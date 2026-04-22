# Developer Launch Mainline

The developer launch mainline workspace is available at `/developer/launch-mainline`.

It is the unified author-side control tower for first-wave rollout. Use it when you want one place to review:

- production readiness
- release readiness
- launch workflow readiness
- launch review follow-up
- launch smoke follow-up
- developer ops follow-up

The page is a thin workspace over the backend/API aggregate:

- `GET /api/developer/launch-mainline`
- `GET /api/developer/launch-mainline/download`

Supported download formats:

- `json`
- `summary`
- `production-handoff`
- `recovery-drill-handoff`
- `operations-handoff`
- `checksums`
- `zip`

## What it shows

The workspace keeps the launch mainline as one server-driven package and surfaces:

- `overallGate`
- `productionGate`
- `releaseGate`
- `workflowGate`
- `reviewGate`
- `smokeGate`
- `opsGate`
- a unified `actionPlan`
- unified `recommendedDownloads`

That makes it useful when the software author, QA, release, or launch-duty teammates need one handoff instead of bouncing between several related pages first.

The production gate is the part that answers "can this lane widen beyond internal launch traffic yet?" It now checks a practical first production slice directly from backend/API state, including:

- default admin password still in use
- default server token secret still in use
- whether the current public entrypoint still points at localhost / 127.x / another loopback-style host
- whether configured PostgreSQL or Redis production endpoints still point at localhost / 127.x / another loopback-style host
- runtime-state still on `memory`
- whether main storage is still on single-host `sqlite`
- whether runtime state is still on single-host `sqlite`
- PostgreSQL or Redis external readiness when those drivers are configured
- whether the current public entrypoint is still HTTP
- whether token-key rotation still starts from only one published key

When one of those checks blocks or needs review, the unified mainline can now send the software author straight into `Developer Security` or `Developer Ops` from the same launch path instead of leaving production-readiness review outside the main rollout flow.

Those checks now also surface as a first-class `Production Gate Checks` section inside `/developer/launch-mainline`, not only as a stage status. Each check is rendered as its own card with service-driven controls, so the lane can move from "blocked by production readiness" to the next concrete security or ops action without leaving the unified mainline flow first. The section is no longer limited to blockers either: it now carries a fuller backend/API snapshot with both blocking/review checks and already-prepared production assets like backup/restore and healthcheck handoff coverage.

The same unified handoff now also exposes a dedicated `production-handoff` download. It packages the deployment docs, runtime launch scripts, healthcheck scripts, backup/restore scripts, and the most relevant env/compose skeletons for the current storage/runtime profile, so the launch lane can hand productionization work to QA, release duty, or ops without rebuilding that checklist from README links by hand.

It also exposes a dedicated `recovery-drill-handoff` download. That package brings backup scripts, restore scripts, storage docs, verification signals, and a drill flow together, so launch duty can rehearse "backup -> restore -> healthcheck -> review -> rollback" as one explicit recovery path instead of rebuilding that playbook from scattered deployment docs.

That recovery path is now part of the gate itself too. `Launch Mainline` will block the lane when no recovery drill has been recorded inside the current 14-day readiness window, and the same `Production Gate Checks` card can now fire a service-driven `Record Recovery Drill` action from the unified mainline workspace. Once that action runs, the refreshed gate, summary text, and action receipt all carry the new drill evidence together.

It also exposes a dedicated `operations-handoff` download for first-wave operations. That package brings together the observability guide, alert-priority guide, incident-response playbook, daily checklist, launch timeline, production operations runbook, and shift handover template, so launch duty can hand monitoring and incident-response expectations to the next operator without rebuilding that bundle manually.

## Why it matters

Before this page existed, the aggregated launch-mainline payload was available as an API/download artifact, but there was no single workspace that treated it like a first-class control point.

Now the surrounding launch pages can route `launch_mainline_overview` into `/developer/launch-mainline`, so:

- the unified handoff is available as a workspace, not only a file
- `release / workflow / review / smoke / ops` can all point into the same total-view page
- the author can inspect stage gates, action plan, and downloads in one place before continuing into a more specific workspace

## Typical use

Use `/developer/launch-mainline` when the software author wants to:

- decide whether a lane is really ready for first-wave rollout
- compare release, workflow, review, smoke, and ops signals together
- download one consistent handoff package for QA, support, or launch-duty teammates
- jump from the unified overview into the next specific workspace that still needs action
