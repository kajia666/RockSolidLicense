# Windows First Deploy Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local CLI that generates a secret-free Markdown handoff pack for the first Windows deployment without modifying the future installation directory.

**Architecture:** Create one Node.js ESM generator beside the existing Windows deploy preflight CLI. The generator accepts a future target directory and Markdown output file, rejects output paths inside the future installation directory, writes only the generated pack, and reports a machine-readable safety summary plus ordered operator steps.

**Tech Stack:** Node.js ESM, built-in `node:test`, PowerShell commands rendered as Markdown, Markdown documentation.

---

### Task 1: Lock The Generator Contract With Failing Tests

**Files:**
- Create: `test/windows-first-deploy-pack-script.test.js`

- [ ] **Step 1: Add focused CLI tests**

Create tests that invoke:

```js
spawnSync(process.execPath, [
  "scripts/windows-first-deploy-pack.mjs",
  "--json",
  "--target-dir",
  targetDir,
  "--output-file",
  outputFile
], { cwd: repoRoot, encoding: "utf8" });
```

Cover:

```text
package.json deploy:windows:prepare-pack entry
default secret-free Markdown generation
custom target and output path
JSON safety flags
unknown option rejection
missing --output-file value rejection
output inside target-directory rejection
--help
```

- [ ] **Step 2: Run the focused suite to verify RED**

Run:

```powershell
node --test --test-concurrency=1 --test-isolation=none test/windows-first-deploy-pack-script.test.js
```

Expected: FAIL because `scripts/windows-first-deploy-pack.mjs` and `deploy:windows:prepare-pack` do not exist.

### Task 2: Add The Secret-Free Windows Deploy Pack Generator

**Files:**
- Create: `scripts/windows-first-deploy-pack.mjs`
- Modify: `package.json`
- Test: `test/windows-first-deploy-pack-script.test.js`

- [ ] **Step 1: Add argument parsing and output-path protection**

Support:

```text
--target-dir <path>
--output-file <path>
--json
--help
```

Default to:

```text
C:\RockSolidLicense
artifacts/deploy/windows/windows-first-deploy-pack.md
```

Reject an output file equal to or contained by the future target directory.

- [ ] **Step 2: Render the pack and machine-readable result**

Write a Markdown pack with:

```text
read-only deploy:windows:preflight
expected preflight states
env example and local env paths
RSL_ADMIN_PASSWORD and RSL_SERVER_TOKEN_SECRET names
manual start
local healthcheck
post-healthcheck Scheduled Task, firewall, backup, PostgreSQL backup, and HTTPS actions
not_deployed_yet explanation
```

Return `status=prepared`, generated output path, target directory, ordered steps, and false safety flags for target mutation, copy, start, task registration, firewall changes, and backup execution.

- [ ] **Step 3: Add the npm script**

Add:

```json
"deploy:windows:prepare-pack": "node scripts/windows-first-deploy-pack.mjs"
```

- [ ] **Step 4: Run focused verification**

Run:

```powershell
node --check scripts/windows-first-deploy-pack.mjs
node --test --test-concurrency=1 --test-isolation=none test/windows-first-deploy-pack-script.test.js
```

Expected: syntax exits `0` and the focused suite passes.

### Task 3: Document And Verify The Deployment Preparation Batch

**Files:**
- Modify: `docs/windows-deployment-guide.md`
- Modify: `docs/project-roadmap-progress.md`
- Modify: `test/deploy-assets.test.js`

- [ ] **Step 1: Update deployment docs**

Add the generator command before the read-only preflight section:

```powershell
npm.cmd run deploy:windows:prepare-pack
```

Explain that the generated Markdown pack is safe to create before a server exists and does not modify `C:\RockSolidLicense`.

- [ ] **Step 2: Extend deployment asset coverage**

Assert the Windows guide references:

```text
deploy:windows:prepare-pack
windows-first-deploy-pack.md
```

- [ ] **Step 3: Record the roadmap slice**

Add a latest-slice entry and a verification entry describing the generated secret-free first-deploy pack, safety boundary, focused tests, deployment-assets tests, preflight check, route-map gate, and deferred full suite.

- [ ] **Step 4: Run the complete batch verification**

Run:

```powershell
node --check scripts/windows-first-deploy-pack.mjs
node --test --test-concurrency=1 --test-isolation=none test/windows-first-deploy-pack-script.test.js test/windows-deploy-preflight-script.test.js test/deploy-assets.test.js
npm.cmd run deploy:windows:prepare-pack
npm.cmd run deploy:windows:preflight
npm.cmd run launch:route-map-gate
git diff --check
```

Expected: syntax exits `0`, focused tests pass, the pack is generated without secret values, current preflight remains `not_deployed_yet`, route-map gate passes, and whitespace check exits `0`.

- [ ] **Step 5: Commit and push the meaningful batch**

Run:

```powershell
git add -- package.json scripts/windows-first-deploy-pack.mjs test/windows-first-deploy-pack-script.test.js test/deploy-assets.test.js docs/windows-deployment-guide.md docs/project-roadmap-progress.md docs/superpowers/plans/2026-06-01-windows-first-deploy-pack.md
git commit -m "Add Windows first deploy pack"
git push
```
