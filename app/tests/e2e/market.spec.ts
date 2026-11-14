import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { demoLogin, demoPurchase } from './market-helpers';

const uniqueEmail = () => `market-${Date.now()}-${randomUUID().slice(0, 8)}@example.test`;
async function screenshot(page: Page, name: string) {
  await mkdir('outputs', { recursive: true });
  await page.screenshot({ path: `outputs/market-${name}.png`, fullPage: true });
}
async function paidUntil(page: Page): Promise<number> {
  const value = await page.locator('.market-expiry time').getAttribute('datetime');
  expect(value).toBeTruthy(); return Date.parse(value!);
}
async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
}

test('failed checkout, successful Premium purchase and renewal preserve authoritative account state', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const email = uniqueEmail();
  await demoLogin(page, email, 'Payment QA');
  await page.goto('/plans');
  await expect(page.getByText('LOCAL SANDBOX: payments are simulated. No money is charged.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Try sandbox checkout', exact: true }).first().click();
  await page.getByRole('button', { name: 'Simulate failure', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('No entitlement was granted and no money was charged');
  await page.goto('/account');
  await expect(page.getByRole('heading', { name: 'No active paid plan', exact: true })).toBeVisible();
  await expect(page.locator('.market-order-status.failed')).toHaveCount(1);
  await demoPurchase(page);
  const firstExpiry = await paidUntil(page);
  expect(firstExpiry).toBeGreaterThan(Date.now() + 27 * 24 * 60 * 60_000);
  await expect(page.locator('.market-order-status.paid')).toHaveCount(1);
  await expect(page.locator('.market-device')).toHaveCount(2);
  await expect(page.locator('.market-device').filter({ hasText: 'Desktop' })).toContainText('This installation');
  await demoPurchase(page);
  const renewalExpiry = await paidUntil(page);
  expect(renewalExpiry).toBeGreaterThan(firstExpiry + 27 * 24 * 60 * 60_000);
  await expect(page.locator('.market-order-status.paid')).toHaveCount(2);
  await expect(page.locator('.market-order-status.failed')).toHaveCount(1);
  await expect(page.getByRole('checkbox', { name: /I prefer relevant ads/ })).not.toBeChecked();
  await page.getByRole('checkbox', { name: /I prefer relevant ads/ }).check();
  await page.reload();
  await expect(page.getByRole('checkbox', { name: /I prefer relevant ads/ })).toBeChecked();
  await screenshot(page, 'account-desktop');
  await page.goto('/');
  await expect(page.getByTestId('send-access-status')).toHaveAttribute('data-premium','true');
  expect(errors).toEqual([]);
});

test('one desktop and one mobile slot remain separate; replacement revokes the old desktop and enforces cooldown', async ({ page: desktop, browser, baseURL }) => {
  test.setTimeout(150_000);
  const email = uniqueEmail();
  await demoLogin(desktop, email, 'Device QA'); await demoPurchase(desktop);
  const mobileContext = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' });
  const replacementContext = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
  try {
    const mobile = await mobileContext.newPage(); const replacement = await replacementContext.newPage();
    await demoLogin(mobile, email, 'Device QA'); await mobile.goto('/account');
    await expect(mobile.getByText('This installation is registered.', { exact: true })).toBeVisible();
    await expect(mobile.locator('.market-device').filter({ hasText: 'Mobile' })).toContainText('This installation');
    await expect(mobile.locator('.market-device').filter({ hasText: 'Desktop' })).not.toContainText('This installation');
    await expectNoHorizontalOverflow(mobile); await screenshot(mobile, 'account-mobile');
    await demoLogin(replacement, email, 'Device QA'); await replacement.goto('/account');
    await expect(replacement.getByRole('button', { name: 'Replace registered desktop', exact: true })).toBeVisible();
    await replacement.getByRole('button', { name: 'Replace registered desktop', exact: true }).click();
    await replacement.getByRole('button', { name: 'Confirm replacement', exact: true }).click();
    await expect(replacement.getByText('This installation is registered.', { exact: true })).toBeVisible();
    await desktop.goto('/account');
    await expect(desktop.getByRole('button', { name: 'Replace registered desktop', exact: true })).toBeVisible();
    await desktop.getByRole('button', { name: 'Replace registered desktop', exact: true }).click();
    await desktop.getByRole('button', { name: 'Confirm replacement', exact: true }).click();
    await expect(desktop.getByRole('alert')).toContainText('once every 24 hours');
    await expect(desktop.getByText('This installation is registered.', { exact: true })).toHaveCount(0);
    await replacement.reload();
    await expect(replacement.getByText('This installation is registered.', { exact: true })).toBeVisible();
    await mobile.reload();
    await expect(mobile.getByText('This installation is registered.', { exact: true })).toBeVisible();
    await expect(mobile.locator('.market-device')).toHaveCount(2);
    await screenshot(desktop, 'device-replacement-cooldown');
  } finally { await mobileContext.close(); await replacementContext.close(); }
});

test('market pages and populated account fit desktop and narrow phones without document overflow', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await demoLogin(page, uniqueEmail(), 'Responsive QA'); await demoPurchase(page, 2);
  const routes = ['/', '/login?reauth=1', '/plans', '/account', '/privacy', '/terms', '/contact', '/payment/return'];
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
    for (const route of routes) {
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      if (route === '/') await expect(page.getByTestId('send-access-status')).toHaveAttribute('data-premium','true');
      if (route === '/account') await expect(page.getByText('This installation is registered.', { exact: true })).toBeVisible();
      if (route.startsWith('/login')) await expect(page.getByLabel('Test email', { exact: true })).toBeVisible();
      if (route === '/plans') await expect(page.getByRole('button', { name: 'Try sandbox checkout', exact: true }).first()).toBeEnabled();
      await expectNoHorizontalOverflow(page);
      if (width === 390 && ['/', '/login?reauth=1', '/plans', '/account'].includes(route)) await screenshot(page, `${route === '/' ? 'sharing' : route.split(/[/?]/)[1]}-390`);
      if (width === 1440 && route === '/plans') await screenshot(page, 'plans-desktop');
    }
  }
  expect(errors).toEqual([]);
});

