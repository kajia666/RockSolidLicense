import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import {
  decodeLicenseTokenPayload,
  signClientRequest,
  verifyLicenseToken
} from "../src/security.js";

async function startServer() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rocksolid-license-"));
  const app = createApp({
    host: "127.0.0.1",
    port: 0,
    tcpHost: "127.0.0.1",
    tcpPort: 0,
    dbPath: ":memory:",
    licensePrivateKeyPath: path.join(tempDir, "license_private.pem"),
    licensePublicKeyPath: path.join(tempDir, "license_public.pem"),
    licenseKeyringPath: path.join(tempDir, "license_keyring.json"),
    adminUsername: "admin",
    adminPassword: "Pass123!abc",
    serverTokenSecret: "test-secret"
  });

  await app.listen();

  const httpAddress = app.server.address();
  const tcpAddress = app.tcpServer.address();
  return {
    app,
    baseUrl: `http://127.0.0.1:${httpAddress.port}`,
    tcpPort: tcpAddress.port,
    tempDir
  };
}

async function postJson(baseUrl, path, body, token = null) {
  const response = await fetch(`${baseUrl}${path}`, {
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

async function postJsonExpectError(baseUrl, path, body, token = null) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  assert.equal(response.ok, false, JSON.stringify(json));
  return {
    status: response.status,
    error: json.error
  };
}

async function getJson(baseUrl, path, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json.data;
}

async function getText(baseUrl, path, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: text
  };
}

async function signedClientPost(baseUrl, path, appId, secret, payload) {
  const body = JSON.stringify(payload);
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomBytes(8).toString("hex");
  const signature = signClientRequest(secret, {
    method: "POST",
    path,
    timestamp,
    nonce,
    body
  });

  const response = await fetch(`${baseUrl}${path}`, {
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

async function signedClientPostExpectError(baseUrl, path, appId, secret, payload) {
  const body = JSON.stringify(payload);
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomBytes(8).toString("hex");
  const signature = signClientRequest(secret, {
    method: "POST",
    path,
    timestamp,
    nonce,
    body
  });

  const response = await fetch(`${baseUrl}${path}`, {
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
  assert.equal(response.ok, false, JSON.stringify(json));
  return {
    status: response.status,
    error: json.error
  };
}

async function tcpRequest(tcpPort, frame) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: tcpPort });
    let buffer = "";
    let settled = false;

    socket.setEncoding("utf8");

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(frame)}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0 || settled) {
        return;
      }

      settled = true;
      socket.end();

      try {
        const response = JSON.parse(buffer.slice(0, newlineIndex));
        if (!response.ok) {
          reject(new Error(JSON.stringify(response.error)));
          return;
        }
        resolve(response.data);
      } catch (error) {
        reject(error);
      }
    });

    socket.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    socket.on("close", () => {
      if (!settled) {
        settled = true;
        reject(new Error("TCP connection closed before a response was received."));
      }
    });
  });
}

async function signedTcpClientCall(tcpPort, action, path, appId, secret, payload) {
  const bodyText = JSON.stringify(payload);
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomBytes(8).toString("hex");
  const signature = signClientRequest(secret, {
    method: "POST",
    path,
    timestamp,
    nonce,
    body: bodyText
  });

  return await tcpRequest(tcpPort, {
    id: crypto.randomBytes(6).toString("hex"),
    action,
    headers: {
      "x-rs-app-id": appId,
      "x-rs-timestamp": timestamp,
      "x-rs-nonce": nonce,
      "x-rs-signature": signature
    },
    bodyText
  });
}

