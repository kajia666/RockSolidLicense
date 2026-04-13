import { AppError } from "../http.js";
import { nowIso } from "../security.js";
import { normalizeGrantType } from "./policy-repository.js";

const SUPPORTED_CARD_CONTROL_STATUSES = new Set(["active", "frozen", "revoked"]);
const SUPPORTED_CARD_DISPLAY_STATUSES = new Set(["unused", "used", "frozen", "revoked", "expired"]);

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

export function maskCardKey(cardKey) {
  const normalized = String(cardKey ?? "")
    .trim()
    .toUpperCase();
  if (!normalized) {
    return "";
  }

  const parts = normalized.split("-");
  const lastPart = parts.at(-1) ?? normalized;
  if (parts.length >= 2) {
    return `${parts[0]}-******-${lastPart.slice(-4)}`;
  }

  if (normalized.length <= 6) {
    return `${normalized.slice(0, 2)}***`;
  }

  return `${normalized.slice(0, 2)}******${normalized.slice(-4)}`;
}

export function normalizeCardControlStatus(value = "active") {
  const status = String(value ?? "active").trim().toLowerCase();
  if (!SUPPORTED_CARD_CONTROL_STATUSES.has(status)) {
    throw new AppError(
      400,
      "INVALID_CARD_STATUS",
      `Card status must be one of: ${Array.from(SUPPORTED_CARD_CONTROL_STATUSES).join(", ")}.`
    );
  }
  return status;
}

function normalizeCardDisplayStatus(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }

  const status = String(value).trim().toLowerCase();
  if (!SUPPORTED_CARD_DISPLAY_STATUSES.has(status)) {
    throw new AppError(
      400,
      "INVALID_CARD_DISPLAY_STATUS",
      `Card filter status must be one of: ${Array.from(SUPPORTED_CARD_DISPLAY_STATUSES).join(", ")}.`
    );
  }

  return status;
}

export function describeLicenseKeyControl(row, referenceTime = nowIso()) {
  const status = normalizeCardControlStatus(row?.status ?? "active");
  const expiresAt = row?.expires_at ?? null;
  const expired = Boolean(expiresAt && expiresAt <= referenceTime);
  const effectiveStatus = expired ? "expired" : status;

  return {
    status,
    expiresAt,
    notes: row?.notes ?? null,
    effectiveStatus,
    available: effectiveStatus === "active"
  };
}

function buildCardDisplayStatus(usageStatus, controlState) {
  if (controlState.effectiveStatus === "expired") {
    return "expired";
  }
  if (controlState.status === "frozen") {
    return "frozen";
  }
  if (controlState.status === "revoked") {
    return "revoked";
  }
  return usageStatus === "redeemed" ? "used" : "unused";
}

function formatCardRow(row, referenceTime = nowIso()) {
  const control = describeLicenseKeyControl({
    status: row.control_status,
    expires_at: row.expires_at,
    notes: row.control_notes ?? row.notes
  }, referenceTime);
  const usageStatus = row.status === "redeemed" ? "redeemed" : "fresh";
  const displayStatus = buildCardDisplayStatus(usageStatus, control);
  const entitlementEndsAt = row.entitlement_ends_at ?? null;
  const entitlementLifecycleStatus = !row.entitlement_id
    ? null
    : entitlementEndsAt && entitlementEndsAt <= referenceTime
      ? "expired"
      : row.entitlement_status === "frozen"
        ? "frozen"
        : row.entitlement_status ?? "active";

  return {
    id: row.id,
    productId: row.product_id,
    productCode: row.product_code,
    productName: row.product_name,
    policyId: row.policy_id,
    policyName: row.policy_name,
    grantType: normalizeGrantType(row.grant_type ?? "duration"),
    grantPoints: Number(row.grant_points ?? 0),
    batchCode: row.batch_code,
    cardKey: row.card_key,
    maskedKey: maskCardKey(row.card_key),
    usageStatus,
    controlStatus: control.status,
    effectiveControlStatus: control.effectiveStatus,
    displayStatus,
    available: control.available && usageStatus === "fresh",
    notes: row.notes ?? control.notes ?? null,
    expiresAt: control.expiresAt,
    issuedAt: row.issued_at,
    redeemedAt: row.redeemed_at ?? null,
    redeemedUsername: row.redeemed_username ?? null,
    redeemedByAccountId: row.redeemed_by_account_id ?? null,
    entitlementId: row.entitlement_id ?? null,
    entitlementStatus: row.entitlement_status ?? null,
    entitlementLifecycleStatus,
    entitlementEndsAt,
    resellerId: row.reseller_id ?? null,
    resellerCode: row.reseller_code ?? null,
    resellerName: row.reseller_name ?? null
  };
}

