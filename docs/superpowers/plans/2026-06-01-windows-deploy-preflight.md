# Windows Deploy Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Windows deployment preparation command that reports whether the repository and future `C:\RockSolidLicense` installation directory are ready for manual start.

**Architecture:** Create one Node.js ESM CLI that reads repository assets, the current Node version, and a configurable target directory. It reports one state and a short operator handoff without creating files, starting services, registering tasks, changing firewall rules, or running backups.

**Tech Stack:** Node.js ESM, built-in `node:test`, PowerShell, Markdown.

---

### Task 1: Lock The Read-Only Deployment States With Failing Tests

**Files:**
- Create: `test/windows-deploy-preflight-script.test.js`

- [ ] **Step 1: Add a focused CLI test suite**

Create tests that run:

```js
spawnSync(process.execPath, [
  "scripts/windows-deploy-preflight.mjs",
  "--json",
  "--target-dir",
  targetDir
], { cwd: repoRoot, encoding: "utf8" });
```

Cover:

```text
not_deployed_yet
needs_env_setup
ready_for_manual_start
fail when --repo-root omits a required asset
plain output boundary text
--help
package.json deploy:windows:preflight entry
```

Assert that informational states exit `0`, fatal asset gaps exit `1`, and no missing target directory is created.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```powershell
node --test --test-concurrency=1 --test-isolation=none test/windows-deploy-preflight-script.test.js
```

Expected: FAIL because `scripts/windows-deploy-preflight.mjs` and `deploy:windows:preflight` do not exist yet.

### Task 2: Add The Read-Only Windows Deploy Preflight CLI

**Files:**
- Create: `scripts/windows-deploy-preflight.mjs`
- Modify: `package.json`
- Test: `test/windows-deploy-preflight-script.test.js`

- [ ] **Step 1: Add argument parsing**

Support:

```text
--target-dir <path>
--repo-root <path>
--json
--help
```

Default `targetDir` to `C:\RockSolidLicense` and `repoRoot` to the repository root beside the script.

- [ ] **Step 2: Add repository and target checks**

Check Node.js major version `24+` and the required repository assets from the design. Read:

```text
<targetDir>
<targetDir>\deploy\windows\rocksolid.env.ps1
```

Return:

```text
fail
not_deployed_yet
needs_env_setup
ready_for_manual_start
```

- [ ] **Step 3: Add operator handoff output**

Print JSON and plain output with:

```text
status
summary.willModifyData=false
summary.willWriteFiles=false
summary.willStartService=false
summary.willRegisterScheduledTasks=false
summary.willChangeFirewall=false
node
repositoryAssets
targetDirectory
operatorHandoff
```

The handoff prints the safe ordered deployment steps and the boundary reminder.

- [ ] **Step 4: Add the npm script**

Add:

```json
"deploy:windows:preflight": "node scripts/windows-deploy-preflight.mjs"
```

- [ ] **Step 5: Verify GREEN**

Run:

```powershell
node --check scripts/windows-deploy-preflight.mjs
node --test --test-concurrency=1 --test-isolation=none test/windows-deploy-preflight-script.test.js
npm.cmd run deploy:windows:preflight
```

Expected: syntax exits `0`, focused tests pass, and the current undeployed workspace prints `not_deployed_yet`.

### Task 3: Document And Verify The Deployment Preparation Slice

**Files:**
- Modify: `docs/windows-deployment-guide.md`
- Modify: `docs/project-roadmap-progress.md`
- Modify: `test/deploy-assets.test.js`
- Create: `docs/superpowers/plans/2026-06-01-windows-deploy-preflight.md`

- [ ] **Step 1: Update deployment docs and asset checks**

Add a Windows guide section before manual start:

```powershell
npm.cmd run deploy:windows:preflight
```

Explain that `C:\RockSolidLicense` is the recommended future server install path and missing target directory means deployment has not started yet.

Extend `test/deploy-assets.test.js` to verify the guide references the preflight command.

- [ ] **Step 2: Record the roadmap slice**

Add one latest-slice entry and one verification entry describing the read-only command, four states, safe boundary, focused tests, deployment-assets tests, route-map gate, and deferred full suite.

- [ ] **Step 3: Run verification**

Run:

```powershell
node --check scripts/windows-deploy-preflight.mjs
node --test --test-concurrency=1 --test-isolation=none test/windows-deploy-preflight-script.test.js test/deploy-assets.test.js
npm.cmd run deploy:windows:preflight
npm.cmd run launch:route-map-gate
git diff --check
```

Expected: syntax exits `0`, focused tests pass, current workspace reports `not_deployed_yet`, route-map gate passes, and whitespace check exits `0`.

- [ ] **Step 4: Commit and push the meaningful slice**

Run:

```powershell
git add -- package.json scripts/windows-deploy-preflight.mjs test/windows-deploy-preflight-script.test.js test/deploy-assets.test.js docs/windows-deployment-guide.md docs/project-roadmap-progress.md docs/superpowers/plans/2026-06-01-windows-deploy-preflight.md
git commit -m "Add Windows deploy preflight"
git push
```

