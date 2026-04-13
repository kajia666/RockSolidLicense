import { nowIso } from "../security.js";
import { AppError } from "../http.js";
import { formatCardRow } from "./card-repository.js";

const SUPPORTED_CARD_DISPLAY_STATUSES = new Set(["unused", "used", "frozen", "revoked", "expired"]);

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

function normalizeCardDisplayStatus(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }

  const status = String(value).trim().toLowerCase();
  if (!SUPPORTED_CARD_DISPLAY_STATUSES.has(status)) {
    throw new AppError(
      400,
      "INVALID_CARD_DISPLAY_STATUS",
      `Card filter status must be one of: ${Array.from(SUPPORTED_CARD_DISPLAY_STATUSES).join(", ")}.`
    );
  }

  return status;
}

function normalizeCardFilters(filters = {}) {
  return {
    productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
    policyId: filters.policyId ? String(filters.policyId).trim() : null,
    batchCode: filters.batchCode ? String(filters.batchCode).trim() : null,
    usageStatus: filters.usageStatus ? String(filters.usageStatus).trim().toLowerCase() : null,
    status: normalizeCardDisplayStatus(filters.status),
    resellerId: filters.resellerId ? String(filters.resellerId).trim() : null,
    search: filters.search ? String(filters.search).trim() : null
  };
}

function buildCardSelectSql(whereClause = "", limit = 500) {
  return `
      SELECT lk.*, pr.code AS product_code, pr.name AS product_name,
             pol.name AS policy_name,
             pgc.grant_type, pgc.grant_points,
             a.username AS redeemed_username,
             lkc.status AS control_status, lkc.expires_at, lkc.notes AS control_notes,
             e.id AS entitlement_id, e.status AS entitlement_status, e.ends_at AS entitlement_ends_at,
             r.id AS reseller_id, r.code AS reseller_code, r.name AS reseller_name
      FROM license_keys lk
      JOIN products pr ON pr.id = lk.product_id
      JOIN policies pol ON pol.id = lk.policy_id
      LEFT JOIN policy_grant_configs pgc ON pgc.policy_id = pol.id
      LEFT JOIN customer_accounts a ON a.id = lk.redeemed_by_account_id
      LEFT JOIN license_key_controls lkc ON lkc.license_key_id = lk.id
      LEFT JOIN entitlements e ON e.source_license_key_id = lk.id
      LEFT JOIN reseller_inventory ri ON ri.license_key_id = lk.id AND ri.status = 'active'
      LEFT JOIN resellers r ON r.id = ri.reseller_id
      ${whereClause}
      ORDER BY lk.issued_at DESC, lk.id DESC
      LIMIT ${limit}
    `;
}

export function createPostgresCardRepository(adapter) {
  return {
    queryCardRows(_db, filters = {}, options = {}) {
      const normalizedFilters = normalizeCardFilters(filters);
      const conditions = [];
      const params = [];

      if (filters.ownerDeveloperId) {
        conditions.push(`pr.owner_developer_id = $${params.length + 1}`);
        params.push(filters.ownerDeveloperId);
      }
      appendInCondition("pr.id", filters.productIds, conditions, params);

      if (normalizedFilters.productCode) {
        conditions.push(`pr.code = $${params.length + 1}`);
        params.push(normalizedFilters.productCode);
      }

      if (normalizedFilters.policyId) {
        conditions.push(`lk.policy_id = $${params.length + 1}`);
        params.push(normalizedFilters.policyId);
      }

      if (normalizedFilters.batchCode) {
        conditions.push(`lk.batch_code = $${params.length + 1}`);
        params.push(normalizedFilters.batchCode);
      }

      if (normalizedFilters.usageStatus) {
        if (!["fresh", "redeemed", "unused", "used"].includes(normalizedFilters.usageStatus)) {
          throw new AppError(400, "INVALID_CARD_USAGE_STATUS", "usageStatus must be fresh, redeemed, unused, or used.");
        }
        conditions.push(`lk.status = $${params.length + 1}`);
        params.push(["unused", "fresh"].includes(normalizedFilters.usageStatus) ? "fresh" : "redeemed");
      }

      if (normalizedFilters.resellerId) {
        conditions.push(`ri.reseller_id = $${params.length + 1}`);
        params.push(normalizedFilters.resellerId);
      }

      if (normalizedFilters.search) {
        const pattern = likeFilter(normalizedFilters.search);
        conditions.push(
          `(lk.card_key LIKE $${params.length + 1} ESCAPE '\\' OR lk.batch_code LIKE $${params.length + 2} ESCAPE '\\' OR COALESCE(a.username, '') LIKE $${params.length + 3} ESCAPE '\\' OR COALESCE(r.code, '') LIKE $${params.length + 4} ESCAPE '\\')`
        );
        params.push(pattern, pattern, pattern, pattern);
      }

      const limit = options.limit === undefined || options.limit === null
        ? 500
        : Math.min(Math.max(Number(options.limit), 1), 5000);
      const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const referenceTime = nowIso();

      const items = adapter.query(
        buildCardSelectSql(whereClause, limit),
        params,
        {
          repository: "cards",
          operation: "queryCardRows",
          filters: normalizedFilters,
          options: { limit }
        }
      )
        .map((row) => formatCardRow({
          ...row,
          status: row.status,
          notes: row.control_notes ?? row.notes
        }, referenceTime))
        .filter((item) => !normalizedFilters.status || item.displayStatus === normalizedFilters.status);

      const summary = items.reduce((accumulator, item) => {
        accumulator.total += 1;
        accumulator[item.displayStatus] += 1;
        return accumulator;
      }, {
        total: 0,
        unused: 0,
        used: 0,
        frozen: 0,
        revoked: 0,
        expired: 0
      });

      return {
        items,
        summary,
        filters: normalizedFilters
      };
    },

    getCardRowById(_db, cardId) {
      const rows = adapter.query(
        buildCardSelectSql("WHERE lk.id = $1", 1),
        [cardId],
        {
          repository: "cards",
          operation: "getCardRowById",
          cardId
        }
      );
      const row = rows[0] ?? null;
      return row ? formatCardRow({
        ...row,
        status: row.status,
        notes: row.control_notes ?? row.notes
      }) : null;
    }
  };
}
