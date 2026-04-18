# Developer Integration Center

The developer integration center is available at `/developer/integration`.

It is designed to help software authors connect the SDK to their own software by aggregating:

- scoped project credentials
- product feature toggles
- default startup bootstrap preview
- HTTP and TCP listener information
- public token keys
- example request payloads

The page also accepts `productId`, `productCode`, and `channel` in the query string. That allows the project workspace or release workspace to open `/developer/integration` with the matching project already selected, and lets the integration page jump back to project settings or release readiness without losing the current project context.

The page now also summarizes how many visible projects currently have each of the 10 product-level switches enabled:

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

The last 3 switches act as project-level client hardening controls. They affect the integration package, startup bootstrap preview, env template, C++ quickstart guidance, and generated C++ host skeleton so software authors can choose a stricter or more relaxed client-side hardening profile per project.

The generated `.env` template is now also shaped to work with the packaged CMake host consumer example. The package additionally emits a dedicated `rocksolid_host_config.env`, a project-aware `CMakeLists.txt`, and a VS2022 `.vcxproj`, so a software author can usually download those files directly, add the demo login credentials, flip `RS_RUN_NETWORK_DEMO=true`, and then drop them into a minimal host consumer project without renaming fields by hand.

## API

- `GET /api/developer/integration`
- `GET /api/developer/integration/package`
- `GET /api/developer/integration/package/download`
- `POST /api/developer/products/integration-packages/export`
- `POST /api/admin/products/integration-packages/export`
- `POST /api/developer/products/integration-packages/export/download`
- `POST /api/admin/products/integration-packages/export/download`

This route requires a normal developer bearer token and is scoped to projects visible to the current actor.

The package route accepts:

- `productId`
- `productCode`
- `projectCode`
- `softwareCode`

The package download route accepts the same selectors plus:

- `format=json|env|host-config|cmake|vs2022|cpp|host-skeleton|checksums|zip`

## Returned data

- `developer`
- `actor`
- `transport.http`
- `transport.tcp`
- `signing`
- `tokenKeys`
- `products`
- `examples`

The package route returns:

- `fileName`
- `manifest`
- `manifest.clientHardening`
- `manifest.startupPreview`
- `snippets.envFileName`
- `snippets.envTemplate`
- `snippets.hostConfigFileName`
- `snippets.hostConfigEnv`
- `snippets.cmakeFileName`
- `snippets.cmakeConsumerTemplate`
- `snippets.vs2022ProjectFileName`
- `snippets.vs2022ProjectTemplate`
- `snippets.cppFileName`
- `snippets.cppQuickstart`
- `snippets.hostSkeletonFileName`
- `snippets.hostSkeletonCpp`
- `snippets.hardeningFileName`
- `snippets.hardeningGuide`

The batch package export routes return:

- `fileName`
- `items`
- `manifestFiles`
- `envFiles`
- `hostConfigFiles`
- `cmakeFiles`
- `vs2022Files`
- `cppFiles`
- `hostSkeletonFiles`
- `manifestBundleText`
- `envBundleText`
- `hostConfigBundleText`
- `cmakeBundleText`
- `vs2022BundleText`
- `cppBundleText`
- `hostSkeletonBundleText`

The batch package download routes accept the same body selectors as the export routes plus:

- `format=json|manifests|env|host-config|cmake|vs2022|cpp|host-skeleton|checksums|zip`

Typical shape:

```json
{
  "transport": {
    "http": {
      "protocol": "http",
      "host": "0.0.0.0",
      "port": 3000,
      "baseUrl": "http://127.0.0.1:3000"
    },
    "tcp": {
      "enabled": true,
      "host": "0.0.0.0",
      "port": 4000
    }
  },
  "signing": {
    "requestAlgorithm": "HMAC-SHA256",
    "requestSkewSeconds": 300,
    "tokenAlgorithm": "RS256",
    "tokenIssuer": "RockSolidLicense",
    "activeKeyId": "kid_xxx"
  }
}
```

## Role behavior

- owner account: can view every owned project inside the integration snapshot
- member account: only sees explicitly assigned projects
- the route is read-only and does not change project state

## Practical use

The page and API are useful when the software author needs to:

- copy the correct `sdkAppId` and `sdkAppSecret`
- confirm whether HTTP or TCP endpoints are enabled
- inspect how the default `startup-bootstrap` call will behave before shipping a client build
- fetch the current public key set used for `licenseToken` verification
- adapt example register/login/card-login/heartbeat requests for their own client
- adapt a dedicated `startup-bootstrap` request before showing the local login UI
- confirm whether recharge and client-unbind are open for a scoped project before exposing those SDK flows
- export a current project integration package after rotating `sdkAppSecret` or `sdkAppId`
- download the current single-project integration package directly as JSON, `.env`, `rocksolid_host_config.env`, C++ quickstart, host skeleton, or one zip handoff bundle
- download a matching SHA-256 checksum list for the generated handoff files
- export multiple project integration packages in one request from the project workspace when several software products need the same deployment refresh
- hand the software author a ready-to-copy C++ quickstart snippet, project-aware host skeleton, dedicated host config file, project-aware `CMakeLists.txt`, VS2022 `.vcxproj`, and environment template that already line up with the packaged host consumer examples

## Request signing headers

The HTTP integration example uses the same request signing headers as the runtime client APIs:

- `x-rs-app-id`
- `x-rs-timestamp`
- `x-rs-nonce`
- `x-rs-signature`
