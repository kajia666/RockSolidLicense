const state = {
  config: null,
  queries: [],
  ended: false
};

class Pool {
  constructor(config) {
    state.config = { ...config };
    state.queries = [];
    state.ended = false;
  }

  async query(sql, params) {
    const normalizedSql = String(sql ?? "").trim();
    state.queries.push({
      sql: normalizedSql,
      params: Array.isArray(params) ? [...params] : []
    });

    if (/SELECT 1 AS ok/i.test(normalizedSql)) {
      return { rows: [{ ok: 1 }] };
    }

    if (/FROM products p/i.test(normalizedSql)) {
      return {
        rows: [
          {
            id: "prod_runtime_1",
            code: "PGREAL",
            owner_developer_id: "dev_runtime_1",
            name: "Runtime Product",
            description: "Loaded through fake pg pool",
            status: "active",
            sdk_app_id: "app_runtime_1",
            sdk_app_secret: "secret_runtime_1",
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-02T00:00:00.000Z",
            allow_register: 1,
            allow_account_login: 1,
            allow_card_login: 1,
            allow_card_recharge: 1,
            allow_version_check: 1,
            allow_notices: 1,
            allow_client_unbind: 1,
            feature_created_at: "2026-01-01T00:00:00.000Z",
            feature_updated_at: "2026-01-02T00:00:00.000Z",
            owner_developer_username: "runtime-dev",
            owner_developer_display_name: "Runtime Dev",
            owner_developer_status: "active"
          }
        ]
      };
    }

    if (/FROM policies p/i.test(normalizedSql)) {
      return {
        rows: [
          {
            id: "policy_runtime_1",
            product_id: "prod_runtime_1",
            product_code: "PGREAL",
            product_name: "Runtime Product",
            name: "Runtime Policy",
            duration_days: 30,
            max_devices: 3,
            allow_concurrent_sessions: 1,
            heartbeat_interval_seconds: 60,
            heartbeat_timeout_seconds: 180,
            token_ttl_seconds: 300,
            bind_mode: "strict",
            bind_fields_json: "[\"deviceFingerprint\"]",
            allow_client_unbind: 0,
            client_unbind_limit: 0,
            client_unbind_window_days: 30,
            client_unbind_deduct_days: 0,
            grant_type: "duration",
            grant_points: 0,
            status: "active",
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-02T00:00:00.000Z"
          }
        ]
      };
    }

    if (/FROM license_keys lk/i.test(normalizedSql)) {
      return {
        rows: [
          {
            id: "card_runtime_1",
            product_id: "prod_runtime_1",
            product_code: "PGREAL",
            product_name: "Runtime Product",
            policy_id: "policy_runtime_1",
            policy_name: "Runtime Policy",
            grant_type: "duration",
            grant_points: 0,
            batch_code: "RUNTIME-001",
            card_key: "PGREAL-123456-AAAA",
            status: "fresh",
            notes: null,
            issued_at: "2026-01-01T00:00:00.000Z",
            redeemed_at: null,
            redeemed_username: null,
            redeemed_by_account_id: null,
            entitlement_id: null,
            entitlement_status: null,
            entitlement_ends_at: null,
            control_status: "active",
            expires_at: null,
            control_notes: null,
            reseller_id: null,
            reseller_code: null,
            reseller_name: null
          }
        ]
      };
    }

    if (/FROM entitlements e/i.test(normalizedSql)) {
      return {
        rows: [
          {
            id: "ent_runtime_1",
            product_code: "PGREAL",
            product_name: "Runtime Product",
            account_id: "acct_runtime_1",
            username: "runtime-user",
            policy_id: "policy_runtime_1",
            policy_name: "Runtime Policy",
            source_license_key_id: "card_runtime_1",
            card_key: "PGREAL-123456-AAAA",
            status: "active",
            starts_at: "2026-01-01T00:00:00.000Z",
            ends_at: "2026-02-01T00:00:00.000Z",
            grant_type: "duration",
            grant_points: 0,
            total_points: null,
            remaining_points: null,
            consumed_points: null,
            active_session_count: 1,
            card_control_status: "active",
            card_expires_at: null,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-02T00:00:00.000Z"
          }
        ]
      };
    }

    if (/FROM customer_accounts a/i.test(normalizedSql)) {
      return {
        rows: [
          {
            id: "acct_runtime_1",
            product_id: "prod_runtime_1",
            product_code: "PGREAL",
            product_name: "Runtime Product",
            owner_developer_id: "dev_runtime_1",
            username: "runtime-user",
            status: "active",
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-02T00:00:00.000Z",
            last_login_at: "2026-01-03T00:00:00.000Z",
            active_entitlement_count: 1,
            latest_entitlement_ends_at: "2026-02-01T00:00:00.000Z",
            active_session_count: 1
          }
        ]
      };
    }

    return { rows: [] };
  }

  async end() {
    state.ended = true;
  }
}

module.exports = {
  Pool,
  __state: state
};
