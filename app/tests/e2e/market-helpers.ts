import { expect, type Page } from '@playwright/test';

/** Complete a deliberately labelled local ad; no real inventory is requested. */
export async function finishTestAd(page: Page) {
  await expect(page.getByTestId('send-access-dialog')).toBeVisible();
  await page.getByTestId('ad-start').click();
  await expect(page.getByTestId('ad-complete')).toBeEnabled({timeout: 12_000});
  await page.getByTestId('ad-complete').click();
}
export async function sendFiles(page: Page) {
  await page.getByRole('button', {name: 'Send files', exact: true}).click();
  await finishTestAd(page);
  await expect(page.getByTestId('send-access-dialog')).not.toBeVisible();
}
export async function prepareSendCredit(page: Page) {
  await page.getByTestId('prepare-send').click();
  await finishTestAd(page);
  await expect(page.getByTestId('send-access-dialog')).not.toBeVisible();
  await expect(page.getByTestId('send-access-status')).toHaveAttribute('data-credit-ready', 'true');
}

export async function demoLogin(page: Page, email: string, name = 'Local QA') {
  await page.goto('/login');
  await page.getByLabel('Name', {exact: true}).fill(name);
  await page.getByLabel('Test email', {exact: true}).fill(email);
  await page.getByRole('button', {name: 'Continue with local test account', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'You’re signed in.', exact: true})).toBeVisible();
}

export async function demoPurchase(page: Page, index = 0) {
  await page.goto('/plans');
  await page.getByRole('button', {name: 'Try sandbox checkout', exact: true}).nth(index).click();
  await page.getByRole('button', {name: 'Simulate successful payment', exact: true}).click();
  await expect(page.getByText('Test purchase confirmed', {exact: true})).toBeVisible();
  await page.goto('/account');
  await expect(page.getByRole('heading', {name: 'Your prepaid plan', exact: true})).toBeVisible();
  const register = page.getByRole('button', {name: /Register this (desktop|mobile)/});
  if (await register.isVisible()) await register.click();
  await expect(page.getByText('This installation is registered.', {exact: true})).toBeVisible();
}
