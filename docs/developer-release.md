# Developer Release Center

The developer release workspace gives software authors a dedicated place to manage:

- client version rules
- forced upgrade floors
- startup announcements
- maintenance notices that can temporarily block login

Route:

- `/developer/releases`

The page accepts `productId`, `productCode`, and `channel` in the query string so project or integration workflows can open `/developer/releases` with the current project already prefilled. The release package card also links back to the project workspace and integration workspace with the same project context preserved.

## Scoped APIs

- `GET /api/developer/client-versions`
- `POST /api/developer/client-versions`
- `POST /api/developer/client-versions/:versionId/status`
- `GET /api/developer/notices`
- `POST /api/developer/notices`
- `POST /api/developer/notices/:noticeId/status`
- `GET /api/developer/release-package`
- `GET /api/developer/release-package/download`

Common filters:

- `productCode`
- `channel`
- `search`

Version list filters also support:

- `status=active|disabled`

Notice list filters also support:

- `status=active|archived`
- `kind=announcement|maintenance`

## Role behavior

- owner: full access inside owned projects
- admin member: full access inside assigned projects
- operator member: can create and update versions and notices inside assigned projects
- viewer member: read-only access to assigned project release data

The workspace is always project-scoped. A developer account or member can never manage versions or notices that belong to another developer account.

## Version rule notes

Create requests can include:

- `productCode`
- `version`
- `channel`
- `status`
- `forceUpdate`
- `downloadUrl`
- `noticeTitle`
- `noticeBody`
- `releaseNotes`
- `releasedAt`

Status updates can change:

- `status`
- `forceUpdate`

Typical uses:

- publish a new stable build
- disable a broken version
- raise the minimum allowed version by setting `forceUpdate=true`

## Notice notes

Create requests can include:

- `productCode`
- `channel`
- `kind`
- `severity`
- `title`
- `body`
- `actionUrl`
- `startsAt`
- `endsAt`
- `status`
- `blockLogin`

Status updates can change:

- `status`
- `blockLogin`

Typical uses:

- show release announcements at client startup
- publish maintenance windows
- temporarily block login with a maintenance notice

## Release delivery package

The release workspace can now generate a project-scoped release delivery package that combines:

- the current integration package
- the selected channel's version manifest
- a release-specific startup bootstrap preview
- a release readiness summary with blocking and attention checks
- a client hardening summary that reflects the project's startup/token/heartbeat gating profile
- a delivery summary that condenses the main handoff points for software authors and release operators
- a delivery checklist that turns the handoff into concrete pass/review/block items
- active runtime notices that affect startup or login
- ready-to-download `.env` and C/C++ quickstart snippets
- a dedicated `rocksolid_host_config.env` for the packaged CMake host consumer example
- a project-aware `CMakeLists.txt` for the packaged CMake host consumer example
- a VS2022 `.sln/.vcxproj/.vcxproj.filters` plus `RockSolidSDK.props` and `RockSolidSDK.local.props` for software authors who prefer native Visual Studio projects
- a project-aware `VS2022 quickstart` markdown guide that tells the software author which file to open first and which `RS_*` values to verify
- a project-aware C++ host skeleton that maps startup, local token validation, and heartbeat gating into host-app flow
- a project-specific hardening guide text snippet for SDK integrators

The release package `.env` template now also carries the extra demo/runtime keys used by the packaged CMake host consumer example, and the package emits a dedicated `rocksolid_host_config.env` plus a reusable VS2022 `.sln/.vcxproj/.vcxproj.filters`, `RockSolidSDK.props`, `RockSolidSDK.local.props`, and `VS2022 quickstart` handoff set. That keeps release handoff closer to a real executable skeleton instead of stopping at raw SDK credentials.

The package route accepts:

- `productId`
- `productCode`
- `projectCode`
- `softwareCode`
- `channel`

The download route accepts the same selectors plus:

- `format=json|summary|env|host-config|cmake|vs2022-guide|vs2022-sln|vs2022|vs2022-filters|vs2022-props|vs2022-local-props|cpp|host-skeleton|checksums|zip`

Typical uses:

- hand the release manager a single deployment snapshot for one software project
- verify that the download URL, force-update floor, and maintenance notices match the latest SDK credentials
- confirm whether the project is shipping with a strict, balanced, or relaxed client hardening profile
- decide whether the selected release should be held, shipped with attention, or treated as ready before rollout
- export release coordination material for viewer members without giving them write access
- hand over a matching SHA-256 checksum list so operators can verify downloaded files before distribution
- let the browser download server-generated attachments instead of building files locally in the page
