import { AppError } from "../http.js";
import { nowIso } from "../security.js";
import { describeLicenseKeyControl } from "./card-repository.js";
import { normalizeGrantType } from "./policy-repository.js";

const SUPPORTED_ENTITLEMENT_STATUSES = new Set(["active", "frozen"]);

function one(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

function many(db, sql, ...params) {
  return db.prepare(sql).all(...params);
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

  conditions.push(`${columnSql} IN (${normalized.map(() => "?").join(", ")})`);
  params.push(...normalized);
}

function escapeLikeText(value) {
  return String(value).replace(/[%_]/g, "\\$&");
}

function likeFilter(value) {
  return `%${escapeLikeText(value).trim()}%`;
}

export function normalizeEntitlementStatus(value = "active") {
  const status = String(value ?? "active").trim().toLowerCase();
  if (!SUPPORTED_ENTITLEMENT_STATUSES.has(status)) {
    throw new AppError(
      400,
      "INVALID_ENTITLEMENT_STATUS",
      `Entitlement status must be one of: ${Array.from(SUPPORTED_ENTITLEMENT_STATUSES).join(", ")}.`
    );
  }
  return status;
}

export function getUsableDurationEntitlement(db, accountId, productId, now) {
  return one(
    db,
    `
      SELECT e.*, p.name AS policy_name, p.max_devices, p.allow_concurrent_sessions,
             p.heartbeat_interval_seconds, p.heartbeat_timeout_seconds, p.token_ttl_seconds, p.bind_mode,
             lkc.status AS card_control_status, lkc.expires_at AS card_expires_at,
             pgc.grant_type, pgc.grant_points,
             em.total_points, em.remaining_points, em.consumed_points
      FROM entitlements e
      JOIN policies p ON p.id = e.policy_id
      JOIN license_keys lk ON lk.id = e.source_license_key_id
      LEFT JOIN license_key_controls lkc ON lkc.license_key_id = lk.id
      LEFT JOIN policy_grant_configs pgc ON pgc.policy_id = p.id
      LEFT JOIN entitlement_metering em ON em.entitlement_id = e.id
      WHERE e.account_id = ?
        AND e.product_id = ?
        AND e.status = 'active'
        AND e.starts_at <= ?
        AND e.ends_at > ?
        AND COALESCE(pgc.grant_type, 'duration') = 'duration'
        AND (lkc.license_key_id IS NULL OR lkc.status = 'active')
        AND (lkc.expires_at IS NULL OR lkc.expires_at > ?)
      ORDER BY e.ends_at DESC
      LIMIT 1
    `,
    accountId,
    productId,
    now,
    now,
    now
  );
}

export function getUsablePointsEntitlement(db, accountId, productId, now) {
  return one(
    db,
    `
      SELECT e.*, p.name AS policy_name, p.max_devices, p.allow_concurrent_sessions,
             p.heartbeat_interval_seconds, p.heartbeat_timeout_seconds, p.token_ttl_seconds, p.bind_mode,
             lkc.status AS card_control_status, lkc.expires_at AS card_expires_at,
             pgc.grant_type, pgc.grant_points,
             em.total_points, em.remaining_points, em.consumed_points
      FROM entitlements e
      JOIN policies p ON p.id = e.policy_id
      JOIN license_keys lk ON lk.id = e.source_license_key_id
      LEFT JOIN license_key_controls lkc ON lkc.license_key_id = lk.id
      JOIN policy_grant_configs pgc ON pgc.policy_id = p.id
      JOIN entitlement_metering em ON em.entitlement_id = e.id
      WHERE e.account_id = ?
        AND e.product_id = ?
        AND e.status = 'active'
        AND e.starts_at <= ?
        AND e.ends_at > ?
        AND pgc.grant_type = 'points'
        AND em.remaining_points > 0
        AND (lkc.license_key_id IS NULL OR lkc.status = 'active')
        AND (lkc.expires_at IS NULL OR lkc.expires_at > ?)
      ORDER BY e.created_at ASC, e.ends_at ASC
      LIMIT 1
    `,
    accountId,
    productId,
    now,
    now,
    now
  );
}

export function getUsableEntitlement(db, accountId, productId, now) {
  return getUsableDurationEntitlement(db, accountId, productId, now)
    ?? getUsablePointsEntitlement(db, accountId, productId, now);
}

export function getLatestEntitlementSnapshot(db, accountId, productId) {
  return one(
    db,
    `
      SELECT e.*, p.name AS policy_name, p.max_devices, p.allow_concurrent_sessions,
             p.heartbeat_interval_seconds, p.heartbeat_timeout_seconds, p.token_ttl_seconds, p.bind_mode,
             lkc.status AS card_control_status, lkc.expires_at AS card_expires_at,
             pgc.grant_type, pgc.grant_points,
             em.total_points, em.remaining_points, em.consumed_points
      FROM entitlements e
      JOIN policies p ON p.id = e.policy_id
      JOIN license_keys lk ON lk.id = e.source_license_key_id
      LEFT JOIN license_key_controls lkc ON lkc.license_key_id = lk.id
      LEFT JOIN policy_grant_configs pgc ON pgc.policy_id = p.id
      LEFT JOIN entitlement_metering em ON em.entitlement_id = e.id
      WHERE e.account_id = ? AND e.product_id = ?
      ORDER BY e.ends_at DESC, e.created_at DESC
      LIMIT 1
    `,
    accountId,
    productId
  );
}

export function entitlementLifecycleStatus(row, referenceTime = nowIso()) {
  if (row.ends_at <= referenceTime) {
    return "expired";
  }
  return row.status === "frozen" ? "frozen" : "active";
}

export function formatEntitlementGrant(row) {
  return {
    grantType: normalizeGrantType(row.grant_type ?? "duration"),
    grantPoints: Number(row.grant_points ?? 0),
    totalPoints: row.total_points === null || row.total_points === undefined ? null : Number(row.total_points),
    remainingPoints: row.remaining_points === null || row.remaining_points === undefined ? null : Number(row.remaining_points),
    consumedPoints: row.consumed_points === null || row.consumed_points === undefined ? null : Number(row.consumed_points)
  };
}

export function queryEntitlementRows(db, filters = {}, options = {}) {
  const now = nowIso();
  const normalizedFilters = {
    productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
    username: filters.username ? String(filters.username).trim() : null,
    status: filters.status ? String(filters.status).trim().toLowerCase() : null,
    grantType: filters.grantType ? normalizeGrantType(filters.grantType) : null,
    search: filters.search ? String(filters.search).trim() : null
  };
  const conditions = [];
  const params = [];

  if (normalizedFilters.productCode) {
    conditions.push("pr.code = ?");
    params.push(normalizedFilters.productCode);
  }

  appendInCondition("pr.id", filters.productIds, conditions, params);

  if (normalizedFilters.username) {
    conditions.push("a.username = ?");
    params.push(normalizedFilters.username);
  }

  if (normalizedFilters.grantType) {
    conditions.push("COALESCE(pgc.grant_type, 'duration') = ?");
    params.push(normalizedFilters.grantType);
  }

  if (normalizedFilters.search) {
    const pattern = likeFilter(normalizedFilters.search);
    conditions.push(
      "(a.username LIKE ? ESCAPE '\\' OR lk.card_key LIKE ? ESCAPE '\\' OR pr.code LIKE ? ESCAPE '\\' OR pol.name LIKE ? ESCAPE '\\')"
    );
    params.push(pattern, pattern, pattern, pattern);
  }

  const limit = options.limit === undefined || options.limit === null
    ? 300
    : Math.min(Math.max(Number(options.limit), 1), 2000);

  const items = many(
    db,
    `
      SELECT e.*, pr.code AS product_code, pr.name AS product_name,
             a.username, pol.name AS policy_name,
             lk.card_key, lk.id AS license_key_id,
             lkc.status AS card_control_status, lkc.expires_at AS card_expires_at,
             pgc.grant_type, pgc.grant_points,
             em.total_points, em.remaining_points, em.consumed_points,
             COALESCE(sess.active_session_count, 0) AS active_session_count
      FROM entitlements e
      JOIN products pr ON pr.id = e.product_id
      JOIN customer_accounts a ON a.id = e.account_id
      JOIN policies pol ON pol.id = e.policy_id
      JOIN license_keys lk ON lk.id = e.source_license_key_id
      LEFT JOIN license_key_controls lkc ON lkc.license_key_id = lk.id
      LEFT JOIN policy_grant_configs pgc ON pgc.policy_id = pol.id
      LEFT JOIN entitlement_metering em ON em.entitlement_id = e.id
      LEFT JOIN (
        SELECT entitlement_id, COUNT(*) AS active_session_count
        FROM sessions
        WHERE status = 'active'
        GROUP BY entitlement_id
      ) sess ON sess.entitlement_id = e.id
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY e.ends_at DESC, e.created_at DESC
      LIMIT ${limit}
    `,
    ...params
  ).map((row) => {
    const control = describeLicenseKeyControl({
      status: row.card_control_status,
      expires_at: row.card_expires_at
    }, now);
    const grant = formatEntitlementGrant(row);
    return {
      id: row.id,
      productCode: row.product_code,
      productName: row.product_name,
      accountId: row.account_id,
      username: row.username,
      policyId: row.policy_id,
      policyName: row.policy_name,
      sourceLicenseKeyId: row.source_license_key_id,
      sourceCardKey: row.card_key,
      status: row.status,
      lifecycleStatus: entitlementLifecycleStatus(row, now),
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      grantType: grant.grantType,
      grantPoints: grant.grantPoints,
      totalPoints: grant.totalPoints,
      remainingPoints: grant.remainingPoints,
      consumedPoints: grant.consumedPoints,
      activeSessionCount: Number(row.active_session_count ?? 0),
      cardControlStatus: control.status,
      cardEffectiveStatus: control.effectiveStatus,
      cardExpiresAt: control.expiresAt,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }).filter((item) => {
    if (!normalizedFilters.status) {
      return true;
    }
    return item.lifecycleStatus === normalizedFilters.status;
  });

  return {
    items,
    filters: normalizedFilters
  };
}

export function loadPointEntitlementForAdmin(db, entitlementId) {
  return one(
    db,
    `
      SELECT e.id, e.status, e.ends_at, e.account_id,
             pr.code AS product_code, pr.name AS product_name,
             a.username,
             pol.name AS policy_name,
             COALESCE(pgc.grant_type, 'duration') AS grant_type,
             COALESCE(pgc.grant_points, 0) AS grant_points,
             em.total_points, em.remaining_points, em.consumed_points,
             COALESCE(sess.active_session_count, 0) AS active_session_count
      FROM entitlements e
      JOIN products pr ON pr.id = e.product_id
      JOIN customer_accounts a ON a.id = e.account_id
      JOIN policies pol ON pol.id = e.policy_id
      LEFT JOIN policy_grant_configs pgc ON pgc.policy_id = e.policy_id
      LEFT JOIN entitlement_metering em ON em.entitlement_id = e.id
      LEFT JOIN (
        SELECT entitlement_id, COUNT(*) AS active_session_count
        FROM sessions
        WHERE status = 'active'
        GROUP BY entitlement_id
      ) sess ON sess.entitlement_id = e.id
      WHERE e.id = ?
    `,
    entitlementId
  );
}
