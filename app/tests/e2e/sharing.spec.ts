import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';
import { sendFiles, finishTestAd, prepareSendCredit, demoLogin, demoPurchase } from './market-helpers';

const checksum = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const row = (page: Page, name: string, direction: string) => page.locator(`[data-testid="transfer-row"][data-filename="${name}"][data-direction="${direction}"]`);

async function pair(host: Page, browser: Browser): Promise<{ guest: Page; context: BrowserContext }> {
  await host.goto('/');
  await expect(host.getByRole('button', { name: 'Create a connection', exact: true })).toBeEnabled();
  await expect(host.getByTestId('session-name')).toBeEnabled();
  await host.getByTestId('session-name').fill('My devices');
  await host.getByRole('button', { name: 'Create a connection', exact: true }).click();
  const invitation = host.getByTestId('pairing-link');
  await expect(invitation).toBeVisible();
  const link = await invitation.inputValue();
  expect(link).toContain('#key=');
  expect(new URL(link).pathname).toMatch(/^\/[a-f0-9]{6}$/);
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const guest = await context.newPage();
  await guest.goto(link);
  await expect(guest.getByRole('heading', { name: 'Waiting for approval', exact: true })).toBeVisible();
  await host.getByRole('button', { name: 'Approve device', exact: true }).click();
  await expect(host.getByRole('heading', { name: 'You’re connected.', exact: true })).toBeVisible({ timeout: 35_000 });
  await expect(guest.getByRole('heading', { name: 'You’re connected.', exact: true })).toBeVisible({ timeout: 35_000 });
  return { guest, context };
}

async function verifyDownload(page: Page, name: string, expected: Buffer) {
  await expect(row(page, name, 'incoming')).toHaveAttribute('data-status', 'ready', { timeout: 45_000 });
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: `Download ${name}`, exact: true }).click();
  const download = await waiting;
  expect(download.suggestedFilename()).toBe(name);
  const path = await download.path();
  expect(path).toBeTruthy();
  expect(checksum(await readFile(path!))).toBe(checksum(expected));
  await expect(row(page, name, 'incoming')).toHaveAttribute('data-status', 'downloaded');
}

test('phone and desktop layouts fit without horizontal overflow', async ({ page }) => {
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Your files.');
    await expect(page.getByRole('button', { name: 'Create a connection', exact: true })).toBeEnabled();
    const layout = await page.evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth}));
    expect(layout.scroll, JSON.stringify(layout)).toBeLessThanOrEqual(width);
  }
});

test('independent browser contexts exchange multiple files both ways with verified downloads', async ({ page, browser }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const { guest, context } = await pair(page, browser);
  guest.on('pageerror', error => errors.push(error.message));
  try {
    const hello = Buffer.from('A real verified file from computer to phone.\n');
    const binary = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < binary.length; i++) binary[i] = (i * 31 + 17) % 256;
    const reverse = Buffer.from('A real file returning from the phone.\n');
    await page.getByLabel('Select files to send').setInputFiles([
      { name: 'hello.txt', mimeType: 'text/plain', buffer: hello },
      { name: 'payload.bin', mimeType: 'application/octet-stream', buffer: binary },
      { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
    ]);
    await guest.getByLabel('Select files to send').setInputFiles({ name: 'return.txt', mimeType: 'text/plain', buffer: reverse });
    await Promise.all([
      sendFiles(page),
      sendFiles(guest),
    ]);
    await Promise.all([
      page.getByRole('button', { name: 'Accept all', exact: true }).click(),
      guest.getByRole('button', { name: 'Accept all', exact: true }).click(),
    ]);
    await verifyDownload(guest, 'hello.txt', hello);
    await verifyDownload(guest, 'payload.bin', binary);
    await verifyDownload(guest, 'empty.txt', Buffer.alloc(0));
    await verifyDownload(page, 'return.txt', reverse);
    await expect(row(page, 'payload.bin', 'outgoing')).toHaveAttribute('data-status', 'received');
    await expect(row(guest, 'return.txt', 'outgoing')).toHaveAttribute('data-status', 'received');
    await page.getByTestId('chat-input').fill('A real message from the computer.');
    await page.getByTestId('chat-send').click();
    await expect(guest.getByTestId('chat-message').filter({hasText: 'A real message from the computer.'})).toBeVisible();
    await guest.getByTestId('chat-input').fill('A real reply from the phone.');
    await guest.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-message').filter({hasText: 'A real reply from the phone.'})).toBeVisible();
    expect(errors).toEqual([]);
    await page.getByRole('button', { name: 'End session', exact: true }).click();
    await page.getByTestId('confirm-end-session').click();
    await expect(guest.getByText('Session ended. You can create a fresh connection.')).toBeVisible();
  } finally { await context.close(); }
});

