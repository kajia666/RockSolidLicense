# Project Roadmap, Overall Plan, and Development Progress

Updated: 2026-04-27

This document is the rolling project control sheet for RockSolidLicense. It answers three recurring questions:

- What should we do next?
- What is the overall project plan?
- How far are we from an initial production launch?

The current launch target is not "all imaginable features are finished". The target is:

- can go online
- can authorize users
- can deliver to software authors
- can operate the first launch wave

## Current Position

The project is now close to an initial pilot launch. The most important backend/API launch chain is already in place:

- Software-author delivery: SDK package, integration package, release package, launch workflow, launch review, launch smoke, launch mainline.
- Authorization operations: accounts, entitlements, sessions, device bindings, device blocks, cards, policies, audit logs, scoped developer operations.
- First-launch operations: launch bootstrap, first batch setup, inventory refill, first-launch handoff, launch receipt follow-ups, initial launch ops readiness.
- Production readiness: production gate, cutover handoff, recovery drill handoff, operations handoff, post-launch sweep handoff, closeout handoff, stabilization handoff.
- Launch control plane: `/api/developer/launch-mainline`, `/developer/launch-mainline`, route focus, action receipts, recommended downloads, stage gates, checksums, zip exports.
- Launch smoke handoff continuity: the CLI `launch:smoke` first-wave handoff now lands in Launch Review and Developer Ops with `source=launch-smoke` / `handoff=first-wave` preserved in route-focus UI, payload filters, exported summaries, and follow-up workspace links.
- Recommended download routing: Release Package and Launch Workflow text handoffs, Launch Workflow local zip/summary/checklist downloads, Launch Workflow integration env/host-config/host-skeleton download format routing, Launch Workflow handoff zip/checksum downloads, Launch Workflow checklist/action-plan handoff zip format consistency, Launch Review route focus/action/focus-target text, Launch Review scoped Workflow summary/checklist downloads, Launch Smoke route focus/action text, Launch Smoke action-plan scoped Smoke Kit downloads, Launch Mainline route focus/continuation/recommended-download text, First Launch Handoff text, Post-Launch Lifecycle text, Launch Workflow, Release follow-ups, Developer Projects follow-up downloads, Developer License quickstart follow-ups, Developer Ops route-review handoffs, Developer Ops Launch Mainline handoff summary text, shared Initial Launch Ops Gate blocker text, launch receipt follow-up queue downloads/CSV export and Developer Ops follow-up overview text, First Wave Recommendations first-round ops actions, initial-launch traceability next-follow-up downloads, Developer Ops summary/readiness/stabilization traceability text, Developer Ops readiness blocker/action text, Developer Ops operator action manifest text, Launch Mainline post-launch handoff traceability/lifecycle primary-download text, Launch Mainline action receipt handoff text, Launch Mainline zip/checksum handoff download routes, and Developer Ops operator/stabilization follow-ups now consume service-provided download `href` values for recommended downloads, so the first-wave handoff chain no longer relies on frontend source/format guessing in those launch-critical entrypoints.
- Latest backend/API slice: First-Wave Recommendations, Launch Review, and Launch Smoke Kit now pass the selected channel into their internal Developer Ops snapshots; stable and beta launch-duty views no longer silently fall back to the wrong lane when reading latest launch receipts. Post-launch lifecycle receipts and stabilization handoff confirmations now also preserve primary handoff download hrefs through Ops snapshots, Launch Mainline traceability, the post-launch handoff index, and the handoff route map.
- Latest Ops export slice: Developer Ops route-review primary, next, remaining, section, and continuation downloads now include service-generated `href` values directly in the snapshot payload; Ops export/download routes preserve non-default channel scope; route-review section downloads now return section-specific handoff files instead of falling back to the generic summary; Ops export zip/checksum packages now include the route-review handoff files for offline launch-duty review.

Estimated initial pilot-launch readiness: 88%-90%.

