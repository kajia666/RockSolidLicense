import {
  formatNotice,
  formatNoticeManageRow,
  normalizeNoticeChannel,
  normalizeNoticeKind,
  normalizeNoticeStatus
} from "./notice-repository.js";
import { normalizeOptionalChannel } from "./client-version-repository.js";
import { appendPostgresInCondition, likeFilter } from "./query-helpers.js";

export function createPostgresNoticeRepository(adapter) {
  return {
    async listActiveNoticesForProduct(_db, productId, channel = "all", referenceTime) {
      const resolvedTime = referenceTime ?? new Date().toISOString();
      const normalizedChannel = normalizeNoticeChannel(channel, "stable");
      const rows = await Promise.resolve(adapter.query(
        `
          SELECT n.*, pr.code AS product_code, pr.name AS product_name
          FROM notices n
          LEFT JOIN products pr ON pr.id = n.product_id
          WHERE n.status = 'active'
            AND n.starts_at <= $1
            AND (n.ends_at IS NULL OR n.ends_at > $2)
            AND (n.product_id IS NULL OR n.product_id = $3)
            AND (n.channel = 'all' OR n.channel = $4)
          ORDER BY n.block_login DESC, n.starts_at DESC, n.created_at DESC
        `,
        [resolvedTime, resolvedTime, productId, normalizedChannel],
        {
          repository: "notices",
          operation: "listActiveNoticesForProduct",
          productId,
          channel: normalizedChannel,
          referenceTime: resolvedTime
        }
      ));

      return rows.map((row) => formatNotice(row));
    },

    async queryNoticeRows(_db, filters = {}) {
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
        conditions.push(`pr.code = $${params.length + 1}`);
        params.push(normalizedFilters.productCode);
      }

      if (normalizedFilters.ownerDeveloperId) {
        conditions.push(`pr.owner_developer_id = $${params.length + 1}`);
        params.push(normalizedFilters.ownerDeveloperId);
      }

      appendPostgresInCondition("n.product_id", filters.productIds, conditions, params);

      if (filters.channel !== undefined && filters.channel !== null && String(filters.channel).trim() !== "") {
        conditions.push(`n.channel = $${params.length + 1}`);
        params.push(normalizedFilters.channel);
      }

      if (normalizedFilters.kind) {
        conditions.push(`n.kind = $${params.length + 1}`);
        params.push(normalizedFilters.kind);
      }

      if (normalizedFilters.status) {
        conditions.push(`n.status = $${params.length + 1}`);
        params.push(normalizedFilters.status);
      }

      if (normalizedFilters.search) {
        const pattern = likeFilter(normalizedFilters.search);
        conditions.push(
          `(n.title LIKE $${params.length + 1} ESCAPE '\\' OR n.body LIKE $${params.length + 2} ESCAPE '\\' OR COALESCE(pr.code, '') LIKE $${params.length + 3} ESCAPE '\\')`
        );
        params.push(pattern, pattern, pattern);
      }

      const rows = await Promise.resolve(adapter.query(
        `
          SELECT n.*, pr.code AS product_code, pr.name AS product_name
          FROM notices n
          LEFT JOIN products pr ON pr.id = n.product_id
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY n.starts_at DESC, n.created_at DESC
          LIMIT 100
        `,
        params,
        {
          repository: "notices",
          operation: "queryNoticeRows",
          filters: normalizedFilters
        }
      ));

      return {
        items: rows.map((row) => formatNotice(row)),
        total: rows.length,
        filters: {
          productCode: normalizedFilters.productCode,
          channel: normalizedFilters.channel,
          kind: normalizedFilters.kind,
          status: normalizedFilters.status,
          search: normalizedFilters.search
        }
      };
    },

    async countActiveNoticesByProductIds(_db, productIds = null, referenceTime) {
      const resolvedTime = referenceTime ?? new Date().toISOString();
      const conditions = [
        "product_id IS NOT NULL",
        "status = 'active'",
        "starts_at <= $1",
        "(ends_at IS NULL OR ends_at > $2)"
      ];
      const params = [resolvedTime, resolvedTime];
      appendPostgresInCondition("product_id", productIds, conditions, params);

      const rows = await Promise.resolve(adapter.query(
        `
          SELECT product_id, COUNT(*) AS count
          FROM notices
          WHERE ${conditions.join(" AND ")}
          GROUP BY product_id
        `,
        params,
        {
          repository: "notices",
          operation: "countActiveNoticesByProductIds",
          productIds: Array.isArray(productIds) ? [...productIds] : null,
          referenceTime: resolvedTime
        }
      ));

      return rows.map((row) => ({
        ...row,
        count: Number(row.count ?? 0)
      }));
    },

    async countBlockingNoticesByProductIds(_db, productIds = null, referenceTime) {
      const resolvedTime = referenceTime ?? new Date().toISOString();
      const conditions = [
        "product_id IS NOT NULL",
        "status = 'active'",
        "block_login = 1",
        "starts_at <= $1",
        "(ends_at IS NULL OR ends_at > $2)"
      ];
      const params = [resolvedTime, resolvedTime];
      appendPostgresInCondition("product_id", productIds, conditions, params);

      const rows = await Promise.resolve(adapter.query(
        `
          SELECT product_id, COUNT(*) AS count
          FROM notices
          WHERE ${conditions.join(" AND ")}
          GROUP BY product_id
        `,
        params,
        {
          repository: "notices",
          operation: "countBlockingNoticesByProductIds",
          productIds: Array.isArray(productIds) ? [...productIds] : null,
          referenceTime: resolvedTime
        }
      ));

      return rows.map((row) => ({
        ...row,
        count: Number(row.count ?? 0)
      }));
    },

    async getNoticeRowById(_db, noticeId) {
      const rows = await Promise.resolve(adapter.query(
        `
          SELECT n.*, pr.code AS product_code, pr.name AS product_name, pr.owner_developer_id
          FROM notices n
          LEFT JOIN products pr ON pr.id = n.product_id
          WHERE n.id = $1
          LIMIT 1
        `,
        [noticeId],
        {
          repository: "notices",
          operation: "getNoticeRowById",
          noticeId
        }
      ));

      return rows[0] ? formatNoticeManageRow(rows[0]) : null;
    }
  };
}
