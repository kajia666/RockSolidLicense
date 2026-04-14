import { AppError } from "../http.js";

function one(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

function many(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

function makeSqlPlaceholders(count) {
  return Array.from({ length: Math.max(0, Number(count) || 0) }, () => "?").join(", ");
}

function appendInCondition(columnSql, values, conditions, params) {
  if (!Array.isArray(values)) {
    return;
  }

  const normalized = Array.from(
    new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    )
  );

  if (!normalized.length) {
    conditions.push("1 = 0");
    return;
  }

  conditions.push(`${columnSql} IN (${makeSqlPlaceholders(normalized.length)})`);
  params.push(...normalized);
}

export function normalizeSessionStatus(value, fieldName = "status") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!["active", "expired"].includes(normalized)) {
    throw new AppError(400, "INVALID_SESSION_STATUS", `${fieldName} must be active or expired.`);
  }
  return normalized;
}

function normalizeSessionFilters(filters = {}) {
  return {
    productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
    username: filters.username ? String(filters.username).trim() : null,
    status: filters.status ? normalizeSessionStatus(filters.status) : null,
    search: filters.search ? String(filters.search).trim() : null
  };
}

function likeFilter(value) {
  return `%${String(value ?? "").replace(/[\\%_]/g, "\\$&")}%`;
}

export function getSessionRecordById(db, sessionId) {
  return one(db, "SELECT * FROM sessions WHERE id = ?", sessionId);
}

export function getSessionRecordByProductToken(db, productId, sessionToken) {
  return one(
    db,
    "SELECT * FROM sessions WHERE product_id = ? AND session_token = ?",
    productId,
    sessionToken
  );
}

export function getSessionRecordByToken(db, sessionToken) {
  return one(db, "SELECT * FROM sessions WHERE session_token = ?", sessionToken);
}

export function getActiveSessionHeartbeatRow(db, productId, sessionToken) {
  return one(
    db,
    `
      SELECT s.*, d.fingerprint, a.username, e.status AS entitlement_status,
             pol.heartbeat_interval_seconds, pol.heartbeat_timeout_seconds, pol.token_ttl_seconds,
             lkc.status AS card_control_status, lkc.expires_at AS card_expires_at
      FROM sessions s
      JOIN devices d ON d.id = s.device_id
      JOIN customer_accounts a ON a.id = s.account_id
      JOIN entitlements e ON e.id = s.entitlement_id
      JOIN policies pol ON pol.id = e.policy_id
      JOIN license_keys lk ON lk.id = e.source_license_key_id
      LEFT JOIN license_key_controls lkc ON lkc.license_key_id = lk.id
      WHERE s.product_id = ? AND s.session_token = ? AND s.status = 'active'
    `,
    productId,
    sessionToken
  );
}

export function getSessionManageRowById(db, sessionId) {
  return one(
    db,
    `
      SELECT s.id, s.status, s.revoked_reason, s.product_id, s.account_id,
             pr.code AS product_code, pr.owner_developer_id,
             a.username,
             d.fingerprint
      FROM sessions s
      JOIN customer_accounts a ON a.id = s.account_id
      JOIN devices d ON d.id = s.device_id
      JOIN products pr ON pr.id = s.product_id
      WHERE s.id = ?
    `,
    sessionId
  );
}

export function querySessionRows(db, filters = {}) {
  const conditions = [];
  const params = [];
  const normalizedFilters = normalizeSessionFilters(filters);

  if (normalizedFilters.productCode) {
    conditions.push("pr.code = ?");
    params.push(normalizedFilters.productCode);
  }

  appendInCondition("pr.id", filters.productIds, conditions, params);

  if (normalizedFilters.username) {
    conditions.push("a.username = ?");
    params.push(normalizedFilters.username);
  }

  if (normalizedFilters.status) {
    conditions.push("s.status = ?");
    params.push(normalizedFilters.status);
  }

  if (normalizedFilters.search) {
    const pattern = likeFilter(normalizedFilters.search);
    conditions.push(
      "(a.username LIKE ? ESCAPE '\\' OR d.fingerprint LIKE ? ESCAPE '\\' OR s.id LIKE ? ESCAPE '\\')"
    );
    params.push(pattern, pattern, pattern);
  }

  const items = many(
    db,
    `
      SELECT s.id, s.account_id, s.entitlement_id, s.device_id, s.status, s.issued_at, s.expires_at,
             s.last_heartbeat_at, s.last_seen_ip, s.user_agent, s.revoked_reason,
             pr.id AS product_id, pr.code AS product_code, pr.name AS product_name,
             a.username,
             d.fingerprint, d.device_name,
             pol.name AS policy_name
      FROM sessions s
      JOIN customer_accounts a ON a.id = s.account_id
      JOIN devices d ON d.id = s.device_id
      JOIN products pr ON pr.id = s.product_id
      JOIN entitlements e ON e.id = s.entitlement_id
      JOIN policies pol ON pol.id = e.policy_id
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY s.last_heartbeat_at DESC
      LIMIT 100
    `,
    ...params
  );

  return {
    items,
    total: items.length,
    filters: normalizedFilters
  };
}

export function listActiveSessionExpiryRows(db) {
  return db.prepare(
    `
      SELECT s.id, s.session_token, s.expires_at, s.last_heartbeat_at, p.heartbeat_timeout_seconds
      FROM sessions s
      JOIN entitlements e ON e.id = s.entitlement_id
      JOIN policies p ON p.id = e.policy_id
      WHERE s.status = 'active'
    `
  ).all();
}
