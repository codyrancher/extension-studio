/**
 * Sign in to the Rancher dashboard.
 *
 * The login form's inputs carry generated ids and no name attribute, so they can only be
 * addressed by type - and "Log in with Local User" is the submit button, not a provider
 * chooser, so it is clicked after the fields are filled rather than before.
 */
export const RANCHER = process.env.RANCHER_URL || 'https://magic-closet-rancher';
export const USER = 'admin';
export const PASS = process.env.RANCHER_PASS || '';

if (!PASS) {
  // Never defaulted. The password belongs to whichever Rancher you are pointing at, and a
  // committed default is both wrong everywhere else and a credential in version control.
  console.error('Set RANCHER_PASS (and RANCHER_URL if not the default) before running this.');
  process.exit(1);
}

export async function login(page, { wait = (ms) => page.waitForTimeout(ms) } = {}) {
  await page.goto(`${ RANCHER }/dashboard/auth/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 90000 }).catch(() => null);

  if (!(await page.locator('input[type="password"]').count())) {
    return 'already signed in';
  }

  await page.locator('input[type="text"]').first().fill(USER);
  await page.locator('input[type="password"]').first().fill(PASS);
  await wait(400);
  await page.locator('button:has-text("Log in with Local User")').first().click();

  await page.waitForFunction(() => !location.pathname.includes('/auth/login'), { timeout: 90000 })
    .catch(() => null);
  await wait(6000);

  return page.url();
}
