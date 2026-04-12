import path from "node:path";

function optionalString(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function normalizeStateStoreDriver(value) {
  const normalized = String(value ?? "sqlite").trim().toLowerCase();
  if (!["sqlite", "memory"].includes(normalized)) {
    throw new Error("RSL_STATE_STORE_DRIVER must be sqlite or memory.");
  }
  return normalized;
}

export function loadConfig(overrides = {}) {
  const cwd = overrides.cwd ?? process.cwd();
  const dataDir = process.env.RSL_DATA_DIR ?? path.join(cwd, "data");

  return {
    env: process.env.NODE_ENV ?? "development",
    host: process.env.RSL_HOST ?? "0.0.0.0",
    port: Number(process.env.RSL_PORT ?? 3000),
    tcpEnabled: String(process.env.RSL_TCP_ENABLED ?? "true").toLowerCase() !== "false",
    tcpHost: process.env.RSL_TCP_HOST ?? process.env.RSL_HOST ?? "0.0.0.0",
    tcpPort: Number(process.env.RSL_TCP_PORT ?? 4000),
    dbPath:
      overrides.dbPath ??
      process.env.RSL_DB_PATH ??
      path.join(dataDir, "rocksolid.db"),
    postgresUrl: optionalString(overrides.postgresUrl ?? process.env.RSL_POSTGRES_URL),
    stateStoreDriver: normalizeStateStoreDriver(
      overrides.stateStoreDriver ?? process.env.RSL_STATE_STORE_DRIVER ?? "sqlite"
    ),
    redisUrl: optionalString(overrides.redisUrl ?? process.env.RSL_REDIS_URL),
    redisKeyPrefix:
      optionalString(overrides.redisKeyPrefix ?? process.env.RSL_REDIS_KEY_PREFIX) ?? "rsl",
    licensePrivateKeyPath:
      overrides.licensePrivateKeyPath ??
      process.env.RSL_LICENSE_PRIVATE_KEY_PATH ??
      path.join(dataDir, "license_private.pem"),
    licensePublicKeyPath:
      overrides.licensePublicKeyPath ??
      process.env.RSL_LICENSE_PUBLIC_KEY_PATH ??
      path.join(dataDir, "license_public.pem"),
    licenseKeyringPath:
      overrides.licenseKeyringPath ??
      process.env.RSL_LICENSE_KEYRING_PATH ??
      path.join(dataDir, "license_keyring.json"),
    tokenIssuer: process.env.RSL_TOKEN_ISSUER ?? "RockSolidLicense",
    adminUsername: process.env.RSL_ADMIN_USERNAME ?? "admin",
    adminPassword: process.env.RSL_ADMIN_PASSWORD ?? "ChangeMe!123",
    adminSessionHours: Number(process.env.RSL_ADMIN_SESSION_HOURS ?? 12),
    requestSkewSeconds: Number(process.env.RSL_REQUEST_SKEW_SECONDS ?? 300),
    serverTokenSecret:
      process.env.RSL_SERVER_TOKEN_SECRET ??
      "change-me-before-production-rocksolid",
    ...overrides
  };
}
