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
    policyGrantConfigs: new Map()
  };

  function productRows(filters = {}) {
    return state.products
      .filter((product) => !filters.productId || product.id === filters.productId)
      .filter((product) => !filters.productCode || product.code === filters.productCode)
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
      ["products", "policies", "cards", "entitlements"]
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
      ["products", "policies", "cards", "entitlements"]
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
            product_code: "PGAPP",
            product_name: "Postgres Product",
            account_id: "acct_pg_1",
            username: "pguser",
            policy_id: "policy_pg_1",
            policy_name: "PG Policy",
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
      entitlements: "postgres"
    });
    assert.deepEqual(app.mainStore.repositoryWriteDrivers, {
      products: "sqlite",
      policies: "sqlite",
      cards: "sqlite",
      entitlements: "sqlite"
    });

    const admin = app.services.adminLogin({
      username: "admin",
      password: "Pass123!abc"
    });

    const products = await app.services.listProducts(admin.token);
    assert.equal(products.length, 1);
    assert.equal(products[0].code, "PGAPP");
    assert.equal(products[0].ownerDeveloper.username, "pgdev");

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

    assert.equal(queries.length, 5);
    assert.equal(queries[0].meta.repository, "products");
    assert.match(queries[0].sql, /FROM products p/i);
    assert.equal(queries[1].meta.repository, "policies");
    assert.match(queries[1].sql, /FROM policies p/i);
    assert.equal(queries[2].meta.repository, "cards");
    assert.match(queries[2].sql, /FROM license_keys lk/i);
    assert.equal(queries[3].meta.repository, "cards");
    assert.match(queries[3].sql, /WHERE lk\.id = \$1/i);
    assert.equal(queries[4].meta.repository, "entitlements");
    assert.match(queries[4].sql, /FROM entitlements e/i);

    const health = await app.services.health();
    assert.equal(health.storage.mainStore.driver, "postgres");
    assert.equal(health.storage.mainStore.implementationStage, "read_side_preview");
    assert.equal(health.storage.mainStore.adapterReady, true);
    assert.deepEqual(health.storage.mainStore.repositoryDrivers, {
      products: "postgres",
      policies: "postgres",
      cards: "postgres",
      entitlements: "postgres"
    });
    assert.deepEqual(health.storage.mainStore.repositoryWriteDrivers, {
      products: "sqlite",
      policies: "sqlite",
      cards: "sqlite",
      entitlements: "sqlite"
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
    assert.equal(app.mainStore.implementationStage, "product_policy_write_preview");
    assert.deepEqual(app.mainStore.repositoryWriteDrivers, {
      products: "postgres",
      policies: "postgres",
      cards: "sqlite",
      entitlements: "sqlite"
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
    assert.equal(health.storage.mainStore.implementationStage, "product_policy_write_preview");
    assert.deepEqual(health.storage.mainStore.repositoryWriteDrivers, {
      products: "postgres",
      policies: "postgres",
      cards: "sqlite",
      entitlements: "sqlite"
    });

    assert.equal(state.products.length, 1);
    assert.equal(state.policies.length, 1);
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
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
