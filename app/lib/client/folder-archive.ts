import { BlobReader, ZipWriter, type CreateReadableOptions } from '@zip.js/zip.js';
import { MAX_FILE_BYTES } from '../transfer-policy';
import { getArchiveStorage, MEMORY_ARCHIVE_LIMIT, releasePreparedArchive, trackPreparedArchive, type ArchiveStorage } from './archive-storage';
export { cleanupPreparedArchives, releasePreparedArchive, retainPreparedArchive } from './archive-storage';

/** Preparation is separate from the receiver's pending-download memory budget. */
export const FOLDER_PREPARATION_LIMIT = MEMORY_ARCHIVE_LIMIT;
export const MAX_FOLDER_ENTRIES = 10_000;
const MAX_DEPTH = 64;
const encoder = new TextEncoder();
const companionAdvice = 'Create a ZIP with your device’s file manager, then choose that ZIP as a file.';
export interface FolderArchiveEntry {path: string; directory?: boolean; file?: File}
export interface ArchiveOptions {signal?: AbortSignal; onProgress?: (entries: number) => void; storage?: ArchiveStorage}
export interface SourceFileHandle {kind: 'file'; name: string; getFile(): Promise<File>}
export interface SourceDirectoryHandle {kind: 'directory'; name: string; values(): AsyncIterable<SourceFileHandle | SourceDirectoryHandle>}
export interface DropEntry {
  name: string; isFile: boolean; isDirectory: boolean;
  file?(success: (file: File) => void, failure: (error: DOMException) => void): void;
  createReader?(): {readEntries(success: (entries: DropEntry[]) => void, failure: (error: DOMException) => void): void};
}
export interface CapturedDrop {entries: DropEntry[]; files: File[]; unreadableItems?: boolean}

function checkAbort(signal?: AbortSignal) {if (signal?.aborted) throw new DOMException('Folder preparation cancelled.', 'AbortError');}
const ARCHIVE_CHUNK_BYTES = 256 * 1024;

