import { expect, test } from './test';

test('public URL survives a fragment-free redirect and reload @gate', async ({ page }) => {
  // Model Continue sending the original request URL, without any fragment.
  await page.route('**/warning-continue', (route) => route.fulfill({
    status: 302, headers: { location: '/p/shared-diagram' }, body: '',
  }));
  await page.goto('/warning-continue');
  await expect(page).toHaveURL(/\/p\/shared-diagram$/);
  // This suite uses browser-only storage: reaching the public-page state proves
  // the URL was routed to the viewer rather than a new owner document.
  await expect(page.getByTestId('v2-public-state')).toContainText('Public links are not set up on this site.');
  await page.reload();
  await expect(page.getByTestId('v2-public-state')).toBeVisible();
  await expect(page).toHaveURL(/\/p\/shared-diagram$/);
  await page.goto('/#/p/shared-diagram');
  await expect(page.getByTestId('v2-public-state')).toBeVisible();
});
