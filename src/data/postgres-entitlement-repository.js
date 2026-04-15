import { AppError } from "../http.js";
import { nowIso } from "../security.js";
import { formatEntitlementRow } from "./entitlement-repository.js";
import { normalizeGrantType } from "./policy-repository.js";

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

function escapeLikeText(value) {
  return String(value).replace(/[%_]/g, "\\$&");
}

function likeFilter(value) {
  return `%${escapeLikeText(value).trim()}%`;
}

function entitlementAccessSelectSql(whereClause = "") {
  return `
    SELECT e.*, p.name AS policy_name, p.max_devices, p.allow_concurrent_sessions,
           p.heartbeat_interval_seconds, p.heartbeat_timeout_seconds, p.token_ttl_seconds, p.bind_mode,
           lkc.status AS card_control_status, lkc.expires_at AS card_expires_at,
           pgc.grant_type, pgc.grant_points,
           em.total_points, em.remaining_points, em.consumed_points
    FROM entitlements e
    JOIN policies p ON p.id = e.policy_id
    JOIN license_keys lk ON lk.id = e.source_license_key_id
    LEFT JOIN license_key_controls lkc ON lkc.license_key_id = lk.id
    LEFT JOIN policy_grant_configs pgc ON pgc.policy_id = p.id
    LEFT JOIN entitlement_metering em ON em.entitlement_id = e.id
    ${whereClause}
  `;
}

