# Developer Launch Mainline

The developer launch mainline workspace is available at `/developer/launch-mainline`.

It is the unified author-side control tower for first-wave rollout. Use it when you want one place to review:

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
- `checksums`
- `zip`

## What it shows

The workspace keeps the launch mainline as one server-driven package and surfaces:

- `overallGate`
- `releaseGate`
- `workflowGate`
- `reviewGate`
- `smokeGate`
- `opsGate`
- a unified `actionPlan`
- unified `recommendedDownloads`

That makes it useful when the software author, QA, release, or launch-duty teammates need one handoff instead of bouncing between several related pages first.

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
