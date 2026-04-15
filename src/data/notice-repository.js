import { AppError } from "../http.js";
import { nowIso } from "../security.js";
import { normalizeChannel, normalizeOptionalChannel } from "./client-version-repository.js";
import { appendSqliteInCondition, likeFilter } from "./query-helpers.js";

function many(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

export function normalizeNoticeChannel(value, fallback = "all") {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  return normalizeChannel(value, fallback);
}

export function normalizeNoticeKind(value, fieldName = "kind") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!["announcement", "maintenance"].includes(normalized)) {
    const message = fieldName === "kind"
      ? "Notice kind must be announcement or maintenance."
      : `${fieldName} must be announcement or maintenance.`;
    throw new AppError(400, "INVALID_NOTICE_KIND", message);
  }
  return normalized;
}

export function normalizeNoticeStatus(value, fieldName = "status") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!["active", "archived"].includes(normalized)) {
    const message = fieldName === "status"
      ? "Notice status must be active or archived."
      : `${fieldName} must be active or archived.`;
    throw new AppError(400, "INVALID_NOTICE_STATUS", message);
  }
  return normalized;
}

export function formatNotice(row) {
  return {
    id: row.id,
    productCode: row.product_code ?? null,
    productName: row.product_name ?? null,
    channel: row.channel,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    body: row.body,
    actionUrl: row.action_url,
    status: row.status,
    blockLogin: Boolean(row.block_login),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function formatNoticeManageRow(row) {
  return {
    ...formatNotice(row),
    productId: row.product_id ?? null,
    ownerDeveloperId: row.owner_developer_id ?? null
  };
}

export function listActiveNoticesForProduct(db, productId, channel = "all", referenceTime = nowIso()) {
  const normalizedChannel = normalizeNoticeChannel(channel, "stable");
  return many(
    db,
    `
      SELECT n.*, pr.code AS product_code, pr.name AS product_name
      FROM notices n
      LEFT JOIN products pr ON pr.id = n.product_id
      WHERE n.status = 'active'
        AND n.starts_at <= ?
        AND (n.ends_at IS NULL OR n.ends_at > ?)
        AND (n.product_id IS NULL OR n.product_id = ?)
        AND (n.channel = 'all' OR n.channel = ?)
      ORDER BY n.block_login DESC, n.starts_at DESC, n.created_at DESC
    `,
    referenceTime,
    referenceTime,
    productId,
    normalizedChannel
  ).map((row) => formatNotice(row));
}

export function queryNoticeRows(db, filters = {}) {
  const conditions = [];
  const params = [];
  const normalizedFilters = {
    productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
    channel: normalizeOptionalChannel(filters.channel) ?? "all",
    kind: filters.kind ? normalizeNoticeKind(filters.kind) : null,
    status: filters.status ? normalizeNoticeStatus(filters.status) : null,
    search: filters.search ? String(filters.search).trim() : null,
    ownerDeveloperId: filters.ownerDeveloperId ? String(filters.ownerDeveloperId).trim() : null
  };

  if (normalizedFilters.productCode) {
    conditions.push("pr.code = ?");
    params.push(normalizedFilters.productCode);
  }

  if (normalizedFilters.ownerDeveloperId) {
    conditions.push("pr.owner_developer_id = ?");
    params.push(normalizedFilters.ownerDeveloperId);
  }

  appendSqliteInCondition("n.product_id", filters.productIds, conditions, params);

  if (filters.channel !== undefined && filters.channel !== null && String(filters.channel).trim() !== "") {
    conditions.push("n.channel = ?");
    params.push(normalizedFilters.channel);
  }

  if (normalizedFilters.kind) {
    conditions.push("n.kind = ?");
    params.push(normalizedFilters.kind);
  }

  if (normalizedFilters.status) {
    conditions.push("n.status = ?");
    params.push(normalizedFilters.status);
  }

  if (normalizedFilters.search) {
    const pattern = likeFilter(normalizedFilters.search);
    conditions.push(
      "(n.title LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\' OR COALESCE(pr.code, '') LIKE ? ESCAPE '\\')"
    );
    params.push(pattern, pattern, pattern);
  }

  const items = many(
    db,
    `
      SELECT n.*, pr.code AS product_code, pr.name AS product_name
      FROM notices n
      LEFT JOIN products pr ON pr.id = n.product_id
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY n.starts_at DESC, n.created_at DESC
      LIMIT 100
    `,
    ...params
  );

  return {
    items: items.map((row) => formatNotice(row)),
    total: items.length,
    filters: {
      productCode: normalizedFilters.productCode,
      channel: normalizedFilters.channel,
      kind: normalizedFilters.kind,
      status: normalizedFilters.status,
      search: normalizedFilters.search
    }
  };
}

export function getNoticeRowById(db, noticeId) {
  const row = db.prepare(
    `
      SELECT n.*, pr.code AS product_code, pr.name AS product_name, pr.owner_developer_id
      FROM notices n
      LEFT JOIN products pr ON pr.id = n.product_id
      WHERE n.id = ?
      LIMIT 1
    `
  ).get(noticeId);

  return row ? formatNoticeManageRow(row) : null;
}

function countByProductIds(db, conditions, params) {
  return many(
    db,
    `
      SELECT product_id, COUNT(*) AS count
      FROM notices
      WHERE ${conditions.join(" AND ")}
      GROUP BY product_id
    `,
    ...params
  ).map((row) => ({
    ...row,
    count: Number(row.count ?? 0)
  }));
}

export function countActiveNoticesByProductIds(db, productIds = null, referenceTime = nowIso()) {
  const conditions = [
    "product_id IS NOT NULL",
    "status = 'active'",
    "starts_at <= ?",
    "(ends_at IS NULL OR ends_at > ?)"
  ];
  const params = [referenceTime, referenceTime];
  appendSqliteInCondition("product_id", productIds, conditions, params);
  return countByProductIds(db, conditions, params);
}

export function countBlockingNoticesByProductIds(db, productIds = null, referenceTime = nowIso()) {
  const conditions = [
    "product_id IS NOT NULL",
    "status = 'active'",
    "block_login = 1",
    "starts_at <= ?",
    "(ends_at IS NULL OR ends_at > ?)"
  ];
  const params = [referenceTime, referenceTime];
  appendSqliteInCondition("product_id", productIds, conditions, params);
  return countByProductIds(db, conditions, params);
}