This estimate means the core flow is mostly ready for a controlled first launch, but still needs a final verification pass, deployment rehearsal, and real first-wave operating data before being treated as production-stable.

## Immediate Next Plan

Work should continue in short backend/API-first slices. Each slice should end with a commit, targeted verification, and a note about the next slice.

1. Finish a final spot audit for any non-critical or older launch-adjacent download surfaces outside the now-hardened Release, Launch Workflow, Launch Review, Launch Smoke, Launch Mainline, Developer Projects, Developer License, Developer Ops first-wave chain, and First Wave Recommendations chain.
   The main launch-critical route/download handoffs, Release Package/Launch Workflow/Launch Review/Launch Smoke/Launch Mainline text handoffs, Launch Workflow local zip/summary/checklist downloads, Launch Workflow integration env/host-config/host-skeleton downloads, Launch Workflow handoff zip/checksum downloads and checklist/action-plan handoff zip entries, Launch Review scoped Workflow summary/checklist downloads, Launch Smoke action-plan scoped Smoke Kit downloads, Launch Mainline Developer Ops route-review primary/remaining downloads, Developer Ops route-review snapshot/section downloads and offline zip/checksum entries, First Launch Handoff text, Post-Launch Lifecycle text, receipt follow-up queue downloads/CSV export and Developer Ops follow-up overview text, first-round ops recommendation downloads, Developer Ops Launch Mainline handoff summary text, shared Initial Launch Ops Gate blocker text, Developer Ops readiness blocker/action text, Developer Ops operator action manifest text, and Developer Ops text handoffs now round-trip through service-provided `href` values; remaining work is mostly residual cleanup and regression coverage.

2. Tighten initial launch ops readiness after real first-launch actions.
   Verify that launch bootstrap, first batch setup, inventory refill, first-wave ops sweep, and closeout/stabilization actions all refresh the same readiness chain. First-Wave Recommendations, Launch Review, and Launch Smoke Kit now protect that chain from cross-channel launch receipt drift; post-launch lifecycle and stabilization confirmation hrefs round-trip into Ops, Launch Mainline traceability, the handoff index, and route-map exports; remaining work is grouped verification and a few low-frequency action/export edges.

3. Continue hardening launch receipt follow-up recovery.
   `launchReceiptNextFollowUp`, `recommendedAction`, `recommendedDownload`, Developer Ops launch receipt follow-up CSV, Release Package/Launch Workflow/Launch Review/Launch Smoke/Launch Mainline summary and route-focus text, First Launch Handoff text, Post-Launch Lifecycle text, readiness traceability, shared Initial Launch Ops Gate blocker text, Developer Ops follow-up overview text, Developer Ops Launch Mainline handoff summary text, Developer Ops readiness blocker/action text, Developer Ops operator action manifest text, Developer Ops summary/readiness/stabilization text, Launch Mainline post-launch traceability JSON/lifecycle primary-download text, post-launch handoff summary/index text, Launch Mainline action receipt handoff text, and Launch Mainline zip/checksum handoff download routes now carry the same download href chain; remaining work is mostly grouped regression around the already-connected path.

4. Run a broader targeted test batch.
   Keep full tests deferred until the remaining route/download and first-wave action gaps are smaller, but run grouped tests around release package, launch mainline actions, developer ops export, and launch workflow/review/smoke handoff.

5. Prepare staging launch rehearsal.
   Use a real server-like environment, non-default secrets, HTTPS, persistent storage, backup/restore rehearsal, and one test software-author project. The command-line `launch:smoke` preflight can now run locally against an ephemeral in-memory app or against a staging `--base-url` with explicit `--allow-live-writes`; its `handoff` output now carries the scoped Launch Review route, Developer Ops route, first-wave downloads, Ops handoff index, and a four-step operator checklist.

## Overall Project Plan

### Phase 1: Core Authorization Platform

Goal: provide the backend service that software authors rely on for runtime authorization.

