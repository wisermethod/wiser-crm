# Upgrading an install

Each section says what an upgrade to that release needs beyond the Cloudflare
connector's upgrade order (`CONNECTOR.md`, "On an upgrade"), which every
upgrade follows: record the running version, stop writes, take a restore
point, migrate and deploy, and roll back on failure.

## 0.3.0 to 0.3.1

The CRM and intake use the same install variables and migrations as 0.3.0.
Follow the connector's upgrade order.

## 0.2.0 to 0.3.0

0.3.0 adds people and roles. The CRM keeps its own People list, and every
request is checked against it. A person with no role sees a waiting page and
nothing of the CRM. The first owner, named by the new `OWNER_EMAIL` setting, is
always an owner, cannot be demoted or removed inside the CRM, and gets in at
once after the upgrade.

### Before the upgrade

1. Choose the first owner: one email address in the form
   [Install variables](FORMAT.md#install-variables) gives for `OWNER_EMAIL`.
   It is the address that person signs in to Cloudflare Access with.
2. Find the CRM's own sign-in list, as Wiser's App People skill does: the one
   Access application for the CRM's hostname (`zones.list_access_apps`), then
   `access.get_app`, whose `policies` must hold exactly one `allow` entry. Stop
   the upgrade if it holds none or more than one. Read that policy with
   `cloudflare.access.list_staff` and check that the first owner's address is
   on it. If it is not, admit it first with `access.set_staff` (App People does
   this) and read the same policy again. Otherwise nobody can manage people
   after the upgrade.
3. Tell everyone else on that list what they will see: after the upgrade,
   "You're signed in, but not set up yet" until the owner gives them a role.

`OWNER_EMAIL` cannot be set on a 0.2.0 install ahead of the upgrade, because
0.2.0's release does not declare it. Give it in the 0.3.0 deploy.

### The upgrade

Follow the connector's order with release `0.3.0` and these inputs:

- The CRM's variables are 0.3.0's set: the five 0.2.0 required, `OWNER_EMAIL`
  now required too, and the optional `BRAND_NAME` and `BRAND_ACCENT`.
  `workers.deploy_worker_release` refuses a 0.3.0 deploy without
  `OWNER_EMAIL`, or with a value that is not one plain email address, before
  any write.
- The CRM's database gains `0002_people.sql`: the People table, and two
  one-time fills the app used to run on its first reads (each deal's company
  from its contact, and each company's customer-since date from its first won
  deal), each skipped where the app had already run it.
- Intake's required variables and its one migration are unchanged from 0.2.0.
  0.3.0 adds the optional `NOTICE_FROM_NAME`, the sender name on intake's
  notices. Leave it out to keep the default, "Wiser CRM".

While the upgrade keeps writes stopped, the CRM stores nothing about people. A
person who opens it then sees the waiting page but is not listed, and **Add
person** and every role change are refused.

### After the upgrade

Once the upgrade has cleared `WISER_READ_ONLY`:

4. Ask Wiser to compare the People list with Cloudflare's sign-in list (the
   App People skill). It names everyone admitted at Cloudflare with no role,
   whether or not they have opened the CRM since, and every role held by
   someone Cloudflare no longer admits.
5. The first owner opens the CRM and chooses **People**. Each person listed
   under **Waiting for a role** gets a role: **Owner**, **Member** or
   **Viewer**. Anyone else step 4 named who should have access is added with
   **Add person** and given a role there.

If the upgrade fails, the connector's order restores the database to the
restore point, which has no People table, and returns the CRM to 0.2.0's
original version, which admits everyone on the sign-in list, as before.
