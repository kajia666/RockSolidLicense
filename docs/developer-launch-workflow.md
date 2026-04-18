# Developer Launch Workflow

The developer launch workflow workspace is available at `/developer/launch-workflow`.

It is meant to give software authors one combined place to inspect:

- release readiness for one project/channel
- startup bootstrap decisions
- client hardening profile
- recommended handoff files
- combined launch summary, checklist, checksums, and zip bundle

This page accepts `productId`, `productCode`, and `channel` in the query string so the project workspace, integration workspace, or release workspace can open the same launch lane without re-entering project context.

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

## Typical use

Use `/developer/launch-workflow` when a software author wants one quick answer to:

- is this lane ready to launch
- what is still blocking launch
- what files should I hand to integration or release teammates
- which workspace should I open next
