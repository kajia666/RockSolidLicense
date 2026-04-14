import { normalizeSessionStatus } from "./session-repository.js";

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

function normalizeSessionFilters(filters = {}) {
  return {
    productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
    username: filters.username ? String(filters.username).trim() : null,
    status: filters.status ? normalizeSessionStatus(filters.status) : null,
    search: filters.search ? String(filters.search).trim() : null
  };
}

function escapeLikeText(value) {
  return String(value ?? "").replace(/[\\%_]/g, "\\$&");
}

function likeFilter(value) {
  return `%${escapeLikeText(value)}%`;
}

function normalizeSessionQueryOptions(filters = {}) {
  const rawLimit = Number(filters.limit ?? 100);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200)
    : 100;
  const sortByInput = String(filters.sortBy ?? "lastHeartbeatDesc").trim();
  const sortBy = sortByInput === "issuedAtDesc" ? "issuedAtDesc" : "lastHeartbeatDesc";

  return { limit, sortBy };
}

function sessionOrderBy(sortBy) {
  if (sortBy === "issuedAtDesc") {
    return "s.issued_at DESC";
  }

  return "s.last_heartbeat_at DESC";
}

export function createPostgresSessionRepository(adapter) {
  return {
    async getSessionRecordById(_db, sessionId) {
      const rows = await Promise.resolve(adapter.query(
        `
          SELECT *
          FROM sessions
          WHERE id = $1
          LIMIT 1
        `,
        [sessionId],
        {
          repository: "sessions",
          operation: "getSessionRecordById",
          sessionId
        }
      ));

      return rows[0] ?? null;
    },

    async getSessionRecordByProductToken(_db, productId, sessionToken) {
      const rows = await Promise.resolve(adapter.query(
        `
          SELECT *
          FROM sessions
          WHERE product_id = $1 AND session_token = $2
          LIMIT 1
        `,
        [productId, sessionToken],
        {
          repository: "sessions",
          operation: "getSessionRecordByProductToken",
          productId,
          sessionToken
        }
      ));

      return rows[0] ?? null;
    },

    async getSessionRecordByToken(_db, sessionToken) {
      const rows = await Promise.resolve(adapter.query(
        `
          SELECT *
          FROM sessions
          WHERE session_token = $1
          LIMIT 1
        `,
        [sessionToken],
        {
          repository: "sessions",
          operation: "getSessionRecordByToken",
          sessionToken
        }
      ));

      return rows[0] ?? null;
    },

    async getActiveSessionHeartbeatRow(_db, productId, sessionToken) {
      const rows = await Promise.resolve(adapter.query(
        `
          SELECT s.*, d.fingerprint, a.username, e.status AS entitlement_status,
                 pol.heartbeat_interval_seconds, pol.heartbeat_timeout_seconds, pol.token_ttl_seconds,
                 lkc.status AS card_control_status, lkc.expires_at AS card_expires_at
          FROM sessions s
          JOIN devices d ON d.id = s.device_id
          JOIN customer_accounts a ON a.id = s.account_id
          JOIN entitlements e ON e.id = s.entitlement_id
          JOIN policies pol ON pol.id = e.policy_id
          JOIN license_keys lk ON lk.id = e.source_license_key_id
          LEFT JOIN license_key_controls lkc ON lkc.license_key_id = lk.id
          WHERE s.product_id = $1 AND s.session_token = $2 AND s.status = 'active'
          LIMIT 1
        `,
        [productId, sessionToken],
        {
          repository: "sessions",
          operation: "getActiveSessionHeartbeatRow",
          productId,
          sessionToken
        }
      ));

      return rows[0] ?? null;
    },

    async getSessionManageRowById(_db, sessionId) {
      const rows = await Promise.resolve(adapter.query(
        `
          SELECT s.id, s.status, s.revoked_reason, s.product_id, s.account_id,
                 pr.code AS product_code, pr.owner_developer_id,
                 a.username,
                 d.fingerprint
          FROM sessions s
          JOIN customer_accounts a ON a.id = s.account_id
          JOIN devices d ON d.id = s.device_id
          JOIN products pr ON pr.id = s.product_id
          WHERE s.id = $1
          LIMIT 1
        `,
        [sessionId],
        {
          repository: "sessions",
          operation: "getSessionManageRowById",
          sessionId
        }
      ));

      return rows[0] ?? null;
    },

    async querySessionRows(_db, filters = {}) {
      const conditions = [];
      const params = [];
      const normalizedFilters = normalizeSessionFilters(filters);
      const queryOptions = normalizeSessionQueryOptions(filters);

      if (normalizedFilters.productCode) {
        conditions.push(`pr.code = $${params.length + 1}`);
        params.push(normalizedFilters.productCode);
      }

      appendInCondition("pr.id", filters.productIds, conditions, params);

      if (normalizedFilters.username) {
        conditions.push(`a.username = $${params.length + 1}`);
        params.push(normalizedFilters.username);
      }

      if (normalizedFilters.status) {
        conditions.push(`s.status = $${params.length + 1}`);
        params.push(normalizedFilters.status);
      }

      if (normalizedFilters.search) {
        const pattern = likeFilter(normalizedFilters.search);
        conditions.push(
          `(a.username LIKE $${params.length + 1} ESCAPE '\\' OR d.fingerprint LIKE $${params.length + 2} ESCAPE '\\' OR s.id LIKE $${params.length + 3} ESCAPE '\\')`
        );
        params.push(pattern, pattern, pattern);
      }

      const rows = await Promise.resolve(adapter.query(
        `
          SELECT s.id, s.account_id, s.entitlement_id, s.device_id, s.status, s.issued_at, s.expires_at,
                 s.last_heartbeat_at, s.last_seen_ip, s.user_agent, s.revoked_reason,
                 pr.id AS product_id, pr.code AS product_code, pr.name AS product_name,
                 a.username,
                 d.fingerprint, d.device_name,
                 pol.name AS policy_name
          FROM sessions s
          JOIN customer_accounts a ON a.id = s.account_id
          JOIN devices d ON d.id = s.device_id
          JOIN products pr ON pr.id = s.product_id
          JOIN entitlements e ON e.id = s.entitlement_id
          JOIN policies pol ON pol.id = e.policy_id
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY ${sessionOrderBy(queryOptions.sortBy)}
          LIMIT ${queryOptions.limit}
        `,
        params,
        {
          repository: "sessions",
          operation: "querySessionRows",
          filters: normalizedFilters,
          limit: queryOptions.limit,
          sortBy: queryOptions.sortBy
        }
      ));

      return {
        items: rows,
        total: rows.length,
        filters: normalizedFilters
      };
    },

    async countActiveSessionsByProductIds(_db, productIds = null) {
      const conditions = ["status = 'active'"];
      const params = [];

      appendInCondition("product_id", productIds, conditions, params);

      const rows = await Promise.resolve(adapter.query(
        `
          SELECT product_id, COUNT(*) AS count
          FROM sessions
          WHERE ${conditions.join(" AND ")}
          GROUP BY product_id
        `,
        params,
        {
          repository: "sessions",
          operation: "countActiveSessionsByProductIds",
          productIds: Array.isArray(productIds) ? [...productIds] : null
        }
      ));

      return rows.map((row) => ({
        ...row,
        count: Number(row.count ?? 0)
      }));
    },

    async listActiveSessionExpiryRows() {
      return Promise.resolve(adapter.query(
        `
          SELECT s.id, s.session_token, s.expires_at, s.last_heartbeat_at, p.heartbeat_timeout_seconds
          FROM sessions s
          JOIN entitlements e ON e.id = s.entitlement_id
          JOIN policies p ON p.id = e.policy_id
          WHERE s.status = 'active'
        `,
        [],
        {
          repository: "sessions",
          operation: "listActiveSessionExpiryRows"
        }
      ));
    }
  };
}
