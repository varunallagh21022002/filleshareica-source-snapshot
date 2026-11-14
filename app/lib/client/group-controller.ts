import type { ChatMessage, GroupMember, ShareSettings, ShareState, TransferRow } from '../share-types';
import { ShareClient, defaultShareState, validChat, freezeSendIntent, type PeerChat, type SharedReceiveBudget, type SendFileSnapshot } from './controller';
import { createInvitationSecret, invitationHash, parseInvitation } from './crypto';
import { clearSavedGroup, readSavedGroup, saveGroup, type SavedGroup } from './group-storage';
import { MEMORY_FILE_LIMIT } from './framing';
import type { DirectoryHandle, FolderWindow } from './sinks';
import type {AccessRuntime} from '../market/proofs';
import {SenderScheduler} from './send-scheduler';
import {digestSendManifest, type SendIntent, type SendRuntime} from '../market/send-types';
import {SendOperation} from './send-operation';
import { ReceiveFlowBudget } from './receive-flow';
import { MAX_BATCH_FILES, isValidFileSize } from '../transfer-policy';
import { retainPreparedArchive, releasePreparedArchive } from './archive-storage';

type GroupResponse = Omit<SavedGroup, 'version' | 'secret' | 'pendingTransfers'>;
interface GroupLink {peerId: string; peerName: string; sessionId: string; token: string; role: 'host' | 'guest'}
interface GroupPoll extends GroupResponse {status: 'open' | 'closed'; memberStatus: GroupMember['status']; members: GroupMember[]; links: GroupLink[]; maxMembers: number}
interface PeerConnection {client: ShareClient; unsubscribe: () => void; sessionId: string}
const uuid = () => crypto.randomUUID();
const expiry = (value: number | string) => typeof value === 'number' ? value : Date.parse(value);
const finished = (row: TransferRow) => ['saved', 'received', 'ready', 'downloaded', 'canceled', 'failed'].includes(row.status);
class GroupApiError extends Error {constructor(message: string, readonly status: number) {super(message);}}