function normalizeCardFilters(filters = {}) {
  return {
    productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
    policyId: filters.policyId ? String(filters.policyId).trim() : null,
    batchCode: filters.batchCode ? String(filters.batchCode).trim() : null,
    usageStatus: filters.usageStatus ? String(filters.usageStatus).trim().toLowerCase() : null,
    status: normalizeCardDisplayStatus(filters.status),
    resellerId: filters.resellerId ? String(filters.resellerId).trim() : null,
    search: filters.search ? String(filters.search).trim() : null
  };
}

function buildCardSelectSql(whereClause = "", limit = 500) {
  return `
      SELECT lk.*, pr.code AS product_code, pr.name AS product_name,
             pol.name AS policy_name,
             pgc.grant_type, pgc.grant_points,
             a.username AS redeemed_username,
             lkc.status AS control_status, lkc.expires_at, lkc.notes AS control_notes,
             e.id AS entitlement_id, e.status AS entitlement_status, e.ends_at AS entitlement_ends_at,
             r.id AS reseller_id, r.code AS reseller_code, r.name AS reseller_name
      FROM license_keys lk
      JOIN products pr ON pr.id = lk.product_id
      JOIN policies pol ON pol.id = lk.policy_id
      LEFT JOIN policy_grant_configs pgc ON pgc.policy_id = pol.id
      LEFT JOIN customer_accounts a ON a.id = lk.redeemed_by_account_id
      LEFT JOIN license_key_controls lkc ON lkc.license_key_id = lk.id
      LEFT JOIN entitlements e ON e.source_license_key_id = lk.id
      LEFT JOIN reseller_inventory ri ON ri.license_key_id = lk.id AND ri.status = 'active'
      LEFT JOIN resellers r ON r.id = ri.reseller_id
      ${whereClause}
      ORDER BY lk.issued_at DESC, lk.id DESC
      LIMIT ${limit}
    `;
}

export function queryCardRows(db, filters = {}, options = {}) {
  const normalizedFilters = normalizeCardFilters(filters);
  const conditions = [];
  const params = [];

  if (filters.ownerDeveloperId) {
    conditions.push("pr.owner_developer_id = ?");
    params.push(filters.ownerDeveloperId);
  }
  appendInCondition("pr.id", filters.productIds, conditions, params);

  if (normalizedFilters.productCode) {
    conditions.push("pr.code = ?");
    params.push(normalizedFilters.productCode);
  }

  if (normalizedFilters.policyId) {
    conditions.push("lk.policy_id = ?");
    params.push(normalizedFilters.policyId);
  }

  if (normalizedFilters.batchCode) {
    conditions.push("lk.batch_code = ?");
    params.push(normalizedFilters.batchCode);
  }

  if (normalizedFilters.usageStatus) {
    if (!["fresh", "redeemed", "unused", "used"].includes(normalizedFilters.usageStatus)) {
      throw new AppError(400, "INVALID_CARD_USAGE_STATUS", "usageStatus must be fresh, redeemed, unused, or used.");
    }
    conditions.push("lk.status = ?");
    params.push(["unused", "fresh"].includes(normalizedFilters.usageStatus) ? "fresh" : "redeemed");
  }

  if (normalizedFilters.resellerId) {
    conditions.push("ri.reseller_id = ?");
    params.push(normalizedFilters.resellerId);
  }

  if (normalizedFilters.search) {
    const pattern = likeFilter(normalizedFilters.search);
    conditions.push(
      "(lk.card_key LIKE ? ESCAPE '\\' OR lk.batch_code LIKE ? ESCAPE '\\' OR COALESCE(a.username, '') LIKE ? ESCAPE '\\' OR COALESCE(r.code, '') LIKE ? ESCAPE '\\')"
    );
    params.push(pattern, pattern, pattern, pattern);
  }

  const limit = options.limit === undefined || options.limit === null
    ? 500
    : Math.min(Math.max(Number(options.limit), 1), 5000);
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const items = many(
    db,
    buildCardSelectSql(whereClause, limit),
    ...params
  )
    .map((row) => formatCardRow({
      ...row,
      status: row.status,
      notes: row.control_notes ?? row.notes
    }))
    .filter((item) => !normalizedFilters.status || item.displayStatus === normalizedFilters.status);

  const summary = items.reduce((accumulator, item) => {
    accumulator.total += 1;
    accumulator[item.displayStatus] += 1;
    return accumulator;
  }, {
    total: 0,
    unused: 0,
    used: 0,
    frozen: 0,
    revoked: 0,
    expired: 0
  });

  return {
    items,
    summary,
    filters: normalizedFilters
  };
}

export function getCardRowById(db, cardId) {
  const row = one(
    db,
    buildCardSelectSql("WHERE lk.id = ?", 1),
    cardId
  );

  return row ? formatCardRow({
    ...row,
    status: row.status,
    notes: row.control_notes ?? row.notes
  }) : null;
}
