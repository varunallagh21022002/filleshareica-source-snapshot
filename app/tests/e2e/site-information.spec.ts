import { test, expect } from './fixtures';

test('product information follows sharing and answers questions with keyboard controls', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', {name: 'fil3shareica home', exact: true})).toBeVisible();
  const sections = page.locator('.site-information > section');
  await expect(sections).toHaveCount(3);
  await expect(sections.nth(0)).toHaveAttribute('id', 'features');
  await expect(sections.nth(1)).toHaveAttribute('id', 'how-it-works');
  await expect(sections.nth(2)).toHaveAttribute('id', 'faq');
  expect(await page.locator('.site-information').evaluate(element => Boolean(element.compareDocumentPosition(document.querySelector('.site-footer')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);

  const largeFiles = page.locator('.faq-item').filter({hasText: 'How large can my files be?'});
  const summary = largeFiles.locator('summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(largeFiles).toHaveAttribute('open', '');
  await expect(largeFiles).toContainText('not yet a verified promise');
  await expect(largeFiles).toContainText('phone browsers have smaller download limits');
  await page.keyboard.press('Enter');
  await expect(largeFiles).not.toHaveAttribute('open');

  const platforms = page.locator('.faq-item').filter({hasText: 'Does it work between Android, iPhone, Mac and Windows?'});
  await platforms.locator('summary').click();
  await expect(platforms).toContainText('Saving options and large-file support differ');
  await expect(page.locator('.drop-zone')).not.toContainText(/64 MiB|100 GB/);
});

test('expanded product information remains usable at narrow phone widths', async ({ page }) => {
  for (const width of [390, 320]) {
    await page.setViewportSize({width, height: 844});
    await page.goto('/');
    const advertising = page.locator('.faq-item').filter({hasText: 'How do free and Premium sharing work?'});
    await advertising.locator('summary').click();
    await expect(advertising).toContainText('Only the sender');
    await expect(advertising).toContainText('Maximum speed');
    await expect(advertising.getByRole('link', {name: 'See plans in a separate tab'})).toHaveAttribute('target', '_blank');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow, `Horizontal overflow at ${width}px`).toBe(false);
  }
});
