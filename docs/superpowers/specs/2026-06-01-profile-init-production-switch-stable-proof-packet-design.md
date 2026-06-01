# Profile Init Production Switch Stable Proof Packet Design

## Goal

Close the remaining archive visibility gap in `staging:profile:init`: the operator queue already reaches stable operations and exposes seven first-window read-only proof downloads, but `productionSwitchProofPacket` still ends at launch-day watch and stabilization.

## Scope

Extend only the profile-init production-switch proof packet. Reuse the existing stable-operations post-handoff proof queue without adding API routes, write operations, or production-proof preflight steps.

## Design

Add a ninth ordered `productionSwitchProofPacket.proofItems` row:

- `key`: `stable_operations_first_window_proof`
- `status`: `blocked_after_stable_operations_handoff`
- `command`: the first existing stable-operations proof download target
- `artifactPath`: the shared launch-duty record index
- `nextAction`: verify the existing first-result and rollout-widening proof queue before widening the stable operating window

Expose a packet-level `stableOperationsFirstWindowProof` summary with:

- stable-operations handoff status
- proof queue status
- proof-download count
- first proof-download target
- full post-handoff proof queue
- shared handoff artifacts
- launch-duty record index
- first-wave closeout artifact

Pass the existing `stableOperationsHandoff` object into `buildProductionSwitchProofPacket`. Do not rebuild the queue inside the packet builder.

## Plain Output

Print one compact production-switch packet line for the stable first-window summary. Keep the existing stable-operations operator-queue output unchanged.

## Testing

Update `test/staging-profile-init-script.test.js` to verify:

- JSON proof counts increase from `8` to `9`.
- The ninth proof row points to the first existing rollout-widening download.
- The packet summary carries all seven existing read-only downloads and the two handoff artifacts.
- Plain output prints the summary and the ninth ordered proof row.
- Secret-ready proof counts increase consistently.

Run the focused profile-init test, syntax check, `launch:route-map-gate`, whitespace check, and stale-count search. Keep the repository full suite deferred to the planned go-live gate.

## Non-Goals

- No new download routes.
- No new write steps.
- No changes to `launch:production-proof-preflight`.
- No broad refactor of staging profile initialization.

