# Client Versioning Guide

This document describes the new version-management and forced-upgrade flow.

## Why this was added

Commercial license systems commonly need more than login and heartbeat:

- operators need to disable broken or cracked client builds
- operators need to force users onto a minimum safe version
- clients often need startup notices and upgrade URLs

This repository now supports those basics.

## Data model

Versions are stored in `client_versions`.

Each record belongs to:

- one product
- one channel such as `stable`
- one version string such as `1.2.0`

Each version record can define:

- `status`: `active` or `disabled`
- `force_update`: whether versions below it must upgrade
- `download_url`
- `notice_title`
- `notice_body`
- `release_notes`

## Admin endpoints

### List versions

- `GET /api/admin/client-versions`

Query parameters:

- `productCode`
- `channel`
- `status`
- `search`

### Create version rule

- `POST /api/admin/client-versions`

Example:

```json
{
  "productCode": "MY_SOFTWARE",
  "version": "1.2.0",
  "channel": "stable",
  "status": "active",
  "forceUpdate": true,
  "downloadUrl": "https://example.com/download/app-1.2.0.exe",
  "noticeTitle": "Critical update",
  "noticeBody": "Please upgrade to 1.2.0.",
  "releaseNotes": "Improve verification stability."
}
```

### Update version status

- `POST /api/admin/client-versions/:versionId/status`

Example:

```json
{
  "status": "disabled",
  "forceUpdate": false
}
```

## Client endpoint

### Version check

- `POST /api/client/version-check`

This is a signed SDK request just like the other `/api/client/*` endpoints.

Example:

```json
{
  "productCode": "MY_SOFTWARE",
  "clientVersion": "1.1.0",
  "channel": "stable"
}
```

Response includes:

- whether the version is allowed
- latest version
- minimum allowed version
- upgrade status
- latest download URL
- latest notice payload

## Runtime enforcement

If the client sends `clientVersion` on login or heartbeat:

- an explicitly disabled version is rejected
- a version below the highest active `forceUpdate=true` version is rejected
- a lower but still allowed version is marked as upgrade recommended by the version-check endpoint

Current rejection status uses:

- HTTP `426`
- error code `CLIENT_VERSION_REJECTED`

## Recommended client flow

1. client starts
2. client calls `POST /api/client/version-check`
3. if response says force update is required, block local login UI
4. if response says upgrade recommended, show the notice and download URL
5. include `clientVersion` on login and heartbeat requests

## Notes

- version comparison currently supports common dotted forms such as `1.2.0`
- if login requests omit `clientVersion`, old clients stay compatible for now
- if you later want hard enforcement for every client, add a product-level setting that requires version reporting