Current state: mostly complete.

Main capabilities:

- Admin login and product management.
- Developer accounts and project ownership.
- Developer member/project-scope permissions.
- License policies and grants.
- Card login, recharge, account login, entitlements, sessions, devices, audit logs.
- Runtime startup/bootstrap/version/notice checks.
- Token key generation and rotation support.

Remaining work:

- Final security review of default secrets, deployment envs, and token-key rotation procedure.
- Real-world abuse/error-path review after first pilot users.

### Phase 2: SDK and Software-Author Integration

Goal: let a software author integrate the SDK into their own protected application.

Current state: usable for pilot integration.

Main capabilities:

- Windows C/C++ SDK package and demo assets.
- Integration package exports.
- Host config/env snippets.
- CMake and Visual Studio consumer materials.
- Developer integration workspace.

Remaining work:

- One or two real software-author integration rehearsals.
- Confirm the SDK packaging instructions match the actual build artifacts on a clean machine.
- Decide which examples are official for first launch and which are internal only.

### Phase 3: Software-Author Delivery Chain

Goal: give software authors a guided path from project setup to release handoff.

Current state: strong and close to pilot-ready.

Main capabilities:

- Release package.
- Launch workflow.
- Launch review.
- Launch smoke.
- Launch mainline.
- Route focus and preserved handoff context.
- Recommended workspace actions and downloads.
- Checksums and zip exports.

Remaining work:

- Continue reducing any fallback logic where frontend or route recovery guesses source/format.
- Keep documentation aligned with supported API formats and generated handoff assets.
- Run broader grouped verification before staging launch.

### Phase 4: First Launch Operations

Goal: make the first customer-facing wave operable instead of only deployable.

Current state: in progress, with the main chain now largely connected.

Main capabilities:

- Launch bootstrap.
- First batch setup.
- Inventory refill.
- First-launch handoff.
- Initial launch ops readiness.
- Launch receipt follow-ups.
- First-wave ops sweep.
- Closeout and stabilization handoffs.

Remaining work:

- Rehearse one complete first-launch path using realistic starter policy, starter cards, starter account, and one test client.
- Confirm the first-launch readiness gate moves from `HOLD` to the expected status after the right evidence is recorded.
- Confirm post-launch follow-up queues are useful for support and not too noisy.

### Phase 5: Production Readiness and Deployment

Goal: safely run the service outside local development.

Current state: strong documentation and server-side gates exist; real deployment rehearsal still remains.

Main capabilities:

- Production launch checklist.
- Production operations runbook.
- Observability guide.
- Incident response playbook.
- Backup/restore scripts and docs.
- Linux and Windows deployment guides.
- Cutover, recovery drill, operations, post-launch, closeout, and stabilization handoffs.

Remaining work:

- Choose first production OS and storage profile.
- Configure real HTTPS entrypoint.
- Replace default admin password and server token secret.
- Decide whether initial pilot uses SQLite or PostgreSQL.
- Run backup and restore drill.
- Run full launch rehearsal on staging.

### Phase 6: Commercial Operations

Goal: support real sales, support, renewals, and first customers.

Current state: operational foundation exists, but commercial packaging still needs decisions.

Main capabilities already available:

- Card batches and card inventory.
- Account and entitlement operations.
- Scoped developer audit logs.
- Developer operations export.
- Reseller and hierarchy docs exist.

Remaining work:

- Decide first sales model: card-only, account-only, or mixed.
- Decide first batch size and naming conventions.
- Prepare support scripts for common user issues.
- Prepare refund/replacement/abuse handling policy.
- Add payment/order automation only if needed before the first paid launch.

## Development Progress

Current high-level progress:

- Core backend/API authorization: 90%-95%.
- Developer delivery and handoff chain: 92%-94%.
- Launch Mainline and first-launch operations: 89%-92%.
- SDK/integration packaging: 80%-85%.
- Production deployment readiness: 75%-85%.
- Commercial operations readiness: 65%-75%.