test('pause, resume, and cancel apply to a real transfer', async ({ page, browser }) => {
  const { guest, context } = await pair(page, browser);
  try {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Bandwidth limit (Mbps)').fill('2');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    const bytes = Buffer.alloc(4 * 1024 * 1024, 37);
    await page.getByLabel('Select files to send').setInputFiles({ name: 'controlled.bin', mimeType: 'application/octet-stream', buffer: bytes });
    await sendFiles(page);
    await guest.getByRole('button', { name: 'Accept all', exact: true }).click();
    await expect(row(page, 'controlled.bin', 'outgoing')).toHaveAttribute('data-status', 'transferring');
    await page.getByRole('button', { name: 'Pause controlled.bin', exact: true }).click();
    await expect(row(page, 'controlled.bin', 'outgoing')).toHaveAttribute('data-status', 'paused');
    await expect(row(guest, 'controlled.bin', 'incoming')).toHaveAttribute('data-status', 'paused');
    await page.getByRole('button', { name: 'Resume controlled.bin', exact: true }).click();
    await expect(row(page, 'controlled.bin', 'outgoing')).toHaveAttribute('data-status', 'transferring');
    await page.getByRole('button', { name: 'Cancel controlled.bin', exact: true }).click();
    await expect(row(page, 'controlled.bin', 'outgoing')).toHaveAttribute('data-status', 'canceled');
    await expect(row(guest, 'controlled.bin', 'incoming')).toHaveAttribute('data-status', 'canceled');
  } finally { await context.close(); }
});

test('malformed invitations report an actionable error', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Create a connection', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Join a session', exact: true }).click();
  await page.getByLabel('Connection link', { exact: true }).fill('http://localhost:5173/?session=invalid#key=invalid');
  await page.getByRole('button', { name: 'Join session', exact: true }).click();
  await expect(page.getByText(/This invitation is incomplete|Invalid invitation key|different website/)).toBeVisible();
});

test('named sessions survive either and simultaneous page refreshes without new approval', async ({ page, browser }) => {
  test.setTimeout(150_000);
  const { guest, context } = await pair(page, browser);
  const sessionPath = new URL(page.url()).pathname;
  try {
    for (const reload of [() => page.reload(), () => guest.reload(), () => Promise.all([page.reload(), guest.reload()])]) {
      await reload();
      await expect(page.getByRole('heading', { name: 'You’re connected.', exact: true })).toBeVisible({ timeout: 35_000 });
      await expect(guest.getByRole('heading', { name: 'You’re connected.', exact: true })).toBeVisible({ timeout: 35_000 });
      expect(new URL(page.url()).pathname).toBe(sessionPath);
      expect(new URL(guest.url()).pathname).toBe(sessionPath);
      await expect(page.getByRole('button', { name: 'Approve device', exact: true })).toHaveCount(0);
      const name = `after-refresh-${Date.now()}.txt`;
      const bytes = Buffer.from(`The same approved session after refresh: ${name}`);
      await guest.getByLabel('Select files to send').setInputFiles({ name, mimeType: 'text/plain', buffer: bytes });
      await sendFiles(guest);
      await page.getByRole('button', { name: 'Accept all', exact: true }).click();
      await verifyDownload(page, name, bytes);
    }
    await guest.getByRole('button', { name: 'Leave session', exact: true }).click();
    await guest.reload();
    await expect(guest.getByRole('button', { name: 'Create a connection', exact: true })).toBeEnabled();
    expect(await guest.evaluate(() => sessionStorage.getItem('f8-active-session-v1') === null)).toBeTruthy();
  } finally { await context.close(); }
});