/** Avoid whole-file reads and bound source read-ahead independently of Blob.stream(). */
class BoundedFileReader extends BlobReader {
  constructor(private readonly file: File, private readonly signal?: AbortSignal) {super(file);}
  createReadable(options: CreateReadableOptions = {}): ReadableStream<Uint8Array> {
    const file = this.file; const signal = this.signal;
    let position = options.offset ?? 0;
    let chunks = 0;
    const end = Math.min(file.size, position + (options.size ?? file.size - position));
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        checkAbort(signal);
        if (position >= end) {controller.close(); return;}
        const length = Math.min(ARCHIVE_CHUNK_BYTES, end - position);
        const bytes = new Uint8Array(await file.slice(position, position + length).arrayBuffer());
        if (++chunks % 32 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
        checkAbort(signal);
        if (bytes.byteLength !== length) throw new Error('A file changed or could not be read completely. Select the folder again.');
        position += bytes.byteLength;
        controller.enqueue(bytes);
      },
    }, {highWaterMark: 0});
  }
}
async function progress(count: number, options: ArchiveOptions) {
  options.onProgress?.(count);
  // Let the page paint and process Cancel even for thousands of empty entries.
  if (count % 32 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
  checkAbort(options.signal);
}
export function validateArchivePath(path: string): string {
  const parts = path.normalize('NFC').split('/');
  if (parts.length > MAX_DEPTH || parts.some(part => !part || part === '.' || part === '..' || /[\\:\u0000-\u001f\u007f]/.test(part) || encoder.encode(part).length > 240)) {
    throw new Error('This folder contains an unsafe or unsupported path. Rename it before sharing.');
  }
  return parts.join('/');
}

/** Conservatively reserves ZIP64 headers, names, directory entries, and payloads. */
class PreparationBudget {
  bytes = 1024; count = 0;
  constructor(readonly limit = MAX_FILE_BYTES) {}
  add(path: string, size = 0) {
    validateArchivePath(path);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('A file has an invalid size.');
    this.bytes += size + 512 + encoder.encode(path).length * 4;
    this.count++;
    if (this.count > MAX_FOLDER_ENTRIES) throw new Error(`Folder preparation supports at most ${MAX_FOLDER_ENTRIES.toLocaleString()} entries, including its root directory. ${companionAdvice}`);
    if (this.bytes > this.limit) throw new Error(this.limit === MEMORY_ARCHIVE_LIMIT
      ? `This browser’s folder preparation is limited to 64 MiB total, including ZIP metadata. ${companionAdvice}`
      : `The prepared ZIP must fit within 100 GB, including its files and ZIP metadata. ${companionAdvice}`);
  }
}

/** A unique top-level directory prevents two received archives from merging. */
export async function createFolderArchive(name: string, entries: FolderArchiveEntry[], options: ArchiveOptions = {}): Promise<File> {
  const root = `${validateArchivePath(name)}-${crypto.randomUUID().slice(0, 8)}`;
  if (root.includes('/')) throw new Error('A folder name must be a single path component.');
  validateArchivePath(root);
  const storage = options.storage ?? await getArchiveStorage();
  const limit = storage.kind === 'disk' ? MAX_FILE_BYTES : MEMORY_ARCHIVE_LIMIT;
  const budget = new PreparationBudget(limit); budget.add(root);
  const seen = new Map<string, boolean>();
  const checked = entries.map(entry => {
    checkAbort(options.signal);
    const path = validateArchivePath(entry.path);
    if (seen.has(path)) throw new Error('This folder contains duplicate archive paths. Rename them before sharing.');
    if (!entry.directory && !entry.file) throw new Error('A folder entry is missing its file.');
    seen.set(path, !!entry.directory);
    budget.add(`${root}/${path}`, entry.directory ? 0 : entry.file!.size);
    return {...entry, path};
  });
  for (const {path} of checked) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      if (seen.get(parts.slice(0, index).join('/')) === false) throw new Error('A file conflicts with a directory path.');
    }
  }
  checkAbort(options.signal);
  const available = await storage.availableBytes?.();
  if (available !== undefined && available < budget.bytes) throw new Error(`There is not enough temporary browser storage to prepare this folder. Free space or create a ZIP with your device’s file manager, then choose it as a file.`);
  checkAbort(options.signal);
  // STORE keeps output size predictable; BlobReader streams file slices. ZIP64
  // is explicit even for small archives, including archives with no file data.
  let sink: Awaited<ReturnType<ArchiveStorage['create']>>;
  try {sink = await storage.create(`${root}.zip`);}
  catch (error) {throw storageError(error);}
  const destination = sink.writable.getWriter();
  let bytes = 0;
  const output = new WritableStream<Uint8Array>({
    async write(chunk) {
      checkAbort(options.signal);
      if (bytes + chunk.byteLength > limit) throw new Error(`The prepared ZIP exceeds this browser’s ${limit === MEMORY_ARCHIVE_LIMIT ? '64 MiB temporary-memory' : '100 GB archive'} limit. ${companionAdvice}`);
      for (let offset = 0; offset < chunk.byteLength; offset += ARCHIVE_CHUNK_BYTES) {
        checkAbort(options.signal);
        const part = chunk.subarray(offset, offset + ARCHIVE_CHUNK_BYTES);
        await destination.write(part);
        bytes += part.byteLength;
      }
    },
    async close() {await destination.close();},
    async abort(reason) {await destination.abort(reason);},
  }, {highWaterMark: 1});
  const zip = new ZipWriter(output, {zip64: true, level: 0, useWebWorkers: false, bufferedWrite: false, extendedTimestamp: false});
  try {
    await zip.add(`${root}/`, undefined, {directory: true, signal: options.signal});
    let count = 0;
    for (const entry of checked) {
      checkAbort(options.signal);
      await zip.add(`${root}/${entry.path}${entry.directory ? '/' : ''}`, entry.directory ? undefined : new BoundedFileReader(entry.file!, options.signal), {directory: !!entry.directory, signal: options.signal});
      await progress(++count, options);
    }
    await zip.close();
    checkAbort(options.signal);
    const file = await sink.getFile();
    if (file.size !== bytes || file.size > limit) throw new Error('The prepared ZIP could not be saved completely. Try again or create a ZIP using your device’s file manager.');
    trackPreparedArchive(file, () => sink.remove());
    return file;
  } catch (error) {
    await destination.abort(error).catch(() => {});
    await sink.remove().catch(() => {});
    throw storageError(error);
  } finally {
    destination.releaseLock();
  }
}

function storageError(error: unknown): unknown {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return new Error(`Temporary browser storage became full while preparing this folder. Free space or ${companionAdvice.charAt(0).toLowerCase()}${companionAdvice.slice(1)}`);
  return error;
}

