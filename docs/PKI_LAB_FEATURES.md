# EC PKI Playground: Features

## Everyone

- [x] Personal sign-in for every visitor
- [x] Username + password login
- [x] Role badge shown after login
- [x] One-click logout
- [x] Access changes take effect immediately
- [ ] Company single sign-on (SSO) button

## What Guests Can Do

- [x] Simplified, safe experience with internals hidden
- [x] Build a PKI topology on the drag-and-drop canvas
- [x] Pick machines from the template catalog
- [x] Draw connections between machines
- [x] Join/leave domains by dragging in and out of the circle
- [x] Stage changes and review the pending-action list
- [x] Deploy the whole plan with one button
- [x] Watch live build progress on each node
- [x] See assigned IP addresses on their machines
- [x] Tear down their own machines
- [ ] Cannot touch machines they didn't create

## What Operators Can Do

- [x] Everything guests can, plus full infrastructure detail
- [x] View system health and internals
- [x] Remove any node from the canvas
- [x] Create user accounts
- [x] Enable/disable accounts
- [x] Reset passwords
- [x] Change roles
- [x] Configure the shared deployment target
- [x] Set the guest machine address range
- [ ] Account management screen (UI)
- [ ] Self-serve signup

## The Canvas

- [x] Drag-and-drop topology builder
- [x] Visual node graph of the whole PKI setup
- [x] Live status color on every node (draft, staged, deploying, deployed, failed)
- [x] Ghosted preview of not-yet-deployed changes
- [x] Inspector panel for per-node details
- [x] IP address shown right on the node once live
- [x] Canvas locks while a deployment runs
- [x] "Drifted" flag when a live machine no longer matches its plan

## Domains

- [x] Domain shown as a circle on the canvas
- [x] Drag a machine into the circle to join a domain
- [x] Drag out to leave
- [x] Confirmation prompt before joining/leaving
- [x] Cancel reverts cleanly — no half-states
- [x] Domain membership visible at a glance

## Planning & Deploying

- [x] Stage changes before anything happens
- [x] Staged list of every pending action
- [x] Per-action status row
- [x] Remove a staged action, with warning if others depend on it
- [x] One "Deploy" button runs the whole plan
- [x] Live progress streamed onto nodes as they build
- [x] Real machines spun up automatically
- [x] Failed steps skip cleanly without breaking the rest
- [x] Elapsed time and estimated progress per step
- [x] Half-built machines stay cleanable

## EC Product Catalog

- [x] Ready-made CertSecure Linux component template (`ub-22.04-base`; service setup stubbed)
- [x] Ready-made CBOM Secure Linux component template (`ub-22.04-base`; service setup stubbed)
- [x] Ready-made CodeSign Secure Linux component template (`ub-22.04-base`; service setup stubbed)