test("commercial license flow works end-to-end", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const product = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "MY_SOFTWARE",
        name: "My Software",
        description: "Desktop commercial edition"
      },
      adminSession.token
    );

    const policy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "MY_SOFTWARE",
        name: "Professional 30D",
        durationDays: 30,
        maxDevices: 1,
        heartbeatIntervalSeconds: 60,
        heartbeatTimeoutSeconds: 180,
        tokenTtlSeconds: 300
      },
      adminSession.token
    );

    const batch = await postJson(
      baseUrl,
      "/api/admin/cards/batch",
      {
        productCode: "MY_SOFTWARE",
        policyId: policy.id,
        count: 1,
        prefix: "MYSOFT"
      },
      adminSession.token
    );

    const cardKey = batch.keys[0];
    assert.ok(cardKey);

    const registration = await signedClientPost(
      baseUrl,
      "/api/client/register",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "MY_SOFTWARE",
        username: "alice",
        password: "StrongPass123"
      }
    );
    assert.equal(registration.username, "alice");

    const recharge = await signedClientPost(
      baseUrl,
      "/api/client/recharge",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "MY_SOFTWARE",
        username: "alice",
        password: "StrongPass123",
        cardKey
      }
    );
    assert.equal(recharge.policyName, "Professional 30D");

    const login = await signedClientPost(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "MY_SOFTWARE",
        username: "alice",
        password: "StrongPass123",
        deviceFingerprint: "device-001-fingerprint",
        deviceName: "Alice PC"
      }
    );

    assert.ok(login.sessionToken);
    assert.ok(login.licenseToken);

    const tokenKey = await getJson(baseUrl, "/api/system/token-key");
    assert.equal(tokenKey.algorithm, "RS256");
    assert.equal(verifyLicenseToken(tokenKey.publicKeyPem, login.licenseToken), true);
    const payload = decodeLicenseTokenPayload(login.licenseToken);
    assert.equal(payload.pid, "MY_SOFTWARE");
    assert.equal(payload.sub, "alice");
    assert.equal(payload.kid, tokenKey.keyId);

    const keysetBefore = await getJson(baseUrl, "/api/system/token-keys");
    assert.equal(keysetBefore.activeKeyId, tokenKey.keyId);
    assert.equal(keysetBefore.keys.length, 1);

    const rotated = await postJson(baseUrl, "/api/admin/token-keys/rotate", {}, adminSession.token);
    assert.notEqual(rotated.activeKeyId, tokenKey.keyId);
    assert.equal(rotated.keys.length, 2);

    const heartbeat = await signedClientPost(
      baseUrl,
      "/api/client/heartbeat",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "MY_SOFTWARE",
        sessionToken: login.sessionToken,
        deviceFingerprint: "device-001-fingerprint"
      }
    );
    assert.equal(heartbeat.status, "active");

    const relogin = await signedClientPost(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "MY_SOFTWARE",
        username: "alice",
        password: "StrongPass123",
        deviceFingerprint: "device-001-fingerprint",
        deviceName: "Alice PC"
      }
    );

    const keysetAfter = await getJson(baseUrl, "/api/system/token-keys");
    assert.equal(keysetAfter.keys.length, 2);
    assert.equal(keysetAfter.activeKeyId, rotated.activeKeyId);

    const oldKey = keysetAfter.keys.find((entry) => entry.keyId === tokenKey.keyId);
    const newKey = keysetAfter.keys.find((entry) => entry.keyId === rotated.activeKeyId);
    assert.ok(oldKey);
    assert.ok(newKey);
    assert.equal(oldKey.status, "retired");
    assert.equal(newKey.status, "active");
    assert.equal(verifyLicenseToken(oldKey.publicKeyPem, login.licenseToken), true);
    assert.equal(verifyLicenseToken(newKey.publicKeyPem, relogin.licenseToken), true);

    const dashboard = await getJson(baseUrl, "/api/admin/dashboard", adminSession.token);
    assert.equal(dashboard.summary.products, 1);
    assert.equal(dashboard.summary.policies, 1);
    assert.equal(dashboard.summary.cardsRedeemed, 1);
    assert.equal(dashboard.summary.accounts, 1);
    assert.equal(dashboard.summary.onlineSessions, 2);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("tcp client license flow works end-to-end", async () => {
  const { app, baseUrl, tcpPort, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const product = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "MY_TCP_APP",
        name: "My TCP App",
        description: "TCP client transport edition"
      },
      adminSession.token
    );

    const policy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "MY_TCP_APP",
        name: "Professional TCP 30D",
        durationDays: 30,
        maxDevices: 1,
        heartbeatIntervalSeconds: 45,
        heartbeatTimeoutSeconds: 120,
        tokenTtlSeconds: 240
      },
      adminSession.token
    );

    const batch = await postJson(
      baseUrl,
      "/api/admin/cards/batch",
      {
        productCode: "MY_TCP_APP",
        policyId: policy.id,
        count: 1,
        prefix: "TCPAPP"
      },
      adminSession.token
    );

    const cardKey = batch.keys[0];
    assert.ok(cardKey);

    const registration = await signedTcpClientCall(
      tcpPort,
      "client.register",
      "/api/client/register",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "MY_TCP_APP",
        username: "bob",
        password: "StrongPass123"
      }
    );
    assert.equal(registration.username, "bob");

    const recharge = await signedTcpClientCall(
      tcpPort,
      "client.recharge",
      "/api/client/recharge",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "MY_TCP_APP",
        username: "bob",
        password: "StrongPass123",
        cardKey
      }
    );
    assert.equal(recharge.policyName, "Professional TCP 30D");

    const login = await signedTcpClientCall(
      tcpPort,
      "client.login",
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "MY_TCP_APP",
        username: "bob",
        password: "StrongPass123",
        deviceFingerprint: "tcp-device-001",
        deviceName: "Bob Workstation"
      }
    );
    assert.ok(login.sessionToken);
    assert.ok(login.licenseToken);

    const tokenKey = await getJson(baseUrl, "/api/system/token-key");
    assert.equal(tokenKey.algorithm, "RS256");
    assert.equal(verifyLicenseToken(tokenKey.publicKeyPem, login.licenseToken), true);
    const payload = decodeLicenseTokenPayload(login.licenseToken);
    assert.equal(payload.pid, "MY_TCP_APP");
    assert.equal(payload.sub, "bob");
    assert.equal(payload.kid, tokenKey.keyId);

    const heartbeat = await signedTcpClientCall(
      tcpPort,
      "client.heartbeat",
      "/api/client/heartbeat",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "MY_TCP_APP",
        sessionToken: login.sessionToken,
        deviceFingerprint: "tcp-device-001"
      }
    );
    assert.equal(heartbeat.status, "active");

    const logout = await signedTcpClientCall(
      tcpPort,
      "client.logout",
      "/api/client/logout",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "MY_TCP_APP",
        sessionToken: login.sessionToken
      }
    );
    assert.equal(logout.status, "logged_out");
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("admin operations can inspect and control accounts, sessions, and device bindings", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const product = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "OPS_APP",
        name: "Ops App",
        description: "Backoffice operations coverage"
      },
      adminSession.token
    );

    const policy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "OPS_APP",
        name: "Operations Plan",
        durationDays: 30,
        maxDevices: 1,
        heartbeatIntervalSeconds: 30,
        heartbeatTimeoutSeconds: 90,
        tokenTtlSeconds: 180
      },
      adminSession.token
    );

    const batch = await postJson(
      baseUrl,
      "/api/admin/cards/batch",
      {
        productCode: "OPS_APP",
        policyId: policy.id,
        count: 1,
        prefix: "OPSAPP"
      },
      adminSession.token
    );

    await signedClientPost(baseUrl, "/api/client/register", product.sdkAppId, product.sdkAppSecret, {
      productCode: "OPS_APP",
      username: "eve",
      password: "StrongPass123"
    });

    await signedClientPost(baseUrl, "/api/client/recharge", product.sdkAppId, product.sdkAppSecret, {
      productCode: "OPS_APP",
      username: "eve",
      password: "StrongPass123",
      cardKey: batch.keys[0]
    });

    const firstLogin = await signedClientPost(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "OPS_APP",
        username: "eve",
        password: "StrongPass123",
        deviceFingerprint: "ops-device-001",
        deviceName: "Ops Workstation"
      }
    );

    const accounts = await getJson(
      baseUrl,
      "/api/admin/accounts?productCode=OPS_APP&status=active",
      adminSession.token
    );
    assert.equal(accounts.total, 1);
    assert.equal(accounts.items[0].username, "eve");
    assert.equal(accounts.items[0].active_session_count, 1);
    assert.equal(accounts.items[0].active_entitlement_count, 1);

    const sessions = await getJson(
      baseUrl,
      "/api/admin/sessions?productCode=OPS_APP&status=active&username=eve",
      adminSession.token
    );
    assert.equal(sessions.total, 1);
    assert.equal(sessions.items[0].fingerprint, "ops-device-001");

    const bindings = await getJson(
      baseUrl,
      "/api/admin/device-bindings?productCode=OPS_APP&username=eve&status=active",
      adminSession.token
    );
    assert.equal(bindings.total, 1);
    assert.equal(bindings.items[0].fingerprint, "ops-device-001");
    assert.equal(bindings.items[0].active_session_count, 1);

    const revokedSession = await postJson(
      baseUrl,
      `/api/admin/sessions/${sessions.items[0].id}/revoke`,
      { reason: "manual_review" },
      adminSession.token
    );
    assert.equal(revokedSession.changed, true);
    assert.equal(revokedSession.revokedReason, "manual_review");

    const heartbeatAfterRevoke = await signedClientPostExpectError(
      baseUrl,
      "/api/client/heartbeat",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "OPS_APP",
        sessionToken: firstLogin.sessionToken,
        deviceFingerprint: "ops-device-001"
      }
    );
    assert.equal(heartbeatAfterRevoke.status, 401);
    assert.equal(heartbeatAfterRevoke.error.code, "SESSION_INVALID");

    const secondLogin = await signedClientPost(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "OPS_APP",
        username: "eve",
        password: "StrongPass123",
        deviceFingerprint: "ops-device-001",
        deviceName: "Ops Workstation"
      }
    );

    const disabledAccount = await postJson(
      baseUrl,
      `/api/admin/accounts/${accounts.items[0].id}/status`,
      { status: "disabled" },
      adminSession.token
    );
    assert.equal(disabledAccount.changed, true);
    assert.equal(disabledAccount.status, "disabled");
    assert.equal(disabledAccount.revokedSessions, 1);

    const disabledLogin = await signedClientPostExpectError(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "OPS_APP",
        username: "eve",
        password: "StrongPass123",
        deviceFingerprint: "ops-device-001",
        deviceName: "Ops Workstation"
      }
    );
    assert.equal(disabledLogin.status, 401);
    assert.equal(disabledLogin.error.code, "ACCOUNT_LOGIN_FAILED");

    const reenabledAccount = await postJson(
      baseUrl,
      `/api/admin/accounts/${accounts.items[0].id}/status`,
      { status: "active" },
      adminSession.token
    );
    assert.equal(reenabledAccount.changed, true);
    assert.equal(reenabledAccount.status, "active");

    const thirdLogin = await signedClientPost(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "OPS_APP",
        username: "eve",
        password: "StrongPass123",
        deviceFingerprint: "ops-device-001",
        deviceName: "Ops Workstation"
      }
    );

    const releasedBinding = await postJson(
      baseUrl,
      `/api/admin/device-bindings/${bindings.items[0].id}/release`,
      { reason: "operator_release" },
      adminSession.token
    );
    assert.equal(releasedBinding.changed, true);
    assert.equal(releasedBinding.status, "revoked");
    assert.equal(releasedBinding.reason, "operator_release");
    assert.equal(releasedBinding.releasedSessions, 1);

    const heartbeatAfterRelease = await signedClientPostExpectError(
      baseUrl,
      "/api/client/heartbeat",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "OPS_APP",
        sessionToken: thirdLogin.sessionToken,
        deviceFingerprint: "ops-device-001"
      }
    );
    assert.equal(heartbeatAfterRelease.status, 401);
    assert.equal(heartbeatAfterRelease.error.code, "SESSION_INVALID");

    const fourthLogin = await signedClientPost(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "OPS_APP",
        username: "eve",
        password: "StrongPass123",
        deviceFingerprint: "ops-device-001",
        deviceName: "Ops Workstation"
      }
    );
    assert.ok(fourthLogin.sessionToken);
    assert.notEqual(fourthLogin.sessionToken, secondLogin.sessionToken);

    const auditLogs = await getJson(baseUrl, "/api/admin/audit-logs?limit=20", adminSession.token);
    const eventTypes = auditLogs.items.map((entry) => entry.event_type);
    assert.ok(eventTypes.includes("session.revoke"));
    assert.ok(eventTypes.includes("account.disable"));
    assert.ok(eventTypes.includes("account.enable"));
    assert.ok(eventTypes.includes("device-binding.release"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("admin can block and unblock a device fingerprint", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const product = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "BLOCK_APP",
        name: "Block App",
        description: "Device blocklist coverage"
      },
      adminSession.token
    );

    const policy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "BLOCK_APP",
        name: "Block Policy",
        durationDays: 30,
        maxDevices: 1,
        heartbeatIntervalSeconds: 30,
        heartbeatTimeoutSeconds: 90,
        tokenTtlSeconds: 180
      },
      adminSession.token
    );

    const batch = await postJson(
      baseUrl,
      "/api/admin/cards/batch",
      {
        productCode: "BLOCK_APP",
        policyId: policy.id,
        count: 1,
        prefix: "BLKAPP"
      },
      adminSession.token
    );

    await signedClientPost(baseUrl, "/api/client/register", product.sdkAppId, product.sdkAppSecret, {
      productCode: "BLOCK_APP",
      username: "mallory",
      password: "StrongPass123"
    });

    await signedClientPost(baseUrl, "/api/client/recharge", product.sdkAppId, product.sdkAppSecret, {
      productCode: "BLOCK_APP",
      username: "mallory",
      password: "StrongPass123",
      cardKey: batch.keys[0]
    });

    const login = await signedClientPost(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "BLOCK_APP",
        username: "mallory",
        password: "StrongPass123",
        deviceFingerprint: "blocked-device-001",
        deviceName: "Mallory PC"
      }
    );

    const blocked = await postJson(
      baseUrl,
      "/api/admin/device-blocks",
      {
        productCode: "BLOCK_APP",
        deviceFingerprint: "blocked-device-001",
        reason: "fraud_risk",
        notes: "manual operator review"
      },
      adminSession.token
    );
    assert.equal(blocked.changed, true);
    assert.equal(blocked.status, "active");
    assert.equal(blocked.reason, "fraud_risk");
    assert.equal(blocked.affectedSessions, 1);
    assert.equal(blocked.affectedBindings, 1);

    const heartbeatAfterBlock = await signedClientPostExpectError(
      baseUrl,
      "/api/client/heartbeat",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "BLOCK_APP",
        sessionToken: login.sessionToken,
        deviceFingerprint: "blocked-device-001"
      }
    );
    assert.equal(heartbeatAfterBlock.status, 401);
    assert.equal(heartbeatAfterBlock.error.code, "SESSION_INVALID");

    const blockedLogin = await signedClientPostExpectError(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "BLOCK_APP",
        username: "mallory",
        password: "StrongPass123",
        deviceFingerprint: "blocked-device-001",
        deviceName: "Mallory PC"
      }
    );
    assert.equal(blockedLogin.status, 403);
    assert.equal(blockedLogin.error.code, "DEVICE_BLOCKED");

    const blocks = await getJson(
      baseUrl,
      "/api/admin/device-blocks?productCode=BLOCK_APP&status=active",
      adminSession.token
    );
    assert.equal(blocks.total, 1);
    assert.equal(blocks.items[0].fingerprint, "blocked-device-001");
    assert.equal(blocks.items[0].reason, "fraud_risk");

    const unblocked = await postJson(
      baseUrl,
      `/api/admin/device-blocks/${blocks.items[0].id}/unblock`,
      {
        reason: "appeal_approved"
      },
      adminSession.token
    );
    assert.equal(unblocked.changed, true);
    assert.equal(unblocked.status, "released");
    assert.equal(unblocked.releaseReason, "appeal_approved");

    const relogin = await signedClientPost(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "BLOCK_APP",
        username: "mallory",
        password: "StrongPass123",
        deviceFingerprint: "blocked-device-001",
        deviceName: "Mallory PC"
      }
    );
    assert.ok(relogin.sessionToken);

    const auditLogs = await getJson(baseUrl, "/api/admin/audit-logs?limit=20", adminSession.token);
    const eventTypes = auditLogs.items.map((entry) => entry.event_type);
    assert.ok(eventTypes.includes("device-block.activate"));
    assert.ok(eventTypes.includes("device-block.release"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client version rules can recommend upgrades and reject outdated clients", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const product = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "VERSION_APP",
        name: "Version App",
        description: "Version management coverage"
      },
      adminSession.token
    );

    const policy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "VERSION_APP",
        name: "Version Policy",
        durationDays: 30,
        maxDevices: 1,
        heartbeatIntervalSeconds: 30,
        heartbeatTimeoutSeconds: 90,
        tokenTtlSeconds: 180
      },
      adminSession.token
    );

    const batch = await postJson(
      baseUrl,
      "/api/admin/cards/batch",
      {
        productCode: "VERSION_APP",
        policyId: policy.id,
        count: 1,
        prefix: "VERAPP"
      },
      adminSession.token
    );

    const version100 = await postJson(
      baseUrl,
      "/api/admin/client-versions",
      {
        productCode: "VERSION_APP",
        version: "1.0.0",
        channel: "stable",
        forceUpdate: false,
        downloadUrl: "https://example.com/version-app/1.0.0"
      },
      adminSession.token
    );
    assert.equal(version100.version, "1.0.0");

    const version110 = await postJson(
      baseUrl,
      "/api/admin/client-versions",
      {
        productCode: "VERSION_APP",
        version: "1.1.0",
        channel: "stable",
        forceUpdate: false,
        downloadUrl: "https://example.com/version-app/1.1.0"
      },
      adminSession.token
    );
    assert.equal(version110.version, "1.1.0");

    const version120 = await postJson(
      baseUrl,
      "/api/admin/client-versions",
      {
        productCode: "VERSION_APP",
        version: "1.2.0",
        channel: "stable",
        forceUpdate: true,
        downloadUrl: "https://example.com/version-app/1.2.0",
        noticeTitle: "关键升级",
        noticeBody: "1.2.0 修复了授权校验与心跳稳定性问题。",
        releaseNotes: "Improve verification stability."
      },
      adminSession.token
    );
    assert.equal(version120.forceUpdate, true);

    const disabledVersion = await postJson(
      baseUrl,
      `/api/admin/client-versions/${version100.id}/status`,
      {
        status: "disabled",
        forceUpdate: false
      },
      adminSession.token
    );
    assert.equal(disabledVersion.status, "disabled");

    const versionList = await getJson(
      baseUrl,
      "/api/admin/client-versions?productCode=VERSION_APP&channel=stable",
      adminSession.token
    );
    assert.equal(versionList.total, 3);

    await signedClientPost(baseUrl, "/api/client/register", product.sdkAppId, product.sdkAppSecret, {
      productCode: "VERSION_APP",
      username: "trent",
      password: "StrongPass123"
    });

    await signedClientPost(baseUrl, "/api/client/recharge", product.sdkAppId, product.sdkAppSecret, {
      productCode: "VERSION_APP",
      username: "trent",
      password: "StrongPass123",
      cardKey: batch.keys[0]
    });

    const manifestFor110 = await signedClientPost(
      baseUrl,
      "/api/client/version-check",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "VERSION_APP",
        clientVersion: "1.1.0",
        channel: "stable"
      }
    );
    assert.equal(manifestFor110.allowed, false);
    assert.equal(manifestFor110.status, "force_update_required");
    assert.equal(manifestFor110.latestVersion, "1.2.0");
    assert.equal(manifestFor110.minimumAllowedVersion, "1.2.0");
    assert.equal(manifestFor110.notice.title, "关键升级");

    const manifestFor100 = await signedClientPost(
      baseUrl,
      "/api/client/version-check",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "VERSION_APP",
        clientVersion: "1.0.0",
        channel: "stable"
      }
    );
    assert.equal(manifestFor100.allowed, false);
    assert.equal(manifestFor100.status, "disabled_version");

    const oldLogin = await signedClientPostExpectError(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "VERSION_APP",
        username: "trent",
        password: "StrongPass123",
        clientVersion: "1.1.0",
        channel: "stable",
        deviceFingerprint: "version-device-001",
        deviceName: "Version PC"
      }
    );
    assert.equal(oldLogin.status, 426);
    assert.equal(oldLogin.error.code, "CLIENT_VERSION_REJECTED");
    assert.equal(oldLogin.error.details.status, "force_update_required");
    assert.equal(oldLogin.error.details.latestVersion, "1.2.0");

    const latestManifest = await signedClientPost(
      baseUrl,
      "/api/client/version-check",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "VERSION_APP",
        clientVersion: "1.2.0",
        channel: "stable"
      }
    );
    assert.equal(latestManifest.allowed, true);
    assert.equal(latestManifest.status, "allowed");

    const latestLogin = await signedClientPost(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "VERSION_APP",
        username: "trent",
        password: "StrongPass123",
        clientVersion: "1.2.0",
        channel: "stable",
        deviceFingerprint: "version-device-001",
        deviceName: "Version PC"
      }
    );
    assert.ok(latestLogin.sessionToken);

    const auditLogs = await getJson(baseUrl, "/api/admin/audit-logs?limit=30", adminSession.token);
    const eventTypes = auditLogs.items.map((entry) => entry.event_type);
    assert.ok(eventTypes.includes("client-version.create"));
    assert.ok(eventTypes.includes("client-version.status"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("client notices can broadcast announcements and temporarily block login", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const product = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "NOTICE_APP",
        name: "Notice App",
        description: "Announcement coverage"
      },
      adminSession.token
    );

    const policy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "NOTICE_APP",
        name: "Notice Policy",
        durationDays: 30,
        maxDevices: 1,
        heartbeatIntervalSeconds: 30,
        heartbeatTimeoutSeconds: 90,
        tokenTtlSeconds: 180
      },
      adminSession.token
    );

    const batch = await postJson(
      baseUrl,
      "/api/admin/cards/batch",
      {
        productCode: "NOTICE_APP",
        policyId: policy.id,
        count: 1,
        prefix: "NOTAPP"
      },
      adminSession.token
    );

    const announcement = await postJson(
      baseUrl,
      "/api/admin/notices",
      {
        productCode: "NOTICE_APP",
        channel: "stable",
        kind: "announcement",
        severity: "info",
        title: "新版本说明",
        body: "欢迎升级到新的授权客户端。",
        actionUrl: "https://example.com/notice",
        status: "active",
        blockLogin: false
      },
      adminSession.token
    );
    assert.equal(announcement.blockLogin, false);

    const maintenance = await postJson(
      baseUrl,
      "/api/admin/notices",
      {
        productCode: "NOTICE_APP",
        channel: "stable",
        kind: "maintenance",
        severity: "critical",
        title: "维护窗口",
        body: "授权服务正在维护，请稍后重试。",
        status: "active",
        blockLogin: true
      },
      adminSession.token
    );
    assert.equal(maintenance.blockLogin, true);

    const notices = await signedClientPost(
      baseUrl,
      "/api/client/notices",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "NOTICE_APP",
        channel: "stable"
      }
    );
    assert.equal(notices.notices.length, 2);
    assert.equal(notices.notices[0].blockLogin, true);
    assert.equal(notices.notices[1].title, "新版本说明");

    await signedClientPost(baseUrl, "/api/client/register", product.sdkAppId, product.sdkAppSecret, {
      productCode: "NOTICE_APP",
      username: "carol",
      password: "StrongPass123"
    });

    await signedClientPost(baseUrl, "/api/client/recharge", product.sdkAppId, product.sdkAppSecret, {
      productCode: "NOTICE_APP",
      username: "carol",
      password: "StrongPass123",
      cardKey: batch.keys[0]
    });

    const blockedLogin = await signedClientPostExpectError(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "NOTICE_APP",
        username: "carol",
        password: "StrongPass123",
        channel: "stable",
        deviceFingerprint: "notice-device-001",
        deviceName: "Carol PC"
      }
    );
    assert.equal(blockedLogin.status, 503);
    assert.equal(blockedLogin.error.code, "LOGIN_BLOCKED_BY_NOTICE");
    assert.equal(blockedLogin.error.details.notices[0].title, "维护窗口");

    const archived = await postJson(
      baseUrl,
      `/api/admin/notices/${maintenance.id}/status`,
      {
        status: "archived",
        blockLogin: false
      },
      adminSession.token
    );
    assert.equal(archived.status, "archived");

    const login = await signedClientPost(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "NOTICE_APP",
        username: "carol",
        password: "StrongPass123",
        channel: "stable",
        deviceFingerprint: "notice-device-001",
        deviceName: "Carol PC"
      }
    );
    assert.ok(login.sessionToken);

    const list = await getJson(
      baseUrl,
      "/api/admin/notices?productCode=NOTICE_APP",
      adminSession.token
    );
    assert.equal(list.total, 2);

    const auditLogs = await getJson(baseUrl, "/api/admin/audit-logs?limit=30", adminSession.token);
    const eventTypes = auditLogs.items.map((entry) => entry.event_type);
    assert.ok(eventTypes.includes("notice.create"));
    assert.ok(eventTypes.includes("notice.status"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("network rules can block login by ip or cidr and recover after archive", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const product = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "SEC_APP",
        name: "Security App",
        description: "Network access rule coverage"
      },
      adminSession.token
    );

    const policy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "SEC_APP",
        name: "Security Policy",
        durationDays: 30,
        maxDevices: 1,
        heartbeatIntervalSeconds: 30,
        heartbeatTimeoutSeconds: 90,
        tokenTtlSeconds: 180
      },
      adminSession.token
    );

    const batch = await postJson(
      baseUrl,
      "/api/admin/cards/batch",
      {
        productCode: "SEC_APP",
        policyId: policy.id,
        count: 1,
        prefix: "SECAPP"
      },
      adminSession.token
    );

    await signedClientPost(baseUrl, "/api/client/register", product.sdkAppId, product.sdkAppSecret, {
      productCode: "SEC_APP",
      username: "dave",
      password: "StrongPass123"
    });

    await signedClientPost(baseUrl, "/api/client/recharge", product.sdkAppId, product.sdkAppSecret, {
      productCode: "SEC_APP",
      username: "dave",
      password: "StrongPass123",
      cardKey: batch.keys[0]
    });

    const rule = await postJson(
      baseUrl,
      "/api/admin/network-rules",
      {
        productCode: "SEC_APP",
        targetType: "cidr",
        pattern: "127.0.0.0/24",
        actionScope: "login",
        status: "active",
        notes: "Local test block"
      },
      adminSession.token
    );
    assert.equal(rule.actionScope, "login");
    assert.equal(rule.pattern, "127.0.0.0/24");

    const rules = await getJson(
      baseUrl,
      "/api/admin/network-rules?productCode=SEC_APP&actionScope=login",
      adminSession.token
    );
    assert.equal(rules.total, 1);

    const blockedLogin = await signedClientPostExpectError(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "SEC_APP",
        username: "dave",
        password: "StrongPass123",
        deviceFingerprint: "sec-device-001",
        deviceName: "Dave PC"
      }
    );
    assert.equal(blockedLogin.status, 403);
    assert.equal(blockedLogin.error.code, "NETWORK_RULE_BLOCKED");
    assert.equal(blockedLogin.error.details.actionScope, "login");

    const archived = await postJson(
      baseUrl,
      `/api/admin/network-rules/${rule.id}/status`,
      { status: "archived" },
      adminSession.token
    );
    assert.equal(archived.status, "archived");

    const login = await signedClientPost(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "SEC_APP",
        username: "dave",
        password: "StrongPass123",
        deviceFingerprint: "sec-device-001",
        deviceName: "Dave PC"
      }
    );
    assert.ok(login.sessionToken);

    const auditLogs = await getJson(baseUrl, "/api/admin/audit-logs?limit=40", adminSession.token);
    const eventTypes = auditLogs.items.map((entry) => entry.event_type);
    assert.ok(eventTypes.includes("network-rule.create"));
    assert.ok(eventTypes.includes("network-rule.status"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reseller inventory can be allocated, tracked, and blocked from new allocation when disabled", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const product = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "RESELLER_APP",
        name: "Reseller App",
        description: "Reseller inventory coverage"
      },
      adminSession.token
    );

    const policy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "RESELLER_APP",
        name: "Reseller Policy",
        durationDays: 30,
        maxDevices: 1,
        heartbeatIntervalSeconds: 30,
        heartbeatTimeoutSeconds: 90,
        tokenTtlSeconds: 180
      },
      adminSession.token
    );

    const reseller = await postJson(
      baseUrl,
      "/api/admin/resellers",
      {
        code: "AGENT_EAST",
        name: "East Region Partner",
        contactName: "Zhang San",
        contactEmail: "agent@example.com",
        notes: "Primary channel partner"
      },
      adminSession.token
    );
    assert.equal(reseller.code, "AGENT_EAST");

    const allocation = await postJson(
      baseUrl,
      `/api/admin/resellers/${reseller.id}/allocate-cards`,
      {
        productCode: "RESELLER_APP",
        policyId: policy.id,
        count: 2,
        prefix: "AGENT1",
        notes: "first channel batch"
      },
      adminSession.token
    );
    assert.equal(allocation.count, 2);
    assert.equal(allocation.keys.length, 2);

    const resellerListBefore = await getJson(
      baseUrl,
      "/api/admin/resellers?status=active&search=AGENT",
      adminSession.token
    );
    assert.equal(resellerListBefore.total, 1);
    assert.equal(resellerListBefore.items[0].totalAllocated, 2);
    assert.equal(resellerListBefore.items[0].freshKeys, 2);
    assert.equal(resellerListBefore.items[0].redeemedKeys, 0);

    const inventoryBefore = await getJson(
      baseUrl,
      `/api/admin/reseller-inventory?resellerId=${encodeURIComponent(reseller.id)}&productCode=RESELLER_APP`,
      adminSession.token
    );
    assert.equal(inventoryBefore.summary.total, 2);
    assert.equal(inventoryBefore.summary.fresh, 2);
    assert.equal(inventoryBefore.summary.redeemed, 0);

    await signedClientPost(baseUrl, "/api/client/register", product.sdkAppId, product.sdkAppSecret, {
      productCode: "RESELLER_APP",
      username: "olivia",
      password: "StrongPass123"
    });

    const recharge = await signedClientPost(
      baseUrl,
      "/api/client/recharge",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "RESELLER_APP",
        username: "olivia",
        password: "StrongPass123",
        cardKey: allocation.keys[0]
      }
    );
    assert.equal(recharge.policyName, "Reseller Policy");
    assert.equal(recharge.reseller.code, "AGENT_EAST");
    assert.equal(recharge.reseller.name, "East Region Partner");

    const inventoryAfter = await getJson(
      baseUrl,
      `/api/admin/reseller-inventory?resellerId=${encodeURIComponent(reseller.id)}&productCode=RESELLER_APP`,
      adminSession.token
    );
    assert.equal(inventoryAfter.summary.total, 2);
    assert.equal(inventoryAfter.summary.fresh, 1);
    assert.equal(inventoryAfter.summary.redeemed, 1);

    const redeemedItem = inventoryAfter.items.find((item) => item.cardKey === allocation.keys[0]);
    assert.ok(redeemedItem);
    assert.equal(redeemedItem.cardStatus, "redeemed");
    assert.equal(redeemedItem.redeemedUsername, "olivia");

    const resellerListAfter = await getJson(
      baseUrl,
      "/api/admin/resellers?search=AGENT_EAST",
      adminSession.token
    );
    assert.equal(resellerListAfter.items[0].freshKeys, 1);
    assert.equal(resellerListAfter.items[0].redeemedKeys, 1);

    const report = await getJson(
      baseUrl,
      `/api/admin/reseller-report?resellerId=${encodeURIComponent(reseller.id)}&productCode=RESELLER_APP`,
      adminSession.token
    );
    assert.equal(report.totals.total, 2);
    assert.equal(report.totals.fresh, 1);
    assert.equal(report.totals.redeemed, 1);
    assert.equal(report.totals.resellerCount, 1);
    assert.equal(report.totals.productCount, 1);
    assert.equal(report.byReseller[0].resellerCode, "AGENT_EAST");
    assert.equal(report.byReseller[0].redeemedKeys, 1);
    assert.equal(report.byProduct[0].productCode, "RESELLER_APP");

    const exported = await getText(
      baseUrl,
      `/api/admin/reseller-inventory/export?resellerId=${encodeURIComponent(reseller.id)}&productCode=RESELLER_APP`,
      adminSession.token
    );
    assert.match(exported.contentType, /^text\/csv/);
    assert.match(exported.body, /resellerCode/);
    assert.match(exported.body, /AGENT_EAST/);
    assert.match(exported.body, /RESELLER_APP/);
    assert.match(exported.body, /olivia/);

    const disabled = await postJson(
      baseUrl,
      `/api/admin/resellers/${reseller.id}/status`,
      { status: "disabled" },
      adminSession.token
    );
    assert.equal(disabled.status, "disabled");
    assert.equal(disabled.changed, true);

    const blockedAllocation = await postJsonExpectError(
      baseUrl,
      `/api/admin/resellers/${reseller.id}/allocate-cards`,
      {
        productCode: "RESELLER_APP",
        policyId: policy.id,
        count: 1,
        prefix: "AGENT1"
      },
      adminSession.token
    );
    assert.equal(blockedAllocation.status, 409);
    assert.equal(blockedAllocation.error.code, "RESELLER_DISABLED");

    const auditLogs = await getJson(baseUrl, "/api/admin/audit-logs?limit=50", adminSession.token);
    const eventTypes = auditLogs.items.map((entry) => entry.event_type);
    assert.ok(eventTypes.includes("reseller.create"));
    assert.ok(eventTypes.includes("reseller.inventory.allocate"));
    assert.ok(eventTypes.includes("reseller.status"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reseller price rules can feed settlement reporting and csv export", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const product = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "FIN_APP",
        name: "Finance App",
        description: "Reseller settlement coverage"
      },
      adminSession.token
    );

    const policy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "FIN_APP",
        name: "Finance Policy",
        durationDays: 30,
        maxDevices: 1,
        heartbeatIntervalSeconds: 30,
        heartbeatTimeoutSeconds: 90,
        tokenTtlSeconds: 180
      },
      adminSession.token
    );

    const reseller = await postJson(
      baseUrl,
      "/api/admin/resellers",
      {
        code: "AGENT_FIN",
        name: "Finance Partner",
        contactName: "Li Si",
        contactEmail: "finance-agent@example.com"
      },
      adminSession.token
    );

    const priceRule = await postJson(
      baseUrl,
      "/api/admin/reseller-price-rules",
      {
        resellerId: reseller.id,
        productCode: "FIN_APP",
        policyId: policy.id,
        currency: "CNY",
        unitPrice: 99,
        unitCost: 40,
        notes: "default desktop settlement"
      },
      adminSession.token
    );
    assert.equal(priceRule.currency, "CNY");
    assert.equal(priceRule.unitPriceCents, 9900);
    assert.equal(priceRule.unitCostCents, 4000);
    assert.equal(priceRule.unitCommissionCents, 5900);

    const rules = await getJson(
      baseUrl,
      `/api/admin/reseller-price-rules?resellerId=${encodeURIComponent(reseller.id)}&productCode=FIN_APP&status=active`,
      adminSession.token
    );
    assert.equal(rules.total, 1);
    assert.equal(rules.items[0].id, priceRule.id);

    const allocation = await postJson(
      baseUrl,
      `/api/admin/resellers/${reseller.id}/allocate-cards`,
      {
        productCode: "FIN_APP",
        policyId: policy.id,
        count: 2,
        prefix: "FINGRP"
      },
      adminSession.token
    );
    assert.equal(allocation.count, 2);
    assert.equal(allocation.pricing.ruleId, priceRule.id);
    assert.equal(allocation.pricing.grossAllocatedCents, 19800);
    assert.equal(allocation.pricing.commissionAllocatedCents, 11800);

    await signedClientPost(baseUrl, "/api/client/register", product.sdkAppId, product.sdkAppSecret, {
      productCode: "FIN_APP",
      username: "iris",
      password: "StrongPass123"
    });

    const recharge = await signedClientPost(
      baseUrl,
      "/api/client/recharge",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "FIN_APP",
        username: "iris",
        password: "StrongPass123",
        cardKey: allocation.keys[0]
      }
    );
    assert.equal(recharge.reseller.code, "AGENT_FIN");

    const settlement = await getJson(
      baseUrl,
      `/api/admin/reseller-settlement-report?resellerId=${encodeURIComponent(reseller.id)}&productCode=FIN_APP`,
      adminSession.token
    );
    assert.equal(settlement.totals.totalKeys, 2);
    assert.equal(settlement.totals.pricedKeys, 2);
    assert.equal(settlement.totals.unpricedKeys, 0);
    assert.equal(settlement.totals.redeemedKeys, 1);
    assert.equal(settlement.totals.pricedRedeemedKeys, 1);
    assert.equal(settlement.totals.grossAllocatedCents, 19800);
    assert.equal(settlement.totals.costAllocatedCents, 8000);
    assert.equal(settlement.totals.commissionAllocatedCents, 11800);
    assert.equal(settlement.totals.grossRedeemedCents, 9900);
    assert.equal(settlement.totals.costRedeemedCents, 4000);
    assert.equal(settlement.totals.commissionRedeemedCents, 5900);
    assert.equal(settlement.byCurrency[0].currency, "CNY");
    assert.equal(settlement.byCurrency[0].grossRedeemedCents, 9900);
    assert.equal(settlement.byReseller[0].resellerCode, "AGENT_FIN");
    assert.equal(settlement.byReseller[0].commissionRedeemedCents, 5900);
    assert.equal(settlement.byProduct[0].productCode, "FIN_APP");

    const exported = await getText(
      baseUrl,
      `/api/admin/reseller-settlement/export?resellerId=${encodeURIComponent(reseller.id)}&productCode=FIN_APP`,
      adminSession.token
    );
    assert.match(exported.contentType, /^text\/csv/);
    assert.match(exported.body, /AGENT_FIN/);
    assert.match(exported.body, /FIN_APP/);
    assert.match(exported.body, /99\.00/);
    assert.match(exported.body, /59\.00/);
    assert.match(exported.body, /iris/);

    const archivedRule = await postJson(
      baseUrl,
      `/api/admin/reseller-price-rules/${priceRule.id}/status`,
      { status: "archived" },
      adminSession.token
    );
    assert.equal(archivedRule.status, "archived");

    const archivedRules = await getJson(
      baseUrl,
      `/api/admin/reseller-price-rules?resellerId=${encodeURIComponent(reseller.id)}&status=archived`,
      adminSession.token
    );
    assert.equal(archivedRules.total, 1);
    assert.equal(archivedRules.items[0].id, priceRule.id);

    const auditLogs = await getJson(baseUrl, "/api/admin/audit-logs?limit=60", adminSession.token);
    const eventTypes = auditLogs.items.map((entry) => entry.event_type);
    assert.ok(eventTypes.includes("reseller-price-rule.create"));
    assert.ok(eventTypes.includes("reseller-price-rule.status"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
