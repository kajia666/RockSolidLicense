import { getSessionRecordById } from "./session-repository.js";

function run(db, sql, ...params) {
  return db.prepare(sql).run(...params);
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
    }
  };
}
