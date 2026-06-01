# Windows Deploy Preflight Design

## Goal

Add one read-only Windows deployment preparation entrypoint so the project can move from code readiness into first deployment without pretending that a server, domain, or staging account already exists.

## Target Directory

`C:\RockSolidLicense` is the recommended future installation directory on the Windows server. It is not required to exist on the current development machine.

The stable path keeps runtime scripts, data, logs, backups, env configuration, and Scheduled Task commands aligned after deployment.

## Command

Add:

```powershell
npm.cmd run deploy:windows:preflight
```

The command uses a Node.js ESM script so it can run before PowerShell execution-policy decisions are finalized.

Supported options:

```text
--target-dir <path>
--json
--help
```

The default target directory is `C:\RockSolidLicense`.

## Read-Only Boundary

The command must not:

- create directories
- copy files
- write env files
- start the server
- register Scheduled Tasks
- change firewall rules
- execute backups

It only reads the repository assets, current Node.js version, and target-directory state.

## Repository Asset Checks

Treat missing repository deployment assets as fatal:

- `deploy/windows/rocksolid.env.ps1.example`
- `deploy/windows/run-rocksolid.ps1`
- `deploy/windows/healthcheck-rocksolid.ps1`
- `deploy/windows/register-rocksolid-task.ps1`
- `deploy/windows/register-rocksolid-backup-task.ps1`
- `deploy/windows/configure-firewall.ps1`
- `deploy/windows/Caddyfile.example`
- `docs/windows-deployment-guide.md`
- `docs/production-launch-checklist.md`

Require Node.js major version `24` or newer.

## Target Directory States

Return exactly one state:

- `fail`: repository assets are missing or Node.js is too old.
- `not_deployed_yet`: target directory does not exist. This is expected before first deployment.
- `needs_env_setup`: target directory exists, but `deploy/windows/rocksolid.env.ps1` does not exist.
- `ready_for_manual_start`: target directory and local env file exist.

`not_deployed_yet` and `needs_env_setup` are informational states, not command failures.

## Operator Handoff

Print a short ordered next-action list that advances only one safe step at a time:

- place the repository at the target directory
- copy `rocksolid.env.ps1.example` to `rocksolid.env.ps1`
- replace default administrator password and server token secret locally
- run `deploy/windows/run-rocksolid.ps1`
- run `deploy/windows/healthcheck-rocksolid.ps1`

Also print a boundary reminder: do not register Scheduled Tasks, change firewall rules, expose HTTPS, or run backups until manual start and healthcheck pass.

## Testing

Add focused tests for:

- default target directory missing
- custom target directory missing
- target directory present without env file
- target directory present with env file
- missing repository asset through an overridable repository root used only by tests
- `--help`

Update the Windows deployment guide, roadmap, and deployment asset tests. Run focused tests, the targeted route-map gate, syntax check, and whitespace check. Keep the full repository suite deferred until the planned full-test window.

