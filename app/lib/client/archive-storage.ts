/** Only this private OPFS directory is eligible for prepared-archive cleanup. */
const DIRECTORY = 'fil3shareica-prepared-archives-v1';
const LOCK_PREFIX = `${DIRECTORY}/`;
export const MEMORY_ARCHIVE_LIMIT = 64 * 1024 * 1024;
const liveFiles = new Set<string>();
const preparedFiles = new WeakMap<File, {references: number; cleanup: () => Promise<void>}>();
let memoryPreparedBytes = 0;

export interface ArchiveStorageFile {
  writable: WritableStream<Uint8Array>;
  getFile(): Promise<File>;
  remove(): Promise<void>;
}

/** Injectable so tests can exercise slow disks, quota errors and cleanup. */
export interface ArchiveStorage {
  kind: 'disk' | 'memory';
  availableBytes?(): Promise<number | undefined>;
  create(name: string): Promise<ArchiveStorageFile>;
}

type Directory = FileSystemDirectoryHandle & {values(): AsyncIterable<FileSystemHandle>};

async function archiveDirectory(create: boolean): Promise<Directory | undefined> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return;
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(DIRECTORY, {create}) as Directory;
  } catch (error) {
    if (error instanceof DOMException && ['NotFoundError', 'NotSupportedError', 'SecurityError'].includes(error.name)) return;
    throw error;
  }
}

/** A Web Lock survives slow writes and protects archives in other open tabs. */
async function holdArchive(name: string): Promise<() => Promise<void>> {
  liveFiles.add(name);
  if (!navigator.locks) return async () => {liveFiles.delete(name);};
  let unlock!: () => void;
  let acquired!: () => void;
  let failed!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {acquired = resolve; failed = reject;});
  const held = navigator.locks.request(`${LOCK_PREFIX}${name}`, async () => {
    const lifetime = new Promise<void>(resolve => {unlock = resolve;});
    acquired();
    await lifetime;
  });
  void held.catch(failed);
  try {await ready;}
  catch (error) {liveFiles.delete(name); throw error;}
  return async () => {liveFiles.delete(name); unlock(); await held;};
}

function memoryStorage(): ArchiveStorage {
  return {
    kind: 'memory',
    async create(name) {
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let size = 0;
      let removed = false;
      function releaseMemory() {
        if (removed) return;
        removed = true;
        chunks.length = 0;
        memoryPreparedBytes -= size;
      }
      return {
        writable: new WritableStream<Uint8Array>({
          write(chunk) {
            if (memoryPreparedBytes + chunk.byteLength > MEMORY_ARCHIVE_LIMIT) throw new Error('Prepared folders exceed this browser’s shared 64 MiB temporary-memory limit. Remove an earlier prepared folder or create a ZIP with your device’s file manager, then choose it as a file.');
            chunks.push(new Uint8Array(chunk)); size += chunk.byteLength; memoryPreparedBytes += chunk.byteLength;
          },
          abort() {releaseMemory();},
        }, {highWaterMark: 1}),
        async getFile() {const file = new File(chunks, name, {type: 'application/zip', lastModified: Date.now()}); chunks.length = 0; return file;},
        async remove() {releaseMemory();},
      };
    },
  };
}

export async function getArchiveStorage(): Promise<ArchiveStorage> {
  const directory = await archiveDirectory(true);
  if (!directory) return memoryStorage();
  return {
    kind: 'disk',
    async availableBytes() {
      try {
        const {quota, usage} = await navigator.storage.estimate();
        if (Number.isFinite(quota) && Number.isFinite(usage)) return Math.max(0, quota! - usage!);
      } catch { /* The write-time quota check remains authoritative. */ }
    },
    async create(name) {
      const temporaryName = `${Date.now()}-${crypto.randomUUID()}.zip`;
      const release = await holdArchive(temporaryName);
      let handle: FileSystemFileHandle;
      let writable: FileSystemWritableFileStream;
      try {
        handle = await directory.getFileHandle(temporaryName, {create: true});
        writable = await handle.createWritable();
      } catch (error) {
        await directory.removeEntry(temporaryName).catch(() => {});
        await release();
        throw error;
      }
      let removed = false;
      return {
        writable: writable as unknown as WritableStream<Uint8Array>,
        async getFile() {
          // File parts refer to the disk-backed Blob; this does not read it into JS memory.
          return new File([await handle.getFile()], name, {type: 'application/zip', lastModified: Date.now()});
        },
        async remove() {
          if (removed) return;
          removed = true;
          try {await directory.removeEntry(temporaryName);}
          catch (error) {if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;}
          finally {await release();}
        },
      };
    },
  };
}

export function trackPreparedArchive(file: File, cleanup: () => Promise<void>) {
  preparedFiles.set(file, {references: 1, cleanup});
}

/** Selection owns the initial reference; each active group sender retains one. */
export function retainPreparedArchive(file: File): void {
  const archive = preparedFiles.get(file);
  if (archive) archive.references++;
}

/** Call when the prepared file leaves the selection and no sender still reads it. */
export async function releasePreparedArchive(file: File): Promise<void> {
  const archive = preparedFiles.get(file);
  if (!archive || --archive.references > 0) return;
  // Delete before awaiting cleanup so simultaneous releases cannot remove twice.
  preparedFiles.delete(file);
  await archive.cleanup();
}

/** Remove abandoned files, never files leased by this tab or another live tab. */
export async function cleanupPreparedArchives(): Promise<void> {
  const directory = await archiveDirectory(false);
  // Without Web Locks there is no reliable way to distinguish a crashed tab
  // from another live tab, so keep its archives rather than risk data loss.
  if (!directory || !navigator.locks) return;
  for await (const entry of directory.values()) {
    if (entry.kind !== 'file' || liveFiles.has(entry.name) || !/^\d+-[0-9a-f-]+\.zip$/.test(entry.name)) continue;
    await navigator.locks.request(`${LOCK_PREFIX}${entry.name}`, {ifAvailable: true}, async lock => {
      if (lock) await directory.removeEntry(entry.name).catch(() => {});
    });
  }
}
