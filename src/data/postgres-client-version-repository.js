import {
  formatClientVersionRow,
  normalizeChannel,
  normalizeClientVersionStatus,
  normalizeOptionalChannel
} from "./client-version-repository.js";
import { appendPostgresInCondition, likeFilter } from "./query-helpers.js";

export function createPostgresClientVersionRepository(adapter) {
  return {
    async listProductVersions(_db, productId, channel) {
      const normalizedChannel = normalizeChannel(channel);
      const rows = await Promise.resolve(adapter.query(
        `
          SELECT *
          FROM client_versions
          WHERE product_id = $1 AND channel = $2
          ORDER BY released_at DESC, created_at DESC
        `,
        [productId, normalizedChannel],
        {
          repository: "versions",
          operation: "listProductVersions",
          productId,
          channel: normalizedChannel
        }
      ));

      return rows.map((row) => formatClientVersionRow(row));
    },

    async queryClientVersionRows(_db, filters = {}) {
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
        conditions.push(`pr.code = $${params.length + 1}`);
        params.push(normalizedFilters.productCode);
      }

      if (normalizedFilters.ownerDeveloperId) {
        conditions.push(`pr.owner_developer_id = $${params.length + 1}`);
        params.push(normalizedFilters.ownerDeveloperId);
      }

      appendPostgresInCondition("pr.id", filters.productIds, conditions, params);

      if (normalizedFilters.channel) {
        conditions.push(`v.channel = $${params.length + 1}`);
        params.push(normalizedFilters.channel);
      }

      if (normalizedFilters.status) {
        conditions.push(`v.status = $${params.length + 1}`);
        params.push(normalizedFilters.status);
      }

      if (normalizedFilters.search) {
        const pattern = likeFilter(normalizedFilters.search);
        conditions.push(
          `(v.version LIKE $${params.length + 1} ESCAPE '\\' OR COALESCE(v.notice_title, '') LIKE $${params.length + 2} ESCAPE '\\' OR COALESCE(v.release_notes, '') LIKE $${params.length + 3} ESCAPE '\\')`
        );
        params.push(pattern, pattern, pattern);
      }

      const rows = await Promise.resolve(adapter.query(
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
        params,
        {
          repository: "versions",
          operation: "queryClientVersionRows",
          filters: normalizedFilters
        }
      ));

      return {
        items: rows.map((row) => formatClientVersionRow(row)),
        total: rows.length,
        filters: {
          productCode: normalizedFilters.productCode,
          channel: normalizedFilters.channel,
          status: normalizedFilters.status,
          search: normalizedFilters.search
        }
      };
    },

    async countActiveVersionsByProductIds(_db, productIds = null) {
      const conditions = ["status = 'active'"];
      const params = [];
      appendPostgresInCondition("product_id", productIds, conditions, params);

      const rows = await Promise.resolve(adapter.query(
        `
          SELECT product_id, COUNT(*) AS count
          FROM client_versions
          WHERE ${conditions.join(" AND ")}
          GROUP BY product_id
        `,
        params,
        {
          repository: "versions",
          operation: "countActiveVersionsByProductIds",
          productIds: Array.isArray(productIds) ? [...productIds] : null
        }
      ));

      return rows.map((row) => ({
        ...row,
        count: Number(row.count ?? 0)
      }));
    },

    async countForceUpdateVersionsByProductIds(_db, productIds = null) {
      const conditions = ["status = 'active'", "force_update = 1"];
      const params = [];
      appendPostgresInCondition("product_id", productIds, conditions, params);

      const rows = await Promise.resolve(adapter.query(
        `
          SELECT product_id, COUNT(*) AS count
          FROM client_versions
          WHERE ${conditions.join(" AND ")}
          GROUP BY product_id
        `,
        params,
        {
          repository: "versions",
          operation: "countForceUpdateVersionsByProductIds",
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
