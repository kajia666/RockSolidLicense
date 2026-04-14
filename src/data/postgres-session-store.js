async function loadSessionRecord(tx, sessionId) {
  const rows = await Promise.resolve(tx.query(
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
}

function buildSessionFilterWhere(filters = {}) {
  const clauses = ["status = 'active'"];
  const params = [];

  function append(column, value) {
    if (!value) {
      return;
    }

    params.push(value);
    clauses.push(`${column} = $${params.length}`);
  }

  append("id", filters.sessionId);
  append("session_token", filters.sessionToken);
  append("product_id", filters.productId);
  append("account_id", filters.accountId);
  append("entitlement_id", filters.entitlementId);
  append("device_id", filters.deviceId);

  if (clauses.length === 1) {
    throw new Error("postgres session store requires at least one session expiration filter");
  }

  return {
    whereSql: clauses.join(" AND "),
    params
  };
}

export function createPostgresSessionStore(adapter) {
  if (!adapter || typeof adapter.withTransaction !== "function") {
    return {};
  }

  return {
    async createIssuedSession(session = {}) {
      return adapter.withTransaction(async (tx) => {
        await Promise.resolve(tx.query(
          `
            INSERT INTO sessions
            (id, product_id, account_id, entitlement_id, device_id, session_token, license_token, status, issued_at,
             expires_at, last_heartbeat_at, last_seen_ip, user_agent)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10, $11, $12)
          `,
          [
            session.id,
            session.productId,
            session.accountId,
            session.entitlementId,
            session.deviceId,
            session.sessionToken,
            session.licenseToken,
            session.issuedAt,
            session.expiresAt,
            session.lastHeartbeatAt ?? session.issuedAt,
            session.lastSeenIp ?? null,
            session.userAgent ?? null
          ],
          {
            repository: "sessions",
            operation: "createIssuedSession",
            sessionId: session.id
          }
        ));

        return loadSessionRecord(tx, session.id);
      });
    },

    async touchSessionHeartbeat(sessionId, updates = {}) {
      return adapter.withTransaction(async (tx) => {
        await Promise.resolve(tx.query(
          `
            UPDATE sessions
            SET last_heartbeat_at = $1, expires_at = $2, last_seen_ip = $3, user_agent = $4
            WHERE id = $5 AND status = 'active'
          `,
          [
            updates.lastHeartbeatAt ?? null,
            updates.expiresAt ?? null,
            updates.lastSeenIp ?? null,
            updates.userAgent ?? null,
            sessionId
          ],
          {
            repository: "sessions",
            operation: "touchSessionHeartbeat",
            sessionId
          }
        ));

        return loadSessionRecord(tx, sessionId);
      });
    },

    async expireActiveSessions(filters = {}, reason = "session_expired") {
      const { whereSql, params } = buildSessionFilterWhere(filters);

      return adapter.withTransaction(async (tx) => {
        const rows = await Promise.resolve(tx.query(
          `
            SELECT id, session_token
            FROM sessions
            WHERE ${whereSql}
          `,
          params,
          {
            repository: "sessions",
            operation: "selectActiveSessionsForExpiry",
            filters,
            reason
          }
        ));

        if (!rows.length) {
          return [];
        }

        await Promise.resolve(tx.query(
          `
            UPDATE sessions
            SET status = 'expired', revoked_reason = $${params.length + 1}
            WHERE ${whereSql}
          `,
          [...params, reason],
          {
            repository: "sessions",
            operation: "expireActiveSessions",
            filters,
            reason
          }
        ));

        return rows.map((row) => ({ ...row }));
      });
    }
  };
}
