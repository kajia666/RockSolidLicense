import { formatAccountRow, normalizeAccountStatus } from "./account-repository.js";

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

function normalizeAccountFilters(filters = {}) {
  return {
    accountId: filters.accountId ? String(filters.accountId).trim() : null,
    productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
    status: filters.status ? normalizeAccountStatus(filters.status) : null,
    search: filters.search ? String(filters.search).trim() : null
  };
}

function escapeLikeText(value) {
  return String(value ?? "").replace(/[\\%_]/g, "\\$&");
}

function likeFilter(value) {
  return `%${escapeLikeText(value)}%`;
}

function accountSelectSql(whereClause = "") {
  return `
    SELECT a.id, a.product_id, a.username, a.status, a.created_at, a.updated_at, a.last_login_at,
           pr.code AS product_code, pr.name AS product_name, pr.owner_developer_id,
           COALESCE(ent.active_entitlement_count, 0) AS active_entitlement_count,
           ent.latest_entitlement_ends_at,
           COALESCE(sess.active_session_count, 0) AS active_session_count
    FROM customer_accounts a
    JOIN products pr ON pr.id = a.product_id
    LEFT JOIN (
      SELECT account_id,
             COUNT(*) AS active_entitlement_count,
             MAX(ends_at) AS latest_entitlement_ends_at
      FROM entitlements
      WHERE status = 'active' AND ends_at > $1
      GROUP BY account_id
    ) ent ON ent.account_id = a.id
    LEFT JOIN (
      SELECT account_id, COUNT(*) AS active_session_count
      FROM sessions
      WHERE status = 'active'
      GROUP BY account_id
    ) sess ON sess.account_id = a.id
    ${whereClause}
  `;
}

async function loadAccountRows(adapter, filters = {}, operation = "queryAccountRows", limit = 100) {
  const normalizedFilters = normalizeAccountFilters(filters);
  const conditions = [];
  const referenceTime = String(filters.referenceTime ?? new Date().toISOString());
  const params = [referenceTime];

  if (normalizedFilters.accountId) {
    conditions.push(`a.id = $${params.length + 1}`);
    params.push(normalizedFilters.accountId);
  }

  if (normalizedFilters.productCode) {
    conditions.push(`pr.code = $${params.length + 1}`);
    params.push(normalizedFilters.productCode);
  }

  appendInCondition("pr.id", filters.productIds, conditions, params);

  if (normalizedFilters.status) {
    conditions.push(`a.status = $${params.length + 1}`);
    params.push(normalizedFilters.status);
  }

  if (normalizedFilters.search) {
    const pattern = likeFilter(normalizedFilters.search);
    conditions.push(`(a.username LIKE $${params.length + 1} ESCAPE '\\' OR pr.code LIKE $${params.length + 2} ESCAPE '\\')`);
    params.push(pattern, pattern);
  }

  const rows = await Promise.resolve(adapter.query(
    `${accountSelectSql(conditions.length ? `WHERE ${conditions.join(" AND ")}` : "")}
     ORDER BY a.created_at DESC
     LIMIT ${Math.max(1, Number(limit) || 1)}`,
    params,
    {
      repository: "accounts",
      operation,
      filters: normalizedFilters,
      referenceTime
    }
  ));

  return {
    items: rows.map((row) => formatAccountRow(row)),
    filters: normalizedFilters
  };
}

export function createPostgresAccountRepository(adapter) {
  return {
    async queryAccountRows(_db, filters = {}) {
      const result = await loadAccountRows(adapter, filters, "queryAccountRows", 100);
      return {
        ...result,
        total: result.items.length
      };
    },

    async getAccountManageRowById(_db, accountId) {
      const result = await loadAccountRows(adapter, { accountId }, "loadAccountManageRow", 1);
      return result.items[0] ?? null;
    },

    async getAccountRecordById(_db, accountId) {
      const rows = await Promise.resolve(adapter.query(
        `
          SELECT *
          FROM customer_accounts
          WHERE id = $1
          LIMIT 1
        `,
        [accountId],
        {
          repository: "accounts",
          operation: "getAccountRecordById",
          accountId
        }
      ));

      return rows[0] ?? null;
    },

    async getAccountRecordByProductUsername(_db, productId, username, status = null) {
      const params = [productId, String(username ?? "").trim()];
      const conditions = ["product_id = $1", "username = $2"];

      if (status) {
        conditions.push(`status = $${params.length + 1}`);
        params.push(normalizeAccountStatus(status));
      }

      const rows = await Promise.resolve(adapter.query(
        `
          SELECT *
          FROM customer_accounts
          WHERE ${conditions.join(" AND ")}
          LIMIT 1
        `,
        params,
        {
          repository: "accounts",
          operation: "getAccountRecordByProductUsername",
          productId,
          username: params[1],
          status: params[2] ?? null
        }
      ));

      return rows[0] ?? null;
    },

    async accountUsernameExists(_db, productId, username) {
      const rows = await Promise.resolve(adapter.query(
        `
          SELECT id
          FROM customer_accounts
          WHERE product_id = $1 AND username = $2
          LIMIT 1
        `,
        [productId, String(username ?? "").trim()],
        {
          repository: "accounts",
          operation: "accountUsernameExists",
          productId
        }
      ));

      return Boolean(rows[0]);
    }
  };
}
