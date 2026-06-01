# Staging Profile Init Stable Proof Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `staging:profile:init` so its real staging operator package continues from stable-operations handoff into the same seven read-only first stable-window proof downloads exposed by `launch:route-map-gate`.

**Architecture:** Keep the route semantics local to `scripts/staging-profile-init.mjs`, matching the existing route-map gate contract without importing across CLI scripts. Build the queue once from validated profile product/channel and the shared launch-duty record-index path, store it under `stableOperationsHandoff`, reuse it in one appended operator row, and carry the row into the stable-operations execution phase and checkpoint counts.

**Tech Stack:** Node.js ESM CLI scripts, Node built-in test runner, PowerShell-compatible npm commands, Markdown launch documentation.

---

### Task 1: Lock Profile Init Stable Proof Queue Behavior

**Files:**
- Modify: `test/staging-profile-init-script.test.js`

- [ ] **Step 1: Write the failing JSON assertions**

Update the focused `staging profile init writes a secret-free profile with launch-duty output paths` expectations:

```js
const stableOperationsProofQueue = [
  {
    order: 1,
    key: "verify_stable_rollout_widening_decision",
    label: "Verify stable rollout widening decision",
    status: "blocked_after_stable_operations_handoff",
    kind: "download",
    sourceBridge: "stableOperationsRolloutWideningBridge",
    target: "/api/developer/launch-mainline/download?productCode=PILOT_ALPHA&channel=beta&reviewMode=matched&format=rollout-widening-decision-execution",
    launchDutyRecordIndexPath: launchDutyRecordIndexFile
  },
  {
    order: 2,
    key: "verify_stable_first_result_handoff",
    label: "Verify stable first operating result handoff",
    status: "blocked_after_rollout_widening_decision",
    kind: "download",
    sourceBridge: "stableOperationsFirstResultBridge",
    target: "/api/developer/launch-mainline/download?productCode=PILOT_ALPHA&channel=beta&reviewMode=matched&format=first-operating-result-handoff-execution",
    launchDutyRecordIndexPath: launchDutyRecordIndexFile
  },
  {
    order: 3,
    key: "verify_stable_first_result_receipt_readback",
    label: "Verify stable first operating result receipt readback",
    status: "blocked_after_first_result_handoff",
    kind: "download",
    sourceBridge: "stableOperationsFirstResultBridge",
    target: "/api/developer/launch-mainline/download?productCode=PILOT_ALPHA&channel=beta&reviewMode=matched&format=first-operating-result-handoff-receipt-readback-execution",
    launchDutyRecordIndexPath: launchDutyRecordIndexFile
  },
  {
    order: 4,
    key: "verify_stable_first_result_review",
    label: "Verify stable first operating result review",
    status: "blocked_after_first_result_receipt_readback",
    kind: "download",
    sourceBridge: "stableOperationsFirstResultBridge",
    target: "/api/developer/launch-mainline/download?productCode=PILOT_ALPHA&channel=beta&reviewMode=matched&format=first-operating-result-review-execution",
    launchDutyRecordIndexPath: launchDutyRecordIndexFile
  },
  {
    order: 5,
    key: "verify_stable_next_rollout_decision",
    label: "Verify stable next rollout decision",
    status: "blocked_after_first_result_review",
    kind: "download",
    sourceBridge: "stableOperationsRolloutWideningBridge",
    target: "/api/developer/launch-mainline/download?productCode=PILOT_ALPHA&channel=beta&reviewMode=matched&format=next-rollout-widening-decision-execution",
    launchDutyRecordIndexPath: launchDutyRecordIndexFile
  },
  {
    order: 6,
    key: "verify_stable_widened_rollout_monitoring",
    label: "Verify stable widened rollout monitoring",
    status: "blocked_after_next_rollout_decision",
    kind: "download",
    sourceBridge: "stableOperationsRolloutWideningBridge",
    target: "/api/developer/launch-mainline/download?productCode=PILOT_ALPHA&channel=beta&reviewMode=matched&format=widened-rollout-monitoring-execution",
    launchDutyRecordIndexPath: launchDutyRecordIndexFile
  },
  {
    order: 7,
    key: "verify_stable_ops_overview_status",
    label: "Verify stable Ops overview status",
    status: "blocked_after_widened_rollout_monitoring",
    kind: "download",
    sourceBridge: "stableOperationsRolloutWideningReadinessBridge",
    target: "/api/developer/ops/export/download?productCode=PILOT_ALPHA&channel=beta&limit=80&format=launch-operations-overview-status",
    launchDutyRecordIndexPath: launchDutyRecordIndexFile
  }
];
```

