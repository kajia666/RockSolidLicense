# Notice Center Guide

This document describes the announcement and maintenance-notice workflow.

## What this adds

The system now supports:

- client-facing announcements
- maintenance notices
- temporary login blocking during maintenance windows
- a dedicated admin page at `/admin/notices`

## Data model

Notices are stored in the `notices` table.

Each notice can be:

- global or product-specific
- channel-specific such as `stable`, or shared through `all`
- an `announcement` or `maintenance`
- `active` or `archived`
- informational only, or marked with `blockLogin=true`

## Admin endpoints

### List notices

- `GET /api/admin/notices`

Query parameters:

- `productCode`
- `channel`
- `kind`
- `status`
- `search`

### Create notice

- `POST /api/admin/notices`

Example:

```json
{
  "productCode": "MY_SOFTWARE",
  "channel": "stable",
  "kind": "maintenance",
  "severity": "critical",
  "title": "Maintenance window",
  "body": "License service maintenance is in progress.",
  "status": "active",
  "blockLogin": true
}
```

### Update notice status

- `POST /api/admin/notices/:noticeId/status`

Example:

```json
{
  "status": "archived",
  "blockLogin": false
}
```

## Client endpoint

### Fetch active notices

- `POST /api/client/notices`

This is a signed SDK request.

Example:

```json
{
  "productCode": "MY_SOFTWARE",
  "channel": "stable"
}
```

Response returns currently active notices for:

- the product
- the requested channel
- global `all` notices

## Login blocking behavior

When a notice is:

- `status=active`
- currently inside its time window
- matches the product/channel
- `blockLogin=true`

then login returns:

- HTTP `503`
- error code `LOGIN_BLOCKED_BY_NOTICE`

The error payload includes matching notices so the client can show the maintenance message immediately.

## Recommended client startup flow

1. call `POST /api/client/notices`
2. render active announcements
3. if any active maintenance notice blocks login, disable the login action locally
4. continue with version check and login once the service is available again

## Admin page

Open:

- `http://127.0.0.1:3000/admin/notices`

This page lets you:

- log in as admin
- create notices
- archive notices
- toggle login blocking
- inspect the returned payload quickly
