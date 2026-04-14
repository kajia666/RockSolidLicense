import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

const require = createRequire(import.meta.url);

function createTestApp(overrides = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rocksolid-postgres-runtime-adapter-"));
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

test("postgres runtime adapter can load a pg-style pool module and close it cleanly", async () => {
  const fakePgModulePath = path.join(process.cwd(), "test-support", "fake-pg-module.cjs");
  const fakePgModule = require(fakePgModulePath);
  fakePgModule.__state.queries = [];
  fakePgModule.__state.ended = false;

  const { app, tempDir } = createTestApp({
    mainStoreDriver: "postgres",
    postgresUrl: "postgres://rocksolid:secret@127.0.0.1:5432/rocksolid",
    postgresPgModulePath: fakePgModulePath,
    postgresPoolMax: 7
  });

  try {
    assert.equal(app.mainStore.driver, "postgres");
    assert.equal(app.mainStore.implementationStage, "core_write_preview");
    assert.equal(app.mainStore.adapterSource, "pg_pool");
    assert.equal(app.mainStore.pgModuleTarget, fakePgModulePath);
    assert.equal(app.mainStore.poolMax, 7);
    assert.deepEqual(app.mainStore.repositoryWriteDrivers, {
      products: "postgres",
      policies: "postgres",
      cards: "postgres",
      entitlements: "postgres"
    });

    const admin = app.services.adminLogin({
      username: "admin",
      password: "Pass123!abc"
    });

    const products = await app.services.listProducts(admin.token);
    assert.equal(products.length, 1);
    assert.equal(products[0].code, "PGREAL");

    const cards = await app.services.listCards(admin.token, { productCode: "PGREAL" });
    assert.equal(cards.items.length, 1);
    assert.equal(cards.items[0].cardKey, "PGREAL-123456-AAAA");

    const entitlements = await app.services.listEntitlements(admin.token, { productCode: "PGREAL" });
    assert.equal(entitlements.items.length, 1);
    assert.equal(entitlements.items[0].username, "runtime-user");

    const health = await app.services.health();
    assert.equal(health.storage.mainStore.driver, "postgres");
    assert.equal(health.storage.mainStore.adapterSource, "pg_pool");
    assert.equal(health.storage.mainStore.adapterState, "ready");
    assert.equal(health.storage.mainStore.connectionOk, true);
    assert.equal(health.storage.mainStore.implementationStage, "core_write_preview");
    assert.equal(health.storage.mainStore.pgModuleTarget, fakePgModulePath);
    assert.equal(health.storage.mainStore.poolMax, 7);

    assert.equal(fakePgModule.__state.config.connectionString, "postgres://rocksolid:secret@127.0.0.1:5432/rocksolid");
    assert.equal(fakePgModule.__state.config.max, 7);
    assert.equal(
      fakePgModule.__state.queries.some((entry) => /FROM products p/i.test(entry.sql)),
      true
    );
    assert.equal(
      fakePgModule.__state.queries.some((entry) => /SELECT 1 AS ok/i.test(entry.sql)),
      true
    );
  } finally {
    await app.close();
    assert.equal(fakePgModule.__state.ended, true);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
