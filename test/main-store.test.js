import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

function createTestApp() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rocksolid-main-store-"));
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
    serverTokenSecret: "test-secret"
  });

  return { app, tempDir };
}

test("app exposes sqlite main store and services read through it", async () => {
  const { app, tempDir } = createTestApp();

  try {
    assert.equal(app.mainStore.driver, "sqlite");
    assert.deepEqual(
      app.mainStore.repositories,
      ["products", "policies", "cards", "entitlements", "accounts", "versions", "notices", "networkRules", "devices", "sessions"]
    );
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
    const developer = app.services.createDeveloper(admin.token, {
      username: "storedev",
      password: "Pass123!abc",
      displayName: "Store Dev"
    });
    const product = await app.services.createProduct(admin.token, {
      code: "STOREAPP",
      name: "Main Store Product",
      ownerDeveloperId: developer.id
    });

    const productRows = app.mainStore.products.queryProductRows(app.db, {
      ownerDeveloperId: developer.id
    });
    assert.equal(productRows.length, 1);
    assert.equal(productRows[0].id, product.id);

    const adminRows = await app.services.listProducts(admin.token);
    assert.equal(adminRows.length, 1);
    assert.equal(adminRows[0].code, "STOREAPP");

    const developerLogin = app.services.developerLogin({
      username: "storedev",
      password: "Pass123!abc"
    });
    const developerRows = await app.services.developerListProducts(developerLogin.token);
    assert.equal(developerRows.length, 1);
    assert.equal(developerRows[0].code, "STOREAPP");

    const directProduct = app.mainStore.products.createProduct({
      code: "STOREAPP2",
      name: "Direct Store Product"
    }, developer.id);
    assert.equal(directProduct.code, "STOREAPP2");
    assert.equal(directProduct.ownerDeveloper.id, developer.id);

    const signedProduct = app.mainStore.products.getActiveProductRowBySdkAppId(
      app.db,
      directProduct.sdkAppId
    );
    assert.equal(signedProduct.id, directProduct.id);
    assert.equal(signedProduct.code, "STOREAPP2");
    assert.equal(signedProduct.featureConfig.allowRegister, true);

    const directAccount = app.mainStore.accounts.createAccount(directProduct, {
      username: "store_direct_user",
      passwordHash: "direct-hash"
    });
    assert.equal(directAccount.username, "store_direct_user");

    const accountRows = app.mainStore.accounts.queryAccountRows(app.db, {
      productCode: "STOREAPP2"
    });
    assert.equal(accountRows.items.length, 1);
    assert.equal(accountRows.items[0].username, "store_direct_user");

    const disabledAccount = app.mainStore.accounts.updateAccountStatus(directAccount.id, "disabled");
    assert.equal(disabledAccount.status, "disabled");

    const restoredAccount = app.mainStore.accounts.updateAccountStatus(directAccount.id, "active");
    assert.equal(restoredAccount.status, "active");

    const directPolicy = app.mainStore.policies.createPolicy(directProduct, {
      name: "Direct Store Policy",
      durationDays: 45,
      maxDevices: 2,
      allowConcurrentSessions: true,
      bindMode: "selected_fields",
      bindFields: ["deviceFingerprint", "machineGuid"],
      allowClientUnbind: true,
      clientUnbindLimit: 2,
      clientUnbindWindowDays: 14,
      clientUnbindDeductDays: 1
    });
    assert.equal(directPolicy.productCode, "STOREAPP2");
    assert.equal(directPolicy.bindMode, "selected_fields");
    assert.deepEqual(directPolicy.bindFields, ["deviceFingerprint", "machineGuid"]);
    assert.equal(directPolicy.allowClientUnbind, true);

    const updatedRuntime = app.mainStore.policies.updatePolicyRuntimeConfig({
      id: directPolicy.id,
      product_id: directProduct.id,
      product_code: directProduct.code,
      product_name: directProduct.name,
      name: directPolicy.name,
      allow_concurrent_sessions: 1,
      bind_mode: directPolicy.bindMode,
      updated_at: directPolicy.updatedAt
    }, {
      allowConcurrentSessions: false,
      bindFields: ["machineGuid"]
    });
    assert.equal(updatedRuntime.allowConcurrentSessions, false);
    assert.deepEqual(updatedRuntime.bindFields, ["machineGuid"]);

    const updatedUnbind = app.mainStore.policies.updatePolicyUnbindConfig({
      id: directPolicy.id,
      product_id: directProduct.id,
      product_code: directProduct.code,
      product_name: directProduct.name,
      name: directPolicy.name,
      updated_at: directPolicy.updatedAt
    }, {
      allowClientUnbind: false,
      clientUnbindLimit: 0,
      clientUnbindWindowDays: 30,
      clientUnbindDeductDays: 0
    });
    assert.equal(updatedUnbind.allowClientUnbind, false);
    assert.equal(updatedUnbind.clientUnbindLimit, 0);

    const directVersion = await app.services.createClientVersion(admin.token, {
      productCode: "STOREAPP2",
      channel: "stable",
      version: "2.0.0",
      status: "active",
      forceUpdate: true,
      downloadUrl: "https://example.invalid/storeapp2/2.0.0.zip",
      releaseNotes: "Store main-store release notes",
      noticeTitle: "Store main-store release",
      noticeBody: "Important runtime update",
      releasedAt: "2026-01-05T00:00:00.000Z"
    });
    assert.equal(directVersion.productCode, "STOREAPP2");
    assert.equal(directVersion.forceUpdate, true);

    const versionRows = await Promise.resolve(app.mainStore.versions.queryClientVersionRows(app.db, {
      productCode: "STOREAPP2",
      channel: "stable",
      status: "active"
    }));
    assert.equal(versionRows.total, 1);
    assert.equal(versionRows.items[0].product_code, "STOREAPP2");
    assert.equal(versionRows.items[0].forceUpdate, true);

    const listedProductVersions = await Promise.resolve(
      app.mainStore.versions.listProductVersions(app.db, directProduct.id, "stable")
    );
    assert.equal(listedProductVersions.length, 1);
    assert.equal(listedProductVersions[0].version, "2.0.0");
    assert.equal(listedProductVersions[0].forceUpdate, true);

    const activeVersionCounts = app.mainStore.versions.countActiveVersionsByProductIds(
      app.db,
      [directProduct.id]
    );
    assert.equal(activeVersionCounts.length, 1);
    assert.equal(activeVersionCounts[0].product_id, directProduct.id);
    assert.equal(activeVersionCounts[0].count, 1);

    const forceUpdateVersionCounts = app.mainStore.versions.countForceUpdateVersionsByProductIds(
      app.db,
      [directProduct.id]
    );
    assert.equal(forceUpdateVersionCounts.length, 1);
    assert.equal(forceUpdateVersionCounts[0].product_id, directProduct.id);
    assert.equal(forceUpdateVersionCounts[0].count, 1);

    const directNotice = await app.services.createNotice(admin.token, {
      productCode: "STOREAPP2",
      channel: "stable",
      kind: "maintenance",
      severity: "critical",
      title: "Store Main Notice",
      body: "Scheduled maintenance for main-store test",
      status: "active",
      blockLogin: true,
      startsAt: "2026-01-05T00:00:00.000Z",
      endsAt: "2026-02-05T00:00:00.000Z"
    });
    assert.equal(directNotice.productCode, "STOREAPP2");
    assert.equal(directNotice.blockLogin, true);

    const noticeRows = await Promise.resolve(app.mainStore.notices.queryNoticeRows(app.db, {
      productCode: "STOREAPP2",
      channel: "stable",
      status: "active"
    }));
    assert.equal(noticeRows.total, 1);
    assert.equal(noticeRows.items[0].productCode, "STOREAPP2");
    assert.equal(noticeRows.items[0].blockLogin, true);

    const activeNotices = await Promise.resolve(
      app.mainStore.notices.listActiveNoticesForProduct(
        app.db,
        directProduct.id,
        "stable",
        "2026-01-10T00:00:00.000Z"
      )
    );
    assert.equal(activeNotices.length, 1);
    assert.equal(activeNotices[0].title, "Store Main Notice");

    const activeNoticeCounts = app.mainStore.notices.countActiveNoticesByProductIds(
      app.db,
      [directProduct.id],
      "2026-01-10T00:00:00.000Z"
    );
    assert.equal(activeNoticeCounts.length, 1);
    assert.equal(activeNoticeCounts[0].product_id, directProduct.id);
    assert.equal(activeNoticeCounts[0].count, 1);

    const blockingNoticeCounts = app.mainStore.notices.countBlockingNoticesByProductIds(
      app.db,
      [directProduct.id],
      "2026-01-10T00:00:00.000Z"
    );
    assert.equal(blockingNoticeCounts.length, 1);
    assert.equal(blockingNoticeCounts[0].product_id, directProduct.id);
    assert.equal(blockingNoticeCounts[0].count, 1);

    const directNetworkRule = await app.services.createNetworkRule(admin.token, {
      productCode: "STOREAPP2",
      targetType: "cidr",
      pattern: "10.10.0.0/16",
      actionScope: "login",
      status: "active",
      notes: "Store main-store network rule"
    });
    assert.equal(directNetworkRule.productCode, "STOREAPP2");
    assert.equal(directNetworkRule.actionScope, "login");

    const networkRuleRows = await Promise.resolve(app.mainStore.networkRules.queryNetworkRuleRows(app.db, {
      productCode: "STOREAPP2",
      actionScope: "login",
      status: "active"
    }));
    assert.equal(networkRuleRows.total, 1);
    assert.equal(networkRuleRows.items[0].productCode, "STOREAPP2");
    assert.equal(networkRuleRows.items[0].pattern, "10.10.0.0/16");

    const blockingRules = await Promise.resolve(
      app.mainStore.networkRules.listBlockingNetworkRulesForProduct(app.db, directProduct.id, "login")
    );
    assert.equal(blockingRules.length, 1);
    assert.equal(blockingRules[0].pattern, "10.10.0.0/16");
    assert.equal(blockingRules[0].product_code, "STOREAPP2");

    const activeNetworkRuleCounts = app.mainStore.networkRules.countActiveNetworkRulesByProductIds(
      app.db,
      [directProduct.id]
    );
    assert.equal(activeNetworkRuleCounts.length, 1);
    assert.equal(activeNetworkRuleCounts[0].product_id, directProduct.id);
    assert.equal(activeNetworkRuleCounts[0].count, 1);

    const directBatch = app.mainStore.cards.createCardBatch(directProduct, directPolicy, {
      count: 2,
      prefix: "STORE2",
      notes: "Direct batch"
    });
    assert.equal(directBatch.count, 2);
    assert.equal(directBatch.keys.length, 2);

    const directCards = app.mainStore.cards.queryCardRows(app.db, {
      productCode: "STOREAPP2"
    });
    assert.equal(directCards.items.length, 2);

    const updatedCard = app.mainStore.cards.updateCardStatus(directCards.items[0].id, {
      status: "frozen",
      notes: "Frozen in direct store path"
    });
    assert.equal(updatedCard.control.status, "frozen");
    assert.equal(updatedCard.card.displayStatus, "frozen");

    const durationCard = directCards.items.find((item) => item.id !== updatedCard.card.id);
    assert.ok(durationCard);
    const durationActivation = app.mainStore.entitlements.activateFreshCardEntitlement(
      directProduct,
      directAccount,
      durationCard,
      new Date().toISOString()
    );
    assert.equal(durationActivation.grantType, "duration");
    assert.equal(durationActivation.entitlementId.length > 0, true);

    const pointPolicy = app.mainStore.policies.createPolicy(directProduct, {
      name: "Point Store Policy",
      grantType: "points",
      grantPoints: 5,
      durationDays: 0,
      maxDevices: 1
    });
    app.mainStore.cards.createCardBatch(directProduct, pointPolicy, {
      count: 1,
      prefix: "PSTORE"
    });
    const pointCard = app.mainStore.cards.queryCardRows(app.db, {
      productCode: "STOREAPP2",
      policyId: pointPolicy.id
    }).items[0];
    assert.ok(pointCard);
    const pointActivation = app.mainStore.entitlements.activateFreshCardEntitlement(
      directProduct,
      directAccount,
      pointCard,
      new Date().toISOString()
    );
    assert.equal(pointActivation.grantType, "points");
    assert.equal(pointActivation.totalPoints, 5);
    assert.equal(pointActivation.remainingPoints, 5);

    const entitlementRows = app.mainStore.entitlements.queryEntitlementRows(app.db, {
      productCode: "STOREAPP2"
    }).items;
    const durationEntitlement = entitlementRows.find((item) => item.grantType === "duration");
    const pointEntitlement = entitlementRows.find((item) => item.grantType === "points");
    assert.ok(durationEntitlement);
    assert.ok(pointEntitlement);

    const usableEntitlement = app.mainStore.entitlements.getUsableEntitlement(
      app.db,
      directAccount.id,
      directProduct.id,
      new Date().toISOString()
    );
    assert.ok(usableEntitlement);
    assert.equal(usableEntitlement.account_id, directAccount.id);

    const latestEntitlement = app.mainStore.entitlements.getLatestEntitlementSnapshot(
      app.db,
      directAccount.id,
      directProduct.id
    );
    assert.ok(latestEntitlement);
    assert.equal(latestEntitlement.account_id, directAccount.id);

    const frozenEntitlement = app.mainStore.entitlements.updateEntitlementStatus(durationEntitlement.id, {
      status: "frozen"
    });
    assert.equal(frozenEntitlement.status, "frozen");
    assert.equal(frozenEntitlement.changed, true);

    const restoredEntitlement = app.mainStore.entitlements.updateEntitlementStatus(durationEntitlement.id, {
      status: "active"
    });
    assert.equal(restoredEntitlement.status, "active");

    const extendedEntitlement = app.mainStore.entitlements.extendEntitlement(durationEntitlement.id, {
      days: 7
    });
    assert.equal(extendedEntitlement.addedDays, 7);

    const adjustedEntitlement = app.mainStore.entitlements.adjustEntitlementPoints(pointEntitlement.id, {
      mode: "add",
      points: 2
    });
    assert.equal(adjustedEntitlement.current.totalPoints, 7);
    assert.equal(adjustedEntitlement.current.remainingPoints, 7);

    const consumedQuota = app.mainStore.entitlements.consumeEntitlementLoginQuota(pointEntitlement);
    assert.equal(consumedQuota.grantType, "points");
    assert.equal(consumedQuota.remainingPoints, 6);
    assert.equal(consumedQuota.consumedPoints, 1);
    assert.equal(consumedQuota.consumedThisLogin, 1);

    const meteringAfterConsume = app.mainStore.entitlements.queryEntitlementRows(app.db, {
      entitlementId: pointEntitlement.id
    }).items[0];
    assert.equal(meteringAfterConsume.remainingPoints, 6);
    assert.equal(meteringAfterConsume.consumedPoints, 1);

    app.db.prepare(`
      INSERT INTO devices
      (id, product_id, fingerprint, device_name, first_seen_at, last_seen_at, last_seen_ip, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "dev_store_session",
      directProduct.id,
      "store-session-device",
      "Store Session Device",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "127.0.0.1",
      "{}"
    );

    const issuedSession = app.mainStore.sessions.createIssuedSession({
      id: "sess_store_main",
      productId: directProduct.id,
      accountId: directAccount.id,
      entitlementId: durationEntitlement.id,
      deviceId: "dev_store_session",
      sessionToken: "session-token-store-main",
      licenseToken: "license-token-store-main",
      issuedAt: "2026-01-05T00:00:00.000Z",
      expiresAt: "2026-01-05T01:00:00.000Z",
      lastSeenIp: "127.0.0.1",
      userAgent: "main-store-test"
    });
    assert.equal(issuedSession.session_token, "session-token-store-main");

    const sessionByProductToken = app.mainStore.sessions.getSessionRecordByProductToken(
      app.db,
      directProduct.id,
      "session-token-store-main"
    );
    assert.equal(sessionByProductToken.id, "sess_store_main");

    const sessionHeartbeatRow = app.mainStore.sessions.getActiveSessionHeartbeatRow(
      app.db,
      directProduct.id,
      "session-token-store-main"
    );
    assert.equal(sessionHeartbeatRow.id, "sess_store_main");
    assert.equal(sessionHeartbeatRow.username, "store_direct_user");
    assert.equal(sessionHeartbeatRow.fingerprint, "store-session-device");

    const sessionManageRow = app.mainStore.sessions.getSessionManageRowById(
      app.db,
      "sess_store_main"
    );
    assert.equal(sessionManageRow.id, "sess_store_main");
    assert.equal(sessionManageRow.product_code, "STOREAPP2");
    assert.equal(sessionManageRow.username, "store_direct_user");

    const activeSessionExpiryRows = app.mainStore.sessions.listActiveSessionExpiryRows(app.db);
    assert.equal(activeSessionExpiryRows.length, 1);
    assert.equal(activeSessionExpiryRows[0].id, "sess_store_main");
    assert.equal(activeSessionExpiryRows[0].session_token, "session-token-store-main");

    const sessionRows = await Promise.resolve(app.mainStore.sessions.querySessionRows(app.db, {
      productCode: "STOREAPP2",
      username: "store_direct_user",
      status: "active"
    }));
    assert.equal(sessionRows.total, 1);
    assert.equal(sessionRows.items[0].id, "sess_store_main");
    assert.equal(sessionRows.items[0].policy_name, "Direct Store Policy");
    assert.equal(sessionRows.items[0].fingerprint, "store-session-device");

    const recentSessionRows = await Promise.resolve(app.mainStore.sessions.querySessionRows(app.db, {
      limit: 1,
      sortBy: "issuedAtDesc"
    }));
    assert.equal(recentSessionRows.total, 1);
    assert.equal(recentSessionRows.items[0].id, "sess_store_main");

    const activeSessionCounts = app.mainStore.sessions.countActiveSessionsByProductIds(
      app.db,
      [directProduct.id]
    );
    assert.equal(activeSessionCounts.length, 1);
    assert.equal(activeSessionCounts[0].product_id, directProduct.id);
    assert.equal(activeSessionCounts[0].count, 1);

    const untouchedAccount = app.mainStore.accounts.getAccountRecordById(app.db, directAccount.id);
    assert.equal(untouchedAccount.last_login_at ?? null, null);

    app.mainStore.accounts.touchAccountLastLogin(directAccount.id, "2026-01-05T00:00:00.000Z");
    const touchedAccount = app.mainStore.accounts.getAccountRecordById(app.db, directAccount.id);
    assert.equal(touchedAccount.last_login_at, "2026-01-05T00:00:00.000Z");

    const heartbeatTouchedSession = app.mainStore.sessions.touchSessionHeartbeat("sess_store_main", {
      lastHeartbeatAt: "2026-01-05T00:10:00.000Z",
      expiresAt: "2026-01-05T01:10:00.000Z",
      lastSeenIp: "127.0.0.2",
      userAgent: "main-store-heartbeat-test"
    });
    assert.equal(heartbeatTouchedSession.last_heartbeat_at, "2026-01-05T00:10:00.000Z");
    assert.equal(heartbeatTouchedSession.expires_at, "2026-01-05T01:10:00.000Z");
    assert.equal(heartbeatTouchedSession.last_seen_ip, "127.0.0.2");
    assert.equal(heartbeatTouchedSession.user_agent, "main-store-heartbeat-test");

    const directDevice = app.mainStore.devices.upsertDevice(
      directProduct.id,
      "store-direct-bind-device",
      "Store Direct Bind Device",
      { ip: "127.0.0.2", userAgent: "main-store-device-test" },
      {
        deviceFingerprint: "store-direct-bind-device",
        machineGuid: "machine-guid-001",
        requestIp: "127.0.0.2"
      }
    );
    const directBinding = await app.mainStore.devices.bindDeviceToEntitlement(
      {
        id: durationEntitlement.id,
        max_devices: 2
      },
      directDevice,
      {
        bindMode: "selected_fields",
        bindFields: ["machineGuid"],
        identity: { machineGuid: "machine-guid-001" },
        identityHash: "machine-guid-hash-001",
        requestIp: "127.0.0.2"
      }
    );
    assert.equal(directBinding.mode, "new_binding");
    assert.equal(directBinding.binding.status, "active");

    const listedBindings = app.mainStore.devices.queryBindingsForEntitlement(
      app.db,
      durationEntitlement.id
    );
    assert.equal(listedBindings.length, 1);
    assert.equal(listedBindings[0].id, directBinding.binding.id);
    assert.equal(listedBindings[0].fingerprint, "store-direct-bind-device");
    assert.deepEqual(listedBindings[0].matchFields, ["machineGuid"]);

    const bindingRows = await Promise.resolve(app.mainStore.devices.queryDeviceBindingRows(app.db, {
      productCode: "STOREAPP2",
      username: "store_direct_user",
      status: "active"
    }));
    assert.equal(bindingRows.total, 1);
    assert.equal(bindingRows.items[0].id, directBinding.binding.id);
    assert.equal(bindingRows.items[0].product_code, "STOREAPP2");
    assert.equal(bindingRows.items[0].bindRequestIp, "127.0.0.2");

    const activeBindingCounts = app.mainStore.devices.countActiveBindingsByProductIds(
      app.db,
      [directProduct.id]
    );
    assert.equal(activeBindingCounts.length, 1);
    assert.equal(activeBindingCounts[0].product_id, directProduct.id);
    assert.equal(activeBindingCounts[0].count, 1);

    const unbindLog = app.mainStore.devices.recordEntitlementUnbind(
      durationEntitlement.id,
      directBinding.binding.id,
      "client",
      directAccount.id,
      "main_store_test_unbind",
      1,
      "2026-01-05T00:20:00.000Z"
    );
    assert.equal(unbindLog.binding_id, directBinding.binding.id);
    assert.equal(unbindLog.actor_type, "client");

    const recentClientUnbinds = app.mainStore.devices.countRecentClientUnbinds(
      app.db,
      durationEntitlement.id,
      30,
      "2026-01-06T00:00:00.000Z"
    );
    assert.equal(recentClientUnbinds, 1);

    const releasedBinding = app.mainStore.devices.releaseBinding(
      directBinding.binding.id,
      "2026-01-05T00:30:00.000Z"
    );
    assert.equal(releasedBinding.status, "revoked");
    assert.equal(releasedBinding.revoked_at, "2026-01-05T00:30:00.000Z");

    const bindingManageRow = app.mainStore.devices.getBindingManageRowById(
      app.db,
      directBinding.binding.id
    );
    assert.equal(bindingManageRow.id, directBinding.binding.id);
    assert.equal(bindingManageRow.product_code, "STOREAPP2");
    assert.equal(bindingManageRow.username, "store_direct_user");
    assert.equal(bindingManageRow.fingerprint, "store-direct-bind-device");

    app.db.prepare(`
      INSERT INTO device_blocks
      (id, product_id, fingerprint, status, reason, notes, created_at, updated_at, released_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?, NULL)
    `).run(
      "block_store_main",
      directProduct.id,
      "store-direct-bind-device",
      "manual-test-block",
      "Inserted from main store test",
      "2026-01-05T00:00:00.000Z",
      "2026-01-05T00:00:00.000Z"
    );
    const activeBlock = app.mainStore.devices.getActiveDeviceBlock(
      app.db,
      directProduct.id,
      "store-direct-bind-device"
    );
    assert.ok(activeBlock);
    assert.equal(activeBlock.reason, "manual-test-block");

    const blockRows = await Promise.resolve(app.mainStore.devices.queryDeviceBlockRows(app.db, {
      productCode: "STOREAPP2",
      status: "active"
    }));
    assert.equal(blockRows.total, 1);
    assert.equal(blockRows.items[0].id, "block_store_main");
    assert.equal(blockRows.items[0].product_code, "STOREAPP2");
    assert.equal(blockRows.items[0].active_session_count, 0);

    const activeBlockCounts = app.mainStore.devices.countActiveBlocksByProductIds(
      app.db,
      [directProduct.id]
    );
    assert.equal(activeBlockCounts.length, 1);
    assert.equal(activeBlockCounts[0].product_id, directProduct.id);
    assert.equal(activeBlockCounts[0].count, 1);

    const revokedSessions = app.mainStore.sessions.expireActiveSessions(
      { sessionId: "sess_store_main" },
      "main_store_revoke"
    );
    assert.equal(revokedSessions.length, 1);
    assert.equal(revokedSessions[0].session_token, "session-token-store-main");

    const revokedSession = app.mainStore.sessions.getSessionRecordById(app.db, "sess_store_main");
    assert.equal(revokedSession.status, "expired");
    assert.equal(revokedSession.revoked_reason, "main_store_revoke");
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
