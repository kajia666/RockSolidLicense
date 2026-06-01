# Windows Deploy Evidence Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local CLI that generates a secret-free Markdown evidence backfill pack for the first Windows deployment.

**Architecture:** Create one Node.js ESM generator beside the existing Windows deployment preparation CLIs. The generator accepts product/channel/output options, renders existing staging backfill and launch-duty record commands, refuses output inside the future Windows target directory, and writes only the generated Markdown pack.

**Tech Stack:** Node.js ESM, built-in `node:test`, Markdown, existing staging CLI command contracts.

---

### Task 1: Lock The Evidence Pack Contract With Failing Tests

**Files:**
- Create: `test/windows-deploy-evidence-pack-script.test.js`

- [ ] **Step 1: Add focused CLI tests**

Create tests that invoke:

```js
spawnSync(process.execPath, [
  "scripts/windows-deploy-evidence-pack.mjs",
  "--json",
  "--product-code",
  productCode,
  "--channel",
  channel,
  "--output-file",
  outputFile
], { cwd: repoRoot, encoding: "utf8" });
```

Cover:

```text
package.json deploy:windows:evidence-pack entry
default secret-free Markdown generation
custom product/channel path rendering
JSON safety flags and evidence groups
unknown option rejection
missing --product-code value rejection
blank --channel rejection
output inside target-directory rejection
--help
```

- [ ] **Step 2: Run the focused suite to verify RED**

Run:

```powershell
node --test --test-concurrency=1 --test-isolation=none test/windows-deploy-evidence-pack-script.test.js
```

Expected: FAIL because `scripts/windows-deploy-evidence-pack.mjs` and `deploy:windows:evidence-pack` do not exist.

### Task 2: Add The Secret-Free Evidence Pack Generator

**Files:**
- Create: `scripts/windows-deploy-evidence-pack.mjs`
- Modify: `package.json`
- Test: `test/windows-deploy-evidence-pack-script.test.js`

- [ ] **Step 1: Add argument parsing and path safety**

Support:

```text
--product-code <code>
--channel <name>
--target-dir <path>
--output-file <path>
--json
--help
```

Default to:

```text
FIRSTBATCH
stable
C:\RockSolidLicense
artifacts/deploy/windows/windows-deploy-evidence-pack.md
```

Reject blank product/channel values and an output file equal to or contained by the future target directory.

- [ ] **Step 2: Render evidence groups and commands**

Generate commands for:

```text
backup_restore_drill_result
live_write_smoke_result
receipt_visibility_review
full_test_window_passed
production signoff conditions
receipt visibility lanes
launch_day_watch_summary
receipt_visibility_snapshot
first_wave_incident_log
rollback_signal_review
stabilization_owner_handoff
first_wave_closeout
staging:readiness:status
staging:rehearsal
```

Use paths under:

```text
artifacts/staging/<productCode>/<channel>
```

- [ ] **Step 3: Add output and npm script**

Return JSON and plain output with safety flags, paths, evidence groups, and first next action:

```text
npm.cmd run deploy:windows:preflight
```

Add:

```json
"deploy:windows:evidence-pack": "node scripts/windows-deploy-evidence-pack.mjs"
```

- [ ] **Step 4: Run focused verification**

Run:

```powershell
node --check scripts/windows-deploy-evidence-pack.mjs
node --test --test-concurrency=1 --test-isolation=none test/windows-deploy-evidence-pack-script.test.js
```

Expected: syntax exits `0` and the focused suite passes.

### Task 3: Document And Verify The Evidence Pack Batch

**Files:**
- Modify: `docs/windows-deployment-guide.md`
- Modify: `docs/project-roadmap-progress.md`
- Modify: `test/deploy-assets.test.js`

- [ ] **Step 1: Update deployment docs**

Add:

```powershell
npm.cmd run deploy:windows:evidence-pack
```

Document that it is safe before a server exists but is meant to guide evidence capture after manual start, healthcheck, HTTPS, and secret configuration.

- [ ] **Step 2: Extend deployment asset coverage**

Assert the Windows guide references:

```text
deploy:windows:evidence-pack
windows-deploy-evidence-pack.md
backup_restore_drill_result
live_write_smoke_result
full_test_window_passed
launch_day_watch_summary
first_wave_closeout
```

- [ ] **Step 3: Record the roadmap slice**

Add a latest-slice entry and a verification entry describing the evidence pack, safety boundary, focused tests, deployment-assets tests, pack generation, existing preflight/prepare-pack checks, route-map gate, secret-placeholder scan, and deferred full suite.

- [ ] **Step 4: Run final verification**

Run:

```powershell
node --check scripts/windows-deploy-evidence-pack.mjs
node --test --test-concurrency=1 --test-isolation=none test/windows-deploy-evidence-pack-script.test.js test/windows-first-deploy-pack-script.test.js test/windows-deploy-preflight-script.test.js test/deploy-assets.test.js
npm.cmd run deploy:windows:evidence-pack
npm.cmd run deploy:windows:prepare-pack
npm.cmd run deploy:windows:preflight
npm.cmd run launch:route-map-gate
git diff --check
```

Expected: syntax exits `0`, focused tests pass, generated packs contain no example secret placeholders, current preflight remains `not_deployed_yet`, route-map gate passes, and whitespace check exits `0`.

- [ ] **Step 5: Commit and push**

Run:

```powershell
git add -- package.json scripts/windows-deploy-evidence-pack.mjs test/windows-deploy-evidence-pack-script.test.js test/deploy-assets.test.js docs/windows-deployment-guide.md docs/project-roadmap-progress.md docs/superpowers/plans/2026-06-01-windows-deploy-evidence-pack.md
git commit -m "Add Windows deploy evidence pack"
git push
```
