import { formatProductRow } from "./product-repository.js";

function makePostgresPlaceholders(startIndex, count) {
  return Array.from({ length: Math.max(0, Number(count) || 0) }, (_, index) => `$${startIndex + index}`).join(", ");
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

  conditions.push(`${columnSql} IN (${makePostgresPlaceholders(params.length + 1, normalized.length)})`);
  params.push(...normalized);
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

export function createPostgresProductRepository(adapter) {
  return {
    async queryProductRows(_db, filters = {}) {
      const conditions = [];
      const params = [];

      if (filters.ownerDeveloperId) {
        conditions.push(`p.owner_developer_id = $${params.length + 1}`);
        params.push(filters.ownerDeveloperId);
      }
      if (filters.productId) {
        conditions.push(`p.id = $${params.length + 1}`);
        params.push(filters.productId);
      }
      if (filters.productCode) {
        conditions.push(`p.code = $${params.length + 1}`);
        params.push(filters.productCode);
      }
      appendInCondition("p.id", filters.productIds, conditions, params);

      const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = await Promise.resolve(adapter.query(
        `${productSelectSql(whereClause)} ORDER BY p.created_at DESC`,
        params,
        {
          repository: "products",
          operation: "queryProductRows",
          filters
        }
      ));

      return rows.map((row) => formatProductRow(row));
    }
  };
}
