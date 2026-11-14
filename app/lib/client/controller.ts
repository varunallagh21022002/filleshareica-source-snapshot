import type { IncomingBatch, SelectedFile, ReceiverCapability, ShareCapabilities, ShareSettings, ShareState, TransferRow, TransferStatus } from '../share-types';
import { createInvitationSecret, deriveSignalKey, encryptSignal, invitationHash, parseInvitation, SignalDecryptor } from './crypto';
import { decodeFrame, encodeFrame, FRAME_HEADER, INITIAL_CHUNK, MAX_CHUNK, MEMORY_FILE_LIMIT, RECEIVE_WINDOW } from './framing';
import { StreamingHasher } from './hasher';
import { chooseFileSink, folderSink, memorySink, type DirectoryHandle, type FolderWindow, type ReceiveSink, safeFilename, saveBlobAs } from './sinks';
import { MAX_BATCH_FILES, MAX_FILE_BYTES, isValidFileSize } from '../transfer-policy';
import { ReceiveFlowBudget } from './receive-flow';
import { cleanupPreparedArchives, releasePreparedArchive, retainPreparedArchive } from './archive-storage';
import { clearSavedSession, readSavedSession, saveSession, type SavedShareSession } from './session-storage';
import {peerChallengeText, verifyPeerAccess, type AccessRuntime, type PeerAccessProof} from '../market/proofs';
import type {AccessClaims} from '../market/types';
import {SenderScheduler} from './send-scheduler';
import {digestSendManifest, SEND_POLICY_VERSION, type SendIntent, type SendRuntime} from '../market/send-types';
import {sendEnvelopeText, validateSendPermit, verifySendEnvelope, type SendEnvelope} from '../market/send-proofs';
import {SendOperation} from './send-operation';

