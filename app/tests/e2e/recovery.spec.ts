import {test, expect} from './fixtures';
import {sendFiles} from './market-helpers';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

test('a broken data channel resumes the same Send without refreshing or watching another ad', async ({page, browser}) => {
  test.setTimeout(150_000);
  await page.addInitScript(() => {
    const original = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function(label, options) {
      const channel = original.call(this, label, options);
      if (label === 'f8-data') (window as Window & {qaDataChannel?: RTCDataChannel}).qaDataChannel = channel;
      return channel;
    };
  });
  const context = await browser.newContext({acceptDownloads: true});
  const receiver = await context.newPage();
  try {
    await page.goto('/');
    await expect(page.getByRole('button', {name: 'Create a connection', exact: true})).toBeEnabled();
    await page.getByRole('button', {name: 'Create a connection', exact: true}).click();
    await expect(page.getByTestId('pairing-link')).toBeVisible();
    await receiver.goto(await page.getByTestId('pairing-link').inputValue());
    await expect(receiver.getByRole('heading', {name: 'Waiting for approval', exact: true})).toBeVisible();
    await page.getByRole('button', {name: 'Approve device', exact: true}).click();
    await expect(page.getByRole('heading', {name: 'You’re connected.', exact: true})).toBeVisible({timeout: 35_000});
    await expect(receiver.getByRole('heading', {name: 'You’re connected.', exact: true})).toBeVisible({timeout: 35_000});
    await page.getByRole('button', {name: 'Settings', exact: true}).click();
    await page.getByLabel('Bandwidth limit (Mbps)').fill('2');
    await page.getByRole('button', {name: 'Done', exact: true}).click();
    const bytes = Buffer.alloc(6 * 1024 ** 2);
    for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 31 + 17) % 256;
    await page.getByLabel('Select files to send').setInputFiles({name: 'recovered.bin', mimeType: 'application/octet-stream', buffer: bytes});
    await sendFiles(page);
    await receiver.getByRole('button', {name: 'Accept all', exact: true}).click();
    const incoming = receiver.locator('[data-testid="transfer-row"][data-filename="recovered.bin"][data-direction="incoming"]');
    const progress = incoming.getByRole('progressbar');
    await expect.poll(async () => Number(await progress.getAttribute('aria-valuenow'))).toBeGreaterThan(5);
    await page.evaluate(() => {
      const channel = (window as Window & {qaDataChannel?: RTCDataChannel}).qaDataChannel;
      if (!channel || channel.readyState !== 'open') throw new Error('No open real data channel to interrupt.');
      channel.close();
    });
    await expect(incoming).toHaveAttribute('data-status', 'ready', {timeout: 90_000});
    await expect(page.getByTestId('send-access-dialog')).not.toBeVisible();
    await expect(page.locator('[data-testid="transfer-row"][data-filename="recovered.bin"][data-direction="outgoing"]')).toHaveCount(1);
    const waiting = receiver.waitForEvent('download');
    await receiver.getByRole('button', {name: 'Download recovered.bin', exact: true}).click();
    const download = await waiting;
    const saved = await readFile((await download.path())!);
    const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
    expect(digest(saved)).toBe(digest(bytes));
  } finally {await context.close();}
});
