# Token Key Rotation

RockSolidLicense now supports:

- one active RSA signing key
- a published public key set with `kid`
- retirement of old public keys after rotation

## Endpoints

- `GET /api/system/token-key`
  Returns the active public key only.
- `GET /api/system/token-keys`
  Returns the full published key set.
- `POST /api/admin/token-keys/rotate`
  Requires admin bearer token and rotates the active signing key.

## Storage

Default files:

- active private key: `data/license_private.pem`
- active public key: `data/license_public.pem`
- published key set metadata: `data/license_keyring.json`

Environment variables:

- `RSL_LICENSE_PRIVATE_KEY_PATH`
- `RSL_LICENSE_PUBLIC_KEY_PATH`
- `RSL_LICENSE_KEYRING_PATH`
- `RSL_TOKEN_ISSUER`

## Rotation behavior

When rotation happens:

1. A new RSA keypair is generated.
2. The new key becomes the active signer.
3. The previous public key remains published as `retired`.
4. New tokens use the new `kid`.
5. Old tokens can still be verified with the old published public key until they expire.

## Client recommendation

Clients should:

1. Cache the full key set from `GET /api/system/token-keys`.
2. Match token `kid` to the corresponding published public key.
3. Verify the RSA signature locally.
4. Refresh the key set periodically or when an unknown `kid` appears.

## Operational recommendation

- Rotate token keys on a planned schedule.
- Keep retired public keys published at least as long as the maximum token lifetime.
- Protect the private key path with OS-level permissions and backups.
