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

It now also derives a review-level:

- `recommended workspace`
- `action plan`
- `review targets`
- `recommended downloads`

So the software author can move from "what happened after bootstrap / first-batch / refill" straight into "what should we open next" without translating the raw launch-workflow and ops summaries by hand.

It now also supports running lane-fix actions directly from the review action plan:

- `Launch Bootstrap`
- `First Batch Setup`
- `Inventory Refill`

After running one of those actions, the page keeps a `Last Review Action` recap in place so the author can:

- confirm what changed in starter policy / card / account / entitlement counts
- review any newly created starter batch, starter account, or internal entitlement
- keep following the next launch-day recheck without leaving the review workspace

The review page also promotes routed launch-day targets such as:

- matched accounts
- matched entitlements
- matched sessions
- matched devices
- matched audit logs

Each target can route directly into the matching scoped `Developer Ops` section with the same review filters preserved.

Those routed target links now also carry the first matched object itself when possible. So when launch review says "Review matched accounts" or "Review matched sessions", `/developer/ops` can open with a direct review target already prepared instead of only dropping the author into a broad section and asking them to find the first object again.

## Scoped APIs

- `GET /api/developer/launch-review`
- `GET /api/developer/launch-review/download`

Supported download formats:

- `json`
- `summary`
- `checksums`
- `zip`

The summary and zip outputs merge the current launch-workflow lane with the routed developer-ops review scope, so the author does not need to export launch and ops follow-up separately.

The surrounding launch initialization flow can also hand off a separate `launch smoke kit` summary from `GET /api/developer/launch-smoke-kit/download`. That file is intentionally lighter than full launch review output: it focuses on startup bootstrap inputs, candidate internal accounts or entitlements, fresh launch-card candidates, and the first smoke-test path that QA, support, or launch-duty teammates can run before or right after launch.

## Typical use

Use `/developer/launch-review` when the software author wants to:

- recheck one lane immediately after launch initialization
- confirm launch workflow and starter inventory are now in the expected state
- review first login, first redemption, or early session signals in the same handoff package
- hand one combined review file to QA, support, or launch-duty teammates
