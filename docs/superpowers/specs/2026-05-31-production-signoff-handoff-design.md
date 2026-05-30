# Production Sign-Off Handoff Design

## Goal

Shorten the remaining first-screen review boundary from the guarded full-test window into production sign-off conditions and receipt visibility. Operators should see one compact, copyable, read-only handoff row without expanding all eleven follow-up commands or introducing automatic execution.

## Selected Approach

Add a separate `productionSignoffHandoff=...` text row beside the existing `productionSignoffEntrypoint=...` row.

The row stays compact: it shows the guarded full-test command, `full_test_window_passed` backfill command, readiness readback, rehearsal reload, the sign-off and receipt queue counts, the first command from each queue, the production sign-off packet, and the current status. The complete six sign-off condition commands and five receipt-visibility commands remain available through the existing deeper entrypoint queues.

## Output Contract

The shared first-screen formatter will render:

```text
productionSignoffHandoff=full_test_window -> full_test_window_passed_backfill -> readiness_readback -> rehearsal_reload -> production_signoff_conditions -> receipt_visibility
| fullTest=<guarded full-test command>
| backfill=<full_test_window_passed signoff backfill command>
| readback=<staging readiness status command>
| rehearsal=<staging rehearsal reload command>
| expected=full_test_window:ready_full_test_window_evidence_attached
| signoffQueue=<sign-off condition command count>
| signoffFirst=<first sign-off condition command>
| receiptQueue=<receipt visibility command count>
| receiptFirst=<first receipt visibility command>
| packet=<staging production sign-off packet path>
| status=<current production sign-off entrypoint status>
```

## Data Flow

The formatter reuses:

- `productionSignoffExecutionEntrypoint.fullTestCommand`
- `productionSignoffExecutionEntrypoint.fullTestBackfillCommand`
- `productionSignoffExecutionEntrypoint.readinessRefreshCommand`
- `productionSignoffExecutionEntrypoint.rehearsalReloadCommand`
- `productionSignoffExecutionEntrypoint.signoffConditionCommands`
- `productionSignoffExecutionEntrypoint.receiptVisibilityBackfillCommands`
- `productionSignoffExecutionEntrypoint.productionSignoffPacket`
- `productionSignoffExecutionEntrypoint.status`

The formatter is called only when the production sign-off entrypoint exists. It selects the first command-bearing row from each queue. Missing commands render as `-` without changing execution behavior.

## Surfaces

Because the row is emitted from the shared production-switch environment proof formatter, it appears consistently in:

- Launch Review summary
- Launch Smoke summary
- Launch Mainline launch-evidence readiness gate
- Developer Ops Operator Entry

## Safety

The row is display-only. It does not run the full suite, backfill evidence, refresh readiness, reload rehearsal, archive packets, or execute real writes. Existing explicit operator confirmation and staging gates remain unchanged.

## Testing

Use TDD:

1. Add first-screen assertions for the four surfaces.
2. Run the focused license flow test and confirm failure because `productionSignoffHandoff` is absent.
3. Add the minimal shared formatter.
4. Re-run syntax checks, focused license flow tests, whitespace checks, and `launch:route-map-gate`.

## Non-Goals

- Do not automatically run the deferred full suite.
- Do not expand all eleven sign-off and receipt commands into the first-screen row.
- Do not change the production-switch state machine.
- Do not add API fields or new staging scripts.
