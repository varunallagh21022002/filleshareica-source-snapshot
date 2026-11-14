export type SessionStage = 'idle' | 'creating' | 'joining' | 'waiting' | 'pending' | 'connecting' | 'connected' | 'reconnecting' | 'rejected' | 'closed';
export type TransferStatus = 'offered' | 'queued' | 'transferring' | 'paused' | 'verifying' | 'saved' | 'received' | 'ready' | 'downloaded' | 'canceled' | 'failed' | 'interrupted';
export interface SelectedFile { id: string; name: string; size: number; type: string }
export interface IncomingBatch { id: string; operationId?: string; files: SelectedFile[]; peerName: string; peerId?: string; receivedAt: number }
export interface GroupMember { id: string; name: string; role: 'host' | 'guest'; status: 'pending' | 'approved' | 'rejected' | 'left'; connectionStage?: SessionStage }
export interface ChatMessage { id: string; senderId: string; senderName: string; recipient: string; text: string; sentAt: number; own: boolean }
export interface TransferRow extends SelectedFile {
  peerId?: string; peerName?: string; operationId?: string; batchId: string; direction: 'incoming' | 'outgoing'; status: TransferStatus;
  bytes: number; speed: number; averageSpeed: number; remainingSeconds: number | null;
  error?: string; saveMethod?: 'folder' | 'file' | 'download';
}
export type ReceiveMode = 'memory' | 'file' | 'folder';
export interface ShareCapabilities { checked: boolean; supported: boolean; secureContext: boolean; folderPicker: boolean; savePicker: boolean; fileShare: boolean; maxMemoryFileSize: number; receiveModes?: ReceiveMode[]; maxFileBytes?: number }
export interface ShareSettings { deviceName: string; directOnly: boolean; speedUnit: 'MB/s' | 'Mbps'; keepAwake: boolean; bandwidthLimitMbps: number }
export interface ReceiverCapability {
  peerId?: string; peerName: string; pendingDownloadLimit: number | null;
  folderAccessAvailable: boolean; folderDestinationSelected: boolean;
  archiveFormat: 'zip64' | null; platform: 'browser' | 'native' | 'unknown';
  receiveModes?: ReceiveMode[]; maxFileBytes?: number; fileAccessAvailable?: boolean;
}
export interface PeerAccessStatus {
  peerId?: string; peerName: string; status: 'checking' | 'valid' | 'expired' | 'required' | 'standard';
  kind: 'none' | 'ad' | 'grace' | 'paid'; expiresAt: number | null; hyperSpeed: boolean; message?: string;
}
export interface TransferSpeedPolicy {
  calibration: 'waiting' | 'measuring' | 'complete'; referenceBytesPerSecond: number;
  freeLimitBytesPerSecond: number; userLimitBytesPerSecond: number; freeRatio: number;
}
export interface ShareState {
  stage: SessionStage; sessionId: string | null; role: 'host' | 'guest' | null;
  sessionName: string; sessionSlug: string;
  groupMode: boolean; selfId: string; members: GroupMember[]; recipient: string; chatMessages: ChatMessage[];
  peerName: string; pairingLink: string; expiresAt: number | null;
  selectedFiles: SelectedFile[]; incomingBatches: IncomingBatch[]; transfers: TransferRow[];
  sendPreparing: boolean;
  errors: { id: string; message: string }[]; route: 'direct' | 'relay' | 'unknown';
  receiverCapabilities: ReceiverCapability[];
  peerAccess: PeerAccessStatus[]; speedPolicy: TransferSpeedPolicy;
  relayAvailable: boolean; folderName: string | null; capabilities: ShareCapabilities;
  settings: ShareSettings; speedTest: { status: 'idle' | 'running' | 'complete'; bytesPerSecond: number; error?: string };
}
export interface ShareActions {
  createSession(sessionName?: string, group?: boolean): Promise<void>; joinSession(link: string): Promise<void>;
  approvePeer(accept: boolean): Promise<void>; disconnect(): Promise<void>; endSession(): Promise<void>;
  setRecipient(id: string): void; sendChat(text: string, recipient?: string): Promise<void>; approveMember(id: string, accept: boolean): Promise<void>;
  addFiles(files: FileList | File[]): void; removeFile(id: string): void; clearFiles(): void;
  sendSelected(recipient?: string): Promise<void>; acceptBatch(batchId: string, fileIds?: string[]): Promise<void>;
  declineBatch(batchId: string): void; pauseTransfer(id: string): void; resumeTransfer(id: string): void;
  cancelTransfer(id: string): void; retryTransfer(id: string): void; downloadFile(id: string): void; saveFile(id: string): Promise<void>;
  chooseFolder(): Promise<void>; clearFolder(): void; dismissError(id: string): void;
  updateSettings(settings: Partial<ShareSettings>): void; testSpeed(): Promise<void>;
}
export type ShareController = ShareState & ShareActions;
