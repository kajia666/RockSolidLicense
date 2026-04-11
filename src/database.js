import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { generateId, hashPassword, nowIso } from "./security.js";

const schema = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  sdk_app_id TEXT NOT NULL UNIQUE,
  sdk_app_secret TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  name TEXT NOT NULL,
  duration_days INTEGER NOT NULL,
  max_devices INTEGER NOT NULL,
  allow_concurrent_sessions INTEGER NOT NULL DEFAULT 1,
  heartbeat_interval_seconds INTEGER NOT NULL DEFAULT 60,
  heartbeat_timeout_seconds INTEGER NOT NULL DEFAULT 180,
  token_ttl_seconds INTEGER NOT NULL DEFAULT 300,
  bind_mode TEXT NOT NULL DEFAULT 'strict',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS customer_accounts (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT,
  UNIQUE(product_id, username),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS license_keys (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  card_key TEXT NOT NULL UNIQUE,
  batch_code TEXT NOT NULL,
  status TEXT NOT NULL,
  notes TEXT,
  issued_at TEXT NOT NULL,
  redeemed_at TEXT,
  redeemed_by_account_id TEXT,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (policy_id) REFERENCES policies(id) ON DELETE CASCADE,
  FOREIGN KEY (redeemed_by_account_id) REFERENCES customer_accounts(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS entitlements (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  source_license_key_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (policy_id) REFERENCES policies(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES customer_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (source_license_key_id) REFERENCES license_keys(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  device_name TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_seen_ip TEXT,
  metadata_json TEXT,
  UNIQUE(product_id, fingerprint),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS device_bindings (
  id TEXT PRIMARY KEY,
  entitlement_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  status TEXT NOT NULL,
  first_bound_at TEXT NOT NULL,
  last_bound_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(entitlement_id, device_id),
  FOREIGN KEY (entitlement_id) REFERENCES entitlements(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS device_blocks (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  released_at TEXT,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  UNIQUE(product_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS client_versions (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  force_update INTEGER NOT NULL DEFAULT 0,
  download_url TEXT,
  release_notes TEXT,
  notice_title TEXT,
  notice_body TEXT,
  released_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  UNIQUE(product_id, channel, version)
);

CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY,
  product_id TEXT,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  action_url TEXT,
  status TEXT NOT NULL,
  block_login INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS network_rules (
  id TEXT PRIMARY KEY,
  product_id TEXT,
  target_type TEXT NOT NULL,
  pattern TEXT NOT NULL,
  action_scope TEXT NOT NULL,
  decision TEXT NOT NULL,
  status TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS resellers (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  contact_name TEXT,
  contact_email TEXT,
  status TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reseller_inventory (
  id TEXT PRIMARY KEY,
  reseller_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  license_key_id TEXT NOT NULL UNIQUE,
  allocation_batch_code TEXT NOT NULL,
  notes TEXT,
  allocated_at TEXT NOT NULL,
  status TEXT NOT NULL,
  FOREIGN KEY (reseller_id) REFERENCES resellers(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (policy_id) REFERENCES policies(id) ON DELETE CASCADE,
  FOREIGN KEY (license_key_id) REFERENCES license_keys(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  entitlement_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  session_token TEXT NOT NULL UNIQUE,
  license_token TEXT NOT NULL,
  status TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  last_seen_ip TEXT,
  user_agent TEXT,
  revoked_reason TEXT,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES customer_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (entitlement_id) REFERENCES entitlements(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS request_nonces (
  app_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (app_id, nonce)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_license_keys_product_status ON license_keys(product_id, status);
CREATE INDEX IF NOT EXISTS idx_entitlements_account_status ON entitlements(account_id, status, ends_at);
CREATE INDEX IF NOT EXISTS idx_sessions_status_expires ON sessions(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_bindings_entitlement_status ON device_bindings(entitlement_id, status);
CREATE INDEX IF NOT EXISTS idx_device_blocks_product_status ON device_blocks(product_id, status);
CREATE INDEX IF NOT EXISTS idx_client_versions_product_channel_status
  ON client_versions(product_id, channel, status, released_at);
CREATE INDEX IF NOT EXISTS idx_notices_status_window
  ON notices(status, starts_at, ends_at, channel, block_login);
CREATE INDEX IF NOT EXISTS idx_network_rules_lookup
  ON network_rules(status, action_scope, target_type, product_id);
CREATE INDEX IF NOT EXISTS idx_reseller_inventory_lookup
  ON reseller_inventory(reseller_id, product_id, policy_id, status, allocated_at);
`;

export function createDatabase(config) {
  if (config.dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  }

  const db = new DatabaseSync(config.dbPath);
  db.exec(schema);
  seedAdmin(db, config);
  return db;
}

function seedAdmin(db, config) {
  const countRow = db.prepare("SELECT COUNT(*) AS count FROM admins").get();
  if (countRow.count > 0) {
    return;
  }

  const now = nowIso();
  db.prepare(
    `
      INSERT INTO admins (id, username, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `
  ).run(
    generateId("admin"),
    config.adminUsername,
    hashPassword(config.adminPassword),
    now,
    now
  );
}
