import {
  formatNetworkRuleRow,
  normalizeNetworkRuleStatus
} from "./network-rule-repository.js";
import { appendPostgresInCondition, likeFilter } from "./query-helpers.js";

export function createPostgresNetworkRuleRepository(adapter) {
  return {
    async queryNetworkRuleRows(_db, filters = {}) {
      const conditions = [];
      const params = [];
      const normalizedFilters = {
        productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
        actionScope: filters.actionScope ? String(filters.actionScope).trim().toLowerCase() : null,
        status: filters.status ? normalizeNetworkRuleStatus(filters.status) : null,
        search: filters.search ? String(filters.search).trim() : null
      };

      if (normalizedFilters.productCode) {
        conditions.push(`pr.code = $${params.length + 1}`);
        params.push(normalizedFilters.productCode);
      }

      appendPostgresInCondition("pr.id", filters.productIds, conditions, params);

      if (normalizedFilters.actionScope) {
        conditions.push(`nr.action_scope = $${params.length + 1}`);
        params.push(normalizedFilters.actionScope);
      }

      if (normalizedFilters.status) {
        conditions.push(`nr.status = $${params.length + 1}`);
        params.push(normalizedFilters.status);
      }

      if (normalizedFilters.search) {
        const pattern = likeFilter(normalizedFilters.search);
        conditions.push(
          `(nr.pattern LIKE $${params.length + 1} ESCAPE '\\' OR COALESCE(nr.notes, '') LIKE $${params.length + 2} ESCAPE '\\' OR COALESCE(pr.code, '') LIKE $${params.length + 3} ESCAPE '\\')`
        );
        params.push(pattern, pattern, pattern);
      }

      const rows = await Promise.resolve(adapter.query(
        `
          SELECT nr.*, pr.code AS product_code, pr.name AS product_name
          FROM network_rules nr
          LEFT JOIN products pr ON pr.id = nr.product_id
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY nr.created_at DESC
          LIMIT 100
        `,
        params,
        {
          repository: "networkRules",
          operation: "queryNetworkRuleRows",
          filters: normalizedFilters
        }
      ));

      return {
        items: rows.map((row) => formatNetworkRuleRow(row)),
        total: rows.length,
        filters: normalizedFilters
      };
    },

    async listBlockingNetworkRulesForProduct(_db, productId, actionScope) {
      const rows = await Promise.resolve(adapter.query(
        `
          SELECT nr.*, pr.code AS product_code
          FROM network_rules nr
          LEFT JOIN products pr ON pr.id = nr.product_id
          WHERE nr.status = 'active'
            AND nr.decision = 'block'
            AND (nr.product_id IS NULL OR nr.product_id = $1)
            AND (nr.action_scope = 'all' OR nr.action_scope = $2)
          ORDER BY CASE WHEN nr.product_id IS NULL THEN 1 ELSE 0 END, nr.created_at DESC
        `,
        [productId, actionScope],
        {
          repository: "networkRules",
          operation: "listBlockingNetworkRulesForProduct",
          productId,
          actionScope
        }
      ));

      return rows;
    },

    async countActiveNetworkRulesByProductIds(_db, productIds = null) {
      const conditions = ["product_id IS NOT NULL", "status = 'active'"];
      const params = [];
      appendPostgresInCondition("product_id", productIds, conditions, params);

      const rows = await Promise.resolve(adapter.query(
        `
          SELECT product_id, COUNT(*) AS count
          FROM network_rules
          WHERE ${conditions.join(" AND ")}
          GROUP BY product_id
        `,
        params,
        {
          repository: "networkRules",
          operation: "countActiveNetworkRulesByProductIds",
          productIds: Array.isArray(productIds) ? [...productIds] : null
        }
      ));

      return rows.map((row) => ({
        ...row,
        count: Number(row.count ?? 0)
      }));
    }
  };
}
