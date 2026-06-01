# Windows Deploy Evidence Pack Design

## Goal

Add one local preparation entrypoint that generates a secret-free Markdown pack for the real-environment evidence that must be captured after the first Windows deployment starts.

This closes the gap between "the server can start" and "the launch operator knows exactly which proof rows to backfill before initial production traffic."

## Command

Add:

```powershell
npm.cmd run deploy:windows:evidence-pack
```

The command uses a Node.js ESM script and supports:

```text
--product-code <code>
--channel <name>
--target-dir <path>
--output-file <path>
--json
--help
```

Defaults:

```text
product code: FIRSTBATCH
channel: stable
target directory: C:\RockSolidLicense
output file: artifacts/deploy/windows/windows-deploy-evidence-pack.md
```

## Boundary

The command may create the parent directory for its generated Markdown file and write that Markdown file.

The command must not:

- create or modify the future Windows target directory
- read or write `rocksolid.env.ps1`
- start services
- call backend APIs
- register Scheduled Tasks
- change firewall rules
- configure HTTPS
- execute backups or smoke tests
- run full tests
- read or print secret values

The output file must stay outside the future target directory and must not contain example secret placeholders.

## Generated Pack

The Markdown pack must include:

- product code, channel, future Windows target directory, and generation timestamp
- the exact staging artifact root
- `filled-closeout-input.json`
- `readiness-action-queue.md`
- `launch-duty-record-index.json`
- the read-only `deploy:windows:preflight` command
- the existing `deploy:windows:prepare-pack` command
- a reminder that the pack is for after manual start, local healthcheck, HTTPS, and secret configuration
- evidence rows for:
  - `backup_restore_drill_result`
  - `live_write_smoke_result`
  - `receipt_visibility_review`
  - `full_test_window_passed`
  - production signoff conditions
  - receipt visibility lanes
  - `launch_day_watch_summary`
  - supporting launch-duty records
  - `first_wave_closeout`
- backfill/record commands that use the existing staging scripts:
  - `staging:closeout:backfill`
  - `staging:signoff:backfill`
  - `staging:launch-duty:record`
  - `staging:readiness:status`
  - `staging:rehearsal`

## Machine-Readable Result

JSON and plain output must report:

- `status=prepared`
- generated output path
- product code
- channel
- target directory
- artifact root
- closeout input file
- actions file
- launch-duty record index file
- `summary.willModifyTargetDirectory=false`
- `summary.willCallBackend=false`
- `summary.willStartService=false`
- `summary.willRunSmoke=false`
- `summary.willRunFullTest=false`
- `summary.willWriteEvidence=false`
- ordered evidence groups with commands
- first next action: `npm.cmd run deploy:windows:preflight`

## Error Handling

Reject:

- unknown CLI options
- missing values for options that require values
- blank product code
- blank channel
- an output path that resolves to the target installation directory or any path inside it

Allow:

- a custom product code and channel
- a custom output file
- a custom future target directory

## Testing

Add focused tests for:

- npm script exposure
- default secret-free Markdown generation
- custom product/channel path rendering
- JSON safety flags and evidence groups
- unknown option rejection
- missing option-value rejection
- blank product/channel rejection
- target-directory output rejection
- `--help`

Update the Windows deployment guide, roadmap, and deployment asset tests. Verify syntax, focused tests, deployment asset tests, the new pack command, existing first deploy pack, existing preflight, the targeted route-map gate, generated-pack secret-placeholder scan, and whitespace.

Keep the full repository suite deferred until the planned final go-live test window unless this slice unexpectedly changes shared backend/API behavior.
