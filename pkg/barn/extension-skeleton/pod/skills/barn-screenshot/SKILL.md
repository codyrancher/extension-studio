---
name: barn-screenshot
description: Screenshot this extension's own dashboard from inside the pod, with a labelled header bar, red highlights around what changed, and an optional side-by-side Before/After. Use when a change should be shown rather than described - a change set's evidence, a reproduction, or an answer to "what does it look like now".
---

Take a picture of the thing you just changed, from the pod it is running in.

## When to use

- A change set wants evidence: what the page looked like before, and after.
- Somebody asks what a change looks like, and describing it is worse than showing it.
- A layout or a colour is the subject, where prose is guesswork.

## The one command

```bash
node ~/.claude/skills/barn-screenshot/screenshot.mjs \
  --path /$EXTENSION_NAME/c/local/home \
  --title "Node condition trends" \
  --note ".chart-legend=new legend" \
  --output /app/.shots/after.png
```

Before and after, side by side, in one image:

```bash
node ~/.claude/skills/barn-screenshot/screenshot.mjs \
  --compare \
  --before-path /$EXTENSION_NAME/c/local/home \
  --after-path  /$EXTENSION_NAME/c/local/home \
  --before-label "installed 0.1.0" \
  --after-label  "working tree" \
  --output /app/.shots/change.png
```

`--compare` renders both captures into one page and shoots that, so the two
panels line up and share a scale. There is no image library in this pod and none
is needed.

## What it does for you

- **Finds the browser.** One Chromium serves every extension in this namespace.
  Its Service name is `$BARN_BROWSER_SERVICE` and its port `$BARN_BROWSER_CDP_PORT`,
  and the name has to be resolved to a ClusterIP first: Chromium answers a
  debugging request whose `Host` is not an IP with a 403. The script does that
  resolution itself.
- **Points at the right dashboard.** `--path` is appended to
  `https://$NODE_IP$DEV_PROXY_PATH`, which is this extension's own dev server
  seen from outside the page. Never write a hostname yourself.
- **Logs in, if it can.** A fresh browser profile has no Rancher session and
  lands on the login page. Pass `--token` (a Rancher bearer token) and the
  script sets the `R_SESS` cookie before navigating. Without one it captures
  whatever the browser already has, which after one manual login is the
  session you want.
- **Waits for the page rather than the clock.** `--wait-for SELECTOR` is the
  honest wait. A dev server recompiles for seconds after a save, so shoot the
  element that means the change has arrived, not a timeout.

## Reading the result

The header bar carries the title, the URL, and the time. Highlights are drawn
in the page before capture, so they are part of the picture rather than an
overlay somebody has to trust.

`--note SELECTOR=TEXT` is the one to reach for: it outlines the element *and*
labels it, which is the difference between a picture that shows a change and
one that merely contains it.

## What it will not do

- **It will not outline the page.** A highlight names a place, and a selector
  that matches the page root, or half of everything on it, names no place. Marks
  covering more than 60% of the viewport are dropped, a match that contains
  another match gives way to the one inside it, and at most six survive -
  smallest first. Ask for something narrower and it is drawn; ask for the page
  and the picture comes back with the header bar and nothing else.
- **It will not invent a Before.** `--compare` needs two paths that both render.
  The unchanged rendering of this extension is whatever is installed in this
  Rancher; if nothing is installed there is no Before, and a picture captioned
  "before" that is really a second copy of "after" is worse than one panel.
- **It will not wait out a broken build.** If the page never renders the
  selector, the script fails and says so rather than shooting a spinner.
