# Live-Write Smoke Readback Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one read-only first-screen bridge from `live_write_smoke_result` backfill through readiness readback and rehearsal reload into production sign-off entry.

**Architecture:** Keep the existing live-write smoke and production sign-off entrypoints as the source of truth. Add one shared text formatter called from the existing production-switch environment proof renderer so Launch Review, Launch Smoke, Launch Mainline, and Developer Ops inherit the same operator-driven handoff without new API fields or automatic writes.

**Tech Stack:** Node.js, built-in test runner, existing `src/services.js` text renderers, `test/license-flow.test.js`, Markdown roadmap.

---

### Task 1: Add failing first-screen readback bridge assertions

**Files:**
- Modify: `D:\code\OnlineVerification\test\license-flow.test.js:13158`
- Modify: `D:\code\OnlineVerification\test\license-flow.test.js:13627`
- Modify: `D:\code\OnlineVerification\test\license-flow.test.js:25068`
- Modify: `D:\code\OnlineVerification\test\license-flow.test.js:28355`

- [x] **Step 1: Add the Launch Review and Launch Smoke assertions**

Add this assertion beside the existing `liveWriteSmokeHandoff` assertion for each `FIRSTBATCH` summary:

```js
assert.match(
  summaryText,
  /liveWriteSmokeReadbackHandoff=live_write_smoke_result_backfill -> readiness_readback -> rehearsal_reload -> production_signoff_entry \| backfill=npm\.cmd run staging:closeout:backfill[^\n]*\| readback=npm\.cmd run staging:readiness:status[^\n]*\| rehearsal=npm\.cmd run staging:rehearsal[^\n]*\| expected=live_write_smoke:ready_live_write_smoke_evidence_attached \| next=production_signoff \| signoff=npm\.cmd test \| packet=artifacts\/staging\/FIRSTBATCH\/stable\/staging-production-signoff-packet\.json \| status=blocked_until_real_environment_proof/
);
```

- [x] **Step 2: Add the Launch Mainline and Developer Ops assertions**

Add the equivalent assertion beside the existing `liveWriteSmokeHandoff` assertion for each `EXPORT_CLOSEOUT_READY` output:

```js
assert.match(
  summaryText,
  /liveWriteSmokeReadbackHandoff=live_write_smoke_result_backfill -> readiness_readback -> rehearsal_reload -> production_signoff_entry \| backfill=npm\.cmd run staging:closeout:backfill[^\n]*\| readback=npm\.cmd run staging:readiness:status[^\n]*\| rehearsal=npm\.cmd run staging:rehearsal[^\n]*\| expected=live_write_smoke:ready_live_write_smoke_evidence_attached \| next=production_signoff \| signoff=npm\.cmd test \| packet=artifacts\/staging\/EXPORT_CLOSEOUT_READY\/stable\/staging-production-signoff-packet\.json \| status=blocked_until_real_environment_proof/
);
```

- [x] **Step 3: Run the focused test and confirm RED**

Run:

```powershell
npm.cmd test -- test/license-flow.test.js --test-name-pattern "developer ops export bundles scoped data and downloadable assets"
```

Expected: `79 pass / 2 fail`, with failures caused only by missing `liveWriteSmokeReadbackHandoff`.

### Task 2: Add the minimal shared formatter

**Files:**
- Modify: `D:\code\OnlineVerification\src\services.js:62428`
- Modify: `D:\code\OnlineVerification\src\services.js:62676`

- [x] **Step 1: Call the formatter after the production sign-off entrypoint is available**

Add the formatter call after the existing `productionSignoffEntrypoint=...` line:

```js
appendLiveWriteSmokeReadbackHandoffLine(
  lines,
  liveWriteSmokeExecutionEntrypoint,
  productionSignoffExecutionEntrypoint
);
```

- [x] **Step 2: Add the display-only formatter**

```js
function appendLiveWriteSmokeReadbackHandoffLine(
  lines = [],
  liveWriteSmokeEntrypoint = null,
  productionSignoffEntrypoint = null
) {
  if (!Array.isArray(lines) || !liveWriteSmokeEntrypoint || typeof liveWriteSmokeEntrypoint !== "object") {
    return false;
  }
  const signoffEntrypoint = productionSignoffEntrypoint && typeof productionSignoffEntrypoint === "object"
    ? productionSignoffEntrypoint
    : null;
  lines.push(
    "- liveWriteSmokeReadbackHandoff=live_write_smoke_result_backfill -> readiness_readback -> rehearsal_reload -> production_signoff_entry"
    + ` | backfill=${liveWriteSmokeEntrypoint.resultBackfillCommand || "-"}`
    + ` | readback=${liveWriteSmokeEntrypoint.readinessRefreshCommand || "-"}`
    + ` | rehearsal=${liveWriteSmokeEntrypoint.rehearsalReloadCommand || "-"}`
    + " | expected=live_write_smoke:ready_live_write_smoke_evidence_attached"
    + " | next=production_signoff"
    + ` | signoff=${signoffEntrypoint?.currentCommand || signoffEntrypoint?.fullTestCommand || signoffEntrypoint?.productionSignoffBackfillCommand || "-"}`
    + ` | packet=${signoffEntrypoint?.productionSignoffPacket || "-"}`
    + ` | status=${liveWriteSmokeEntrypoint.status || "-"}`
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
- Modify: `D:\code\OnlineVerification\docs\project-roadmap-progress.md:33`

- [x] **Step 1: Add one roadmap bullet**

```md
- Latest live-write smoke readback handoff slice: the same first-screen surfaces now also render `liveWriteSmokeReadbackHandoff=...`, compressing the guarded `live_write_smoke_result` backfill -> readiness readback -> rehearsal reload -> production-signoff entry boundary into one operator row. This keeps result confirmation explicit and operator-driven while removing the remaining lookup gap before the production-signoff lane.
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
git add docs/project-roadmap-progress.md docs/superpowers/plans/2026-05-31-live-write-smoke-readback-handoff.md src/services.js test/license-flow.test.js
git diff --cached --check
git commit -m "Surface live-write smoke readback handoff"
git push
git status -sb
git log -2 --oneline
```

Expected: the implementation commit and prior design commit are pushed together; the worktree is clean and synchronized with `origin/codex/production-switch-proof-hardening`.
