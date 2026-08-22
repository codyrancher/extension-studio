// A walk through the Extension Studio, recorded against the real Rancher (Prime).
//
// Navigation between screens is by URL, because in the real dashboard every screen has a
// working address and that is part of what this shows. Within a screen it points at what is
// worth looking at, and on screen 13 it actually drives the control rather than describing it.
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

  // Light theme, and a seeded build failure so screen 08 has something to draw.
  await visit('/barn/extensions', '.studio-home__table');
  await page.evaluate(() => {
    window.localStorage.setItem('theme', 'light');
    window.sessionStorage.setItem('barn.publish.failure', JSON.stringify({
      extension: 'base',
      message:   'the extension did not build',
      at:        Date.now(),
      log:       [
        '> barn@0.5.22 build-pkg',
        'Building for production as library (umd-min)...',
        '',
        'ERROR in ./pages/NodeHealth.vue',
        "Module not found: Error: Can't resolve '@shell/utils/conditions'",
        '',
        'webpack compiled with 1 error',
      ].join('\n'),
    }));
  });
  await visit('/barn/extensions', '.studio-home__table');

  // --- Recorded ------------------------------------------------------------
  startRecording();
  await pause(800);

  await say('The Extension Studio, inside Rancher Prime');
  await point('.studio-home__title-row', '01 · Studio home');
  await point(page.locator('.studio-home__row').first(), 'Every column is a live reading');

  await visit('/barn/extensions/new', '.new-ext__card');
  await say('02 · Describing a new extension');
  await point('.new-ext__prompt', 'What should it do?');
  await point(page.locator('.new-ext__options').first(), 'Placement decides the parent route');

  await visit('/barn/extensions/base/brief', '.brief__columns');
  await say('10 · The brief, agreed before any code exists');
  await point(page.locator('.brief__card').first(), 'Agreeing writes BRIEF.md into the pod');

  await visit('/barn/editor', '.mc-editor');
  await say('03 · The workspace');
  await point('.studio-masthead', 'Name, state, branch, publish');
  await point('.assistant-panel__composer', 'The composer types into the pod’s assistant');
  await point('.preview-panel__toolbar', 'The toolbar drives the framed dashboard');

  await visit('/barn/extensions/base/files', '.files__body');
  await say('05 · Files, history and where used');
  await point('.files__tree', 'The pod’s actual package tree');
  await point('.files__used', '“Where used” is a real grep of the package');

  await visit('/barn/extensions/base/review', '.review__body');
  await say('04 · Review before publishing');
  await point('.review__files', 'Per-file checkboxes decide what is kept');

  await visit('/barn/review', '.queue__list');
  await say('11 · The review queue');
  await point(page.locator('.queue__card').first(), 'Rows lead with intent, from the brief');

  await visit('/barn/review/base/working', '.rc__body');
  await say('12 · Intent, diff and rendered result together');
  await point('.rc__packet', 'The packet: what the change is for');
  await point('.rc__visual', 'And the extension actually running');

  // 13 gets driven, not just shown - the verdict control is the most reworked thing here.
  await visit('/barn/extensions/base/verification', '.verify__body');
  await say('13 · Does it actually do the job?');
  await point('.verify__list', 'The brief’s own criteria, read back');

  await say('Four states, and each one is recorded');
  await click(page.locator('.verify__criterion').nth(0).locator('button', { hasText: 'Yes' }));
  await pause(700);
  await click(page.locator('.verify__criterion').nth(1).locator('button', { hasText: 'No' }));
  await pause(700);
  await click(page.locator('.verify__criterion').nth(2).locator('button', { hasText: "Can't tell" }));
  await pause(900);
  await point('.verify__signoff', 'The sign-off counts all four separately');

  await visit('/barn/extensions/base/build-failed', '.failed__body');
  await say('08 · A build that failed, with a way back');
  await point('.failed__ways', 'Three routes out, all of them real');

  // --- Dark ----------------------------------------------------------------
  await say('And all of it follows Rancher’s theme');
  await page.evaluate(() => {
    window.localStorage.setItem('theme', 'dark');
    document.body.classList.remove('theme-light');
    document.body.classList.add('theme-dark');
  });
  await pause(1200);

  await visit('/barn/extensions/base/verification', '.verify__body');
  await page.evaluate(() => {
    document.body.classList.remove('theme-light');
    document.body.classList.add('theme-dark');
  });
  await pause(1500);
  await point('.verify__list', 'Dark theme, same screen');

  await visit('/barn/review/base/working', '.rc__body');
  await page.evaluate(() => {
    document.body.classList.remove('theme-light');
    document.body.classList.add('theme-dark');
  });
  await pause(1800);

  await pause(1200);
}
