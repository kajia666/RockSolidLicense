# Developer Members

The platform now supports a two-layer developer backoffice model:

- primary developer account
- developer member accounts scoped to selected projects

## Login model

- both owners and members log in through `POST /api/developer/login`
- `GET /api/developer/me` returns both the root developer identity and the current actor
- member sessions become invalid immediately if the member or the parent developer is disabled

## Supported member roles

- `admin`
  Can view assigned projects and can manage feature toggles, policies, cards, versions, and notices for those projects.
- `operator`
  Can view assigned projects and can manage policies, cards, versions, and notices, but cannot edit product feature toggles.
- `viewer`
  Read-only access to assigned projects and their policies, cards, versions, and notices.

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

## Isolation rules

- a member only sees products explicitly assigned to that member
- project-scoped actions re-check permissions on every request, so role changes apply immediately
- if a project is transferred to a different developer account, old member mappings no longer grant access
