# Developer License Center

The developer license workspace is available at `/developer/licenses`.

It is designed for software authors who need to manage policies and card inventory inside their own project scope without opening the admin backoffice.

The same page now also accepts routed query parameters such as `productId`, `productCode`, `channel`, `autofocus`, `routeTitle`, and `routeReason`. That lets `/developer/launch-workflow`, `/developer/projects`, or other routed actions drop a software author directly into:

- launch authorization quickstart review
- starter policy creation
- policy runtime / unbind controls
- starter card inventory and card status

without losing the current project context.

The page now also includes a `Launch Authorization Quickstart` block. It combines routed project context, scoped dashboard metrics, current feature config, policy inventory, and card inventory into one starter checklist so software authors can see:

- the current launch login mode and hardening posture
- whether starter policies already exist
- whether fresh cards are staged for direct-card login or recharge
- whether account-login launches still need open registration or seeded starter accounts

That quickstart block can also prefill the two most common launch templates:

- starter duration policy
- starter points policy

and it can prefill:

- a starter card-batch draft using the current project code and the first active policy in scope
- a starter account draft when account login is enabled but public registration stays closed

The same quickstart block can now also run a one-click `Launch Bootstrap`. When the current project already has a valid login path, that bootstrap can create the missing starter policy, starter card batch, and starter account in one pass, then return the generated starter-account password in the response so the software author can hand it off securely.

For account-only lanes that do not use direct-card login or recharge, the same bootstrap can now also seed one internal starter entitlement automatically. It does that by staging a private one-card seed batch and redeeming it into the starter account, so QA or support can exercise the real runtime gating path before the first customer arrives.

When the first recommended card batches already exist but the fresh inventory falls below the launch buffer, the same quickstart block now exposes `Run Inventory Refill`, `Refill Direct-Card Batch`, or `Refill Recharge Batch`. Those actions top the matching launch prefixes back up toward their recommended starter counts instead of rerunning the full first-batch flow.

The same quickstart block now also turns launch advice into three concrete groups instead of only showing generic blockers:

- `Initial Inventory Recommendations`
- `First Batch Card Suggestions`
- `First Ops Actions`

That helps a software author answer three practical launch questions in one place:

- what must exist before launch
- what first batch of sellable or recharge cards should be issued
- what should be checked in the first launch window after users begin signing in

Those recommendation rows can now also carry direct actions. So instead of only reading the suggestion, a software author can immediately:

- open the project authorization preset
- prefill a starter policy or a recommendation-specific first batch card draft
- run one-click first-batch setup to create the recommended direct-card / recharge starter batches automatically
- prefill a starter account
- jump straight into launch workflow, release workspace, or developer ops for the matching first-launch follow-up
- run `Launch Bootstrap`

After `Launch Bootstrap`, `First Batch Setup`, or `Inventory Refill` completes, the same quickstart block now also keeps a `Next Launch Follow-up` section in view. It reuses the real launch-day ops actions for the current project and turns them into direct buttons, so a software author can immediately:

- review the combined launch workflow again before moving into launch-day ops
- review starter inventory or refilled inventory inside the license workspace when the lane depends on sellable cards
- open the exact routed workspace for runtime smoke, card redemption watch, session review, or release checks
- download the matching launch workflow summary/checklist or filtered ops summary without first navigating into another workspace
- keep the most recent launch initialization result attached to the same routed project instead of re-deriving the next step manually

The direct `First Batch Setup` and `Inventory Refill` API responses also include a launch-mainline-style `receipt`. That receipt carries the first-launch inventory queue, owner/stage duty handoff, first-launch duty summary, production evidence queue, post-launch lifecycle summary, and `first-launch-handoff` download shortcut, so API callers can hand the result to launch duty without calling the mainline action endpoint first.

That same follow-up block can now also download a combined `launch review summary`. It merges the current launch-workflow recheck with the filtered developer-ops snapshot for the routed lane, so QA, support, or launch-duty teammates can review launch readiness and first-wave runtime signals from one handoff file.

The same follow-up chain can now also download a `launch smoke kit` summary. That file packages:

- the current startup bootstrap request and startup decision
- internal account candidates
- starter entitlement candidates
- fresh direct-card and recharge-card candidates
- a short smoke-test path for startup, account login, direct-card login, recharge, and heartbeat validation

so QA, support, or launch-duty teammates can run an internal first-pass validation without rebuilding the launch lane by hand.

