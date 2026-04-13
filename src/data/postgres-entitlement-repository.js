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

export function createPostgresEntitlementRepository(adapter) {
  return {
    queryEntitlementRows(_db, filters = {}, options = {}) {
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

      const items = adapter.query(
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
      ).map((row) => formatEntitlementRow(row, referenceTime)).filter((item) => {
        if (!normalizedFilters.status) {
          return true;
        }
        return item.lifecycleStatus === normalizedFilters.status;
      });

      return {
        items,
        filters: normalizedFilters
      };
    }
  };
}