test('QR scanner decodes a real camera video frame and stops camera tracks after joining', async ({ page, browser }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a connection', exact: true }).click();
  await expect(page.getByTestId('pairing-link')).toBeVisible();
  const originalLink = await page.getByTestId('pairing-link').inputValue();
  await page.reload();
  await expect(page.getByTestId('pairing-link')).toHaveValue(originalLink);
  const qr = page.getByAltText('Scan this QR code with your other device to connect');
  await expect(qr).toBeVisible();
  const dataUrl = await qr.getAttribute('src');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript((imageUrl) => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      const canvas = document.createElement('canvas'); canvas.width = 720; canvas.height = 720;
      const ctx = canvas.getContext('2d')!;
      const image = new Image(); image.src = imageUrl!; await image.decode();
      const draw = () => { ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 720, 720); ctx.drawImage(image, 60, 60, 600, 600); };
      draw(); const timer = setInterval(draw, 80);
      const stream = canvas.captureStream(12);
      (window as unknown as Window & { __cameraTracks: MediaStreamTrack[] }).__cameraTracks = stream.getTracks();
      stream.getTracks().forEach(track => { const stop = track.stop.bind(track); track.stop = () => { clearInterval(timer); stop(); }; });
      return stream;
    } });
  }, dataUrl);
  const guest = await context.newPage();
  try {
    await guest.goto('/');
    await guest.getByRole('button', { name: 'Join a session', exact: true }).click();
    await guest.getByTestId('scan-qr').click();
    await expect(guest.getByRole('heading', { name: 'Waiting for approval', exact: true })).toBeVisible({ timeout: 25_000 });
    expect(await guest.evaluate(() => (window as unknown as Window & { __cameraTracks: MediaStreamTrack[] }).__cameraTracks.every(track => track.readyState === 'ended'))).toBeTruthy();
    await page.getByRole('button', { name: 'Approve device', exact: true }).click();
    await expect(guest.getByRole('heading', { name: 'You’re connected.', exact: true })).toBeVisible({ timeout: 35_000 });
  } finally { await context.close(); }
});

test('camera denial offers a usable paste fallback, Bluetooth explanation, and paid Maximum speed gate', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => { throw new DOMException('Denied for test', 'NotAllowedError'); } }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Create a connection', exact: true })).toBeEnabled();
  await expect(page.getByTestId('scan-qr')).toHaveCount(0);
  await page.getByRole('button', { name: 'Join a session', exact: true }).click();
  await page.getByTestId('scan-qr').click();
  await expect(page.getByRole('alert')).toContainText('Camera access was denied');
  await page.getByRole('button', { name: 'Paste a link instead', exact: true }).click();
  await expect(page.getByLabel('Connection link', { exact: true })).toBeFocused();
  await page.getByRole('button', { name: /Bluetooth.*Check browser support/ }).click();
  await expect(page.getByRole('dialog')).toContainText('Browser-to-browser Bluetooth file transfer is unavailable');
  await page.getByRole('button', { name: 'Got it', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Bandwidth limit (Mbps)').fill('12');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByTestId('ultra-fast')).toBeDisabled();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Bandwidth limit (Mbps)')).toHaveValue('12');
});

test('Save as streams a received file into the selected writable handle', async ({ page, browser }) => {
  const { guest, context } = await pair(page, browser);
  try {
    // Substitute the native dialog with an actual OPFS file handle; writing still uses the real stream.
    await guest.evaluate(() => Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async ({ suggestedName }: { suggestedName: string }) => {
      const directory = await navigator.storage.getDirectory();
      return directory.getFileHandle(suggestedName, { create: true });
    } }));
    const name = 'save-location.txt'; const bytes = Buffer.from('Verified bytes written via the Save as destination.');
    await page.getByLabel('Select files to send').setInputFiles({ name, mimeType: 'text/plain', buffer: bytes });
    await sendFiles(page);
    await guest.getByRole('button', { name: 'Accept all', exact: true }).click();
    await expect(row(guest, name, 'incoming')).toHaveAttribute('data-status', 'ready');
    await guest.setViewportSize({ width: 320, height: 844 });
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await expect(guest.getByRole('button', { name: `Download ${name}`, exact: true })).toBeVisible();
    await guest.getByRole('button', { name: `Save ${name} as…`, exact: true }).click();
    await expect(row(guest, name, 'incoming')).toHaveAttribute('data-status', 'saved');
    const saved = await guest.evaluate(async (filename) => {
      const directory = await navigator.storage.getDirectory(); const handle = await directory.getFileHandle(filename);
      return (await handle.getFile()).text();
    }, name);
    expect(saved).toBe(bytes.toString());
  } finally { await context.close(); }
});

