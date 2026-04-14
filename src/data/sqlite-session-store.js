import { getSessionRecordById } from "./session-repository.js";

function many(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

function run(db, sql, ...params) {
  return db.prepare(sql).run(...params);
}

function buildSessionFilterWhere(filters = {}) {
  const clauses = ["status = 'active'"];
  const params = [];

  if (filters.sessionId) {
    clauses.push("id = ?");
    params.push(filters.sessionId);
  }

  if (filters.sessionToken) {
    clauses.push("session_token = ?");
    params.push(filters.sessionToken);
  }

  if (filters.productId) {
    clauses.push("product_id = ?");
    params.push(filters.productId);
  }

  if (filters.accountId) {
    clauses.push("account_id = ?");
    params.push(filters.accountId);
  }

  if (filters.entitlementId) {
    clauses.push("entitlement_id = ?");
    params.push(filters.entitlementId);
  }

  if (filters.deviceId) {
    clauses.push("device_id = ?");
    params.push(filters.deviceId);
  }

  if (clauses.length === 1) {
    throw new Error("sqlite session store requires at least one session expiration filter");
  }

  return {
    whereSql: clauses.join(" AND "),
    params
  };
}

export function createSqliteSessionStore({ db }) {
  return {
    createIssuedSession(session = {}) {
      run(
        db,
        `
          INSERT INTO sessions
          (id, product_id, account_id, entitlement_id, device_id, session_token, license_token, status, issued_at,
           expires_at, last_heartbeat_at, last_seen_ip, user_agent)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
        `,
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
      );

      run(
        db,
        `
          UPDATE customer_accounts
          SET last_login_at = ?, updated_at = ?
          WHERE id = ?
        `,
        session.issuedAt,
        session.issuedAt,
        session.accountId
      );

      return getSessionRecordById(db, session.id);
    },

    expireActiveSessions(filters = {}, reason = "session_expired") {
      const { whereSql, params } = buildSessionFilterWhere(filters);
      const rows = many(
        db,
        `
          SELECT id, session_token
          FROM sessions
          WHERE ${whereSql}
        `,
        ...params
      );

      if (!rows.length) {
        return [];
      }

      run(
        db,
        `
          UPDATE sessions
          SET status = 'expired', revoked_reason = ?
          WHERE ${whereSql}
        `,
        reason,
        ...params
      );

      return rows;
    },

    touchSessionHeartbeat(sessionId, updates = {}) {
      run(
        db,
        `
          UPDATE sessions
          SET last_heartbeat_at = ?, expires_at = ?, last_seen_ip = ?, user_agent = ?
          WHERE id = ? AND status = 'active'
        `,
        updates.lastHeartbeatAt ?? null,
        updates.expiresAt ?? null,
        updates.lastSeenIp ?? null,
        updates.userAgent ?? null,
        sessionId
      );

      return getSessionRecordById(db, sessionId);
    }
  };
}
