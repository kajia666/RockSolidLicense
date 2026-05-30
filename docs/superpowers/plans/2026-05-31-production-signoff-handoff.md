# Production Sign-Off Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one compact read-only first-screen bridge from the guarded full-test window into production sign-off conditions and receipt visibility.

**Architecture:** Keep `productionSignoffExecutionEntrypoint` as the source of truth. Add one shared text formatter called beside the existing production sign-off entrypoint row so Launch Review, Launch Smoke, Launch Mainline, and Developer Ops inherit the same operator-driven handoff without new API fields, automatic writes, or an eleven-command first-screen dump.

**Tech Stack:** Node.js, built-in test runner, existing `src/services.js` text renderers, `test/license-flow.test.js`, Markdown roadmap.

---

### Task 1: Add failing first-screen production sign-off bridge assertions

**Files:**
- Modify: `D:\code\OnlineVerification\test\license-flow.test.js:13169`
- Modify: `D:\code\OnlineVerification\test\license-flow.test.js:13642`
- Modify: `D:\code\OnlineVerification\test\license-flow.test.js:25087`
- Modify: `D:\code\OnlineVerification\test\license-flow.test.js:28378`

- [x] **Step 1: Add the Launch Review and Launch Smoke assertions**

Add this assertion beside the existing `productionSignoffEntrypoint` assertion for each `FIRSTBATCH` summary:

```js
assert.match(
  summaryText,
  /productionSignoffHandoff=full_test_window -> full_test_window_passed_backfill -> readiness_readback -> rehearsal_reload -> production_signoff_conditions -> receipt_visibility \| fullTest=npm\.cmd test \| backfill=npm\.cmd run staging:signoff:backfill[^\n]*\| readback=npm\.cmd run staging:readiness:status[^\n]*\| rehearsal=npm\.cmd run staging:rehearsal[^\n]*\| expected=full_test_window:ready_full_test_window_evidence_attached \| signoffQueue=6 \| signoffFirst=npm\.cmd run staging:signoff:backfill[^\n]*\| receiptQueue=5 \| receiptFirst=npm\.cmd run staging:signoff:backfill[^\n]*\| packet=artifacts\/staging\/FIRSTBATCH\/stable\/staging-production-signoff-packet\.json \| status=blocked_until_real_environment_proof/
);
```

- [x] **Step 2: Add the Launch Mainline and Developer Ops assertions**

Add the equivalent assertion beside the existing `productionSignoffEntrypoint` output for each `EXPORT_CLOSEOUT_READY` output:

```js
assert.match(
  summaryText,
  /productionSignoffHandoff=full_test_window -> full_test_window_passed_backfill -> readiness_readback -> rehearsal_reload -> production_signoff_conditions -> receipt_visibility \| fullTest=npm\.cmd test \| backfill=npm\.cmd run staging:signoff:backfill[^\n]*\| readback=npm\.cmd run staging:readiness:status[^\n]*\| rehearsal=npm\.cmd run staging:rehearsal[^\n]*\| expected=full_test_window:ready_full_test_window_evidence_attached \| signoffQueue=6 \| signoffFirst=npm\.cmd run staging:signoff:backfill[^\n]*\| receiptQueue=5 \| receiptFirst=npm\.cmd run staging:signoff:backfill[^\n]*\| packet=artifacts\/staging\/EXPORT_CLOSEOUT_READY\/stable\/staging-production-signoff-packet\.json \| status=blocked_until_real_environment_proof/
);
```

- [x] **Step 3: Run the focused test and confirm RED**

Run:

```powershell
npm.cmd test -- test/license-flow.test.js --test-name-pattern "developer ops export bundles scoped data and downloadable assets"
```

Expected: `79 pass / 2 fail`, with failures caused only by missing `productionSignoffHandoff`.

### Task 2: Add the minimal shared formatter

**Files:**
- Modify: `D:\code\OnlineVerification\src\services.js:62440`
- Modify: `D:\code\OnlineVerification\src\services.js:62725`