test('refresh interrupts an active file cleanly and the recovered direct connection works without signaling internet', async ({ page, browser }) => {
  test.setTimeout(150_000);
  const { guest, context } = await pair(page, browser);
  try {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Bandwidth limit (Mbps)').fill('1');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    const name = 'refresh-during-transfer.bin'; const bytes = Buffer.alloc(1024 * 1024, 87);
    await page.getByLabel('Select files to send').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
    await sendFiles(page);
    await guest.getByRole('button', { name: 'Accept all', exact: true }).click();
    await expect(row(guest, name, 'incoming')).toHaveAttribute('data-status', 'transferring');
    await guest.reload();
    await expect(guest.getByText(/must be selected and sent again/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'You’re connected.', exact: true })).toBeVisible({ timeout: 35_000 });
    await expect(guest.getByRole('heading', { name: 'You’re connected.', exact: true })).toBeVisible({ timeout: 35_000 });
    await expect(row(page, name, 'outgoing')).toHaveAttribute('data-status', 'failed');
    // The already established WebRTC path must transfer with both signaling endpoints unavailable.
    await page.route('**/api/sessions/**', route => route.abort());
    await guest.route('**/api/sessions/**', route => route.abort());
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
    await page.getByLabel('Bandwidth limit (Mbps)').fill('0');
    await page.getByRole('button', {name: 'Done', exact: true}).click();
    await page.getByRole('button', { name: `Retry ${name}`, exact: true }).click();
    await guest.getByRole('button', { name: 'Accept all', exact: true }).click();
    await verifyDownload(guest, name, bytes);
    await page.unroute('**/api/sessions/**');
    await guest.unroute('**/api/sessions/**');
    const expired = { status: 410, contentType: 'application/json', body: JSON.stringify({ error: 'This session has expired.' }) };
    await page.route('**/api/sessions/**', route => route.fulfill(expired));
    await guest.route('**/api/sessions/**', route => route.fulfill(expired));
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('f8-active-session-v1') === null), {timeout: 70_000}).toBeTruthy();
    await expect.poll(() => guest.evaluate(() => sessionStorage.getItem('f8-active-session-v1') === null), {timeout: 70_000}).toBeTruthy();
    await expect(page.getByRole('heading', { name: 'You’re connected.', exact: true })).toBeVisible();
    await expect(guest.getByRole('heading', { name: 'You’re connected.', exact: true })).toBeVisible();
    const finalName = 'after-signaling-expiry.txt'; const finalBytes = Buffer.from('A healthy local channel continues after the pairing record expires.');
    await guest.getByLabel('Select files to send').setInputFiles({ name: finalName, mimeType: 'text/plain', buffer: finalBytes });
    await sendFiles(guest);
    await page.getByRole('button', { name: 'Accept all', exact: true }).click();
    await verifyDownload(page, finalName, finalBytes);
  } finally { await context.close(); }
});


