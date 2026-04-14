function safeParseJson(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function formatBindingRow(row) {
  return {
    id: row.id,
    entitlementId: row.entitlement_id,
    deviceId: row.device_id,
    status: row.status,
    firstBoundAt: row.first_bound_at,
    lastBoundAt: row.last_bound_at,
    revokedAt: row.revoked_at ?? null,
    fingerprint: row.fingerprint,
    deviceName: row.device_name ?? null,
    lastSeenAt: row.last_seen_at ?? null,
    lastSeenIp: row.last_seen_ip ?? null,
    matchFields: safeParseJson(row.match_fields_json, []),
    identity: safeParseJson(row.identity_json, {}),
    bindRequestIp: row.request_ip ?? null,
    activeSessionCount: Number(row.active_session_count ?? 0)
  };
}

export function createPostgresDeviceRepository(adapter) {
  return {
    async getActiveDeviceBlock(_db, productId, fingerprint) {
      const rows = await Promise.resolve(adapter.query(
        `
          SELECT *
          FROM device_blocks
          WHERE product_id = $1 AND fingerprint = $2 AND status = 'active'
          LIMIT 1
        `,
        [productId, fingerprint],
        {
          repository: "devices",
          operation: "getActiveDeviceBlock",
          productId,
          fingerprint
        }
      ));

      return rows[0] ?? null;
    },

    async queryBindingsForEntitlement(_db, entitlementId) {
      const rows = await Promise.resolve(adapter.query(
        `
          SELECT b.id, b.entitlement_id, b.device_id, b.status, b.first_bound_at, b.last_bound_at, b.revoked_at,
                 d.fingerprint, d.device_name, d.last_seen_at, d.last_seen_ip,
                 bp.match_fields_json, bp.identity_json, bp.request_ip,
                 COALESCE(sess.active_session_count, 0) AS active_session_count
          FROM device_bindings b
          JOIN devices d ON d.id = b.device_id
          LEFT JOIN device_binding_profiles bp ON bp.binding_id = b.id
          LEFT JOIN (
            SELECT entitlement_id, device_id, COUNT(*) AS active_session_count
            FROM sessions
            WHERE status = 'active'
            GROUP BY entitlement_id, device_id
          ) sess ON sess.entitlement_id = b.entitlement_id AND sess.device_id = b.device_id
          WHERE b.entitlement_id = $1
          ORDER BY CASE WHEN b.status = 'active' THEN 0 ELSE 1 END, b.last_bound_at DESC
        `,
        [entitlementId],
        {
          repository: "devices",
          operation: "queryBindingsForEntitlement",
          entitlementId
        }
      ));

      return rows.map(formatBindingRow);
    },

    async getBindingManageRowById(_db, bindingId) {
      const rows = await Promise.resolve(adapter.query(
        `
          SELECT b.id, b.entitlement_id, b.device_id, b.status,
                 pr.id AS product_id, pr.code AS product_code, pr.owner_developer_id,
                 a.id AS account_id, a.username,
                 d.fingerprint, d.device_name
          FROM device_bindings b
          JOIN entitlements e ON e.id = b.entitlement_id
          JOIN customer_accounts a ON a.id = e.account_id
          JOIN products pr ON pr.id = e.product_id
          JOIN devices d ON d.id = b.device_id
          WHERE b.id = $1
          LIMIT 1
        `,
        [bindingId],
        {
          repository: "devices",
          operation: "getBindingManageRowById",
          bindingId
        }
      ));

      return rows[0] ?? null;
    }
  };
}
