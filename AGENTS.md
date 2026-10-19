---
root: wiser-crm
---

# Wiser CRM

Wiser CRM is a CRM a member runs in their own Cloudflare account, with their staff signing in through Cloudflare Access. It is based on OpenCRM by Clawnify, released under the MIT licence, and keeps Clawnify's notice. It is not a plugin.

The chain starts here. Load this file before the first read or write under this root.

## What this root is

A fork of OpenCRM that carries upstream's full history. Upstream's files stay as upstream wrote them wherever that is possible, and what Wiser adds lives in files upstream does not have: this file and `CLAUDE.md`, the runtime library that stands in for Clawnify's platform packages under their names, the Worker entry that puts sign-in in front of the app, the build configuration, the migrations, the tests, and `.github/README.md`, each as it is added. Every upstream file this fork does change is counted, and the count stays within the limit the operator has set.

## Upstream

- The remote `clawnify` is fetch-only, and its push URL refuses. Never give it a push URL, and never open a pull request, issue or comment there: Wiser does not contact Clawnify.
- Upstream is merged into this repository, never rebased onto. A merge is approved by the operator before it is released.
- Clawnify's platform packages, the `@clawnify/` names upstream imports, carry no licence. No session opens, installs, fetches or searches one, its npm page, its tarball or a copy of it in `node_modules`. The runtime library here is written only from how upstream's MIT code calls them.

## Writes

Writes land only under this root. Never write to another root composed in the same workspace.

## Secrets

No key, token or secret in any file here, a commit, a fixture, a log or a conversation. The private half of the release signing key never enters this repository or any automated run.

## What needs a person

Every deploy, every push and tag, every release and its signature, every upstream merge that will be released, and the text of the licence and the credit.