- [x] **Step 1: Call the formatter inside the production sign-off entrypoint block**

```js
appendProductionSignoffHandoffLine(lines, productionSignoffExecutionEntrypoint);
```

- [x] **Step 2: Add the display-only formatter**

```js
function appendProductionSignoffHandoffLine(lines = [], entrypoint = null) {
  if (!Array.isArray(lines) || !entrypoint || typeof entrypoint !== "object") {
    return false;
  }
  const signoffCommands = Array.isArray(entrypoint.signoffConditionCommands)
    ? entrypoint.signoffConditionCommands.filter((item) => item && typeof item === "object")
    : [];
  const receiptCommands = Array.isArray(entrypoint.receiptVisibilityBackfillCommands)
    ? entrypoint.receiptVisibilityBackfillCommands.filter((item) => item && typeof item === "object")
    : [];
  lines.push(
    "- productionSignoffHandoff=full_test_window -> full_test_window_passed_backfill -> readiness_readback -> rehearsal_reload -> production_signoff_conditions -> receipt_visibility"
    + ` | fullTest=${entrypoint.fullTestCommand || "-"}`
    + ` | backfill=${entrypoint.fullTestBackfillCommand || "-"}`
    + ` | readback=${entrypoint.readinessRefreshCommand || "-"}`
    + ` | rehearsal=${entrypoint.rehearsalReloadCommand || "-"}`
    + " | expected=full_test_window:ready_full_test_window_evidence_attached"
    + ` | signoffQueue=${signoffCommands.length}`
    + ` | signoffFirst=${signoffCommands.find((item) => item.command)?.command || "-"}`
    + ` | receiptQueue=${receiptCommands.length}`
    + ` | receiptFirst=${receiptCommands.find((item) => item.command)?.command || "-"}`
    + ` | packet=${entrypoint.productionSignoffPacket || "-"}`
    + ` | status=${entrypoint.status || "-"}`
  );
  return true;
}
```

- [x] **Step 3: Run syntax checks**

Run:

```powershell
node --check src/services.js
node --check test/license-flow.test.js
```

Expected: both commands exit `0`.

- [x] **Step 4: Run the focused test and confirm GREEN**

Run:

```powershell
npm.cmd test -- test/license-flow.test.js --test-name-pattern "developer ops export bundles scoped data and downloadable assets"
```

Expected: `81 pass / 0 fail`.

### Task 3: Record progress and verify the launch gate

**Files:**
- Modify: `D:\code\OnlineVerification\docs\project-roadmap-progress.md:35`

- [x] **Step 1: Add one roadmap bullet**

```md
- Latest production signoff handoff slice: the same first-screen surfaces now also render `productionSignoffHandoff=...`, compressing the guarded full-test window -> `full_test_window_passed` backfill -> readiness readback -> rehearsal reload -> production sign-off conditions -> receipt visibility boundary into one compact operator row. The row keeps the complete `6+5` command queues in their existing deeper payloads while surfacing queue counts and the first command from each lane for launch-duty continuation.
```

- [x] **Step 2: Run static verification**

Run:

```powershell
node --check src/services.js
node --check test/license-flow.test.js
git diff --check
git diff --stat
```

Expected: syntax checks exit `0`; `git diff --check` reports no whitespace errors; the diff is limited to the formatter, assertions, roadmap, and this implementation plan.

- [x] **Step 3: Run the targeted launch gate**

Run:

```powershell
npm.cmd run launch:route-map-gate
```

Expected: all `17/17` route-map gate steps pass.

- [x] **Step 4: Review, commit, and push the meaningful slice**

Run:

```powershell
git status -sb
git diff --check
git add docs/project-roadmap-progress.md docs/superpowers/plans/2026-05-31-production-signoff-handoff.md src/services.js test/license-flow.test.js
git diff --cached --check
git commit -m "Surface production signoff handoff"
git push
git status -sb
git log -2 --oneline
```

Expected: the implementation commit and prior design commit are pushed together; the worktree is clean and synchronized with `origin/codex/production-switch-proof-hardening`.

