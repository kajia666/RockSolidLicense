# Profile-Driven Production Proof Single-Argument Design

## Goal

Reduce the real-like cutover entrypoint to one profile argument:

```powershell
npm.cmd run launch:production-proof-preflight -- --profile-file <staging-profile.json>
```

The profile remains secret-free and continues to carry `productionProofExecutionPackFile`, so the preflight can write the Markdown execution pack without asking the operator to repeat its path.

## Scope

Normalize profile-driven production-proof commands emitted by:

- `staging:profile:init`
- `staging:profile:check`
- `staging:rehearsal --profile-file`
- `docs/staging-rehearsal-profile.example.json`

Keep direct CLI production-proof usage unchanged. Operators without a profile can still pass `--execution-pack-file` explicitly with the other non-secret bindings.

## Compatibility

- `launch:production-proof-preflight` continues accepting explicit `--execution-pack-file`.
- `launch:production-proof-preflight -- --profile-file <file>` continues loading `productionProofExecutionPackFile` from the profile.
- Existing profiles that store an older two-argument `productionProofPreflightCommand` remain readable.
- Profile-driven outputs ignore the older stored command shape and emit the normalized one-argument command.
- The manual `launch_smoke_staging` live-write gate remains unchanged.

## Data Flow

1. `staging:profile:init` derives `production-proof-execution-pack.md` and stores it as `productionProofExecutionPackFile`.
2. The generated profile stores a normalized `productionProofPreflightCommand` containing only `--profile-file`.
3. `staging:profile:check` validates the stored execution-pack path and verifies that the stored command uses the one-argument profile handoff.
4. `staging:profile:check` prints the normalized one-argument `nextCommand`.
5. `staging:rehearsal --profile-file` prints the same normalized one-argument command even when an older profile embeds the two-argument form.
6. `launch:production-proof-preflight` resolves the execution-pack path from the loaded profile and writes the secret-free Markdown pack when the operator runs the one-argument command.

## Error Handling

- Reject profiles missing `productionProofExecutionPackFile` or `productionProofPreflightCommand`.
- Reject profile commands that do not use exactly the profile-driven one-argument shape.
- Preserve existing profile secret-field rejection and HTTPS/storage validation.
- Do not auto-run production proof from profile check. The read-only check and pack-writing preflight remain two explicit operator steps.

## Verification

Use TDD to update and verify:

- `test/staging-profile-check-script.test.js`
- `test/staging-profile-init-script.test.js`
- `test/staging-rehearsal-script.test.js`
- `npm.cmd run launch:route-map-gate`

The full repository suite remains deferred to the agreed production-cutover window unless this change exposes a broader backend/API regression.
