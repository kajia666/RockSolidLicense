# Windows First Deploy Pack Design

## Goal

Add one local preparation entrypoint that generates a secret-free Markdown pack for the first Windows deployment. The pack lets an operator prepare the future server workflow before a server, domain, or real staging account exists.

## Command

Add:

```powershell
npm.cmd run deploy:windows:prepare-pack
```

The command uses a Node.js ESM script and supports:

```text
--target-dir <path>
--output-file <path>
--json
--help
```

Defaults:

```text
target directory: C:\RockSolidLicense
output file: artifacts/deploy/windows/windows-first-deploy-pack.md
```

## Boundary

The command may create the parent directory for its generated Markdown file and write that Markdown file.

The command must not:

- create or modify the target installation directory
- copy repository files into the target installation directory
- write `rocksolid.env.ps1`
- start the server
- register Scheduled Tasks
- change firewall rules
- configure HTTPS
- execute backups
- read or print secret values

## Generated Pack

The generated Markdown pack must include:

- the future Windows target directory
- the pack generation timestamp
- the existing read-only preflight command
- the expected preflight states
- the env example source and local env destination paths
- the names `RSL_ADMIN_PASSWORD` and `RSL_SERVER_TOKEN_SECRET`
- the manual start command
- the local healthcheck command
- the post-healthcheck commands for Scheduled Task registration, firewall configuration, file backup registration, and PostgreSQL backup registration
- a reminder that HTTPS exposure comes after local manual-start and healthcheck proof
- a reminder that `not_deployed_yet` is expected before deployment starts

The pack must not contain the example secret placeholders:

```text
ReplaceThisImmediately
ReplaceThisWithARandomSecret
```

## Machine-Readable Result

Both JSON and plain output must report:

- `status=prepared`
- generated output path
- target directory
- `summary.willModifyTargetDirectory=false`
- `summary.willCopyFiles=false`
- `summary.willStartService=false`
- `summary.willRegisterScheduledTasks=false`
- `summary.willChangeFirewall=false`
- `summary.willRunBackups=false`
- ordered operator steps

The plain output should print the generated pack path and the first next action:

```text
npm.cmd run deploy:windows:preflight
```

## Error Handling

Reject:

- unknown CLI options
- missing values for `--target-dir` or `--output-file`
- an output path that resolves to the target installation directory or any path inside it

Allow:

- an output file inside the repository's `artifacts` directory
- a custom output file used by tests
- a custom future target directory

## Testing

Add focused tests for:

- npm script exposure
- default secret-free generated pack
- custom target directory and output file
- output safety flags in JSON
- unknown option rejection
- missing option-value rejection
- target-directory output rejection
- `--help`

Update the Windows deployment guide, roadmap, and deployment asset tests. Verify syntax, focused tests, the deployment-assets suite, the existing Windows preflight command, the targeted route-map gate, and whitespace.

Keep the full repository suite deferred until the planned final go-live test window unless this slice unexpectedly changes shared backend/API behavior.
