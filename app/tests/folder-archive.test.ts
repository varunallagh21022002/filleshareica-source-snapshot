import assert from 'node:assert/strict';
import test from 'node:test';
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';
import { archiveDirectory, archiveFolderDrop, createFolderArchive, FOLDER_PREPARATION_LIMIT, MAX_FOLDER_ENTRIES, releasePreparedArchive, retainPreparedArchive, validateArchivePath, type SourceDirectoryHandle, type DropEntry } from '../lib/client/folder-archive';
import type {ArchiveStorage} from '../lib/client/archive-storage';
import {MAX_FILE_BYTES} from '../lib/transfer-policy';

test('ZIP64 folder archive preserves nested files, Unicode, empty directories and a unique root', async () => {
  const archive = await createFolderArchive('Photos', [
    {path: 'empty', directory: true}, {path: '旅行', directory: true},
    {path: '旅行/हैलो.txt', file: new File(['hello 🌍'], 'हैलो.txt')},
    {path: 'zero.bin', file: new File([], 'zero.bin')},
  ]);
  assert.match(archive.name, /^Photos-[0-9a-f]{8}\.zip$/);
  const bytes = new Uint8Array(await archive.arrayBuffer());
  assert.ok(Buffer.from(bytes).includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), 'contains ZIP64 end-of-directory record');
  const reader = new ZipReader(new BlobReader(archive), {useWebWorkers: false});
  try {
    const entries = await reader.getEntries(); const root = archive.name.slice(0, -4);
    assert.deepEqual(entries.map(entry => entry.filename), [`${root}/`, `${root}/empty/`, `${root}/旅行/`, `${root}/旅行/हैलो.txt`, `${root}/zero.bin`]);
    assert.equal(entries[1].directory, true);
    const textEntry = entries[3]; if (textEntry.directory) throw new Error('Expected a file entry');
    assert.equal(await textEntry.getData!(new TextWriter()), 'hello 🌍');
    assert.equal(entries[4].uncompressedSize, 0);
  } finally {await reader.close();}
  const second = await createFolderArchive('Photos', []);
  assert.notEqual(archive.name, second.name);
});

test('an entirely empty folder still arrives as a ZIP64 directory', async () => {
  const archive = await createFolderArchive('Empty', []);
  const reader = new ZipReader(new BlobReader(archive), {useWebWorkers: false});
  try {const entries = await reader.getEntries(); assert.equal(entries.length, 1); assert.equal(entries[0].directory, true);}
  finally {await reader.close();}
});

test('archive rejects traversal, absolute paths, duplicate normalized names, and file/directory conflicts', async () => {
  for (const path of ['../secret', '/absolute', 'a/../b', 'a//b', 'a\\b', 'C:/Windows', 'a/./b', 'bad\0name', Array(66).fill('x').join('/')]) {
    assert.throws(() => validateArchivePath(path), /unsafe|unsupported/);
  }
  await assert.rejects(createFolderArchive('../bad', []), /unsafe/);
  await assert.rejects(createFolderArchive('Root', [{path: 'é', directory: true}, {path: 'e\u0301', directory: true}]), /duplicate/);
  await assert.rejects(createFolderArchive('Root', [{path: 'a', file: new File([], 'a')}, {path: 'a/b', file: new File([], 'b')}]), /conflicts/);
});

