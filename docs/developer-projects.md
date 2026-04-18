# Developer Project Workspace

The developer project workspace is available at `/developer/projects`.

It is intended for software authors who need a dedicated place to manage project creation, project profile editing, project status changes, product-level feature toggles, and SDK signing credentials.

The selected project detail card now also exposes direct handoff links into:

- `/developer/launch-workflow?productId=...&productCode=...&channel=stable`
- `/developer/integration?productId=...&productCode=...`
- `/developer/releases?productId=...&productCode=...&channel=stable`

`/developer/projects` also accepts `productId` or `productCode` in the query string so the page can reopen with the same project preselected.

The detail card now also shows a lightweight "Delivery quick signals" summary. It is not the same as the full release readiness package, but it helps software authors spot obvious blockers such as:

- inactive project status
- no active client version rule
- active blocking notices
- startup version-check or notice toggles being turned off

The same detail card now also supports an inline release-readiness preview. Software authors can choose a channel such as `stable` and fetch the current `release-package` summary directly inside `/developer/projects` before jumping to the dedicated release workspace. After previewing the result, they can also download the same release package `summary`, `checksums`, or `zip` straight from the project page.

The project detail card now also supports an inline integration snapshot preview. Without leaving `/developer/projects`, software authors can inspect the latest startup bootstrap decision, client hardening profile, token key coverage, and handoff artifact hints for the selected project. This preview now follows the same `channel` field used by the inline release-readiness preview, so `stable`, `beta`, and other release lanes stay aligned while checking startup behavior and downloading handoff assets. The same card also exposes the most common integration handoff files directly:

- package JSON
- generated `.env`
- `rocksolid_host_config.env`
- checksum manifest
- C++ quickstart
- `CMakeLists.txt`
- VS2022 quickstart guide
- VS2022 `.sln`
- VS2022 `.vcxproj`
- VS2022 `.vcxproj.filters`
- VS2022 `.props`
- VS2022 `.local.props`
- host skeleton snippet
- integration `zip`

To reduce repeated clicks, the same detail card now also exposes a `Preview Launch Workflow` action. It now loads a dedicated launch-workflow package for the current project/channel, keeps the inline release and integration previews in sync, and renders one combined summary with:

- overall lane status
- candidate version
- release checklist counts
- startup bootstrap decision
- hardening profile
- workflow blockers
- recommended next steps and download hints

The launch workflow block now also includes direct quick actions so software authors can immediately:

- download the combined recommended handoff zip
- download launch summary / checklist / checksums
- download release summary only
- download integration env / host config / host skeleton
- jump straight into the integration or release workspace with the same project and channel

The same combined package is also available over:

- `GET /api/developer/launch-workflow`
- `GET /api/developer/launch-workflow/download`

## Scoped APIs

- `GET /api/developer/products`
- `POST /api/developer/products`
- `POST /api/developer/products/:productId/profile`
- `POST /api/developer/products/:productId/status`
- `POST /api/developer/products/:productId/feature-config`
- `POST /api/developer/products/:productId/sdk-credentials/rotate`
- `POST /api/developer/products/sdk-credentials/export`
- `POST /api/developer/products/sdk-credentials/export/download`
- `GET /api/developer/dashboard`

## Role behavior

- owner account
  Can create new projects, edit project profile, switch project status, edit feature toggles, and rotate SDK credentials for owned projects.
- admin member
  Can edit project profile, switch project status, edit feature toggles, and rotate SDK credentials inside assigned projects.
- operator member
  Read-only for project settings.
- viewer member
  Read-only for project settings.

## Project create notes

`POST /api/developer/products` is owner-only.

Typical body:

```json
{
  "code": "ALPHA_APP",
  "name": "Alpha Desktop",
  "description": "Main Windows client",
  "featureConfig": {
    "allowRegister": true,
    "allowAccountLogin": true,
    "allowCardLogin": true,
  "allowCardRecharge": true,
  "allowVersionCheck": true,
  "allowNotices": true,
  "allowClientUnbind": false,
  "requireStartupBootstrap": true,
  "requireLocalTokenValidation": true,
  "requireHeartbeatGate": true
  }
}
```

## Feature toggle notes

`POST /api/developer/products/:productId/feature-config` accepts the same product-level booleans used by the admin backoffice:

- `allowRegister`
- `allowAccountLogin`
- `allowCardLogin`
- `allowCardRecharge`
- `allowVersionCheck`
- `allowNotices`
- `allowClientUnbind`
- `requireStartupBootstrap`
- `requireLocalTokenValidation`
- `requireHeartbeatGate`

The last 3 toggles are project-level client hardening controls. They let the software author decide whether the client should strictly require startup bootstrap, locally verify `licenseToken`, and gate protected features on heartbeat health. Core protocol security stays mandatory even if these project-level toggles are relaxed.

## Project profile editing

`POST /api/developer/products/:productId/profile`

Typical body:

```json
{
  "code": "ALPHA_APP",
  "name": "Alpha Desktop",
  "description": "Main Windows client"
}
```

Notes:

- the endpoint keeps the same `productId`
- only project metadata changes, so member/project bindings stay intact
- if the project code changes, client requests must use the new `productCode` / `projectCode` / `softwareCode`

## Project status switching

`POST /api/developer/products/:productId/status`

Typical body:

```json
{
  "status": "disabled"
}
```

Supported status values:

- `active`
- `disabled`
- `archived`

Effects:

- non-`active` projects stop accepting client register, login, recharge, heartbeat, notice, and version-check runtime traffic
- switching a project to `disabled` or `archived` revokes active sessions for that project
- switching back to `active` restores normal client access with the same SDK credentials

## SDK credential rotation

`POST /api/developer/products/:productId/sdk-credentials/rotate`

Typical body:

```json
{
  "rotateAppId": true
}
```

Effects:

- a new `sdkAppSecret` is always generated
- `sdkAppId` changes only when `rotateAppId=true`
- old credentials stop working immediately after rotation succeeds

## Batch SDK credential export

`POST /api/developer/products/sdk-credentials/export`

Typical body:

```json
{
  "productIds": [
    1,
    2
  ]
}
```

Returned data includes:

- batch JSON snapshot
- CSV text for quick spreadsheet import
- per-project `.env` snippets
- combined `.env` bundle text

`POST /api/developer/products/sdk-credentials/export/download` accepts the same selectors plus:

- `format=json|csv|env|checksums|zip`

The `zip` format bundles:

- the full JSON export
- the generated CSV file
- one `.env` file per selected project

The `checksums` format returns a SHA-256 manifest for the generated JSON / CSV / per-project `.env` files so software authors can verify a handoff package after download.

Access notes:

- owner, admin member, operator member, and viewer member can export SDK credentials for projects already visible to them
- visibility is still scoped by assigned project membership, so members cannot download credentials for unassigned projects
