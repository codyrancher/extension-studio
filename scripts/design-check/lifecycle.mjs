// The whole journey, recorded: describe an extension, agree its brief, watch a change land,
// review it, publish it.
//
// Two things are genuinely slow and are shown rather than hidden. A brand-new pod installs and
// compiles before it can serve, and publishing runs a production build inside that pod. The
// pod for this run is warmed in setup (before recording) so the video does not open on five
// minutes of a spinner; the publish is left to run on camera, because its progress strip is
// worth seeing and faking it would misrepresent what publishing costs.
import { execFileSync } from 'node:child_process';

const NAME = 'nodehealth';
const R = 'https://magic-closet-rancher/dashboard';
const kc = { env: { ...process.env, KUBECONFIG: '/workspace/.kube/config' } };

const podName = () => execFileSync('kubectl',
  ['-n', 'barn', 'get', 'pods', '-l', `app=barn-${ NAME }-extension`,
    '-o', 'jsonpath={.items[0].metadata.name}'], kc).toString().trim();

const inPod = (script) => execFileSync('kubectl',
  ['-n', 'barn', 'exec', podName(), '--', 'su', '-s', '/bin/bash', '-c',
    `cd "$(ls -d /app/pkg/*/ | head -1)" && ${ script }`, 'node'], kc).toString();

export default async function ({
  page, startRecording, click, type, waitFor, settle, say, point, pause,
}) {
  // --- Setup (not recorded) -------------------------------------------------
  await page.goto(`${ R }/auth/login`, { waitUntil: 'domcontentloaded' });
  await waitFor('input[type="password"], .side-nav', { timeout: 90000 }).catch(() => {});

  if (await page.locator('input[type="password"]').count()) {
    await page.locator('input[type="text"]').first().fill('admin');
    await page.locator('input[type="password"]').first().fill(process.env.RANCHER_PASS || '');
    await page.locator('button:has-text("Log in with Local User")').first().click();
    await page.waitForTimeoutStill(12000);
  }

  await page.goto(`${ R }/barn/extensions`, { waitUntil: 'domcontentloaded' });
  await waitFor('.studio-home__table', { timeout: 45000 });
  await page.evaluate(() => window.localStorage.setItem('theme', 'light'));

  // Put the tree back to a clean state so the change we make on camera is the only one.
  //
  // This restores tracked files from the index, so anything a fixture wrote and did not commit
  // is undone here. Set fixtures up *before* this line or commit them; doing it after cost one
  // recording that published under the wrong name.
  try {
    inPod('git checkout -- . 2>/dev/null ; git clean -fd -e node_modules 2>/dev/null ; true');
  } catch { /* the pod may not exist yet on a first run; the flow creates it */ }

  await page.goto(`${ R }/barn/extensions`, { waitUntil: 'domcontentloaded' });
  await waitFor('.studio-home__table', { timeout: 45000 });
  await settle();

  // --- Recorded -------------------------------------------------------------
  startRecording();
  await pause(800);

  await say('Start from the list of extensions in this cluster');
  await click('button:has-text("New extension")');
  await waitFor('.new-ext__card', { timeout: 45000 });
  await settle();

  await say('Describe it in your own words');
  await type('.new-ext__prompt-input',
    'Add a tab to the cluster page showing how node conditions trended over the last 24 hours.');
  await pause(600);

  await say('And say what someone cannot do today');
  await type('.new-ext__box-input',
    'Mid-incident they cannot tell a spike apart from a slow degradation.');
  await pause(500);

  await point(page.locator('.new-ext__options').first(), 'Placement decides the parent route');
  await pause(400);

  // The name drives which pod this becomes; set it explicitly.
  const nameField = page.locator('.s-field__input').first();

  await nameField.fill('');
  await type(nameField, NAME);
  await pause(600);

  await say('Drafting the brief creates the extension');
  await click('button:has-text("Draft the brief")');
  await waitFor('.brief__columns', { timeout: 90000 });
  await settle();

  await say('The brief is agreed before any code exists');
  await type('.s-field__input >> nth=0',
    'An operator cannot see how node conditions moved during an incident.');
  await pause(500);
  await point(page.locator('.brief__card').nth(2), 'These become the reviewer’s checklist');

  await click('button:has-text("Agree and start building")');
  await waitFor('.mc-editor', { timeout: 90000 });
  await settle();
  await say('Agreeing writes BRIEF.md into the pod and opens the workspace');

  // --- A change lands, for real ---------------------------------------------
  await say('Now a change arrives in the extension');
  inPod(`mkdir -p pages && cat > pages/NodeHealth.vue <<'EOF'
<script>
export default { name: 'NodeHealth' };
</script>

<template>
  <div class="node-health">
    <h1>Node health</h1>
    <p>How node conditions have trended over the last 24 hours.</p>
  </div>
</template>
EOF
chown 1000:1000 pages/NodeHealth.vue 2>/dev/null || true`);
  await pause(1200);

  await say('The workspace notices it');
  await click('.s-tab:has-text("Changes")');
  await waitFor('.working-changes', { timeout: 45000 }).catch(() => {});
  await settle();
  await pause(1500);

  // --- Review ----------------------------------------------------------------
  await page.goto(`${ R }/barn/extensions/${ NAME }/review`, { waitUntil: 'domcontentloaded' });
  await waitFor('.review__body', { timeout: 45000 });
  await settle();
  await say('Review it before anything is published');
  await point('.review__files', 'What changed, and what will be kept');
  await pause(900);

  // --- Publish ----------------------------------------------------------------
  await page.goto(`${ R }/barn/editor/${ NAME }`, { waitUntil: 'domcontentloaded' });
  await waitFor('.mc-editor', { timeout: 45000 });
  await settle();

  await say('Publishing builds the extension inside the pod');
  await click('[data-testid="barn-publish-button"]');

  await waitFor('.publish-status__running', { timeout: 45000 }).catch(() => {});
  await point('.publish-status', 'A real production build — this takes minutes');

  // Sit on the progress strip until it finishes. Long, and honest about why.
  await page.waitForSelector('.publish-status__done', { timeout: 600000 })
    .then(async () => {
      await say('Installed into this Rancher');
      await point('.publish-status__done', 'The extension is live');
    })
    .catch(async () => {
      await say('Still building when this recording ended');
    });

  await pause(1500);
}
