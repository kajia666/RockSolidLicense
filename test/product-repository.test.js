import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import {
  findOwnedProductIdByCode,
  getActiveProductRecordByCode,
  getActiveProductRecordBySdkAppId,
  listAssignedDeveloperProductIds,
  listOwnedProductIds,
  queryProductRows
} from "../src/data/product-repository.js";

function createTestApp() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rocksolid-product-repo-"));
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

test("product repository exposes formatted rows and developer-scoped lookups", async () => {
  const { app, tempDir } = createTestApp();

  try {
    const admin = app.services.adminLogin({
      username: "admin",
      password: "Pass123!abc"
    });
    const developer = app.services.createDeveloper(admin.token, {
      username: "repodev",
      password: "Pass123!abc",
      displayName: "Repository Dev"
    });

    const productA = await app.services.createProduct(admin.token, {
      code: "REPOUNITA",
      name: "Repository Product A",
      ownerDeveloperId: developer.id,
      allowRegister: false,
      allowNotices: false
    });
    const productB = await app.services.createProduct(admin.token, {
      code: "REPOUNITB",
      name: "Repository Product B",
      ownerDeveloperId: developer.id
    });

    const productRows = queryProductRows(app.db, { ownerDeveloperId: developer.id });
    assert.equal(productRows.length, 2);

    const rowA = productRows.find((item) => item.code === "REPOUNITA");
    assert.ok(rowA);
    assert.equal(rowA.ownerDeveloper?.id, developer.id);
    assert.equal(rowA.featureConfig.allowRegister, false);
    assert.equal(rowA.featureConfig.allowNotices, false);

    assert.deepEqual(
      listOwnedProductIds(app.db, developer.id).sort(),
      [productA.id, productB.id].sort()
    );
    assert.equal(findOwnedProductIdByCode(app.db, developer.id, "REPOUNITA"), productA.id);

    const ownerSession = app.services.developerLogin({
      username: "repodev",
      password: "Pass123!abc"
    });
    const member = await app.services.developerCreateMember(ownerSession.token, {
      username: "repomember",
      password: "Pass123!abc",
      role: "viewer",
      productCodes: ["REPOUNITB"]
    });

    assert.deepEqual(
      listAssignedDeveloperProductIds(app.db, member.id, developer.id),
      [productB.id]
    );

    const rawByCode = getActiveProductRecordByCode(app.db, "REPOUNITA");
    assert.equal(rawByCode.id, productA.id);
    assert.equal(rawByCode.sdk_app_id, productA.sdkAppId);

    const rawByAppId = getActiveProductRecordBySdkAppId(app.db, productA.sdkAppId);
    assert.equal(rawByAppId.id, productA.id);
    assert.equal(rawByAppId.code, "REPOUNITA");
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