test('a browser folder picker creates a real ZIP64 that transfers nested Unicode files and empty folders', async ({page, browser}) => {
  const {guest, context} = await pair(page, browser);
  try {
    await page.evaluate(() => {
      Object.defineProperty(window, 'showDirectoryPicker', {configurable: true, value: async () => ({kind: 'directory', name: 'Folder check', async *values() {
        yield {kind: 'directory', name: 'Empty', async *values() {}};
        yield {kind: 'directory', name: '旅行', async *values() {yield {kind: 'file', name: 'hello.txt', getFile: async () => new File(['Verified folder payload 🌍'], 'hello.txt', {type: 'text/plain'})};}};
        yield {kind: 'file', name: 'installer.apk', getFile: async () => new File(['ordinary installer file'], 'installer.apk', {type: 'application/octet-stream'})};
      }})});
    });
    await page.getByTestId('choose-source-folder').click();
    const selected = page.locator('.selected-file strong'); await expect(selected).toHaveCount(1);
    const name = await selected.innerText(); expect(name).toMatch(/^Folder check-[a-f0-9]{8}\.zip$/);
    await sendFiles(page);
    await guest.getByRole('button', {name: 'Accept all', exact: true}).click();
    await expect(row(guest, name, 'incoming')).toHaveAttribute('data-status', 'ready');
    const waiting = guest.waitForEvent('download');
    await guest.getByRole('button', {name: `Download ${name}`, exact: true}).click();
    const downloaded = await waiting; const bytes = await readFile((await downloaded.path())!);
    expect(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBeTruthy();
    const reader = new ZipReader(new BlobReader(new Blob([bytes])), {useWebWorkers: false});
    try {
      const entries = await reader.getEntries();
      expect(entries.some(entry => entry.filename.endsWith('/Empty/') && entry.directory)).toBeTruthy();
      const nested = entries.find(entry => entry.filename.endsWith('/旅行/hello.txt'));
      if (!nested || nested.directory) throw new Error('Missing nested file');
      expect(await nested.getData!(new TextWriter())).toBe('Verified folder payload 🌍');
      expect(entries.some(entry => entry.filename.endsWith('/installer.apk'))).toBeTruthy();
    } finally {await reader.close();}
    await expect(page.getByText('Receiver storage limits')).toBeVisible();
  } finally {await context.close();}
});

test('unsupported folder selection explains pre-archiving and companion availability without fake downloads', async ({page}) => {
  await page.goto('/');
  await expect(page.getByTestId('choose-source-folder')).toBeEnabled();
  await page.evaluate(() => Object.defineProperty(window, 'showDirectoryPicker', {configurable: true, value: undefined}));
  await page.getByTestId('choose-source-folder').click();
  await expect(page.getByRole('dialog')).toContainText('Create a ZIP in your device’s file manager');
  await page.getByRole('button', {name: 'About native companions', exact: true}).click();
  await expect(page.getByRole('dialog')).toContainText('No public companion installer or Android APK download is available');
  await expect(page.getByRole('dialog').locator('a[href$=".apk"]')).toHaveCount(0);
  await page.getByRole('button', {name: 'Continue in browser', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Choose files', exact: true})).toBeEnabled();
});


test('only the sender watches an ad for each batch; receiving and chat stay free', async ({page, browser}) => {
  const {guest, context} = await pair(page, browser);
  try {
    await page.getByTestId('chat-input').fill('No ad is needed for chat.');
    await page.getByTestId('chat-send').click();
    await expect(guest.getByTestId('chat-message').filter({hasText:'No ad is needed for chat.'})).toBeVisible();
    for (const name of ['sender-first.txt','sender-next.txt']) {
      if(name==='sender-next.txt') await page.setViewportSize({width:320,height:844});
      const payload = Buffer.from(`Only the sender watches for ${name}`);
      await page.getByLabel('Select files to send').setInputFiles({name,mimeType:'text/plain',buffer:payload});
      await page.getByRole('button', {name:'Send files',exact:true}).click();
      await expect(page.getByTestId('send-access-dialog')).toBeVisible();
      await expect(page.getByTestId('ad-start')).toBeVisible();
      if(name==='sender-next.txt') {
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
        const bounds=await page.getByTestId('send-access-dialog').boundingBox();
        expect(bounds?.width).toBeLessThanOrEqual(320);
        await page.screenshot({path:'outputs/per-send-ad-phone.png'});
      }
      await expect(guest.getByRole('button',{name:'Accept all',exact:true})).toHaveCount(0);
      await finishTestAd(page);
      await guest.getByRole('button',{name:'Accept all',exact:true}).click();
      await expect(guest.getByTestId('send-access-dialog')).not.toBeVisible();
      await verifyDownload(guest,name,payload);
    }
    await expect(guest.getByTestId('send-access-status')).toHaveAttribute('data-credit-ready','false');
  } finally {await context.close();}
});

test('a prepared send credit survives refresh and only one is stored', async ({page,browser}) => {
  const {guest,context}=await pair(page,browser);
  const observer=await page.context().newPage();
  try {
    await observer.goto('/');
    const bytes=Buffer.from('A prepared credit is preserved until the batch succeeds.');
    await page.getByLabel('Select files to send').setInputFiles({name:'prepared.txt',mimeType:'text/plain',buffer:bytes});
    await prepareSendCredit(page);
    await expect(observer.getByTestId('send-access-status')).toHaveAttribute('data-credit-ready','true');
    await expect(page.getByTestId('prepare-send')).toBeDisabled();
    await page.reload();
    await expect(page.getByRole('heading',{name:'You’re connected.',exact:true})).toBeVisible({timeout:35_000});
    await expect(page.getByTestId('send-access-status')).toHaveAttribute('data-credit-ready','true');
    await page.getByLabel('Select files to send').setInputFiles({name:'prepared.txt',mimeType:'text/plain',buffer:bytes});
    await page.getByRole('button',{name:'Send files',exact:true}).click();
    await guest.getByRole('button',{name:'Accept all',exact:true}).click();
    await verifyDownload(guest,'prepared.txt',bytes);
    await expect(page.getByTestId('send-access-status')).toHaveAttribute('data-credit-ready','false');
    await expect(observer.getByTestId('send-access-status')).toHaveAttribute('data-credit-ready','false');
  } finally {await observer.close();await context.close();}
});

test('canceling an ad preserves the connection and rejected credit-backed batches release their credit', async ({page,browser}) => {
  const {guest,context}=await pair(page,browser);
  try {
    const bytes=Buffer.from('Only a verified delivery spends the reserved credit.');
    const select=()=>page.getByLabel('Select files to send').setInputFiles({name:'reserved.txt',mimeType:'text/plain',buffer:bytes});
    await select();
    await page.getByRole('button',{name:'Send files',exact:true}).click();
    await expect(page.getByTestId('send-access-dialog')).toBeVisible();
    await page.getByTestId('cancel-send').click();
    await expect(page.getByRole('heading',{name:'You’re connected.',exact:true})).toBeVisible();
    await expect(page.locator('.selected-file strong')).toHaveText('reserved.txt');
    await expect(guest.getByRole('button',{name:'Accept all',exact:true})).toHaveCount(0);
    await sendFiles(page);
    await guest.getByRole('button',{name:'Decline',exact:true}).click();
    await expect(page.getByTestId('send-access-status')).toHaveAttribute('data-credit-ready','true');
    await select();
    await page.getByRole('button',{name:'Send files',exact:true}).click();
    await expect(guest.getByRole('button',{name:'Accept all',exact:true})).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading',{name:'You’re connected.',exact:true})).toBeVisible({timeout:35_000});
    await expect(page.getByTestId('send-access-status')).toHaveAttribute('data-credit-ready','true');
    await select();
    await page.getByRole('button',{name:'Send files',exact:true}).click();
    await guest.getByRole('button',{name:'Accept all',exact:true}).click();
    await verifyDownload(guest,'reserved.txt',bytes);
    await expect(page.getByTestId('send-access-status')).toHaveAttribute('data-credit-ready','false');
  } finally {await context.close();}
});

test('offline successful batches are counted once; reconnect is quiet and unavailable ads preserve catch-up', async ({page,browser}) => {
  test.setTimeout(180_000);
  const {guest,context}=await pair(page,browser);
  const sendAndVerify=async(name:string, withAd=false)=>{
    const bytes=Buffer.from(`Verified offline accounting: ${name}`);
    await page.getByLabel('Select files to send').setInputFiles({name,mimeType:'text/plain',buffer:bytes});
    if(withAd) await sendFiles(page); else await page.getByRole('button',{name:'Send files',exact:true}).click();
    await guest.getByRole('button',{name:'Accept all',exact:true}).click();
    await verifyDownload(guest,name,bytes);
  };
  try {
    await page.context().setOffline(true);await context.setOffline(true);
    await sendAndVerify('offline-first.txt');
    await sendAndVerify('offline-next.txt');
    await expect(page.getByTestId('send-access-status')).toHaveAttribute('data-pending-ads','2');
    await page.context().setOffline(false);await context.setOffline(false);
    await expect(page.getByTestId('send-access-dialog')).not.toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading',{name:'You’re connected.',exact:true})).toBeVisible({timeout:35_000});
    await expect(page.getByTestId('send-access-status')).toHaveAttribute('data-pending-ads','2');
    await page.route('**/api/market/ads/start',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'No test inventory available',code:'AD_UNAVAILABLE'})}));
    const freeBytes=Buffer.from('No inventory allows this online batch without adding another count.');
    await page.getByLabel('Select files to send').setInputFiles({name:'no-inventory.txt',mimeType:'text/plain',buffer:freeBytes});
    await page.getByRole('button',{name:'Send files',exact:true}).click();
    await expect(page.getByTestId('send-access-dialog')).toHaveAttribute('data-required-ads','3');
    await page.getByTestId('ad-start').click();
    await guest.getByRole('button',{name:'Accept all',exact:true}).click();
    await verifyDownload(guest,'no-inventory.txt',freeBytes);
    await expect(page.getByTestId('send-access-status')).toHaveAttribute('data-pending-ads','2');
    await page.unroute('**/api/market/ads/start');
    const bytes=Buffer.from('All catch-up progress is completed explicitly.');
    await page.getByLabel('Select files to send').setInputFiles({name:'caught-up.txt',mimeType:'text/plain',buffer:bytes});
    await page.getByRole('button',{name:'Send files',exact:true}).click();
    await expect(page.getByTestId('send-access-dialog')).toHaveAttribute('data-required-ads','3');
    await finishTestAd(page);
    await expect(page.getByTestId('send-access-dialog')).toHaveAttribute('data-completed-ads','1');
    await page.getByTestId('cancel-send').click();
    await expect(page.getByTestId('send-access-status')).toHaveAttribute('data-pending-ads','1');
    // A new explicit send resumes the already settled catch-up progress.
    await page.getByRole('button',{name:'Send files',exact:true}).click();
    await expect(page.getByTestId('send-access-dialog')).toHaveAttribute('data-required-ads','2');
    await finishTestAd(page);await finishTestAd(page);
    await guest.getByRole('button',{name:'Accept all',exact:true}).click();
    await verifyDownload(guest,'caught-up.txt',bytes);
    await expect(page.getByTestId('send-access-status')).toHaveAttribute('data-pending-ads','0');
    await expect(guest.getByTestId('send-access-dialog')).not.toBeVisible();
    // An online inventory request exceeding eight seconds must not turn into offline debt.
    await page.route('**/api/market/ads/start',async route=>{
      await new Promise(resolve=>setTimeout(resolve,10_000));
      await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'AD_UNAVAILABLE'})}).catch(()=>{});
    });
    const timeoutBytes=Buffer.from('An ad timeout grants this batch free.');
    await page.getByLabel('Select files to send').setInputFiles({name:'ad-timeout.txt',mimeType:'text/plain',buffer:timeoutBytes});
    await page.getByRole('button',{name:'Send files',exact:true}).click();
    await page.getByTestId('ad-start').click();
    await expect(guest.getByRole('button',{name:'Accept all',exact:true})).toBeVisible({timeout:11_500});
    await guest.getByRole('button',{name:'Accept all',exact:true}).click();
    await verifyDownload(guest,'ad-timeout.txt',timeoutBytes);
    await expect(page.getByTestId('send-access-status')).toHaveAttribute('data-pending-ads','0');
    // Returning online before a started-offline file verifies must still sync that late receipt.
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.getByLabel('Bandwidth limit (Mbps)').fill('1');
    await page.getByRole('button',{name:'Done',exact:true}).click();
    await page.context().setOffline(true);await context.setOffline(true);
    const lateBytes=Buffer.alloc(512*1024,63);
    await page.getByLabel('Select files to send').setInputFiles({name:'online-before-verification.bin',mimeType:'application/octet-stream',buffer:lateBytes});
    const preparingOffline=page.waitForRequest(request=>request.url().endsWith('/api/market/sends/prepare'));
    await page.getByRole('button',{name:'Send files',exact:true}).click();
    const lateOperation=(await preparingOffline).postDataJSON().intent.operationId as string;
    await guest.getByRole('button',{name:'Accept all',exact:true}).click();
    await expect(row(guest,'online-before-verification.bin','incoming')).toHaveAttribute('data-status','transferring');
    const lateSync=page.waitForResponse(response=>response.url().endsWith('/api/market/usage/sync')&&response.request().postDataJSON()?.events?.some((event:{operationId:string})=>event.operationId===lateOperation));
    await page.context().setOffline(false);await context.setOffline(false);
    await verifyDownload(guest,'online-before-verification.bin',lateBytes);
    const syncedLate=await lateSync;expect(syncedLate.status()).toBe(200);
    expect((await syncedLate.json()).sendAccess.pendingOfflineAds).toBe(1);
    await expect(page.getByTestId('send-access-status')).toHaveAttribute('data-pending-ads','1');
  } finally {await page.context().setOffline(false);await context.setOffline(false);await context.close();}
});