export async function archiveDirectory(handle: SourceDirectoryHandle, options: ArchiveOptions = {}): Promise<File> {
  const entries: FolderArchiveEntry[] = []; const budget = new PreparationBudget(); budget.add(`${handle.name}-xxxxxxxx`);
  async function visit(directory: SourceDirectoryHandle, prefix = ''): Promise<void> {
    for await (const child of directory.values()) {
      checkAbort(options.signal);
      const path = validateArchivePath(prefix ? `${prefix}/${child.name}` : child.name);
      if (child.kind === 'directory') {budget.add(`${handle.name}-xxxxxxxx/${path}`); entries.push({path, directory: true}); await visit(child, path);}
      else {const file = await child.getFile(); budget.add(`${handle.name}-xxxxxxxx/${path}`, file.size); entries.push({path, file});}
      await progress(entries.length, options);
    }
  }
  await visit(handle);
  return createFolderArchive(handle.name, entries, options);
}

export async function pickFolderArchive(options: ArchiveOptions = {}): Promise<File> {
  const picker = (window as Window & {showDirectoryPicker?: (options: {mode: 'read'}) => Promise<SourceDirectoryHandle>}).showDirectoryPicker;
  if (!picker) throw new Error(`This browser cannot open a folder for archiving. Create a ZIP in your device’s file manager, then choose it as a file. Empty folders are preserved when using a supported folder picker or directory drop. ${companionAdvice}`);
  const directory = await picker.call(window, {mode: 'read'});
  return archiveDirectory(directory, options);
}

/** Capture entries synchronously while the browser still exposes the drop store. */
export function captureFolderDrop(transfer: DataTransfer): CapturedDrop {
  const entries: DropEntry[] = []; const files: File[] = []; let unreadableItems = false;
  for (const item of Array.from(transfer.items || [])) {
    if (item.kind !== 'file') continue;
    const entry = (item as DataTransferItem & {webkitGetAsEntry?: () => DropEntry | null}).webkitGetAsEntry?.();
    if (entry) entries.push(entry);
    else {const file = item.getAsFile(); if (file) files.push(file); else unreadableItems = true;}
  }
  if (!entries.length && !files.length) files.push(...Array.from(transfer.files));
  return {entries, files, unreadableItems};
}

export async function archiveFolderDrop(captured: CapturedDrop, options: ArchiveOptions = {}): Promise<File[]> {
  if (captured.unreadableItems) throw new Error(`This browser cannot read one of the dropped folders. ${companionAdvice}`);
  const files = [...captured.files];
  const storage = options.storage ?? await getArchiveStorage();
  // Memory fallbacks share one budget across the whole drop. Disk archives have
  // a per-file 100 GB limit, and are checked against remaining quota individually.
  const memoryBudget = storage.kind === 'memory' ? new PreparationBudget(MEMORY_ARCHIVE_LIMIT) : undefined;
  const prepared: File[] = [];
  try {for (const root of captured.entries) {
    checkAbort(options.signal);
    if (root.isFile && root.file) {files.push(await new Promise<File>((resolve, reject) => root.file!(resolve, reject))); continue;}
    if (!root.isDirectory || !root.createReader) throw new Error(`This browser could not read the dropped folder. ${companionAdvice}`);
    const budget = memoryBudget ?? new PreparationBudget();
    const entries: FolderArchiveEntry[] = []; budget.add(`${root.name}-xxxxxxxx`);
    async function visit(directory: DropEntry, prefix = ''): Promise<void> {
      checkAbort(options.signal);
      const reader = directory.createReader!();
      while (true) {
        const children = await new Promise<DropEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!children.length) break;
        for (const child of children) {
          checkAbort(options.signal);
          const path = validateArchivePath(prefix ? `${prefix}/${child.name}` : child.name);
          if (child.isDirectory && child.createReader) {budget.add(`${root.name}-xxxxxxxx/${path}`); entries.push({path, directory: true}); await visit(child, path);}
          else if (child.isFile && child.file) {const file = await new Promise<File>((resolve, reject) => child.file!(resolve, reject)); budget.add(`${root.name}-xxxxxxxx/${path}`, file.size); entries.push({path, file});}
          else throw new Error('A dropped folder entry could not be read. Create a ZIP in your file manager instead.');
          await progress(budget.count, options);
        }
      }
    }
    await visit(root);
    const archive = await createFolderArchive(root.name, entries, {...options, storage});
    prepared.push(archive); files.push(archive);
  }} catch (error) {
    await Promise.all(prepared.map(file => releasePreparedArchive(file).catch(() => {})));
    throw error;
  }
  return files;
}
