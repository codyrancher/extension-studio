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
  There is nothing to scaffold and nothing to install first. It is made in front of you - every
  object listed as it goes - and it starts as a pod in the cluster rather than a checkout on
  your machine.

https://github.com/user-attachments/assets/7d7fcd8e-5247-44d1-87dc-55504227c8f4

- **Import from GitHub** brings existing work in the same way. Search the repositories you can
  reach and pick one; Studio reads it before importing, so you find out it is not an extension
  before it is cloned rather than after. A public repository needs no token at all.

https://github.com/user-attachments/assets/5d4ffff3-4070-47df-8fe8-239dba4bdfab

## Editing

- **Ask, in the Assistant tab.** The assistant edits the package in its pod and the preview
  reloads - no build step, no reinstall. While a turn runs, its card carries the assistant's own
  screen, so what it is doing is on the page rather than behind a spinner.

https://github.com/user-attachments/assets/365ff965-25be-4c25-bfee-e7197147cf55

- **Point at what you mean.** Which extension, which cluster and which page the preview is on
  are attached to every message already. The target button beside the URL turns the preview into
  an element picker, and whatever you click becomes another chip - so "this heading" is a thing
  you can say, and the thing you pointed at is the thing that changes.

https://github.com/user-attachments/assets/15d00f52-ada1-40de-8aa2-82c330eddc5a

- **Read what it did, in the Changes tab.** Every turn is a change set with before and after
  screenshots and the changed region outlined. Approve them, or reject back to any point.

## Deploying

- **Publish** builds the package in its pod and loads it into the Rancher you are looking at.
  Nothing is installed by hand: the page is not there, you publish, you reload, and it is.
  Everybody signed in here gets it on their next page load, and it lasts as long as the pod does.

https://github.com/user-attachments/assets/f4d0cffb-a4c7-4b02-98d8-a7061c1b7de8

- **Push the source to GitHub** hands the change over instead: it assembles the work as a
  numbered packet, puts it in the review queue, and pushes it as a branch with a pull request
  against the default branch. Nothing is merged, so closing that pull request is the way back.

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
