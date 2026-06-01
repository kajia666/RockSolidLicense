# Profile Init Production Switch Stable Proof Packet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `staging:profile:init` production-switch proof archives through the first stable-operations proof window without adding routes or write steps.

**Architecture:** Reuse the existing `stableOperationsHandoff.postHandoffProofQueue` built by profile init. Pass that object into the production-switch packet builder, expose a packet summary, append one ordered proof row, and print one compact summary line.

**Tech Stack:** Node.js ESM, built-in `node:test`, PowerShell, Markdown.

---

### Task 1: Lock The Missing Archive Behavior With A Failing Test

**Files:**
- Modify: `test/staging-profile-init-script.test.js`

- [x] **Step 1: Extend the JSON expectation**

Add `stableOperationsFirstWindowProof` to the expected packet:

```js
stableOperationsFirstWindowProof: {
  status: "blocked_until_first_wave_closeout_recorded",
  proofQueueStatus: "blocked_after_stable_operations_handoff",
  proofDownloadCount: 7,
  firstProofDownloadTarget: stableOperationsProofQueue[0].target,
  postHandoffProofQueue: stableOperationsProofQueue,
  handoffArtifacts: [launchDutyRecordIndexFile, firstWaveCloseoutFile],
  launchDutyRecordIndexFile,
  firstWaveCloseoutArtifactPath: firstWaveCloseoutFile
},
```

Append the ninth expected proof item:

```js
{
  order: 9,
  key: "stable_operations_first_window_proof",
  status: "blocked_after_stable_operations_handoff",
  command: stableOperationsProofQueue[0].target,
  artifactPath: launchDutyRecordIndexFile,
  nextAction: "Verify the first-result and rollout-widening proof queue before widening the stable operating window."
}
```

Update packet counts from `8` to `9`, and add plain-output assertions for the summary and ninth row.

- [x] **Step 2: Run the focused test to verify RED**

Run:

```powershell
node --test --test-concurrency=1 --test-isolation=none test/staging-profile-init-script.test.js
```

Expected: FAIL because `productionSwitchProofPacket` does not yet expose `stableOperationsFirstWindowProof`, still returns eight rows, and does not print the ninth row.

### Task 2: Reuse The Existing Stable Proof Queue In The Packet

**Files:**
- Modify: `scripts/staging-profile-init.mjs`
- Test: `test/staging-profile-init-script.test.js`

- [x] **Step 1: Add the packet summary**

Accept `stableOperationsHandoff` in `buildProductionSwitchProofPacket`, derive the first target from the existing queue, and expose:

```js
const stableOperationsFirstWindowProof = {
  status: stableOperationsHandoff.status,
  proofQueueStatus: stableOperationsHandoff.proofQueueStatus,
  proofDownloadCount: stableOperationsHandoff.postHandoffProofQueue.length,
  firstProofDownloadTarget: stableOperationsHandoff.postHandoffProofQueue[0]?.target || null,
  postHandoffProofQueue: stableOperationsHandoff.postHandoffProofQueue,
  handoffArtifacts: stableOperationsHandoff.handoffArtifacts,
  launchDutyRecordIndexFile: stableOperationsHandoff.recordIndexFile,
  firstWaveCloseoutArtifactPath: stableOperationsHandoff.firstWaveCloseoutArtifactPath
};
```

- [x] **Step 2: Append the ninth ordered proof item**

Append:

```js
{
  order: 9,
  key: "stable_operations_first_window_proof",
  status: stableOperationsFirstWindowProof.proofQueueStatus,
  command: stableOperationsFirstWindowProof.firstProofDownloadTarget,
  artifactPath: stableOperationsFirstWindowProof.launchDutyRecordIndexFile,
  nextAction: "Verify the first-result and rollout-widening proof queue before widening the stable operating window."
}
```

Return `stableOperationsFirstWindowProof`, pass `stableOperationsHandoff` from `main`, and update the packet next action to include stable first-window proof downloads.

- [x] **Step 3: Print the compact packet summary**

In `writeProductionSwitchProofPacketPlain`, print:

```js
console.log(
  `Production switch stable first-window proof: ${stableOperationsFirstWindowProof.status || "-"}`
    + ` (queue=${stableOperationsFirstWindowProof.proofQueueStatus || "-"}`
    + `, first=${stableOperationsFirstWindowProof.firstProofDownloadTarget || "-"}`
    + `, downloads=${stableOperationsFirstWindowProof.proofDownloadCount ?? "-"})`
);
```

- [x] **Step 4: Run focused checks to verify GREEN**

Run:

```powershell
node --check scripts/staging-profile-init.mjs
node --test --test-concurrency=1 --test-isolation=none test/staging-profile-init-script.test.js
```

Expected: syntax check exits `0`; focused tests pass.

### Task 3: Record The Slice And Verify The Launch Gate

**Files:**
- Modify: `docs/project-roadmap-progress.md`
- Create: `docs/superpowers/plans/2026-06-01-profile-init-production-switch-stable-proof-packet.md`

- [x] **Step 1: Update the roadmap**

Add one latest-slice entry describing the ninth packet row, seven reused read-only downloads, compact plain output, and the absence of new routes or write operations.

- [x] **Step 2: Run the targeted launch gate and hygiene checks**

Run:

```powershell
npm.cmd run launch:route-map-gate
git diff --check
rg -n "ready=3/8|blocked=5/8|total: 8|ready: 4,|blocked: 4" test/staging-profile-init-script.test.js scripts/staging-profile-init.mjs docs/project-roadmap-progress.md
```

Expected: route-map gate passes, whitespace check exits `0`, and stale-count search prints no matches.

- [x] **Step 3: Commit and push the meaningful slice**

Run:

```powershell
git add -- scripts/staging-profile-init.mjs test/staging-profile-init-script.test.js docs/project-roadmap-progress.md docs/superpowers/plans/2026-06-01-profile-init-production-switch-stable-proof-packet.md
git commit -m "Add profile init stable proof packet"
git push
```