### Task 4: Extend the same first-screen bridge into launch-day watch handoff

**Files:**
- Modify: `D:\code\OnlineVerification\test\license-flow.test.js`
- Modify: `D:\code\OnlineVerification\src\services.js`
- Modify: `D:\code\OnlineVerification\docs\project-roadmap-progress.md`

- [x] **Step 1: Add failing assertions for `launchDayWatchHandoff` on all mirrored surfaces**

Added `launchDayWatchHandoff=...` assertions beside existing `productionSignoffHandoff` checks for:
- Launch Review `FIRSTBATCH`
- Launch Smoke `FIRSTBATCH`
- Launch Mainline Launch Evidence Gate `EXPORT_CLOSEOUT_READY`
- Developer Ops Operator Queue Checkpoint `EXPORT_CLOSEOUT_READY`

- [x] **Step 2: Confirm RED on focused scope**

```powershell
npm.cmd test -- test/license-flow.test.js --test-name-pattern "developer ops export bundles scoped data and downloadable assets"
```

Observed RED: `79 pass / 2 fail`, failures caused by missing `launchDayWatchHandoff`.

- [x] **Step 3: Add shared launch-day-watch handoff formatter**

Implemented a display-only shared formatter:

```js
appendLaunchDayWatchHandoffLine(lines, launchDayWatchExecutionEntrypoint);
```

The formatter surfaces:
- fixed handoff chain (`production_signoff_evidence -> ... -> first_wave_closeout`)
- expected readiness gate
- watch record queue count and first record command
- readiness/rehearsal commands
- launch-day-watch artifact and first-wave closeout artifact
- production signoff packet and status

- [x] **Step 4: Re-run focused verification and roadmap update**

```powershell
node --check src/services.js
node --check test/license-flow.test.js
npm.cmd test -- test/license-flow.test.js --test-name-pattern "developer ops export bundles scoped data and downloadable assets"
```

Observed GREEN: `81 pass / 0 fail`.

Roadmap updated with a new “Latest launch-day watch handoff slice” bullet.

### Task 5: Add launch-day-watch readback handoff into stable operations

**Files:**
- Modify: `D:\code\OnlineVerification\test\license-flow.test.js`
- Modify: `D:\code\OnlineVerification\src\services.js`
- Modify: `D:\code\OnlineVerification\docs\project-roadmap-progress.md`

- [x] **Step 1: Add failing blocked-state and ready-state assertions**

Added `launchDayWatchReadbackHandoff=...` assertions for:
- Launch Review and Launch Smoke `FIRSTBATCH` blocked-state summaries
- Launch Mainline readiness gate and Developer Ops operator-entry blocked-state summaries
- Developer Ops, Launch Review, and Launch Smoke 6/6-record ready-state summaries

- [x] **Step 2: Confirm RED on focused scope**

```powershell
npm.cmd test -- test/license-flow.test.js --test-name-pattern "developer ops export bundles scoped data and downloadable assets"
```

Observed RED: `79 pass / 2 fail`, failures caused by missing `launchDayWatchReadbackHandoff`.

- [x] **Step 3: Add the shared readback formatter**

Implemented:

```js
appendLaunchDayWatchReadbackHandoffLine(
  lines,
  launchDayWatchExecutionEntrypoint,
  proofSource
);
```

The formatter surfaces:
- final `first_wave_closeout` write command
- readiness readback and rehearsal reload commands
- expected `ready_launch_day_watch_records_attached` gate
- stable-operations readiness command and steady-state handoff URL
- first-wave closeout artifact, shared record index, and blocked/ready status

- [x] **Step 4: Confirm GREEN**

```powershell
node --check src/services.js
node --check test/license-flow.test.js
npm.cmd test -- test/license-flow.test.js --test-name-pattern "developer ops export bundles scoped data and downloadable assets"
```

Observed GREEN: `81 pass / 0 fail`.

Roadmap updated with a new “Latest launch-day watch readback handoff slice” bullet.
