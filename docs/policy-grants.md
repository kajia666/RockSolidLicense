# Policy Grant Types

RockSolidLicense policies now support two grant types:

- `duration`
- `points`

## Duration

This is the classic time-based authorization model.

Example:

```json
{
  "productCode": "MY_APP",
  "name": "30 Day Plan",
  "grantType": "duration",
  "durationDays": 30,
  "maxDevices": 1
}
```

Behavior:

- card recharge creates a normal entitlement window
- login is allowed while `startsAt <= now < endsAt`
- heartbeat keeps the session alive inside that entitlement window

## Points

This is a metered authorization model.

Example:

```json
{
  "productCode": "MY_APP",
  "name": "2 Login Credits",
  "grantType": "points",
  "grantPoints": 2,
  "durationDays": 0,
  "maxDevices": 1
}
```

Behavior:

- card recharge creates a point-based entitlement
- each successful new login session consumes 1 point
- heartbeat does not consume extra points
- logout does not refund points
- when remaining points reach 0, future login returns `LICENSE_POINTS_EXHAUSTED`

This model works in both:

- account mode
- direct card-login mode

## Operator visibility

Admin entitlement queries now include:

- `grantType`
- `grantPoints`
- `totalPoints`
- `remainingPoints`
- `consumedPoints`

This makes it easier to operate both time cards and metered cards from the same backend.
