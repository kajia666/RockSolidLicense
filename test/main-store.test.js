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
      ["products", "policies", "cards", "entitlements"]
    );
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
    const accountId = "acct_store_main";
    const now = new Date().toISOString();
    const durationEndsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    app.db.prepare(`
      INSERT INTO customer_accounts
      (id, product_id, username, password_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `).run(accountId, directProduct.id, "store_user", "test-hash", now, now);
    app.db.prepare(`
      UPDATE license_keys
      SET status = 'redeemed', redeemed_by_account_id = ?, redeemed_at = ?
      WHERE id = ?
    `).run(accountId, now, durationCard.id);
    app.db.prepare(`
      INSERT INTO entitlements
      (id, product_id, account_id, policy_id, source_license_key_id, status, starts_at, ends_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run("ent_store_duration", directProduct.id, accountId, directPolicy.id, durationCard.id, now, durationEndsAt, now, now);

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
    const pointEndsAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    app.db.prepare(`
      UPDATE license_keys
      SET status = 'redeemed', redeemed_by_account_id = ?, redeemed_at = ?
      WHERE id = ?
    `).run(accountId, now, pointCard.id);
    app.db.prepare(`
      INSERT INTO entitlements
      (id, product_id, account_id, policy_id, source_license_key_id, status, starts_at, ends_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run("ent_store_points", directProduct.id, accountId, pointPolicy.id, pointCard.id, now, pointEndsAt, now, now);
    app.db.prepare(`
      INSERT INTO entitlement_metering
      (entitlement_id, grant_type, total_points, remaining_points, consumed_points, created_at, updated_at)
      VALUES (?, 'points', ?, ?, ?, ?, ?)
    `).run("ent_store_points", 5, 5, 0, now, now);

    const entitlementRows = app.mainStore.entitlements.queryEntitlementRows(app.db, {
      productCode: "STOREAPP2"
    }).items;
    const durationEntitlement = entitlementRows.find((item) => item.grantType === "duration");
    const pointEntitlement = entitlementRows.find((item) => item.grantType === "points");
    assert.ok(durationEntitlement);
    assert.ok(pointEntitlement);

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
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
