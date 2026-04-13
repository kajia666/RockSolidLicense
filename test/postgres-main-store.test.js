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
