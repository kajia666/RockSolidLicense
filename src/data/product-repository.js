const DEFAULT_PRODUCT_FEATURE_CONFIG = Object.freeze({
  allowRegister: true,
  allowAccountLogin: true,
  allowCardLogin: true,
  allowCardRecharge: true,
  allowVersionCheck: true,
  allowNotices: true,
  allowClientUnbind: true
});

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
  return {
    allowRegister: row ? Boolean(row.allow_register) : DEFAULT_PRODUCT_FEATURE_CONFIG.allowRegister,
    allowAccountLogin: row ? Boolean(row.allow_account_login) : DEFAULT_PRODUCT_FEATURE_CONFIG.allowAccountLogin,
    allowCardLogin: row ? Boolean(row.allow_card_login) : DEFAULT_PRODUCT_FEATURE_CONFIG.allowCardLogin,
    allowCardRecharge: row ? Boolean(row.allow_card_recharge) : DEFAULT_PRODUCT_FEATURE_CONFIG.allowCardRecharge,
    allowVersionCheck: row ? Boolean(row.allow_version_check) : DEFAULT_PRODUCT_FEATURE_CONFIG.allowVersionCheck,
    allowNotices: row ? Boolean(row.allow_notices) : DEFAULT_PRODUCT_FEATURE_CONFIG.allowNotices,
    allowClientUnbind: row ? Boolean(row.allow_client_unbind) : DEFAULT_PRODUCT_FEATURE_CONFIG.allowClientUnbind,
    createdAt: row?.feature_created_at ?? row?.created_at ?? fallbackUpdatedAt ?? null,
    updatedAt: row?.feature_updated_at ?? row?.updated_at ?? fallbackUpdatedAt ?? null
  };
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

export { DEFAULT_PRODUCT_FEATURE_CONFIG };
