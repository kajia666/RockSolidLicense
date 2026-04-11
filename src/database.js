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

CREATE TABLE IF NOT EXISTS policy_bind_configs (
  policy_id TEXT PRIMARY KEY,
  bind_mode TEXT NOT NULL,
  bind_fields_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (policy_id) REFERENCES policies(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS policy_unbind_configs (
  policy_id TEXT PRIMARY KEY,
  allow_client_unbind INTEGER NOT NULL DEFAULT 0,
  client_unbind_limit INTEGER NOT NULL DEFAULT 0,
  client_unbind_window_days INTEGER NOT NULL DEFAULT 30,
  client_unbind_deduct_days INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (policy_id) REFERENCES policies(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS policy_grant_configs (
  policy_id TEXT PRIMARY KEY,
  grant_type TEXT NOT NULL DEFAULT 'duration',
  grant_points INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (policy_id) REFERENCES policies(id) ON DELETE CASCADE
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

CREATE TABLE IF NOT EXISTS license_key_controls (
  license_key_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  expires_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (license_key_id) REFERENCES license_keys(id) ON DELETE CASCADE
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

CREATE TABLE IF NOT EXISTS card_login_accounts (
  license_key_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE,
  product_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (license_key_id) REFERENCES license_keys(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES customer_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
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

CREATE TABLE IF NOT EXISTS device_binding_profiles (
  binding_id TEXT PRIMARY KEY,
  entitlement_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  identity_hash TEXT NOT NULL,
  match_fields_json TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  request_ip TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (binding_id) REFERENCES device_bindings(id) ON DELETE CASCADE,
  FOREIGN KEY (entitlement_id) REFERENCES entitlements(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  UNIQUE(entitlement_id, identity_hash)
);

CREATE TABLE IF NOT EXISTS entitlement_unbind_logs (
  id TEXT PRIMARY KEY,
  entitlement_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  reason TEXT NOT NULL,
  deducted_days INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (entitlement_id) REFERENCES entitlements(id) ON DELETE CASCADE,
  FOREIGN KEY (binding_id) REFERENCES device_bindings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS entitlement_metering (
  entitlement_id TEXT PRIMARY KEY,
  grant_type TEXT NOT NULL,
  total_points INTEGER NOT NULL DEFAULT 0,
  remaining_points INTEGER NOT NULL DEFAULT 0,
  consumed_points INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (entitlement_id) REFERENCES entitlements(id) ON DELETE CASCADE
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

CREATE TABLE IF NOT EXISTS reseller_relations (
  reseller_id TEXT PRIMARY KEY,
  parent_reseller_id TEXT,
  can_view_descendants INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (reseller_id) REFERENCES resellers(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_reseller_id) REFERENCES resellers(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS reseller_users (
  id TEXT PRIMARY KEY,
  reseller_id TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT,
  FOREIGN KEY (reseller_id) REFERENCES resellers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reseller_sessions (
  id TEXT PRIMARY KEY,
  reseller_user_id TEXT NOT NULL,
  reseller_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  FOREIGN KEY (reseller_user_id) REFERENCES reseller_users(id) ON DELETE CASCADE,
  FOREIGN KEY (reseller_id) REFERENCES resellers(id) ON DELETE CASCADE
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

CREATE TABLE IF NOT EXISTS reseller_price_rules (
  id TEXT PRIMARY KEY,
  reseller_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  policy_id TEXT,
  status TEXT NOT NULL,
  currency TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  unit_cost_cents INTEGER NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (reseller_id) REFERENCES resellers(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (policy_id) REFERENCES policies(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reseller_settlement_snapshots (
  id TEXT PRIMARY KEY,
  reseller_inventory_id TEXT NOT NULL UNIQUE,
  reseller_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  license_key_id TEXT NOT NULL UNIQUE,
  price_rule_id TEXT NOT NULL,
  allocation_batch_code TEXT NOT NULL,
  currency TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  unit_cost_cents INTEGER NOT NULL,
  commission_amount_cents INTEGER NOT NULL,
  priced_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (reseller_inventory_id) REFERENCES reseller_inventory(id) ON DELETE CASCADE,
  FOREIGN KEY (reseller_id) REFERENCES resellers(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (policy_id) REFERENCES policies(id) ON DELETE CASCADE,
  FOREIGN KEY (license_key_id) REFERENCES license_keys(id) ON DELETE CASCADE,
  FOREIGN KEY (price_rule_id) REFERENCES reseller_price_rules(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reseller_statements (
  id TEXT PRIMARY KEY,
  reseller_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  statement_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  product_id TEXT,
  period_start TEXT,
  period_end TEXT,
  item_count INTEGER NOT NULL,
  gross_amount_cents INTEGER NOT NULL,
  cost_amount_cents INTEGER NOT NULL,
  commission_amount_cents INTEGER NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paid_at TEXT,
  FOREIGN KEY (reseller_id) REFERENCES resellers(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS reseller_statement_items (
  id TEXT PRIMARY KEY,
  statement_id TEXT NOT NULL,
  settlement_snapshot_id TEXT NOT NULL UNIQUE,
  reseller_inventory_id TEXT NOT NULL UNIQUE,
  license_key_id TEXT NOT NULL UNIQUE,
  redeemed_at TEXT NOT NULL,
  gross_amount_cents INTEGER NOT NULL,
  cost_amount_cents INTEGER NOT NULL,
  commission_amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (statement_id) REFERENCES reseller_statements(id) ON DELETE CASCADE,
  FOREIGN KEY (settlement_snapshot_id) REFERENCES reseller_settlement_snapshots(id) ON DELETE CASCADE,
  FOREIGN KEY (reseller_inventory_id) REFERENCES reseller_inventory(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS idx_license_key_controls_status ON license_key_controls(status, expires_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_policy_bind_configs_mode ON policy_bind_configs(bind_mode, updated_at);
CREATE INDEX IF NOT EXISTS idx_policy_unbind_configs_lookup
  ON policy_unbind_configs(allow_client_unbind, client_unbind_limit, updated_at);
CREATE INDEX IF NOT EXISTS idx_policy_grant_configs_lookup
  ON policy_grant_configs(grant_type, grant_points, updated_at);
CREATE INDEX IF NOT EXISTS idx_entitlements_account_status ON entitlements(account_id, status, ends_at);
CREATE INDEX IF NOT EXISTS idx_entitlement_metering_lookup
  ON entitlement_metering(grant_type, remaining_points, updated_at);
CREATE INDEX IF NOT EXISTS idx_card_login_accounts_product ON card_login_accounts(product_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_status_expires ON sessions(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_bindings_entitlement_status ON device_bindings(entitlement_id, status);
CREATE INDEX IF NOT EXISTS idx_binding_profiles_lookup
  ON device_binding_profiles(entitlement_id, identity_hash, device_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_entitlement_unbind_logs_lookup
  ON entitlement_unbind_logs(entitlement_id, actor_type, created_at);
CREATE INDEX IF NOT EXISTS idx_device_blocks_product_status ON device_blocks(product_id, status);
CREATE INDEX IF NOT EXISTS idx_client_versions_product_channel_status
  ON client_versions(product_id, channel, status, released_at);
CREATE INDEX IF NOT EXISTS idx_notices_status_window
  ON notices(status, starts_at, ends_at, channel, block_login);
CREATE INDEX IF NOT EXISTS idx_network_rules_lookup
  ON network_rules(status, action_scope, target_type, product_id);
CREATE INDEX IF NOT EXISTS idx_reseller_relations_parent
  ON reseller_relations(parent_reseller_id, can_view_descendants, updated_at);
CREATE INDEX IF NOT EXISTS idx_reseller_users_reseller
  ON reseller_users(reseller_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_reseller_sessions_lookup
  ON reseller_sessions(reseller_id, expires_at, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_reseller_inventory_lookup
  ON reseller_inventory(reseller_id, product_id, policy_id, status, allocated_at);
CREATE INDEX IF NOT EXISTS idx_reseller_price_rules_lookup
  ON reseller_price_rules(reseller_id, product_id, policy_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_reseller_settlement_lookup
  ON reseller_settlement_snapshots(reseller_id, product_id, policy_id, currency, priced_at);
CREATE INDEX IF NOT EXISTS idx_reseller_statements_lookup
  ON reseller_statements(reseller_id, currency, status, created_at);
CREATE INDEX IF NOT EXISTS idx_reseller_statement_items_lookup
  ON reseller_statement_items(statement_id, redeemed_at);
`;

export function createDatabase(config) {
  if (config.dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  }

  const db = new DatabaseSync(config.dbPath);
  db.exec(schema);
  seedAdmin(db, config);
  seedResellerRelations(db);
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

function seedResellerRelations(db) {
  const now = nowIso();
  const rows = db.prepare(
    `
      SELECT r.id
      FROM resellers r
      LEFT JOIN reseller_relations rr ON rr.reseller_id = r.id
      WHERE rr.reseller_id IS NULL
    `
  ).all();

  const insert = db.prepare(
    `
      INSERT INTO reseller_relations
      (reseller_id, parent_reseller_id, can_view_descendants, created_at, updated_at)
      VALUES (?, NULL, 1, ?, ?)
    `
  );

  for (const row of rows) {
    insert.run(row.id, now, now);
  }
}
