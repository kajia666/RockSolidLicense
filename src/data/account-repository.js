import { AppError } from "../http.js";
import { nowIso } from "../security.js";

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

export function normalizeAccountStatus(value, fieldName = "status") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!["active", "disabled"].includes(normalized)) {
    throw new AppError(400, "INVALID_ACCOUNT_STATUS", `${fieldName} must be active or disabled.`);
  }
  return normalized;
}

function normalizeAccountFilters(filters = {}) {
  const normalizedFilters = {
    accountId: filters.accountId ? String(filters.accountId).trim() : null,
    productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
    status: filters.status ? normalizeAccountStatus(filters.status) : null,
    search: filters.search ? String(filters.search).trim() : null
  };

  return normalizedFilters;
}

function likeFilter(value) {
  return `%${String(value ?? "").replace(/[\\%_]/g, "\\$&")}%`;
}

export function formatAccountRow(row) {
  return {
    id: row.id,
    productId: row.product_id,
    productCode: row.product_code,
    productName: row.product_name ?? "",
    ownerDeveloperId: row.owner_developer_id ?? null,
    username: row.username,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at ?? null,
    activeEntitlementCount: Number(row.active_entitlement_count ?? 0),
    latestEntitlementEndsAt: row.latest_entitlement_ends_at ?? null,
    activeSessionCount: Number(row.active_session_count ?? 0),
    product_id: row.product_id,
    product_code: row.product_code,
    product_name: row.product_name ?? "",
    owner_developer_id: row.owner_developer_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at ?? null,
    active_entitlement_count: Number(row.active_entitlement_count ?? 0),
    latest_entitlement_ends_at: row.latest_entitlement_ends_at ?? null,
    active_session_count: Number(row.active_session_count ?? 0)
  };
}

function accountSelectSql(whereClause = "") {
  return `
    SELECT a.id, a.product_id, a.username, a.status, a.created_at, a.updated_at, a.last_login_at,
           pr.code AS product_code, pr.name AS product_name, pr.owner_developer_id,
           COALESCE(ent.active_entitlement_count, 0) AS active_entitlement_count,
           ent.latest_entitlement_ends_at,
           COALESCE(sess.active_session_count, 0) AS active_session_count
    FROM customer_accounts a
    JOIN products pr ON pr.id = a.product_id
    LEFT JOIN (
      SELECT account_id,
             COUNT(*) AS active_entitlement_count,
             MAX(ends_at) AS latest_entitlement_ends_at
      FROM entitlements
      WHERE status = 'active' AND ends_at > ?
      GROUP BY account_id
    ) ent ON ent.account_id = a.id
    LEFT JOIN (
      SELECT account_id, COUNT(*) AS active_session_count
      FROM sessions
      WHERE status = 'active'
      GROUP BY account_id
    ) sess ON sess.account_id = a.id
    ${whereClause}
  `;
}

export function queryAccountRows(db, filters = {}) {
  const conditions = [];
  const params = [nowIso()];
  const normalizedFilters = normalizeAccountFilters(filters);

  if (normalizedFilters.accountId) {
    conditions.push("a.id = ?");
    params.push(normalizedFilters.accountId);
  }

  if (normalizedFilters.productCode) {
    conditions.push("pr.code = ?");
    params.push(normalizedFilters.productCode);
  }

  appendInCondition("pr.id", filters.productIds, conditions, params);

  if (normalizedFilters.status) {
    conditions.push("a.status = ?");
    params.push(normalizedFilters.status);
  }

  if (normalizedFilters.search) {
    const pattern = likeFilter(normalizedFilters.search);
    conditions.push("(a.username LIKE ? ESCAPE '\\' OR pr.code LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }

  const rows = many(
    db,
    `${accountSelectSql(conditions.length ? `WHERE ${conditions.join(" AND ")}` : "")}
     ORDER BY a.created_at DESC
     LIMIT 100`,
    ...params
  );

  const items = rows.map(formatAccountRow);
  return {
    items,
    total: items.length,
    filters: normalizedFilters
  };
}

export function getAccountManageRowById(db, accountId) {
  return queryAccountRows(db, { accountId }).items[0] ?? null;
}

export function getAccountRecordById(db, accountId) {
  return one(db, "SELECT * FROM customer_accounts WHERE id = ?", accountId);
}

export function getAccountRecordByProductUsername(db, productId, username, status = null) {
  const normalizedUsername = String(username ?? "").trim();
  if (status) {
    return one(
      db,
      `
        SELECT *
        FROM customer_accounts
        WHERE product_id = ? AND username = ? AND status = ?
      `,
      productId,
      normalizedUsername,
      normalizeAccountStatus(status)
    );
  }

  return one(
    db,
    `
      SELECT *
      FROM customer_accounts
      WHERE product_id = ? AND username = ?
    `,
    productId,
    normalizedUsername
  );
}

export function accountUsernameExists(db, productId, username) {
  return Boolean(
    one(
      db,
      "SELECT id FROM customer_accounts WHERE product_id = ? AND username = ?",
      productId,
      String(username ?? "").trim()
    )
  );
}
