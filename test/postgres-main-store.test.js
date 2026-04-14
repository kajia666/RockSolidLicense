import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

function createTestApp(overrides = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rocksolid-postgres-main-store-"));
  const app = createApp({
    host: "127.0.0.1",
    port: 0,
    tcpEnabled: false,
    dbPath: ":memory:",
    licensePrivateKeyPath: path.join(tempDir, "license_private.pem"),
    licensePublicKeyPath: path.join(tempDir, "license_public.pem"),
    licenseKeyringPath: path.join(tempDir, "license_keyring.json"),
    adminUsername: "admin",
    adminPassword: "Pass123!abc",
    serverTokenSecret: "test-secret",
    ...overrides
  });

  return { app, tempDir };
}

function createWriteCapableAdapter() {
  const state = {
    queries: [],
    products: [],
    productFeatureConfigs: new Map(),
    policies: [],
    policyBindConfigs: new Map(),
    policyUnbindConfigs: new Map(),
    policyGrantConfigs: new Map(),
    licenseKeys: [],
    licenseKeyControls: new Map(),
    customerAccounts: [],
    cardLoginAccounts: [],
    deviceBindings: [],
    entitlementUnbindLogs: [],
    sessions: [],
    entitlements: [],
    entitlementMetering: new Map()
  };

  function productRows(filters = {}) {
    return state.products
      .filter((product) => !filters.productId || product.id === filters.productId)
      .filter((product) => !filters.productCode || product.code === filters.productCode)
      .filter((product) => !filters.sdkAppId || product.sdk_app_id === filters.sdkAppId)
      .filter((product) => !filters.status || product.status === filters.status)
      .filter((product) => !filters.ownerDeveloperId || product.owner_developer_id === filters.ownerDeveloperId)
      .filter((product) => !filters.productIds || filters.productIds.includes(product.id))
      .map((product) => {
        const feature = state.productFeatureConfigs.get(product.id);
        return {
          ...product,
          allow_register: feature?.allow_register ?? 1,
          allow_account_login: feature?.allow_account_login ?? 1,
          allow_card_login: feature?.allow_card_login ?? 1,
          allow_card_recharge: feature?.allow_card_recharge ?? 1,
          allow_version_check: feature?.allow_version_check ?? 1,
          allow_notices: feature?.allow_notices ?? 1,
          allow_client_unbind: feature?.allow_client_unbind ?? 1,
          feature_created_at: feature?.created_at ?? product.created_at,
          feature_updated_at: feature?.updated_at ?? product.updated_at,
          owner_developer_username: null,
          owner_developer_display_name: "",
          owner_developer_status: null
        };
      });
  }

  function policyRows(filters = {}) {
    return state.policies
      .filter((policy) => !filters.policyId || policy.id === filters.policyId)
      .filter((policy) => !filters.productIds || filters.productIds.includes(policy.product_id))
      .map((policy) => {
        const product = state.products.find((item) => item.id === policy.product_id);
        const bindConfig = state.policyBindConfigs.get(policy.id);
        const unbindConfig = state.policyUnbindConfigs.get(policy.id);
        const grantConfig = state.policyGrantConfigs.get(policy.id);
        return {
          ...policy,
          product_code: product?.code ?? null,
          product_name: product?.name ?? null,
          owner_developer_id: product?.owner_developer_id ?? null,
          bind_fields_json: bindConfig?.bind_fields_json ?? JSON.stringify(["deviceFingerprint"]),
          allow_client_unbind: unbindConfig?.allow_client_unbind ?? 0,
          client_unbind_limit: unbindConfig?.client_unbind_limit ?? 0,
          client_unbind_window_days: unbindConfig?.client_unbind_window_days ?? 30,
          client_unbind_deduct_days: unbindConfig?.client_unbind_deduct_days ?? 0,
          grant_type: grantConfig?.grant_type ?? "duration",
          grant_points: grantConfig?.grant_points ?? 0
        };
      })
      .filter((policy) => !filters.productCode || policy.product_code === filters.productCode)
      .filter((policy) => !filters.ownerDeveloperId || policy.owner_developer_id === filters.ownerDeveloperId);
  }

  function cardRows(filters = {}) {
    return state.licenseKeys
      .filter((card) => !filters.cardId || card.id === filters.cardId)
      .filter((card) => !filters.productIds || filters.productIds.includes(card.product_id))
      .map((card) => {
        const product = state.products.find((item) => item.id === card.product_id);
        const policy = state.policies.find((item) => item.id === card.policy_id);
        const grantConfig = state.policyGrantConfigs.get(card.policy_id);
        const account = state.customerAccounts.find((item) => item.id === card.redeemed_by_account_id);
        const control = state.licenseKeyControls.get(card.id);
        const entitlement = state.entitlements.find((item) => item.source_license_key_id === card.id);
        return {
          ...card,
          product_code: product?.code ?? null,
          product_name: product?.name ?? null,
          policy_name: policy?.name ?? null,
          grant_type: grantConfig?.grant_type ?? "duration",
          grant_points: grantConfig?.grant_points ?? 0,
          redeemed_username: account?.username ?? null,
          control_status: control?.status ?? null,
          expires_at: control?.expires_at ?? null,
          control_notes: control?.notes ?? null,
          entitlement_id: entitlement?.id ?? null,
          entitlement_status: entitlement?.status ?? null,
          entitlement_ends_at: entitlement?.ends_at ?? null,
          reseller_id: null,
          reseller_code: null,
          reseller_name: null
        };
      })
      .filter((card) => !filters.productCode || card.product_code === filters.productCode)
      .filter((card) => !filters.policyId || card.policy_id === filters.policyId)
      .filter((card) => !filters.batchCode || card.batch_code === filters.batchCode)
      .filter((card) => !filters.usageStatus || card.status === filters.usageStatus);
  }

  function entitlementRows(filters = {}) {
    return state.entitlements
      .filter((entitlement) => !filters.entitlementId || entitlement.id === filters.entitlementId)
      .filter((entitlement) => !filters.productIds || filters.productIds.includes(entitlement.product_id))
      .map((entitlement) => {
        const product = state.products.find((item) => item.id === entitlement.product_id);
        const account = state.customerAccounts.find((item) => item.id === entitlement.account_id);
        const policy = state.policies.find((item) => item.id === entitlement.policy_id);
        const card = state.licenseKeys.find((item) => item.id === entitlement.source_license_key_id);
        const grantConfig = state.policyGrantConfigs.get(entitlement.policy_id);
        const metering = state.entitlementMetering.get(entitlement.id);
        const control = state.licenseKeyControls.get(entitlement.source_license_key_id);
        return {
          ...entitlement,
          product_code: product?.code ?? null,
          product_name: product?.name ?? null,
          username: account?.username ?? null,
          policy_name: policy?.name ?? null,
          max_devices: policy?.max_devices ?? policy?.maxDevices ?? 1,
          allow_concurrent_sessions: policy?.allow_concurrent_sessions ?? policy?.allowConcurrentSessions ?? 0,
          heartbeat_interval_seconds: policy?.heartbeat_interval_seconds ?? policy?.heartbeatIntervalSeconds ?? 60,
          heartbeat_timeout_seconds: policy?.heartbeat_timeout_seconds ?? policy?.heartbeatTimeoutSeconds ?? 180,
          token_ttl_seconds: policy?.token_ttl_seconds ?? policy?.tokenTtlSeconds ?? 300,
          bind_mode: policy?.bind_mode ?? policy?.bindMode ?? "strict",
          card_key: card?.card_key ?? null,
          license_key_id: card?.id ?? null,
          card_control_status: control?.status ?? null,
          card_expires_at: control?.expires_at ?? null,
          grant_type: grantConfig?.grant_type ?? "duration",
          grant_points: grantConfig?.grant_points ?? 0,
          total_points: metering?.total_points ?? null,
          remaining_points: metering?.remaining_points ?? null,
          consumed_points: metering?.consumed_points ?? null,
          active_session_count: 0
        };
      })
      .filter((entitlement) => !filters.productCode || entitlement.product_code === filters.productCode)
      .filter((entitlement) => !filters.username || entitlement.username === filters.username)
      .filter((entitlement) => !filters.grantType || entitlement.grant_type === filters.grantType);
  }

  function accountRows(filters = {}, referenceTime = "9999-12-31T23:59:59.999Z") {
    const normalizedSearch = String(filters.search ?? "").trim().toLowerCase();

    return state.customerAccounts
      .map((account) => {
        const product = state.products.find((item) => item.id === account.product_id);
        const activeEntitlements = state.entitlements.filter(
          (entitlement) => entitlement.account_id === account.id
            && entitlement.status === "active"
            && String(entitlement.ends_at ?? "") > referenceTime
        );
        const activeSessions = state.sessions.filter(
          (session) => session.account_id === account.id && session.status === "active"
        );
        const latestEntitlementEndsAt = activeEntitlements
          .map((entitlement) => entitlement.ends_at)
          .filter(Boolean)
          .sort()
          .at(-1) ?? null;

        return {
          ...account,
          product_code: product?.code ?? null,
          product_name: product?.name ?? null,
          owner_developer_id: product?.owner_developer_id ?? null,
          active_entitlement_count: activeEntitlements.length,
          latest_entitlement_ends_at: latestEntitlementEndsAt,
          active_session_count: activeSessions.length
        };
      })
      .filter((account) => !filters.accountId || account.id === filters.accountId)
      .filter((account) => !filters.productCode || account.product_code === filters.productCode)
      .filter((account) => !filters.productIds || filters.productIds.includes(account.product_id))
      .filter((account) => !filters.status || account.status === filters.status)
      .filter((account) => {
        if (!normalizedSearch) {
          return true;
        }
        return String(account.username ?? "").toLowerCase().includes(normalizedSearch)
          || String(account.product_code ?? "").toLowerCase().includes(normalizedSearch);
      });
  }

  function recordQuery(sql, params = [], meta = {}) {
    state.queries.push({
      sql: String(sql ?? "").trim(),
      params: [...params],
      meta
    });
  }

  async function handleQuery(sql, params = [], meta = {}) {
    recordQuery(sql, params, meta);

    if (meta.repository === "products" && meta.operation === "assertProductCodeAvailable") {
      return state.products
        .filter((product) => product.code === params[0])
        .slice(0, 1)
        .map((product) => ({ id: product.id }));
    }

    if (meta.repository === "products" && meta.operation === "createProduct") {
      state.products.push({
        id: params[0],
        code: params[1],
        name: params[2],
        description: params[3],
        status: params[4],
        owner_developer_id: params[5],
        sdk_app_id: params[6],
        sdk_app_secret: params[7],
        created_at: params[8],
        updated_at: params[9]
      });
      return [];
    }

    if (meta.repository === "products" && meta.operation === "loadProductFeatureConfig") {
      const feature = state.productFeatureConfigs.get(params[0]);
      return feature ? [{ ...feature }] : [];
    }

    if (meta.repository === "products" && meta.operation === "persistProductFeatureConfig") {
      state.productFeatureConfigs.set(params[0], {
        product_id: params[0],
        allow_register: params[1],
        allow_account_login: params[2],
        allow_card_login: params[3],
        allow_card_recharge: params[4],
        allow_version_check: params[5],
        allow_notices: params[6],
        allow_client_unbind: params[7],
        created_at: params[8],
        updated_at: params[9]
      });
      return [];
    }

    if (meta.repository === "products" && meta.operation === "touchProductUpdatedAt") {
      const product = state.products.find((item) => item.id === params[1]);
      if (product) {
        product.updated_at = params[0];
      }
      return [];
    }

    if (meta.repository === "products" && meta.operation === "updateProductOwner") {
      const product = state.products.find((item) => item.id === params[2]);
      if (product) {
        product.owner_developer_id = params[0];
        product.updated_at = params[1];
      }
      return [];
    }

    if (meta.repository === "products" && meta.operation === "rotateProductSdkCredentials") {
      const product = state.products.find((item) => item.id === params[3]);
      if (product) {
        product.sdk_app_id = params[0];
        product.sdk_app_secret = params[1];
        product.updated_at = params[2];
      }
      return [];
    }

    if (meta.repository === "products" && (meta.operation === "queryProductRows" || meta.operation === "loadProductRow")) {
      return productRows(meta.filters ?? { productId: meta.productId });
    }

    if (meta.repository === "products" && meta.operation === "getActiveProductRowBySdkAppId") {
      return productRows({ sdkAppId: meta.sdkAppId, status: "active" }).slice(0, 1);
    }

    if (meta.repository === "policies" && meta.operation === "createPolicy") {
      state.policies.push({
        id: params[0],
        product_id: params[1],
        name: params[2],
        duration_days: params[3],
        max_devices: params[4],
        allow_concurrent_sessions: params[5],
        heartbeat_interval_seconds: params[6],
        heartbeat_timeout_seconds: params[7],
        token_ttl_seconds: params[8],
        bind_mode: params[9],
        status: params[10],
        created_at: params[11],
        updated_at: params[12]
      });
      return [];
    }

    if (meta.repository === "policies" && meta.operation === "persistPolicyBindConfig") {
      state.policyBindConfigs.set(params[0], {
        policy_id: params[0],
        bind_mode: params[1],
        bind_fields_json: params[2],
        created_at: params[3],
        updated_at: params[4]
      });
      return [];
    }

    if (meta.repository === "policies" && meta.operation === "persistPolicyUnbindConfig") {
      state.policyUnbindConfigs.set(params[0], {
        policy_id: params[0],
        allow_client_unbind: params[1],
        client_unbind_limit: params[2],
        client_unbind_window_days: params[3],
        client_unbind_deduct_days: params[4],
        created_at: params[5],
        updated_at: params[6]
      });
      return [];
    }

    if (meta.repository === "policies" && meta.operation === "persistPolicyGrantConfig") {
      state.policyGrantConfigs.set(params[0], {
        policy_id: params[0],
        grant_type: params[1],
        grant_points: params[2],
        created_at: params[3],
        updated_at: params[4]
      });
      return [];
    }

    if (meta.repository === "policies" && meta.operation === "updatePolicyRuntimeConfig") {
      const policy = state.policies.find((item) => item.id === params[3]);
      if (policy) {
        policy.allow_concurrent_sessions = params[0];
        policy.bind_mode = params[1];
        policy.updated_at = params[2];
      }
      return [];
    }

    if (meta.repository === "policies" && (meta.operation === "queryPolicyRows" || meta.operation === "loadPolicyRow")) {
      return policyRows(meta.filters ?? { policyId: meta.policyId });
    }

    if (meta.repository === "cards" && meta.operation === "createCard") {
      state.licenseKeys.push({
        id: params[0],
        product_id: params[1],
        policy_id: params[2],
        card_key: params[3],
        batch_code: params[4],
        status: "fresh",
        notes: params[5],
        issued_at: params[6],
        redeemed_at: null,
        redeemed_by_account_id: null
      });
      return [];
    }

    if (meta.repository === "cards" && meta.operation === "loadCardControl") {
      const control = state.licenseKeyControls.get(params[0]);
      return control ? [{ ...control }] : [];
    }

    if (meta.repository === "cards" && meta.operation === "upsertCardControl") {
      state.licenseKeyControls.set(params[0], {
        license_key_id: params[0],
        status: params[1],
        expires_at: params[2],
        notes: params[3],
        created_at: params[4],
        updated_at: params[5]
      });
      return [];
    }

    if (meta.repository === "cards" && (meta.operation === "queryCardRows" || meta.operation === "loadCardRow" || meta.operation === "getCardRowById")) {
      return cardRows(meta.filters ?? { cardId: meta.cardId });
    }

    if (meta.repository === "entitlements" && meta.operation === "loadEntitlementManageRow") {
      return entitlementRows({ entitlementId: params[0] }).slice(0, 1);
    }

    if (meta.repository === "entitlements" && meta.operation === "updateEntitlementStatus") {
      const entitlement = state.entitlements.find((item) => item.id === params[2]);
      if (entitlement) {
        entitlement.status = params[0];
        entitlement.updated_at = params[1];
      }
      return [];
    }

    if (meta.repository === "entitlements" && meta.operation === "extendEntitlement") {
      const entitlement = state.entitlements.find((item) => item.id === params[2]);
      if (entitlement) {
        entitlement.ends_at = params[0];
        entitlement.updated_at = params[1];
      }
      return [];
    }

    if (meta.repository === "entitlements" && meta.operation === "loadPointEntitlementForAdmin") {
      return entitlementRows({ entitlementId: params[0] }).slice(0, 1);
    }

    if (meta.repository === "entitlements" && meta.operation === "loadEntitlementMetering") {
      const metering = state.entitlementMetering.get(params[0]);
      return metering ? [{ ...metering }] : [];
    }

    if (meta.repository === "entitlements" && meta.operation === "upsertEntitlementMetering") {
      state.entitlementMetering.set(params[0], {
        entitlement_id: params[0],
        grant_type: params[1],
        total_points: params[2],
        remaining_points: params[3],
        consumed_points: params[4],
        created_at: params[5],
        updated_at: params[6]
      });
      return [];
    }

    if (meta.repository === "entitlements" && meta.operation === "queryEntitlementRows") {
      return entitlementRows(meta.filters ?? {});
    }

    if (meta.repository === "entitlements" && meta.operation === "getUsableDurationEntitlement") {
      return entitlementRows({})
        .filter((entitlement) => entitlement.account_id === params[0])
        .filter((entitlement) => entitlement.product_id === params[1])
        .filter((entitlement) => entitlement.status === "active")
        .filter((entitlement) => entitlement.starts_at <= params[2] && entitlement.ends_at > params[3])
        .filter((entitlement) => (entitlement.grant_type ?? "duration") === "duration")
        .filter((entitlement) => !entitlement.card_control_status || entitlement.card_control_status === "active")
        .filter((entitlement) => !entitlement.card_expires_at || entitlement.card_expires_at > params[4])
        .sort((left, right) => String(right.ends_at).localeCompare(String(left.ends_at)))
        .slice(0, 1);
    }

    if (meta.repository === "entitlements" && meta.operation === "getUsablePointsEntitlement") {
      return entitlementRows({})
        .filter((entitlement) => entitlement.account_id === params[0])
        .filter((entitlement) => entitlement.product_id === params[1])
        .filter((entitlement) => entitlement.status === "active")
        .filter((entitlement) => entitlement.starts_at <= params[2] && entitlement.ends_at > params[3])
        .filter((entitlement) => entitlement.grant_type === "points")
        .filter((entitlement) => Number(entitlement.remaining_points ?? 0) > 0)
        .filter((entitlement) => !entitlement.card_control_status || entitlement.card_control_status === "active")
        .filter((entitlement) => !entitlement.card_expires_at || entitlement.card_expires_at > params[4])
        .sort((left, right) => {
          const createdOrder = String(left.created_at).localeCompare(String(right.created_at));
          return createdOrder || String(left.ends_at).localeCompare(String(right.ends_at));
        })
        .slice(0, 1);
    }

    if (meta.repository === "entitlements" && meta.operation === "getLatestEntitlementSnapshot") {
      return entitlementRows({})
        .filter((entitlement) => entitlement.account_id === params[0])
        .filter((entitlement) => entitlement.product_id === params[1])
        .sort((left, right) => {
          const endsOrder = String(right.ends_at).localeCompare(String(left.ends_at));
          return endsOrder || String(right.created_at).localeCompare(String(left.created_at));
        })
        .slice(0, 1);
    }

    if (meta.repository === "accounts" && (
      meta.operation === "queryAccountRows"
      || meta.operation === "loadAccountManageRow"
      || meta.operation === "getAccountManageRowById"
    )) {
      return accountRows(meta.filters ?? {}, params[0]);
    }

    if (meta.repository === "accounts" && meta.operation === "getAccountRecordById") {
      return state.customerAccounts
        .filter((account) => account.id === params[0])
        .slice(0, 1)
        .map((account) => ({ ...account }));
    }

    if (meta.repository === "accounts" && meta.operation === "getAccountRecordByProductUsername") {
      return state.customerAccounts
        .filter((account) => account.product_id === params[0] && account.username === params[1])
        .filter((account) => !params[2] || account.status === params[2])
        .slice(0, 1)
        .map((account) => ({ ...account }));
    }

    if (meta.repository === "accounts" && meta.operation === "accountUsernameExists") {
      return state.customerAccounts
        .filter((account) => account.product_id === params[0] && account.username === params[1])
        .slice(0, 1)
        .map((account) => ({ id: account.id }));
    }

    if (meta.repository === "accounts" && meta.operation === "createAccount") {
      state.customerAccounts.push({
        id: params[0],
        product_id: params[1],
        username: params[2],
        password_hash: params[3],
        status: "active",
        created_at: params[4],
        updated_at: params[5],
        last_login_at: null
      });
      return [];
    }

    if (meta.repository === "accounts" && meta.operation === "createCardLoginAccount") {
      state.customerAccounts.push({
        id: params[0],
        product_id: params[1],
        username: params[2],
        password_hash: params[3],
        status: "active",
        created_at: params[4],
        updated_at: params[5],
        last_login_at: null
      });
      return [];
    }

    if (meta.repository === "accounts" && meta.operation === "linkCardLoginAccount") {
      state.cardLoginAccounts.push({
        license_key_id: params[0],
        account_id: params[1],
        product_id: params[2],
        created_at: params[3]
      });
      return [];
    }

    if (meta.repository === "accounts" && meta.operation === "updateAccountStatus") {
      const account = state.customerAccounts.find((item) => item.id === params[2]);
      if (account) {
        account.status = params[0];
        account.updated_at = params[1];
      }
      return [];
    }

    if (meta.repository === "accounts" && meta.operation === "touchAccountLastLogin") {
      const account = state.customerAccounts.find((item) => item.id === params[2]);
      if (account) {
        account.last_login_at = params[0];
        account.updated_at = params[1];
      }
      return [];
    }

    if (meta.repository === "devices" && meta.operation === "releaseBinding") {
      const binding = state.deviceBindings.find((item) => item.id === params[2]);
      if (binding) {
        binding.status = "revoked";
        binding.revoked_at = params[0];
        binding.last_bound_at = params[1];
      }
      return [];
    }

    if (meta.repository === "devices" && meta.operation === "loadBindingRecordById") {
      return state.deviceBindings
        .filter((binding) => binding.id === params[0])
        .slice(0, 1)
        .map((binding) => ({ ...binding }));
    }

    if (meta.repository === "devices" && meta.operation === "countRecentClientUnbinds") {
      const count = state.entitlementUnbindLogs.filter((entry) =>
        entry.entitlement_id === params[0]
        && entry.actor_type === "client"
        && entry.created_at >= params[1]
      ).length;
      return [{ count }];
    }

    if (meta.repository === "devices" && meta.operation === "recordEntitlementUnbind") {
      state.entitlementUnbindLogs.push({
        id: params[0],
        entitlement_id: params[1],
        binding_id: params[2],
        actor_type: params[3],
        actor_id: params[4],
        reason: params[5],
        deducted_days: params[6],
        created_at: params[7]
      });
      return [];
    }

    if (meta.repository === "devices" && meta.operation === "loadEntitlementUnbindLog") {
      return state.entitlementUnbindLogs
        .filter((entry) => entry.id === params[0])
        .slice(0, 1)
        .map((entry) => ({ ...entry }));
    }

    return [];
  }

  const adapter = {
    async query(sql, params = [], meta = {}) {
      return handleQuery(sql, params, meta);
    },
    async withTransaction(callback) {
      return callback({
        query: (sql, params = [], meta = {}) => handleQuery(sql, params, meta)
      });
    }
  };

  return { adapter, state };
}