test('Premium checkout opens separately and updates the sharing tab without losing selected files', async ({page,browser}) => {
  test.setTimeout(120_000);
  const {guest,context}=await pair(page,browser);
  let plans:Page|undefined;
  try {
    const url=page.url();const bytes=Buffer.from('This selection survives purchase in a separate tab.');
    await page.getByLabel('Select files to send').setInputFiles({name:'purchase-retained.txt',mimeType:'text/plain',buffer:bytes});
    await page.getByRole('button',{name:'Go ad-free',exact:true}).click();
    await expect(page.getByTestId('premium-dialog')).toContainText('Ad-free sharing');
    await expect(page.getByTestId('premium-dialog')).toContainText('Maximum speed');
    await page.screenshot({path:'outputs/per-send-premium.png'});
    const opened=page.context().waitForEvent('page');
    await page.getByTestId('premium-plans').click();plans=await opened;
    await plans.waitForLoadState();
    await demoLogin(plans,`purchase-new-tab-${Date.now()}@example.test`);
    await demoPurchase(plans);
    await expect(page.getByTestId('send-access-status')).toHaveAttribute('data-premium','true');
    expect(page.url()).toBe(url);
    await expect(page.locator('.selected-file strong')).toHaveText('purchase-retained.txt');
    await expect(page.getByRole('heading',{name:'You’re connected.',exact:true})).toBeVisible();
    await page.getByTestId('premium-dialog').getByRole('button',{name:/Close/}).click();
    await page.getByRole('button',{name:'Send files',exact:true}).click();
    await guest.getByRole('button',{name:'Accept all',exact:true}).click();
    await verifyDownload(guest,'purchase-retained.txt',bytes);
    await expect(page.getByTestId('send-access-dialog')).not.toBeVisible();
  } finally {await plans?.close();await context.close();}
});

