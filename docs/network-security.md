# Network Security Guide

This document describes the IP / CIDR access-rule system.

## What it does

The current system supports admin-managed block rules for:

- exact IP addresses
- IPv4 CIDR ranges
- global scope
- product-specific scope
- action-specific enforcement

Supported action scopes:

- `all`
- `register`
- `recharge`
- `login`
- `heartbeat`

## Admin endpoints

### List rules

- `GET /api/admin/network-rules`

Query parameters:

- `productCode`
- `actionScope`
- `status`
- `search`

### Create rule

- `POST /api/admin/network-rules`

Example:

```json
{
  "productCode": "MY_SOFTWARE",
  "targetType": "cidr",
  "pattern": "203.0.113.0/24",
  "actionScope": "login",
  "status": "active",
  "notes": "Temporary login block for abuse handling."
}
```

### Update rule status

- `POST /api/admin/network-rules/:ruleId/status`

Example:

```json
{
  "status": "archived"
}
```

## Runtime behavior

When a signed client request matches an active block rule:

- the request is rejected with HTTP `403`
- the error code is `NETWORK_RULE_BLOCKED`
- the payload contains rule metadata such as `pattern`, `actionScope`, and `ip`

## Current matching support

- exact IP comparison
- IPv4 CIDR matching
- IPv4-mapped IPv6 values such as `::ffff:127.0.0.1` are normalized to IPv4 before matching

## Admin page

Open:

- `http://127.0.0.1:3000/admin/security`

This page lets operators:

- create access rules
- archive old rules
- inspect matching patterns and notes
- keep a simple audit trail through the existing audit-log system

## Recommended use cases

- temporary login block for brute-force cleanup
- heartbeat block for abusive online-session traffic
- product-specific recharge blocking during fraud investigations
- emergency global block for a hostile source range

## Current limitation

This version supports block rules only.

If you later want:

- allowlists
- geolocation rules
- ASN rules
- time-windowed automatic expiry

then extend `network_rules` rather than creating unrelated tables.
