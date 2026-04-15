import { AppError } from "../http.js";
import { appendSqliteInCondition, likeFilter } from "./query-helpers.js";

function many(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

export function normalizeChannel(value, fallback = "stable") {
  return String(value ?? fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "") || fallback;
}

export function normalizeOptionalChannel(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  return normalizeChannel(value);
}

export function normalizeClientVersionStatus(value, fieldName = "status") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!["active", "disabled"].includes(normalized)) {
    const message = fieldName === "status"
      ? "Version status must be active or disabled."
      : `${fieldName} must be active or disabled.`;
    throw new AppError(400, "INVALID_CLIENT_VERSION_STATUS", message);
  }
  return normalized;
}

export function parseVersionParts(version) {
  return String(version)
    .trim()
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()));
}

export function compareVersions(left, right) {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];

    if (leftPart === undefined && rightPart === undefined) {
      return 0;
    }

    if (leftPart === undefined) {
      return typeof rightPart === "number" ? (rightPart === 0 ? 0 : -1) : -1;
    }

    if (rightPart === undefined) {
      return typeof leftPart === "number" ? (leftPart === 0 ? 0 : 1) : 1;
    }

    if (typeof leftPart === "number" && typeof rightPart === "number") {
      if (leftPart !== rightPart) {
        return leftPart < rightPart ? -1 : 1;
      }
      continue;
    }

    const compared = String(leftPart).localeCompare(String(rightPart));
    if (compared !== 0) {
      return compared < 0 ? -1 : 1;
    }
  }

  return 0;
}

export function selectHighestVersion(rows) {
  if (!rows.length) {
    return null;
  }

  return rows.reduce((best, row) =>
    !best || compareVersions(best.version, row.version) < 0 ? row : best
  , null);
}

export function formatClientVersionRow(row) {
  return {
    ...row,
    force_update: Boolean(row.force_update),
    forceUpdate: Boolean(row.force_update)
  };
}

export function formatClientVersionManageRow(row) {
  return {
    id: row.id,
    productId: row.product_id,
    productCode: row.product_code ?? null,
    productName: row.product_name ?? null,
    ownerDeveloperId: row.owner_developer_id ?? null,
    channel: row.channel,
    version: row.version,
    status: row.status,
    forceUpdate: Boolean(row.force_update),
    downloadUrl: row.download_url ?? null,
    releaseNotes: row.release_notes ?? null,
    noticeTitle: row.notice_title ?? null,
    noticeBody: row.notice_body ?? null,
    releasedAt: row.released_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function listProductVersions(db, productId, channel) {
  return many(
    db,
    `
      SELECT *
      FROM client_versions
      WHERE product_id = ? AND channel = ?
      ORDER BY released_at DESC, created_at DESC
    `,
    productId,
    normalizeChannel(channel)
  ).map((row) => formatClientVersionRow(row));
}

export function queryClientVersionRows(db, filters = {}) {
  const conditions = [];
  const params = [];
  const normalizedFilters = {
    productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
    channel: normalizeOptionalChannel(filters.channel),
    status: filters.status ? normalizeClientVersionStatus(filters.status) : null,
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

  appendSqliteInCondition("pr.id", filters.productIds, conditions, params);

  if (normalizedFilters.channel) {
    conditions.push("v.channel = ?");
    params.push(normalizedFilters.channel);
  }

  if (normalizedFilters.status) {
    conditions.push("v.status = ?");
    params.push(normalizedFilters.status);
  }

  if (normalizedFilters.search) {
    const pattern = likeFilter(normalizedFilters.search);
    conditions.push(
      "(v.version LIKE ? ESCAPE '\\' OR COALESCE(v.notice_title, '') LIKE ? ESCAPE '\\' OR COALESCE(v.release_notes, '') LIKE ? ESCAPE '\\')"
    );
    params.push(pattern, pattern, pattern);
  }

  const items = many(
    db,
    `
      SELECT v.id, v.channel, v.version, v.status, v.force_update, v.download_url, v.release_notes,
             v.notice_title, v.notice_body, v.released_at, v.created_at, v.updated_at,
             pr.code AS product_code, pr.name AS product_name
      FROM client_versions v
      JOIN products pr ON pr.id = v.product_id
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY pr.code ASC, v.channel ASC, v.released_at DESC, v.created_at DESC
      LIMIT 100
    `,
    ...params
  );

  return {
    items: items.map((row) => formatClientVersionRow(row)),
    total: items.length,
    filters: {
      productCode: normalizedFilters.productCode,
      channel: normalizedFilters.channel,
      status: normalizedFilters.status,
      search: normalizedFilters.search
    }
  };
}

export function getClientVersionRowById(db, versionId) {
  const row = db.prepare(
    `
      SELECT v.*, pr.code AS product_code, pr.name AS product_name, pr.owner_developer_id
      FROM client_versions v
      JOIN products pr ON pr.id = v.product_id
      WHERE v.id = ?
      LIMIT 1
    `
  ).get(versionId);

  return row ? formatClientVersionManageRow(row) : null;
}

function countByProductIds(db, conditions, params) {
  return many(
    db,
    `
      SELECT product_id, COUNT(*) AS count
      FROM client_versions
      WHERE ${conditions.join(" AND ")}
      GROUP BY product_id
    `,
    ...params
  ).map((row) => ({
    ...row,
    count: Number(row.count ?? 0)
  }));
}

export function countActiveVersionsByProductIds(db, productIds = null) {
  const conditions = ["status = 'active'"];
  const params = [];
  appendSqliteInCondition("product_id", productIds, conditions, params);
  return countByProductIds(db, conditions, params);
}

export function countForceUpdateVersionsByProductIds(db, productIds = null) {
  const conditions = ["status = 'active'", "force_update = 1"];
  const params = [];
  appendSqliteInCondition("product_id", productIds, conditions, params);
  return countByProductIds(db, conditions, params);
}
