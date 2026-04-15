import {
  appendPostgresInCondition,
  formatBindingQueryRow,
  formatBindingRow,
  formatDeviceBlockQueryRow,
  likeFilter,
  normalizeDeviceBindingFilters,
  normalizeDeviceBlockFilters
} from "./device-repository.js";

export function createPostgresDeviceRepository(adapter) {
  return {
    async getActiveDeviceBlock(_db, productId, fingerprint) {
      const rows = await Promise.resolve(adapter.query(
        `
          SELECT *
          FROM device_blocks
          WHERE product_id = $1 AND fingerprint = $2 AND status = 'active'
          LIMIT 1
        `,
        [productId, fingerprint],
        {
          repository: "devices",
          operation: "getActiveDeviceBlock",
          productId,
          fingerprint
        }
      ));

      return rows[0] ?? null;
    },

    async getDeviceRecordByFingerprint(_db, productId, fingerprint) {
      const rows = await Promise.resolve(adapter.query(
        `
          SELECT *
          FROM devices
          WHERE product_id = $1 AND fingerprint = $2
          LIMIT 1
        `,
        [productId, fingerprint],
        {
          repository: "devices",
          operation: "getDeviceRecordByFingerprint",
          productId,
          fingerprint
        }
      ));

      return rows[0] ?? null;
    },

    async getDeviceBlockManageRowById(_db, blockId) {
      const rows = await Promise.resolve(adapter.query(
        `
          SELECT b.*, pr.code AS product_code, pr.owner_developer_id,
                 d.id AS device_id, d.device_name, d.last_seen_at, d.last_seen_ip
          FROM device_blocks b
          JOIN products pr ON pr.id = b.product_id
          LEFT JOIN devices d ON d.product_id = b.product_id AND d.fingerprint = b.fingerprint
          WHERE b.id = $1
          LIMIT 1
        `,
        [blockId],
        {
          repository: "devices",
          operation: "getDeviceBlockManageRowById",
          blockId
        }
      ));

      return rows[0] ?? null;
    },

    async queryBindingsForEntitlement(_db, entitlementId) {
      const rows = await Promise.resolve(adapter.query(
        `
          SELECT b.id, b.entitlement_id, b.device_id, b.status, b.first_bound_at, b.last_bound_at, b.revoked_at,
                 d.fingerprint, d.device_name, d.last_seen_at, d.last_seen_ip,
                 bp.match_fields_json, bp.identity_json, bp.request_ip,
                 COALESCE(sess.active_session_count, 0) AS active_session_count
          FROM device_bindings b
          JOIN devices d ON d.id = b.device_id
          LEFT JOIN device_binding_profiles bp ON bp.binding_id = b.id
          LEFT JOIN (
            SELECT entitlement_id, device_id, COUNT(*) AS active_session_count
            FROM sessions
            WHERE status = 'active'
            GROUP BY entitlement_id, device_id
          ) sess ON sess.entitlement_id = b.entitlement_id AND sess.device_id = b.device_id
          WHERE b.entitlement_id = $1
          ORDER BY CASE WHEN b.status = 'active' THEN 0 ELSE 1 END, b.last_bound_at DESC
        `,
        [entitlementId],
        {
          repository: "devices",
          operation: "queryBindingsForEntitlement",
          entitlementId
        }
      ));

      return rows.map(formatBindingRow);
    },

    async getBindingManageRowById(_db, bindingId) {
      const rows = await Promise.resolve(adapter.query(
        `
          SELECT b.id, b.entitlement_id, b.device_id, b.status,
                 pr.id AS product_id, pr.code AS product_code, pr.owner_developer_id,
                 a.id AS account_id, a.username,
                 d.fingerprint, d.device_name
          FROM device_bindings b
          JOIN entitlements e ON e.id = b.entitlement_id
          JOIN customer_accounts a ON a.id = e.account_id
          JOIN products pr ON pr.id = e.product_id
          JOIN devices d ON d.id = b.device_id
          WHERE b.id = $1
          LIMIT 1
        `,
        [bindingId],
        {
          repository: "devices",
          operation: "getBindingManageRowById",
          bindingId
        }
      ));

      return rows[0] ?? null;
    },

    async queryDeviceBindingRows(_db, filters = {}) {
      const conditions = [];
      const params = [];
      const normalizedFilters = normalizeDeviceBindingFilters(filters);

      if (normalizedFilters.productCode) {
        conditions.push(`pr.code = $${params.length + 1}`);
        params.push(normalizedFilters.productCode);
      }

      appendPostgresInCondition("pr.id", filters.productIds, conditions, params);

      if (normalizedFilters.username) {
        conditions.push(`a.username = $${params.length + 1}`);
        params.push(normalizedFilters.username);
      }

      if (normalizedFilters.status) {
        conditions.push(`b.status = $${params.length + 1}`);
        params.push(normalizedFilters.status);
      }

      if (normalizedFilters.search) {
        const pattern = likeFilter(normalizedFilters.search);
        conditions.push(
          `(d.fingerprint LIKE $${params.length + 1} ESCAPE '\\' OR d.device_name LIKE $${params.length + 2} ESCAPE '\\' OR a.username LIKE $${params.length + 3} ESCAPE '\\')`
        );
        params.push(pattern, pattern, pattern);
      }

      const rows = await Promise.resolve(adapter.query(
        `
          SELECT b.id, b.entitlement_id, b.device_id, b.status, b.first_bound_at, b.last_bound_at, b.revoked_at,
                 pr.id AS product_id, pr.code AS product_code, pr.name AS product_name,
                 a.id AS account_id, a.username,
                 pol.name AS policy_name,
                 e.ends_at AS entitlement_ends_at,
                 d.fingerprint, d.device_name, d.last_seen_at, d.last_seen_ip,
                 bp.identity_hash, bp.match_fields_json, bp.identity_json, bp.request_ip AS bind_request_ip,
                 COALESCE(sess.active_session_count, 0) AS active_session_count
          FROM device_bindings b
          JOIN entitlements e ON e.id = b.entitlement_id
          JOIN customer_accounts a ON a.id = e.account_id
          JOIN products pr ON pr.id = e.product_id
          JOIN policies pol ON pol.id = e.policy_id
          JOIN devices d ON d.id = b.device_id
          LEFT JOIN device_binding_profiles bp ON bp.binding_id = b.id
          LEFT JOIN (
            SELECT entitlement_id, device_id, COUNT(*) AS active_session_count
            FROM sessions
            WHERE status = 'active'
            GROUP BY entitlement_id, device_id
          ) sess ON sess.entitlement_id = b.entitlement_id AND sess.device_id = b.device_id
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY b.last_bound_at DESC
          LIMIT 100
        `,
        params,
        {
          repository: "devices",
          operation: "queryDeviceBindingRows",
          filters: normalizedFilters
        }
      ));

      return {
        items: rows.map((row) => formatBindingQueryRow(row)),
        total: rows.length,
        filters: normalizedFilters
      };
    },

    async queryDeviceBlockRows(_db, filters = {}) {
      const conditions = [];
      const params = [];
      const normalizedFilters = normalizeDeviceBlockFilters(filters);

      if (normalizedFilters.productCode) {
        conditions.push(`pr.code = $${params.length + 1}`);
        params.push(normalizedFilters.productCode);
      }

      appendPostgresInCondition("pr.id", filters.productIds, conditions, params);

      if (normalizedFilters.status) {
        conditions.push(`b.status = $${params.length + 1}`);
        params.push(normalizedFilters.status);
      }

      if (normalizedFilters.search) {
        const pattern = likeFilter(normalizedFilters.search);
        conditions.push(
          `(b.fingerprint LIKE $${params.length + 1} ESCAPE '\\' OR b.reason LIKE $${params.length + 2} ESCAPE '\\' OR COALESCE(b.notes, '') LIKE $${params.length + 3} ESCAPE '\\')`
        );
        params.push(pattern, pattern, pattern);
      }

      const rows = await Promise.resolve(adapter.query(
        `
          SELECT b.id, b.product_id, b.fingerprint, b.status, b.reason, b.notes, b.created_at, b.updated_at, b.released_at,
                 pr.code AS product_code, pr.name AS product_name,
                 d.id AS device_id, d.device_name, d.last_seen_at, d.last_seen_ip,
                 COALESCE(sess.active_session_count, 0) AS active_session_count
          FROM device_blocks b
          JOIN products pr ON pr.id = b.product_id
          LEFT JOIN devices d ON d.product_id = b.product_id AND d.fingerprint = b.fingerprint
          LEFT JOIN (
            SELECT device_id, COUNT(*) AS active_session_count
            FROM sessions
            WHERE status = 'active'
            GROUP BY device_id
          ) sess ON sess.device_id = d.id
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY CASE WHEN b.status = 'active' THEN 0 ELSE 1 END, b.updated_at DESC
          LIMIT 100
        `,
        params,
        {
          repository: "devices",
          operation: "queryDeviceBlockRows",
          filters: normalizedFilters
        }
      ));

      return {
        items: rows.map((row) => formatDeviceBlockQueryRow(row)),
        total: rows.length,
        filters: normalizedFilters
      };
    },

    async countActiveBindingsByProductIds(_db, productIds = null) {
      const conditions = ["b.status = 'active'"];
      const params = [];

      appendPostgresInCondition("e.product_id", productIds, conditions, params);

      const rows = await Promise.resolve(adapter.query(
        `
          SELECT e.product_id, COUNT(*) AS count
          FROM device_bindings b
          JOIN entitlements e ON e.id = b.entitlement_id
          WHERE ${conditions.join(" AND ")}
          GROUP BY e.product_id
        `,
        params,
        {
          repository: "devices",
          operation: "countActiveBindingsByProductIds",
          productIds: Array.isArray(productIds) ? [...productIds] : null
        }
      ));

      return rows.map((row) => ({
        ...row,
        count: Number(row.count ?? 0)
      }));
    },

    async countActiveBlocksByProductIds(_db, productIds = null) {
      const conditions = ["status = 'active'"];
      const params = [];

      appendPostgresInCondition("product_id", productIds, conditions, params);

      const rows = await Promise.resolve(adapter.query(
        `
          SELECT product_id, COUNT(*) AS count
          FROM device_blocks
          WHERE ${conditions.join(" AND ")}
          GROUP BY product_id
        `,
        params,
        {
          repository: "devices",
          operation: "countActiveBlocksByProductIds",
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