/** One encrypted, backpressured transfer connection per approved member pair. */
export class GroupShareClient {
  private legacy: ShareClient;
  private scheduler = new SenderScheduler();
  constructor(private options: {accessRuntime?: AccessRuntime; sendRuntime?: SendRuntime} = {}) {this.legacy = new ShareClient({accessRuntime: options.accessRuntime, sendRuntime: options.sendRuntime});}
  private state: ShareState = defaultShareState();
  private listeners = new Set<() => void>();
  private legacyUnsubscribe: (() => void) | null = null;
  private peers = new Map<string, PeerConnection>();
  private archivedPeers = new Map<string, PeerConnection>();
  private selected = new Map<string, File>();
  private credential: SavedGroup | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshRequested = false; private lastPollAt = -Infinity;
  private preparingSend = false;
  private epoch = 0; private destroyed = false; private polling = false; private restoring = false; private signalingUnavailable = false; private updatingSettings = false;
  private directory: DirectoryHandle | null = null;
  private budget: SharedReceiveBudget = {used: 0, limit: MEMORY_FILE_LIMIT};
  private receiveFlowBudget = new ReceiveFlowBudget();
  private localErrors: ShareState['errors'] = [];
  private chatIds = new Set<string>();
  private chatRate = new Map<string, number[]>();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {this.listeners.add(listener); return () => {this.listeners.delete(listener);};};
  private set(patch: Partial<ShareState>) {this.state = {...this.state, ...patch}; this.persist(); for (const listener of this.listeners) listener();}
  private error(error: unknown) {this.localErrors = [...this.localErrors.slice(-4), {id: uuid(), message: error instanceof Error ? error.message : 'The group request failed. Try again.'}]; this.aggregate();}
  initialize() {
    this.destroyed = false;
    let saved: SavedGroup | null = null; try {saved = readSavedGroup(sessionStorage);} catch { /* Optional. */ }
    let invitation: ReturnType<typeof parseInvitation> | null = null;
    try {if (window.location.hash.includes('key=')) invitation = parseInvitation(window.location.href, window.location.origin);} catch { /* Manual join presents validation. */ }
    const isGroup = !!invitation && 'group' in invitation && invitation.group === true;
    const same = !!saved && (!invitation || isGroup && invitation.sessionId === saved.code && invitation.secret === saved.secret);
    this.legacyUnsubscribe = this.legacy.subscribe(() => {if (!this.state.groupMode) this.set(this.legacy.getSnapshot()); else this.set({settings: this.legacy.getSnapshot().settings, capabilities: this.legacy.getSnapshot().capabilities});});
    this.legacy.initialize({skipRestore: !!saved && same || isGroup});
    this.set(this.legacy.getSnapshot());
    if (saved && same) {
      this.credential = saved; this.restoring = true;
      this.set({groupMode: true, stage: 'reconnecting', sessionId: saved.groupId, sessionName: saved.sessionName, sessionSlug: saved.code, selfId: saved.memberId, role: saved.role, pairingLink: this.link(saved), expiresAt: saved.expiresAt});
      this.address(saved.code);
      if (saved.pendingTransfers) this.error(new Error('Group restored after refresh. Files selected, in progress, or waiting to be saved before refresh must be sent again. Chat history is kept only while this page is open.'));
      this.schedule(0);
    } else if (isGroup) {void this.joinSession(window.location.href);}
    else if (saved) {try {clearSavedGroup(sessionStorage);} catch { /* Optional. */ }}
  }
  private link(value: Pick<SavedGroup, 'code' | 'secret'>) {return `${window.location.origin}/${encodeURIComponent(value.code)}#key=${value.secret}&group=1`;}
  private address(code: string) {history.replaceState(null, '', `/${encodeURIComponent(code)}`);}
  private persist() {
    if (!this.credential || !this.state.groupMode || this.destroyed || this.signalingUnavailable) return;
    this.credential = {...this.credential, expiresAt: this.state.expiresAt || this.credential.expiresAt, pendingTransfers: !!this.selected.size || !!this.state.incomingBatches.length || this.state.transfers.some(row => row.status === 'ready' || !finished(row))};
    try {saveGroup(sessionStorage, this.credential);} catch { /* Optional. */ }
  }
  private async api<T>(path: string, body?: unknown): Promise<T> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`/api/groups${path}`, {method: body === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json', ...(this.credential ? {Authorization: `Bearer ${this.credential.token}`} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)}), cache: 'no-store', signal: controller.signal});
      const result = await response.json() as T & {error?: string};
      if (!response.ok) throw new GroupApiError(result.error || `The group request failed (${response.status}).`, response.status);
      return result;
    } finally {clearTimeout(timer);}
  }
  createSession = async (sessionName?: string, group = false) => {
    if (!group) {await this.disconnect(); await this.legacy.createSession(sessionName); return;}
    await this.disconnect(); const epoch = this.epoch;
    this.set({groupMode: true, stage: 'creating', errors: [], chatMessages: [], members: [], selectedFiles: [], incomingBatches: [], transfers: []});
    try {
      if (!this.state.capabilities.supported) throw new Error('This browser needs HTTPS and WebRTC support for secure group transfers.');
      const secret = createInvitationSecret();
      const response = await this.api<GroupResponse>('', {deviceName: this.state.settings.deviceName, sessionName, joinHash: await invitationHash(secret)});
      if (epoch !== this.epoch || this.destroyed) return;
      this.acceptCredential(response, secret); this.set({stage: 'waiting'}); this.schedule(0);
    } catch (error) {this.set({stage: 'idle'}); this.error(error);}
  };
  joinSession = async (value: string) => {
    let invite: ReturnType<typeof parseInvitation>;
    try {invite = parseInvitation(value.trim(), window.location.origin);} catch (error) {if (this.state.groupMode) this.error(error); else await this.legacy.joinSession(value); return;}
    if (!('group' in invite) || invite.group !== true) {await this.disconnect(); await this.legacy.joinSession(value); return;}
    await this.disconnect(); const epoch = this.epoch;
    this.set({groupMode: true, stage: 'joining', errors: [], chatMessages: [], members: [], selectedFiles: [], incomingBatches: [], transfers: []});
    try {
      if (!this.state.capabilities.supported) throw new Error('This browser needs HTTPS and WebRTC support for secure group transfers.');
      const response = await this.api<GroupResponse>(`/${invite.sessionId}/join`, {deviceName: this.state.settings.deviceName, joinHash: await invitationHash(invite.secret)});
      if (epoch !== this.epoch || this.destroyed) return;
      this.acceptCredential(response, invite.secret); this.set({stage: 'pending'}); this.schedule(0);
    } catch (error) {this.set({stage: 'idle'}); this.error(error);}
  };
  private acceptCredential(response: GroupResponse, secret: string) {
    this.credential = {...response, sessionName: response.sessionName || 'Sharing group', expiresAt: expiry(response.expiresAt), version: 1, secret, pendingTransfers: false};
    this.set({groupMode: true, sessionId: response.groupId, sessionName: this.credential.sessionName, sessionSlug: response.code, selfId: response.memberId, role: response.role, pairingLink: this.link(this.credential), expiresAt: this.credential.expiresAt, recipient: 'all'});
    this.address(response.code);
  }
  private schedule(delay = this.state.stage === 'connected' ? this.credential?.role === 'host' ? 60_000 : 600_000 : 1500) {
    // A hint received during an in-flight request must survive its normal
    // heartbeat scheduling. Coalesce it into one trailing authoritative read.
    if (this.polling && delay === 0) {this.refreshRequested = true; return;}
    if (this.timer) clearTimeout(this.timer);
    if (!this.destroyed && this.credential && !this.signalingUnavailable) this.timer = setTimeout(() => void this.poll(), delay);
  }
  private requestRosterRefresh() {
    if (this.polling) {this.refreshRequested = true; return;}
    this.schedule(Math.max(0, 2000 - (performance.now() - this.lastPollAt)));
  }
  private async poll() {
    if (this.polling || !this.credential || this.destroyed || this.signalingUnavailable) return;
    this.polling = true; this.lastPollAt = performance.now(); const epoch = this.epoch;
    try {
      const response = await this.api<GroupPoll>(`/${this.credential.groupId}`);
      if (epoch !== this.epoch || this.destroyed) return;
      if (response.status === 'closed' || ['left', 'rejected'].includes(response.memberStatus)) {
        this.clearPeers(); this.credential = null; try {clearSavedGroup(sessionStorage);} catch { /* Optional. */ }
        this.set({stage: response.memberStatus === 'rejected' ? 'rejected' : 'closed', pairingLink: '', members: response.members, incomingBatches: []}); return;
      }
      const rosterChanged = JSON.stringify(this.state.members.map(member => [member.id, member.status])) !== JSON.stringify(response.members.map(member => [member.id, member.status]));
      this.state = {...this.state, members: response.members, expiresAt: expiry(response.expiresAt)};
      if (rosterChanged) for (const peer of this.peers.values()) peer.client.sendGroupEvent('roster-refresh');
      const wanted = new Set(response.links.map(link => link.peerId));
      for (const [peerId, peer] of this.peers) if (!wanted.has(peerId)) {
        this.peers.delete(peerId); this.archivedPeers.set(peerId, peer);
        // Keep verified downloads available after the remote member leaves.
        void peer.client.disconnect();
      }
      for (const link of response.links) {
        if (this.peers.has(link.peerId)) continue;
        if (this.peers.size >= 7) throw new Error('This group supports up to eight devices.');
        const client = new ShareClient({isolated: true, managedByGroup: true, accessRuntime: this.options.accessRuntime, sendRuntime: this.options.sendRuntime, sendScope: {sessionId: this.credential.groupId, selfRecipientId: this.credential.memberId, peerRecipientId: link.peerId}, scheduler: this.scheduler, receiveBudget: this.budget, receiveFlowBudget: this.receiveFlowBudget, onChat: message => this.receiveChat(link.peerId, message), onGroupEvent: () => this.requestRosterRefresh()});
        client.initialize(); client.syncSettings(this.state.settings); client.setDirectory(this.directory);
        const peer: PeerConnection = {client, sessionId: link.sessionId, unsubscribe: () => {}};
        let previousStage = client.getSnapshot().stage;
        this.peers.set(link.peerId, peer); peer.unsubscribe = client.subscribe(() => {const stage = client.getSnapshot().stage; const changed = stage !== previousStage; previousStage = stage; if (changed) {if (['closed', 'reconnecting'].includes(stage)) this.requestRosterRefresh(); if (stage === 'connected') {client.sendGroupEvent('roster-refresh'); this.requestRosterRefresh();}} this.syncChildSettings(); this.aggregate();});
        await client.attachSession({sessionId: link.sessionId, token: link.token, role: link.role, slug: response.code, sessionName: response.sessionName, expiresAt: response.expiresAt, connectionRevision: 0}, this.credential.secret, {resume: this.restoring});
        if (epoch !== this.epoch || this.destroyed) return;
      }
      this.restoring = false; this.aggregate(response.memberStatus); this.schedule();
    } catch (error) {
      if (epoch !== this.epoch || this.destroyed) return;
      if (error instanceof GroupApiError && [404, 410].includes(error.status) && [...this.peers.values()].some(peer => peer.client.getSnapshot().stage === 'connected')) {
        this.signalingUnavailable = true; if (this.timer) clearTimeout(this.timer); this.timer = null;
        try {clearSavedGroup(sessionStorage);} catch { /* Optional. */ }
        this.set({pairingLink: ''}); this.error(new Error('The group pairing service expired while offline. Existing connections and local transfers continue. Refreshing, reconnecting, or adding members will need a new group.')); return;
      }
      if (error instanceof GroupApiError && [401, 404, 410].includes(error.status)) {this.clearPeers(); this.credential = null; try {clearSavedGroup(sessionStorage);} catch { /* Optional. */ } this.set({stage: 'closed', pairingLink: ''}); this.error(error); return;}
      // Existing direct connections continue through temporary signaling failures.
      if (!this.peers.size) this.set({stage: 'reconnecting'});
      this.schedule(2500);
    } finally {if (epoch === this.epoch) {this.polling = false; if (this.refreshRequested) {this.refreshRequested = false; this.requestRosterRefresh();}}}
  }
  private aggregate(memberStatus?: GroupMember['status']) {
    if (!this.state.groupMode) return;
    const connections = [...this.peers.entries(), ...this.archivedPeers.entries()];
    const members = this.state.members.map(member => ({...member, ...(this.peers.has(member.id) ? {connectionStage: this.peers.get(member.id)!.client.getSnapshot().stage} : {})}));
    const connected = connections.filter(([, peer]) => peer.client.getSnapshot().stage === 'connected');
    if (this.signalingUnavailable && !connected.length) {this.clearPeers(); this.credential = null; this.set({stage: 'closed', pairingLink: '', incomingBatches: []}); return;}
    let stage = this.state.stage;
    if (memberStatus === 'pending') stage = 'pending';
    else if (this.credential) stage = connected.length ? 'connected' : this.peers.size ? 'connecting' : 'waiting';
    const incomingBatches = connections.flatMap(([peerId, peer]) => peer.client.getSnapshot().incomingBatches.map(batch => ({...batch, id: `${peerId}:${batch.id}`, peerId, peerName: members.find(member => member.id === peerId)?.name || batch.peerName, files: batch.files.map(file => ({...file, id: `${peerId}:${file.id}`}))})));
    const transfers = connections.flatMap(([peerId, peer]) => peer.client.getSnapshot().transfers.map(row => ({...row, id: `${peerId}:${row.id}`, batchId: `${peerId}:${row.batchId}`, peerId, peerName: members.find(member => member.id === peerId)?.name || 'Device'})));
    const errors = [...this.localErrors, ...connections.flatMap(([peerId, peer]) => peer.client.getSnapshot().errors.map(error => ({id: `${peerId}:${error.id}`, message: `${members.find(member => member.id === peerId)?.name || 'Device'}: ${error.message}`})))].slice(-8);
    const routes = connected.map(([, peer]) => peer.client.getSnapshot().route);
    const receiverCapabilities = connected.flatMap(([peerId, peer]) => peer.client.getSnapshot().receiverCapabilities.map(capability => ({...capability, peerId, peerName: members.find(member => member.id === peerId)?.name || capability.peerName})));
    const peerAccess = connected.flatMap(([peerId, peer]) => peer.client.getSnapshot().peerAccess.map(access => ({...access, peerId, peerName: members.find(member => member.id === peerId)?.name || access.peerName})));
    const recipient = this.state.recipient === 'all' || members.some(member => member.id === this.state.recipient && member.status === 'approved') ? this.state.recipient : 'all';
    this.set({stage, members, recipient, incomingBatches, transfers, errors, receiverCapabilities, peerAccess, sendPreparing: this.preparingSend || connections.some(([, peer]) => peer.client.getSnapshot().sendPreparing), speedPolicy: this.scheduler.getSnapshot(), peerName: `${connected.length} ${connected.length === 1 ? 'device' : 'devices'} connected`, route: routes.includes('relay') ? 'relay' : routes.length && routes.every(route => route === 'direct') ? 'direct' : 'unknown', relayAvailable: connections.some(([, peer]) => peer.client.getSnapshot().relayAvailable)});
  }
  private syncChildSettings() {
    if (this.updatingSettings) return; this.updatingSettings = true;
    try {
      const cap = this.state.settings.bandwidthLimitMbps;
      this.scheduler.setUserLimit(cap);
      for (const peer of this.peers.values()) peer.client.syncSettings({...this.state.settings, bandwidthLimitMbps: cap});
    } finally {this.updatingSettings = false;}
  }
  setRecipient = (recipient: string) => {if (!this.state.groupMode) return; if (recipient !== 'all' && !this.state.members.some(member => member.id === recipient && member.id !== this.state.selfId && member.status === 'approved')) return; this.set({recipient});};
  approveMember = async (memberId: string, accept: boolean) => {if (!this.credential) return; try {await this.api(`/${this.credential.groupId}/approve`, {memberId, accept}); for (const peer of this.peers.values()) peer.client.sendGroupEvent('roster-refresh'); this.schedule(0);} catch (error) {this.error(error);}};
  approvePeer = async (accept: boolean) => {if (!this.state.groupMode) await this.legacy.approvePeer(accept); else {const member = this.state.members.find(member => member.status === 'pending' && member.id !== this.state.selfId); if (member) await this.approveMember(member.id, accept);}};
  addFiles = (files: FileList | File[]) => {if (!this.state.groupMode) return this.legacy.addFiles(files); const selectedFiles = [...this.state.selectedFiles]; let reportedLimit = false; for (const file of Array.from(files)) {if (this.selected.size >= MAX_BATCH_FILES) {void releasePreparedArchive(file); if (!reportedLimit) {this.error(new Error('Select up to 500 files per batch.')); reportedLimit = true;} continue;} if (!isValidFileSize(file.size)) {void releasePreparedArchive(file); this.error(new Error('This file exceeds the supported size. See the large-file FAQ.')); continue;} const id = uuid(); this.selected.set(id, file); selectedFiles.push({id, name: file.name, size: file.size, type: file.type});} this.set({selectedFiles});};
  removeFile = (id: string) => {if (!this.state.groupMode) return this.legacy.removeFile(id); const file = this.selected.get(id); this.selected.delete(id); if (file) void releasePreparedArchive(file); this.set({selectedFiles: this.state.selectedFiles.filter(file => file.id !== id)});};
  clearFiles = () => {if (!this.state.groupMode) return this.legacy.clearFiles(); for (const file of this.selected.values()) void releasePreparedArchive(file); this.selected.clear(); this.set({selectedFiles: []});};
  private targets(recipient: string, checkSendPolicy = false): [string, PeerConnection][] {
    const members = this.state.members.filter(member => member.id !== this.state.selfId && member.status === 'approved' && (recipient === 'all' || member.id === recipient));
    if (!members.length) throw new Error('Wait for another approved device to connect.');
    const targets: [string, PeerConnection][] = [];
    for (const member of members) {const peer = this.peers.get(member.id); if (!peer || peer.client.getSnapshot().stage !== 'connected') throw new Error(`${member.name} is reconnecting. Keep their page open and try again once connected.`); const blocked = checkSendPolicy ? peer.client.getAccessBlockReason?.() : null; if (blocked) throw new Error(`${member.name}: ${blocked}`); targets.push([member.id, peer]);}
    return targets;
  }
  sendSelected = async (recipient = this.state.recipient) => {
    if (!this.state.groupMode) return this.legacy.sendSelected();
    if (this.state.sendPreparing || !this.selected.size) return;
    const files: SendFileSnapshot[] = this.state.selectedFiles.map(info => ({info: {...info}, file: this.selected.get(info.id)!}));
    for (const snapshot of files) retainPreparedArchive(snapshot.file);
    const epoch = this.epoch; let operation: SendOperation | null = null; this.preparingSend = true; this.set({sendPreparing: true});
    try {
      const targets = this.targets(recipient, true);
      for (const [, peer] of targets) {const blocked = peer.client.getFileBlockReason(files.map(file => file.info)); if (blocked) throw new Error(blocked);}
      const intent: SendIntent = {operationId: uuid(), sessionId: this.state.sessionId || '', manifestDigest: '', files: files.map(file => ({id: file.info.id, size: file.info.size})), recipientIds: targets.map(([peerId]) => peerId)};
      intent.manifestDigest = await digestSendManifest(intent); freezeSendIntent(intent);
      const permit = this.options.sendRuntime ? await this.options.sendRuntime.authorize(intent) : null;
      if (this.options.sendRuntime && !permit) return;
      operation = new SendOperation(intent, permit, this.options.sendRuntime, error => this.error(error));
      if (epoch !== this.epoch || this.destroyed) return;
      for (const [peerId, peer] of targets) if (this.peers.get(peerId) !== peer || peer.client.getSnapshot().stage !== 'connected' || !this.state.members.some(member => member.id === peerId && member.status === 'approved')) throw new Error('A selected recipient left while the send was being authorized. The files remain selected.');
      for (const [, peer] of targets) await peer.client.sendAuthorized(operation, files);
      const ids = new Set(files.map(file => file.info.id)); for (const fileId of ids) {const file = this.selected.get(fileId); this.selected.delete(fileId); if (file) void releasePreparedArchive(file);}
      this.set({selectedFiles: this.state.selectedFiles.filter(file => !ids.has(file.id))}); this.syncChildSettings();
    } catch (error) {if (epoch === this.epoch) this.error(error);} finally {for (const snapshot of files) void releasePreparedArchive(snapshot.file); operation?.seal(); if (epoch === this.epoch) {this.preparingSend = false; this.aggregate();}}
  };
  sendChat = async (text: string, recipient = this.state.recipient) => {
    if (!this.state.groupMode) return this.legacy.sendChat(text, recipient);
    try {
      const message: PeerChat = {id: uuid(), text: text.trim(), sentAt: Date.now(), recipient};
      if (!validChat(message)) throw new Error('Write a message of 1 to 4,000 characters.');
      const targets = this.targets(recipient);
      for (const [, peer] of targets) if (!peer.client.sendChatMessage(message)) throw new Error('A device disconnected before the message could be sent.');
      this.appendChat({...message, senderId: this.state.selfId, senderName: this.state.settings.deviceName, own: true});
    } catch (error) {this.error(error);}
  };
  private receiveChat(peerId: string, message: PeerChat) {
    if (message.recipient !== 'all' && message.recipient !== this.state.selfId) return;
    const time = Date.now(); const recent = (this.chatRate.get(peerId) || []).filter(at => time - at < 10000);
    if (recent.length >= 30) return; recent.push(time); this.chatRate.set(peerId, recent);
    this.appendChat({...message, senderId: peerId, senderName: this.state.members.find(member => member.id === peerId)?.name || 'Device', own: false});
  }
  private appendChat(message: ChatMessage) {const key = `${message.senderId}:${message.id}`; if (this.chatIds.has(key)) return; this.chatIds.add(key); if (this.chatIds.size > 1000) this.chatIds.delete(this.chatIds.values().next().value!); this.set({chatMessages: [...this.state.chatMessages.slice(-199), message]});}
  private locate(value: string) {const split = value.indexOf(':'); if (split < 0) return null; const peer = this.peers.get(value.slice(0, split)) || this.archivedPeers.get(value.slice(0, split)); return peer ? {client: peer.client, id: value.slice(split + 1)} : null;}
  acceptBatch = async (id: string, files?: string[]) => {
    if (!this.state.groupMode) return this.legacy.acceptBatch(id, files);
    const target = this.locate(id); if (!target) return;
    const batch = this.state.incomingBatches.find(item => item.id === id);
    const bytes = batch?.files.filter(file => !files || files.includes(file.id)).reduce((sum, file) => sum + file.size, 0) || 0;
    if (!this.directory && this.budget.used + bytes > this.budget.limit && this.state.capabilities.folderPicker) {await this.chooseFolder(); if (!this.directory) return;}
    await target.client.acceptBatch(target.id, files?.map(file => this.locate(file)?.id || file));
  };
  declineBatch = (id: string) => {if (!this.state.groupMode) return this.legacy.declineBatch(id); const target = this.locate(id); target?.client.declineBatch(target.id);};
  pauseTransfer = (id: string) => {if (!this.state.groupMode) return this.legacy.pauseTransfer(id); const target = this.locate(id); target?.client.pauseTransfer(target.id);};
  resumeTransfer = (id: string) => {if (!this.state.groupMode) return this.legacy.resumeTransfer(id); const target = this.locate(id); target?.client.resumeTransfer(target.id);};
  cancelTransfer = (id: string) => {if (!this.state.groupMode) return this.legacy.cancelTransfer(id); const target = this.locate(id); target?.client.cancelTransfer(target.id);};
  retryTransfer = async (id: string) => {
    if (!this.state.groupMode) return this.legacy.retryTransfer(id);
    if (this.state.sendPreparing) return; const target = this.locate(id); if (!target) return;
    const epoch = this.epoch; this.preparingSend = true; this.set({sendPreparing: true});
    try {await target.client.retryTransfer(target.id);} finally {if (epoch === this.epoch) {this.preparingSend = false; this.aggregate();}}
  };
  downloadFile = (id: string) => {if (!this.state.groupMode) return this.legacy.downloadFile(id); const target = this.locate(id); target?.client.downloadFile(target.id);};
  saveFile = async (id: string) => {if (!this.state.groupMode) return this.legacy.saveFile(id); const target = this.locate(id); await target?.client.saveFile(target.id);};
  chooseFolder = async () => {
    if (!this.state.groupMode) return this.legacy.chooseFolder();
    try {const picker = (window as FolderWindow).showDirectoryPicker; if (!picker) throw new Error('This browser uses individual downloads. Use a supported Chrome or Edge browser to save directly into a folder.'); this.directory = await picker.call(window, {mode: 'readwrite'}); for (const peer of this.peers.values()) peer.client.setDirectory(this.directory); this.set({folderName: this.directory.name});}
    catch (error) {if (!(error instanceof DOMException && error.name === 'AbortError')) this.error(error);}
  };
  clearFolder = () => {if (!this.state.groupMode) return this.legacy.clearFolder(); this.directory = null; for (const peer of this.peers.values()) peer.client.setDirectory(null); this.set({folderName: null});};
  dismissError = (id: string) => {if (!this.state.groupMode) return this.legacy.dismissError(id); const target = this.locate(id); if (target) target.client.dismissError(target.id); else {this.localErrors = this.localErrors.filter(error => error.id !== id); this.aggregate();}};
  updateSettings = (patch: Partial<ShareSettings>) => {
    if (this.state.groupMode && this.peers.size && patch.directOnly !== undefined && patch.directOnly !== this.state.settings.directOnly) {this.error(new Error('End or leave this group before changing the connection preference.')); return;}
    this.legacy.updateSettings(patch); if (this.state.groupMode) {this.set({settings: this.legacy.getSnapshot().settings}); this.syncChildSettings();}};
  testSpeed = async () => {if (!this.state.groupMode) return this.legacy.testSpeed(); try {const target = this.targets(this.state.recipient)[0]; if (!target) return; if ([...this.peers.values()].some(peer => peer.client.getSnapshot().transfers.some(row => row.direction === 'outgoing' && row.status !== 'offered' && !finished(row)))) throw new Error('Wait until accepted outgoing transfers finish before resetting the group reference.'); await target[1].client.testSpeed(); this.set({speedPolicy: this.scheduler.getSnapshot(), speedTest: target[1].client.getSnapshot().speedTest});} catch (error) {this.error(error);}};
  private clearPeers() {for (const peer of [...this.peers.values(), ...this.archivedPeers.values()]) {peer.unsubscribe(); peer.client.destroy();} this.peers.clear(); this.archivedPeers.clear(); this.scheduler.destroy(); this.scheduler = new SenderScheduler(); this.budget.used = 0;}
  disconnect = async () => {
    if (!this.state.groupMode) {await this.legacy.disconnect(); return;}
    const credential = this.credential; this.persist(); this.epoch++; this.polling = false; this.restoring = false; this.signalingUnavailable = false;
    this.refreshRequested = false; this.lastPollAt = -Infinity;
    this.preparingSend = false;
    if (credential) {
      try {const response = await fetch(`/api/groups/${credential.groupId}/${credential.role === 'host' ? 'end' : 'leave'}`, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${credential.token}`}, body: '{}', keepalive: true}); if (response.ok) for (const peer of this.peers.values()) peer.client.sendGroupEvent(credential.role === 'host' ? 'group-ended' : 'member-left');} catch { /* Bounded server leases clean up abandoned sessions. */ }
    }
    if (this.timer) clearTimeout(this.timer); this.timer = null; this.clearPeers(); for (const file of this.selected.values()) void releasePreparedArchive(file); this.selected.clear(); this.credential = null; this.localErrors = []; this.chatIds.clear(); this.chatRate.clear(); this.directory = null;
    try {clearSavedGroup(sessionStorage);} catch { /* Optional. */ }
    this.set({...defaultShareState(), capabilities: this.state.capabilities, settings: this.state.settings}); history.replaceState(null, '', '/');
  };
  endSession = async () => {
    if (!this.state.groupMode || this.credential?.role !== 'host') {await this.disconnect(); return;}
    const credential = this.credential; const epoch = this.epoch;
    try {
      await this.api(`/${credential.groupId}/end`, {});
      if (epoch !== this.epoch || this.destroyed) return;
      for (const peer of this.peers.values()) peer.client.sendGroupEvent('group-ended');
      this.credential = null; await this.disconnect();
    } catch (error) {this.error(new Error(`The group could not be ended for everyone. Check your connection and try End session again. ${error instanceof Error ? error.message : ''}`));}
  };
  destroy() {this.persist(); this.destroyed = true; this.epoch++; this.refreshRequested = false; if (this.timer) clearTimeout(this.timer); this.timer = null; this.clearPeers(); this.legacyUnsubscribe?.(); this.legacyUnsubscribe = null; this.legacy.destroy(); for (const file of this.selected.values()) void releasePreparedArchive(file); this.selected.clear(); this.credential = null;}
}
