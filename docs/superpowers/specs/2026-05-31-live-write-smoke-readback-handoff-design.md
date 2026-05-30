# Live-Write Smoke Readback Handoff Design

## Goal

Shorten the remaining manual review boundary between live-write smoke result backfill and production sign-off entry. Operators should see one first-screen, copyable, read-only handoff row without reopening deeper readiness packets or introducing automatic real-environment writes.

## Selected Approach

Add a separate `liveWriteSmokeReadbackHandoff=...` text row beside the existing `liveWriteSmokeHandoff=...` row.

This is preferred over extending the existing row because it keeps the live-write execution path separate from the post-write readback path. It is preferred over adding a new API object because the existing entrypoint objects already carry every required value.

## Output Contract

The shared first-screen formatter will render:

```text
liveWriteSmokeReadbackHandoff=live_write_smoke_result_backfill -> readiness_readback -> rehearsal_reload -> production_signoff_entry
| backfill=<staging closeout backfill command>
| readback=<staging readiness status command>
| rehearsal=<staging rehearsal reload command>
| expected=live_write_smoke:ready_live_write_smoke_evidence_attached
| next=production_signoff
| signoff=<guarded full-test or production-signoff entry command>
| packet=<staging production sign-off packet path>
| status=<current live-write smoke entrypoint status>
```

## Data Flow

The formatter reuses:

- `liveWriteSmokeExecutionEntrypoint.resultBackfillCommand`
- `liveWriteSmokeExecutionEntrypoint.readinessRefreshCommand`
- `liveWriteSmokeExecutionEntrypoint.rehearsalReloadCommand`
- `liveWriteSmokeExecutionEntrypoint.status`
- `productionSignoffExecutionEntrypoint.currentCommand`
- `productionSignoffExecutionEntrypoint.fullTestCommand`
- `productionSignoffExecutionEntrypoint.productionSignoffPacket`

The formatter is called only when the live-write smoke entrypoint exists. If the production sign-off entrypoint is absent, the sign-off command and packet render as `-` instead of changing execution behavior.

## Surfaces

Because the row is emitted from the shared production-switch environment proof formatter, it appears consistently in:

- Launch Review summary
- Launch Smoke summary
- Launch Mainline launch-evidence readiness gate
- Developer Ops Operator Entry

## Safety

The row is display-only. It does not execute backfill, readiness refresh, rehearsal reload, full tests, production sign-off, or real writes. Existing explicit operator confirmation and staging gates remain unchanged.

## Testing

Use TDD:

1. Add first-screen assertions for the four surfaces.
2. Run the focused license flow test and confirm failure because `liveWriteSmokeReadbackHandoff` is absent.
3. Add the minimal shared formatter.
4. Re-run syntax checks, focused license flow tests, whitespace checks, and `launch:route-map-gate`.

## Non-Goals

- Do not add automatic write execution.
- Do not change the production-switch state machine.
- Do not add API fields or new staging scripts.
- Do not run the deferred full suite until the planned pre-cutover test window.
