import { AppError } from "../http.js";

const PRODUCT_FEATURE_KEYS = Object.freeze([
  "allowRegister",
  "allowAccountLogin",
  "allowCardLogin",
  "allowCardRecharge",
  "allowVersionCheck",
  "allowNotices",
  "allowClientUnbind"
]);

const PRODUCT_FEATURE_COLUMN_MAP = Object.freeze({
  allowRegister: "allow_register",
  allowAccountLogin: "allow_account_login",
  allowCardLogin: "allow_card_login",
  allowCardRecharge: "allow_card_recharge",
  allowVersionCheck: "allow_version_check",
  allowNotices: "allow_notices",
  allowClientUnbind: "allow_client_unbind"
});

const DEFAULT_PRODUCT_FEATURE_CONFIG = Object.freeze(
  Object.fromEntries(PRODUCT_FEATURE_KEYS.map((key) => [key, true]))
);
const PRODUCT_CODE_PATTERN = /^[A-Z0-9_]{3,32}$/;
const PRODUCT_STATUS_VALUES = Object.freeze(["active", "disabled", "archived"]);

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

export function parseProductFeatureConfigRow(row, fallbackUpdatedAt = null) {
  const featureConfig = Object.fromEntries(
    PRODUCT_FEATURE_KEYS.map((key) => [
      key,
      row ? Boolean(row[PRODUCT_FEATURE_COLUMN_MAP[key]]) : DEFAULT_PRODUCT_FEATURE_CONFIG[key]
    ])
  );

  return {
    ...featureConfig,
    createdAt: row?.feature_created_at ?? row?.created_at ?? fallbackUpdatedAt ?? null,
    updatedAt: row?.feature_updated_at ?? row?.updated_at ?? fallbackUpdatedAt ?? null
  };
}

export function extractProductFeatureConfigInput(body = {}) {
  if (
    body &&
    typeof body === "object" &&
    body.featureConfig &&
    typeof body.featureConfig === "object" &&
    !Array.isArray(body.featureConfig)
  ) {
    return body.featureConfig;
  }
  return body ?? {};
}

export function parseProductFeatureConfigInput(body = {}, parseOptionalBoolean = (value) => value) {
  const source = extractProductFeatureConfigInput(body);
  return Object.fromEntries(
    PRODUCT_FEATURE_KEYS.map((key) => [key, parseOptionalBoolean(source[key], key)])
  );
}

export function mergeProductFeatureConfig(current = DEFAULT_PRODUCT_FEATURE_CONFIG, overrides = {}) {
  const baseline = current && typeof current === "object"
    ? current
    : DEFAULT_PRODUCT_FEATURE_CONFIG;

  return Object.fromEntries(
    PRODUCT_FEATURE_KEYS.map((key) => [key, overrides[key] ?? baseline[key] ?? DEFAULT_PRODUCT_FEATURE_CONFIG[key]])
  );
}

export function serializeProductFeatureConfigValues(config = DEFAULT_PRODUCT_FEATURE_CONFIG, mapValue = (value) => value) {
  return PRODUCT_FEATURE_KEYS.map((key) => mapValue(config[key] !== false, key));
}