test('account deletion requires confirmation and removes the signed-in profile', async ({ page }) => {
  await demoLogin(page, uniqueEmail(), 'Deletion QA'); await demoPurchase(page);
  await page.getByRole('button', { name: 'Delete my account…', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Permanently delete my account', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your prepaid plan', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete my account…', exact: true }).click();
  await page.getByRole('button', { name: 'Permanently delete my account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to see your account', exact: true })).toBeVisible();
  await expect(page.getByText('Your account was deleted. Received files remain on your device.', { exact: true })).toBeVisible();
  await page.goto('/');
  await expect(page.getByTestId('send-access-status')).toHaveAttribute('data-premium','false');
});

test('a recovered paid checkout refreshes access without reopening Cashfree or asking for another payment', async ({ page }) => {
  await demoLogin(page, uniqueEmail(), 'Payment recovery QA'); await demoPurchase(page);
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('sdk.cashfree.com')) requests.push(request.url()); });
  await page.route('**/api/market/orders', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ order: { id: 'fs_recovered_paid_test', planId: 'month', amountPaise: 3000, currency: 'INR', status: 'paid', createdAt: Date.now(), paidAt: Date.now(), provider: 'cashfree' } }) });
  });
  await page.goto('/plans');
  await page.getByRole('button', { name: 'Try sandbox checkout', exact: true }).first().click();
  await expect(page.getByText('Payment confirmed', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Check your existing payment', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Simulate successful payment', exact: true })).toHaveCount(0);
  expect(requests).toEqual([]);
});

test('production PWA restores a paid lease offline with pinned issuer and signed expiry', async ({ page, context }) => {
  test.skip(process.env.MARKET_PWA_TEST !== '1', 'Run against the built production preview with MARKET_PWA_TEST=1.');
  test.setTimeout(120_000);
  await demoLogin(page, uniqueEmail(), 'Offline QA'); await demoPurchase(page, 2);
  await page.goto('/');
  await expect(page.getByTestId('send-access-status')).toHaveAttribute('data-premium','true');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBeTruthy();
  const originalPaidUntil = await page.evaluate(() => JSON.parse(localStorage.getItem('f8-market-paid-lease-v1')!).paidUntil as number);
  const storedIdentity = await page.evaluate(async () => new Promise<{ nonExtractable: boolean; trustedIssuer: boolean }>((resolve, reject) => {
    const open = indexedDB.open('f8-device-identity-v1', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const transaction = open.result.transaction('keys'); const store = transaction.objectStore('keys');
      const identity = store.get('installation'); const trust = store.get('network-market-config');
      transaction.oncomplete = () => { resolve({ nonExtractable: identity.result.privateKey.extractable === false, trustedIssuer: Boolean(trust.result?.publicKey) }); open.result.close(); };
      transaction.onerror = () => reject(transaction.error);
    };
  }));
  expect(storedIdentity).toEqual({ nonExtractable: true, trustedIssuer: true });
  await page.evaluate(() => {
    const key = 'f8-market-paid-lease-v1'; const cached = JSON.parse(localStorage.getItem(key)!);
    cached.expiresAt = Date.now() + 10 * 365 * 24 * 60 * 60_000; cached.paidUntil = cached.expiresAt;
    localStorage.setItem(key, JSON.stringify(cached));
  });
  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('send-access-status')).toHaveAttribute('data-premium','true');
    await expect(page.getByText('Verified offline lease. Reconnect within 24 hours to refresh it.', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('f8-market-paid-lease-v1')!).paidUntil)).toBe(originalPaidUntil);
    expect(await page.evaluate(async () => {
      const entries = await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname)));
      return entries.flat().some(path => path.startsWith('/api/'));
    })).toBeFalsy();
    await screenshot(page, 'paid-offline');
  } finally { await context.setOffline(false); }
});