test('size plus metadata and entry count are bounded before archive payload reads', async () => {
  const oversized = new File([], 'large.bin');
  Object.defineProperty(oversized, 'size', {value: FOLDER_PREPARATION_LIMIT});
  Object.defineProperty(oversized, 'stream', {value: () => {throw new Error('must not read oversized payload');}});
  await assert.rejects(createFolderArchive('Root', [{path: 'large.bin', file: oversized}]), /64 MiB total/);
  await assert.rejects(createFolderArchive('Root', Array.from({length: MAX_FOLDER_ENTRIES}, (_, index) => ({path: `empty-${index}`, directory: true}))), /10,000 entries/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(createFolderArchive('Root', [], {signal: abort.signal}), {name: 'AbortError'});
});

test('native directory traversal preserves empty children and stops large file metadata early', async () => {
  const empty: SourceDirectoryHandle = {kind: 'directory', name: 'Empty child', async *values() {}};
  const root: SourceDirectoryHandle = {kind: 'directory', name: 'Root', async *values() {yield empty; yield {kind: 'file' as const, name: 'app.apk', getFile: async () => new File(['installer'], 'app.apk')};}};
  const archive = await archiveDirectory(root);
  const reader = new ZipReader(new BlobReader(archive), {useWebWorkers: false});
  try {const entries = await reader.getEntries(); assert.ok(entries.some(entry => entry.filename.endsWith('/Empty child/') && entry.directory)); assert.ok(entries.some(entry => entry.filename.endsWith('/app.apk')));}
  finally {await reader.close();}
  const huge = new File([], 'huge.bin'); Object.defineProperty(huge, 'size', {value: FOLDER_PREPARATION_LIMIT});
  const tooLarge: SourceDirectoryHandle = {kind: 'directory', name: 'Large', async *values() {yield {kind: 'file', name: 'huge.bin', getFile: async () => huge};}};
  await assert.rejects(archiveDirectory(tooLarge), /64 MiB total/);
});

test('directory drops read all paginated children and keep empty dropped folders', async () => {
  const empty: DropEntry = {name: 'empty', isFile: false, isDirectory: true, createReader: () => ({readEntries: (done: (entries: DropEntry[]) => void) => done([])})};
  const entry: DropEntry = {name: 'Dropped', isFile: false, isDirectory: true, createReader() {
    let page = 0;
    return {readEntries(done: (entries: DropEntry[]) => void) {done(page++ === 0 ? [empty] : page === 2 ? [{name: 'game.exe', isFile: true, isDirectory: false, file: (resolve: (file: File) => void) => resolve(new File(['game'], 'game.exe'))}] : []);}};
  }};
  const [archive] = await archiveFolderDrop({entries: [entry], files: []});
  const reader = new ZipReader(new BlobReader(archive), {useWebWorkers: false});
  try {const entries = await reader.getEntries(); assert.equal(entries.length, 3); assert.ok(entries.some(value => value.filename.endsWith('/empty/'))); assert.ok(entries.some(value => value.filename.endsWith('/game.exe')));}
  finally {await reader.close();}
});


test('preparation yields and cancels while writing many empty archive entries', async () => {
  const controller = new AbortController();
  await assert.rejects(createFolderArchive('Cancelable', Array.from({length: 100}, (_, index) => ({path: `empty-${index}`, directory: true})), {
    signal: controller.signal, onProgress: count => {if (count === 32) controller.abort();},
  }), {name: 'AbortError'});
});

function diskStorage(options: {available?: number; capture?: boolean; failWrite?: boolean; beforeWrite?: () => void} = {}) {
  const state = {created: 0, removed: 0, aborted: 0, closed: 0, bytes: 0, largestChunk: 0, inFlight: 0, peakInFlight: 0};
  const storage: ArchiveStorage = {
    kind: 'disk', availableBytes: async () => options.available,
    async create(name) {
      state.created++;
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      return {
        writable: new WritableStream<Uint8Array>({
          async write(chunk) {
            state.inFlight++; state.peakInFlight = Math.max(state.peakInFlight, state.inFlight);
            try {
              options.beforeWrite?.();
              if (options.failWrite) throw new DOMException('disk full', 'QuotaExceededError');
              await Promise.resolve();
              state.bytes += chunk.byteLength;
              state.largestChunk = Math.max(state.largestChunk, chunk.byteLength);
              if (options.capture) chunks.push(new Uint8Array(chunk));
            } finally {state.inFlight--;}
          },
          close() {state.closed++;}, abort() {state.aborted++;},
        }, {highWaterMark: 1}),
        async getFile() {
          const file = new File(chunks, name, {type: 'application/zip'});
          if (!options.capture) Object.defineProperty(file, 'size', {value: state.bytes});
          return file;
        },
        async remove() {state.removed++;},
      };
    },
  };
  return {storage, state};
}

test('disk-backed ZIP64 output preserves contents and is released exactly once', async () => {
  const {storage, state} = diskStorage({capture: true});
  const archive = await createFolderArchive('Disk', [{path: 'hello.txt', file: new File(['hello disk'], 'hello.txt')}], {storage});
  const reader = new ZipReader(new BlobReader(archive), {useWebWorkers: false});
  try {
    const entries = await reader.getEntries(); const entry = entries[1];
    if (entry.directory) throw new Error('Expected a file entry');
    assert.equal(await entry.getData!(new TextWriter()), 'hello disk');
  } finally {await reader.close();}
  assert.equal(state.closed, 1); assert.equal(state.removed, 0);
  retainPreparedArchive(archive);
  await releasePreparedArchive(archive);
  assert.equal(state.removed, 0, 'active sender still owns the archive');
  await releasePreparedArchive(archive); await releasePreparedArchive(archive);
  assert.equal(state.removed, 1);
});

test('a folder exceeding the memory fallback limit streams bounded chunks to a slow disk', async () => {
  const size = FOLDER_PREPARATION_LIMIT + 1024;
  const source = new File([], 'generated.bin');
  Object.defineProperty(source, 'size', {value: size});
  let largestRead = 0;
  Object.defineProperty(source, 'arrayBuffer', {value: () => {throw new Error('must not read the whole source');}});
  Object.defineProperty(source, 'slice', {value: (start: number, end: number) => {
    largestRead = Math.max(largestRead, end - start);
    return new Blob([new Uint8Array(end - start)]);
  }});
  const {storage, state} = diskStorage();
  const archive = await createFolderArchive('Large', [{path: source.name, file: source}], {storage});
  assert.ok(archive.size > FOLDER_PREPARATION_LIMIT);
  assert.ok(largestRead <= 256 * 1024);
  assert.ok(state.largestChunk <= 256 * 1024);
  assert.equal(state.peakInFlight, 1);
  await releasePreparedArchive(archive);
  assert.equal(state.removed, 1);
});

test('100 GB plus archive metadata and insufficient quota are rejected before source reads or disk creation', async () => {
  const source = new File([], 'huge.bin');
  Object.defineProperty(source, 'size', {value: MAX_FILE_BYTES});
  Object.defineProperty(source, 'slice', {value: () => {throw new Error('must not read the source');}});
  const huge = diskStorage();
  await assert.rejects(createFolderArchive('Large', [{path: source.name, file: source}], {storage: huge.storage}), /100 GB/);
  assert.equal(huge.state.created, 0);
  const full = diskStorage({available: 10});
  await assert.rejects(createFolderArchive('Small', [], {storage: full.storage}), /not enough temporary browser storage/);
  assert.equal(full.state.created, 0);
});

test('disk-full failure and cancellation remove incomplete temporary archives', async () => {
  const full = diskStorage({failWrite: true});
  await assert.rejects(createFolderArchive('Full', [], {storage: full.storage}), /storage became full/);
  assert.equal(full.state.removed, 1);
  const abort = new AbortController();
  const canceled = diskStorage({beforeWrite: () => abort.abort()});
  await assert.rejects(createFolderArchive('Canceled', [{path: 'hello', file: new File(['hello'], 'hello')}], {storage: canceled.storage, signal: abort.signal}), {name: 'AbortError'});
  assert.equal(canceled.state.removed, 1);
  assert.equal(canceled.state.aborted, 1);
});

test('cancel remains responsive during a single cached large source file', async () => {
  const controller = new AbortController();
  const size = 16 * 1024 * 1024;
  const source = new File([], 'cached.bin');
  Object.defineProperty(source, 'size', {value: size});
  Object.defineProperty(source, 'slice', {value: (start: number, end: number) => new Blob([new Uint8Array(end - start)])});
  let scheduled = false;
  const {storage, state} = diskStorage({beforeWrite() {
    if (state.bytes >= 1024 * 1024 && !scheduled) {scheduled = true; setTimeout(() => controller.abort(), 0);}
  }});
  await assert.rejects(createFolderArchive('Cached', [{path: source.name, file: source}], {storage, signal: controller.signal}), {name: 'AbortError'});
  assert.ok(state.bytes < size);
  assert.equal(state.removed, 1);
});

test('failed multi-folder drops clean up archives already prepared by that drop', async () => {
  const empty: DropEntry = {name: 'Valid', isFile: false, isDirectory: true, createReader: () => ({readEntries: done => done([])})};
  const bad: DropEntry = {name: 'Unreadable', isFile: false, isDirectory: true};
  const {storage, state} = diskStorage();
  await assert.rejects(archiveFolderDrop({entries: [empty, bad], files: []}, {storage}), /could not read/);
  assert.equal(state.created, 1); assert.equal(state.removed, 1);
});