export function formatProductRow(row) {
  const featureConfig = parseProductFeatureConfigRow(row, row.updated_at ?? null);
  return {
    id: row.id,
    code: row.code,
    projectCode: row.code,
    softwareCode: row.code,
    ownerDeveloperId: row.owner_developer_id ?? null,
    name: row.name,
    description: row.description ?? "",
    status: row.status,
    ownerDeveloper: row.owner_developer_id
      ? {
          id: row.owner_developer_id,
          username: row.owner_developer_username ?? null,
          displayName: row.owner_developer_display_name ?? "",
          status: row.owner_developer_status ?? null
        }
      : null,
    sdkAppId: row.sdk_app_id,
    sdkAppSecret: row.sdk_app_secret,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    featureConfig,
    sdk_app_id: row.sdk_app_id,
    sdk_app_secret: row.sdk_app_secret,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function normalizeProductProfileInput(body = {}, current = null) {
  const rawCode = body.code === undefined ? current?.code : body.code;
  const rawName = body.name === undefined ? current?.name : body.name;
  const rawDescription = body.description === undefined
    ? current?.description ?? ""
    : body.description;

  if (rawCode === undefined || rawCode === null || String(rawCode).trim() === "") {
    throw new AppError(400, "FIELD_REQUIRED", "code is required.");
  }
  if (rawName === undefined || rawName === null || String(rawName).trim() === "") {
    throw new AppError(400, "FIELD_REQUIRED", "name is required.");
  }

  const code = String(rawCode).trim().toUpperCase();
  if (!PRODUCT_CODE_PATTERN.test(code)) {
    throw new AppError(400, "INVALID_PRODUCT_CODE", "Product code must be 3-32 chars: A-Z, 0-9 or underscore.");
  }

  return {
    code,
    name: String(rawName).trim(),
    description: String(rawDescription ?? "").trim()
  };
}

export function normalizeProductStatus(value, fieldName = "status") {
  const status = String(value ?? "").trim().toLowerCase();
  if (!PRODUCT_STATUS_VALUES.includes(status)) {
    throw new AppError(
      400,
      "INVALID_PRODUCT_STATUS",
      `${fieldName} must be active, disabled, or archived.`
    );
  }
  return status;
}

function productSelectSql(whereClause = "") {
  return `
    SELECT p.*, pfc.allow_register, pfc.allow_account_login, pfc.allow_card_login, pfc.allow_card_recharge,
           pfc.allow_version_check, pfc.allow_notices, pfc.allow_client_unbind,
           pfc.created_at AS feature_created_at, pfc.updated_at AS feature_updated_at,
           da.id AS owner_developer_id,
           da.username AS owner_developer_username,
           da.display_name AS owner_developer_display_name,
           da.status AS owner_developer_status
    FROM products p
    LEFT JOIN product_feature_configs pfc ON pfc.product_id = p.id
    LEFT JOIN developer_accounts da ON da.id = p.owner_developer_id
    ${whereClause}
  `;
}

export function queryProductRows(db, filters = {}) {
  const conditions = [];
  const params = [];

  if (filters.ownerDeveloperId) {
    conditions.push("p.owner_developer_id = ?");
    params.push(filters.ownerDeveloperId);
  }
  if (filters.productId) {
    conditions.push("p.id = ?");
    params.push(filters.productId);
  }
  if (filters.productCode) {
    conditions.push("p.code = ?");
    params.push(filters.productCode);
  }
  if (filters.sdkAppId) {
    conditions.push("p.sdk_app_id = ?");
    params.push(filters.sdkAppId);
  }
  if (filters.status) {
    conditions.push("p.status = ?");
    params.push(String(filters.status).trim().toLowerCase());
  }
  appendInCondition("p.id", filters.productIds, conditions, params);

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = many(
    db,
    `${productSelectSql(whereClause)} ORDER BY p.created_at DESC`,
    ...params
  );

  return rows.map((row) => formatProductRow(row));
}

export function getProductRowById(db, productId) {
  return queryProductRows(db, { productId })[0] ?? null;
}

export function getProductRecordById(db, productId) {
  return one(db, "SELECT * FROM products WHERE id = ?", productId);
}

export function getProductRecordByCode(db, productCode) {
  return one(db, "SELECT * FROM products WHERE code = ?", productCode);
}

export function getActiveProductRecordByCode(db, productCode) {
  return one(db, "SELECT * FROM products WHERE code = ? AND status = 'active'", productCode);
}

export function getActiveProductRecordBySdkAppId(db, appId) {
  return one(db, "SELECT * FROM products WHERE sdk_app_id = ? AND status = 'active'", appId);
}

export function getActiveProductRowBySdkAppId(db, appId) {
  return queryProductRows(db, { sdkAppId: appId, status: "active" })[0] ?? null;
}

export function productCodeExists(db, productCode) {
  return Boolean(one(db, "SELECT id FROM products WHERE code = ?", productCode));
}

export function listOwnedProductIds(db, ownerDeveloperId) {
  return many(
    db,
    "SELECT id FROM products WHERE owner_developer_id = ? ORDER BY created_at DESC",
    ownerDeveloperId
  ).map((row) => row.id);
}

export function listAssignedDeveloperProductIds(db, memberId, developerId) {
  return many(
    db,
    `
      SELECT p.id
      FROM developer_member_products dmp
      JOIN products p ON p.id = dmp.product_id
      WHERE dmp.member_id = ? AND p.owner_developer_id = ?
      ORDER BY p.created_at DESC
    `,
    memberId,
    developerId
  ).map((row) => row.id);
}

export function findOwnedProductIdByCode(db, ownerDeveloperId, productCode) {
  return one(
    db,
    "SELECT id FROM products WHERE owner_developer_id = ? AND code = ?",
    ownerDeveloperId,
    productCode
  )?.id ?? null;
}

export {
  DEFAULT_PRODUCT_FEATURE_CONFIG,
  PRODUCT_FEATURE_COLUMN_MAP,
  PRODUCT_FEATURE_KEYS,
  PRODUCT_STATUS_VALUES
};
