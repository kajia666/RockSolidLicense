# Developer Launch Workflow

The developer launch workflow workspace is available at `/developer/launch-workflow`.

It is meant to give software authors one combined place to inspect:

- release readiness for one project/channel
- authorization readiness for one project/channel
- startup bootstrap decisions
- client hardening profile
- recommended workspace routing
- recommended handoff files
- combined launch summary, checklist, checksums, and zip bundle

This page accepts `productId`, `productCode`, and `channel` in the query string so the project workspace, integration workspace, or release workspace can open the same launch lane without re-entering project context.

It can also accept `autofocus=handoff` so the page prefers the recommended handoff section and, after sign-in or refresh, auto-loads the matching launch workflow package for that routed lane when possible.

## Scoped APIs

- `GET /api/developer/launch-workflow`
- `GET /api/developer/launch-workflow/download`

Selectors:

- `productId`
- `productCode`
- `projectCode`
- `softwareCode`
- `channel`

Download formats:

- `json`
- `summary`
- `checklist`
- `handoff-zip`
- `handoff-checksums`
- `checksums`
- `zip`
- `release-json`
- `release-summary`
- `release-checksums`
- `integration-json`
- `integration-env`
- `integration-host-config`
- `integration-cmake`
- `integration-vs2022-guide`
- `integration-vs2022-sln`
- `integration-vs2022`
- `integration-vs2022-filters`
- `integration-vs2022-props`
- `integration-vs2022-local-props`
- `integration-cpp`
- `integration-host-skeleton`
- `integration-checksums`

## Workspace behavior

The launch workflow package combines:

- the linked release package
- the linked integration package
- authorization-readiness checks for login paths, starter policies, and starter card inventory
- workflow-level summary text
- workflow checklist text
- a curated recommended handoff zip for teammates
- the full workflow zip for archive and deep review
- recommended downloads
- launch blockers
- next actions for the current lane

The workspace keeps direct navigation back to:

- `/developer/projects`
- `/developer/integration`
- `/developer/releases`

That makes it easier for software authors to move between:

1. project settings
2. integration handoff
3. launch decision review
4. release handoff

without losing `productCode` or `channel`.

The same page now also keeps the most common lane-specific handoff files one click away, including:

- recommended handoff zip
- recommended handoff checksums
- recommended workspace jump
- linked release summary
- linked integration `.env`
- linked `rocksolid_host_config.env`
- linked `CMakeLists.txt`
- linked VS2022 quickstart
- linked C++ quickstart
- linked host skeleton

The same handoff summary can now also render the top `recommendedDownloads` as direct buttons. That keeps the lane-specific handoff zip, launch summary/checklist, release summary, and integration host files one click away from the workflow summary itself.

The checklist section is now actionable too. Each top workflow check can expose its own workspace jump and download shortcut, so release-readiness, startup, hardening, token-key, and handoff tasks can be handled straight from the checklist card instead of only from the summary header.

That same checklist now includes an authorization-readiness check. It verifies whether the current project still needs starter policies, sellable cards, or a first-launch login path, and it can route software authors directly into `/developer/licenses` or back into `/developer/projects` when those are the fastest fixes.

The launch workflow summary itself now also derives an `Action Plan`. It takes the highest-priority blocked or review items, turns them into a short ordered path, and lets the software author jump to the right workspace or download the right file from that path directly.

When the current authorization blockers can be fixed automatically, the same launch workflow package now also exposes `Run Launch Bootstrap`. That action can create the missing starter policy, starter card batch, or starter account for the routed project, then regenerate the same lane immediately so the software author can verify whether the blocker really cleared.

Authorization readiness inside the launch workflow now also carries more operational launch guidance, not just pass/review/block state. The workflow summary and exported summary/checklist now include:

- `Initial Inventory Recommendations`
- `First Batch Card Suggestions`
- `First Ops Actions`

That makes the launch workflow useful not only for "is this lane blocked" but also for "what should we stock first", "what kind of first card batches should we issue", and "what should operations watch right after launch".

Those recommendation rows are now actionable too. When the current lane knows the next best fix, the launch workflow can expose direct buttons beside the recommendation so the software author can:

- jump into the right workspace
- run `Launch Bootstrap`
- or follow a recommended download

The same launch-day operations slice can now also route directly into `/developer/ops`. So first sign-in smoke checks, first card-redemption watch, and early session/device review can drop the software author straight into `snapshot`, `audit`, or `sessions` focus inside the developer ops workspace instead of stopping at summary text. Those jumps can also carry launch-specific audit filters such as `eventType`, `actorType`, or `entityType`, so the first post-launch review opens closer to the real signal that needs watching.

The `Recommended Workspace` area is now actionable as well. Besides the single “open recommended workspace” button, the page can render the top workspace-path actions directly as buttons, so a software author can jump straight to the most relevant project, integration, or release section for the current lane.

Those routed jumps now also carry the originating step title and reason into the next workspace. So when an action-plan item or checklist item sends someone to Integration or Releases, the target page can explain which workflow step triggered the jump instead of only showing a generic autofocus hint.

Those files now also come from the same `/api/developer/launch-workflow/download` endpoint, so the launch workflow workspace can stay on one unified download route instead of mixing multiple release and integration download APIs. The recommended handoff zip is intentionally smaller than the full workflow zip: it keeps the launch summary/checklist, release summary, host config, CMake consumer, VS2022 consumer files, C++ quickstart, host skeleton, and hardening guide together for handoff, while the full workflow zip still preserves the larger release/integration JSON archive.

The recommended workspace jump now also carries more specific autofocus hints. So instead of only choosing `Projects`, `Integration`, or `Releases`, it can route a software author straight into the most relevant section of that workspace, such as project feature toggles, startup bootstrap review, hardening review, version rules, or notices.

## Typical use

Use `/developer/launch-workflow` when a software author wants one quick answer to:

- is this lane ready to launch
- what is still blocking launch
- what files should I hand to integration or release teammates
- which workspace should I open next
