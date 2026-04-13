# Developer Members

The platform now supports a two-layer developer backoffice model:

- primary developer account
- developer member accounts scoped to selected projects

## Login model

- both owners and members log in through `POST /api/developer/login`
- `GET /api/developer/me` returns both the root developer identity and the current actor
- `GET /api/developer/dashboard` returns only the summary data for projects visible to the current actor
- member sessions become invalid immediately if the member or the parent developer is disabled

## Supported member roles

- `admin`
  Can view assigned projects and can manage feature toggles, policies, cards, versions, notices, and developer authorization operations for those projects.
- `operator`
  Can view assigned projects and can manage policies, cards, versions, notices, and developer authorization operations, but cannot edit product feature toggles.
- `viewer`
  Read-only access to assigned projects and their policies, cards, versions, notices, and authorization operations data.

All three roles can read the scoped dashboard summary, but the totals and project metrics are still limited to projects assigned to that actor.

## Owner-only endpoints

- `GET /api/developer/members`
- `POST /api/developer/members`
- `POST /api/developer/members/:memberId`

Example create request:

```json
{
  "username": "ops.agent",
  "password": "OpsAgent123!",
  "displayName": "Operations Agent",
  "role": "operator",
  "productCodes": ["ALPHA_APP", "BETA_APP"]
}
```

Example update request:

```json
{
  "role": "admin",
  "status": "active",
  "productCodes": ["ALPHA_APP", "BETA_APP", "GAMMA_APP"]
}
```

Optional password reset during update:

```json
{
  "newPassword": "NewMemberPassword123!"
}
```

## Profile management

- `POST /api/developer/profile`
- `POST /api/developer/change-password`
- `POST /api/developer/logout`

Owners update the main developer profile. Members update only their own display name and password.

## Project workspace

- `/developer/projects`
- `GET /api/developer/products`
- `POST /api/developer/products`
- `POST /api/developer/products/:productId/feature-config`
- `POST /api/developer/products/:productId/sdk-credentials/rotate`
- `GET /api/developer/dashboard`

The owner account can create new projects. Product feature toggles and SDK credential rotation require product write permission, which in the current role model means the owner account or an assigned `admin` member. `operator` and `viewer` members stay read-only for project settings.

## Authorization operations

- `/developer/ops`
- `GET /api/developer/accounts`
- `GET /api/developer/entitlements`
- `GET /api/developer/sessions`
- `GET /api/developer/device-bindings`
- `GET /api/developer/device-blocks`
- `GET /api/developer/audit-logs`

Write-capable roles can also freeze accounts, extend entitlements, adjust points, revoke sessions, release bindings, and block or unblock devices inside their assigned project scope.

## License workspace

- `/developer/licenses`
- `GET /api/developer/policies`
- `POST /api/developer/policies`
- `POST /api/developer/policies/:policyId/runtime-config`
- `POST /api/developer/policies/:policyId/unbind-config`
- `GET /api/developer/cards`
- `GET /api/developer/cards/export`
- `POST /api/developer/cards/batch`
- `POST /api/developer/cards/:cardId/status`

This workspace is meant for day-to-day policy maintenance and card inventory operations. Owners and write-capable members can create policies, issue card batches, export scoped inventory, and freeze or revoke cards. `viewer` members can inspect the same scoped data but cannot create or modify it.

## Project network security

- `/developer/security`
- `GET /api/developer/network-rules`
- `POST /api/developer/network-rules`
- `POST /api/developer/network-rules/:ruleId/status`

These endpoints are project-scoped only. Developers and members can list rules only inside assigned products, while creating or archiving rules requires `products.write`. That typically means the owner account or an `admin` member. `operator` and `viewer` roles remain read-only for network-rule changes.

## Release workspace

- `/developer/releases`
- `GET /api/developer/client-versions`
- `POST /api/developer/client-versions`
- `POST /api/developer/client-versions/:versionId/status`
- `GET /api/developer/notices`
- `POST /api/developer/notices`
- `POST /api/developer/notices/:noticeId/status`

This workspace is meant for version publishing, forced upgrade rules, and startup or maintenance notices. Owners and `admin` members have full access. `operator` members can also create and update release data inside assigned projects. `viewer` members remain read-only and can inspect release data without publishing changes.

## SDK credential rotation

- `POST /api/developer/products/:productId/sdk-credentials/rotate`

Roles with `products.write` permission can rotate a project's SDK signing credentials. This is typically the owner account or a developer member with the `admin` role.

Example request:

```json
{
  "rotateAppId": true
}
```

Effects:

- a new `sdkAppSecret` is always generated
- `sdkAppId` changes only when `rotateAppId=true`
- old SDK credentials stop working immediately after the rotation succeeds

## Isolation rules

- a member only sees products explicitly assigned to that member
- project-scoped actions re-check permissions on every request, so role changes apply immediately
- if a project is transferred to a different developer account, old member mappings no longer grant access
