import path from "node:path";

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
