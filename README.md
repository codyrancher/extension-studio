# extension-studio

A Rancher extension for writing Rancher extensions. Allows you to create, edit and host on the 
rancher instance it's hosted on.


## Installing

1. **Enable extension support.** Go to **Extensions** in the cluster explorer. If this Rancher
   has not used extensions before it offers to enable them; accept, and wait for the plugin
   operator to come up.
2. **Add the repository.** **Apps -> Repositories -> Create**, target **http(s) URL**, index URL
   `https://codyrancher.github.io/extension-studio`. Give it any name.
3. **Install it.** Back on **Extensions**, under **Available**, install **Extension Studio**.
4. **Reload the page** when it asks. **Extensions** now has an **Open the Studio** button on it.

## Creating

- **Extensions -> Open the Studio -> Create.** Give it a name and say where it should appear.
  There is nothing to scaffold and nothing to install first, and it starts as a pod in the
  cluster rather than a checkout on your machine.

https://github.com/user-attachments/assets/86bd77d6-f5ec-480e-9879-3040aa34fa8e

- **Import from GitHub** brings existing work in the same way. A public repository needs no
  token, and Studio reads the repository before importing it, so you find out it is not an
  extension before it is cloned rather than after.

https://github.com/user-attachments/assets/ad3d85c2-d6e5-4de2-a41f-34aafd1ddb5e

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

## Architecture

An extension you make here never leaves the cluster, and never has to be hosted anywhere for you
to use it.

```
browser ---> Rancher ---> apiserver service proxy ---> pod (dashboard + your package)
                |                                       ^
                +-- UIPlugin (direct: true) ------------+
```

- **Each extension is a pod.** Creating one writes a Deployment, a Service and a ConfigMap of
  source into the `extension-studio` namespace. The pod runs a whole Rancher dashboard with
  your package compiled into it, on port 8005.
- **The browser reaches it through the apiserver**, at
  `/api/v1/namespaces/extension-studio/services/http:<name>:8005/proxy`. That is Rancher's own
  origin carrying the session you already have, so nothing is exposed and there is nothing extra
  to log into.
- **Editing happens inside the pod.** The assistant runs there too, so a save recompiles and hot
  reloads the Preview. There is no build step and nothing to reinstall.
- **Publish writes a UIPlugin**, in `cattle-ui-plugin-system`, marked `direct: "true"` and
  pointing at that same proxy URL. Rancher's own index picks it up and the browser loads the
  bundle straight from the pod, which is why the extension lives exactly as long as the pod does.
- **A release does not involve the pod at all.** Publish to GitHub, tag it, and the chart on
  `gh-pages` is what other people add as a repository, the same way you added this one.
