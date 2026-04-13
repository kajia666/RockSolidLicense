# Developer Release Center

The developer release workspace gives software authors a dedicated place to manage:

- client version rules
- forced upgrade floors
- startup announcements
- maintenance notices that can temporarily block login

Route:

- `/developer/releases`

## Scoped APIs

- `GET /api/developer/client-versions`
- `POST /api/developer/client-versions`
- `POST /api/developer/client-versions/:versionId/status`
- `GET /api/developer/notices`
- `POST /api/developer/notices`
- `POST /api/developer/notices/:noticeId/status`

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