Overall initial pilot-launch readiness: 88%-90%.

This is high enough to keep moving toward a controlled launch, but not high enough to skip staging, full tests, backup/restore rehearsal, or first-wave support preparation.

## Work Remaining Before Initial Launch

Minimum remaining work before a controlled pilot:

1. Finish residual route/download spot checks outside the launch-critical first-wave handoff chain and any less-used Ops export variants.
2. Run grouped targeted tests for release, launch workflow, launch review, launch smoke, launch mainline, and developer ops.
3. Run full test suite once the current backend/API slices settle and before staging rehearsal sign-off.
4. Prepare staging environment with non-default secrets and public HTTPS.
5. Run one complete staging rehearsal:
   release package -> launch workflow -> bootstrap -> first batch setup -> launch review -> `launch:smoke --base-url` -> launch smoke workspace -> launch mainline -> developer ops -> post-launch sweep.
6. Verify backup/restore and recovery drill.
7. Create first pilot software-author project and first batch of test cards/accounts.
8. Prepare support and escalation notes for first users.

## Testing Rhythm

Current rhythm:

- Run focused tests on every small backend/API slice.
- Keep full test suite deferred while the launch-mainline route/download work is still moving quickly.
- Run full test suite when either:
  - another 2-4 launch-mainline/backend API commits land, or
  - before the first staging deployment rehearsal, whichever comes first.

Recommended full verification gate before pilot:

```powershell
node --test --test-concurrency=1 --test-isolation=none test\license-flow.test.js
node --check src\services.js
git diff --check
```

If the full suite is too slow or noisy, split it into grouped runs but do not skip:

- release package export
- launch workflow export
- launch review
- launch smoke
- launch mainline actions
- developer ops export
- account/card/session authorization flows
- deployment/security/static checks

## Operating Definition of "Ready to Launch"

The project can be treated as initially launchable when all of these are true:

- A software author can create/configure a project.
- The software author can integrate the SDK using the exported package.
- The software author can produce a protected client build.
- The backend can authorize first users by card or account.
- First cards/accounts can be created, delivered, revoked, and audited.
- Launch Mainline reaches an explainable non-blocking state for the selected pilot lane.
- Backup/restore has been rehearsed.
- Public HTTPS and non-default secrets are configured.
- A support operator knows where to inspect accounts, sessions, devices, cards, and audit logs.
- The first-wave post-launch review has a clear owner and handoff path.

## Current Risk Register

### High

- Full test suite has been intentionally deferred during rapid backend/API iteration.
- Real deployment rehearsal has not replaced local verification yet.
- Commercial operations decisions may still affect first-launch packaging.

### Medium

- Some older or non-critical route/download key mappings may still need spot audit outside the launch-critical paths recently tested.
- SDK clean-machine integration should be rehearsed before inviting a real software author.
- Payment/order automation may be unnecessary for pilot, but the manual process must be explicit if payment is accepted.

### Low

- Documentation is broad and useful, but needs occasional index updates when new handoff formats are added.
- README is long; new operators should start with this roadmap plus the launch checklist, not the whole README.

## Recommended Reading Order

For launch planning:

- [production-launch-checklist.md](production-launch-checklist.md)
- [developer-launch-mainline.md](developer-launch-mainline.md)
- [launch-mainline-rehearsal.md](launch-mainline-rehearsal.md)
- [production-operations-runbook.md](production-operations-runbook.md)

For software-author handoff:

- [developer-integration.md](developer-integration.md)
- [developer-release.md](developer-release.md)
- [developer-launch-workflow.md](developer-launch-workflow.md)
- [developer-ops.md](developer-ops.md)

For production operations:

- [observability-guide.md](observability-guide.md)
- [incident-response-playbook.md](incident-response-playbook.md)
- [daily-operations-checklist.md](daily-operations-checklist.md)
- [shift-handover-template.md](shift-handover-template.md)
