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
      products: "sqlite"
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
    const product = app.services.createProduct(admin.token, {
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
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
