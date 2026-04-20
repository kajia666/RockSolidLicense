# Developer Launch Review

The developer launch review workspace is available at `/developer/launch-review`.

It is the post-initialization review workspace for software authors. Use it right after:

- `Launch Bootstrap`
- `First Batch Setup`
- `Inventory Refill`

The page combines two things in one place:

- the current launch-workflow lane
- the filtered developer-ops snapshot for the same project and lane

That makes it useful when a software author wants one follow-up view for:

- launch workflow status and summary text
- launch workflow checklist text
- first-wave runtime or redemption review signals
- one downloadable review package for QA, support, or launch-duty handoff

## Scoped APIs

- `GET /api/developer/launch-review`
- `GET /api/developer/launch-review/download`

Supported download formats:

- `json`
- `summary`
- `checksums`
- `zip`

The summary and zip outputs merge the current launch-workflow lane with the routed developer-ops review scope, so the author does not need to export launch and ops follow-up separately.

## Typical use

Use `/developer/launch-review` when the software author wants to:

- recheck one lane immediately after launch initialization
- confirm launch workflow and starter inventory are now in the expected state
- review first login, first redemption, or early session signals in the same handoff package
- hand one combined review file to QA, support, or launch-duty teammates