test('Premium unlocks Maximum speed for the pair while only its free sender watches an ad', async ({page, browser}) => {
  await demoLogin(page, `paid-peer-${Date.now()}@example.test`, 'Paid laptop');
  await demoPurchase(page);
  const {guest, context} = await pair(page, browser);
  try {
    await expect(guest.locator('.market-peer-status')).toContainText('Premium');
    await expect(guest.getByTestId('ultra-fast')).toBeEnabled();
    await expect(guest.locator('.market-peer-status')).toContainText('Maximum speed');
    await guest.getByRole('button', {name:'Settings',exact:true}).click();
    await guest.getByLabel('Bandwidth limit (Mbps)').fill('12');
    await guest.getByRole('button', {name:'Done',exact:true}).click();
    await guest.getByTestId('ultra-fast').check();
    await guest.getByRole('button', {name:'Settings',exact:true}).click();
    await expect(guest.getByLabel('Bandwidth limit (Mbps)')).toHaveValue('0');
    await expect(guest.getByLabel('Keep screen awake while transferring')).toBeChecked();
    await guest.getByRole('button', {name:'Done',exact:true}).click();
    await guest.getByTestId('ultra-fast').uncheck();
    await guest.getByRole('button', {name:'Settings',exact:true}).click();
    await expect(guest.getByLabel('Bandwidth limit (Mbps)')).toHaveValue('12');
    await guest.getByRole('button', {name:'Done',exact:true}).click();
    const bytes = Buffer.from('A free installation can send to its verified paid endpoint.');
    await guest.getByLabel('Select files to send').setInputFiles({name:'paid-pair.txt',mimeType:'text/plain',buffer:bytes});
    await sendFiles(guest);
    await page.getByRole('button', {name:'Accept all',exact:true}).click();
    await verifyDownload(page,'paid-pair.txt',bytes);
  } finally {await context.close();}
});
