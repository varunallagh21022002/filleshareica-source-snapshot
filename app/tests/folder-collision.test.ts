import assert from 'node:assert/strict';
import test from 'node:test';
import { folderSink, type DirectoryHandle } from '../lib/client/sinks';

test('simultaneous group receives reserve different names in a shared destination', async () => {
  const files = new Map<string, string>();
  const directory: DirectoryHandle = {name: 'Files', async getFileHandle(name, options) {
    await new Promise(resolve => setTimeout(resolve, 1));
    if (!options?.create && !files.has(name)) throw new DOMException('Missing', 'NotFoundError');
    files.set(name, '');
    return {async createWritable() {
      return {async write(bytes: Uint8Array) {files.set(name, new TextDecoder().decode(bytes));}, async close() {}, async abort() {}} as unknown as FileSystemWritableFileStream;
    }};
  }};
  const [first, second] = await Promise.all([folderSink(directory, 'photo.txt'), folderSink(directory, 'photo.txt')]);
  await first.write(new TextEncoder().encode('first')); await second.write(new TextEncoder().encode('second'));
  await Promise.all([first.close(), second.close()]);
  assert.equal(files.get('photo.txt'), 'first'); assert.equal(files.get('photo (1).txt'), 'second');
});