export function createPostgresEntitlementRepository(adapter) {
  return {
    async getUsableDurationEntitlement(_db, accountId, productId, referenceTime = nowIso()) {
      const rows = await Promise.resolve(adapter.query(
        `${entitlementAccessSelectSql(`
          WHERE e.account_id = $1
            AND e.product_id = $2
            AND e.status = 'active'
            AND e.starts_at <= $3
            AND e.ends_at > $4
            AND COALESCE(pgc.grant_type, 'duration') = 'duration'
            AND (lkc.license_key_id IS NULL OR lkc.status = 'active')
            AND (lkc.expires_at IS NULL OR lkc.expires_at > $5)
        `)}
         ORDER BY e.ends_at DESC
         LIMIT 1`,
        [accountId, productId, referenceTime, referenceTime, referenceTime],
        {
          repository: "entitlements",
          operation: "getUsableDurationEntitlement",
          accountId,
          productId,
          referenceTime
        }
      ));

      return rows[0] ?? null;
    },

    async getUsablePointsEntitlement(_db, accountId, productId, referenceTime = nowIso()) {
      const rows = await Promise.resolve(adapter.query(
        `${entitlementAccessSelectSql(`
          WHERE e.account_id = $1
            AND e.product_id = $2
            AND e.status = 'active'
            AND e.starts_at <= $3
            AND e.ends_at > $4
            AND pgc.grant_type = 'points'
            AND em.remaining_points > 0
            AND (lkc.license_key_id IS NULL OR lkc.status = 'active')
            AND (lkc.expires_at IS NULL OR lkc.expires_at > $5)
        `)}
         ORDER BY e.created_at ASC, e.ends_at ASC
         LIMIT 1`,
        [accountId, productId, referenceTime, referenceTime, referenceTime],
        {
          repository: "entitlements",
          operation: "getUsablePointsEntitlement",
          accountId,
          productId,
          referenceTime
        }
      ));

      return rows[0] ?? null;
    },

    async getUsableEntitlement(db, accountId, productId, referenceTime = nowIso()) {
      const durationEntitlement = await this.getUsableDurationEntitlement(
        db,
        accountId,
        productId,
        referenceTime
      );
      if (durationEntitlement) {
        return durationEntitlement;
      }

      return this.getUsablePointsEntitlement(db, accountId, productId, referenceTime);
    },

    async getLatestEntitlementSnapshot(_db, accountId, productId) {
      const rows = await Promise.resolve(adapter.query(
        `${entitlementAccessSelectSql(`
          WHERE e.account_id = $1 AND e.product_id = $2
        `)}
         ORDER BY e.ends_at DESC, e.created_at DESC
         LIMIT 1`,
        [accountId, productId],
        {
          repository: "entitlements",
          operation: "getLatestEntitlementSnapshot",
          accountId,
          productId
        }
      ));

      return rows[0] ?? null;
    },

    async queryEntitlementRows(_db, filters = {}, options = {}) {
      const referenceTime = nowIso();
      const normalizedFilters = {
        productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
        username: filters.username ? String(filters.username).trim() : null,
        status: filters.status ? String(filters.status).trim().toLowerCase() : null,
        grantType: filters.grantType ? normalizeGrantType(filters.grantType) : null,
        search: filters.search ? String(filters.search).trim() : null
      };
      const conditions = [];
      const params = [];

      if (filters.entitlementId) {
        conditions.push(`e.id = $${params.length + 1}`);
        params.push(String(filters.entitlementId).trim());
      }

      if (normalizedFilters.productCode) {
        conditions.push(`pr.code = $${params.length + 1}`);
        params.push(normalizedFilters.productCode);
      }

      appendInCondition("pr.id", filters.productIds, conditions, params);

      if (normalizedFilters.username) {
        conditions.push(`a.username = $${params.length + 1}`);
        params.push(normalizedFilters.username);
      }

      if (normalizedFilters.grantType) {
        conditions.push(`COALESCE(pgc.grant_type, 'duration') = $${params.length + 1}`);
        params.push(normalizedFilters.grantType);
      }

      if (normalizedFilters.search) {
        const pattern = likeFilter(normalizedFilters.search);
        conditions.push(
          `(a.username LIKE $${params.length + 1} ESCAPE '\\' OR lk.card_key LIKE $${params.length + 2} ESCAPE '\\' OR pr.code LIKE $${params.length + 3} ESCAPE '\\' OR pol.name LIKE $${params.length + 4} ESCAPE '\\')`
        );
        params.push(pattern, pattern, pattern, pattern);
      }

      const limit = options.limit === undefined || options.limit === null
        ? 300
        : Math.min(Math.max(Number(options.limit), 1), 2000);

      const items = (await Promise.resolve(adapter.query(
        `
          SELECT e.*, pr.code AS product_code, pr.name AS product_name,
                 a.username, pol.name AS policy_name,
                 lk.card_key, lk.id AS license_key_id,
                 lkc.status AS card_control_status, lkc.expires_at AS card_expires_at,
                 pgc.grant_type, pgc.grant_points,
                 em.total_points, em.remaining_points, em.consumed_points,
                 COALESCE(sess.active_session_count, 0) AS active_session_count
          FROM entitlements e
          JOIN products pr ON pr.id = e.product_id
          JOIN customer_accounts a ON a.id = e.account_id
          JOIN policies pol ON pol.id = e.policy_id
          JOIN license_keys lk ON lk.id = e.source_license_key_id
          LEFT JOIN license_key_controls lkc ON lkc.license_key_id = lk.id
          LEFT JOIN policy_grant_configs pgc ON pgc.policy_id = pol.id
          LEFT JOIN entitlement_metering em ON em.entitlement_id = e.id
          LEFT JOIN (
            SELECT entitlement_id, COUNT(*) AS active_session_count
            FROM sessions
            WHERE status = 'active'
            GROUP BY entitlement_id
          ) sess ON sess.entitlement_id = e.id
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY e.ends_at DESC, e.created_at DESC
          LIMIT ${limit}
        `,
        params,
        {
          repository: "entitlements",
          operation: "queryEntitlementRows",
          filters: normalizedFilters,
          options: { limit }
        }
      ))).map((row) => formatEntitlementRow(row, referenceTime)).filter((item) => {
        if (!normalizedFilters.status) {
          return true;
        }
        return item.lifecycleStatus === normalizedFilters.status;
      });

      return {
        items,
        filters: normalizedFilters
      };
    },

    async countActiveEntitlementsByProductIds(_db, productIds = null, referenceTime = nowIso()) {
      const conditions = ["status = 'active'", `ends_at > $1`];
      const params = [referenceTime];

      appendInCondition("product_id", productIds, conditions, params);

      const rows = await Promise.resolve(adapter.query(
        `
          SELECT product_id, COUNT(*) AS count
          FROM entitlements
          WHERE ${conditions.join(" AND ")}
          GROUP BY product_id
        `,
        params,
        {
          repository: "entitlements",
          operation: "countActiveEntitlementsByProductIds",
          productIds: Array.isArray(productIds) ? [...productIds] : null,
          referenceTime
        }
      ));

      return rows.map((row) => ({
        ...row,
        count: Number(row.count ?? 0)
      }));
    }
  };
}
