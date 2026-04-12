import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { signClientRequest } from "../src/security.js";

async function startServer(overrides = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rocksolid-runtime-state-"));
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

  await app.listen();
  const httpAddress = app.server.address();
  return {
    app,
    tempDir,
    baseUrl: `http://127.0.0.1:${httpAddress.port}`
  };
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

async function getJson(baseUrl, requestPath) {
  const response = await fetch(`${baseUrl}${requestPath}`);
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json.data;
}

async function signedClientRequest(baseUrl, requestPath, appId, secret, payload, { nonce, timestamp } = {}) {
  const body = JSON.stringify(payload);
  const resolvedTimestamp = timestamp ?? new Date().toISOString();
  const resolvedNonce = nonce ?? "nonce-default";
  const signature = signClientRequest(secret, {
    method: "POST",
    path: requestPath,
    timestamp: resolvedTimestamp,
    nonce: resolvedNonce,
    body
  });

  const response = await fetch(`${baseUrl}${requestPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-rs-app-id": appId,
      "x-rs-timestamp": resolvedTimestamp,
      "x-rs-nonce": resolvedNonce,
      "x-rs-signature": signature
    },
    body
  });

  return {
    status: response.status,
    json: await response.json()
  };
}

test("health exposes storage profile and runtime state configuration", async () => {
  const { app, baseUrl } = await startServer({
    stateStoreDriver: "memory",
    postgresUrl: "postgres://rocksolid:secret@127.0.0.1:5432/rocksolid",
    redisUrl: "redis://127.0.0.1:6379/0",
    redisKeyPrefix: "rocksolid:test"
  });

  try {
    const health = await getJson(baseUrl, "/api/health");
    assert.equal(health.status, "ok");
    assert.equal(health.storage.database.driver, "sqlite");
    assert.equal(health.storage.database.postgresUrlConfigured, true);
    assert.equal(health.storage.runtimeState.driver, "memory");
    assert.equal(health.storage.runtimeState.nonceReplayStore, "process_memory");
    assert.equal(health.storage.runtimeState.sessionPresenceStore, "process_memory");
    assert.equal(health.storage.runtimeState.redisUrlConfigured, true);
    assert.equal(health.storage.runtimeState.redisKeyPrefix, "rocksolid:test");
    assert.equal(health.storage.runtimeState.activeSessions, 0);
  } finally {
    await app.close();
  }
});

test("memory runtime state rejects replayed sdk nonce", async () => {
  const { app, baseUrl } = await startServer({
    stateStoreDriver: "memory"
  });

  try {
    const adminLogin = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const product = await postJson(baseUrl, "/api/admin/products", {
      code: "MEMORYSDK",
      name: "Memory SDK Product"
    }, adminLogin.token);

    const payload = {
      productCode: product.code,
      clientVersion: "1.0.0",
      channel: "stable"
    };
    const signatureWindow = {
      nonce: "replay-nonce-001",
      timestamp: new Date().toISOString()
    };

    const first = await signedClientRequest(
      baseUrl,
      "/api/client/version-check",
      product.sdkAppId,
      product.sdkAppSecret,
      payload,
      signatureWindow
    );
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.ok, true);

    const second = await signedClientRequest(
      baseUrl,
      "/api/client/version-check",
      product.sdkAppId,
      product.sdkAppSecret,
      payload,
      signatureWindow
    );
    assert.equal(second.status, 409, JSON.stringify(second.json));
    assert.equal(second.json.ok, false);
    assert.equal(second.json.error.code, "SDK_NONCE_REPLAY");
  } finally {
    await app.close();
  }
});