Add `proofQueueStatus`, `postHandoffProofQueue`, and the updated `nextAction` to both `output.stableOperationsHandoff` expectations. Append:

```js
{
  key: "verify_stable_operations_first_result_and_rollout",
  status: "blocked_after_stable_operations_handoff",
  command: null,
  target: stableOperationsProofQueue[0].target,
  queue: stableOperationsProofQueue,
  artifactPath: firstWaveCloseoutFile,
  targetKey: "stable_operations_first_result_and_rollout",
  recordIndexFile: launchDutyRecordIndexFile,
  handoffArtifacts: [launchDutyRecordIndexFile, firstWaveCloseoutFile],
  nextAction: "Open the rollout widening, first operating result, next rollout, widened monitoring, and overview-status direct files before widening the stable operating window."
}
```

Update checkpoint totals from `39/38` to `40/39`, set `stableOperationsCommandCount: 4`, add `stableOperationsProofDownloadCount: 7`, and append the new row to the `stable_operations_handoff` phase so its command count changes from `3` to `4`.

- [ ] **Step 2: Write the failing plain-output assertions**

Update the focused plain output test:

```js
assert.match(result.stdout, /Operator queue checkpoint: profile_rehearsal \(status=awaiting_profile_rehearsal, total=40, blocked=39\)/);
assert.match(result.stdout, /Operator queue counts: postSmoke=4, signoff=6, receipts=5, launchDutyRecords=6, stableOps=4, stableProof=7/);
assert.match(result.stdout, /Stable-operations proof queue: blocked_after_stable_operations_handoff \| first=\/api\/developer\/launch-mainline\/download\?productCode=PILOT_ALPHA&channel=beta&reviewMode=matched&format=rollout-widening-decision-execution \| count=7/);
```

Update the phase-plan plain expectation from `commands=39` to `commands=40`.

- [ ] **Step 3: Run the focused test to verify RED**

Run:

```powershell
node --test --test-concurrency=1 --test-isolation=none test/staging-profile-init-script.test.js
```

Expected: FAIL because `stableOperationsHandoff.postHandoffProofQueue`, the appended operator row, and `stableOperationsProofDownloadCount` do not exist yet.

### Task 2: Implement the Profile Init Stable Proof Queue

**Files:**
- Modify: `scripts/staging-profile-init.mjs`

- [ ] **Step 1: Add the queue builder**

Add a helper beside the existing stable-operations helpers:

```js
function buildStableOperationsPostHandoffProofQueue(productCode, channel, launchDutyRecordIndexPath) {
  const downloads = [
    {
      key: "verify_stable_rollout_widening_decision",
      label: "Verify stable rollout widening decision",
      status: "blocked_after_stable_operations_handoff",
      sourceBridge: "stableOperationsRolloutWideningBridge",
      target: `/api/developer/launch-mainline/download?productCode=${productCode}&channel=${channel}&reviewMode=matched&format=rollout-widening-decision-execution`
    },
    {
      key: "verify_stable_first_result_handoff",
      label: "Verify stable first operating result handoff",
      status: "blocked_after_rollout_widening_decision",
      sourceBridge: "stableOperationsFirstResultBridge",
      target: `/api/developer/launch-mainline/download?productCode=${productCode}&channel=${channel}&reviewMode=matched&format=first-operating-result-handoff-execution`
    },
    {
      key: "verify_stable_first_result_receipt_readback",
      label: "Verify stable first operating result receipt readback",
      status: "blocked_after_first_result_handoff",
      sourceBridge: "stableOperationsFirstResultBridge",
      target: `/api/developer/launch-mainline/download?productCode=${productCode}&channel=${channel}&reviewMode=matched&format=first-operating-result-handoff-receipt-readback-execution`
    },
    {
      key: "verify_stable_first_result_review",
      label: "Verify stable first operating result review",
      status: "blocked_after_first_result_receipt_readback",
      sourceBridge: "stableOperationsFirstResultBridge",
      target: `/api/developer/launch-mainline/download?productCode=${productCode}&channel=${channel}&reviewMode=matched&format=first-operating-result-review-execution`
    },
    {
      key: "verify_stable_next_rollout_decision",
      label: "Verify stable next rollout decision",
      status: "blocked_after_first_result_review",
      sourceBridge: "stableOperationsRolloutWideningBridge",
      target: `/api/developer/launch-mainline/download?productCode=${productCode}&channel=${channel}&reviewMode=matched&format=next-rollout-widening-decision-execution`
    },
    {
      key: "verify_stable_widened_rollout_monitoring",
      label: "Verify stable widened rollout monitoring",
      status: "blocked_after_next_rollout_decision",
      sourceBridge: "stableOperationsRolloutWideningBridge",
      target: `/api/developer/launch-mainline/download?productCode=${productCode}&channel=${channel}&reviewMode=matched&format=widened-rollout-monitoring-execution`
    },
    {
      key: "verify_stable_ops_overview_status",
      label: "Verify stable Ops overview status",
      status: "blocked_after_widened_rollout_monitoring",
      sourceBridge: "stableOperationsRolloutWideningReadinessBridge",
      target: `/api/developer/ops/export/download?productCode=${productCode}&channel=${channel}&limit=80&format=launch-operations-overview-status`
    }
  ];
  return downloads.map((item, index) => ({
    order: index + 1,
    ...item,
    kind: "download",
    launchDutyRecordIndexPath
  }));
}
```

