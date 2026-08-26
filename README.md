# extension-studio

A Rancher extension for writing Rancher extensions. Allow you to create, edit and host on the 
rancher instance it's hosted on.


## Installing
Install it from this repository's Helm repo - add `https://codyrancher.github.io/extension-studio`
under **Apps -> Repositories**, then install **Extension Studio** from **Extensions**.

## Creating

- **Extensions -> Open the Studio -> Create.** Give it a name and a sentence about what it
  should do. There is nothing to scaffold and nothing to install first.
- The new extension is a **pod in the cluster**, not a checkout on your machine: a whole Rancher
  dashboard with your package compiled into it, reached through the apiserver's service proxy on
  Rancher's own origin. Existing work comes in the same way through **Import from GitHub**.

## Editing

- **Ask, in the Assistant tab.** The assistant edits the package in its pod and the Preview
  reloads - no build step, no reinstall. Attach a screenshot, or use the target button beside the
  URL to point at the element you mean.
- **Read what it did, in the Changes tab.** Every turn is a change set with before and after
  screenshots and the changed region outlined. Approve them, or reject back to any point.

## Deploying

- **Publish**, in the editor, builds the package in its pod and installs it into the Rancher
  you are looking at. It is a dev loop: it lives as long as the pod does and nobody else can
  reach it.
- **Publish to GitHub** puts the source in a repository of your own. Tagging a release there
  builds the Helm chart and serves it from `gh-pages`, which is how anyone else installs it.

## Building this extension

Node 24.

```bash
yarn install
yarn build-pkg extension-studio     # dist-pkg/extension-studio-<version>/
node scripts/gen-extension-seed.mjs # after editing extension-skeleton/ or base-extension/
```
