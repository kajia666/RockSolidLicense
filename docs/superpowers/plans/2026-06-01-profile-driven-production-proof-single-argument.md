# Profile-Driven Production Proof Single-Argument Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize generated profile-driven production-proof commands to `launch:production-proof-preflight -- --profile-file <staging-profile.json>` while preserving explicit direct-CLI execution-pack support and older profile compatibility.

**Architecture:** Keep `productionProofExecutionPackFile` in the secret-free profile as the source of the Markdown execution-pack path. Remove the redundant `--execution-pack-file` argument only from profile-driven command renderers in profile init, profile check, and rehearsal. Leave `launch:production-proof-preflight` option parsing unchanged so explicit direct CLI calls and older operator commands remain accepted.

**Tech Stack:** Node.js ESM scripts, Node test runner, npm scripts, PowerShell, Git.

---

### Task 1: Make Profile-Driven Command Expectations Fail

**Files:**
- Modify: `test/staging-profile-check-script.test.js`
- Modify: `test/staging-profile-init-script.test.js`
- Modify: `test/staging-rehearsal-script.test.js`

- [ ] **Step 1: Update the profile-check expected next command**

Change the passing example assertion to:

```js
assert.equal(
  output.nextCommand,
  "npm.cmd run launch:production-proof-preflight -- --profile-file docs/staging-rehearsal-profile.example.json"
);
```

- [ ] **Step 2: Update profile-init expected command values and plain-output assertion**

Use:

```js
const productionProofPreflightCommand =
  `npm.cmd run launch:production-proof-preflight -- --profile-file ${outputFile}`;
```

Update the plain-output regex so it stops after `staging-profile.json`.

- [ ] **Step 3: Update rehearsal normalization assertions**

Use:

```js
const productionProofPreflightCommand =
  `npm.cmd run launch:production-proof-preflight -- --profile-file ${profileFile}`;
```

Keep `embeddedProductionProofPreflightCommand` in the fixture as the older two-argument form so the test proves compatibility normalization.

- [ ] **Step 4: Run focused tests and verify RED**

Run:

```powershell
node --test --test-concurrency=1 --test-isolation=none test/staging-profile-check-script.test.js
node --test --test-concurrency=1 --test-isolation=none test/staging-profile-init-script.test.js
node --test --test-concurrency=1 --test-isolation=none test/staging-rehearsal-script.test.js
```

Expected: failures showing emitted commands still include `--execution-pack-file`.

### Task 2: Normalize Profile-Driven Command Renderers

**Files:**
- Modify: `scripts/staging-profile-check.mjs`
- Modify: `scripts/staging-profile-init.mjs`
- Modify: `scripts/staging-rehearsal.mjs`
- Modify: `docs/staging-rehearsal-profile.example.json`

- [ ] **Step 1: Simplify profile-check command rendering and validation**

Make `buildProductionProofPreflightCommand(profileFile)` return:

```js
return [
  "npm.cmd run launch:production-proof-preflight --",
  "--profile-file",
  commandValue(profileFile)
].join(" ");
```

Validate the stored command against the normalized output or the known legacy two-argument form, then expose whether normalization was required:

```js
const expectedProductionProofCommand =
  buildProductionProofPreflightCommand(profileFile);
const legacyProductionProofCommand =
  productionProofCommand === buildLegacyProductionProofPreflightCommand(
    profileFile,
    profile.productionProofExecutionPackFile
  );
const productionProofCommandReady =
  productionProofCommand === expectedProductionProofCommand
  || legacyProductionProofCommand;
```

- [ ] **Step 2: Simplify profile-init command rendering**

Make `buildProductionProofPreflightCommand({ outputFile })` return only:

```js
return [
  "npm.cmd run launch:production-proof-preflight --",
  "--profile-file",
  commandValue(outputFile)
].join(" ");
```

Continue storing `productionProofExecutionPackFile` separately in the generated profile.

- [ ] **Step 3: Simplify rehearsal profile-driven normalization**

For `options.profileFile`, return only:

```js
return [
  "npm.cmd run launch:production-proof-preflight --",
  "--profile-file",
  commandValue(options.profileFile)
].join(" ");
```

Leave the direct-CLI branch unchanged.

- [ ] **Step 4: Synchronize the committed example profile**

Set:

```json
"productionProofPreflightCommand": "npm.cmd run launch:production-proof-preflight -- --profile-file docs/staging-rehearsal-profile.example.json"
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the three commands from Task 1 Step 4.

Expected: all focused tests pass.

- [ ] **Step 6: Strengthen profile-only production-proof coverage**

Update `test/production-proof-preflight-script.test.js` so its profile bridge fixture writes `productionProofExecutionPackFile` into the profile and invokes preflight with only:

```js
["--profile-file", profileFile]
```

Run:

```powershell
node --test --test-concurrency=1 --test-isolation=none test/production-proof-preflight-script.test.js
```

Expected: pass, including the generated secret-free Markdown execution pack.

### Task 3: Update Operator Documentation and Verify the Launch Gate

**Files:**
- Modify: `docs/developer-launch-smoke.md`
- Modify: `docs/project-roadmap-progress.md`

- [ ] **Step 1: Update operator documentation**

State that profile-driven production proof uses only `--profile-file`; the profile metadata supplies the execution-pack path. Keep direct CLI fallback documentation with explicit `--execution-pack-file`.

- [ ] **Step 2: Record the roadmap progress slice**

Add a 2026-06-01 line describing the one-argument profile-driven handoff, older profile compatibility, and unchanged manual live-write gate.

- [ ] **Step 3: Run the secret-free profile command**

Run:

```powershell
npm.cmd run staging:profile:check -- --profile-file docs/staging-rehearsal-profile.example.json
```

Expected: pass with a one-argument next command.

- [ ] **Step 4: Run targeted launch verification**

Run:

```powershell
npm.cmd run launch:route-map-gate
```

Expected: all targeted gate steps pass.

- [ ] **Step 5: Run staged whitespace verification**

Run:

```powershell
git diff --check
```

Expected: exit code `0`.

- [ ] **Step 6: Commit and push the meaningful slice**

Run:

```powershell
git add -- docs/developer-launch-smoke.md docs/project-roadmap-progress.md docs/staging-rehearsal-profile.example.json docs/superpowers/plans/2026-06-01-profile-driven-production-proof-single-argument.md scripts/staging-profile-check.mjs scripts/staging-profile-init.mjs scripts/staging-rehearsal.mjs test/staging-profile-check-script.test.js test/staging-profile-init-script.test.js test/staging-rehearsal-script.test.js
git diff --cached --check
git commit -m "Normalize profile-driven production proof command"
git push
```

Expected: branch upstream advances and worktree is clean.
