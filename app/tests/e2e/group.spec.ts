import type { Page, Browser, BrowserContext } from '@playwright/test';
import { test, expect } from './fixtures';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { sendFiles } from './market-helpers';

const fileRow = (page: Page, name: string, direction = 'incoming') => page.locator(`[data-testid="transfer-row"][data-filename="${name}"][data-direction="${direction}"]`);
const connected = (page: Page) => expect(page.getByRole('heading', {name: 'You’re connected.', exact: true})).toBeVisible({timeout: 45_000});

async function prepare(page: Page, name: string) {
  await page.addInitScript((deviceName) => localStorage.setItem('f8-settings', JSON.stringify({deviceName})), name);
}
async function guest(browser: Browser, link: string, name: string, width: number): Promise<{page: Page; context: BrowserContext}> {
  const context = await browser.newContext({acceptDownloads: true, viewport: {width, height: 900}});
  const page = await context.newPage(); await prepare(page, name); await page.goto(link);
  await expect(page.getByRole('heading', {name: 'Waiting for approval', exact: true})).toBeVisible();
  return {page, context};
}
async function send(page: Page, name: string, bytes: Buffer, recipient = 'all') {
  await page.getByTestId('recipient-select').selectOption(recipient);
  await page.getByLabel('Select files to send').setInputFiles({name, mimeType: 'application/octet-stream', buffer: bytes});
  await sendFiles(page);
}
async function download(page: Page, name: string, bytes: Buffer) {
  await expect(fileRow(page, name)).toHaveAttribute('data-status', 'ready', {timeout: 45_000});
  const pending = page.waitForEvent('download');
  await page.getByRole('button', {name: `Download ${name}`, exact: true}).click();
  const item = await pending;
  const saved = await readFile((await item.path())!);
  expect(createHash('sha256').update(saved).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
}
async function chat(page: Page, text: string, recipient = 'all') {
  await page.getByTestId('chat-recipient-select').selectOption(recipient);
  await page.getByTestId('chat-input').fill(text); await page.getByTestId('chat-send').click();
}

test('three participants exchange broadcast/private files and chat, recover refresh, leave individually, and end together', async ({page: host, browser}) => {
  test.setTimeout(240_000);
  const runtimeErrors: string[] = []; host.on('pageerror', error => runtimeErrors.push(error.message));
  await prepare(host, 'Host laptop'); await host.goto('/');
  await expect(host.getByRole('button', {name: 'Create a connection', exact: true})).toBeEnabled();
  await expect(host.getByTestId('scan-qr')).toHaveCount(0);
  await host.getByTestId('group-mode').check(); await host.getByTestId('session-name').fill('Friends');
  await host.getByRole('button', {name: 'Create a connection', exact: true}).click();
  await expect(host.getByTestId('pairing-link')).toBeVisible();
  const link = await host.getByTestId('pairing-link').inputValue(); const codePath = new URL(link).pathname;
  expect(codePath).toMatch(/^\/[a-f0-9]{6}$/); expect(link).toContain('&group=1');
  const alice = await guest(browser, link, 'Alice phone', 390);
  let bob: Awaited<ReturnType<typeof guest>> | null = null;
  try {
    alice.page.on('pageerror', error => runtimeErrors.push(error.message));
    await host.getByRole('button', {name: 'Approve Alice phone', exact: true}).click();
    await connected(alice.page); await connected(host);
    await expect(host.getByTestId('pairing-link')).toHaveValue(link);
    bob = await guest(browser, link, 'Bob tablet', 320); bob.page.on('pageerror', error => runtimeErrors.push(error.message));
    await host.getByRole('button', {name: 'Approve Bob tablet', exact: true}).click();
    for (const device of [host, alice.page, bob.page]) {
      await connected(device);
      await expect(device.getByTestId('recipient-select').locator('option')).toHaveCount(3, {timeout: 45_000});
      expect(await device.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    }
    const aliceId = await host.locator('[data-testid="member-row"][data-member-name="Alice phone"]').getAttribute('data-member-id');
    const bobId = await host.locator('[data-testid="member-row"][data-member-name="Bob tablet"]').getAttribute('data-member-id');
    const hostId = await alice.page.locator('[data-testid="member-row"][data-member-name="Host laptop"]').getAttribute('data-member-id');

    const shared = Buffer.alloc(512 * 1024, 31);
    await send(host, 'everyone.bin', shared);
    await Promise.all([alice.page.getByRole('button', {name: 'Accept all', exact: true}).click(), bob.page.getByRole('button', {name: 'Accept all', exact: true}).click()]);
    await download(alice.page, 'everyone.bin', shared); await download(bob.page, 'everyone.bin', shared);
    expect(await host.getByTestId('transfer-row').filter({hasText: 'everyone.bin'}).count()).toBe(2);

    const privateBytes = Buffer.from('Only Bob should receive this file from Alice.');
    await send(alice.page, 'private-for-bob.txt', privateBytes, bobId!);
    await bob.page.getByRole('button', {name: 'Accept all', exact: true}).click(); await download(bob.page, 'private-for-bob.txt', privateBytes);
    await expect(fileRow(host, 'private-for-bob.txt')).toHaveCount(0);
    await expect(host.getByRole('region', {name: 'Incoming file offer'})).toHaveCount(0);

    const everyoneText = 'Hello everyone <b>plain text</b>';
    await chat(host, everyoneText);
    for (const device of [alice.page, bob.page]) await expect(device.getByTestId('chat-message').filter({hasText: everyoneText})).toBeVisible();
    const secretText = 'Alice to Bob only'; await chat(alice.page, secretText, bobId!);
    await expect(bob.page.getByTestId('chat-message').filter({hasText: secretText})).toContainText('Private to you');
    await expect(host.getByTestId('chat-message').filter({hasText: secretText})).toHaveCount(0);
    await expect(bob.page.getByTestId('chat-message').locator('b')).toHaveCount(0);

    await alice.page.reload();
    for (const device of [host, alice.page, bob.page]) await expect(device.getByTestId('recipient-select').locator('option')).toHaveCount(3, {timeout: 45_000});
    expect(new URL(alice.page.url()).pathname).toBe(codePath);
    await expect(host.getByRole('button', {name: 'Approve Alice phone', exact: true})).toHaveCount(0);
    await expect(alice.page.getByTestId('chat-message')).toHaveCount(0);
    const refreshed = Buffer.from('Alice is still approved after a page refresh.');
    await send(alice.page, 'after-group-refresh.txt', refreshed, hostId!);
    await host.getByRole('button', {name: 'Accept all', exact: true}).click(); await download(host, 'after-group-refresh.txt', refreshed);

    const retained = Buffer.from('A verified received file remains available after its sender leaves.');
    await send(bob.page, 'save-after-leave.txt', retained, hostId!);
    await host.getByRole('button', {name: 'Accept all', exact: true}).click();
    await expect(fileRow(host, 'save-after-leave.txt')).toHaveAttribute('data-status', 'ready');
    await alice.page.getByTestId('chat-recipient-select').selectOption(bobId!);
    await alice.page.getByTestId('chat-input').fill('Keep this draft private when Bob leaves');
    await bob.page.getByRole('button', {name: 'Leave session', exact: true}).click();
    for (const device of [host, alice.page]) await expect(device.getByTestId('recipient-select').locator('option')).toHaveCount(2);
    await expect(alice.page.getByTestId('chat-recipient-select')).toHaveValue(bobId!);
    await expect(alice.page.getByTestId('chat-send')).toBeDisabled();
    await expect(alice.page.getByTestId('chat-input')).toHaveValue('Keep this draft private when Bob leaves');
    await expect(host.getByTestId('chat-message').filter({hasText: 'Keep this draft private when Bob leaves'})).toHaveCount(0);
    await download(host, 'save-after-leave.txt', retained);
    await chat(host, 'The remaining group stays connected', aliceId!);
    await expect(alice.page.getByTestId('chat-message').filter({hasText: 'The remaining group stays connected'})).toBeVisible();
    await host.screenshot({path: 'outputs/group-session-desktop.png', fullPage: true});
    await alice.page.screenshot({path: 'outputs/group-session-phone.png', fullPage: true});
    await host.setViewportSize({width: 320, height: 900});
    expect(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();

    await host.getByRole('button', {name: 'End session', exact: true}).click();
    await host.getByTestId('confirm-end-session').click();
    await expect(alice.page.getByText('Session ended. You can create a fresh connection.')).toBeVisible();
    await alice.page.reload(); await expect(alice.page.getByRole('button', {name: 'Create a connection', exact: true})).toBeEnabled();
    expect(await alice.page.evaluate(() => sessionStorage.getItem('f8-active-group-v1'))).toBeNull();
    expect(runtimeErrors).toEqual([]);
  } finally {await alice.context.close(); if (bob) await bob.context.close();}
});

test('a host can explicitly end a waiting session before anyone joins', async ({page}) => {
  await page.goto('/'); await page.getByRole('button', {name: 'Create a connection', exact: true}).click();
  await expect(page.getByTestId('pairing-link')).toBeVisible();
  await page.getByRole('button', {name: 'End session', exact: true}).click();
  await page.getByRole('button', {name: 'Keep sharing', exact: true}).click();
  await expect(page.getByTestId('pairing-link')).toBeVisible();
  await page.getByRole('button', {name: 'End session', exact: true}).click(); await page.getByTestId('confirm-end-session').click();
  await expect(page.getByRole('button', {name: 'Create a connection', exact: true})).toBeEnabled();
  expect(new URL(page.url()).pathname).toBe('/');
  expect(await page.evaluate(() => sessionStorage.getItem('f8-active-session-v1') === null)).toBeTruthy();
});
