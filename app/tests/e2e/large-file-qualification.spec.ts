import {test, expect} from './fixtures';
import {open, mkdtemp, mkdir, writeFile, rm, statfs} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {demoLogin, demoPurchase} from './market-helpers';
import {chromium} from '@playwright/test';

/** Opt-in, real disk + real WebRTC exercise. This is NOT 100 GB release qualification. */
test('disk-backed transfer crosses the 4 GiB offset boundary with independently verified bytes', async ({page}, testInfo) => {
  test.skip(process.env.LARGE_FILE_QA !== '1', 'Opt in with LARGE_FILE_QA=1; needs at least 7 GiB free and several minutes.');
  test.setTimeout(20 * 60_000);
  const bytes = 5 * 1024 ** 3 + 123;
  const disk = await statfs(resolve('.'));
  expect(disk.bavail * disk.bsize, 'Enough free disk for the receiver and browser temporary output').toBeGreaterThan(bytes + 2 * 1024 ** 3);
  const directory = await mkdtemp(resolve(tmpdir(), 'fil3shareica-large-'));
  const source = resolve(directory, 'offset-boundary.bin');
  const handle = await open(source, 'w');
  try {
    await handle.truncate(bytes); // Sparse source; the receiver still writes every byte.
    for (const position of [0, 2 ** 32 - 32, 2 ** 32 + 21, bytes - 64]) {
      await handle.write(Buffer.from(`fil3shareica-offset-${position}`.padEnd(32, '!')), 0, 32, position);
    }
  } finally {await handle.close();}
  const expected = createHash('sha256');
  for await (const chunk of createReadStream(source, {highWaterMark: 1024 * 1024})) expected.update(chunk);
  const expectedDigest = expected.digest('hex');
  const profile = await mkdtemp(resolve(tmpdir(), 'fil3shareica-disk-browser-'));
  // A regular, isolated on-disk profile is necessary: Chromium incognito's
  // in-memory filesystem has a separate hard quota unsuitable for this run.
  const receiverContext = await chromium.launchPersistentContext(profile, {channel: 'chrome', headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns']});
  const receiver = await receiverContext.newPage();
  // Select a real, disk-backed OPFS directory instead of automating a native OS dialog.
  // The native external-folder permission UI still needs physical-device qualification.
  await receiverContext.addInitScript(() => {
    type QAWindow = Window & {showDirectoryPicker?: () => Promise<unknown>; qaDisk?: {bytes: number; peakWrite: number; inFlight: number; peakInFlight: number; closed: boolean; directory: FileSystemDirectoryHandle}};
    const current = window as QAWindow;
    current.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle('fil3shareica-real-disk-qa', {create: true});
      const metrics = {bytes: 0, peakWrite: 0, inFlight: 0, peakInFlight: 0, closed: false, directory};
      current.qaDisk = metrics;
      return {
        name: directory.name,
        queryPermission: async () => 'granted',
        async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
          const file = await directory.getFileHandle(name, options);
          return {async createWritable() {
            const writer = await file.createWritable();
            return {
              async write(chunk: Uint8Array) {
                metrics.inFlight++; metrics.peakInFlight = Math.max(metrics.peakInFlight, metrics.inFlight);
                metrics.peakWrite = Math.max(metrics.peakWrite, chunk.byteLength);
                try {await writer.write(chunk as FileSystemWriteChunkType); metrics.bytes += chunk.byteLength;}
                finally {metrics.inFlight--;}
              },
              async close() {await writer.close(); metrics.closed = true;},
              async abort() {await writer.abort();},
            };
          }};
        },
      };
    };
  });
  const heapSamples: {sender: number | null; receiver: number | null; at: number}[] = [];
  const heap = (target: typeof page) => target.evaluate(() => (performance as Performance & {memory?: {usedJSHeapSize: number}}).memory?.usedJSHeapSize ?? null).catch(() => null);
  try {
    await demoLogin(page, `large-${Date.now()}@example.test`);
    await demoPurchase(page);
    await page.goto('/');
    await expect(page.getByRole('button', {name: 'Create a connection', exact: true})).toBeEnabled();
    await page.getByRole('button', {name: 'Create a connection', exact: true}).click();
    const invitation = page.getByTestId('pairing-link');
    await expect(invitation).toBeVisible();
    await receiver.goto(await invitation.inputValue());
    await expect(receiver.getByRole('heading', {name: 'Waiting for approval', exact: true})).toBeVisible();
    await page.getByRole('button', {name: 'Approve device', exact: true}).click();
    await expect(receiver.getByRole('heading', {name: 'You’re connected.', exact: true})).toBeVisible({timeout: 35_000});
    await expect(page.getByRole('heading', {name: 'You’re connected.', exact: true})).toBeVisible({timeout: 35_000});
    await page.getByLabel('Select files to send').setInputFiles(source);
    await page.getByRole('button', {name: 'Send files', exact: true}).click();
    await receiver.getByRole('button', {name: 'Accept & choose destination', exact: true}).click();
    const received = receiver.locator('[data-testid="transfer-row"][data-filename="offset-boundary.bin"][data-direction="incoming"]');
    const started = Date.now();
    await expect.poll(async () => {
      heapSamples.push({sender: await heap(page), receiver: await heap(receiver), at: Date.now() - started});
      const status = await received.getAttribute('data-status');
      if (status === 'failed') throw new Error(await received.innerText());
      return status;
    }, {timeout: 16 * 60_000, intervals: [1000, 3000, 5000]}).toBe('saved');
    const elapsedMs = Date.now() - started;
    const saved = await receiver.evaluate(async () => {
      const qa = (window as unknown as {qaDisk: {directory: FileSystemDirectoryHandle; bytes: number; peakWrite: number; peakInFlight: number; closed: boolean}}).qaDisk;
      const file = await (await qa.directory.getFileHandle('offset-boundary.bin')).getFile();
      // A separate, incremental second read verifies the committed destination.
      const source = '/lib/client/hasher.ts';
      const {StreamingHasher} = await import(/* @vite-ignore */ source);
      const hasher = new StreamingHasher(); hasher.start('saved-file');
      try {
        for (let offset = 0; offset < file.size; offset += 256 * 1024) {
          hasher.update('saved-file', await file.slice(offset, offset + 256 * 1024).arrayBuffer());
          await hasher.flush('saved-file');
        }
        return {size: file.size, digest: await hasher.finish('saved-file'), bytesWritten: qa.bytes, peakWrite: qa.peakWrite, peakInFlight: qa.peakInFlight, closed: qa.closed};
      } finally {hasher.destroy();}
    });
    expect(saved.size).toBe(bytes); expect(saved.bytesWritten).toBe(bytes);
    expect(saved.digest).toBe(expectedDigest); expect(saved.closed).toBe(true);
    expect(saved.peakWrite).toBeLessThanOrEqual(64 * 1024); expect(saved.peakInFlight).toBe(1);
    for (const side of ['sender', 'receiver'] as const) {
      const observed = heapSamples.map(sample => sample[side]).filter((sample): sample is number => sample !== null);
      if (observed.length) expect(Math.max(...observed), `${side} sampled JS heap (excludes native/browser allocations)`).toBeLessThan(512 * 1024 ** 2);
    }
    const evidence = {bytes, expectedDigest, saved, elapsedMs, averageMBps: bytes / elapsedMs / 1000, browser: receiverContext.browser()?.version(), platform: process.platform, heapSamples, qualification: '5 GiB real disk path only; NOT 100 GB or cross-device qualification'};
    await mkdir(testInfo.outputDir, {recursive: true});
    const evidencePath = testInfo.outputPath('large-disk-evidence.json');
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
    await testInfo.attach('large-disk-evidence', {path: evidencePath, contentType: 'application/json'});
  } finally {
    const partial = await receiver.evaluate(() => {
      const qa = (window as unknown as {qaDisk?: {bytes: number; peakWrite: number; peakInFlight: number; closed: boolean}}).qaDisk;
      return qa ? {bytesWritten: qa.bytes, peakWrite: qa.peakWrite, peakInFlight: qa.peakInFlight, closed: qa.closed} : null;
    }).catch(() => null);
    await mkdir(testInfo.outputDir, {recursive: true});
    const finalStatePath = testInfo.outputPath('disk-run-final-state.json');
    await writeFile(finalStatePath, JSON.stringify({partial, heapSamples}, null, 2));
    await testInfo.attach('disk-run-final-state', {path: finalStatePath, contentType: 'application/json'});
    await receiver.evaluate(async () => {await (await navigator.storage.getDirectory()).removeEntry('fil3shareica-real-disk-qa', {recursive: true}).catch(() => {});}).catch(() => {});
    await receiverContext.close();
    await rm(profile, {recursive: true, force: true});
    await rm(directory, {recursive: true, force: true});
  }
});