type Role = 'host' | 'guest';
interface PollResponse { status: 'waiting' | 'pending' | 'approved' | 'rejected' | 'closed'; role: Role; peerName: string; expiresAt: number | string; signals: {id: number; payload: string}[]; iceServers: RTCIceServer[]; relayAvailable: boolean; connectionRevision: number; slug: string; sessionName: string | null }
export interface SessionResponse {sessionId: string; token: string; role: Role; expiresAt: number | string; slug: string; sessionName: string | null; connectionRevision: number}
export interface PeerChat {id: string; text: string; sentAt: number; recipient: string}
export interface SharedReceiveBudget {used: number; limit: number}
export interface SendFileSnapshot {info: SelectedFile; file: File; digest?: string;}
export interface ShareClientOptions {isolated?: boolean; managedByGroup?: boolean; accessRuntime?: AccessRuntime; sendRuntime?: SendRuntime; sendScope?: {sessionId: string; selfRecipientId: string; peerRecipientId: string}; scheduler?: SenderScheduler; receiveBudget?: SharedReceiveBudget; receiveFlowBudget?: ReceiveFlowBudget; onChat?: (message: PeerChat) => void; onGroupEvent?: (type: 'roster-refresh' | 'group-ended' | 'member-left') => void}
type ResumeResponse = Omit<SessionResponse, 'token'> & {status: PollResponse['status']};
interface SignalMessage {type: 'description' | 'candidate' | 'restart'; replace?: boolean; connectionRevision?: number; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit}
interface Outgoing {id: string; batchId: string; operation?: SendOperation; digest?: string; retryDigest?: boolean; file: File; sourceReleased?: boolean; offset: number; confirmed: number; credit: number; localPaused: boolean; remotePaused: boolean; status: TransferStatus; started: number; sampled: number; sampledBytes: number; hashStarted: boolean; ending: boolean; lastActivity: number; nextSendAt: number; resumePending?: boolean}
interface Receiving {id: string; batchId: string; operationId?: string; info: SelectedFile; bytes: number; status: TransferStatus; localPaused: boolean; remotePaused: boolean; sink: Promise<ReceiveSink> | null; directory: DirectoryHandle | null; diskSink?: boolean; grantedCredit?: number; started: number; lastAck: number; lastAckTime: number; sampled: number; sampledBytes: number; expectedHash?: string; finishing: boolean; hasherStarted: boolean}
interface Control {type: string; [key: string]: unknown}
const now = () => performance.now();
const id = () => crypto.randomUUID();
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
const terminal = (status: TransferStatus) => ['saved', 'received', 'ready', 'downloaded', 'failed', 'canceled'].includes(status);
const asExpiry = (value: number | string) => typeof value === 'number' ? value : Date.parse(value);
class SessionApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export function defaultShareState(): ShareState {
  return {
    stage: 'idle', sessionId: null, role: null, sessionName: '', sessionSlug: '', peerName: '', pairingLink: '', expiresAt: null,
    selectedFiles: [], incomingBatches: [], transfers: [], sendPreparing: false, errors: [], receiverCapabilities: [], route: 'unknown', relayAvailable: false, folderName: null,
    capabilities: {checked: false, supported: false, secureContext: false, folderPicker: false, savePicker: false, fileShare: false, maxMemoryFileSize: MEMORY_FILE_LIMIT},
    settings: {deviceName: 'My device', directOnly: false, speedUnit: 'MB/s', keepAwake: true, bandwidthLimitMbps: 0},
    groupMode: false, selfId: '', members: [], recipient: 'all', chatMessages: [],
    peerAccess: [], speedPolicy: {calibration: 'waiting', referenceBytesPerSecond: 0, freeLimitBytesPerSecond: 0, userLimitBytesPerSecond: 0, freeRatio: .65},
    speedTest: {status: 'idle', bytesPerSecond: 0},
  };
}
export class ShareClient {
  constructor(private options: ShareClientOptions = {}) {this.scheduler = options.scheduler || new SenderScheduler(); this.receiveFlow = options.receiveFlowBudget || new ReceiveFlowBudget();}
  private receiveFlow: ReceiveFlowBudget;
  private flowUnsubscribe: (() => void) | null = null;
  private receiveWindows = new Map<string, {owner: Receiving; bytes: number}>();
  private peerFlowControl = false;
  private peerCheckpoints = false;
  private transportId = id();
  private peerTransportId = '';
  private replacingTransport = false;
  private scheduler: SenderScheduler;
  private accessUnsubscribe: (() => void) | null = null;
  private accessChallenge = ''; private remoteChallenge = ''; private peerClaims: AccessClaims | null = null;
  private challengeUsed = false;
  private accessVersion = 0; private accessSource: unknown = null; private accessClock = {server: Date.now(), local: now()};
  private selectedPair = ''; private pumpCursor = 0;
  private peerSendPolicy = 0;
  private incomingOperations = new Map<string, string>();
  private state = defaultShareState(); private listeners = new Set<() => void>();
  private token = ''; private secret = ''; private key: CryptoKey | null = null; private decryptor: SignalDecryptor | null = null;
  private generation = ''; private sequence = 0; private cursor = 0; private timer: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0; private polling = false; private pc: RTCPeerConnection | null = null; private control: RTCDataChannel | null = null; private data: RTCDataChannel | null = null;
  private candidates: RTCIceCandidateInit[] = []; private signalQueue = Promise.resolve(); private controlQueue = Promise.resolve(); private receiveQueue = Promise.resolve();
  private selected = new Map<string, File>(); private outgoing = new Map<string, Outgoing>(); private receiving = new Map<string, Receiving>(); private downloads = new Map<string, Blob>();
  private directory: DirectoryHandle | null = null; private hasher: StreamingHasher | null = null; private sending = false; private destroyed = false; private tickTimer: ReturnType<typeof setInterval> | null = null; private statsTimer: ReturnType<typeof setInterval> | null = null;
  private wakeLock: {release(): Promise<void>} | null = null; private wakePending = false; private waking = false; private memoryReserved = 0; private reconnecting = false; private iceServers: RTCIceServer[] = [];
  private speedRun: {id: string; started: number; bytes: number; done: (speed: number) => void} | null = null;
  private queuedReceiveBytes = 0;
  private connectionDeadline: ReturnType<typeof setTimeout> | null = null;
  private hadConnected = false;
  private connectionRevision = 0;
  private resumeRequired = false;
  private recoveryNotified = false;
  private signalingUnavailable = false;
  private savedSessionJson = '';
  private speedReceive = new Map<string, {bytes: number; started: number}>();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(patch: Partial<ShareState>) { this.state = {...this.state, ...patch}; this.persistSession(); for (const listener of this.listeners) listener(); }
  private persistSession() {
    if (this.options.isolated || this.signalingUnavailable || !this.state.sessionId || !this.state.role || !this.token || !this.secret) return;
    const record: SavedShareSession = {version: 1, sessionId: this.state.sessionId, token: this.token, secret: this.secret, role: this.state.role, slug: this.state.sessionSlug || this.state.sessionId, sessionName: this.state.sessionName, expiresAt: this.state.expiresAt || Date.now(), connectionRevision: this.connectionRevision, hadConnected: this.hadConnected, pendingTransfers: !!this.state.selectedFiles.length || !!this.state.incomingBatches.length || this.state.transfers.some(row => row.status === 'ready' || !terminal(row.status))};
    const serialized = JSON.stringify(record);
    if (serialized === this.savedSessionJson) return;
    try { saveSession(window.sessionStorage, record); this.savedSessionJson = serialized; } catch { /* Tab storage can be unavailable. */ }
  }
  private updateRow(fileId: string, patch: Partial<TransferRow>, emit = false) {
    this.state = {...this.state, transfers: this.state.transfers.map(row => row.id === fileId ? {...row, ...patch} : row)};
    if (emit) this.set({transfers: this.state.transfers});
  }
  private error(error: unknown) { this.set({errors: [...this.state.errors.slice(-4), {id: id(), message: errorMessage(error)}]}); }
  initialize(options: {skipRestore?: boolean} = {}) {
    this.destroyed = false;
    this.accessUnsubscribe?.(); this.accessUnsubscribe = this.options.accessRuntime?.subscribe(() => {this.updatePeerAccess(); this.requestPeerAccess(); this.sendControl({type: 'access-refresh', version: 1});}) || null;
    const folderPicker = typeof (window as FolderWindow).showDirectoryPicker === 'function';
    const savePicker = 'showSaveFilePicker' in window && typeof window.showSaveFilePicker === 'function';
    const capabilities: ShareCapabilities = {checked: true, supported: typeof RTCPeerConnection !== 'undefined' && !!globalThis.crypto?.subtle, secureContext: window.isSecureContext, folderPicker, savePicker, fileShare: typeof navigator.share === 'function' && typeof navigator.canShare === 'function', maxMemoryFileSize: MEMORY_FILE_LIMIT, receiveModes: ['memory', ...(folderPicker ? ['folder' as const] : []), ...(savePicker ? ['file' as const] : [])], maxFileBytes: folderPicker || savePicker ? MAX_FILE_BYTES : MEMORY_FILE_LIMIT};
    this.flowUnsubscribe?.(); this.flowUnsubscribe = this.receiveFlow.subscribe(() => this.grantQueuedReceives());
    if (!this.options.isolated) void cleanupPreparedArchives().catch(() => {});
    const mobile = /iPhone|iPad|Android/i.test(navigator.userAgent);
    let settings: ShareSettings = {...this.state.settings, deviceName: mobile ? 'My phone' : 'My computer'};
    try { const stored = JSON.parse(localStorage.getItem('f8-settings') || '{}') as Partial<ShareSettings>; settings = {...settings, ...stored, directOnly: !!stored.directOnly}; } catch { /* Settings are optional. */ }
    this.set({capabilities, settings});
    this.scheduler.setUserLimit(settings.bandwidthLimitMbps);
    this.hasher = new StreamingHasher();
    this.tickTimer = setInterval(() => this.tick(), 250);
    document.addEventListener('visibilitychange', this.visibility);
    if (this.options.isolated || options.skipRestore) return;
    let saved: SavedShareSession | null = null;
    try { saved = readSavedSession(window.sessionStorage); } catch { /* Storage may be disabled. */ }
    const hasInvitation = (new URLSearchParams(window.location.search).has('session') || /^\/s\//.test(window.location.pathname) || /^\/[a-f0-9]{6}\/?$/.test(window.location.pathname)) && window.location.hash.includes('key=');
    let sameInvitation = true;
    if (hasInvitation && saved) {
      try { const invitation = parseInvitation(window.location.href, window.location.origin); sameInvitation = [saved.sessionId, saved.slug].includes(invitation.sessionId) && invitation.secret === saved.secret; }
      catch { sameInvitation = false; }
    }
    if (saved && sameInvitation && capabilities.supported) void this.restoreSession(saved);
    else if (hasInvitation) {
      // A new invitation in this tab intentionally replaces its prior room.
      if (saved) { this.token = saved.token; this.state = {...this.state, sessionId: saved.sessionId, role: saved.role}; }
      void this.joinSession(window.location.href);
    }
  }
  private visibility = () => { if (document.visibilityState === 'visible') { void this.syncWakeLock(); this.schedulePoll(0); } };
  private async api<T>(path: string, body?: unknown): Promise<T> {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`/api/sessions${path}`, {method: body === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json', ...(this.token ? {Authorization: `Bearer ${this.token}`} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)}), cache: 'no-store', signal: controller.signal});
      const result = await response.json() as T & {error?: string};
      if (!response.ok) throw new SessionApiError(result.error || `Connection request failed (${response.status}).`, response.status);
      return result;
    } finally { clearTimeout(timeout); }
  }
  private invitationLink(slug: string) { const link = new URL(sessionPath(slug), window.location.origin); link.hash = `key=${this.secret}`; return link.href; }
  private useSessionAddress() { if (!this.options.isolated && this.state.sessionSlug) history.replaceState(null, '', sessionPath(this.state.sessionSlug)); }
  private async restoreSession(saved: SavedShareSession) {
    const epoch = this.epoch;
    try {
      this.secret = saved.secret;
      this.hadConnected = saved.hadConnected;
      await this.setupSession({sessionId: saved.sessionId, token: saved.token, role: saved.role, expiresAt: saved.expiresAt, slug: saved.slug, sessionName: saved.sessionName, connectionRevision: saved.connectionRevision});
      if (epoch !== this.epoch || this.destroyed) return;
      this.resumeRequired = true;
      this.set({stage: 'reconnecting', pairingLink: this.invitationLink(saved.slug)});
      this.useSessionAddress();
      if (saved.pendingTransfers) this.error(new Error('Connection restored after refresh. Files selected, in progress, or waiting to be downloaded before refresh must be selected and sent again.'));
      this.schedulePoll(0);
    } catch (error) { if (epoch === this.epoch && !this.destroyed) { this.set({stage: 'idle'}); this.error(error); } }
  }
  createSession = async (sessionName?: string) => {
    try {
      if (!this.state.capabilities.supported) throw new Error(window.isSecureContext ? 'This browser does not support secure file transfers. Update it or use Chrome, Edge, Safari, or Firefox.' : 'Secure transfers require HTTPS. A phone cannot use WebRTC encryption from an ordinary HTTP network address. Open the HTTPS website on both devices.');
      const disconnecting = this.disconnect(); const epoch = this.epoch; await disconnecting; if (epoch !== this.epoch || this.destroyed) return;
      this.set({stage: 'creating', errors: []}); this.secret = createInvitationSecret();
      const joinHash = await invitationHash(this.secret);
      const response = await this.api<SessionResponse>('', {deviceName: this.state.settings.deviceName, joinHash, sessionName});
      if (epoch !== this.epoch) return;
      await this.setupSession(response);
      if (epoch !== this.epoch || this.destroyed) return;
      this.set({stage: 'waiting', pairingLink: this.invitationLink(response.slug || response.sessionId)}); this.useSessionAddress(); this.schedulePoll(0);
    } catch (error) { this.set({stage: 'idle'}); this.error(error); }
  };
  joinSession = async (value: string) => {
    try {
      if (!this.state.capabilities.supported) throw new Error(window.isSecureContext ? 'This browser does not support secure file transfers. Update it or use Chrome, Edge, Safari, or Firefox.' : 'Secure transfers require HTTPS. A phone cannot use WebRTC encryption from an ordinary HTTP network address. Open the HTTPS website on both devices.');
      const invite = parseInvitation(value.trim(), window.location.origin);
      const disconnecting = this.disconnect(); const epoch = this.epoch; await disconnecting; if (epoch !== this.epoch || this.destroyed) return;
      this.set({stage: 'joining', errors: []}); this.secret = invite.secret;
      const response = await this.api<SessionResponse>(`/${invite.sessionId}/join`, {deviceName: this.state.settings.deviceName, joinHash: await invitationHash(this.secret)});
      if (epoch !== this.epoch) return;
      await this.setupSession(response); if (epoch !== this.epoch || this.destroyed) return;
      this.set({stage: 'pending', pairingLink: this.invitationLink(response.slug || response.sessionId)}); this.useSessionAddress(); this.schedulePoll(0);
    } catch (error) { this.set({stage: 'idle'}); this.error(error); }
  };
  attachSession = async (response: SessionResponse, secret: string, options: {resume: boolean}) => {
    this.secret = secret; await this.setupSession(response); this.resumeRequired = options.resume;
    this.set({stage: options.resume ? 'reconnecting' : 'connecting'}); this.schedulePoll(0);
  };
  setDirectory(directory: DirectoryHandle | null) { this.directory = directory; this.set({folderName: directory?.name || null}); this.advertiseCapabilities(); }
  syncSettings(settings: ShareSettings) {
    if (JSON.stringify(this.state.settings) !== JSON.stringify(settings)) { this.set({settings: {...settings}}); void this.syncWakeLock(); }
    this.scheduler.setUserLimit(settings.bandwidthLimitMbps);
  }
  sendChatMessage = (message: PeerChat): boolean => {
    if (!validChat(message)) return false;
    return this.sendControl({type: 'chat', version: 1, ...message});
  };
  sendChat = async (text: string, recipient = 'all') => {
    const message = {id: id(), text: text.trim(), sentAt: Date.now(), recipient};
    if (!validChat(message)) { this.error(new Error('Write a message of 1 to 4,000 characters.')); return; }
    if (!this.sendChatMessage(message)) { this.error(new Error('Connect the other device before sending a message.')); return; }
    this.set({chatMessages: [...this.state.chatMessages.slice(-199), {...message, senderId: this.state.role || '', senderName: this.state.settings.deviceName, own: true}]});
  };
  setRecipient = (_recipient: string) => {void _recipient;};
  approveMember = async (_memberId: string, accept: boolean) => { await this.approvePeer(accept); };
  endSession = async () => { await this.disconnect(); };
  private async setupSession(response: SessionResponse) {
    const epoch = this.epoch;
    const key = await deriveSignalKey(this.secret, response.sessionId);
    if (epoch !== this.epoch || this.destroyed) return;
    this.token = response.token; this.key = key; this.generation = id(); this.sequence = 0; this.cursor = 0; this.connectionRevision = response.connectionRevision || 0;
    this.decryptor = new SignalDecryptor(key, response.sessionId, response.role);
    this.set({sessionId: response.sessionId, role: response.role, sessionName: response.sessionName || response.slug || '', sessionSlug: response.slug || response.sessionId, expiresAt: asExpiry(response.expiresAt), route: 'unknown'});
  }
  approvePeer = async (accept: boolean) => { try { await this.api(`/${this.state.sessionId}/approve`, {accept}); this.set({stage: accept ? 'connecting' : 'rejected'}); this.schedulePoll(0); } catch (error) { this.error(error); } };
  private schedulePoll(delay = 800) { if (this.timer) clearTimeout(this.timer); this.timer = null; if (this.options.managedByGroup && this.state.stage === 'connected' && delay > 0) return; if (this.state.sessionId && !this.destroyed && !this.signalingUnavailable) this.timer = setTimeout(() => void this.poll(), delay); }
  private async poll() {
    if (this.signalingUnavailable) return;
    if (this.polling || !this.state.sessionId || this.destroyed) { this.schedulePoll(); return; }
    this.polling = true; const epoch = this.epoch;
    try {
      if (this.resumeRequired) {
        const resumed = await this.api<ResumeResponse>(`/${this.state.sessionId}/resume`, {});
        if (epoch !== this.epoch || this.destroyed) return;
        this.resumeRequired = false;
        await this.adoptConnectionRevision(resumed.connectionRevision);
        if (epoch !== this.epoch || this.destroyed) return;
        this.set({sessionName: resumed.sessionName || resumed.slug || this.state.sessionName, sessionSlug: resumed.slug || this.state.sessionSlug, expiresAt: asExpiry(resumed.expiresAt)});
      }
      const response = await this.api<PollResponse>(`/${this.state.sessionId}?after=${this.cursor}`);
      if (epoch !== this.epoch || this.destroyed) return;
      if (response.connectionRevision < this.connectionRevision) { this.schedulePoll(0); return; }
      await this.adoptConnectionRevision(response.connectionRevision);
      if (epoch !== this.epoch || this.destroyed) return;
      this.iceServers = response.iceServers || [];
      this.set({peerName: response.peerName || '', expiresAt: asExpiry(response.expiresAt), relayAvailable: response.relayAvailable});
      if (response.status === 'closed' || response.status === 'rejected') { this.closePeer(); this.token = ''; this.forgetSavedSession(); this.set({stage: response.status}); return; }
      if (response.status === 'waiting' && !this.pc) this.set({stage: 'waiting'});
      if (response.status === 'pending' && !this.pc) this.set({stage: 'pending'});
      if (response.status === 'approved' && !this.pc) await this.connectPeer();
      else if (response.status === 'approved' && this.pc?.connectionState === 'failed' && !this.reconnecting) void this.restartConnection();
      if (epoch !== this.epoch || this.destroyed) return;
      for (const signal of response.signals || []) {
        if (signal.id <= this.cursor) continue;
        try { const message = await this.decryptor!.decrypt(signal.payload) as SignalMessage; if (epoch === this.epoch && message.connectionRevision === this.connectionRevision) await this.handleSignal(message); }
        catch (error) { this.error(new Error(`Connection authentication failed: ${errorMessage(error)}`)); }
        if (epoch !== this.epoch || this.destroyed) return;
        this.cursor = signal.id;
      }
      this.schedulePoll(this.state.stage === 'connected' ? 60_000 : 800);
    } catch (error) {
      if (epoch === this.epoch && !this.destroyed) {
        if (error instanceof SessionApiError && error.status === 409 && this.resumeRequired) { this.resumeRequired = false; this.schedulePoll(0); return; }
        if (error instanceof SessionApiError && [404, 410].includes(error.status) && this.pc?.connectionState === 'connected' && this.control?.readyState === 'open' && this.data?.readyState === 'open') {
          // The signaling room is unnecessary for a healthy, approved data
          // connection. WAN loss must not interrupt an existing local transfer.
          this.signalingUnavailable = true; this.forgetSavedSession();
          if (this.timer) clearTimeout(this.timer); this.timer = null;
          this.error(new Error('Pairing service expired while offline. Your current connection and transfers continue. Refresh or a lost connection will require a new pairing.'));
          return;
        }
        if (error instanceof SessionApiError && [401, 404, 410].includes(error.status)) { this.closePeer(); this.token = ''; this.forgetSavedSession(); this.set({stage: 'closed'}); this.error(new Error('This session has ended or expired. Create a new connection.')); return; }
        if (this.state.stage !== 'connected' && !this.recoveryNotified) { this.recoveryNotified = true; this.error(new Error(`Reconnecting automatically. Keep both pages open. ${errorMessage(error)}`)); }
        this.schedulePoll(2000);
      }
    } finally { if (epoch === this.epoch) this.polling = false; }
  }
  private async adoptConnectionRevision(revision: number) {
    if (!Number.isSafeInteger(revision) || revision <= this.connectionRevision) return;
    this.connectionRevision = revision;
    this.set({stage: 'reconnecting', route: 'unknown', incomingBatches: [], speedTest: {status: 'idle', bytesPerSecond: 0}});
    this.closePeer(); this.reconnecting = false; this.cursor = 0; this.generation = id(); this.sequence = 0;
    if (this.key && this.state.sessionId && this.state.role) this.decryptor = new SignalDecryptor(this.key, this.state.sessionId, this.state.role);
    const interrupted = [...this.outgoing.values(), ...this.receiving.values()].filter(item => !terminal(item.status));
    await Promise.all(interrupted.map(item => this.stopTransfer(item.id, 'failed', 'A device refreshed the page. Send this file again.')));
    if (interrupted.length) this.error(new Error('The other device refreshed. Your connection will recover automatically; send interrupted files again.'));
    this.speedReceive.clear(); this.speedRun?.done(0);
  }
  private sendSignal(message: SignalMessage): Promise<void> {
    const epoch = this.epoch; const revision = this.connectionRevision;
    this.signalQueue = this.signalQueue.catch(() => {}).then(async () => {
      if (this.signalingUnavailable || epoch !== this.epoch || revision !== this.connectionRevision || !this.key || !this.state.sessionId || !this.state.role) return;
      const payload = await encryptSignal(this.key, this.state.sessionId, this.state.role, this.generation, this.sequence++, {...message, connectionRevision: revision});
      if (this.signalingUnavailable || epoch !== this.epoch || revision !== this.connectionRevision) return;
      try { await this.api(`/${this.state.sessionId}/signals`, {payload, connectionRevision: revision}); }
      catch (error) { if (epoch !== this.epoch || revision !== this.connectionRevision) return; if (error instanceof SessionApiError && error.status === 409) { this.schedulePoll(0); return; } throw error; }
    });
    return this.signalQueue;
  }
  private async connectPeer() {
    const epoch = this.epoch; const revision = this.connectionRevision;
    this.transportId = id();
    this.set({stage: 'connecting'});
    const servers = this.iceServers.map(server => ({...server, urls: (typeof server.urls === 'string' ? [server.urls] : server.urls).filter(url => !this.state.settings.directOnly || !url.startsWith('turn'))})).filter(server => server.urls.length);
    const pc = new RTCPeerConnection({iceServers: servers}); this.pc = pc;
    this.armConnectionDeadline(35000);
    pc.onicecandidate = event => { if (this.pc === pc && event.candidate) void this.sendSignal({type: 'candidate', candidate: event.candidate.toJSON()}).catch(error => { if (this.pc === pc) this.error(error); }); };
    pc.ondatachannel = event => { if (this.pc === pc) this.attachChannel(event.channel); else event.channel.close(); };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === 'connected') { this.reconnecting = false; this.checkConnected(); void this.refreshRoute(); }
      if (this.signalingUnavailable && ['failed', 'closed'].includes(pc.connectionState)) { this.endExpiredConnection(); return; }
      if (['disconnected', 'failed'].includes(pc.connectionState)) {
        this.set({stage: 'reconnecting'}); this.armConnectionDeadline(this.hadConnected ? 45000 : 35000);
        this.schedulePoll(0);
        for (const item of this.outgoing.values()) if (!terminal(item.status)) this.updateRow(item.id, {speed: 0, status: 'interrupted'});
        if (pc.connectionState === 'failed') void this.restartConnection();
        else if (!this.signalingUnavailable) setTimeout(() => { if (this.pc === pc && pc.connectionState === 'disconnected') void this.restartConnection(); }, 8000);
      }
    };
    if (this.state.role === 'host') {
      this.attachChannel(pc.createDataChannel('f8-control', {ordered: true})); this.attachChannel(pc.createDataChannel('f8-data', {ordered: true}));
      const offer = await pc.createOffer(); if (this.pc !== pc || epoch !== this.epoch || revision !== this.connectionRevision) return;
      await pc.setLocalDescription(offer); if (this.pc !== pc || epoch !== this.epoch || revision !== this.connectionRevision) return;
      await this.sendSignal({type: 'description', description: {type: offer.type, sdp: offer.sdp}});
    }
    if (this.pc !== pc) return;
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = setInterval(() => void this.refreshRoute(), 5000);
  }
  private async handleSignal(message: SignalMessage) {
    if (!this.pc || !message || !['description', 'candidate', 'restart'].includes(message.type)) return;
    const pc = this.pc;
    if (message.type === 'candidate' && message.candidate) {
      if (!pc.remoteDescription) this.candidates.push(message.candidate); else await pc.addIceCandidate(message.candidate);
    }
    if (message.type === 'description' && message.description) {
      if (!['offer', 'answer'].includes(message.description.type) || typeof message.description.sdp !== 'string') throw new Error('Invalid peer description.');
      await pc.setRemoteDescription(message.description); if (this.pc !== pc) return;
      for (const candidate of this.candidates.splice(0)) { if (this.pc !== pc) return; await pc.addIceCandidate(candidate); }
      if (message.description.type === 'offer') { const answer = await pc.createAnswer(); if (this.pc !== pc) return; await pc.setLocalDescription(answer); if (this.pc !== pc) return; await this.sendSignal({type: 'description', description: {type: answer.type, sdp: answer.sdp}}); }
    }
    if (message.type === 'restart') {
      if (message.replace === true && this.peerCheckpoints && this.hadConnected) await this.replaceTransport(this.state.role === 'host');
      else if (this.state.role === 'host') await this.restartConnection();
    }
  }
  private async restartConnection(replace = false) {
    if (this.signalingUnavailable) { this.endExpiredConnection(); return; }
    if (this.reconnecting || !this.pc) return; this.reconnecting = true;
    const pc = this.pc;
    try {
      if (this.hadConnected && this.peerCheckpoints && (replace || this.control?.readyState === 'closed' || this.data?.readyState === 'closed')) {
        if (this.state.role === 'host') await this.replaceTransport(true);
        else await this.sendSignal({type: 'restart', replace: true});
        return;
      }
      if (this.state.role === 'host') { const offer = await pc.createOffer({iceRestart: true}); if (this.pc !== pc) return; await pc.setLocalDescription(offer); if (this.pc !== pc) return; await this.sendSignal({type: 'description', description: {type: offer.type, sdp: offer.sdp}}); }
      else await this.sendSignal({type: 'restart'});
    } catch (error) { if (this.pc === pc) this.error(error); } finally { setTimeout(() => { if (this.pc === pc) this.reconnecting = false; }, 5000); }
  }
  /** Replace a dead SCTP transport while preserving same-page files, writers and hash states. */
  private async replaceTransport(notifyPeer: boolean) {
    if (this.replacingTransport || this.signalingUnavailable || !this.hadConnected) return;
    this.replacingTransport = true;
    const epoch = this.epoch; const revision = this.connectionRevision;
    try {
      if (notifyPeer) await this.sendSignal({type: 'restart', replace: true});
      if (epoch !== this.epoch || revision !== this.connectionRevision || this.destroyed) return;
      for (const item of this.outgoing.values()) if (!terminal(item.status)) {item.resumePending = true; this.updateRow(item.id, {status: 'interrupted', speed: 0});}
      this.closePeer(); this.peerCheckpoints = true; this.reconnecting = false;
      // Drain already-started writes before advertising a durable receive offset.
      await this.receiveQueue;
      if (epoch !== this.epoch || revision !== this.connectionRevision || this.destroyed) return;
      await this.connectPeer();
    } catch (error) {if (epoch === this.epoch) {this.reconnecting = false; this.error(error); this.schedulePoll(0);}}
    finally {this.replacingTransport = false;}
  }
  private attachChannel(channel: RTCDataChannel) {
    const revision = this.connectionRevision;
    channel.binaryType = 'arraybuffer';
    if (channel.label === 'f8-control') {
      this.control = channel;
      channel.onmessage = event => { this.controlQueue = this.controlQueue.then(() => { if (!this.destroyed && this.control === channel && revision === this.connectionRevision) return this.handleControl(event.data); }).catch(error => this.error(error)); };
    } else if (channel.label === 'f8-data') {
      this.data = channel; channel.bufferedAmountLowThreshold = 1024 * 1024;
      channel.onmessage = event => {
        if (this.destroyed || this.data !== channel || revision !== this.connectionRevision) return;
        const raw: unknown = event.data;
        if (!(raw instanceof ArrayBuffer) || raw.byteLength > MAX_CHUNK + FRAME_HEADER || !this.receiveFlow.enqueue(raw.byteLength)) {
          this.error(new Error('The other device exceeded the safe transfer buffer. Reconnect to continue.'));
          this.set({stage: 'closed'}); this.closePeer();
          for (const item of this.receiving.values()) if (!terminal(item.status)) void this.stopTransfer(item.id, 'failed', 'The peer exceeded the transfer buffer limit.');
          return;
        }
        this.queuedReceiveBytes += raw.byteLength;
        this.receiveQueue = this.receiveQueue.then(() => { if (!this.destroyed && this.data === channel && revision === this.connectionRevision) return this.receiveFrame(raw); }).catch(error => { this.error(error); }).finally(() => { this.queuedReceiveBytes = Math.max(0, this.queuedReceiveBytes - raw.byteLength); this.receiveFlow.dequeue(raw.byteLength); });
      };
    } else { channel.close(); return; }
    channel.onopen = () => this.checkConnected();
    channel.onclose = () => { if (this.signalingUnavailable) { this.endExpiredConnection(); return; } if (this.state.stage === 'connected') { this.set({stage: 'reconnecting'}); this.armConnectionDeadline(45000); this.schedulePoll(0); void this.restartConnection(true); } };
    channel.onerror = () => { if (this.signalingUnavailable) { this.endExpiredConnection(); return; } if (this.state.stage === 'connected') { this.set({stage: 'reconnecting'}); this.armConnectionDeadline(45000); this.schedulePoll(0); } };
  }
  private checkConnected() {
    if (this.control?.readyState !== 'open' || this.data?.readyState !== 'open') return;
    this.hadConnected = true; this.recoveryNotified = false;
    if (this.connectionDeadline) clearTimeout(this.connectionDeadline); this.connectionDeadline = null;
    this.set({stage: 'connected'});
    for (const item of this.outgoing.values()) if (!terminal(item.status) && item.status !== 'offered') { item.status = item.localPaused || item.remotePaused ? 'paused' : item.ending ? 'verifying' : item.started ? 'transferring' : 'queued'; this.updateRow(item.id, {status: item.status}, true); }
    for (const item of this.receiving.values()) if (!terminal(item.status)) { item.status = item.localPaused || item.remotePaused ? 'paused' : item.finishing ? 'verifying' : item.started ? 'transferring' : 'queued'; this.updateRow(item.id, {status: item.status}, true); }
    this.advertiseCapabilities();
    if (!this.accessChallenge) this.requestPeerAccess();
    this.grantQueuedReceives();
    if (this.peerCheckpoints && this.peerTransportId) void this.replayCheckpoints(this.peerTransportId).catch(error => this.error(error));
    void this.pump();
  }
  private advertiseCapabilities() {
    this.sendControl({type: 'hello', version: 1, sendPolicyVersion: SEND_POLICY_VERSION, memoryLimit: MEMORY_FILE_LIMIT, folder: this.state.capabilities.folderPicker,
      caps: {platform: 'browser', pendingDownloadLimit: MEMORY_FILE_LIMIT, folderAccessAvailable: this.state.capabilities.folderPicker,
        folderDestinationSelected: !!this.directory, fileAccessAvailable: this.state.capabilities.savePicker,
        receiveModes: this.state.capabilities.receiveModes, maxFileBytes: this.state.capabilities.maxFileBytes,
        flowControl: 1, resumeCheckpoints: 1, transportId: this.transportId, archiveFormat: 'zip64', archiveDelivery: 'file'}});
  }
  /** Checkpoints acknowledge bytes only after writes/hash updates; no file data is persisted remotely. */
  private async replayCheckpoints(peerTransportId: string) {
    const epoch = this.epoch; const revision = this.connectionRevision; const transportId = this.transportId;
    await this.receiveQueue;
    if (this.destroyed || epoch !== this.epoch || revision !== this.connectionRevision || transportId !== this.transportId || peerTransportId !== this.peerTransportId || this.state.stage !== 'connected') return;
    this.grantQueuedReceives();
    for (const item of this.receiving.values()) {
      if (['ready', 'saved', 'downloaded'].includes(item.status) && item.expectedHash) {
        this.sendControl({type: 'complete', id: item.id, operationId: item.operationId, hash: item.expectedHash, saved: item.status !== 'ready'});
      } else if (!terminal(item.status)) {
        if (item.hasherStarted) await this.hasher!.flush(item.id);
        if (this.destroyed || transportId !== this.transportId || epoch !== this.epoch || revision !== this.connectionRevision) return;
        this.sendControl({type: 'checkpoint', version: 1, transportId: peerTransportId, id: item.id, batchId: item.batchId, operationId: item.operationId, bytes: item.bytes, credit: Math.max(item.bytes, item.grantedCredit || 0), paused: item.localPaused});
      }
    }
    for (const item of this.outgoing.values()) if (!terminal(item.status) && item.ending && item.digest) this.sendControl({type: 'finish', id: item.id, operationId: item.operation?.intent.operationId, hash: item.digest});
  }
  private async resumeOutgoing(message: Control) {
    if (!this.peerCheckpoints || message.version !== 1 || message.transportId !== this.transportId || typeof message.id !== 'string') return;
    const item = this.outgoing.get(message.id);
    if (!item || terminal(item.status) || message.batchId !== item.batchId || item.operation && this.options.sendRuntime && message.operationId !== item.operation.intent.operationId) return;
    const bytes = message.bytes; const credit = message.credit;
    if (!isValidFileSize(bytes) || bytes < item.confirmed || bytes > item.offset || bytes > item.file.size || !Number.isSafeInteger(credit) || Number(credit) < bytes || Number(credit) > Math.min(item.file.size, bytes + RECEIVE_WINDOW) || typeof message.paused !== 'boolean') return;
    const epoch = this.epoch; const revision = this.connectionRevision; const transportId = this.transportId;
    if (item.resumePending && bytes < item.offset) {
      // A replacement channel can lose unacknowledged frames. Re-hash the retained
      // source prefix in bounded pieces rather than trusting a wire-provided hash.
      this.hasher!.cancel(item.id); this.hasher!.start(item.id); item.hashStarted = true; item.digest = undefined; item.ending = false;
      for (let offset = 0; offset < bytes; offset += MAX_CHUNK) {
        const chunk = await item.file.slice(offset, Math.min(bytes, offset + MAX_CHUNK)).arrayBuffer();
        if (epoch !== this.epoch || revision !== this.connectionRevision || transportId !== this.transportId || terminal(item.status)) return;
        this.hasher!.update(item.id, chunk);
        if (offset % (256 * 1024) === 0) await this.hasher!.flush(item.id);
      }
      await this.hasher!.flush(item.id);
      if (epoch !== this.epoch || revision !== this.connectionRevision || transportId !== this.transportId || terminal(item.status)) return;
      item.offset = bytes;
    }
    item.resumePending = false; item.confirmed = bytes; item.credit = Number(credit); item.remotePaused = message.paused; item.lastActivity = now();
    if (item.status === 'offered' || item.status === 'interrupted' || !item.ending) item.status = item.localPaused || item.remotePaused ? 'paused' : 'queued';
    this.scheduler.ack(`${this.state.sessionId}:${item.id}`, bytes);
    this.updateRow(item.id, {bytes, status: item.status}, true);
    if (item.ending && item.digest) this.sendControl({type: 'finish', id: item.id, operationId: item.operation?.intent.operationId, hash: item.digest});
    void this.pump();
  }
  private accessNow() {
    if (this.options.accessRuntime?.now) return this.options.accessRuntime.now();
    const access = this.options.accessRuntime?.getAccess();
    if (access && access !== this.accessSource) {this.accessSource = access; this.accessClock = {server: access.serverNow, local: now()};}
    return this.accessClock.server + Math.max(0, now() - this.accessClock.local);
  }
  /** Public preflight lets a group fail atomically instead of silently skipping recipients. */
  getAccessBlockReason = (): string | null => this.accessError();
  getFileBlockReason = (files: readonly SelectedFile[]): string | null => {
    if (files.some(file => !isValidFileSize(file.size))) return 'A selected file exceeds the supported transfer limits.';
    const peer = this.state.receiverCapabilities[0];
    if (peer?.maxFileBytes !== undefined && files.some(file => file.size > peer.maxFileBytes!)) return `${peer.peerName || 'The receiving device'} cannot safely save this file in its current browser. Use a supported browser with direct saving.`;
    return null;
  };
  private accessError(): string | null {
    if (this.options.sendRuntime && this.peerSendPolicy === 0) return 'Waiting for the other device to confirm the current send policy. Keep both pages open and try again shortly.';
    if (this.options.sendRuntime && this.peerSendPolicy !== SEND_POLICY_VERSION) return 'Refresh both devices to use the current send policy before offering new files. Already accepted transfers can finish.';
    return null;
  }
  private pairHyperSpeed() {
    if (!this.options.accessRuntime) return true;
    const access = this.options.accessRuntime.getAccess(); const time = this.accessNow();
    return !!(access?.allowed && access.kind === 'paid' && access.hyperSpeed && (access.expiresAt || 0) > time || this.peerClaims?.kind === 'paid' && this.peerClaims.hyperSpeed && this.peerClaims.exp * 1000 > time);
  }
  private updatePeerAccess(message?: string) {
    if (!this.options.accessRuntime) return;
    const claims = this.peerClaims; const valid = !!claims && claims.exp * 1000 > this.accessNow();
    this.set({peerAccess: [{peerName: this.state.peerName || 'Other device', status: valid && claims!.kind === 'paid' ? 'valid' : 'standard', kind: valid && claims!.kind === 'paid' ? 'paid' : 'none', expiresAt: valid && claims!.kind === 'paid' ? claims!.exp * 1000 : null, hyperSpeed: valid && claims!.kind === 'paid' && claims!.hyperSpeed, ...(message ? {message} : {})}], speedPolicy: this.scheduler.getSnapshot()});
  }
  private requestPeerAccess() {
    if (!this.options.accessRuntime || !this.state.sessionId || this.control?.readyState !== 'open') return;
    this.accessChallenge = id(); this.challengeUsed = false; this.accessVersion++;
    this.updatePeerAccess(); this.sendControl({type: 'access-challenge', version: 1, challenge: this.accessChallenge});
  }
  private async advertiseAccess() {
    const runtime = this.options.accessRuntime; const challenge = this.remoteChallenge;
    if (!runtime || !challenge || !this.state.sessionId) return;
    const epoch = this.epoch; const revision = this.connectionRevision; const sessionId = this.state.sessionId;
    const access = runtime.getAccess();
    if (!access?.proof || !access.allowed || (access.expiresAt || 0) <= this.accessNow()) {this.sendControl({type: 'access-required', version: 1, challenge}); return;}
    try {
      const device = await runtime.getIdentity();
      const signature = await runtime.signChallenge(peerChallengeText(sessionId, revision, challenge, access.proof));
      if (epoch !== this.epoch || revision !== this.connectionRevision || challenge !== this.remoteChallenge) return;
      this.sendControl({type: 'access-proof', version: 1, challenge, proof: access.proof, device, signature});
    } catch (error) {if (epoch === this.epoch) this.error(new Error(`Could not prove this installation's access. ${errorMessage(error)}`));}
  }
  sendGroupEvent(type: 'roster-refresh' | 'group-ended' | 'member-left') {return this.sendControl({type: 'group-event', version: 1, event: type});}
  private async refreshRoute() {
    if (!this.pc || this.pc.connectionState !== 'connected') return;
    const pc = this.pc;
    try {
      const stats = await pc.getStats(); if (this.pc !== pc) return; let pair: RTCStats | undefined;
      stats.forEach(report => { if (report.type === 'transport' && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId); });
      if (!pair) stats.forEach(report => { if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) pair = report; });
      if (!pair) return;
      const candidatePair = pair as RTCIceCandidatePairStats; const local = stats.get(candidatePair.localCandidateId); const remote = stats.get(candidatePair.remoteCandidateId);
      const pairIdentity = `${candidatePair.localCandidateId}:${candidatePair.remoteCandidateId}`;
      if (pairIdentity !== this.selectedPair) {this.scheduler.route(this.state.sessionId || '', pairIdentity); this.selectedPair = pairIdentity;}
      const route = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct';
      if (route !== this.state.route) { for (const item of this.outgoing.values()) { item.sampled = now(); item.sampledBytes = item.confirmed; } this.set({route}); }
    } catch { /* A route label is optional when browser stats are unavailable. */ }
  }
  private sendControl(message: Control): boolean {
    if (this.control?.readyState !== 'open') return false;
    try { const text = JSON.stringify(message); if (text.length > 200_000) throw new Error('File batch is too large. Send fewer files.'); this.control.send(text); return true; }
    catch (error) { this.error(error); return false; }
  }
  addFiles = (files: FileList | File[]) => {
    const added: SelectedFile[] = [];
    for (const file of Array.from(files)) {
      if (this.selected.size >= MAX_BATCH_FILES) { void releasePreparedArchive(file); this.error(new Error('Select up to 500 files per batch.')); continue; }
      if (!isValidFileSize(file.size)) {void releasePreparedArchive(file); this.error(new Error('This file exceeds the supported size. See the large-file FAQ for supported browsers and file sizes.')); continue;}
      const fileId = id(); this.selected.set(fileId, file); added.push({id: fileId, name: file.name, size: file.size, type: file.type});
    }
    this.set({selectedFiles: [...this.state.selectedFiles, ...added]});
  };
  removeFile = (fileId: string) => { const file = this.selected.get(fileId); this.selected.delete(fileId); if (file) void releasePreparedArchive(file); this.set({selectedFiles: this.state.selectedFiles.filter(file => file.id !== fileId)}); };
  clearFiles = () => { for (const file of this.selected.values()) void releasePreparedArchive(file); this.selected.clear(); this.set({selectedFiles: []}); };
  private sendScope() {return this.options.sendScope || {sessionId: this.state.sessionId || '', selfRecipientId: `${this.state.sessionId}:${this.state.role}`, peerRecipientId: `${this.state.sessionId}:${this.state.role === 'host' ? 'guest' : 'host'}`};}
  private removeSnapshot(files: SendFileSnapshot[]) {
    const ids = new Set(files.map(file => file.info.id)); for (const fileId of ids) {const file = this.selected.get(fileId); this.selected.delete(fileId); if (file) void releasePreparedArchive(file);}
    this.set({selectedFiles: this.state.selectedFiles.filter(file => !ids.has(file.id))});
  }
  private retainOutgoingSource(fileId: string, file: File) {
    retainPreparedArchive(file);
    const previous = this.outgoing.get(fileId);
    if (previous) this.releaseOutgoingSource(previous);
  }
  private releaseOutgoingSource(item: Outgoing) {
    if (!item.sourceReleased) {item.sourceReleased = true; void releasePreparedArchive(item.file);}
  }
  sendSelected = async () => {
    if (this.state.sendPreparing) return;
    const files = this.state.selectedFiles.map(info => ({info: {...info}, file: this.selected.get(info.id)!}));
    if (!files.length) return;
    for (const snapshot of files) retainPreparedArchive(snapshot.file);
    const epoch = this.epoch; let operation: SendOperation | null = null;
    this.set({sendPreparing: true});
    try {
      if (this.state.stage !== 'connected') throw new Error('Connect another device before sending.');
      const blocked = this.accessError(); if (blocked) throw new Error(blocked);
      const fileBlocked = this.getFileBlockReason(files.map(file => file.info)); if (fileBlocked) throw new Error(fileBlocked);
      const scope = this.sendScope();
      const intent: SendIntent = {operationId: id(), sessionId: scope.sessionId, files: files.map(file => ({id: file.info.id, size: file.info.size})), recipientIds: [scope.peerRecipientId], manifestDigest: ''};
      intent.manifestDigest = await digestSendManifest(intent); freezeSendIntent(intent);
      const permit = this.options.sendRuntime ? await this.options.sendRuntime.authorize(intent) : null;
      if (this.options.sendRuntime && !permit) return;
      operation = new SendOperation(intent, permit, this.options.sendRuntime, error => this.error(error));
      if (epoch !== this.epoch || this.destroyed || this.state.stage !== 'connected') return;
      if (await this.sendAuthorized(operation, files)) this.removeSnapshot(files);
    } catch (error) { if (epoch === this.epoch) this.error(error); }
    finally {for (const snapshot of files) void releasePreparedArchive(snapshot.file); operation?.seal(); if (epoch === this.epoch) this.set({sendPreparing: false});}
  };
  /** Group fanout supplies its one already-authorized immutable parent operation. */
  async sendAuthorized(operation: SendOperation, snapshots: SendFileSnapshot[]): Promise<boolean> {
    const epoch = this.epoch;
    try {return await this.sendAuthorizedInternal(operation, snapshots);}
    catch (error) {
      if (epoch !== this.epoch || this.destroyed) return false;
      const batchId = id();
      for (const snapshot of snapshots) {
        const key = `${this.state.sessionId}:${snapshot.info.id}`; operation.expect(key);
        this.retainOutgoingSource(snapshot.info.id, snapshot.file);
        this.outgoing.set(snapshot.info.id, {id: snapshot.info.id, batchId, operation, digest: snapshot.digest, file: snapshot.file, offset: 0, confirmed: 0, credit: 0, localPaused: false, remotePaused: false, status: 'failed', started: 0, sampled: now(), sampledBytes: 0, hashStarted: false, ending: false, lastActivity: now(), nextSendAt: 0});
        operation.outcome(key, 'released');
      }
      const ids = new Set(snapshots.map(file => file.info.id));
      this.set({transfers: [...this.state.transfers.filter(row => row.direction !== 'outgoing' || !ids.has(row.id)), ...snapshots.map(({info}) => ({...this.row(info, batchId, 'outgoing', 'failed'), operationId: operation.intent.operationId, error: errorMessage(error)}))]});
      this.error(error); return false;
    }
  }
  private async sendAuthorizedInternal(operation: SendOperation, snapshots: SendFileSnapshot[]): Promise<boolean> {
    const epoch = this.epoch; const revision = this.connectionRevision; const scope = this.sendScope();
    if (this.state.stage !== 'connected') throw new Error('A selected device disconnected before the file offer.');
    const blocked = this.accessError(); if (blocked) throw new Error(blocked);
    const files = snapshots.map(snapshot => ({...snapshot.info}));
    if (!files.length || files.length > MAX_BATCH_FILES || files.some(file => !isValidFileSize(file.size))) throw new Error('The selected files exceed the supported transfer limits.');
    let authorization: SendEnvelope | undefined;
    if (this.options.sendRuntime) {
      if (!operation.permit || !this.options.accessRuntime || !this.state.sessionId) throw new Error('This device cannot sign the send authorization. Refresh and try again.');
      const device = await this.options.accessRuntime.getIdentity();
      await validateSendPermit(operation.intent, operation.permit, this.options.accessRuntime.getAccess()?.config || null, this.accessNow(), device);
      authorization = {intent: operation.intent, permit: operation.permit, device, signature: await this.options.accessRuntime.signChallenge(sendEnvelopeText(this.state.sessionId, revision, scope.peerRecipientId, operation.intent, operation.permit))};
      if (!operation.intent.recipientIds.includes(scope.peerRecipientId) || operation.intent.sessionId !== scope.sessionId || files.some(file => !operation.intent.files.some(entry => entry.id === file.id && entry.size === file.size))) throw new Error('The authorized files or recipients changed.');
    }
    if (epoch !== this.epoch || revision !== this.connectionRevision || this.state.stage !== 'connected') throw new Error('The connection changed while preparing this send. Try the same transfer again.');
    const batchId = id();
    for (const snapshot of snapshots) {
      operation.expect(`${this.state.sessionId}:${snapshot.info.id}`);
      this.retainOutgoingSource(snapshot.info.id, snapshot.file);
      this.outgoing.set(snapshot.info.id, {id: snapshot.info.id, batchId, operation, digest: snapshot.digest, retryDigest: !!snapshot.digest, file: snapshot.file, offset: 0, confirmed: 0, credit: 0, localPaused: false, remotePaused: false, status: 'offered', started: 0, sampled: now(), sampledBytes: 0, hashStarted: false, ending: false, lastActivity: now(), nextSendAt: 0});
    }
    const ids = new Set(files.map(file => file.id));
    this.set({transfers: [...this.state.transfers.filter(row => row.direction !== 'outgoing' || !ids.has(row.id)), ...files.map(file => ({...this.row(file, batchId, 'outgoing', 'offered'), operationId: operation.intent.operationId}))]});
    if (!this.sendControl({type: 'offer', version: this.options.sendRuntime ? 2 : 1, batchId, files, ...(authorization ? {authorization} : {})})) {
      for (const file of files) await this.stopTransfer(file.id, 'failed', 'The connection closed before the offer was sent.');
      return false;
    }
    return true;
  }
  private row(file: SelectedFile, batchId: string, direction: 'incoming' | 'outgoing', status: TransferStatus): TransferRow { return {...file, batchId, direction, status, bytes: 0, speed: 0, averageSpeed: 0, remainingSeconds: null}; }
  acceptBatch = async (batchId: string, fileIds?: string[]) => {
    const batch = this.state.incomingBatches.find(batch => batch.id === batchId); if (!batch) return;
    const epoch = this.epoch;
    let selectedSink: ReceiveSink | null = null;
    try {
      const files = batch.files.filter(file => !fileIds || fileIds.includes(file.id));
      if (!files.length) { this.declineBatch(batchId); return; }
      if (files.length > MAX_BATCH_FILES || files.some(file => !isValidFileSize(file.size))) throw new Error('This offer exceeds the supported transfer limits.');
      const total = files.reduce((sum, file) => sum + file.size, 0);
      if (!this.directory && total + (this.options.receiveBudget?.used ?? this.memoryReserved) > MEMORY_FILE_LIMIT) {
        if (this.state.capabilities.folderPicker) await this.chooseFolderOrThrow();
        else if (this.state.capabilities.savePicker && files.length === 1) selectedSink = await chooseFileSink(files[0].name);
        else throw new Error(this.state.capabilities.savePicker
          ? 'Accept one large file at a time so you can choose where to save it, or choose a browser that supports saving a whole folder.'
          : 'This browser cannot safely receive this selection. Download pending files first, choose fewer small files, or use an up-to-date Chrome or Edge browser with direct saving.');
      }
      if (this.directory?.queryPermission && await this.directory.queryPermission({mode: 'readwrite'}) !== 'granted') {
        if (await this.directory.requestPermission?.({mode: 'readwrite'}) !== 'granted') throw new Error('Folder permission was denied. Choose the destination again.');
      }
      if (epoch !== this.epoch || this.destroyed || !this.state.incomingBatches.some(item => item.id === batchId)) {await selectedSink?.abort(); return;}
      if (!this.peerFlowControl && files.reduce((sum, file) => sum + Math.min(file.size, RECEIVE_WINDOW), 0) > this.receiveFlow.available) throw new Error('Refresh the sending device before accepting this many files together. Its older transfer version cannot safely queue this selection.');
      if (!this.directory && !selectedSink && this.options.receiveBudget) {
        if (total + this.options.receiveBudget.used > this.options.receiveBudget.limit) throw new Error('This group can hold up to 64 MiB total of pending downloads in this tab. Download received files or choose a folder before accepting more.');
        this.options.receiveBudget.used += total;
      }
      for (const file of files) {
        this.receiving.set(file.id, {id: file.id, batchId, operationId: batch.operationId, info: file, bytes: 0, status: 'queued', localPaused: false, remotePaused: false, sink: selectedSink ? Promise.resolve(selectedSink) : null, diskSink: !!selectedSink, directory: this.directory, grantedCredit: 0, started: 0, lastAck: 0, lastAckTime: now(), sampled: now(), sampledBytes: 0, finishing: false, hasherStarted: false});
        if (!this.directory && !selectedSink) this.memoryReserved += file.size;
      }
      const receivingIds = new Set(files.map(file => file.id));
      this.set({incomingBatches: this.state.incomingBatches.filter(batch => batch.id !== batchId), transfers: [...this.state.transfers.filter(row => row.direction !== 'incoming' || !receivingIds.has(row.id)), ...files.map(file => ({...this.row(file, batchId, 'incoming', 'queued'), operationId: batch.operationId, saveMethod: this.directory ? 'folder' as const : selectedSink ? 'file' as const : 'download' as const}))]});
      this.sendControl({type: 'accept', batchId, operationId: batch.operationId, fileIds: files.map(file => file.id), credit: this.peerFlowControl ? 0 : RECEIVE_WINDOW});
      this.grantQueuedReceives();
    } catch (error) {await selectedSink?.abort(); if (!(error instanceof DOMException && error.name === 'AbortError')) this.error(error);}
  };
  declineBatch = (batchId: string) => {this.sendControl({type: 'reject', batchId, operationId: this.incomingOperations.get(batchId)}); this.set({incomingBatches: this.state.incomingBatches.filter(batch => batch.id !== batchId)});};
  private async handleControl(raw: unknown) {
    if (typeof raw !== 'string' || raw.length > 200_000) throw new Error('Invalid peer message.');
    const message = JSON.parse(raw) as Control;
    if (!message || typeof message.type !== 'string') throw new Error('Invalid peer message.');
    const fileId = typeof message.id === 'string' ? message.id : '';
    if (message.type === 'group-event') {
      if (message.version === 1 && ['roster-refresh', 'group-ended', 'member-left'].includes(String(message.event))) this.options.onGroupEvent?.(message.event as 'roster-refresh' | 'group-ended' | 'member-left');
      return;
    }
    if (message.type === 'access-refresh') {if (message.version === 1) this.requestPeerAccess(); return;}
    if (message.type === 'access-challenge') {
      if (message.version !== 1 || typeof message.challenge !== 'string' || !/^[a-zA-Z0-9-]{16,128}$/.test(message.challenge)) throw new Error('Invalid access challenge.');
      this.remoteChallenge = message.challenge; await this.advertiseAccess(); return;
    }
    if (message.type === 'access-required') {
      if (message.version === 1 && message.challenge === this.accessChallenge && !this.challengeUsed) {
        this.challengeUsed = true; this.peerClaims = null; this.updatePeerAccess();
      }
      return;
    }
    if (message.type === 'access-proof') {
      const runtime = this.options.accessRuntime; const config = runtime?.getAccess()?.config;
      if (!runtime || !config || message.version !== 1 || message.challenge !== this.accessChallenge || this.challengeUsed || !this.state.sessionId) return;
      this.challengeUsed = true; const version = this.accessVersion; const epoch = this.epoch;
      try {
        const claims = await verifyPeerAccess(message as unknown as PeerAccessProof, config, {sessionId: this.state.sessionId, revision: this.connectionRevision, challenge: this.accessChallenge, nowMs: this.accessNow()});
        if (version !== this.accessVersion || epoch !== this.epoch) return;
        this.peerClaims = claims.kind === 'paid' ? claims : null; this.updatePeerAccess();
      } catch (error) {if (version === this.accessVersion && epoch === this.epoch) {this.peerClaims = null; this.updatePeerAccess(`Premium speed could not be verified. Standard transfer remains available. ${errorMessage(error)}`);}}
      return;
    }
    if (message.type === 'access-denied') {
      if (typeof message.batchId === 'string') for (const item of this.outgoing.values()) if (item.batchId === message.batchId && item.status === 'offered') await this.stopTransfer(item.id, 'failed', 'The other device uses an older access policy. Refresh both devices before retrying.');
      this.error(new Error('The other device uses an older access policy. Refresh both devices before starting a new transfer.')); return;
    }
    if (message.type === 'chat') {
      if (message.version !== 1 || !validChat(message)) throw new Error('Invalid chat message.');
      const chat = {id: message.id as string, text: message.text as string, sentAt: message.sentAt as number, recipient: message.recipient as string};
      if (this.options.onChat) this.options.onChat(chat);
      else if (!this.state.chatMessages.some(item => item.id === chat.id)) this.set({chatMessages: [...this.state.chatMessages.slice(-199), {...chat, senderId: this.state.role === 'host' ? 'guest' : 'host', senderName: this.state.peerName, own: false}]});
      return;
    }
    if (message.type === 'hello') {
      if (message.version !== 1) { this.error(new Error('The other device uses an unsupported version. Refresh both pages.')); await this.disconnect(); }
      else {
        const caps = message.caps && typeof message.caps === 'object' ? message.caps as Record<string, unknown> : {};
        this.peerSendPolicy = message.sendPolicyVersion === SEND_POLICY_VERSION ? SEND_POLICY_VERSION : 1; this.peerFlowControl = caps.flowControl === 1;
        this.peerCheckpoints = caps.resumeCheckpoints === 1 && typeof caps.transportId === 'string' && /^[a-f0-9-]{36}$/i.test(caps.transportId);
        this.peerTransportId = this.peerCheckpoints ? String(caps.transportId) : '';
        const capability = receiverCapability(message, this.state.peerName); this.set({receiverCapabilities: capability ? [capability] : []}); this.grantQueuedReceives();
        if (this.peerCheckpoints) await this.replayCheckpoints(this.peerTransportId);
        else for (const item of this.outgoing.values()) if (item.resumePending && !terminal(item.status)) await this.stopTransfer(item.id, 'failed', 'The other browser cannot resume this interrupted transfer. Refresh both devices and retry it.');
      }
      return;
    }
    if (message.type === 'checkpoint') {await this.resumeOutgoing(message); return;}
    if (message.type === 'offer') {
      if (![1, 2].includes(Number(message.version)) || typeof message.batchId !== 'string' || !Array.isArray(message.files) || !message.files.length || message.files.length > MAX_BATCH_FILES) throw new Error('Invalid incoming file offer.');
      if (this.options.sendRuntime && message.version !== 2) {this.sendControl({type: 'reject', batchId: message.batchId}); this.error(new Error('The other device needs to refresh for the current send policy. Already accepted transfers continue.')); return;}
      if (this.state.incomingBatches.length >= 20) { this.sendControl({type: 'reject', batchId: message.batchId}); return; }
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuid.test(message.batchId)) throw new Error('Invalid batch identifier.');
      const ids = new Set<string>();
      const envelope = message.version === 2 ? message.authorization as SendEnvelope : undefined;
      if (message.version === 2) {
        const scope = this.sendScope();
        try {await verifySendEnvelope(envelope!, {roomId: this.state.sessionId || '', revision: this.connectionRevision, sessionId: scope.sessionId, recipientId: scope.selfRecipientId, files: message.files as {id: string; size: number}[], nowMs: this.accessNow()}, this.options.accessRuntime?.getAccess()?.config || null);}
        catch (error) {this.sendControl({type: 'reject', batchId: message.batchId, operationId: envelope?.intent?.operationId}); this.error(new Error(`The incoming send authorization was rejected. ${errorMessage(error)}`)); return;}
      }
      const files: SelectedFile[] = message.files.map((value: unknown) => {
        const file = value as SelectedFile;
        const previous = this.receiving.get(file?.id);
        const retryable = previous && ['failed', 'canceled', 'saved', 'downloaded', 'ready'].includes(previous.status) && envelope?.intent.operationId === previous.operationId;
        if (!file || typeof file.id !== 'string' || !uuid.test(file.id) || ids.has(file.id) || this.outgoing.has(file.id) || previous && !retryable || this.state.incomingBatches.some(batch => batch.files.some(pending => pending.id === file.id)) || typeof file.name !== 'string' || file.name.length > 1024 || !isValidFileSize(file.size) || typeof file.type !== 'string' || file.type.length > 255) throw new Error('Invalid incoming file information.');
        ids.add(file.id); return {id: file.id, name: safeFilename(file.name), size: file.size, type: file.type};
      });
      if (this.state.incomingBatches.some(batch => batch.id === message.batchId)) return;
      const pending = files.filter(file => {
        const previous = this.receiving.get(file.id);
        if (previous && previous.operationId === envelope?.intent.operationId && ['saved', 'downloaded', 'ready'].includes(previous.status)) {this.sendControl({type: 'complete', id: file.id, operationId: previous.operationId, hash: previous.expectedHash, saved: previous.status !== 'ready'}); return false;}
        return true;
      });
      if (!pending.length) return;
      const batch: IncomingBatch = {id: message.batchId, operationId: envelope?.intent.operationId, files: pending, peerName: this.state.peerName, receivedAt: Date.now()};
      if (batch.operationId) this.incomingOperations.set(batch.id, batch.operationId);
      this.set({incomingBatches: [...this.state.incomingBatches, batch]}); return;
    }
    if (message.type === 'accept' || message.type === 'reject') {
      const accepted = message.type === 'accept' && Array.isArray(message.fileIds) ? new Set(message.fileIds as string[]) : new Set<string>();
      for (const item of this.outgoing.values()) if (item.batchId === message.batchId && item.status === 'offered') {
        if (item.operation && this.options.sendRuntime && message.operationId !== item.operation.intent.operationId) continue;
        item.status = accepted.has(item.id) ? 'queued' : 'canceled'; item.credit = this.peerFlowControl && Number.isSafeInteger(message.credit) && Number(message.credit) >= 0 && Number(message.credit) <= RECEIVE_WINDOW ? Number(message.credit) : RECEIVE_WINDOW;
        if (item.status === 'canceled') item.operation?.outcome(`${this.state.sessionId}:${item.id}`, 'released');
        this.updateRow(item.id, {status: item.status}, true);
      }
      void this.pump(); return;
    }
    if (message.type === 'ack') {
      const item = this.outgoing.get(fileId);
      if (item?.operation && this.options.sendRuntime && message.operationId !== item.operation.intent.operationId) return;
      if (!item || terminal(item.status) || typeof message.bytes !== 'number' || !Number.isSafeInteger(message.bytes) || message.bytes < item.confirmed || message.bytes > item.offset || typeof message.credit !== 'number' || !Number.isSafeInteger(message.credit) || message.credit < message.bytes || message.credit > message.bytes + RECEIVE_WINDOW) return;
      item.confirmed = message.bytes; item.credit = message.credit; item.lastActivity = now(); this.scheduler.ack(`${this.state.sessionId}:${item.id}`, item.confirmed);
      this.updateRow(item.id, {bytes: item.confirmed}); void this.pump(); return;
    }
    if (message.type === 'finish') {
      const item = this.receiving.get(fileId);
      if (!item || typeof message.hash !== 'string' || !/^[0-9a-f]{64}$/.test(message.hash)) return;
      if (item.operationId && message.operationId !== item.operationId) return;
      if (terminal(item.status)) {
        if (this.peerCheckpoints && ['ready', 'saved', 'downloaded'].includes(item.status) && item.expectedHash === message.hash) this.sendControl({type: 'complete', id: item.id, operationId: item.operationId, hash: item.expectedHash, saved: item.status !== 'ready'});
        return;
      }
      item.expectedHash = message.hash;
      // The independent data channel can deliver its final frame after this control message.
      await this.receiveQueue; await this.finishIncoming(item); return;
    }
    if (message.type === 'complete') {
      const item = this.outgoing.get(fileId); if (!item || terminal(item.status)) return;
      if (item.operation && this.options.sendRuntime && message.operationId !== item.operation.intent.operationId) return;
      if (!item.digest || typeof message.hash !== 'string' || message.hash !== item.digest || (!item.ending || item.offset !== item.file.size) && !item.retryDigest) return;
      item.status = message.saved === true ? 'saved' : 'received'; item.confirmed = item.file.size;
      this.releaseOutgoingSource(item);
      item.operation?.outcome(`${this.state.sessionId}:${item.id}`, 'verified');
      this.scheduler.ack(`${this.state.sessionId}:${item.id}`, item.confirmed); this.scheduler.remove(`${this.state.sessionId}:${item.id}`);
      this.updateRow(item.id, {status: item.status, bytes: item.file.size, speed: 0, remainingSeconds: 0}, true); void this.pump(); return;
    }
    if (message.type === 'pause' || message.type === 'resume') {
      const paused = message.type === 'pause'; const outgoing = this.outgoing.get(fileId); const incoming = this.receiving.get(fileId);
      if (outgoing && !terminal(outgoing.status)) { outgoing.remotePaused = paused; outgoing.status = paused || outgoing.localPaused ? 'paused' : 'queued'; this.updateRow(fileId, {status: outgoing.status}, true); }
      if (incoming && !terminal(incoming.status)) { incoming.remotePaused = paused; incoming.status = paused || incoming.localPaused ? 'paused' : 'transferring'; this.updateRow(fileId, {status: incoming.status}, true); }
      if (!paused) {this.grantQueuedReceives(); void this.pump();} return;
    }
    if (message.type === 'cancel' || message.type === 'error') {
      const error = message.type === 'error' ? String(message.error || 'The other device could not complete this file.').slice(0, 400) : undefined;
      await this.stopTransfer(fileId, error ? 'failed' : 'canceled', error); return;
    }
    if (message.type === 'speed-start' && typeof message.id === 'string' && /^[0-9a-f-]{36}$/i.test(message.id)) {
      if (this.options.accessRuntime) {this.sendControl({type: 'speed-result', id: message.id, speed: 0}); return;}
      if (this.speedReceive.size || this.speedRun || [...this.receiving.values()].some(item => !terminal(item.status))) { this.sendControl({type: 'speed-result', id: message.id, speed: 0}); return; }
      this.speedReceive.set(message.id, {bytes: 0, started: 0}); this.sendControl({type: 'speed-ready', id: message.id}); return;
    }
    if (message.type === 'speed-ready' && this.speedRun && this.speedRun.id === message.id) { this.speedRun.started = now(); return; }
    if (message.type === 'speed-end' && typeof message.id === 'string' && typeof message.bytes === 'number') {
      const run = this.speedReceive.get(message.id); if (!run) return;
      const expected = message.bytes;
      await this.receiveQueue;
      if (run.bytes >= expected) this.finishSpeedReceive(message.id);
      else { (run as typeof run & {expected?: number}).expected = expected; }
      return;
    }
    if (message.type === 'speed-result' && this.speedRun && this.speedRun.id === message.id && typeof message.speed === 'number') this.speedRun.done(Math.max(0, message.speed));
  }
  private async receiveFrame(raw: unknown) {
    const epoch = this.epoch; const revision = this.connectionRevision;
    const current = () => !this.destroyed && epoch === this.epoch && revision === this.connectionRevision;
    if (!(raw instanceof ArrayBuffer)) throw new Error('The other device sent an unsupported file frame.');
    const frame = decodeFrame(raw);
    const speed = this.speedReceive.get(frame.fileId);
    if (speed && frame.batchId === frame.fileId) {
      if (frame.offset !== speed.bytes || speed.bytes + frame.payload.length > 32 * 1024 * 1024) throw new Error('Invalid speed test frame.');
      if (!speed.started) speed.started = now(); speed.bytes += frame.payload.byteLength;
      const expected = (speed as typeof speed & {expected?: number}).expected;
      if (expected !== undefined && speed.bytes >= expected) this.finishSpeedReceive(frame.fileId);
      return;
    }
    const item = this.receiving.get(frame.fileId);
    if (!item || terminal(item.status)) return;
    try {
      if (frame.batchId !== item.batchId || frame.offset !== item.bytes || frame.offset + frame.payload.byteLength > item.info.size || frame.offset + frame.payload.byteLength > (item.grantedCredit ?? item.lastAck + RECEIVE_WINDOW)) throw new Error('File data arrived out of order or exceeded its receiving window.');
      if (!item.hasherStarted) { this.hasher!.start(item.id); item.hasherStarted = true; }
      if (!item.started) { item.started = now(); item.sampled = now(); }
      item.sink ||= item.directory ? folderSink(item.directory, item.info.name) : Promise.resolve(memorySink(item.info.type));
      const sink = await item.sink; await sink.write(frame.payload);
      if (!current() || terminal(item.status)) return;
      const hashBytes = frame.payload.buffer.slice(frame.payload.byteOffset, frame.payload.byteOffset + frame.payload.byteLength) as ArrayBuffer;
      this.hasher!.update(item.id, hashBytes);
      item.bytes += frame.payload.byteLength; item.status = item.localPaused || item.remotePaused ? 'paused' : 'transferring';
      this.updateRow(item.id, {bytes: item.bytes, status: item.status});
      if (item.bytes - item.lastAck >= 256 * 1024 || now() - item.lastAckTime > 100 || item.bytes === item.info.size) { await this.hasher!.flush(item.id); if (!current() || terminal(item.status)) return; this.ack(item); }
      await this.finishIncoming(item);
    } catch (error) { if (!current() || terminal(item.status)) return; await this.stopTransfer(item.id, 'failed', errorMessage(error)); if (current()) this.sendControl({type: 'error', id: item.id, error: errorMessage(error)}); }
  }
  private ack(item: Receiving) {
    item.lastAck = item.bytes; item.lastAckTime = now();
    const window = this.receiveWindows.get(item.id)?.bytes ?? (item.grantedCredit === undefined ? RECEIVE_WINDOW : 0);
    const credit = item.localPaused ? item.bytes : Math.min(item.info.size, item.bytes + window);
    item.grantedCredit = Math.max(item.grantedCredit || 0, credit);
    this.sendControl({type: 'ack', id: item.id, operationId: item.operationId, bytes: item.bytes, credit});
  }
  /** Credits reserve actual tab-wide capacity; a slow disk cannot accumulate whole files. */
  private grantQueuedReceives() {
    if (this.destroyed || this.state.stage !== 'connected') return;
    for (const item of this.receiving.values()) {
      if (terminal(item.status)) continue;
      if (!this.receiveWindows.has(item.id) && !item.localPaused && !item.remotePaused) {
        if (this.peerFlowControl && this.receiveWindows.size >= 2) continue;
        const bytes = Math.min(RECEIVE_WINDOW, item.info.size);
        if (!this.receiveFlow.acquire(item, bytes)) continue;
        this.receiveWindows.set(item.id, {owner: item, bytes});
      }
      this.ack(item);
    }
  }
  private releaseReceiveWindow(item: Receiving) {
    const reservation = this.receiveWindows.get(item.id);
    if (reservation) {this.receiveWindows.delete(item.id); this.receiveFlow.release(reservation.owner);}
    this.grantQueuedReceives();
  }
  private async finishIncoming(item: Receiving) {
    if (!item.expectedHash || item.bytes !== item.info.size || item.finishing || terminal(item.status)) return;
    const epoch = this.epoch; const revision = this.connectionRevision;
    const current = () => !this.destroyed && epoch === this.epoch && revision === this.connectionRevision;
    item.finishing = true; item.status = 'verifying'; this.updateRow(item.id, {status: 'verifying'}, true);
    try {
      if (!item.hasherStarted) { this.hasher!.start(item.id); item.hasherStarted = true; }
      const digest = await this.hasher!.finish(item.id);
      if (!current() || terminal(item.status)) return;
      if (digest !== item.expectedHash) throw new Error('Verification failed. The received file was not saved. Please resend it.');
      item.sink ||= item.directory ? folderSink(item.directory, item.info.name) : Promise.resolve(memorySink(item.info.type));
      const sink = await item.sink;
      if (!current() || terminal(item.status)) return;
      const blob = await sink.close();
      if (!current() || terminal(item.status)) return;
      if (blob) this.downloads.set(item.id, blob);
      item.status = blob ? 'ready' : 'saved';
      this.releaseReceiveWindow(item);
      this.updateRow(item.id, {status: item.status, bytes: item.info.size, speed: 0, remainingSeconds: 0}, true);
      this.sendControl({type: 'complete', id: item.id, operationId: item.operationId, hash: digest, saved: !blob});
    } catch (error) { if (!current() || terminal(item.status)) return; await this.stopTransfer(item.id, 'failed', errorMessage(error)); if (current()) this.sendControl({type: 'error', id: item.id, error: errorMessage(error)}); }
  }
  private async pump() {
    if (this.sending || this.state.stage !== 'connected' || this.data?.readyState !== 'open') return;
    const revision = this.connectionRevision; const epoch = this.epoch; const channel = this.data; const pc = this.pc;
    this.sending = true;
    try {
      while (epoch === this.epoch && revision === this.connectionRevision && this.state.stage === 'connected' && this.data === channel && channel.readyState === 'open') {
        this.syncActiveStreams();
        const eligible = [...this.outgoing.values()].filter(item => ['queued', 'transferring'].includes(item.status) && !item.resumePending && !item.localPaused && !item.remotePaused && !item.ending && (item.offset < item.credit || item.offset === item.file.size));
        const item = eligible.length ? eligible[this.pumpCursor++ % eligible.length] : null;
        if (!item) break;
        if (!item.started) { item.started = now(); item.sampled = now(); }
        if (item.status !== 'transferring') { item.status = 'transferring'; this.updateRow(item.id, {status: 'transferring'}, true); }
        if (!item.hashStarted) { this.hasher!.start(item.id); item.hashStarted = true; }
        if (item.offset === item.file.size) {
          item.ending = true; item.status = 'verifying'; this.updateRow(item.id, {status: 'verifying'}, true);
          const hash = await this.hasher!.finish(item.id);
          if (epoch !== this.epoch || revision !== this.connectionRevision || terminal(item.status)) break;
          item.digest = hash;
          this.sendControl({type: 'finish', id: item.id, operationId: item.operation?.intent.operationId, hash}); continue;
        }
        if (item.offset >= item.credit) break;
        if (channel.bufferedAmount > 4 * 1024 * 1024) { await this.waitForBuffer(); continue; }
        const negotiated = pc?.sctp?.maxMessageSize || INITIAL_CHUNK + FRAME_HEADER;
        const adaptive = item.confirmed >= 1024 * 1024 ? MAX_CHUNK : INITIAL_CHUNK;
        const length = Math.min(Math.max(1, negotiated - FRAME_HEADER), adaptive, item.file.size - item.offset, item.credit - item.offset);
        const current = () => epoch === this.epoch && revision === this.connectionRevision && this.data === channel && channel.readyState === 'open' && !terminal(item.status) && !item.localPaused && !item.remotePaused && this.state.stage === 'connected';
        if (!await this.scheduler.acquire(length, () => !!this.options.accessRuntime && !this.pairHyperSpeed(), current)) continue;
        const offset = item.offset; let payload: ArrayBuffer;
        try {payload = await item.file.slice(offset, offset + length).arrayBuffer();} catch (error) {this.scheduler.cancelReservation(length); throw error;}
        if (epoch !== this.epoch || revision !== this.connectionRevision || this.data !== channel) {this.scheduler.cancelReservation(length); break;}
        if (terminal(item.status) || item.localPaused || item.remotePaused || this.state.stage !== 'connected') {this.scheduler.cancelReservation(length); continue;}
        channel.send(encodeFrame(item.batchId, item.id, offset, payload));
        this.scheduler.sent(length);
        this.hasher!.update(item.id, payload); item.offset += length; item.lastActivity = now();
        if (Math.floor(offset / (256 * 1024)) !== Math.floor(item.offset / (256 * 1024))) await this.hasher!.flush(item.id);
      }
    } catch (error) {
      if (epoch !== this.epoch || revision !== this.connectionRevision || this.data !== channel) return;
      const active = [...this.outgoing.values()].find(item => item.status === 'transferring' || item.status === 'verifying');
      if (active && this.state.stage === 'connected') { await this.stopTransfer(active.id, 'failed', errorMessage(error)); this.sendControl({type: 'error', id: active.id, error: errorMessage(error)}); }
    } finally { this.sending = false; this.syncActiveStreams(); }
  }
  private syncActiveStreams() {
    for (const item of this.outgoing.values()) this.scheduler.setActive(`${this.state.sessionId}:${item.id}`, !terminal(item.status) && item.status !== 'offered' && !item.localPaused && !item.remotePaused && this.state.stage === 'connected');
  }
  private waitForBuffer(): Promise<void> {
    return new Promise(resolve => {
      const channel = this.data; if (!channel || channel.bufferedAmount <= 1024 * 1024 || channel.readyState !== 'open') return resolve();
      const done = () => { clearTimeout(timer); channel.removeEventListener('bufferedamountlow', done); channel.removeEventListener('close', done); resolve(); };
      const timer = setTimeout(done, 500); channel.addEventListener('bufferedamountlow', done, {once: true}); channel.addEventListener('close', done, {once: true});
    });
  }
  pauseTransfer = (fileId: string) => {
    const outgoing = this.outgoing.get(fileId); const incoming = this.receiving.get(fileId);
    if (outgoing && !terminal(outgoing.status)) { outgoing.localPaused = true; outgoing.status = 'paused'; }
    if (incoming && !terminal(incoming.status)) { incoming.localPaused = true; incoming.status = 'paused'; this.ack(incoming); }
    this.updateRow(fileId, {status: 'paused', speed: 0}, true); this.sendControl({type: 'pause', id: fileId});
    this.syncActiveStreams();
  };
  resumeTransfer = (fileId: string) => {
    const outgoing = this.outgoing.get(fileId); const incoming = this.receiving.get(fileId);
    if (outgoing && !terminal(outgoing.status)) { outgoing.localPaused = false; outgoing.status = outgoing.remotePaused ? 'paused' : 'queued'; this.updateRow(fileId, {status: outgoing.status}, true); }
    if (incoming && !terminal(incoming.status)) { incoming.localPaused = false; incoming.status = incoming.remotePaused ? 'paused' : 'transferring'; this.grantQueuedReceives(); this.updateRow(fileId, {status: incoming.status}, true); }
    this.sendControl({type: 'resume', id: fileId}); void this.pump();
  };
  cancelTransfer = (fileId: string) => { void this.stopTransfer(fileId, 'canceled'); this.sendControl({type: 'cancel', id: fileId}); };
  private async stopTransfer(fileId: string, status: 'canceled' | 'failed', error?: string) {
    const outgoing = this.outgoing.get(fileId); if (outgoing) { outgoing.status = status; this.hasher?.cancel(fileId); }
    outgoing?.operation?.outcome(`${this.state.sessionId}:${fileId}`, 'released');
    this.scheduler.remove(`${this.state.sessionId}:${fileId}`);
    const incoming = this.receiving.get(fileId);
    if (incoming && !terminal(incoming.status)) { incoming.status = status; this.hasher?.cancel(fileId); if (incoming.sink) { try { await (await incoming.sink).abort(); } catch { /* Permission may have been revoked. */ } } if (!incoming.directory && !incoming.diskSink) this.releaseMemory(incoming.info.size); this.releaseReceiveWindow(incoming); }
    this.downloads.delete(fileId); this.updateRow(fileId, {status, error, speed: 0, remainingSeconds: null}, true); void this.pump();
  }
  retryTransfer = async (fileId: string) => {
    if (this.state.sendPreparing) return;
    const item = this.outgoing.get(fileId); if (!item) { this.error(new Error('Ask the other device to resend this file.')); return; }
    if (!['failed', 'canceled', 'interrupted'].includes(item.status)) {this.error(new Error('Wait until this attempt stops before retrying it.')); return;}
    if (!item.operation) {this.addFiles([item.file]); await this.sendSelected(); return;}
    const operation = item.operation; const epoch = this.epoch; this.set({sendPreparing: true});
    try {
      const permit = await operation.renew(); if (this.options.sendRuntime && !permit) return;
      if (epoch !== this.epoch || this.destroyed) return;
      operation.open();
      await this.sendAuthorized(operation, [{info: {id: item.id, name: item.file.name, size: item.file.size, type: item.file.type}, file: item.file, digest: item.digest}]);
    } catch (error) {if (epoch === this.epoch) this.error(error);} finally {operation.seal(); if (epoch === this.epoch) this.set({sendPreparing: false});}
  };
  downloadFile = (fileId: string) => {
    const blob = this.downloads.get(fileId); const item = this.receiving.get(fileId); if (!blob || !item) return;
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = safeFilename(item.info.name); document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    this.downloads.delete(fileId); this.releaseMemory(item.info.size); item.status = 'downloaded'; this.updateRow(fileId, {status: 'downloaded'}, true);
  };
  saveFile = async (fileId: string) => {
    const blob = this.downloads.get(fileId); const item = this.receiving.get(fileId);
    if (!blob || !item) { this.error(new Error('This file is no longer available. Ask the other device to send it again.')); return; }
    try {
      const result = await saveBlobAs(blob, item.info.name);
      if (result === 'saved') { this.downloads.delete(fileId); this.releaseMemory(item.info.size); item.status = 'saved'; this.updateRow(fileId, {status: 'saved', saveMethod: 'folder'}, true); }
    } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) this.error(error); }
  };
  chooseFolder = async () => { try { await this.chooseFolderOrThrow(); } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) this.error(error); } };
  private async chooseFolderOrThrow() {
    const picker = (window as FolderWindow).showDirectoryPicker;
    if (!picker) throw new Error('Folder selection is supported in desktop Chrome and Edge. This browser uses individual downloads.');
    this.setDirectory(await picker.call(window, {mode: 'readwrite'}));
  }
  clearFolder = () => { this.setDirectory(null); };
  dismissError = (errorId: string) => this.set({errors: this.state.errors.filter(error => error.id !== errorId)});
  updateSettings = (patch: Partial<ShareSettings>) => {
    const settings = {...this.state.settings, ...patch}; settings.deviceName = settings.deviceName.trim().slice(0, 60) || 'My device'; settings.bandwidthLimitMbps = Number.isFinite(settings.bandwidthLimitMbps) ? Math.max(0, Math.min(10000, settings.bandwidthLimitMbps)) : 0;
    if (this.pc && patch.directOnly !== undefined && patch.directOnly !== this.state.settings.directOnly) { settings.directOnly = this.state.settings.directOnly; this.error(new Error('Disconnect before changing the connection preference.')); }
    this.set({settings}); try { if (!this.options.isolated) localStorage.setItem('f8-settings', JSON.stringify(settings)); } catch { /* Optional preferences. */ }
    this.scheduler.setUserLimit(settings.bandwidthLimitMbps);
    void this.syncWakeLock();
  };
  private tick() {
    this.syncActiveStreams();
    const speedPolicy = this.scheduler.getSnapshot();
    if (JSON.stringify(speedPolicy) !== JSON.stringify(this.state.speedPolicy)) this.set({speedPolicy, ...(speedPolicy.calibration === 'complete' ? {speedTest: {status: 'complete', bytesPerSecond: speedPolicy.referenceBytesPerSecond}} : {})});
    if (this.peerClaims && this.peerClaims.exp * 1000 <= this.accessNow() && this.state.peerAccess.some(peer => peer.status === 'valid')) this.updatePeerAccess('Premium speed lease expired. Standard transfers remain available.');
    let active = false;
    for (const item of this.outgoing.values()) {
      if (terminal(item.status) || item.status === 'offered') continue;
      active = true; const elapsed = Math.max(.001, (now() - item.sampled) / 1000); const speed = item.localPaused || item.remotePaused || this.state.stage !== 'connected' ? 0 : Math.max(0, (item.confirmed - item.sampledBytes) / elapsed);
      const previous = this.state.transfers.find(row => row.id === item.id)?.speed || 0; const smoothed = speed ? previous * .6 + speed * .4 : previous * .6;
      this.updateRow(item.id, {bytes: item.confirmed, speed: smoothed, averageSpeed: item.started ? item.confirmed / Math.max(.001, (now() - item.started) / 1000) : 0, remainingSeconds: smoothed > 0 ? (item.file.size - item.confirmed) / smoothed : null}); item.sampled = now(); item.sampledBytes = item.confirmed;
    }
    for (const item of this.receiving.values()) {
      if (terminal(item.status)) continue;
      active = true; const elapsed = Math.max(.001, (now() - item.sampled) / 1000); const speed = item.localPaused || item.remotePaused || this.state.stage !== 'connected' ? 0 : Math.max(0, (item.bytes - item.sampledBytes) / elapsed);
      const previous = this.state.transfers.find(row => row.id === item.id)?.speed || 0; const smoothed = speed ? previous * .6 + speed * .4 : previous * .6;
      this.updateRow(item.id, {speed: smoothed, averageSpeed: item.started ? item.bytes / Math.max(.001, (now() - item.started) / 1000) : 0, remainingSeconds: smoothed > 0 ? (item.info.size - item.bytes) / smoothed : null}); item.sampled = now(); item.sampledBytes = item.bytes;
      if (item.bytes && now() - item.lastAckTime > 1000) this.ack(item);
    }
    if (active) this.set({transfers: this.state.transfers});
    if (this.state.stage === 'connected') void this.pump();
    if (this.waking !== active) { this.waking = active; void this.syncWakeLock(); }
  }
  private async syncWakeLock() {
    const wanted = this.waking && this.state.settings.keepAwake && document.visibilityState === 'visible';
    if (!wanted) { if (this.wakeLock) { await this.wakeLock.release().catch(() => {}); this.wakeLock = null; } return; }
    if (!this.wakeLock && !this.wakePending && 'wakeLock' in navigator) {
      this.wakePending = true;
      try { const lock = await navigator.wakeLock.request('screen'); this.wakeLock = lock; lock.addEventListener('release', () => { if (this.wakeLock === lock) this.wakeLock = null; }); }
      catch { /* Browsers can deny a wake lock; the interface advises keeping pages open. */ }
      finally { this.wakePending = false; }
    }
  }
  testSpeed = async () => {
    try {
      if (this.state.stage !== 'connected') throw new Error('Connect another device first.');
      if ([...this.outgoing.values()].some(item => !terminal(item.status) && item.status !== 'offered')) throw new Error('Wait until accepted outgoing transfers finish before resetting the reference.');
      this.scheduler.retest();
      this.set({speedPolicy: this.scheduler.getSnapshot(), speedTest: {status: 'idle', bytesPerSecond: 0}});
    } catch (error) {this.set({speedTest: {status: 'idle', bytesPerSecond: 0, error: errorMessage(error)}});}
  };
  private finishSpeedReceive(testId: string) {
    const run = this.speedReceive.get(testId); if (!run) return;
    this.sendControl({type: 'speed-result', id: testId, speed: run.bytes / Math.max(.001, (now() - run.started) / 1000)}); this.speedReceive.delete(testId);
  }
  private armConnectionDeadline(milliseconds: number) {
    if (this.connectionDeadline) return;
    const pc = this.pc;
    this.connectionDeadline = setTimeout(() => {
      this.connectionDeadline = null;
      if (this.pc !== pc || this.state.stage === 'connected' || !this.state.sessionId) return;
      if (this.signalingUnavailable) { this.endExpiredConnection(); return; }
      const message = this.hadConnected
        ? 'The other device is unavailable. Keep both pages open; this session will reconnect automatically when it is reachable.'
        : !this.state.relayAvailable || this.state.settings.directOnly
          ? 'Could not connect directly. Use the same Wi-Fi or hotspot. Restrictive networks may require a TURN relay; switch off Direct only when a relay is available.'
          : 'Could not connect these devices. Try the same Wi-Fi or hotspot, check VPN and firewall settings, then create a new session.';
      this.set({stage: 'reconnecting'});
      if (!this.recoveryNotified) { this.recoveryNotified = true; this.error(new Error(message)); }
      void this.restartConnection(this.hadConnected && this.peerCheckpoints);
    }, milliseconds);
  }
  private endExpiredConnection() {
    if (this.state.stage === 'closed') return;
    this.epoch++; this.polling = false; this.closePeer(); this.token = ''; this.key = null; this.secret = ''; this.decryptor = null; this.forgetSavedSession();
    this.set({stage: 'closed', route: 'unknown', pairingLink: '', incomingBatches: []});
    const message = 'Connection ended after the pairing service expired. Create a new pairing to continue.';
    for (const item of [...this.outgoing.values(), ...this.receiving.values()]) if (!terminal(item.status)) void this.stopTransfer(item.id, 'failed', message);
    this.speedReceive.clear(); this.speedRun?.done(0); this.error(new Error(message));
  }
  private closePeer() {
    this.accessChallenge = ''; this.remoteChallenge = ''; this.challengeUsed = false; this.peerClaims = null; this.accessVersion++; this.peerSendPolicy = 0;
    this.peerCheckpoints = false; this.peerTransportId = '';
    if (this.connectionDeadline) clearTimeout(this.connectionDeadline); this.connectionDeadline = null;
    for (const channel of [this.control, this.data]) if (channel) { channel.onopen = null; channel.onclose = null; channel.onerror = null; channel.onmessage = null; }
    if (this.pc) { this.pc.onconnectionstatechange = null; this.pc.onicecandidate = null; this.pc.ondatachannel = null; this.pc.close(); }
    this.pc = null; this.control = null; this.data = null; this.candidates = []; if (this.statsTimer) clearInterval(this.statsTimer); this.statsTimer = null;
    for (const item of this.outgoing.values()) this.scheduler.setActive(`${this.state.sessionId}:${item.id}`, false);
    this.set({peerAccess: []});
  }
  private releaseMemory(bytes: number) {
    const released = Math.min(this.memoryReserved, bytes); this.memoryReserved -= released;
    if (this.options.receiveBudget) this.options.receiveBudget.used = Math.max(0, this.options.receiveBudget.used - released);
  }
  private forgetSavedSession() { if (this.options.isolated) return; this.savedSessionJson = ''; try { clearSavedSession(window.sessionStorage); } catch { /* Storage may be disabled. */ } }
  disconnect = async () => {
    const sessionId = this.state.sessionId; const token = this.token; this.epoch++;
    // Invalidate persistence inputs before closePeer emits state. Otherwise its
    // access-status update can recreate credentials that were just removed.
    this.token = ''; this.key = null; this.secret = ''; this.decryptor = null; this.cursor = 0;
    this.forgetSavedSession(); this.polling = false; this.resumeRequired = false; this.reconnecting = false; this.recoveryNotified = false; this.signalingUnavailable = false; this.connectionRevision = 0;
    if (this.timer) clearTimeout(this.timer); this.timer = null; this.closePeer(); this.hadConnected = false;
    for (const item of this.outgoing.values()) {if (!terminal(item.status)) { item.status = 'canceled'; this.hasher?.cancel(item.id); item.operation?.outcome(`${sessionId}:${item.id}`, 'released'); this.updateRow(item.id, {status: 'canceled', speed: 0}); } this.releaseOutgoingSource(item);}
    for (const item of this.receiving.values()) if (!terminal(item.status)) { item.status = 'canceled'; this.hasher?.cancel(item.id); if (item.sink) void item.sink.then(sink => sink.abort()).catch(() => {}); if (!item.directory && !item.diskSink) this.releaseMemory(item.info.size); this.releaseReceiveWindow(item); this.updateRow(item.id, {status: 'canceled', speed: 0}); }
    this.speedReceive.clear(); this.speedRun?.done(0); this.set({stage: 'idle', sendPreparing: false, sessionId: null, role: null, sessionName: '', sessionSlug: '', peerName: '', pairingLink: '', receiverCapabilities: [], expiresAt: null, route: 'unknown', relayAvailable: false, incomingBatches: []});
    if (!this.options.isolated) history.replaceState(null, '', '/');
    this.waking = false; void this.syncWakeLock();
    if (sessionId && token) void fetch(`/api/sessions/${sessionId}/leave`, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`}, body: '{}', keepalive: true}).catch(() => { /* Server sessions also expire automatically. */ });
  };
  destroy() {
    // React cleanup and browser refresh must release this page without closing
    // the approved server room. Only an explicit Disconnect sends /leave.
    this.persistSession(); this.destroyed = true; this.epoch++; this.polling = false;
    this.accessUnsubscribe?.(); this.accessUnsubscribe = null;
    this.flowUnsubscribe?.(); this.flowUnsubscribe = null;
    if (!this.options.scheduler) this.scheduler.destroy();
    if (this.timer) clearTimeout(this.timer); this.timer = null; this.closePeer();
    if (this.tickTimer) clearInterval(this.tickTimer); this.tickTimer = null;
    document.removeEventListener('visibilitychange', this.visibility);
    for (const item of this.receiving.values()) if (!terminal(item.status) && item.sink) void item.sink.then(sink => sink.abort()).catch(() => {});
    for (const reservation of this.receiveWindows.values()) this.receiveFlow.release(reservation.owner);
    this.receiveWindows.clear();
    for (const item of this.outgoing.values()) if (!terminal(item.status)) item.operation?.outcome(`${this.state.sessionId}:${item.id}`, 'released');
    for (const item of this.outgoing.values()) this.releaseOutgoingSource(item);
    for (const file of this.selected.values()) void releasePreparedArchive(file);
    this.hasher?.destroy(); this.hasher = null; this.downloads.clear(); this.outgoing.clear(); this.receiving.clear(); this.selected.clear(); this.releaseMemory(this.memoryReserved);
    this.speedReceive.clear(); this.speedRun?.done(0); this.speedRun = null; this.reconnecting = false; this.resumeRequired = false; this.sending = false; this.hadConnected = false;
    this.token = ''; this.key = null; this.secret = ''; this.decryptor = null; this.savedSessionJson = '';
    this.waking = false; void this.syncWakeLock();
    this.state = {...this.state, stage: 'idle', sessionId: null, sessionName: '', sessionSlug: '', role: null, pairingLink: '', receiverCapabilities: [], expiresAt: null, peerName: '', selectedFiles: [], incomingBatches: [], transfers: []};
  }
}

export function freezeSendIntent(intent: SendIntent): SendIntent {
  for (const file of intent.files) Object.freeze(file);
  Object.freeze(intent.files); Object.freeze(intent.recipientIds); return Object.freeze(intent);
}

export function validChat(value: unknown): value is PeerChat {
  const message = value as PeerChat | null;
  return !!message && typeof message.id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(message.id) && typeof message.text === 'string' && message.text.length > 0 && message.text.length <= 4000 && Number.isSafeInteger(message.sentAt) && message.sentAt > 0 && message.sentAt <= 8_640_000_000_000_000 && typeof message.recipient === 'string' && (message.recipient === 'all' || /^[a-f0-9-]{36}$/i.test(message.recipient));
}

/** Historical invitations keep their supported route while new rooms use /<sixhex>. */
export function sessionPath(slug: string): string {return /^[a-f0-9]{6}$/.test(slug) ? `/${slug}` : `/s/${encodeURIComponent(slug)}`;}

/** Optional v1 hello fields: older browsers and future companions remain valid. */
export function receiverCapability(message: Record<string, unknown>, peerName: string): ReceiverCapability | null {
  const caps = message.caps && typeof message.caps === 'object' && !Array.isArray(message.caps) ? message.caps as Record<string, unknown> : {};
  const rawLimit = caps.pendingDownloadLimit ?? message.memoryLimit;
  const pendingDownloadLimit = typeof rawLimit === 'number' && Number.isSafeInteger(rawLimit) && rawLimit >= 0 ? rawLimit : null;
  const folderAccessAvailable = caps.folderAccessAvailable === true || message.folder === true;
  if (pendingDownloadLimit === null && !folderAccessAvailable && !Object.keys(caps).length) return null;
  return {peerName, pendingDownloadLimit, folderAccessAvailable, folderDestinationSelected: caps.folderDestinationSelected === true && folderAccessAvailable,
    archiveFormat: caps.archiveFormat === 'zip64' ? 'zip64' : null, platform: caps.platform === 'browser' || caps.platform === 'native' ? caps.platform : 'unknown',
    fileAccessAvailable: caps.fileAccessAvailable === true,
    receiveModes: Array.isArray(caps.receiveModes) ? caps.receiveModes.filter((mode): mode is 'memory' | 'file' | 'folder' => ['memory', 'file', 'folder'].includes(mode)) : undefined,
    maxFileBytes: isValidFileSize(caps.maxFileBytes) ? caps.maxFileBytes : undefined};
}
