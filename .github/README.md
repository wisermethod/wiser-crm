# Wiser CRM

A CRM you run in your own Cloudflare account, with your staff signing in
through Cloudflare Access and Wiser's agent working beside them.

Wiser CRM is based on [OpenCRM](https://github.com/clawnify/OpenCRM) by
Clawnify, released under the MIT License. Thank you to Clawnify for building
it in the open.

Company logos in the CRM's screens are fetched from Google's favicon service,
which receives each company's web domain.

## People and roles

- An **Owner** can view and change CRM records and manage people and their roles.
- A **Member** can view and change CRM records and view the People list.
- A **Viewer** can view CRM records and the People list.

The install's `OWNER_EMAIL` sets the first owner. Ask Wiser to change that
address. Removing or demoting the first owner requires changing that install
setting.

To add a person, ask Wiser to admit their email address to Cloudflare Access.
On the CRM's People screen, an owner chooses **Add person** and gives that
address a role. If the person has already signed in, assign their role under
**Waiting for a role**. To revoke their CRM access immediately, choose **Remove**
beside their email and confirm. Their Cloudflare sign-in stays active until
Wiser removes that access.

Cloudflare sign-in is handled outside the CRM. Viewers still see controls for
changing records. The CRM shows a message when it refuses the action. Members
change records and see no controls on the People screen. An owner changes
other people there and not their own row: another owner does that. If mailbox or meeting sync is ever switched on, the **Customers**
and **Open deals** screens do not load for viewers.
