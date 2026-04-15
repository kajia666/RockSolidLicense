import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { signClientRequest } from "../src/security.js";

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

async function startHttpApp(app) {
  await app.listen();
  const address = app.server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function postJson(baseUrl, requestPath, body, token = null) {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json.data;
}

let signedClientNonceCounter = 0;

async function callSignedClientService(app, product, routePath, serviceMethod, payload, meta = {}) {
  const body = JSON.stringify(payload);
  const timestamp = new Date(Date.now() + signedClientNonceCounter).toISOString();
  const nonce = `pg-preview-${signedClientNonceCounter += 1}`;
  const signature = signClientRequest(product.sdkAppSecret, {
    method: "POST",
    path: routePath,
    timestamp,
    nonce,
    body
  });

  return app.services[serviceMethod](
    {
      method: "POST",
      path: routePath,
      headers: {
        "x-rs-app-id": product.sdkAppId,
        "x-rs-timestamp": timestamp,
        "x-rs-nonce": nonce,
        "x-rs-signature": signature
      }
    },
    payload,
    body,
    meta
  );
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
    clientVersions: [],
    notices: [],
    networkRules: [],
    licenseKeys: [],
    licenseKeyControls: new Map(),
    customerAccounts: [],
    cardLoginAccounts: [],
    devices: [],
    deviceBlocks: [],
    deviceBindings: [],
    deviceBindingProfiles: new Map(),
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

  function deviceRows(filters = {}) {
    return state.devices
      .filter((device) => !filters.deviceId || device.id === filters.deviceId)
      .filter((device) => !filters.productId || device.product_id === filters.productId)
      .filter((device) => !filters.fingerprint || device.fingerprint === filters.fingerprint)
      .map((device) => ({ ...device }));
  }

  function bindingRows(filters = {}) {
    return state.deviceBindings
      .filter((binding) => !filters.bindingId || binding.id === filters.bindingId)
      .filter((binding) => !filters.entitlementId || binding.entitlement_id === filters.entitlementId)
      .filter((binding) => !filters.deviceId || binding.device_id === filters.deviceId)
      .map((binding) => {
        const entitlement = state.entitlements.find((item) => item.id === binding.entitlement_id);
        const device = state.devices.find((item) => item.id === binding.device_id);
        const product = state.products.find((item) => item.id === entitlement?.product_id);
        const account = state.customerAccounts.find((item) => item.id === entitlement?.account_id);
        const policy = state.policies.find((item) => item.id === entitlement?.policy_id);
        const profile = state.deviceBindingProfiles.get(binding.id);
        const activeSessionCount = state.sessions.filter((session) =>
          session.status === "active"
          && session.entitlement_id === binding.entitlement_id
          && session.device_id === binding.device_id
        ).length;

        return {
          ...binding,
          product_id: product?.id ?? null,
          product_code: product?.code ?? null,
          product_name: product?.name ?? null,
          owner_developer_id: product?.owner_developer_id ?? null,
          account_id: account?.id ?? null,
          username: account?.username ?? null,
          policy_name: policy?.name ?? null,
          entitlement_ends_at: entitlement?.ends_at ?? null,
          fingerprint: device?.fingerprint ?? null,
          device_name: device?.device_name ?? null,
          last_seen_at: device?.last_seen_at ?? null,
          last_seen_ip: device?.last_seen_ip ?? null,
          identity_hash: profile?.identity_hash ?? null,
          match_fields_json: profile?.match_fields_json ?? null,
          identity_json: profile?.identity_json ?? null,
          request_ip: profile?.request_ip ?? null,
          bind_request_ip: profile?.request_ip ?? null,
          active_session_count: activeSessionCount
        };
      });
  }

  function deviceBlockRows(filters = {}) {
    return state.deviceBlocks
      .filter((block) => !filters.blockId || block.id === filters.blockId)
      .filter((block) => !filters.productId || block.product_id === filters.productId)
      .filter((block) => !filters.fingerprint || block.fingerprint === filters.fingerprint)
      .map((block) => {
        const product = state.products.find((item) => item.id === block.product_id);
        const device = state.devices.find((item) =>
          item.product_id === block.product_id && item.fingerprint === block.fingerprint
        );
        const activeSessionCount = device
          ? state.sessions.filter((session) => session.status === "active" && session.device_id === device.id).length
          : 0;

        return {
          ...block,
          product_code: product?.code ?? null,
          product_name: product?.name ?? null,
          owner_developer_id: product?.owner_developer_id ?? null,
          device_id: device?.id ?? null,
          device_name: device?.device_name ?? null,
          last_seen_at: device?.last_seen_at ?? null,
          last_seen_ip: device?.last_seen_ip ?? null,
          active_session_count: activeSessionCount
        };
      });
  }

  function versionRows(filters = {}) {
    const normalizedSearch = String(filters.search ?? "").trim().toLowerCase();

    return state.clientVersions
      .filter((version) => !filters.versionId || version.id === filters.versionId)
      .filter((version) => !filters.productIds || filters.productIds.includes(version.product_id))
      .map((version) => {
        const product = state.products.find((item) => item.id === version.product_id);
        return {
          ...version,
          product_code: product?.code ?? null,
          product_name: product?.name ?? null,
          owner_developer_id: product?.owner_developer_id ?? null
        };
      })
      .filter((version) => !filters.productCode || version.product_code === filters.productCode)
      .filter((version) => !filters.ownerDeveloperId || version.owner_developer_id === filters.ownerDeveloperId)
      .filter((version) => !filters.channel || version.channel === filters.channel)
      .filter((version) => !filters.status || version.status === filters.status)
      .filter((version) => {
        if (!normalizedSearch) {
          return true;
        }
        return String(version.version ?? "").toLowerCase().includes(normalizedSearch)
          || String(version.notice_title ?? "").toLowerCase().includes(normalizedSearch)
          || String(version.release_notes ?? "").toLowerCase().includes(normalizedSearch);
      })
      .sort((left, right) => {
        const productOrder = String(left.product_code ?? "").localeCompare(String(right.product_code ?? ""));
        if (productOrder !== 0) {
          return productOrder;
        }
        const channelOrder = String(left.channel ?? "").localeCompare(String(right.channel ?? ""));
        if (channelOrder !== 0) {
          return channelOrder;
        }
        const releasedOrder = String(right.released_at ?? "").localeCompare(String(left.released_at ?? ""));
        return releasedOrder || String(right.created_at ?? "").localeCompare(String(left.created_at ?? ""));
      });
  }

  function noticeRows(filters = {}) {
    const normalizedSearch = String(filters.search ?? "").trim().toLowerCase();

    return state.notices
      .filter((notice) => !filters.noticeId || notice.id === filters.noticeId)
      .filter((notice) => !filters.productIds || filters.productIds.includes(notice.product_id))
      .map((notice) => {
        const product = state.products.find((item) => item.id === notice.product_id);
        return {
          ...notice,
          product_code: product?.code ?? null,
          product_name: product?.name ?? null,
          owner_developer_id: product?.owner_developer_id ?? null
        };
      })
      .filter((notice) => !filters.productCode || notice.product_code === filters.productCode)
      .filter((notice) => !filters.ownerDeveloperId || notice.owner_developer_id === filters.ownerDeveloperId)
      .filter((notice) => !filters.channel || filters.channel === "all" || notice.channel === filters.channel)
      .filter((notice) => !filters.kind || notice.kind === filters.kind)
      .filter((notice) => !filters.status || notice.status === filters.status)
      .filter((notice) => {
        if (!normalizedSearch) {
          return true;
        }
        return String(notice.title ?? "").toLowerCase().includes(normalizedSearch)
          || String(notice.body ?? "").toLowerCase().includes(normalizedSearch)
          || String(notice.product_code ?? "").toLowerCase().includes(normalizedSearch);
      })
      .sort((left, right) => {
        const startsOrder = String(right.starts_at ?? "").localeCompare(String(left.starts_at ?? ""));
        return startsOrder || String(right.created_at ?? "").localeCompare(String(left.created_at ?? ""));
      });
  }

  function networkRuleRows(filters = {}) {
    const normalizedSearch = String(filters.search ?? "").trim().toLowerCase();

    return state.networkRules
      .filter((rule) => !filters.ruleId || rule.id === filters.ruleId)
      .filter((rule) => !filters.productIds || filters.productIds.includes(rule.product_id))
      .map((rule) => {
        const product = state.products.find((item) => item.id === rule.product_id);
        return {
          ...rule,
          product_code: product?.code ?? null,
          product_name: product?.name ?? null,
          owner_developer_id: product?.owner_developer_id ?? null
        };
      })
      .filter((rule) => !filters.productCode || rule.product_code === filters.productCode)
      .filter((rule) => !filters.actionScope || rule.action_scope === filters.actionScope)
      .filter((rule) => !filters.status || rule.status === filters.status)
      .filter((rule) => {
        if (!normalizedSearch) {
          return true;
        }
        return String(rule.pattern ?? "").toLowerCase().includes(normalizedSearch)
          || String(rule.notes ?? "").toLowerCase().includes(normalizedSearch)
          || String(rule.product_code ?? "").toLowerCase().includes(normalizedSearch);
      })
      .sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")));
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

    if (meta.repository === "policies" && meta.operation === "countPoliciesByProductIds") {
      const counts = new Map();
      for (const policy of state.policies) {
        if (Array.isArray(meta.productIds) && meta.productIds.length && !meta.productIds.includes(policy.product_id)) {
          continue;
        }
        counts.set(policy.product_id, (counts.get(policy.product_id) ?? 0) + 1);
      }
      return Array.from(counts.entries()).map(([productId, count]) => ({
        product_id: productId,
        count
      }));
    }

    if (meta.repository === "versions" && meta.operation === "assertClientVersionAvailable") {
      return state.clientVersions
        .filter((version) =>
          version.product_id === params[0]
          && version.channel === params[1]
          && version.version === params[2]
        )
        .slice(0, 1)
        .map((version) => ({ id: version.id }));
    }

    if (meta.repository === "versions" && meta.operation === "createClientVersion") {
      state.clientVersions.push({
        id: params[0],
        product_id: params[1],
        channel: params[2],
        version: params[3],
        status: params[4],
        force_update: params[5],
        download_url: params[6],
        release_notes: params[7],
        notice_title: params[8],
        notice_body: params[9],
        released_at: params[10],
        created_at: params[11],
        updated_at: params[12]
      });
      return [];
    }

    if (meta.repository === "versions" && meta.operation === "updateClientVersionStatus") {
      const version = state.clientVersions.find((item) => item.id === params[3]);
      if (version) {
        version.status = params[0];
        version.force_update = params[1];
        version.updated_at = params[2];
      }
      return [];
    }

    if (meta.repository === "versions" && meta.operation === "listProductVersions") {
      return versionRows({ productIds: [params[0]], channel: params[1] });
    }

    if (meta.repository === "versions" && meta.operation === "queryClientVersionRows") {
      return versionRows(meta.filters ?? {});
    }

    if (meta.repository === "versions" && meta.operation === "getClientVersionRowById") {
      return versionRows({ versionId: params[0] }).slice(0, 1);
    }

    if (meta.repository === "versions" && meta.operation === "countActiveVersionsByProductIds") {
      const counts = new Map();
      for (const version of state.clientVersions) {
        if (version.status !== "active") {
          continue;
        }
        if (Array.isArray(meta.productIds) && meta.productIds.length && !meta.productIds.includes(version.product_id)) {
          continue;
        }
        counts.set(version.product_id, (counts.get(version.product_id) ?? 0) + 1);
      }
      return Array.from(counts.entries()).map(([productId, count]) => ({
        product_id: productId,
        count
      }));
    }

    if (meta.repository === "versions" && meta.operation === "countForceUpdateVersionsByProductIds") {
      const counts = new Map();
      for (const version of state.clientVersions) {
        if (version.status !== "active" || !version.force_update) {
          continue;
        }
        if (Array.isArray(meta.productIds) && meta.productIds.length && !meta.productIds.includes(version.product_id)) {
          continue;
        }
        counts.set(version.product_id, (counts.get(version.product_id) ?? 0) + 1);
      }
      return Array.from(counts.entries()).map(([productId, count]) => ({
        product_id: productId,
        count
      }));
    }

    if (meta.repository === "notices" && meta.operation === "createNotice") {
      state.notices.push({
        id: params[0],
        product_id: params[1],
        channel: params[2],
        kind: params[3],
        severity: params[4],
        title: params[5],
        body: params[6],
        action_url: params[7],
        status: params[8],
        block_login: params[9],
        starts_at: params[10],
        ends_at: params[11],
        created_at: params[12],
        updated_at: params[13]
      });
      return [];
    }

    if (meta.repository === "notices" && meta.operation === "updateNoticeStatus") {
      const notice = state.notices.find((item) => item.id === params[3]);
      if (notice) {
        notice.status = params[0];
        notice.block_login = params[1];
        notice.updated_at = params[2];
      }
      return [];
    }

    if (meta.repository === "notices" && meta.operation === "listActiveNoticesForProduct") {
      return noticeRows({})
        .filter((notice) => notice.status === "active")
        .filter((notice) => notice.starts_at <= params[0] && (!notice.ends_at || notice.ends_at > params[1]))
        .filter((notice) => notice.product_id === null || notice.product_id === params[2])
        .filter((notice) => notice.channel === "all" || notice.channel === params[3])
        .sort((left, right) => {
          const blockOrder = Number(right.block_login ?? 0) - Number(left.block_login ?? 0);
          if (blockOrder !== 0) {
            return blockOrder;
          }
          const startsOrder = String(right.starts_at ?? "").localeCompare(String(left.starts_at ?? ""));
          return startsOrder || String(right.created_at ?? "").localeCompare(String(left.created_at ?? ""));
        });
    }

    if (meta.repository === "notices" && meta.operation === "queryNoticeRows") {
      return noticeRows(meta.filters ?? {});
    }

    if (meta.repository === "notices" && meta.operation === "getNoticeRowById") {
      return noticeRows({ noticeId: params[0] }).slice(0, 1);
    }

    if (meta.repository === "notices" && meta.operation === "countActiveNoticesByProductIds") {
      const counts = new Map();
      for (const notice of state.notices) {
        if (!notice.product_id || notice.status !== "active") {
          continue;
        }
        if (!(notice.starts_at <= params[0] && (!notice.ends_at || notice.ends_at > params[1]))) {
          continue;
        }
        if (Array.isArray(meta.productIds) && meta.productIds.length && !meta.productIds.includes(notice.product_id)) {
          continue;
        }
        counts.set(notice.product_id, (counts.get(notice.product_id) ?? 0) + 1);
      }
      return Array.from(counts.entries()).map(([productId, count]) => ({
        product_id: productId,
        count
      }));
    }

    if (meta.repository === "notices" && meta.operation === "countBlockingNoticesByProductIds") {
      const counts = new Map();
      for (const notice of state.notices) {
        if (!notice.product_id || notice.status !== "active" || !notice.block_login) {
          continue;
        }
        if (!(notice.starts_at <= params[0] && (!notice.ends_at || notice.ends_at > params[1]))) {
          continue;
        }
        if (Array.isArray(meta.productIds) && meta.productIds.length && !meta.productIds.includes(notice.product_id)) {
          continue;
        }
        counts.set(notice.product_id, (counts.get(notice.product_id) ?? 0) + 1);
      }
      return Array.from(counts.entries()).map(([productId, count]) => ({
        product_id: productId,
        count
      }));
    }

    if (meta.repository === "networkRules" && meta.operation === "createNetworkRule") {
      state.networkRules.push({
        id: params[0],
        product_id: params[1],
        target_type: params[2],
        pattern: params[3],
        action_scope: params[4],
        decision: params[5],
        status: params[6],
        notes: params[7],
        created_at: params[8],
        updated_at: params[9]
      });
      return [];
    }

    if (meta.repository === "networkRules" && meta.operation === "updateNetworkRuleStatus") {
      const rule = state.networkRules.find((item) => item.id === params[2]);
      if (rule) {
        rule.status = params[0];
        rule.updated_at = params[1];
      }
      return [];
    }

    if (meta.repository === "networkRules" && meta.operation === "queryNetworkRuleRows") {
      return networkRuleRows(meta.filters ?? {});
    }

    if (meta.repository === "networkRules" && meta.operation === "getNetworkRuleRowById") {
      return networkRuleRows({ ruleId: params[0] }).slice(0, 1);
    }

    if (meta.repository === "networkRules" && meta.operation === "listBlockingNetworkRulesForProduct") {
      return networkRuleRows({})
        .filter((rule) => rule.status === "active")
        .filter((rule) => rule.decision === "block")
        .filter((rule) => rule.product_id === null || rule.product_id === params[0])
        .filter((rule) => rule.action_scope === "all" || rule.action_scope === params[1])
        .sort((left, right) => {
          const globalOrder = Number(left.product_id === null) - Number(right.product_id === null);
          return globalOrder || String(right.created_at ?? "").localeCompare(String(left.created_at ?? ""));
        });
    }

    if (meta.repository === "networkRules" && meta.operation === "countActiveNetworkRulesByProductIds") {
      const counts = new Map();
      for (const rule of state.networkRules) {
        if (!rule.product_id || rule.status !== "active") {
          continue;
        }
        if (Array.isArray(meta.productIds) && meta.productIds.length && !meta.productIds.includes(rule.product_id)) {
          continue;
        }
        counts.set(rule.product_id, (counts.get(rule.product_id) ?? 0) + 1);
      }
      return Array.from(counts.entries()).map(([productId, count]) => ({
        product_id: productId,
        count
      }));
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

    if (meta.repository === "cards" && meta.operation === "countCardsByProductIds") {
      const counts = new Map();
      for (const card of state.licenseKeys) {
        if (Array.isArray(meta.productIds) && meta.productIds.length && !meta.productIds.includes(card.product_id)) {
          continue;
        }
        if (meta.usageStatus && card.status !== meta.usageStatus) {
          continue;
        }
        counts.set(card.product_id, (counts.get(card.product_id) ?? 0) + 1);
      }
      return Array.from(counts.entries()).map(([productId, count]) => ({
        product_id: productId,
        count
      }));
    }

    if (meta.repository === "entitlements" && meta.operation === "loadEntitlementManageRow") {
      return entitlementRows({ entitlementId: params[0] }).slice(0, 1);
    }

    if (meta.repository === "entitlements" && meta.operation === "loadLatestEntitlementEndsAtByPolicy") {
      return state.entitlements
        .filter((entitlement) => entitlement.account_id === params[0])
        .filter((entitlement) => entitlement.product_id === params[1])
        .filter((entitlement) => entitlement.policy_id === params[2])
        .sort((left, right) => String(right.ends_at).localeCompare(String(left.ends_at)))
        .slice(0, 1)
        .map((entitlement) => ({ ends_at: entitlement.ends_at }));
    }

    if (meta.repository === "entitlements" && meta.operation === "createEntitlement") {
      state.entitlements.push({
        id: params[0],
        product_id: params[1],
        policy_id: params[2],
        account_id: params[3],
        source_license_key_id: params[4],
        status: "active",
        starts_at: params[5],
        ends_at: params[6],
        created_at: params[7],
        updated_at: params[8]
      });
      return [];
    }

    if (meta.repository === "entitlements" && meta.operation === "markCardRedeemed") {
      const card = state.licenseKeys.find((item) => item.id === params[2]);
      if (card) {
        card.status = "redeemed";
        card.redeemed_at = params[0];
        card.redeemed_by_account_id = params[1];
      }
      return [];
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

    if (meta.repository === "entitlements" && meta.operation === "countActiveEntitlementsByProductIds") {
      const counts = new Map();
      const referenceTime = params[0] ?? meta.referenceTime ?? "9999-12-31T23:59:59.999Z";
      for (const entitlement of state.entitlements) {
        if (entitlement.status !== "active" || String(entitlement.ends_at ?? "") <= referenceTime) {
          continue;
        }
        if (Array.isArray(meta.productIds) && meta.productIds.length && !meta.productIds.includes(entitlement.product_id)) {
          continue;
        }
        counts.set(entitlement.product_id, (counts.get(entitlement.product_id) ?? 0) + 1);
      }
      return Array.from(counts.entries()).map(([productId, count]) => ({
        product_id: productId,
        count
      }));
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

    if (meta.repository === "accounts" && meta.operation === "countAccountsByProductIds") {
      const counts = new Map();
      for (const account of state.customerAccounts) {
        if (Array.isArray(meta.productIds) && meta.productIds.length && !meta.productIds.includes(account.product_id)) {
          continue;
        }
        if (meta.status && account.status !== meta.status) {
          continue;
        }
        counts.set(account.product_id, (counts.get(account.product_id) ?? 0) + 1);
      }
      return Array.from(counts.entries()).map(([productId, count]) => ({
        product_id: productId,
        count
      }));
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

    if (meta.repository === "devices" && meta.operation === "loadDeviceByFingerprint") {
      return deviceRows({ productId: params[0], fingerprint: params[1] }).slice(0, 1);
    }

    if (meta.repository === "devices" && meta.operation === "getDeviceRecordByFingerprint") {
      return deviceRows({ productId: params[0], fingerprint: params[1] }).slice(0, 1);
    }

    if (meta.repository === "devices" && meta.operation === "createDevice") {
      state.devices.push({
        id: params[0],
        product_id: params[1],
        fingerprint: params[2],
        device_name: params[3],
        first_seen_at: params[4],
        last_seen_at: params[5],
        last_seen_ip: params[6],
        metadata_json: params[7]
      });
      return [];
    }

    if (meta.repository === "devices" && meta.operation === "updateDevice") {
      const device = state.devices.find((item) => item.id === params[4]);
      if (device) {
        device.device_name = params[0];
        device.last_seen_at = params[1];
        device.last_seen_ip = params[2];
        device.metadata_json = params[3];
      }
      return [];
    }

    if (meta.repository === "devices" && meta.operation === "loadDeviceRecordById") {
      return deviceRows({ deviceId: params[0] }).slice(0, 1);
    }

    if (meta.repository === "devices" && meta.operation === "loadDeviceBlockByProductFingerprint") {
      return deviceBlockRows({ productId: params[0], fingerprint: params[1] })
        .slice(0, 1)
        .map((block) => ({
          id: block.id,
          product_id: block.product_id,
          fingerprint: block.fingerprint,
          status: block.status,
          reason: block.reason,
          notes: block.notes,
          created_at: block.created_at,
          updated_at: block.updated_at,
          released_at: block.released_at
        }));
    }

    if (meta.repository === "devices" && meta.operation === "createDeviceBlock") {
      state.deviceBlocks.push({
        id: params[0],
        product_id: params[1],
        fingerprint: params[2],
        status: "active",
        reason: params[3],
        notes: params[4],
        created_at: params[5],
        updated_at: params[6],
        released_at: null
      });
      return [];
    }

    if (meta.repository === "devices" && meta.operation === "updateDeviceBlock") {
      const block = state.deviceBlocks.find((item) => item.id === params[3]);
      if (block) {
        block.status = "active";
        block.reason = params[0];
        block.notes = params[1];
        block.updated_at = params[2];
        block.released_at = null;
      }
      return [];
    }

    if (meta.repository === "devices" && meta.operation === "loadDeviceBlockRecordById") {
      return deviceBlockRows({ blockId: params[0] })
        .slice(0, 1)
        .map((block) => ({
          id: block.id,
          product_id: block.product_id,
          fingerprint: block.fingerprint,
          status: block.status,
          reason: block.reason,
          notes: block.notes,
          created_at: block.created_at,
          updated_at: block.updated_at,
          released_at: block.released_at
        }));
    }

    if (meta.repository === "devices" && meta.operation === "getDeviceBlockManageRowById") {
      return deviceBlockRows({ blockId: params[0] })
        .slice(0, 1)
        .map((block) => ({
          id: block.id,
          product_id: block.product_id,
          fingerprint: block.fingerprint,
          status: block.status,
          reason: block.reason,
          notes: block.notes,
          created_at: block.created_at,
          updated_at: block.updated_at,
          released_at: block.released_at,
          product_code: block.product_code,
          owner_developer_id: block.owner_developer_id,
          device_id: block.device_id,
          device_name: block.device_name,
          last_seen_at: block.last_seen_at,
          last_seen_ip: block.last_seen_ip
        }));
    }

    if (meta.repository === "devices" && meta.operation === "loadBindingByEntitlementDevice") {
      return bindingRows({ entitlementId: params[0], deviceId: params[1] }).slice(0, 1);
    }

    if (meta.repository === "devices" && meta.operation === "loadBindingByIdentityHash") {
      return bindingRows({ entitlementId: params[0] })
        .filter((binding) => binding.identity_hash === params[1])
        .slice(0, 1)
        .map((binding) => ({
          id: binding.id,
          entitlement_id: binding.entitlement_id,
          device_id: binding.device_id,
          status: binding.status,
          first_bound_at: binding.first_bound_at,
          last_bound_at: binding.last_bound_at,
          revoked_at: binding.revoked_at,
          identity_hash: binding.identity_hash
        }));
    }

    if (meta.repository === "devices" && meta.operation === "countActiveBindingsForEntitlement") {
      const count = state.deviceBindings.filter((binding) =>
        binding.entitlement_id === params[0] && binding.status === "active"
      ).length;
      return [{ count }];
    }

    if (meta.repository === "devices" && meta.operation === "touchBinding") {
      const binding = state.deviceBindings.find((item) => item.id === params[1]);
      if (binding) {
        binding.last_bound_at = params[0];
      }
      return [];
    }

    if (meta.repository === "devices" && meta.operation === "reactivateBinding") {
      const binding = state.deviceBindings.find((item) => item.id === params[1]);
      if (binding) {
        binding.status = "active";
        binding.revoked_at = null;
        binding.last_bound_at = params[0];
      }
      return [];
    }

    if (meta.repository === "devices" && meta.operation === "rebindIdentityMatch") {
      const binding = state.deviceBindings.find((item) => item.id === params[2]);
      if (binding) {
        binding.device_id = params[0];
        binding.status = "active";
        binding.revoked_at = null;
        binding.last_bound_at = params[1];
      }
      return [];
    }

    if (meta.repository === "devices" && meta.operation === "createBinding") {
      state.deviceBindings.push({
        id: params[0],
        entitlement_id: params[1],
        device_id: params[2],
        status: "active",
        first_bound_at: params[3],
        last_bound_at: params[4],
        revoked_at: null
      });
      return [];
    }

    if (meta.repository === "devices" && meta.operation === "selectActiveBindingsForDeviceRevoke") {
      return state.deviceBindings
        .filter((binding) => binding.device_id === params[0] && binding.status === "active")
        .map((binding) => ({ id: binding.id }));
    }

    if (meta.repository === "devices" && meta.operation === "revokeActiveBindingsByDevice") {
      for (const binding of state.deviceBindings) {
        if (binding.device_id === params[2] && binding.status === "active") {
          binding.status = "revoked";
          binding.revoked_at = params[0];
          binding.last_bound_at = params[1];
        }
      }
      return [];
    }

    if (meta.repository === "devices" && meta.operation === "upsertBindingProfile") {
      const existing = state.deviceBindingProfiles.get(params[0]);
      state.deviceBindingProfiles.set(params[0], {
        binding_id: params[0],
        entitlement_id: params[1],
        device_id: params[2],
        identity_hash: params[3],
        match_fields_json: params[4],
        identity_json: params[5],
        request_ip: params[6],
        created_at: existing?.created_at ?? params[7],
        updated_at: params[8]
      });
      return [];
    }

    if (meta.repository === "devices" && meta.operation === "queryBindingsForEntitlement") {
      return bindingRows({ entitlementId: params[0] }).sort((left, right) => {
        const activeOrder = Number(left.status !== "active") - Number(right.status !== "active");
        return activeOrder || String(right.last_bound_at ?? "").localeCompare(String(left.last_bound_at ?? ""));
      });
    }

    if (meta.repository === "devices" && meta.operation === "getBindingManageRowById") {
      return bindingRows({ bindingId: params[0] })
        .slice(0, 1)
        .map((binding) => ({
          id: binding.id,
          entitlement_id: binding.entitlement_id,
          device_id: binding.device_id,
          status: binding.status,
          product_id: binding.product_id,
          product_code: binding.product_code,
          owner_developer_id: binding.owner_developer_id,
          account_id: binding.account_id,
          username: binding.username,
          fingerprint: binding.fingerprint,
          device_name: binding.device_name
        }));
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

    if (meta.repository === "devices" && meta.operation === "releaseDeviceBlock") {
      const block = state.deviceBlocks.find((item) => item.id === params[2]);
      if (block) {
        block.status = "released";
        block.updated_at = params[0];
        block.released_at = params[1];
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

    if (meta.repository === "devices" && meta.operation === "countReleasedBindingsByProductIds") {
      const counts = new Map();
      for (const binding of state.deviceBindings) {
        if (binding.status !== "revoked") {
          continue;
        }

        const productId = state.entitlements.find((entitlement) => entitlement.id === binding.entitlement_id)?.product_id;
        if (!productId) {
          continue;
        }

        if (Array.isArray(meta.productIds) && meta.productIds.length && !meta.productIds.includes(productId)) {
          continue;
        }

        counts.set(productId, (counts.get(productId) ?? 0) + 1);
      }

      return Array.from(counts.entries()).map(([productId, count]) => ({
        product_id: productId,
        count
      }));
    }

    if (meta.repository === "sessions" && meta.operation === "createIssuedSession") {
      state.sessions.push({
        id: params[0],
        product_id: params[1],
        account_id: params[2],
        entitlement_id: params[3],
        device_id: params[4],
        session_token: params[5],
        license_token: params[6],
        status: "active",
        issued_at: params[7],
        expires_at: params[8],
        last_heartbeat_at: params[9],
        last_seen_ip: params[10],
        user_agent: params[11],
        revoked_reason: null
      });
      return [];
    }

    if (meta.repository === "sessions" && meta.operation === "getSessionRecordById") {
      return state.sessions
        .filter((session) => session.id === params[0])
        .slice(0, 1)
        .map((session) => ({ ...session }));
    }

    if (meta.repository === "sessions" && meta.operation === "getSessionRecordByToken") {
      return state.sessions
        .filter((session) => session.session_token === params[0])
        .slice(0, 1)
        .map((session) => ({ ...session }));
    }

    if (meta.repository === "sessions" && meta.operation === "listActiveSessionExpiryRows") {
      return state.sessions
        .filter((session) => session.status === "active")
        .map((session) => ({
          id: session.id,
          session_token: session.session_token,
          expires_at: session.expires_at,
          last_heartbeat_at: session.last_heartbeat_at,
          heartbeat_timeout_seconds: 180
        }));
    }

    if (meta.repository === "sessions" && meta.operation === "countActiveSessionsByProductIds") {
      const counts = new Map();
      for (const session of state.sessions) {
        if (session.status !== "active") {
          continue;
        }

        if (Array.isArray(meta.productIds) && meta.productIds.length && !meta.productIds.includes(session.product_id)) {
          continue;
        }

        counts.set(session.product_id, (counts.get(session.product_id) ?? 0) + 1);
      }

      return Array.from(counts.entries()).map(([productId, count]) => ({
        product_id: productId,
        count
      }));
    }

    if (meta.repository === "sessions" && meta.operation === "selectActiveSessionsForExpiry") {
      return state.sessions
        .filter((session) => session.status === "active")
        .filter((session) => (
          (!meta.filters?.sessionId || session.id === meta.filters.sessionId)
          && (!meta.filters?.sessionToken || session.session_token === meta.filters.sessionToken)
          && (!meta.filters?.productId || session.product_id === meta.filters.productId)
          && (!meta.filters?.accountId || session.account_id === meta.filters.accountId)
          && (!meta.filters?.entitlementId || session.entitlement_id === meta.filters.entitlementId)
          && (!meta.filters?.deviceId || session.device_id === meta.filters.deviceId)
        ))
        .map((session) => ({
          id: session.id,
          session_token: session.session_token
        }));
    }

    if (meta.repository === "sessions" && meta.operation === "expireActiveSessions") {
      const reason = params[params.length - 1];
      for (const session of state.sessions) {
        if (session.status !== "active") {
          continue;
        }

        const matches = (
          (!meta.filters?.sessionId || session.id === meta.filters.sessionId)
          && (!meta.filters?.sessionToken || session.session_token === meta.filters.sessionToken)
          && (!meta.filters?.productId || session.product_id === meta.filters.productId)
          && (!meta.filters?.accountId || session.account_id === meta.filters.accountId)
          && (!meta.filters?.entitlementId || session.entitlement_id === meta.filters.entitlementId)
          && (!meta.filters?.deviceId || session.device_id === meta.filters.deviceId)
        );
        if (matches) {
          session.status = "expired";
          session.revoked_reason = reason;
        }
      }
      return [];
    }

    if (meta.repository === "sessions" && meta.operation === "touchSessionHeartbeat") {
      const session = state.sessions.find((item) => item.id === params[4] && item.status === "active");
      if (session) {
        session.last_heartbeat_at = params[0];
        session.expires_at = params[1];
        session.last_seen_ip = params[2];
        session.user_agent = params[3];
      }
      return [];
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
      ["products", "policies", "cards", "entitlements", "accounts", "versions", "notices", "networkRules", "devices", "sessions"]
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
      ["products", "policies", "cards", "entitlements", "accounts", "versions", "notices", "networkRules", "devices", "sessions"]
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

      if (meta.repository === "policies" && meta.operation === "countPoliciesByProductIds") {
        return [
          {
            product_id: "prod_pg_1",
            count: 1
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

      if (meta.repository === "cards" && meta.operation === "countCardsByProductIds") {
        if (meta.usageStatus === "redeemed") {
          return [];
        }
        return [
          {
            product_id: "prod_pg_1",
            count: 1
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

      if (meta.repository === "entitlements" && meta.operation === "countActiveEntitlementsByProductIds") {
        return [
          {
            product_id: "prod_pg_1",
            count: 1
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

      if (meta.repository === "accounts" && meta.operation === "countAccountsByProductIds") {
        if (meta.status === "disabled") {
          return [];
        }
        return [
          {
            product_id: "prod_pg_1",
            count: 1
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

      if (meta.repository === "versions" && meta.operation === "listProductVersions") {
        return [
          {
            id: "ver_pg_1",
            product_id: "prod_pg_1",
            channel: "stable",
            version: "2.0.0",
            status: "active",
            force_update: 1,
            download_url: "https://example.invalid/pgapp/2.0.0.zip",
            release_notes: "postgres release notes",
            notice_title: "PG Release",
            notice_body: "postgres runtime notice",
            released_at: "2026-01-10T00:00:00.000Z",
            created_at: "2026-01-10T00:00:00.000Z",
            updated_at: "2026-01-10T00:00:00.000Z"
          }
        ];
      }

      if (meta.repository === "versions" && meta.operation === "queryClientVersionRows") {
        return [
          {
            id: "ver_pg_1",
            channel: "stable",
            version: "2.0.0",
            status: "active",
            force_update: 1,
            download_url: "https://example.invalid/pgapp/2.0.0.zip",
            release_notes: "postgres release notes",
            notice_title: "PG Release",
            notice_body: "postgres runtime notice",
            released_at: "2026-01-10T00:00:00.000Z",
            created_at: "2026-01-10T00:00:00.000Z",
            updated_at: "2026-01-10T00:00:00.000Z",
            product_code: "PGAPP",
            product_name: "Postgres Product"
          }
        ];
      }

      if (meta.repository === "versions" && meta.operation === "countActiveVersionsByProductIds") {
        return [
          {
            product_id: "prod_pg_1",
            count: 1
          }
        ];
      }

      if (meta.repository === "versions" && meta.operation === "countForceUpdateVersionsByProductIds") {
        return [
          {
            product_id: "prod_pg_1",
            count: 1
          }
        ];
      }

      if (meta.repository === "notices" && meta.operation === "listActiveNoticesForProduct") {
        return [
          {
            id: "notice_pg_1",
            product_id: "prod_pg_1",
            product_code: "PGAPP",
            product_name: "Postgres Product",
            channel: "stable",
            kind: "maintenance",
            severity: "critical",
            title: "PG Maintenance",
            body: "postgres notice body",
            action_url: "https://example.invalid/pgapp/status",
            status: "active",
            block_login: 1,
            starts_at: "2026-01-10T00:00:00.000Z",
            ends_at: "2026-02-10T00:00:00.000Z",
            created_at: "2026-01-10T00:00:00.000Z",
            updated_at: "2026-01-10T00:00:00.000Z"
          }
        ];
      }

      if (meta.repository === "notices" && meta.operation === "queryNoticeRows") {
        return [
          {
            id: "notice_pg_1",
            product_id: "prod_pg_1",
            product_code: "PGAPP",
            product_name: "Postgres Product",
            channel: "stable",
            kind: "maintenance",
            severity: "critical",
            title: "PG Maintenance",
            body: "postgres notice body",
            action_url: "https://example.invalid/pgapp/status",
            status: "active",
            block_login: 1,
            starts_at: "2026-01-10T00:00:00.000Z",
            ends_at: "2026-02-10T00:00:00.000Z",
            created_at: "2026-01-10T00:00:00.000Z",
            updated_at: "2026-01-10T00:00:00.000Z"
          }
        ];
      }

      if (meta.repository === "notices" && meta.operation === "countActiveNoticesByProductIds") {
        return [
          {
            product_id: "prod_pg_1",
            count: 1
          }
        ];
      }

      if (meta.repository === "notices" && meta.operation === "countBlockingNoticesByProductIds") {
        return [
          {
            product_id: "prod_pg_1",
            count: 1
          }
        ];
      }

      if (meta.repository === "networkRules" && meta.operation === "queryNetworkRuleRows") {
        return [
          {
            id: "nrule_pg_1",
            product_id: "prod_pg_1",
            product_code: "PGAPP",
            product_name: "Postgres Product",
            target_type: "cidr",
            pattern: "10.0.0.0/24",
            action_scope: "login",
            decision: "block",
            status: "active",
            notes: "postgres network rule",
            created_at: "2026-01-10T00:00:00.000Z",
            updated_at: "2026-01-10T00:00:00.000Z"
          }
        ];
      }

      if (meta.repository === "networkRules" && meta.operation === "listBlockingNetworkRulesForProduct") {
        return [
          {
            id: "nrule_pg_1",
            product_id: "prod_pg_1",
            product_code: "PGAPP",
            target_type: "cidr",
            pattern: "10.0.0.0/24",
            action_scope: "login",
            decision: "block",
            status: "active",
            notes: "postgres network rule",
            created_at: "2026-01-10T00:00:00.000Z",
            updated_at: "2026-01-10T00:00:00.000Z"
          }
        ];
      }

      if (meta.repository === "networkRules" && meta.operation === "countActiveNetworkRulesByProductIds") {
        return [
          {
            product_id: "prod_pg_1",
            count: 1
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

      if (meta.repository === "devices" && meta.operation === "queryDeviceBindingRows") {
        return [
          {
            id: "bind_pg_1",
            entitlement_id: "ent_pg_1",
            device_id: "dev_pg_1",
            status: "active",
            first_bound_at: "2026-01-03T00:00:00.000Z",
            last_bound_at: "2026-01-04T00:00:00.000Z",
            revoked_at: null,
            product_id: "prod_pg_1",
            product_code: "PGAPP",
            product_name: "Postgres Product",
            account_id: "acct_pg_1",
            username: "pguser",
            policy_name: "PG Policy",
            entitlement_ends_at: "2026-02-01T00:00:00.000Z",
            fingerprint: "pg-device-001",
            device_name: "PG Desktop",
            last_seen_at: "2026-01-04T00:05:00.000Z",
            last_seen_ip: "203.0.113.9",
            identity_hash: "pg-device-hash-001",
            match_fields_json: "[\"deviceFingerprint\",\"machineGuid\"]",
            identity_json: "{\"machineGuid\":\"PG-MG-001\"}",
            bind_request_ip: "203.0.113.9",
            active_session_count: 1
          }
        ];
      }

      if (meta.repository === "devices" && meta.operation === "queryDeviceBlockRows") {
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
            released_at: null,
            product_code: "PGAPP",
            product_name: "Postgres Product",
            device_id: "dev_pg_1",
            device_name: "PG Desktop",
            last_seen_at: "2026-01-04T00:05:00.000Z",
            last_seen_ip: "203.0.113.9",
            active_session_count: 1
          }
        ];
      }

      if (meta.repository === "devices" && meta.operation === "countActiveBindingsByProductIds") {
        return [
          {
            product_id: "prod_pg_1",
            count: 1
          }
        ];
      }

      if (meta.repository === "devices" && meta.operation === "countReleasedBindingsByProductIds") {
        return [
          {
            product_id: "prod_pg_1",
            count: 1
          }
        ];
      }

      if (meta.repository === "devices" && meta.operation === "countActiveBlocksByProductIds") {
        return [
          {
            product_id: "prod_pg_1",
            count: 1
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

      if (meta.repository === "sessions" && meta.operation === "querySessionRows") {
        return [
          {
            id: "sess_pg_1",
            account_id: "acct_pg_1",
            entitlement_id: "ent_pg_1",
            device_id: "dev_pg_1",
            status: "active",
            issued_at: "2026-01-04T00:00:00.000Z",
            expires_at: "2026-01-04T01:00:00.000Z",
            last_heartbeat_at: "2026-01-04T00:10:00.000Z",
            last_seen_ip: "203.0.113.9",
            user_agent: "postgres-session-test",
            revoked_reason: null,
            product_id: "prod_pg_1",
            product_code: "PGAPP",
            product_name: "Postgres Product",
            username: "pguser",
            fingerprint: "pg-device-001",
            device_name: "PG Desktop",
            policy_name: "PG Policy"
          }
        ];
      }

      if (meta.repository === "sessions" && meta.operation === "countActiveSessionsByProductIds") {
        return [
          {
            product_id: "prod_pg_1",
            count: 1
          }
        ];
      }

      if (meta.repository === "sessions" && meta.operation === "listActiveSessionExpiryRows") {
        return [
          {
            id: "sess_pg_1",
            session_token: "session_pg_1",
            expires_at: "2026-01-04T01:00:00.000Z",
            last_heartbeat_at: "2026-01-04T00:10:00.000Z",
            heartbeat_timeout_seconds: 180
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
      versions: "postgres",
      notices: "postgres",
      networkRules: "postgres",
      devices: "postgres",
      sessions: "postgres"
    });
    assert.deepEqual(app.mainStore.repositoryWriteDrivers, {
      products: "sqlite",
      policies: "sqlite",
      cards: "sqlite",
      entitlements: "sqlite",
      accounts: "sqlite",
      versions: "sqlite",
      notices: "sqlite",
      networkRules: "sqlite",
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

    const activeSessionExpiryRows = await app.mainStore.sessions.listActiveSessionExpiryRows(app.db);
    assert.equal(activeSessionExpiryRows.length, 1);
    assert.equal(activeSessionExpiryRows[0].session_token, "session_pg_1");

    const sessionRows = await app.mainStore.sessions.querySessionRows(app.db, {
      productCode: "PGAPP",
      username: "pguser",
      status: "active"
    });
    assert.equal(sessionRows.total, 1);
    assert.equal(sessionRows.items[0].product_code, "PGAPP");
    assert.equal(sessionRows.items[0].policy_name, "PG Policy");

    const recentSessionRows = await app.mainStore.sessions.querySessionRows(app.db, {
      limit: 1,
      sortBy: "issuedAtDesc"
    });
    assert.equal(recentSessionRows.total, 1);
    assert.equal(recentSessionRows.items[0].id, "sess_pg_1");

    const activeSessionCounts = await app.mainStore.sessions.countActiveSessionsByProductIds(
      app.db,
      ["prod_pg_1"]
    );
    assert.equal(activeSessionCounts.length, 1);
    assert.equal(activeSessionCounts[0].product_id, "prod_pg_1");
    assert.equal(activeSessionCounts[0].count, 1);

    const bindingRows = await app.mainStore.devices.queryDeviceBindingRows(app.db, {
      productCode: "PGAPP",
      username: "pguser",
      status: "active"
    });
    assert.equal(bindingRows.total, 1);
    assert.equal(bindingRows.items[0].product_code, "PGAPP");
    assert.equal(bindingRows.items[0].bindRequestIp, "203.0.113.9");
    assert.deepEqual(bindingRows.items[0].matchFields, ["deviceFingerprint", "machineGuid"]);

    const blockRows = await app.mainStore.devices.queryDeviceBlockRows(app.db, {
      productCode: "PGAPP",
      status: "active"
    });
    assert.equal(blockRows.total, 1);
    assert.equal(blockRows.items[0].product_code, "PGAPP");
    assert.equal(blockRows.items[0].reason, "manual_review");

    const activeBindingCounts = await app.mainStore.devices.countActiveBindingsByProductIds(
      app.db,
      ["prod_pg_1"]
    );
    assert.equal(activeBindingCounts.length, 1);
    assert.equal(activeBindingCounts[0].product_id, "prod_pg_1");
    assert.equal(activeBindingCounts[0].count, 1);

    const releasedBindingCounts = await app.mainStore.devices.countReleasedBindingsByProductIds(
      app.db,
      ["prod_pg_1"]
    );
    assert.equal(releasedBindingCounts.length, 1);
    assert.equal(releasedBindingCounts[0].product_id, "prod_pg_1");
    assert.equal(releasedBindingCounts[0].count, 1);

    const activeBlockCounts = await app.mainStore.devices.countActiveBlocksByProductIds(
      app.db,
      ["prod_pg_1"]
    );
    assert.equal(activeBlockCounts.length, 1);
    assert.equal(activeBlockCounts[0].product_id, "prod_pg_1");
    assert.equal(activeBlockCounts[0].count, 1);

    const listedVersions = await app.mainStore.versions.listProductVersions(app.db, "prod_pg_1", "stable");
    assert.equal(listedVersions.length, 1);
    assert.equal(listedVersions[0].version, "2.0.0");
    assert.equal(listedVersions[0].forceUpdate, true);

    const versionRows = await app.mainStore.versions.queryClientVersionRows(app.db, {
      productCode: "PGAPP",
      channel: "stable",
      status: "active"
    });
    assert.equal(versionRows.total, 1);
    assert.equal(versionRows.items[0].product_code, "PGAPP");
    assert.equal(versionRows.items[0].forceUpdate, true);

    const activeVersionCounts = await app.mainStore.versions.countActiveVersionsByProductIds(
      app.db,
      ["prod_pg_1"]
    );
    assert.equal(activeVersionCounts.length, 1);
    assert.equal(activeVersionCounts[0].product_id, "prod_pg_1");
    assert.equal(activeVersionCounts[0].count, 1);

    const forceUpdateVersionCounts = await app.mainStore.versions.countForceUpdateVersionsByProductIds(
      app.db,
      ["prod_pg_1"]
    );
    assert.equal(forceUpdateVersionCounts.length, 1);
    assert.equal(forceUpdateVersionCounts[0].product_id, "prod_pg_1");
    assert.equal(forceUpdateVersionCounts[0].count, 1);

    const activeNotices = await app.mainStore.notices.listActiveNoticesForProduct(
      app.db,
      "prod_pg_1",
      "stable",
      "2026-01-15T00:00:00.000Z"
    );
    assert.equal(activeNotices.length, 1);
    assert.equal(activeNotices[0].title, "PG Maintenance");
    assert.equal(activeNotices[0].blockLogin, true);

    const noticeRows = await app.mainStore.notices.queryNoticeRows(app.db, {
      productCode: "PGAPP",
      channel: "stable",
      status: "active"
    });
    assert.equal(noticeRows.total, 1);
    assert.equal(noticeRows.items[0].productCode, "PGAPP");
    assert.equal(noticeRows.items[0].blockLogin, true);

    const activeNoticeCounts = await app.mainStore.notices.countActiveNoticesByProductIds(
      app.db,
      ["prod_pg_1"],
      "2026-01-15T00:00:00.000Z"
    );
    assert.equal(activeNoticeCounts.length, 1);
    assert.equal(activeNoticeCounts[0].product_id, "prod_pg_1");
    assert.equal(activeNoticeCounts[0].count, 1);

    const blockingNoticeCounts = await app.mainStore.notices.countBlockingNoticesByProductIds(
      app.db,
      ["prod_pg_1"],
      "2026-01-15T00:00:00.000Z"
    );
    assert.equal(blockingNoticeCounts.length, 1);
    assert.equal(blockingNoticeCounts[0].product_id, "prod_pg_1");
    assert.equal(blockingNoticeCounts[0].count, 1);

    const networkRuleRows = await app.mainStore.networkRules.queryNetworkRuleRows(app.db, {
      productCode: "PGAPP",
      actionScope: "login",
      status: "active"
    });
    assert.equal(networkRuleRows.total, 1);
    assert.equal(networkRuleRows.items[0].productCode, "PGAPP");
    assert.equal(networkRuleRows.items[0].pattern, "10.0.0.0/24");

    const blockingRules = await app.mainStore.networkRules.listBlockingNetworkRulesForProduct(
      app.db,
      "prod_pg_1",
      "login"
    );
    assert.equal(blockingRules.length, 1);
    assert.equal(blockingRules[0].pattern, "10.0.0.0/24");
    assert.equal(blockingRules[0].product_code, "PGAPP");

    const activeNetworkRuleCounts = await app.mainStore.networkRules.countActiveNetworkRulesByProductIds(
      app.db,
      ["prod_pg_1"]
    );
    assert.equal(activeNetworkRuleCounts.length, 1);
    assert.equal(activeNetworkRuleCounts[0].product_id, "prod_pg_1");
    assert.equal(activeNetworkRuleCounts[0].count, 1);

    const policyCounts = await app.mainStore.policies.countPoliciesByProductIds(app.db, ["prod_pg_1"]);
    assert.equal(policyCounts.length, 1);
    assert.equal(policyCounts[0].product_id, "prod_pg_1");
    assert.equal(policyCounts[0].count, 1);

    const freshCardCounts = await app.mainStore.cards.countCardsByProductIds(app.db, ["prod_pg_1"], "fresh");
    assert.equal(freshCardCounts.length, 1);
    assert.equal(freshCardCounts[0].product_id, "prod_pg_1");
    assert.equal(freshCardCounts[0].count, 1);

    const redeemedCardCounts = await app.mainStore.cards.countCardsByProductIds(app.db, ["prod_pg_1"], "redeemed");
    assert.equal(redeemedCardCounts.length, 0);

    const accountCounts = await app.mainStore.accounts.countAccountsByProductIds(app.db, ["prod_pg_1"]);
    assert.equal(accountCounts.length, 1);
    assert.equal(accountCounts[0].product_id, "prod_pg_1");
    assert.equal(accountCounts[0].count, 1);

    const disabledAccountCounts = await app.mainStore.accounts.countAccountsByProductIds(
      app.db,
      ["prod_pg_1"],
      "disabled"
    );
    assert.equal(disabledAccountCounts.length, 0);

    const activeEntitlementCounts = await app.mainStore.entitlements.countActiveEntitlementsByProductIds(
      app.db,
      ["prod_pg_1"],
      "2026-01-15T00:00:00.000Z"
    );
    assert.equal(activeEntitlementCounts.length, 1);
    assert.equal(activeEntitlementCounts[0].product_id, "prod_pg_1");
    assert.equal(activeEntitlementCounts[0].count, 1);

    assert.equal(queries.length, 44);
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
    assert.equal(queries[8].meta.operation, "listActiveSessionExpiryRows");
    assert.match(queries[8].sql, /JOIN policies p ON p\.id = e\.policy_id/i);
    assert.equal(queries[9].meta.repository, "accounts");
    assert.match(queries[9].sql, /FROM customer_accounts a/i);
    assert.equal(queries[10].meta.operation, "queryBindingsForEntitlement");
    assert.match(queries[10].sql, /FROM device_bindings b/i);
    assert.equal(queries[11].meta.operation, "getActiveDeviceBlock");
    assert.match(queries[11].sql, /FROM device_blocks/i);
    assert.equal(queries[12].meta.operation, "getBindingManageRowById");
    assert.match(queries[12].sql, /JOIN entitlements e ON e\.id = b\.entitlement_id/i);
    assert.equal(queries[13].meta.operation, "getSessionRecordByProductToken");
    assert.match(queries[13].sql, /FROM sessions/i);
    assert.equal(queries[14].meta.operation, "getSessionRecordById");
    assert.match(queries[14].sql, /WHERE id = \$1/i);
    assert.equal(queries[15].meta.operation, "getSessionRecordByToken");
    assert.match(queries[15].sql, /WHERE session_token = \$1/i);
    assert.equal(queries[16].meta.operation, "getActiveSessionHeartbeatRow");
    assert.match(queries[16].sql, /JOIN devices d ON d\.id = s\.device_id/i);
    assert.equal(queries[17].meta.operation, "getSessionManageRowById");
    assert.match(queries[17].sql, /JOIN products pr ON pr\.id = s\.product_id/i);
    assert.equal(queries[18].meta.operation, "listActiveSessionExpiryRows");
    assert.match(queries[18].sql, /JOIN policies p ON p\.id = e\.policy_id/i);
    assert.equal(queries[19].meta.operation, "querySessionRows");
    assert.match(queries[19].sql, /ORDER BY s\.last_heartbeat_at DESC/i);
    assert.equal(queries[20].meta.operation, "querySessionRows");
    assert.match(queries[20].sql, /ORDER BY s\.issued_at DESC/i);
    assert.equal(queries[21].meta.operation, "countActiveSessionsByProductIds");
    assert.match(queries[21].sql, /GROUP BY product_id/i);
    assert.equal(queries[22].meta.operation, "queryDeviceBindingRows");
    assert.match(queries[22].sql, /FROM device_bindings b/i);
    assert.equal(queries[23].meta.operation, "queryDeviceBlockRows");
    assert.match(queries[23].sql, /FROM device_blocks b/i);
    assert.equal(queries[24].meta.operation, "countActiveBindingsByProductIds");
    assert.match(queries[24].sql, /GROUP BY e\.product_id/i);
    assert.equal(queries[25].meta.operation, "countReleasedBindingsByProductIds");
    assert.match(queries[25].sql, /GROUP BY e\.product_id/i);
    assert.equal(queries[26].meta.operation, "countActiveBlocksByProductIds");
    assert.match(queries[26].sql, /GROUP BY product_id/i);
    assert.equal(queries[27].meta.operation, "listProductVersions");
    assert.match(queries[27].sql, /FROM client_versions/i);
    assert.equal(queries[28].meta.operation, "queryClientVersionRows");
    assert.match(queries[28].sql, /FROM client_versions v/i);
    assert.equal(queries[29].meta.operation, "countActiveVersionsByProductIds");
    assert.match(queries[29].sql, /GROUP BY product_id/i);
    assert.equal(queries[30].meta.operation, "countForceUpdateVersionsByProductIds");
    assert.match(queries[30].sql, /force_update = 1/i);
    assert.equal(queries[31].meta.operation, "listActiveNoticesForProduct");
    assert.match(queries[31].sql, /FROM notices n/i);
    assert.equal(queries[32].meta.operation, "queryNoticeRows");
    assert.match(queries[32].sql, /FROM notices n/i);
    assert.equal(queries[33].meta.operation, "countActiveNoticesByProductIds");
    assert.match(queries[33].sql, /GROUP BY product_id/i);
    assert.equal(queries[34].meta.operation, "countBlockingNoticesByProductIds");
    assert.match(queries[34].sql, /block_login = 1/i);
    assert.equal(queries[35].meta.operation, "queryNetworkRuleRows");
    assert.match(queries[35].sql, /FROM network_rules nr/i);
    assert.equal(queries[36].meta.operation, "listBlockingNetworkRulesForProduct");
    assert.match(queries[36].sql, /nr\.decision = 'block'/i);
    assert.equal(queries[37].meta.operation, "countActiveNetworkRulesByProductIds");
    assert.match(queries[37].sql, /FROM network_rules/i);
    assert.equal(queries[38].meta.operation, "countPoliciesByProductIds");
    assert.match(queries[38].sql, /FROM policies/i);
    assert.equal(queries[39].meta.operation, "countCardsByProductIds");
    assert.match(queries[39].sql, /FROM license_keys/i);
    assert.equal(queries[40].meta.operation, "countCardsByProductIds");
    assert.match(queries[40].sql, /status = \$2/i);
    assert.equal(queries[41].meta.operation, "countAccountsByProductIds");
    assert.match(queries[41].sql, /FROM customer_accounts/i);
    assert.equal(queries[42].meta.operation, "countAccountsByProductIds");
    assert.match(queries[42].sql, /status = \$2/i);
    assert.equal(queries[43].meta.operation, "countActiveEntitlementsByProductIds");
    assert.match(queries[43].sql, /FROM entitlements/i);

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
      versions: "postgres",
      notices: "postgres",
      networkRules: "postgres",
      devices: "postgres",
      sessions: "postgres"
    });
    assert.deepEqual(health.storage.mainStore.repositoryWriteDrivers, {
      products: "sqlite",
      policies: "sqlite",
      cards: "sqlite",
      entitlements: "sqlite",
      accounts: "sqlite",
      versions: "sqlite",
      notices: "sqlite",
      networkRules: "sqlite",
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
      versions: "postgres",
      notices: "postgres",
      networkRules: "postgres",
      devices: "postgres_partial",
      sessions: "postgres_partial"
    });

    const admin = app.services.adminLogin({
      username: "admin",
      password: "Pass123!abc"
    });
    const developer = app.services.createDeveloper(admin.token, {
      username: "pgwriter",
      password: "Pass123!abc",
      displayName: "PG Writer"
    });

    const product = await app.services.createProduct(admin.token, {
      code: "PGWRITE",
      name: "PG Write Product",
      description: "Write-capable adapter",
      ownerDeveloperId: developer.id,
      allowRegister: false,
      allowCardLogin: false
    });
    assert.equal(product.code, "PGWRITE");
    assert.equal(product.featureConfig.allowRegister, false);
    assert.equal(product.featureConfig.allowCardLogin, false);
    assert.equal(product.ownerDeveloper?.id, developer.id);

    const developerSession = app.services.developerLogin({
      username: "pgwriter",
      password: "Pass123!abc"
    });
    const developerProducts = await app.services.developerListProducts(developerSession.token);
    assert.equal(developerProducts.length, 1);
    assert.equal(developerProducts[0].code, "PGWRITE");

    const developerIntegration = await app.services.developerIntegration(developerSession.token);
    assert.equal(developerIntegration.products.length, 1);
    assert.equal(developerIntegration.products[0].code, "PGWRITE");

    const developerDashboard = await app.services.developerDashboard(developerSession.token);
    assert.equal(developerDashboard.summary.projects, 1);
    assert.equal(developerDashboard.projects.length, 1);

    const member = await app.services.developerCreateMember(developerSession.token, {
      username: "pgmember",
      password: "Pass123!abc",
      role: "viewer",
      productCodes: ["PGWRITE"]
    });
    assert.equal(member.productAccess.length, 1);
    assert.equal(member.productAccess[0].productCode, "PGWRITE");

    const memberSession = app.services.developerLogin({
      username: "pgmember",
      password: "Pass123!abc"
    });
    const memberProducts = await app.services.developerListProducts(memberSession.token);
    assert.equal(memberProducts.length, 1);
    assert.equal(memberProducts[0].code, "PGWRITE");

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

    state.entitlements.push({
      id: "ent_pg_write_1",
      product_id: product.id,
      policy_id: policy.id,
      account_id: createdAccount.id,
      source_license_key_id: "lk_pg_write_1",
      status: "active",
      starts_at: "2026-01-12T00:00:00.000Z",
      ends_at: "2026-02-12T00:00:00.000Z",
      created_at: "2026-01-12T00:00:00.000Z",
      updated_at: "2026-01-12T00:00:00.000Z"
    });

    const firstDevice = await app.mainStore.devices.upsertDevice(
      product.id,
      "pg-device-write-1",
      "PG Write Device 1",
      { ip: "203.0.113.40", userAgent: "pg-device-write-agent-1" },
      { deviceFingerprint: "pg-device-write-1", machineGuid: "PG-MACHINE-1" },
      "2026-01-13T00:00:00.000Z"
    );
    assert.equal(firstDevice.fingerprint, "pg-device-write-1");

    const firstBinding = await app.mainStore.devices.bindDeviceToEntitlement(
      { id: "ent_pg_write_1", max_devices: 2 },
      firstDevice,
      {
        bindMode: "selected_fields",
        bindFields: ["machineGuid"],
        identity: { machineGuid: "PG-MACHINE-1" },
        identityHash: "pg_identity_hash_1",
        requestIp: "203.0.113.40"
      },
      { timestamp: "2026-01-13T00:01:00.000Z" }
    );
    assert.equal(firstBinding.mode, "new_binding");
    assert.equal(firstBinding.binding.status, "active");

    state.sessions.push({
      id: "sess_pg_device_rebound_1",
      product_id: product.id,
      account_id: createdAccount.id,
      entitlement_id: "ent_pg_write_1",
      device_id: firstDevice.id,
      session_token: "sess-pg-device-rebound-1",
      license_token: "license-pg-device-rebound-1",
      status: "active",
      issued_at: "2026-01-13T00:02:00.000Z",
      expires_at: "2026-01-13T01:02:00.000Z",
      last_heartbeat_at: "2026-01-13T00:02:00.000Z",
      last_seen_ip: "203.0.113.40",
      user_agent: "pg-device-rebound-test",
      revoked_reason: null
    });

    const secondDevice = await app.mainStore.devices.upsertDevice(
      product.id,
      "pg-device-write-2",
      "PG Write Device 2",
      { ip: "203.0.113.41", userAgent: "pg-device-write-agent-2" },
      { deviceFingerprint: "pg-device-write-2", machineGuid: "PG-MACHINE-1" },
      "2026-01-13T00:03:00.000Z"
    );
    assert.equal(secondDevice.fingerprint, "pg-device-write-2");

    const reboundBinding = await app.mainStore.devices.bindDeviceToEntitlement(
      { id: "ent_pg_write_1", max_devices: 2 },
      secondDevice,
      {
        bindMode: "selected_fields",
        bindFields: ["machineGuid"],
        identity: { machineGuid: "PG-MACHINE-1" },
        identityHash: "pg_identity_hash_1",
        requestIp: "203.0.113.41"
      },
      {
        timestamp: "2026-01-13T00:04:00.000Z",
        releaseSessions: ({ entitlementId, deviceId, reason }) =>
          Promise.resolve(app.mainStore.sessions.expireActiveSessions({ entitlementId, deviceId }, reason))
            .then((rows) => rows.length)
      }
    );
    assert.equal(reboundBinding.mode, "identity_rebound");
    assert.equal(reboundBinding.releasedSessions, 1);
    assert.equal(reboundBinding.binding.device_id, secondDevice.id);
    assert.equal(state.sessions[0].status, "expired");
    assert.equal(state.sessions[0].revoked_reason, "binding_rebound");

    const bindingRows = await app.mainStore.devices.queryBindingsForEntitlement(app.db, "ent_pg_write_1");
    assert.equal(bindingRows.length, 1);
    assert.equal(bindingRows[0].deviceId, secondDevice.id);
    assert.deepEqual(bindingRows[0].matchFields, ["machineGuid"]);
    assert.deepEqual(bindingRows[0].identity, { machineGuid: "PG-MACHINE-1" });

    state.sessions.push({
      id: "sess_pg_device_block_1",
      product_id: product.id,
      account_id: createdAccount.id,
      entitlement_id: "ent_pg_write_1",
      device_id: secondDevice.id,
      session_token: "sess-pg-device-block-1",
      license_token: "license-pg-device-block-1",
      status: "active",
      issued_at: "2026-01-13T00:05:00.000Z",
      expires_at: "2026-01-13T01:05:00.000Z",
      last_heartbeat_at: "2026-01-13T00:05:00.000Z",
      last_seen_ip: "203.0.113.41",
      user_agent: "pg-device-block-test",
      revoked_reason: null
    });

    const blockedDevice = await app.services.blockDevice(admin.token, {
      productCode: "PGWRITE",
      deviceFingerprint: "pg-device-write-2",
      reason: "manual_review",
      notes: "blocked during pg write preview"
    });
    assert.equal(blockedDevice.status, "active");
    assert.equal(blockedDevice.changed, true);
    assert.equal(blockedDevice.affectedSessions, 1);
    assert.equal(blockedDevice.affectedBindings, 1);
    const blockedSession = state.sessions.find((entry) => entry.id === "sess_pg_device_block_1");
    assert.equal(blockedSession?.status, "expired");
    assert.equal(blockedSession?.revoked_reason, "device_blocked");
    assert.equal(
      state.deviceBindings.find((entry) => entry.id === reboundBinding.binding.id)?.status,
      "revoked"
    );

    const unblockedDevice = await app.services.unblockDevice(admin.token, blockedDevice.id, {
      reason: "manual_release"
    });
    assert.equal(unblockedDevice.status, "released");
    assert.equal(unblockedDevice.changed, true);
    assert.equal(state.deviceBlocks.length, 1);
    assert.equal(state.deviceBlocks[0].status, "released");

    const listedProducts = await app.services.listProducts(admin.token);
    assert.equal(listedProducts.some((item) => item.code === "PGWRITE"), true);

    const listedPolicies = await app.services.listPolicies(admin.token, { productCode: "PGWRITE" });
    assert.equal(listedPolicies.length, 1);
    assert.equal(listedPolicies[0].grantType, "points");
    assert.equal(listedPolicies[0].allowClientUnbind, false);

    const clientVersion = await app.services.createClientVersion(admin.token, {
      productCode: "PGWRITE",
      channel: "stable",
      version: "2.5.0",
      forceUpdate: true,
      noticeTitle: "PG write release"
    });
    assert.equal(clientVersion.productCode, "PGWRITE");
    assert.equal(clientVersion.forceUpdate, true);

    const updatedClientVersion = await app.services.updateClientVersionStatus(admin.token, clientVersion.id, {
      status: "disabled",
      forceUpdate: false
    });
    assert.equal(updatedClientVersion.status, "disabled");
    assert.equal(updatedClientVersion.forceUpdate, false);

    const listedVersions = await app.services.listClientVersions(admin.token, { productCode: "PGWRITE" });
    assert.equal(listedVersions.items.length, 1);
    assert.equal(listedVersions.items[0].version, "2.5.0");
    assert.equal(listedVersions.items[0].status, "disabled");

    const notice = await app.services.createNotice(admin.token, {
      productCode: "PGWRITE",
      channel: "stable",
      kind: "maintenance",
      severity: "warning",
      title: "PG write notice",
      body: "maintenance window",
      blockLogin: true
    });
    assert.equal(notice.productCode, "PGWRITE");
    assert.equal(notice.blockLogin, true);

    const updatedNotice = await app.services.updateNoticeStatus(admin.token, notice.id, {
      status: "archived",
      blockLogin: false
    });
    assert.equal(updatedNotice.status, "archived");
    assert.equal(updatedNotice.blockLogin, false);

    const listedNotices = await app.services.listNotices(admin.token, { productCode: "PGWRITE" });
    assert.equal(listedNotices.items.length, 1);
    assert.equal(listedNotices.items[0].title, "PG write notice");
    assert.equal(listedNotices.items[0].status, "archived");

    const networkRule = await app.services.createNetworkRule(admin.token, {
      productCode: "PGWRITE",
      targetType: "ip",
      pattern: "203.0.113.90",
      actionScope: "login",
      notes: "pg write rule"
    });
    assert.equal(networkRule.productCode, "PGWRITE");
    assert.equal(networkRule.actionScope, "login");

    const updatedNetworkRule = await app.services.updateNetworkRuleStatus(admin.token, networkRule.id, {
      status: "archived"
    });
    assert.equal(updatedNetworkRule.status, "archived");

    const listedNetworkRules = await app.services.listNetworkRules(admin.token, { productCode: "PGWRITE" });
    assert.equal(listedNetworkRules.items.length, 1);
    assert.equal(listedNetworkRules.items[0].pattern, "203.0.113.90");
    assert.equal(listedNetworkRules.items[0].status, "archived");

    const dashboard = await app.services.dashboard(admin.token);
    assert.equal(dashboard.summary.products, 1);
    assert.equal(dashboard.summary.policies, 1);
    assert.equal(dashboard.summary.accounts, 2);
    assert.equal(dashboard.summary.disabledAccounts, 1);
    assert.equal(dashboard.summary.activeEntitlements, 0);
    assert.equal(dashboard.summary.cardsFresh, 0);
    assert.equal(dashboard.summary.cardsRedeemed, 0);
    assert.equal(dashboard.summary.activeBindings, 0);
    assert.equal(dashboard.summary.blockedDevices, 0);
    assert.equal(dashboard.summary.activeClientVersions, 0);
    assert.equal(dashboard.summary.activeNotices, 0);
    assert.equal(dashboard.summary.activeNetworkRules, 0);

    const health = await app.services.health();
    assert.equal(health.storage.mainStore.implementationStage, "core_write_preview");
    assert.deepEqual(health.storage.mainStore.repositoryWriteDrivers, {
      products: "postgres",
      policies: "postgres",
      cards: "postgres",
      entitlements: "postgres",
      accounts: "postgres",
      versions: "postgres",
      notices: "postgres",
      networkRules: "postgres",
      devices: "postgres_partial",
      sessions: "postgres_partial"
    });

    assert.equal(state.products.length, 1);
    assert.equal(state.policies.length, 1);
    assert.equal(state.clientVersions.length, 1);
    assert.equal(state.notices.length, 1);
    assert.equal(state.networkRules.length, 1);
    assert.equal(state.devices.length, 2);
    assert.equal(state.deviceBlocks.length, 1);
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

    const issuedSession = await app.mainStore.sessions.createIssuedSession({
      id: "sess_pg_write_1",
      productId: product.id,
      accountId: createdAccount.id,
      entitlementId: "ent_pg_write_1",
      deviceId: "dev_pg_write_1",
      sessionToken: "session-pg-write-1",
      licenseToken: "license-pg-write-1",
      issuedAt: "2026-01-15T00:00:00.000Z",
      expiresAt: "2026-01-15T01:00:00.000Z",
      lastHeartbeatAt: "2026-01-15T00:00:00.000Z",
      lastSeenIp: "203.0.113.30",
      userAgent: "pg-session-write-test"
    });
    assert.equal(issuedSession.session_token, "session-pg-write-1");

    const touchedSession = await app.mainStore.sessions.touchSessionHeartbeat("sess_pg_write_1", {
      lastHeartbeatAt: "2026-01-15T00:10:00.000Z",
      expiresAt: "2026-01-15T01:10:00.000Z",
      lastSeenIp: "203.0.113.31",
      userAgent: "pg-session-heartbeat-test"
    });
    assert.equal(touchedSession.last_heartbeat_at, "2026-01-15T00:10:00.000Z");
    assert.equal(touchedSession.expires_at, "2026-01-15T01:10:00.000Z");
    assert.equal(touchedSession.last_seen_ip, "203.0.113.31");

    const expiredSessions = await app.mainStore.sessions.expireActiveSessions(
      { sessionId: "sess_pg_write_1" },
      "pg_session_revoke"
    );
    assert.equal(expiredSessions.length, 1);
    assert.equal(expiredSessions[0].session_token, "session-pg-write-1");
    const issuedSessionRow = state.sessions.find((entry) => entry.id === "sess_pg_write_1");
    assert.equal(issuedSessionRow?.status, "expired");
    assert.equal(issuedSessionRow?.revoked_reason, "pg_session_revoke");

    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "createProduct"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "countActiveSessionsByProductIds"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "countPoliciesByProductIds"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "countCardsByProductIds"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "countAccountsByProductIds"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "countActiveEntitlementsByProductIds"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "createPolicy"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "countActiveVersionsByProductIds"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "countForceUpdateVersionsByProductIds"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "updatePolicyRuntimeConfig"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "createClientVersion"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "updateClientVersionStatus"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "createNotice"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "updateNoticeStatus"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "createNetworkRule"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "countActiveNoticesByProductIds"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "countBlockingNoticesByProductIds"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "updateNetworkRuleStatus"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "countActiveNetworkRulesByProductIds"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "createDevice"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "getDeviceRecordByFingerprint"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "createBinding"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "createDeviceBlock"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "upsertBindingProfile"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "rebindIdentityMatch"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "selectActiveBindingsForDeviceRevoke"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "revokeActiveBindingsByDevice"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "getDeviceBlockManageRowById"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "releaseDeviceBlock"),
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
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "createIssuedSession"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "touchSessionHeartbeat"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "selectActiveSessionsForExpiry"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "expireActiveSessions"),
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
      versions: "postgres",
      notices: "postgres",
      networkRules: "postgres",
      devices: "postgres_partial",
      sessions: "postgres_partial"
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

test("postgres main store keeps sqlite card shadows and reseller routes usable during preview", async () => {
  const { adapter, state } = createWriteCapableAdapter();
  const { app, tempDir } = createTestApp({
    mainStoreDriver: "postgres",
    postgresUrl: "postgres://rocksolid:secret@127.0.0.1:5432/rocksolid",
    postgresMainStoreAdapter: adapter
  });

  try {
    const baseUrl = await startHttpApp(app);
    const admin = app.services.adminLogin({
      username: "admin",
      password: "Pass123!abc"
    });

    const product = await app.services.createProduct(admin.token, {
      code: "PGSELL",
      name: "PG Reseller Product"
    });
    const policy = await app.services.createPolicy(admin.token, {
      productCode: "PGSELL",
      name: "PG Reseller Policy",
      durationDays: 30,
      maxDevices: 1,
      grantType: "points",
      grantPoints: 9
    });

    const batch = await app.services.createCardBatch(admin.token, {
      productCode: "PGSELL",
      policyId: policy.id,
      count: 1,
      prefix: "PGSELL",
      expiresAt: "2026-02-01T00:00:00.000Z"
    });
    assert.equal(batch.count, 1);

    const shadowCard = app.db.prepare(
      "SELECT * FROM license_keys WHERE batch_code = ? LIMIT 1"
    ).get(batch.batchCode);
    assert.ok(shadowCard);
    assert.equal(shadowCard.product_id, product.id);
    assert.equal(shadowCard.policy_id, policy.id);

    const shadowPolicyGrant = app.db.prepare(
      "SELECT * FROM policy_grant_configs WHERE policy_id = ?"
    ).get(policy.id);
    assert.ok(shadowPolicyGrant);
    assert.equal(shadowPolicyGrant.grant_type, "points");
    assert.equal(Number(shadowPolicyGrant.grant_points), 9);

    const shadowControl = app.db.prepare(
      "SELECT * FROM license_key_controls WHERE license_key_id = ?"
    ).get(shadowCard.id);
    assert.ok(shadowControl);
    assert.equal(shadowControl.status, "active");
    assert.equal(shadowControl.expires_at, "2026-02-01T00:00:00.000Z");

    const frozenCard = await app.services.updateCardStatus(admin.token, shadowCard.id, {
      status: "frozen",
      notes: "freeze shadow"
    });
    assert.equal(frozenCard.effectiveControlStatus, "frozen");
    const frozenControl = app.db.prepare(
      "SELECT * FROM license_key_controls WHERE license_key_id = ?"
    ).get(shadowCard.id);
    assert.equal(frozenControl.status, "frozen");

    const reseller = app.services.createReseller(admin.token, {
      code: "PG_ROUTE",
      name: "PG Route Reseller"
    });

    const priceRule = await postJson(baseUrl, "/api/admin/reseller-price-rules", {
      resellerId: reseller.id,
      productCode: "PGSELL",
      policyId: policy.id,
      unitPrice: 59,
      unitCost: 41
    }, admin.token);
    assert.equal(priceRule.productCode, "PGSELL");
    assert.equal(priceRule.policyId, policy.id);
    assert.equal(priceRule.unitPriceCents, 5900);

    const allocation = await postJson(
      baseUrl,
      `/api/admin/resellers/${reseller.id}/allocate-cards`,
      {
        productCode: "PGSELL",
        policyId: policy.id,
        count: 2,
        prefix: "PGRTE"
      },
      admin.token
    );
    assert.equal(allocation.count, 2);
    assert.equal(allocation.pricing.unitPriceCents, 5900);
    assert.equal(allocation.keys.length, 2);

    const inventoryCount = app.db.prepare(
      "SELECT COUNT(*) AS count FROM reseller_inventory WHERE reseller_id = ?"
    ).get(reseller.id).count;
    assert.equal(inventoryCount, 2);

    const allocationCardCount = app.db.prepare(
      "SELECT COUNT(*) AS count FROM license_keys WHERE batch_code = ?"
    ).get(allocation.allocationBatchCode).count;
    assert.equal(allocationCardCount, 2);

    const listedInventory = app.services.listResellerInventory(admin.token, {
      resellerId: reseller.id,
      productCode: "PGSELL"
    });
    assert.equal(listedInventory.items.length, 2);
    assert.equal(listedInventory.items[0].productCode, "PGSELL");

    assert.equal(state.licenseKeys.length, 3);
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "createCard"),
      true
    );
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("postgres preview supports signed client register, recharge, login, and card-login reuse", async () => {
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
      code: "PGCLIENT",
      name: "PG Client Flow Product"
    });
    const policy = await app.services.createPolicy(admin.token, {
      productCode: "PGCLIENT",
      name: "PG Client Flow Policy",
      durationDays: 0,
      maxDevices: 1,
      grantType: "points",
      grantPoints: 3
    });

    const batch = await app.services.createCardBatch(admin.token, {
      productCode: "PGCLIENT",
      policyId: policy.id,
      count: 2,
      prefix: "PGCLNT"
    });
    assert.equal(batch.count, 2);

    const registration = await callSignedClientService(
      app,
      product,
      "/api/client/register",
      "registerClient",
      {
        productCode: "PGCLIENT",
        username: "pguser",
        password: "StrongPass123"
      },
      { ip: "203.0.113.70", userAgent: "pg-preview-register" }
    );
    assert.equal(registration.username, "pguser");

    const recharge = await callSignedClientService(
      app,
      product,
      "/api/client/recharge",
      "redeemCard",
      {
        productCode: "PGCLIENT",
        username: "pguser",
        password: "StrongPass123",
        cardKey: batch.keys[0]
      },
      { ip: "203.0.113.70", userAgent: "pg-preview-recharge" }
    );
    assert.equal(recharge.grantType, "points");
    assert.equal(recharge.remainingPoints, 3);

    const accountLogin = await callSignedClientService(
      app,
      product,
      "/api/client/login",
      "loginClient",
      {
        productCode: "PGCLIENT",
        username: "pguser",
        password: "StrongPass123",
        deviceFingerprint: "pg-preview-device-001",
        deviceName: "PG Preview Desktop"
      },
      { ip: "203.0.113.70", userAgent: "pg-preview-login" }
    );
    assert.ok(accountLogin.sessionToken);
    assert.equal(accountLogin.quota.grantType, "points");
    assert.equal(accountLogin.quota.remainingPoints, 2);

    const rechargedCardShadow = app.db.prepare(
      "SELECT status, redeemed_by_account_id FROM license_keys WHERE card_key = ?"
    ).get(batch.keys[0]);
    assert.equal(rechargedCardShadow.status, "redeemed");
    assert.ok(rechargedCardShadow.redeemed_by_account_id);

    const accountShadow = app.db.prepare(
      "SELECT username, status, last_login_at FROM customer_accounts WHERE username = ?"
    ).get("pguser");
    assert.ok(accountShadow);
    assert.equal(accountShadow.status, "active");
    assert.ok(accountShadow.last_login_at);

    const directLogin = await callSignedClientService(
      app,
      product,
      "/api/client/card-login",
      "cardLoginClient",
      {
        productCode: "PGCLIENT",
        cardKey: batch.keys[1],
        deviceFingerprint: "pg-preview-card-device-001",
        deviceName: "PG Preview Card Client"
      },
      { ip: "203.0.113.71", userAgent: "pg-preview-card-login-1" }
    );
    assert.equal(directLogin.authMode, "card");
    assert.ok(directLogin.sessionToken);

    const directCardShadow = app.db.prepare(
      "SELECT id, status, redeemed_by_account_id FROM license_keys WHERE card_key = ?"
    ).get(batch.keys[1]);
    assert.ok(directCardShadow);
    assert.equal(directCardShadow.status, "redeemed");
    assert.ok(directCardShadow.redeemed_by_account_id);

    const cardLoginLink = app.db.prepare(
      "SELECT * FROM card_login_accounts WHERE license_key_id = ?"
    ).get(directCardShadow.id);
    assert.ok(cardLoginLink);
    assert.equal(cardLoginLink.product_id, product.id);

    const cardLoginAccountShadow = app.db.prepare(
      "SELECT * FROM customer_accounts WHERE id = ?"
    ).get(cardLoginLink.account_id);
    assert.ok(cardLoginAccountShadow);
    assert.equal(cardLoginAccountShadow.status, "active");

    const directRelogin = await callSignedClientService(
      app,
      product,
      "/api/client/card-login",
      "cardLoginClient",
      {
        productCode: "PGCLIENT",
        cardKey: batch.keys[1],
        deviceFingerprint: "pg-preview-card-device-001",
        deviceName: "PG Preview Card Client"
      },
      { ip: "203.0.113.71", userAgent: "pg-preview-card-login-2" }
    );
    assert.equal(directRelogin.authMode, "card");
    assert.notEqual(directRelogin.sessionToken, directLogin.sessionToken);

    const disabledCardLoginAccount = await app.services.updateAccountStatus(admin.token, cardLoginLink.account_id, {
      status: "disabled"
    });
    assert.equal(disabledCardLoginAccount.status, "disabled");

    const disabledCardLoginShadow = app.db.prepare(
      "SELECT status FROM customer_accounts WHERE id = ?"
    ).get(cardLoginLink.account_id);
    assert.equal(disabledCardLoginShadow.status, "disabled");

    await assert.rejects(
      () => callSignedClientService(
        app,
        product,
        "/api/client/card-login",
        "cardLoginClient",
        {
          productCode: "PGCLIENT",
          cardKey: batch.keys[1],
          deviceFingerprint: "pg-preview-card-device-001",
          deviceName: "PG Preview Card Client"
        },
        { ip: "203.0.113.71", userAgent: "pg-preview-card-login-disabled" }
      ),
      (error) => {
        assert.equal(error.status, 403);
        assert.equal(error.code, "CARD_LOGIN_DISABLED");
        return true;
      }
    );

    assert.ok(state.entitlements.length >= 2);
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "createEntitlement"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "markCardRedeemed"),
      true
    );
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("postgres preview keeps sqlite runtime-state session visibility aligned with main store", async () => {
  const { adapter, state } = createWriteCapableAdapter();
  const { app, tempDir } = createTestApp({
    mainStoreDriver: "postgres",
    postgresUrl: "postgres://rocksolid:secret@127.0.0.1:5432/rocksolid",
    postgresMainStoreAdapter: adapter,
    stateStoreDriver: "sqlite"
  });

  try {
    const admin = app.services.adminLogin({
      username: "admin",
      password: "Pass123!abc"
    });

    const product = await app.services.createProduct(admin.token, {
      code: "PGRSTATE",
      name: "PG Runtime State Product"
    });
    const policy = await app.services.createPolicy(admin.token, {
      productCode: "PGRSTATE",
      name: "PG Runtime State Policy",
      durationDays: 7,
      maxDevices: 1
    });

    const batch = await app.services.createCardBatch(admin.token, {
      productCode: "PGRSTATE",
      policyId: policy.id,
      count: 1,
      prefix: "PGRS"
    });
    assert.equal(batch.count, 1);

    await callSignedClientService(
      app,
      product,
      "/api/client/register",
      "registerClient",
      {
        productCode: "PGRSTATE",
        username: "runtime-user",
        password: "StrongPass123"
      },
      { ip: "203.0.113.90", userAgent: "pg-runtime-register" }
    );

    await callSignedClientService(
      app,
      product,
      "/api/client/recharge",
      "redeemCard",
      {
        productCode: "PGRSTATE",
        username: "runtime-user",
        password: "StrongPass123",
        cardKey: batch.keys[0]
      },
      { ip: "203.0.113.90", userAgent: "pg-runtime-recharge" }
    );

    const login = await callSignedClientService(
      app,
      product,
      "/api/client/login",
      "loginClient",
      {
        productCode: "PGRSTATE",
        username: "runtime-user",
        password: "StrongPass123",
        deviceFingerprint: "pg-runtime-device-001",
        deviceName: "PG Runtime Device"
      },
      { ip: "203.0.113.90", userAgent: "pg-runtime-login" }
    );

    const runtimeSession = await app.runtimeState.getSessionState(login.sessionToken);
    assert.ok(runtimeSession);
    assert.equal(runtimeSession.status, "active");

    const health = await app.services.health();
    assert.equal(health.storage.runtimeState.driver, "sqlite");
    assert.equal(health.storage.runtimeState.activeSessions, 1);

    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "getSessionRecordByToken"),
      true
    );
    assert.equal(
      state.queries.some((entry) => entry.meta?.operation === "countActiveSessionsByProductIds"),
      true
    );
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
