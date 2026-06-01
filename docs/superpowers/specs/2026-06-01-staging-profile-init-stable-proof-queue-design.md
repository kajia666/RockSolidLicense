# Staging Profile Init Stable Proof Queue Design

Updated: 2026-06-01

## Goal

Keep the real staging profile initialization package aligned with the route-map gate after stable-operations handoff. An operator who starts from `staging:profile:init` should see the same first stable-window proof downloads without reopening the route-map dry-run output.

## Scope

Extend only `scripts/staging-profile-init.mjs`, its focused test, and the rolling launch documentation.

Do not change:

- `staging:profile:check` secret-free validation responsibilities
- `launch:production-proof-preflight` no-write responsibilities
- API endpoints or write operations
- the existing launch-day watch, stabilization, or stable-operations handoff order

## Design

Add a `postHandoffProofQueue` to the existing `stableOperationsHandoff` payload. It contains seven read-only downloads in this order:

1. Rollout widening decision execution
2. First operating-result handoff execution
3. First operating-result handoff receipt-readback execution
4. First operating-result review execution
5. Next rollout widening decision execution
6. Widened rollout monitoring execution
7. Launch operations overview status

The first six direct execution files use `/api/developer/launch-mainline/download` with the profile product code, channel, `reviewMode=matched`, and the required `format`. The overview-status file remains on `/api/developer/ops/export/download` with `limit=80`.

Append one `verify_stable_operations_first_result_and_rollout` read-only `download_queue` row after `handoff_stable_operations` in `operatorNextCommands`. Include that row in the stable-operations execution phase and checkpoint counts. Plain output should print the queue status, first download, and count.

## Data Flow

`staging:profile:init` derives the profile product code, channel, and launch-duty record-index path. It builds the stable proof queue once, stores it under `stableOperationsHandoff`, reuses it in the appended operator row, and reports `stableOperationsProofDownloadCount=7` in the checkpoint.

## Error Handling

The queue is derived only from validated profile inputs. It adds no new I/O and no new failure mode. Existing profile validation remains the source of truth for invalid product, channel, or path inputs.

## Testing

Use TDD:

1. Update `test/staging-profile-init-script.test.js` first and verify RED.
2. Assert JSON payload coverage for `postHandoffProofQueue`, the appended operator row, stable phase contents, and checkpoint counts.
3. Assert plain output coverage for the stable proof queue and appended operator row.
4. Implement the minimum script changes.
5. Run the focused profile-init test, `node --check scripts/staging-profile-init.mjs`, `npm.cmd run launch:route-map-gate`, and `git diff --check`.

## Success Criteria

- Profile initialization no longer stops its operator package at stable-operations handoff.
- The profile-init stable proof queue matches route-map gate route semantics.
- No write step is added after stable-operations handoff.
- Targeted launch verification remains green.
