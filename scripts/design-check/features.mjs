// The controls that used to fire a "not yet" toast, doing real work.
//
// Every one of these was a placeholder an hour ago. The point of the recording is that each
// now has an effect you can see: a menu that opens somewhere, a sort that reorders, a diff
// that appears, a mark that lands on another screen.
export default async function ({
  page, startRecording, click, waitFor, settle, say, point, pause,
}) {
  const R = 'https://magic-closet-rancher/dashboard';

  const visit = async (route, sel) => {
    await page.goto(`${ R }${ route }`, { waitUntil: 'domcontentloaded' });
    await waitFor(sel, { timeout: 45000 }).catch(() => {});
    await settle();
  };

  // --- Setup (not recorded) ------------------------------------------------
  await page.goto(`${ R }/auth/login`, { waitUntil: 'domcontentloaded' });
  await waitFor('input[type="password"], .side-nav', { timeout: 90000 }).catch(() => {});

  if (await page.locator('input[type="password"]').count()) {
    await page.locator('input[type="text"]').first().fill('admin');
    await page.locator('input[type="password"]').first().fill(process.env.RANCHER_PASS || '');
    await page.locator('button:has-text("Log in with Local User")').first().click();
    await page.waitForTimeoutStill(12000);
  }

  await visit('/barn/extensions', '.studio-home__table');
  await page.evaluate(() => window.localStorage.setItem('theme', 'light'));
  await visit('/barn/extensions', '.studio-home__table');

  // --- Recorded ------------------------------------------------------------
  startRecording();
  await pause(700);

  await say('Every control here fired a “not yet” toast an hour ago');

  // 1. Sorting, on the reading rather than the string.
  await say('The columns sort — on the value, not the rendered text');
  await click(page.locator('.studio-home__th', { hasText: 'Last change' }));
  await pause(1100);
  await click(page.locator('.studio-home__th', { hasText: 'Last change' }));
  await pause(1100);
  await point(page.locator('.studio-home__th', { hasText: 'Last change' }), 'Sorted by real timestamps');

  // 2. The row menu.
  await say('Each row has a menu of things that exist');
  await click(page.locator('.studio-home__row .s-menu__trigger').first());
  await pause(1600);
  await page.keyboard.press('Escape');
  await pause(500);

  // 3. Files: overflow and a commit's diff.
  await visit('/barn/extensions/base/files', '.files__body');
  await say('Files has an overflow menu, and its history opens');
  await click('.files__masthead .s-menu__trigger');
  await pause(1500);
  await page.keyboard.press('Escape');
  await pause(400);

  await click(page.locator('.files__commit').first());
  await waitFor('.diff', { timeout: 30000 }).catch(() => {});
  await settle();
  await point('.files__panel-head--wide', 'That commit’s diff, with a way back');
  await pause(900);

  // 4. The workspace: snapshots, undo, phase, overflow.
  await visit('/barn/editor', '.mc-editor');
  await say('The workspace masthead: snapshots are real commits');
  await click('[data-testid="barn-snapshots-menu"]');
  await pause(1700);
  await page.keyboard.press('Escape');
  await pause(400);

  await point('[data-testid="barn-phase-chip"]', 'The phase chip reports actual state');
  await pause(600);

  await say('And the overflow goes where it says');
  await click('[data-testid="barn-masthead-overflow"]');
  await pause(1700);
  await page.keyboard.press('Escape');
  await pause(500);

  // 5. Context chips are named in the message the assistant receives.
  await say('Context is real — the paths are named in what the assistant gets');
  await point('[data-testid="barn-add-context"]', 'Add picks from the pod’s own files');
  await pause(500);
  await point('[data-testid="barn-permission-chip"]', 'And this one now tells the truth');
  await pause(800);

  // 6. The queue: sort menu and the deferral.
  await visit('/barn/review', '.queue__list');
  await say('The review queue sorts for real');
  await click('.queue__sort .s-menu__trigger');
  await pause(1700);
  await page.keyboard.press('Escape');
  await pause(500);

  // 7. Defer, and see the mark land.
  await visit('/barn/review/base/working', '.rc__body');
  await say('“Come back to it” records a deferral');
  await click(page.locator('button', { hasText: 'Come back to it' }));
  await waitFor('.queue__list', { timeout: 45000 }).catch(() => {});
  await settle();
  await pause(1200);
  await point(page.locator('.queue__card').first(), 'Marked deferred, on the queue');

  await pause(1400);
}
