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
