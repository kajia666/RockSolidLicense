# Developer Integration Center

The developer integration center is available at `/developer/integration`.

It is designed to help software authors connect the SDK to their own software by aggregating:

- scoped project credentials
- product feature toggles
- default startup bootstrap preview
- HTTP and TCP listener information
- public token keys
- example request payloads

The page also accepts `productId`, `productCode`, `channel`, and `autofocus` in the query string. That allows the project workspace, launch workflow workspace, or release workspace to open `/developer/integration` with the matching project already selected, and lets the integration page jump back to project settings, launch workflow review, or release readiness without losing the current project context.

When `autofocus` is provided, the page can automatically scroll to and emphasize the routed section after sign-in or refresh. Typical values include `startup`, `hardening`, `host-config`, `host-skeleton`, `cmake`, and `vs2022-guide`.

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

The generated `.env` template is now also shaped to work with the packaged CMake host consumer example. The package additionally emits a dedicated `rocksolid_host_config.env`, a project-aware `CMakeLists.txt`, a VS2022 `.sln/.vcxproj/.vcxproj.filters` set plus `RockSolidSDK.props` and `RockSolidSDK.local.props`, and a project-aware `VS2022 quickstart` markdown guide so a software author can usually download those files directly, add the demo login credentials, flip `RS_RUN_NETWORK_DEMO=true`, and then drop them into a minimal host consumer project without renaming fields by hand.

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
- `channel`

The package download route accepts the same selectors plus:

- `format=json|env|host-config|cmake|vs2022-guide|vs2022-sln|vs2022|vs2022-filters|vs2022-props|vs2022-local-props|cpp|host-skeleton|checksums|zip`

When `channel` is provided, the package uses that release lane for the generated startup bootstrap preview, startup defaults, and channel-aware handoff snippets such as `.env` and `rocksolid_host_config.env`.

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
- `snippets.vs2022GuideFileName`
- `snippets.vs2022GuideText`
- `snippets.vs2022SolutionFileName`
- `snippets.vs2022SolutionTemplate`
- `snippets.vs2022ProjectFileName`
- `snippets.vs2022ProjectTemplate`
- `snippets.vs2022FiltersFileName`
- `snippets.vs2022FiltersTemplate`
- `snippets.vs2022PropsFileName`
- `snippets.vs2022PropsTemplate`
- `snippets.vs2022LocalPropsFileName`
- `snippets.vs2022LocalPropsTemplate`
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
- `vs2022GuideFiles`
- `vs2022SolutionFiles`
- `vs2022Files`
- `vs2022FiltersFiles`
- `vs2022PropsFiles`
- `vs2022LocalPropsFiles`
- `cppFiles`
- `hostSkeletonFiles`
- `manifestBundleText`
- `envBundleText`
- `hostConfigBundleText`
- `cmakeBundleText`
- `vs2022GuideBundleText`
- `vs2022SolutionBundleText`
- `vs2022BundleText`
- `vs2022FiltersBundleText`
- `vs2022PropsBundleText`
- `vs2022LocalPropsBundleText`
- `cppBundleText`
- `hostSkeletonBundleText`

The batch package download routes accept the same body selectors as the export routes plus:

- `format=json|manifests|env|host-config|cmake|vs2022-guide|vs2022-sln|vs2022|vs2022-filters|vs2022-props|vs2022-local-props|cpp|host-skeleton|checksums|zip`

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
- download the current single-project integration package directly as JSON, `.env`, `rocksolid_host_config.env`, `CMakeLists.txt`, `VS2022 quickstart.md`, VS2022 `.sln/.vcxproj/.vcxproj.filters/.props/.local.props`, C++ quickstart, host skeleton, or one zip handoff bundle
- download a matching SHA-256 checksum list for the generated handoff files
- export multiple project integration packages in one request from the project workspace when several software products need the same deployment refresh
- hand the software author a ready-to-copy C++ quickstart snippet, project-aware host skeleton, dedicated host config file, project-aware `CMakeLists.txt`, `VS2022 quickstart.md`, VS2022 `.sln/.vcxproj/.vcxproj.filters/.props/.local.props`, and environment template that already line up with the packaged host consumer examples

## Request signing headers

The HTTP integration example uses the same request signing headers as the runtime client APIs:

- `x-rs-app-id`
- `x-rs-timestamp`
- `x-rs-nonce`
- `x-rs-signature`
