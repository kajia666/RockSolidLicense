import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { getPolicyAccessRowById, queryPolicyRows } from "../src/data/policy-repository.js";

function createTestApp() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rocksolid-policy-repo-"));
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

test("policy repository formats scoped policy rows and ownership joins", async () => {
  const { app, tempDir } = createTestApp();

  try {
    const admin = app.services.adminLogin({
      username: "admin",
      password: "Pass123!abc"
    });
    const developer = app.services.createDeveloper(admin.token, {
      username: "policydev",
      password: "Pass123!abc",
      displayName: "Policy Dev"
    });
    const product = await app.services.createProduct(admin.token, {
      code: "POLREPO1",
      name: "Policy Repo Product",
      ownerDeveloperId: developer.id
    });

    const policy = await app.services.createPolicy(admin.token, {
      productCode: "POLREPO1",
      name: "Selected Bind Policy",
      durationDays: 45,
      maxDevices: 3,
      allowConcurrentSessions: false,
      bindMode: "selected_fields",
      bindFields: ["machineGuid", "requestIp"],
      allowClientUnbind: true,
      clientUnbindLimit: 2,
      clientUnbindWindowDays: 15,
      clientUnbindDeductDays: 1,
      grantType: "points",
      grantPoints: 12
    });

    const rows = queryPolicyRows(app.db, {
      ownerDeveloperId: developer.id,
      productCode: "POLREPO1"
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, policy.id);
    assert.equal(rows[0].productId, product.id);
    assert.equal(rows[0].productCode, "POLREPO1");
    assert.equal(rows[0].allowConcurrentSessions, false);
    assert.deepEqual(rows[0].bindFields, ["machineGuid", "requestIp"]);
    assert.equal(rows[0].bindMode, "selected_fields");
    assert.equal(rows[0].allowClientUnbind, true);
    assert.equal(rows[0].clientUnbindLimit, 2);
    assert.equal(rows[0].clientUnbindWindowDays, 15);
    assert.equal(rows[0].clientUnbindDeductDays, 1);
    assert.equal(rows[0].grantType, "points");
    assert.equal(rows[0].grantPoints, 12);

    const accessRow = getPolicyAccessRowById(app.db, policy.id);
    assert.equal(accessRow.product_id, product.id);
    assert.equal(accessRow.product_code, "POLREPO1");
    assert.equal(accessRow.owner_developer_id, developer.id);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