- [ ] **Step 2: Attach the queue and operator row**

Build the queue before `stableOperationsHandoff`, add:

```js
proofQueueStatus: "blocked_after_stable_operations_handoff",
postHandoffProofQueue,
```

Append:

```js
{
  key: "verify_stable_operations_first_result_and_rollout",
  status: "blocked_after_stable_operations_handoff",
  command: null,
  target: stableOperationsHandoff.postHandoffProofQueue[0]?.target || null,
  queue: stableOperationsHandoff.postHandoffProofQueue,
  artifactPath: stableOperationsHandoff.firstWaveCloseoutArtifactPath,
  targetKey: "stable_operations_first_result_and_rollout",
  recordIndexFile: launchDutyRecordIndexFile,
  handoffArtifacts: stableOperationsHandoff.handoffArtifacts,
  nextAction: "Open the rollout widening, first operating result, next rollout, widened monitoring, and overview-status direct files before widening the stable operating window."
}
```

- [ ] **Step 3: Align checkpoint, phase, and plain output**

Count the new operator key in `stableOperationsCommandCount`, derive:

```js
const stableOperationsProofQueue = operatorNextCommands
  .find((item) => item.key === "verify_stable_operations_first_result_and_rollout")
  ?.queue || [];
```

Expose:

```js
stableOperationsProofDownloadCount: stableOperationsProofQueue.length
```

Append the operator key to `LAUNCH_EXECUTION_PHASES` stable-operations phase, print `stableProof=...` in the checkpoint, and print:

```js
console.log(
  `Stable-operations proof queue: ${stableOperationsProofQueue.status || "-"}`
    + ` | first=${stableOperationsProofQueue.target || "-"}`
    + ` | count=${stableOperationsProofQueue.queue?.length || 0}`
);
```

- [ ] **Step 4: Run syntax and focused tests to verify GREEN**

Run:

```powershell
node --check scripts/staging-profile-init.mjs
node --test --test-concurrency=1 --test-isolation=none test/staging-profile-init-script.test.js
```

Expected: syntax exit `0`; profile-init focused tests pass.

### Task 3: Update Rolling Launch Documentation

**Files:**
- Modify: `docs/project-roadmap-progress.md`

- [ ] **Step 1: Add the completed slice description**

Add a current slice entry explaining that `staging:profile:init` now appends `verify_stable_operations_first_result_and_rollout`, mirrors the seven read-only route-map proof downloads, and reports `stableOps=4` plus `stableProof=7`.

- [ ] **Step 2: Record fresh verification evidence**

After verification, add the exact focused test, targeted gate, and diff-check results. Keep the full-suite note explicit: `npm.cmd test` remains deferred until the next full-test window.

### Task 4: Verify and Publish the Meaningful Slice

**Files:**
- Verify: `scripts/staging-profile-init.mjs`
- Verify: `test/staging-profile-init-script.test.js`
- Verify: `docs/project-roadmap-progress.md`

- [ ] **Step 1: Run the targeted launch gate**

Run:

```powershell
npm.cmd run launch:route-map-gate
```

Expected: all targeted launch groups pass.

- [ ] **Step 2: Run whitespace and route checks**

Run:

```powershell
git diff --check
rg -n "ops/export/download\\?[^\\r\\n]*(first-operating-result|rollout-widening-decision-execution|next-rollout-widening-decision-execution|widened-rollout-monitoring-execution)" docs scripts test -g "*.md" -g "*.mjs" -g "*.js"
```

Expected: `git diff --check` exits `0`; the route grep returns no unsupported direct-execution URL matches.

- [ ] **Step 3: Commit and push**

Run:

```powershell
git add docs/superpowers/plans/2026-06-01-staging-profile-init-stable-proof-queue.md docs/project-roadmap-progress.md scripts/staging-profile-init.mjs test/staging-profile-init-script.test.js
git commit -m "Add profile init stable proof queue"
git push
```

Expected: one meaningful implementation commit is pushed to `codex/production-switch-proof-hardening`.
