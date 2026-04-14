import { formatPolicyRow } from "./policy-repository.js";

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

export function createPostgresPolicyRepository(adapter) {
  return {
    async queryPolicyRows(_db, filters = {}) {
      const conditions = [];
      const params = [];

      if (filters.policyId) {
        conditions.push(`p.id = $${params.length + 1}`);
        params.push(String(filters.policyId).trim());
      }
      if (filters.productCode) {
        conditions.push(`pr.code = $${params.length + 1}`);
        params.push(String(filters.productCode).trim().toUpperCase());
      }
      if (filters.ownerDeveloperId) {
        conditions.push(`pr.owner_developer_id = $${params.length + 1}`);
        params.push(filters.ownerDeveloperId);
      }
      appendInCondition("pr.id", filters.productIds, conditions, params);

      const rows = await Promise.resolve(adapter.query(
        `
          SELECT p.*, pr.code AS product_code, pr.name AS product_name, pr.owner_developer_id,
                 pbc.bind_fields_json,
                 puc.allow_client_unbind, puc.client_unbind_limit, puc.client_unbind_window_days,
                 puc.client_unbind_deduct_days,
                 pgc.grant_type, pgc.grant_points
          FROM policies p
          JOIN products pr ON pr.id = p.product_id
          LEFT JOIN policy_bind_configs pbc ON pbc.policy_id = p.id
          LEFT JOIN policy_unbind_configs puc ON puc.policy_id = p.id
          LEFT JOIN policy_grant_configs pgc ON pgc.policy_id = p.id
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY p.created_at DESC
        `,
        params,
        {
          repository: "policies",
          operation: "queryPolicyRows",
          filters
        }
      ));

      return rows.map(formatPolicyRow);
    }
  };
}