When the software author wants to continue the same review in-page, the same quickstart follow-up can now route into `/developer/launch-review`, keeping launch workflow recheck and first-wave runtime follow-up together in one workspace after authorization initialization or refill.

The quickstart block now also keeps a `Last Quickstart Action` recap above that follow-up section. It summarizes the before/after counts for starter policies, fresh cards, starter accounts, and active entitlements, then lists the newly created starter batches, accounts, or internal entitlements so a software author can confirm what actually changed before moving on to the next launch-day recheck.

## Scope

- owners can manage every product they own
- member accounts only see products explicitly assigned to them
- `viewer` members stay read-only
- write actions still follow the existing project-scoped permission checks

## Policy APIs

- `GET /api/developer/policies`
- `POST /api/developer/policies`
- `POST /api/developer/policies/:policyId/runtime-config`
- `POST /api/developer/policies/:policyId/unbind-config`

Typical creation body:

```json
{
  "productCode": "ALPHA_APP",
  "name": "Standard 30 Days",
  "grantType": "duration",
  "durationDays": 30,
  "maxDevices": 1,
  "allowConcurrentSessions": false,
  "heartbeatIntervalSeconds": 60,
  "heartbeatTimeoutSeconds": 180,
  "tokenTtlSeconds": 300,
  "bindMode": "selected_fields",
  "bindFields": ["machineGuid", "requestIp"],
  "allowClientUnbind": true,
  "clientUnbindLimit": 1,
  "clientUnbindWindowDays": 30,
  "clientUnbindDeductDays": 0
}
```

## Card APIs

- `GET /api/developer/cards`
- `GET /api/developer/cards/export`
- `GET /api/developer/cards/export/download`
- `POST /api/developer/cards/batch`
- `POST /api/developer/cards/:cardId/status`
- `POST /api/developer/license-quickstart/first-batches`

## Account APIs

- `GET /api/developer/accounts`
- `POST /api/developer/accounts`
- `POST /api/developer/accounts/:accountId/status`
- `POST /api/developer/license-quickstart/bootstrap`

Typical starter-account body:

```json
{
  "productCode": "ALPHA_APP",
  "username": "alpha_seed_01",
  "password": "TemporaryPass123!"
}
```

Typical launch-bootstrap body:

```json
{
  "productCode": "ALPHA_APP"
}
```

Typical first-batch-setup body:

```json
{
  "productCode": "ALPHA_APP",
  "mode": "recommended"
}
```

Supported first-batch setup modes:

- `recommended`
- `direct_card`
- `recharge`

Typical batch body:

```json
{
  "productCode": "ALPHA_APP",
  "policyId": "pol_xxx",
  "count": 50,
  "prefix": "ALPHA",
  "expiresAt": "2026-12-31T23:59:59+08:00",
  "notes": "Spring promotion"
}
```

Typical card control body:

```json
{
  "status": "frozen",
  "expiresAt": null,
  "notes": "Suspicious distribution"
}
```

Supported card control statuses:

- `active`
- `frozen`
- `revoked`

## Filter support

The list endpoint, the legacy CSV export endpoint, and the download endpoint all accept:

- `productCode`
- `policyId`
- `batchCode`
- `usageStatus`
- `status`
- `search`

That keeps the page and exported inventory inside the current developer scope while still letting the author narrow results to a single policy or batch.

## Export delivery

- `GET /api/developer/cards/export` keeps returning CSV for backward compatibility.
- `GET /api/developer/cards/export/download` accepts `format=json|csv|summary|checksums|zip`.
- `summary` gives a human-readable project and batch recap for support handoff.
- `checksums` emits SHA-256 digests for the generated JSON, summary, and CSV files.
- `zip` bundles JSON, summary, CSV, and `SHA256SUMS.txt` into one delivery archive.

## Routed launch fixes

Launch workflow can now send a software author straight into this page when authorization-readiness detects:

- no starter policies
- no fresh cards for direct-card login
- no fresh cards for recharge / renewal
- no viable first-launch account path
- account login enabled, registration closed, and no seeded starter account yet

When that happens, the page renders a `Route Focus` card, prefills the routed project code, and can scroll to the relevant policy, card, or starter-account controls so the author can fix the blocker faster.

If the blocker is really about the login model itself rather than policy or inventory, the same quickstart block can now send the software author back to `/developer/projects?autofocus=auth-preset` so the project-level authorization preset can be adjusted directly.
