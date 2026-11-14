export interface DirectoryHandle {
  name: string;
  getFileHandle(name: string, options?: {create?: boolean}): Promise<{createWritable(): Promise<FileSystemWritableFileStream>}>;
  queryPermission?(options: {mode: 'readwrite'}): Promise<PermissionState>;
  requestPermission?(options: {mode: 'readwrite'}): Promise<PermissionState>;
}
export type FolderWindow = Window & {showDirectoryPicker?: (options?: {mode: 'readwrite'}) => Promise<DirectoryHandle>};
export interface ReceiveSink { write(bytes: Uint8Array): Promise<void>; close(): Promise<Blob | null>; abort(): Promise<void> }
export interface WritableFileHandle {createWritable(): Promise<FileSystemWritableFileStream>}
/** Obtain a destination from the receiver's explicit Accept click, before data starts. */
export async function chooseFileSink(filename: string): Promise<ReceiveSink> {
  const picker = (window as SaveWindow).showSaveFilePicker;
  if (!picker) throw new Error('This browser cannot save large files directly. Receive this file using an up-to-date Chrome or Edge browser on a supported phone or computer.');
  const handle = await picker.call(window, {suggestedName: safeFilename(filename)});
  const stream = await handle.createWritable();
  return writableSink(stream);
}
export function writableSink(stream: FileSystemWritableFileStream): ReceiveSink {
  return {
    write: bytes => stream.write(bytes as FileSystemWriteChunkType),
    close: async () => {await stream.close(); return null;},
    abort: async () => {try {await stream.abort();} catch { /* Already closed or permission revoked. */ }},
  };
}
export function safeFilename(name: string): string {
  return name.replace(/[\\/\x00-\x1f]/g, '_').replace(/^\.+$/, '_').slice(0, 240) || 'download';
}
const directoryReservations = new WeakMap<DirectoryHandle, Promise<void>>();
export async function folderSink(directory: DirectoryHandle, filename: string): Promise<ReceiveSink> {
  const previous = directoryReservations.get(directory) || Promise.resolve();
  let release!: () => void;
  const reservation = new Promise<void>(resolve => {release = resolve;});
  directoryReservations.set(directory, reservation);
  await previous;
  try {return await reserveFolderSink(directory, filename);}
  finally {release(); if (directoryReservations.get(directory) === reservation) directoryReservations.delete(directory);}
}
async function reserveFolderSink(directory: DirectoryHandle, filename: string): Promise<ReceiveSink> {
  const original = safeFilename(filename); const dot = original.lastIndexOf('.');
  const stem = dot > 0 ? original.slice(0, dot) : original; const extension = dot > 0 ? original.slice(dot) : '';
  let name = original;
  for (let suffix = 0; suffix < 10000; suffix++) {
    name = suffix ? `${stem} (${suffix})${extension}` : original;
    try { await directory.getFileHandle(name); } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error;
      const handle = await directory.getFileHandle(name, {create: true}); const stream = await handle.createWritable();
      return writableSink(stream);
    }
  }
  throw new Error('Too many files with the same name in this folder.');
}
export function memorySink(type: string, limit = 64 * 1024 * 1024): ReceiveSink {
  let parts: ArrayBuffer[] = [];
  let length = 0;
  return {
    write: async bytes => { if (length + bytes.byteLength > limit) throw new Error('This browser cannot hold this download safely. Choose a disk destination or receive it on another supported device.'); length += bytes.byteLength; parts.push(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer); },
    close: async () => { const blob = new Blob(parts, {type: type || 'application/octet-stream'}); parts = []; return blob; },
    abort: async () => { parts = []; length = 0; },
  };
}

export type SaveWindow = Window & {
  showSaveFilePicker?: (options: {suggestedName: string}) => Promise<WritableFileHandle>;
};

/** Invoke directly from a click so the OS picker retains user activation. */
export async function saveBlobAs(blob: Blob, filename: string): Promise<'saved' | 'shared'> {
  const name = safeFilename(filename);
  const picker = (window as SaveWindow).showSaveFilePicker;
  if (picker) {
    const handle = await picker.call(window, {suggestedName: name});
    const writer = await handle.createWritable();
    try {
      await blob.stream().pipeTo(writer);
      return 'saved';
    } catch (error) {
      try { await writer.abort(); } catch { /* The stream may already be aborted. */ }
      throw error;
    }
  }
  const file = new File([blob], name, {type: blob.type || 'application/octet-stream'});
  if (typeof navigator.canShare === 'function' && typeof navigator.share === 'function' && navigator.canShare({files: [file]})) {
    await navigator.share({files: [file], title: name});
    // The share sheet cannot confirm whether the user saved to a folder.
    return 'shared';
  }
  throw new Error('This browser cannot open a folder picker for this file. Use Download and choose a location in your browser settings, or use Save to Files from your phone’s share menu. Desktop Chrome and Edge support Save as.');
}
