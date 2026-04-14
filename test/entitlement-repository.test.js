import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import {
  entitlementLifecycleStatus,
  formatEntitlementGrant,
  getLatestEntitlementSnapshot,
  getUsableEntitlement,
  loadPointEntitlementForAdmin,
  queryEntitlementRows
} from "../src/data/entitlement-repository.js";
import { signClientRequest } from "../src/security.js";

async function startServer() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rocksolid-entitlement-repo-"));
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

  await app.listen();
  const address = app.server.address();
  return {
    app,
    tempDir,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function signedClientRequest(baseUrl, requestPath, appId, secret, payload, nonce) {
  const body = JSON.stringify(payload);
  const timestamp = new Date().toISOString();
  const signature = signClientRequest(secret, {
    method: "POST",
    path: requestPath,
    timestamp,
    nonce,
    body
  });

  const response = await fetch(`${baseUrl}${requestPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-rs-app-id": appId,
      "x-rs-timestamp": timestamp,
      "x-rs-nonce": nonce,
      "x-rs-signature": signature
    },
    body
  });

  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json.data;
}

test("entitlement repository reads usable authorization and formatted grant state", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const admin = app.services.adminLogin({
      username: "admin",
      password: "Pass123!abc"
    });
    await app.services.createProduct(admin.token, {
      code: "ENTREPO",
      name: "Entitlement Repo Product"
    });
    const product = (await app.services.listProducts(admin.token)).find((item) => item.code === "ENTREPO");
    const policy = await app.services.createPolicy(admin.token, {
      productCode: "ENTREPO",
      name: "Points Policy",
      durationDays: 365,
      maxDevices: 2,
      grantType: "points",
      grantPoints: 8
    });
    const batch = app.services.createCardBatch(admin.token, {
      productCode: "ENTREPO",
      policyId: policy.id,
      count: 1,
      prefix: "ENT"
    });

    await signedClientRequest(baseUrl, "/api/client/register", product.sdkAppId, product.sdkAppSecret, {
      productCode: "ENTREPO",
      username: "repo-user",
      password: "Pass123!abc"
    }, "nonce-ent-register");
    await signedClientRequest(baseUrl, "/api/client/recharge", product.sdkAppId, product.sdkAppSecret, {
      productCode: "ENTREPO",
      username: "repo-user",
      password: "Pass123!abc",
      cardKey: batch.keys[0]
    }, "nonce-ent-recharge");

    const rows = queryEntitlementRows(app.db, {
      productCode: "ENTREPO",
      username: "repo-user",
      grantType: "points"
    });

    assert.equal(rows.items.length, 1);
    assert.equal(rows.items[0].productCode, "ENTREPO");
    assert.equal(rows.items[0].username, "repo-user");
    assert.equal(rows.items[0].grantType, "points");
    assert.equal(rows.items[0].grantPoints, 8);
    assert.equal(rows.items[0].remainingPoints, 8);
    assert.equal(rows.items[0].lifecycleStatus, "active");

    const account = app.db.prepare(
      "SELECT id FROM customer_accounts WHERE product_id = ? AND username = ?"
    ).get(product.id, "repo-user");

    const usable = getUsableEntitlement(app.db, account.id, product.id, new Date().toISOString());
    assert.ok(usable);
    assert.equal(usable.id, rows.items[0].id);

    const latest = getLatestEntitlementSnapshot(app.db, account.id, product.id);
    assert.ok(latest);
    assert.equal(latest.id, rows.items[0].id);
    assert.equal(entitlementLifecycleStatus(latest, new Date().toISOString()), "active");

    const grant = formatEntitlementGrant(latest);
    assert.equal(grant.grantType, "points");
    assert.equal(grant.totalPoints, 8);
    assert.equal(grant.remainingPoints, 8);
    assert.equal(grant.consumedPoints, 0);

    const pointEntitlement = loadPointEntitlementForAdmin(app.db, rows.items[0].id);
    assert.ok(pointEntitlement);
    assert.equal(pointEntitlement.product_code, "ENTREPO");
    assert.equal(pointEntitlement.username, "repo-user");
    assert.equal(pointEntitlement.grant_type, "points");
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
