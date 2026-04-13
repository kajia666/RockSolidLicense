# Developer Project Workspace

The developer project workspace is available at `/developer/projects`.

It is intended for software authors who need a dedicated place to manage project creation, product-level feature toggles, and SDK signing credentials.

## Scoped APIs

- `GET /api/developer/products`
- `POST /api/developer/products`
- `POST /api/developer/products/:productId/feature-config`
- `POST /api/developer/products/:productId/sdk-credentials/rotate`
- `GET /api/developer/dashboard`

## Role behavior

- owner account
  Can create new projects, edit feature toggles, and rotate SDK credentials for owned projects.
- admin member
  Can edit feature toggles and rotate SDK credentials inside assigned projects.
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
    "allowClientUnbind": false
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