test("postgres main store configuration falls back to sqlite implementation", async () => {
  const { app, tempDir } = createTestApp({
    mainStoreDriver: "postgres",
    postgresUrl: "postgres://rocksolid:secret@127.0.0.1:5432/rocksolid"
  });

  try {
    assert.equal(app.mainStore.driver, "sqlite");
    assert.equal(app.mainStore.configuredDriver, "postgres");
    assert.equal(app.mainStore.targetDriver, "postgres");
    assert.equal(app.mainStore.implementationStage, "sqlite_fallback");
    assert.equal(app.mainStore.fallbackReason, "postgres_runtime_not_implemented");
    assert.equal(app.mainStore.postgresUrlConfigured, true);
    assert.match(app.mainStore.schemaScriptPath, /deploy[\\/]+postgres[\\/]+init\.sql$/);
    assert.deepEqual(
      app.mainStore.repositories,
      ["products", "policies", "cards", "entitlements", "accounts", "devices", "sessions"]
    );
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("health reports configured postgres main store and sqlite fallback stage", async () => {
  const { app, tempDir } = createTestApp({
    mainStoreDriver: "postgres",
    postgresUrl: "postgres://rocksolid:secret@127.0.0.1:5432/rocksolid"
  });

  try {
    const health = await app.services.health();
    assert.equal(health.storage.mainStore.driver, "sqlite");
    assert.equal(health.storage.mainStore.configuredDriver, "postgres");
    assert.equal(health.storage.mainStore.targetDriver, "postgres");
    assert.equal(health.storage.mainStore.implementationStage, "sqlite_fallback");
    assert.equal(health.storage.mainStore.fallbackReason, "postgres_runtime_not_implemented");
    assert.equal(health.storage.mainStore.postgresUrlConfigured, true);
    assert.match(health.storage.mainStore.schemaScriptPath, /deploy[\\/]+postgres[\\/]+init\.sql$/);
    assert.deepEqual(
      health.storage.mainStore.repositories,
      ["products", "policies", "cards", "entitlements", "accounts", "devices", "sessions"]
    );
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("postgres main store can serve all main-store read-side queries through adapter", async () => {
  const queries = [];
  const adapter = {
    query(sql, params, meta) {
      queries.push({
        sql: sql.trim(),
        params: [...params],
        meta
      });

      if (meta.repository === "products") {
        return [
          {
            id: "prod_pg_1",
            code: "PGAPP",
            owner_developer_id: "dev_pg_1",
            name: "Postgres Product",
            description: "Read-side preview",
            status: "active",
            sdk_app_id: "app_pg_1",
            sdk_app_secret: "secret_pg_1",
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
            owner_developer_username: "pgdev",
            owner_developer_display_name: "PG Dev",
            owner_developer_status: "active"
          }
        ];
      }

      if (meta.repository === "policies") {
        return [
          {
            id: "policy_pg_1",
            product_id: "prod_pg_1",
            product_code: "PGAPP",
            product_name: "Postgres Product",
            name: "PG Policy",
            duration_days: 30,
            max_devices: 2,
            allow_concurrent_sessions: 1,
            heartbeat_interval_seconds: 60,
            heartbeat_timeout_seconds: 180,
            token_ttl_seconds: 300,
            bind_mode: "selected_fields",
            bind_fields_json: "[\"deviceFingerprint\",\"machineGuid\"]",
            allow_client_unbind: 1,
            client_unbind_limit: 3,
            client_unbind_window_days: 30,
            client_unbind_deduct_days: 1,
            grant_type: "duration",
            grant_points: 0,
            status: "active",
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-02T00:00:00.000Z"
          }
        ];
      }

      if (meta.repository === "cards") {
        return [
          {
            id: "card_pg_1",
            product_id: "prod_pg_1",
            product_code: "PGAPP",
            product_name: "Postgres Product",
            policy_id: "policy_pg_1",
            policy_name: "PG Policy",
            grant_type: "points",
            grant_points: 25,
            batch_code: "BATCH-PG-001",
            card_key: "PGAPP-123456-ABCD",
            status: "fresh",
            notes: "postgres card",
            issued_at: "2026-01-01T00:00:00.000Z",
            redeemed_at: null,
            redeemed_username: null,
            redeemed_by_account_id: null,
            entitlement_id: "ent_pg_1",
            entitlement_status: "active",
            entitlement_ends_at: "2026-02-01T00:00:00.000Z",
            control_status: "active",
            expires_at: null,
            control_notes: null,
            reseller_id: null,
            reseller_code: null,
            reseller_name: null
          }
        ];
      }

      if (meta.repository === "entitlements") {
        return [
          {
            id: "ent_pg_1",
            product_id: "prod_pg_1",
            product_code: "PGAPP",
            product_name: "Postgres Product",
            account_id: "acct_pg_1",
            username: "pguser",
            policy_id: "policy_pg_1",
            policy_name: "PG Policy",
            max_devices: 2,
            allow_concurrent_sessions: 1,
            heartbeat_interval_seconds: 60,
            heartbeat_timeout_seconds: 180,
            token_ttl_seconds: 300,
            bind_mode: "selected_fields",
            source_license_key_id: "card_pg_1",
            card_key: "PGAPP-123456-ABCD",
            status: "active",
            starts_at: "2026-01-01T00:00:00.000Z",
            ends_at: "2026-02-01T00:00:00.000Z",
            grant_type: "points",
            grant_points: 25,
            total_points: 25,
            remaining_points: 17,
            consumed_points: 8,
            active_session_count: 2,
            card_control_status: "active",
            card_expires_at: null,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-02T00:00:00.000Z"
          }
        ];
      }

      if (meta.repository === "accounts") {
        return [
          {
            id: "acct_pg_1",
            product_id: "prod_pg_1",
            product_code: "PGAPP",
            product_name: "Postgres Product",
            owner_developer_id: "dev_pg_1",
            username: "pguser",
            status: "active",
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-02T00:00:00.000Z",
            last_login_at: "2026-01-03T00:00:00.000Z",
            active_entitlement_count: 1,
            latest_entitlement_ends_at: "2026-02-01T00:00:00.000Z",
            active_session_count: 2
          }
        ];
      }

      if (meta.repository === "devices" && meta.operation === "queryBindingsForEntitlement") {
        return [
          {
            id: "bind_pg_1",
            entitlement_id: "ent_pg_1",
            device_id: "dev_pg_1",
            status: "active",
            first_bound_at: "2026-01-03T00:00:00.000Z",
            last_bound_at: "2026-01-04T00:00:00.000Z",
            revoked_at: null,
            fingerprint: "pg-device-001",
            device_name: "PG Desktop",
            last_seen_at: "2026-01-04T00:05:00.000Z",
            last_seen_ip: "203.0.113.9",
            match_fields_json: "[\"deviceFingerprint\",\"machineGuid\"]",
            identity_json: "{\"machineGuid\":\"PG-MG-001\"}",
            request_ip: "203.0.113.9",
            active_session_count: 1
          }
        ];
      }

      if (meta.repository === "devices" && meta.operation === "getActiveDeviceBlock") {
        return [
          {
            id: "block_pg_1",
            product_id: "prod_pg_1",
            fingerprint: "pg-device-001",
            status: "active",
            reason: "manual_review",
            notes: "postgres device block",
            created_at: "2026-01-04T00:00:00.000Z",
            updated_at: "2026-01-04T00:00:00.000Z",
            released_at: null
          }
        ];
      }

      if (meta.repository === "devices" && meta.operation === "getBindingManageRowById") {
        return [
          {
            id: "bind_pg_1",
            entitlement_id: "ent_pg_1",
            device_id: "dev_pg_1",
            status: "active",
            product_id: "prod_pg_1",
            product_code: "PGAPP",
            owner_developer_id: "dev_pg_1",
            account_id: "acct_pg_1",
            username: "pguser",
            fingerprint: "pg-device-001",
            device_name: "PG Desktop"
          }
        ];
      }

      if (meta.repository === "sessions" && meta.operation === "getSessionRecordByProductToken") {
        return [
          {
            id: "sess_pg_1",
            product_id: "prod_pg_1",
            account_id: "acct_pg_1",
            entitlement_id: "ent_pg_1",
            device_id: "dev_pg_1",
            session_token: "session_pg_1",
            license_token: "license_pg_1",
            status: "active",
            issued_at: "2026-01-04T00:00:00.000Z",
            expires_at: "2026-01-04T01:00:00.000Z",
            last_heartbeat_at: "2026-01-04T00:10:00.000Z",
            last_seen_ip: "203.0.113.9",
            user_agent: "postgres-session-test"
          }
        ];
      }

      if (meta.repository === "sessions" && meta.operation === "getSessionRecordById") {
        return [
          {
            id: "sess_pg_1",
            product_id: "prod_pg_1",
            account_id: "acct_pg_1",
            entitlement_id: "ent_pg_1",
            device_id: "dev_pg_1",
            session_token: "session_pg_1",
            license_token: "license_pg_1",
            status: "active",
            issued_at: "2026-01-04T00:00:00.000Z",
            expires_at: "2026-01-04T01:00:00.000Z",
            last_heartbeat_at: "2026-01-04T00:10:00.000Z",
            last_seen_ip: "203.0.113.9",
            user_agent: "postgres-session-test"
          }
        ];
      }

      if (meta.repository === "sessions" && meta.operation === "getSessionRecordByToken") {
        return [
          {
            id: "sess_pg_1",
            product_id: "prod_pg_1",
            account_id: "acct_pg_1",
            entitlement_id: "ent_pg_1",
            device_id: "dev_pg_1",
            session_token: "session_pg_1",
            license_token: "license_pg_1",
            status: "active",
            issued_at: "2026-01-04T00:00:00.000Z",
            expires_at: "2026-01-04T01:00:00.000Z",
            last_heartbeat_at: "2026-01-04T00:10:00.000Z",
            last_seen_ip: "203.0.113.9",
            user_agent: "postgres-session-test"
          }
        ];
      }

      if (meta.repository === "sessions" && meta.operation === "getActiveSessionHeartbeatRow") {
        return [
          {
            id: "sess_pg_1",
            product_id: "prod_pg_1",
            account_id: "acct_pg_1",
            entitlement_id: "ent_pg_1",
            device_id: "dev_pg_1",
            session_token: "session_pg_1",
            license_token: "license_pg_1",
            status: "active",
            issued_at: "2026-01-04T00:00:00.000Z",
            expires_at: "2026-01-04T01:00:00.000Z",
            last_heartbeat_at: "2026-01-04T00:10:00.000Z",
            last_seen_ip: "203.0.113.9",
            user_agent: "postgres-session-test",
            fingerprint: "pg-device-001",
            username: "pguser",
            entitlement_status: "active",
            heartbeat_interval_seconds: 60,
            heartbeat_timeout_seconds: 180,
            token_ttl_seconds: 300,
            card_control_status: "active",
            card_expires_at: null
          }
        ];
      }

      if (meta.repository === "sessions" && meta.operation === "getSessionManageRowById") {
        return [
          {
            id: "sess_pg_1",
            status: "active",
            revoked_reason: null,
            product_id: "prod_pg_1",
            account_id: "acct_pg_1",
            product_code: "PGAPP",
            owner_developer_id: "dev_pg_1",
            username: "pguser",
            fingerprint: "pg-device-001"
          }
        ];
      }

      return [];
    }
  };

  const { app, tempDir } = createTestApp({
    mainStoreDriver: "postgres",
    postgresUrl: "postgres://rocksolid:secret@127.0.0.1:5432/rocksolid",
    postgresMainStoreAdapter: adapter
  });

  try {
    assert.equal(app.mainStore.driver, "postgres");
    assert.equal(app.mainStore.implementationStage, "read_side_preview");
    assert.deepEqual(app.mainStore.repositoryDrivers, {
      products: "postgres",
      policies: "postgres",
      cards: "postgres",
      entitlements: "postgres",
      accounts: "postgres",
      devices: "postgres",
      sessions: "postgres"
    });
    assert.deepEqual(app.mainStore.repositoryWriteDrivers, {
      products: "sqlite",
      policies: "sqlite",
      cards: "sqlite",
      entitlements: "sqlite",
      accounts: "sqlite",
      devices: "sqlite",
      sessions: "sqlite"
    });

    const admin = app.services.adminLogin({
      username: "admin",
      password: "Pass123!abc"
    });

    const products = await app.services.listProducts(admin.token);
    assert.equal(products.length, 1);
    assert.equal(products[0].code, "PGAPP");
    assert.equal(products[0].ownerDeveloper.username, "pgdev");

    const signedProduct = await app.mainStore.products.getActiveProductRowBySdkAppId(app.db, "app_pg_1");
    assert.equal(signedProduct.id, "prod_pg_1");
    assert.equal(signedProduct.code, "PGAPP");
    assert.equal(signedProduct.featureConfig.allowRegister, true);

    const policies = await app.services.listPolicies(admin.token, { productCode: "PGAPP" });
    assert.equal(policies.length, 1);
    assert.equal(policies[0].productCode, "PGAPP");
    assert.deepEqual(policies[0].bindFields, ["deviceFingerprint", "machineGuid"]);

    const cards = await app.services.listCards(admin.token, { productCode: "PGAPP" });
    assert.equal(cards.items.length, 1);
    assert.equal(cards.items[0].cardKey, "PGAPP-123456-ABCD");
    assert.equal(cards.items[0].grantType, "points");

    const cardById = await app.mainStore.cards.getCardRowById(app.db, "card_pg_1");
    assert.equal(cardById.id, "card_pg_1");
    assert.equal(cardById.maskedKey, "PGAPP-******-ABCD");

    const entitlements = await app.services.listEntitlements(admin.token, { productCode: "PGAPP" });
    assert.equal(entitlements.items.length, 1);
    assert.equal(entitlements.items[0].username, "pguser");
    assert.equal(entitlements.items[0].remainingPoints, 17);

    const usableEntitlement = await app.mainStore.entitlements.getUsableEntitlement(
      app.db,
      "acct_pg_1",
      "prod_pg_1",
      "2026-01-15T00:00:00.000Z"
    );
    assert.equal(usableEntitlement.id, "ent_pg_1");
    assert.equal(usableEntitlement.bind_mode, "selected_fields");

    const latestEntitlement = await app.mainStore.entitlements.getLatestEntitlementSnapshot(
      app.db,
      "acct_pg_1",
      "prod_pg_1"
    );
    assert.equal(latestEntitlement.id, "ent_pg_1");

    const accounts = await app.services.listAccounts(admin.token, { productCode: "PGAPP" });
    assert.equal(accounts.items.length, 1);
    assert.equal(accounts.items[0].username, "pguser");
    assert.equal(accounts.items[0].activeSessionCount, 2);

    const bindings = await app.mainStore.devices.queryBindingsForEntitlement(app.db, "ent_pg_1");
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].fingerprint, "pg-device-001");
    assert.deepEqual(bindings[0].matchFields, ["deviceFingerprint", "machineGuid"]);

    const activeBlock = await app.mainStore.devices.getActiveDeviceBlock(app.db, "prod_pg_1", "pg-device-001");
    assert.equal(activeBlock.reason, "manual_review");

    const bindingManageRow = await app.mainStore.devices.getBindingManageRowById(app.db, "bind_pg_1");
    assert.equal(bindingManageRow.product_code, "PGAPP");
    assert.equal(bindingManageRow.username, "pguser");

    const sessionByProductToken = await app.mainStore.sessions.getSessionRecordByProductToken(
      app.db,
      "prod_pg_1",
      "session_pg_1"
    );
    assert.equal(sessionByProductToken.id, "sess_pg_1");

    const sessionById = await app.mainStore.sessions.getSessionRecordById(app.db, "sess_pg_1");
    assert.equal(sessionById.session_token, "session_pg_1");

    const sessionByToken = await app.mainStore.sessions.getSessionRecordByToken(app.db, "session_pg_1");
    assert.equal(sessionByToken.id, "sess_pg_1");

    const heartbeatSession = await app.mainStore.sessions.getActiveSessionHeartbeatRow(
      app.db,
      "prod_pg_1",
      "session_pg_1"
    );
    assert.equal(heartbeatSession.fingerprint, "pg-device-001");
    assert.equal(heartbeatSession.username, "pguser");

    const sessionManageRow = await app.mainStore.sessions.getSessionManageRowById(app.db, "sess_pg_1");
    assert.equal(sessionManageRow.product_code, "PGAPP");
    assert.equal(sessionManageRow.username, "pguser");

    assert.equal(queries.length, 17);
    assert.equal(queries[0].meta.repository, "products");
    assert.match(queries[0].sql, /FROM products p/i);
    assert.equal(queries[1].meta.operation, "getActiveProductRowBySdkAppId");
    assert.match(queries[1].sql, /p\.sdk_app_id = \$1/i);
    assert.equal(queries[2].meta.repository, "policies");
    assert.match(queries[2].sql, /FROM policies p/i);
    assert.equal(queries[3].meta.repository, "cards");
    assert.match(queries[3].sql, /FROM license_keys lk/i);
    assert.equal(queries[4].meta.repository, "cards");
    assert.match(queries[4].sql, /WHERE lk\.id = \$1/i);
    assert.equal(queries[5].meta.repository, "entitlements");
    assert.match(queries[5].sql, /FROM entitlements e/i);
    assert.equal(queries[6].meta.operation, "getUsableDurationEntitlement");
    assert.match(queries[6].sql, /FROM entitlements e/i);
    assert.equal(queries[7].meta.operation, "getLatestEntitlementSnapshot");
    assert.match(queries[7].sql, /FROM entitlements e/i);
    assert.equal(queries[8].meta.repository, "accounts");
    assert.match(queries[8].sql, /FROM customer_accounts a/i);
    assert.equal(queries[9].meta.operation, "queryBindingsForEntitlement");
    assert.match(queries[9].sql, /FROM device_bindings b/i);
    assert.equal(queries[10].meta.operation, "getActiveDeviceBlock");
    assert.match(queries[10].sql, /FROM device_blocks/i);
    assert.equal(queries[11].meta.operation, "getBindingManageRowById");
    assert.match(queries[11].sql, /JOIN entitlements e ON e\.id = b\.entitlement_id/i);
    assert.equal(queries[12].meta.operation, "getSessionRecordByProductToken");
    assert.match(queries[12].sql, /FROM sessions/i);
    assert.equal(queries[13].meta.operation, "getSessionRecordById");
    assert.match(queries[13].sql, /WHERE id = \$1/i);
    assert.equal(queries[14].meta.operation, "getSessionRecordByToken");
    assert.match(queries[14].sql, /WHERE session_token = \$1/i);
    assert.equal(queries[15].meta.operation, "getActiveSessionHeartbeatRow");
    assert.match(queries[15].sql, /JOIN devices d ON d\.id = s\.device_id/i);
    assert.equal(queries[16].meta.operation, "getSessionManageRowById");
    assert.match(queries[16].sql, /JOIN products pr ON pr\.id = s\.product_id/i);

    const health = await app.services.health();
    assert.equal(health.storage.mainStore.driver, "postgres");
    assert.equal(health.storage.mainStore.implementationStage, "read_side_preview");
    assert.equal(health.storage.mainStore.adapterReady, true);
    assert.deepEqual(health.storage.mainStore.repositoryDrivers, {
      products: "postgres",
      policies: "postgres",
      cards: "postgres",
      entitlements: "postgres",
      accounts: "postgres",
      devices: "postgres",
      sessions: "postgres"
    });
    assert.deepEqual(health.storage.mainStore.repositoryWriteDrivers, {
      products: "sqlite",
      policies: "sqlite",
      cards: "sqlite",
      entitlements: "sqlite",
      accounts: "sqlite",
      devices: "sqlite",
      sessions: "sqlite"
    });
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("postgres main store can write products and policies through a transaction-capable adapter", async () => {
  const { adapter, state } = createWriteCapableAdapter();
  const { app, tempDir } = createTestApp({
    mainStoreDriver: "postgres",
    postgresUrl: "postgres://rocksolid:secret@127.0.0.1:5432/rocksolid",
    postgresMainStoreAdapter: adapter
  });

  try {
    assert.equal(app.mainStore.driver, "postgres");
    assert.equal(app.mainStore.implementationStage, "core_write_preview");
    assert.deepEqual(app.mainStore.repositoryWriteDrivers, {
      products: "postgres",
      policies: "postgres",
      cards: "postgres",
      entitlements: "postgres",
      accounts: "postgres",
      devices: "postgres_partial",
      sessions: "sqlite"
    });

    const admin = app.services.adminLogin({
      username: "admin",
      password: "Pass123!abc"
    });

    const product = await app.services.createProduct(admin.token, {
      code: "PGWRITE",
      name: "PG Write Product",
      description: "Write-capable adapter",
      allowRegister: false,
      allowCardLogin: false
    });
    assert.equal(product.code, "PGWRITE");
    assert.equal(product.featureConfig.allowRegister, false);
    assert.equal(product.featureConfig.allowCardLogin, false);

    const createdAccount = await app.mainStore.accounts.createAccount(
      product,
      {
        username: "pgwriteuser",
        passwordHash: "hash_pgwriteuser"
      },
      "2026-01-10T00:00:00.000Z"
    );
    assert.equal(createdAccount.username, "pgwriteuser");
    assert.equal(createdAccount.status, "active");

    const touchedAccount = await app.mainStore.accounts.touchAccountLastLogin(
      createdAccount.id,
      "2026-01-11T00:00:00.000Z"
    );
    assert.equal(touchedAccount.last_login_at, "2026-01-11T00:00:00.000Z");

    const disabledAccount = await app.mainStore.accounts.updateAccountStatus(
      createdAccount.id,
      "disabled",
      "2026-01-12T00:00:00.000Z"
    );
    assert.equal(disabledAccount.status, "disabled");
    assert.equal(disabledAccount.username, "pgwriteuser");

    const cardLoginAccount = await app.mainStore.accounts.createCardLoginAccount(
      product,
      {
        id: "card_login_pg_1",
        card_key: "PGWRITE-LOGIN-0001"
      },
      "2026-01-13T00:00:00.000Z"
    );
    assert.match(cardLoginAccount.username, /^card_pgwrite_/);

    const featureUpdated = await app.services.updateProductFeatureConfig(admin.token, product.id, {
      allowRegister: true,
      allowCardRecharge: false
    });
    assert.equal(featureUpdated.featureConfig.allowRegister, true);
    assert.equal(featureUpdated.featureConfig.allowCardRecharge, false);

    const policy = await app.services.createPolicy(admin.token, {
      productCode: "PGWRITE",
      name: "PG Write Policy",
      durationDays: 15,
      maxDevices: 2,
      allowConcurrentSessions: true,
      bindMode: "selected_fields",
      bindFields: ["machineGuid"],
      allowClientUnbind: true,
      clientUnbindLimit: 2,
      grantType: "points",
      grantPoints: 9
    });
    assert.equal(policy.productCode, "PGWRITE");
    assert.equal(policy.grantType, "points");

    const runtimeUpdated = await app.services.updatePolicyRuntimeConfig(admin.token, policy.id, {
      allowConcurrentSessions: false,
      bindFields: ["machineGuid", "requestIp"]
    });
    assert.equal(runtimeUpdated.allowConcurrentSessions, false);
    assert.deepEqual(runtimeUpdated.bindFields, ["machineGuid", "requestIp"]);

    const unbindUpdated = await app.services.updatePolicyUnbindConfig(admin.token, policy.id, {
      allowClientUnbind: false,
      clientUnbindLimit: 0,
      clientUnbindWindowDays: 7,
      clientUnbindDeductDays: 0
    });
    assert.equal(unbindUpdated.allowClientUnbind, false);
    assert.equal(unbindUpdated.clientUnbindWindowDays, 7);

    const listedProducts = await app.services.listProducts(admin.token);
    assert.equal(listedProducts.some((item) => item.code === "PGWRITE"), true);

    const listedPolicies = await app.services.listPolicies(admin.token, { productCode: "PGWRITE" });
    assert.equal(listedPolicies.length, 1);
    assert.equal(listedPolicies[0].grantType, "points");
    assert.equal(listedPolicies[0].allowClientUnbind, false);

    const health = await app.services.health();
    assert.equal(health.storage.mainStore.implementationStage, "core_write_preview");
    assert.deepEqual(health.storage.mainStore.repositoryWriteDrivers, {
      products: "postgres",
      policies: "postgres",
      cards: "postgres",
      entitlements: "postgres",
      accounts: "postgres",
      devices: "postgres_partial",
      sessions: "sqlite"
    });

    assert.equal(state.products.length, 1);
    assert.equal(state.policies.length, 1);
    assert.equal(state.customerAccounts.length, 2);
    assert.equal(state.cardLoginAccounts.length, 1);
    state.deviceBindings.push({
      id: "bind_pg_write_1",
      entitlement_id: "ent_pg_write_1",
      device_id: "dev_pg_write_1",
      status: "active",
      first_bound_at: "2026-01-13T00:00:00.000Z",
      last_bound_at: "2026-01-13T00:00:00.000Z",
      revoked_at: null
    });

    const releasedBinding = await app.mainStore.devices.releaseBinding(
      "bind_pg_write_1",
      "2026-01-14T00:00:00.000Z"
    );
    assert.equal(releasedBinding.status, "revoked");
    assert.equal(releasedBinding.revoked_at, "2026-01-14T00:00:00.000Z");

    const unbindLog = await app.mainStore.devices.recordEntitlementUnbind(
      "ent_pg_write_1",
      "bind_pg_write_1",
      "client",
      createdAccount.id,
      "pg_preview_unbind",
      1,
      "2026-01-14T00:05:00.000Z"
    );
    assert.equal(unbindLog.binding_id, "bind_pg_write_1");

    const recentClientUnbinds = await app.mainStore.devices.countRecentClientUnbinds(
      app.db,
      "ent_pg_write_1",
      30,
      "2026-01-15T00:00:00.000Z"
    );
    assert.equal(recentClientUnbinds, 1);

    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "createProduct"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "createPolicy"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "updatePolicyRuntimeConfig"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "createAccount"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "touchAccountLastLogin"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "updateAccountStatus"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "createCardLoginAccount"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "linkCardLoginAccount"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "releaseBinding"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "recordEntitlementUnbind"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "countRecentClientUnbinds"),
      true
    );
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("postgres main store can write cards and entitlements through a transaction-capable adapter", async () => {
  const { adapter, state } = createWriteCapableAdapter();
  const { app, tempDir } = createTestApp({
    mainStoreDriver: "postgres",
    postgresUrl: "postgres://rocksolid:secret@127.0.0.1:5432/rocksolid",
    postgresMainStoreAdapter: adapter
  });

  try {
    const admin = app.services.adminLogin({
      username: "admin",
      password: "Pass123!abc"
    });

    const product = await app.services.createProduct(admin.token, {
      code: "PGCARD",
      name: "PG Card Product"
    });
    const policy = await app.services.createPolicy(admin.token, {
      productCode: "PGCARD",
      name: "PG Card Policy",
      durationDays: 30,
      maxDevices: 1,
      grantType: "points",
      grantPoints: 5
    });

    const batch = await app.services.createCardBatch(admin.token, {
      productCode: "PGCARD",
      policyId: policy.id,
      count: 1,
      prefix: "PGCARD"
    });
    assert.equal(batch.count, 1);
    assert.equal(batch.keys.length, 1);

    const cards = await app.services.listCards(admin.token, { productCode: "PGCARD" });
    assert.equal(cards.items.length, 1);

    const frozenCard = await app.services.updateCardStatus(admin.token, cards.items[0].id, {
      status: "frozen",
      notes: "Freeze from postgres preview"
    });
    assert.equal(frozenCard.displayStatus, "frozen");
    assert.equal(frozenCard.effectiveControlStatus, "frozen");

    state.customerAccounts.push({
      id: "acct_pg_cards",
      product_id: product.id,
      username: "pg-card-user"
    });
    state.entitlements.push({
      id: "ent_pg_cards",
      product_id: product.id,
      policy_id: policy.id,
      account_id: "acct_pg_cards",
      source_license_key_id: cards.items[0].id,
      status: "active",
      starts_at: "2026-01-01T00:00:00.000Z",
      ends_at: "2026-02-01T00:00:00.000Z",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z"
    });
    state.entitlementMetering.set("ent_pg_cards", {
      entitlement_id: "ent_pg_cards",
      grant_type: "points",
      total_points: 5,
      remaining_points: 5,
      consumed_points: 0,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z"
    });

    const entitlements = await app.services.listEntitlements(admin.token, { productCode: "PGCARD" });
    assert.equal(entitlements.items.length, 1);
    assert.equal(entitlements.items[0].username, "pg-card-user");

    const frozenEntitlement = await app.services.updateEntitlementStatus(admin.token, "ent_pg_cards", {
      status: "frozen"
    });
    assert.equal(frozenEntitlement.status, "frozen");

    const extendedEntitlement = await app.services.extendEntitlement(admin.token, "ent_pg_cards", {
      days: 5
    });
    assert.equal(extendedEntitlement.addedDays, 5);

    const adjustedEntitlement = await app.services.adjustEntitlementPoints(admin.token, "ent_pg_cards", {
      mode: "add",
      points: 2
    });
    assert.equal(adjustedEntitlement.totalPoints, 7);
    assert.equal(adjustedEntitlement.remainingPoints, 7);

    const health = await app.services.health();
    assert.equal(health.storage.mainStore.implementationStage, "core_write_preview");
    assert.deepEqual(health.storage.mainStore.repositoryWriteDrivers, {
      products: "postgres",
      policies: "postgres",
      cards: "postgres",
      entitlements: "postgres",
      accounts: "postgres",
      devices: "postgres_partial",
      sessions: "sqlite"
    });

    assert.equal(state.licenseKeys.length, 1);
    assert.equal(state.entitlements.length, 1);
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "createCard"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "updateEntitlementStatus"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "upsertEntitlementMetering"),
      true
    );
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
