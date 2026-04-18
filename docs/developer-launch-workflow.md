# Developer Launch Workflow

The developer launch workflow workspace is available at `/developer/launch-workflow`.

It is meant to give software authors one combined place to inspect:

- release readiness for one project/channel
- startup bootstrap decisions
- client hardening profile
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
- workflow-level summary text
- workflow checklist text
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

- linked release summary
- linked integration `.env`
- linked `rocksolid_host_config.env`
- linked `CMakeLists.txt`
- linked VS2022 quickstart
- linked C++ quickstart
- linked host skeleton

Those files now also come from the same `/api/developer/launch-workflow/download` endpoint, so the launch workflow workspace can stay on one unified download route instead of mixing multiple release and integration download APIs.

## Typical use

Use `/developer/launch-workflow` when a software author wants one quick answer to:

- is this lane ready to launch
- what is still blocking launch
- what files should I hand to integration or release teammates
- which workspace should I open next
