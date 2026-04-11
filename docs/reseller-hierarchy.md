# Reseller Hierarchy

This document describes the new hierarchical reseller model. The focus is channel isolation for a network-verification platform, not finance settlement.

## What changed

Resellers are no longer flat records only visible to the admin backend.

The system now supports:

- parent-child reseller relationships
- reseller login sessions
- reseller-created child accounts
- subtree-aware inventory visibility
- reseller-to-child inventory transfer

Each reseller can now work inside its own scope:

- by default a reseller sees only its own inventory
- when `includeDescendants=true`, a reseller can also inspect descendant scope if that reseller is allowed to view descendants
- a reseller cannot query a sibling or ancestor inventory scope

## HTTP endpoints

### Reseller authentication

- `POST /api/reseller/login`
- `GET /api/reseller/me`

Login request example:

```json
{
  "username": "root.agent",
  "password": "RootPass123!"
}
```

### Reseller tree management

- `GET /api/reseller/resellers`
- `POST /api/reseller/resellers`

Child reseller creation example:

```json
{
  "code": "CHILD_AGENT",
  "name": "Child Agent",
  "username": "child.agent",
  "password": "ChildPass123!"
}
```

Optional fields:

- `parentResellerId`
- `contactName`
- `contactEmail`
- `notes`
- `allowViewDescendants`

### Scoped inventory

- `GET /api/reseller/inventory`
- `GET /api/reseller/inventory/export`
- `POST /api/reseller/inventory/transfer`

Scoped inventory query parameters:

- `resellerId`
- `includeDescendants`
- `productCode`
- `cardStatus`
- `search`

Inventory transfer example:

```json
{
  "targetResellerId": "reseller_child_xxx",
  "productCode": "MY_SOFTWARE",
  "policyId": "pol_xxx",
  "count": 20
}
```

Effects:

- transfer only consumes the current reseller's own fresh inventory
- target reseller must be inside the caller's descendant tree
- sibling or ancestor transfer is rejected with `RESELLER_SCOPE_FORBIDDEN`
- reseller inventory exports only include rows inside the caller's scope

## Recommended workflow

1. Admin creates the top-level reseller and optional login credentials.
2. Admin allocates the first batch to the top-level reseller.
3. Top-level reseller logs in and creates child resellers.
4. Parent reseller transfers fresh card inventory to children.
5. Each child sees only its own inventory by default.
6. Parent reseller optionally inspects descendant inventory with `includeDescendants=true`.

## Isolation notes

- scope checks happen on every reseller inventory read
- subtree management is recursive, so the hierarchy can be extended to multiple levels
- admin allocation still exists for initial stocking, but downstream distribution now uses reseller transfer rather than generating unrelated duplicate stock
