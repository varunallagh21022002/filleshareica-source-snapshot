import assert from 'node:assert/strict';
import test from 'node:test';
import {cleanupPreparedArchives, getArchiveStorage, releasePreparedArchive} from '../lib/client/archive-storage';
import {createFolderArchive} from '../lib/client/folder-archive';

function fakeBrowserStorage(withLocks = true) {
  const files = new Map<string, File>();
  const held = new Map<string, Promise<void>>();
  const directory = {
    async getFileHandle(name: string, options: {create?: boolean}) {
      if (!files.has(name)) {
        if (!options.create) throw new DOMException('not found', 'NotFoundError');
        files.set(name, new File([], name));
      }
      return {
        async getFile() {return files.get(name)!;},
        async createWritable() {
          const chunks: Uint8Array<ArrayBuffer>[] = [];
          return new WritableStream<Uint8Array>({
            write(chunk) {chunks.push(new Uint8Array(chunk));},
            close() {files.set(name, new File(chunks, name));},
          });
        },
      };
    },
    async removeEntry(name: string) {
      if (!files.delete(name)) throw new DOMException('not found', 'NotFoundError');
    },
    async *values() {for (const name of files.keys()) yield {kind: 'file', name};},
  };
  const locks = {
    async request(name: string, optionsOrCallback: unknown, maybeCallback?: (lock: unknown) => unknown) {
      const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback as {ifAvailable?: boolean};
      const callback = (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback) as (lock: unknown) => unknown;
      if (held.has(name) && options.ifAvailable) return callback(null);
      while (held.has(name)) await held.get(name);
      let release!: () => void;
      held.set(name, new Promise<void>(resolve => {release = resolve;}));
      try {return await callback({name});}
      finally {held.delete(name); release();}
    },
  };
  const navigator = {
    storage: {
      async getDirectory() {return {async getDirectoryHandle() {return directory;}};},
      async estimate() {return {quota: 1_000_000_000, usage: 0};},
    },
    ...(withLocks ? {locks} : {}),
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {value: navigator, configurable: true});
  return {files, held, restore() {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }};
}

test('OPFS archives retain a lease until release; startup cleanup deletes only abandoned archives', async () => {
  const browser = fakeBrowserStorage();
  try {
    const storage = await getArchiveStorage();
    assert.equal(storage.kind, 'disk');
    assert.equal(await storage.availableBytes?.(), 1_000_000_000);
    const archive = await createFolderArchive('Prepared', [{path: 'a.txt', file: new File(['a'], 'a.txt')}], {storage});
    assert.match(archive.name, /^Prepared-[a-f0-9]{8}\.zip$/);
    assert.equal(browser.files.size, 1);
    assert.equal(browser.held.size, 1);
    const abandoned = '1700000000000-11111111-1111-4111-8111-111111111111.zip';
    browser.files.set(abandoned, new File([], abandoned));
    browser.files.set('unrelated.txt', new File([], 'unrelated.txt'));
    await cleanupPreparedArchives();
    assert.equal(browser.files.has(abandoned), false);
    assert.equal(browser.files.has('unrelated.txt'), true);
    assert.equal(browser.files.size, 2, 'the live archive remains available');
    await releasePreparedArchive(archive); await releasePreparedArchive(archive);
    assert.equal(browser.files.size, 1);
    assert.equal(browser.held.size, 0);
  } finally {browser.restore();}
});

test('startup cleanup never removes archives when another-tab leases cannot be checked', async () => {
  const browser = fakeBrowserStorage(false);
  try {
    const name = '1700000000000-11111111-1111-4111-8111-111111111111.zip';
    browser.files.set(name, new File([], name));
    await cleanupPreparedArchives();
    assert.equal(browser.files.has(name), true);
  } finally {browser.restore();}
});
