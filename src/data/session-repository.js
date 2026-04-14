function one(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

export function getSessionRecordById(db, sessionId) {
  return one(db, "SELECT * FROM sessions WHERE id = ?", sessionId);
}

export function getSessionRecordByProductToken(db, productId, sessionToken) {
  return one(
    db,
    "SELECT * FROM sessions WHERE product_id = ? AND session_token = ?",
    productId,
    sessionToken
  );
}

export function getSessionRecordByToken(db, sessionToken) {
  return one(db, "SELECT * FROM sessions WHERE session_token = ?", sessionToken);
}

export function getActiveSessionHeartbeatRow(db, productId, sessionToken) {
  return one(
    db,
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
      WHERE s.product_id = ? AND s.session_token = ? AND s.status = 'active'
    `,
    productId,
    sessionToken
  );
}

export function getSessionManageRowById(db, sessionId) {
  return one(
    db,
    `
      SELECT s.id, s.status, s.revoked_reason, s.product_id, s.account_id,
             pr.code AS product_code, pr.owner_developer_id,
             a.username,
             d.fingerprint
      FROM sessions s
      JOIN customer_accounts a ON a.id = s.account_id
      JOIN devices d ON d.id = s.device_id
      JOIN products pr ON pr.id = s.product_id
      WHERE s.id = ?
    `,
    sessionId
  );
}

export function listActiveSessionExpiryRows(db) {
  return db.prepare(
    `
      SELECT s.id, s.session_token, s.expires_at, s.last_heartbeat_at, p.heartbeat_timeout_seconds
      FROM sessions s
      JOIN entitlements e ON e.id = s.entitlement_id
      JOIN policies p ON p.id = e.policy_id
      WHERE s.status = 'active'
    `
  ).all();
}
