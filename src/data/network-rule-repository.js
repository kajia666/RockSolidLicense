import { AppError } from "../http.js";
import { appendSqliteInCondition, likeFilter } from "./query-helpers.js";

function many(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

export function normalizeNetworkRuleStatus(value, fieldName = "status") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!["active", "archived"].includes(normalized)) {
    const message = fieldName === "status"
      ? "Rule status must be active or archived."
      : `${fieldName} must be active or archived.`;
    throw new AppError(400, "INVALID_NETWORK_RULE_STATUS", message);
  }
  return normalized;
}

export function formatNetworkRuleRow(row) {
  return {
    id: row.id,
    productCode: row.product_code ?? null,
    productName: row.product_name ?? null,
    targetType: row.target_type,
    pattern: row.pattern,
    actionScope: row.action_scope,
    decision: row.decision,
    status: row.status,
    notes: row.notes ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function formatNetworkRuleManageRow(row) {
  return {
    ...formatNetworkRuleRow(row),
    productId: row.product_id ?? null,
    ownerDeveloperId: row.owner_developer_id ?? null
  };
}

export function queryNetworkRuleRows(db, filters = {}) {
  const conditions = [];
  const params = [];
  const normalizedFilters = {
    productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
    actionScope: filters.actionScope ? String(filters.actionScope).trim().toLowerCase() : null,
    status: filters.status ? normalizeNetworkRuleStatus(filters.status) : null,
    search: filters.search ? String(filters.search).trim() : null
  };

  if (normalizedFilters.productCode) {
    conditions.push("pr.code = ?");
    params.push(normalizedFilters.productCode);
  }

  appendSqliteInCondition("pr.id", filters.productIds, conditions, params);

  if (normalizedFilters.actionScope) {
    conditions.push("nr.action_scope = ?");
    params.push(normalizedFilters.actionScope);
  }

  if (normalizedFilters.status) {
    conditions.push("nr.status = ?");
    params.push(normalizedFilters.status);
  }

  if (normalizedFilters.search) {
    const pattern = likeFilter(normalizedFilters.search);
    conditions.push(
      "(nr.pattern LIKE ? ESCAPE '\\' OR COALESCE(nr.notes, '') LIKE ? ESCAPE '\\' OR COALESCE(pr.code, '') LIKE ? ESCAPE '\\')"
    );
    params.push(pattern, pattern, pattern);
  }

  const items = many(
    db,
    `
      SELECT nr.*, pr.code AS product_code, pr.name AS product_name
      FROM network_rules nr
      LEFT JOIN products pr ON pr.id = nr.product_id
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY nr.created_at DESC
      LIMIT 100
    `,
    ...params
  );

  return {
    items: items.map((row) => formatNetworkRuleRow(row)),
    total: items.length,
    filters: normalizedFilters
  };
}

export function getNetworkRuleRowById(db, ruleId) {
  const row = db.prepare(
    `
      SELECT nr.*, pr.code AS product_code, pr.name AS product_name, pr.owner_developer_id
      FROM network_rules nr
      LEFT JOIN products pr ON pr.id = nr.product_id
      WHERE nr.id = ?
      LIMIT 1
    `
  ).get(ruleId);

  return row ? formatNetworkRuleManageRow(row) : null;
}

export function listBlockingNetworkRulesForProduct(db, productId, actionScope) {
  return many(
    db,
    `
      SELECT nr.*, pr.code AS product_code
      FROM network_rules nr
      LEFT JOIN products pr ON pr.id = nr.product_id
      WHERE nr.status = 'active'
        AND nr.decision = 'block'
        AND (nr.product_id IS NULL OR nr.product_id = ?)
        AND (nr.action_scope = 'all' OR nr.action_scope = ?)
      ORDER BY CASE WHEN nr.product_id IS NULL THEN 1 ELSE 0 END, nr.created_at DESC
    `,
    productId,
    actionScope
  );
}

export function countActiveNetworkRulesByProductIds(db, productIds = null) {
  const conditions = ["product_id IS NOT NULL", "status = 'active'"];
  const params = [];
  appendSqliteInCondition("product_id", productIds, conditions, params);

  return many(
    db,
    `
      SELECT product_id, COUNT(*) AS count
      FROM network_rules
      WHERE ${conditions.join(" AND ")}
      GROUP BY product_id
    `,
    ...params
  ).map((row) => ({
    ...row,
    count: Number(row.count ?? 0)
  }));
}
