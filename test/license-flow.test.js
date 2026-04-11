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

async function signedClientPost(baseUrl, path, appId, secret, payload, extraHeaders = {}) {
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
      "x-rs-signature": signature,
      ...extraHeaders
    },
    body
  });

  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json.data;
}

async function signedClientPostExpectError(baseUrl, path, appId, secret, payload, extraHeaders = {}) {
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
      "x-rs-signature": signature,
      ...extraHeaders
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

test("card key supports direct login over HTTP while account-redeemed cards stay account-bound", async () => {
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
        code: "CARD_HTTP_APP",
        name: "Card HTTP App",
        description: "Direct card login and account recharge"
      },
      adminSession.token
    );

    const policy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "CARD_HTTP_APP",
        name: "Card 30D",
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
        productCode: "CARD_HTTP_APP",
        policyId: policy.id,
        count: 2,
        prefix: "CARDHTTP"
      },
      adminSession.token
    );

    const directCardKey = batch.keys[0];
    const accountCardKey = batch.keys[1];
    assert.ok(directCardKey);
    assert.ok(accountCardKey);

    const directLogin = await signedClientPost(
      baseUrl,
      "/api/client/card-login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "CARD_HTTP_APP",
        cardKey: directCardKey,
        deviceFingerprint: "card-http-device-001",
        deviceName: "Card Login PC"
      }
    );

    assert.equal(directLogin.authMode, "card");
    assert.ok(directLogin.sessionToken);
    assert.ok(directLogin.licenseToken);
    assert.ok(directLogin.card.maskedKey.endsWith(directCardKey.slice(-4)));
    const directPayload = decodeLicenseTokenPayload(directLogin.licenseToken);
    assert.equal(directPayload.pid, "CARD_HTTP_APP");
    assert.equal(directPayload.am, "card");

    const heartbeat = await signedClientPost(
      baseUrl,
      "/api/client/heartbeat",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "CARD_HTTP_APP",
        sessionToken: directLogin.sessionToken,
        deviceFingerprint: "card-http-device-001"
      }
    );
    assert.equal(heartbeat.status, "active");

    const logout = await signedClientPost(
      baseUrl,
      "/api/client/logout",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "CARD_HTTP_APP",
        sessionToken: directLogin.sessionToken
      }
    );
    assert.equal(logout.status, "logged_out");

    const relogin = await signedClientPost(
      baseUrl,
      "/api/client/card-login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "CARD_HTTP_APP",
        cardKey: directCardKey,
        deviceFingerprint: "card-http-device-001",
        deviceName: "Card Login PC"
      }
    );
    assert.equal(relogin.authMode, "card");
    assert.notEqual(relogin.sessionToken, directLogin.sessionToken);

    await signedClientPost(baseUrl, "/api/client/register", product.sdkAppId, product.sdkAppSecret, {
      productCode: "CARD_HTTP_APP",
      username: "charlie",
      password: "StrongPass123"
    });

    await signedClientPost(baseUrl, "/api/client/recharge", product.sdkAppId, product.sdkAppSecret, {
      productCode: "CARD_HTTP_APP",
      username: "charlie",
      password: "StrongPass123",
      cardKey: accountCardKey
    });

    const accountBoundError = await signedClientPostExpectError(
      baseUrl,
      "/api/client/card-login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "CARD_HTTP_APP",
        cardKey: accountCardKey,
        deviceFingerprint: "card-http-device-002",
        deviceName: "Blocked Card Login"
      }
    );
    assert.equal(accountBoundError.status, 409);
    assert.equal(accountBoundError.error.code, "CARD_BOUND_TO_ACCOUNT");
    assert.equal(accountBoundError.error.details.redeemedUsername, "charlie");
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("tcp card-login flow works end-to-end", async () => {
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
        code: "CARD_TCP_APP",
        name: "Card TCP App",
        description: "Direct card login over TCP"
      },
      adminSession.token
    );

    const policy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "CARD_TCP_APP",
        name: "Card TCP 30D",
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
        productCode: "CARD_TCP_APP",
        policyId: policy.id,
        count: 1,
        prefix: "CARDTCP"
      },
      adminSession.token
    );

    const cardKey = batch.keys[0];
    assert.ok(cardKey);

    const login = await signedTcpClientCall(
      tcpPort,
      "client.card-login",
      "/api/client/card-login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "CARD_TCP_APP",
        cardKey,
        deviceFingerprint: "card-tcp-device-001",
        deviceName: "TCP Card Client"
      }
    );

    assert.equal(login.authMode, "card");
    assert.ok(login.sessionToken);
    assert.ok(login.card.maskedKey.endsWith(cardKey.slice(-4)));
    const payload = decodeLicenseTokenPayload(login.licenseToken);
    assert.equal(payload.pid, "CARD_TCP_APP");
    assert.equal(payload.am, "card");

    const heartbeat = await signedTcpClientCall(
      tcpPort,
      "client.heartbeat",
      "/api/client/heartbeat",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "CARD_TCP_APP",
        sessionToken: login.sessionToken,
        deviceFingerprint: "card-tcp-device-001"
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
        productCode: "CARD_TCP_APP",
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

test("policy runtime config can control multi-open policy and configurable rebind detection", async () => {
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
        code: "REBIND_APP",
        name: "Rebind App",
        description: "Configurable binding detection"
      },
      adminSession.token
    );

    const policy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "REBIND_APP",
        name: "Rebind Policy",
        durationDays: 30,
        maxDevices: 1,
        allowConcurrentSessions: true,
        heartbeatIntervalSeconds: 30,
        heartbeatTimeoutSeconds: 90,
        tokenTtlSeconds: 180,
        bindMode: "selected_fields",
        bindFields: ["machineGuid"]
      },
      adminSession.token
    );

    assert.equal(policy.allowConcurrentSessions, true);
    assert.deepEqual(policy.bindFields, ["machineGuid"]);

    const batch = await postJson(
      baseUrl,
      "/api/admin/cards/batch",
      {
        productCode: "REBIND_APP",
        policyId: policy.id,
        count: 1,
        prefix: "REBIND"
      },
      adminSession.token
    );

    const cardKey = batch.keys[0];
    assert.ok(cardKey);

    await signedClientPost(baseUrl, "/api/client/register", product.sdkAppId, product.sdkAppSecret, {
      productCode: "REBIND_APP",
      username: "dora",
      password: "StrongPass123"
    });

    await signedClientPost(baseUrl, "/api/client/recharge", product.sdkAppId, product.sdkAppSecret, {
      productCode: "REBIND_APP",
      username: "dora",
      password: "StrongPass123",
      cardKey
    });

    const firstLogin = await signedClientPost(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "REBIND_APP",
        username: "dora",
        password: "StrongPass123",
        deviceFingerprint: "rebind-device-a",
        deviceName: "Desk A",
        deviceProfile: {
          machineGuid: "MG-001",
          cpuId: "CPU-A"
        }
      },
      {
        "x-forwarded-for": "198.51.100.10"
      }
    );

    assert.equal(firstLogin.binding.mode, "new_binding");

    const reboundLogin = await signedClientPost(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "REBIND_APP",
        username: "dora",
        password: "StrongPass123",
        deviceFingerprint: "rebind-device-b",
        deviceName: "Desk B",
        deviceProfile: {
          machineGuid: "MG-001",
          cpuId: "CPU-B"
        }
      },
      {
        "x-forwarded-for": "198.51.100.11"
      }
    );

    assert.equal(reboundLogin.binding.mode, "identity_rebound");

    const oldHeartbeat = await signedClientPostExpectError(
      baseUrl,
      "/api/client/heartbeat",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "REBIND_APP",
        sessionToken: firstLogin.sessionToken,
        deviceFingerprint: "rebind-device-a"
      }
    );
    assert.equal(oldHeartbeat.status, 401);
    assert.equal(oldHeartbeat.error.code, "SESSION_INVALID");

    const bindingsAfterRebound = await getJson(
      baseUrl,
      "/api/admin/device-bindings?productCode=REBIND_APP&status=active",
      adminSession.token
    );
    assert.equal(bindingsAfterRebound.total, 1);
    assert.equal(bindingsAfterRebound.items[0].fingerprint, "rebind-device-b");
    assert.deepEqual(bindingsAfterRebound.items[0].matchFields, ["machineGuid"]);

    const runtimeConfig = await postJson(
      baseUrl,
      `/api/admin/policies/${policy.id}/runtime-config`,
      {
        allowConcurrentSessions: false,
        bindMode: "selected_fields",
        bindFields: ["machineGuid", "requestIp"]
      },
      adminSession.token
    );

    assert.equal(runtimeConfig.allowConcurrentSessions, false);
    assert.deepEqual(runtimeConfig.bindFields, ["machineGuid", "requestIp"]);

    const blockedRebind = await signedClientPostExpectError(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "REBIND_APP",
        username: "dora",
        password: "StrongPass123",
        deviceFingerprint: "rebind-device-c",
        deviceName: "Desk C",
        deviceProfile: {
          machineGuid: "MG-001",
          cpuId: "CPU-C"
        }
      },
      {
        "x-forwarded-for": "203.0.113.25"
      }
    );
    assert.equal(blockedRebind.status, 409);
    assert.equal(blockedRebind.error.code, "DEVICE_LIMIT_REACHED");
    assert.deepEqual(blockedRebind.error.details.bindFields, ["machineGuid", "requestIp"]);

    const released = await postJson(
      baseUrl,
      `/api/admin/device-bindings/${bindingsAfterRebound.items[0].id}/release`,
      {
        reason: "operator_rebind_approved"
      },
      adminSession.token
    );
    assert.equal(released.status, "revoked");

    const reboundAfterRelease = await signedClientPost(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "REBIND_APP",
        username: "dora",
        password: "StrongPass123",
        deviceFingerprint: "rebind-device-c",
        deviceName: "Desk C",
        deviceProfile: {
          machineGuid: "MG-001",
          cpuId: "CPU-C"
        }
      },
      {
        "x-forwarded-for": "203.0.113.25"
      }
    );

    assert.equal(reboundAfterRelease.binding.mode, "new_binding");

    const bindingsAfterRelease = await getJson(
      baseUrl,
      "/api/admin/device-bindings?productCode=REBIND_APP&status=active",
      adminSession.token
    );
    assert.equal(bindingsAfterRelease.total, 1);
    assert.equal(bindingsAfterRelease.items[0].fingerprint, "rebind-device-c");
    assert.deepEqual(bindingsAfterRelease.items[0].matchFields, ["machineGuid", "requestIp"]);
    assert.equal(bindingsAfterRelease.items[0].bindRequestIp, "203.0.113.25");
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

test("reseller statements can freeze redeemed settlement items and move to paid", async () => {
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
        code: "STMT_APP",
        name: "Statement App",
        description: "Statement lifecycle coverage"
      },
      adminSession.token
    );

    const policy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "STMT_APP",
        name: "Statement Policy",
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
        code: "AGENT_STMT",
        name: "Statement Partner",
        contactEmail: "stmt@example.com"
      },
      adminSession.token
    );

    const priceRule = await postJson(
      baseUrl,
      "/api/admin/reseller-price-rules",
      {
        resellerId: reseller.id,
        productCode: "STMT_APP",
        policyId: policy.id,
        currency: "CNY",
        unitPrice: 120,
        unitCost: 50
      },
      adminSession.token
    );
    assert.equal(priceRule.unitCommissionCents, 7000);

    const allocation = await postJson(
      baseUrl,
      `/api/admin/resellers/${reseller.id}/allocate-cards`,
      {
        productCode: "STMT_APP",
        policyId: policy.id,
        count: 2,
        prefix: "STMTA1"
      },
      adminSession.token
    );
    assert.equal(allocation.keys.length, 2);

    await signedClientPost(baseUrl, "/api/client/register", product.sdkAppId, product.sdkAppSecret, {
      productCode: "STMT_APP",
      username: "nina",
      password: "StrongPass123"
    });

    await signedClientPost(baseUrl, "/api/client/recharge", product.sdkAppId, product.sdkAppSecret, {
      productCode: "STMT_APP",
      username: "nina",
      password: "StrongPass123",
      cardKey: allocation.keys[0]
    });

    const statement = await postJson(
      baseUrl,
      "/api/admin/reseller-statements",
      {
        resellerId: reseller.id,
        currency: "CNY",
        productCode: "STMT_APP",
        notes: "weekly payout"
      },
      adminSession.token
    );
    assert.equal(statement.status, "draft");
    assert.equal(statement.itemCount, 1);
    assert.equal(statement.grossAmountCents, 12000);
    assert.equal(statement.costAmountCents, 5000);
    assert.equal(statement.commissionAmountCents, 7000);
    assert.equal(statement.productCode, "STMT_APP");

    const statements = await getJson(
      baseUrl,
      `/api/admin/reseller-statements?resellerId=${encodeURIComponent(reseller.id)}&currency=CNY&status=draft`,
      adminSession.token
    );
    assert.equal(statements.total, 1);
    assert.equal(statements.items[0].statementCode, statement.statementCode);

    const items = await getJson(
      baseUrl,
      `/api/admin/reseller-statements/${statement.id}/items`,
      adminSession.token
    );
    assert.equal(items.total, 1);
    assert.equal(items.statement.id, statement.id);
    assert.equal(items.items[0].cardKey, allocation.keys[0]);
    assert.equal(items.items[0].commissionAmountCents, 7000);
    assert.equal(items.items[0].redeemedUsername, "nina");

    const noEligible = await postJsonExpectError(
      baseUrl,
      "/api/admin/reseller-statements",
      {
        resellerId: reseller.id,
        currency: "CNY",
        productCode: "STMT_APP"
      },
      adminSession.token
    );
    assert.equal(noEligible.status, 409);
    assert.equal(noEligible.error.code, "NO_SETTLEMENT_ITEMS");

    const reviewed = await postJson(
      baseUrl,
      `/api/admin/reseller-statements/${statement.id}/status`,
      { status: "reviewed" },
      adminSession.token
    );
    assert.equal(reviewed.status, "reviewed");

    const paid = await postJson(
      baseUrl,
      `/api/admin/reseller-statements/${statement.id}/status`,
      { status: "paid" },
      adminSession.token
    );
    assert.equal(paid.status, "paid");
    assert.ok(paid.paidAt);

    const invalidRollback = await postJsonExpectError(
      baseUrl,
      `/api/admin/reseller-statements/${statement.id}/status`,
      { status: "draft" },
      adminSession.token
    );
    assert.equal(invalidRollback.status, 409);
    assert.equal(invalidRollback.error.code, "INVALID_STATEMENT_TRANSITION");

    const exported = await getText(
      baseUrl,
      `/api/admin/reseller-statements/${statement.id}/export`,
      adminSession.token
    );
    assert.match(exported.contentType, /^text\/csv/);
    assert.match(exported.body, /SETTLE-/);
    assert.match(exported.body, /AGENT_STMT/);
    assert.match(exported.body, /120\.00/);
    assert.match(exported.body, /70\.00/);
    assert.match(exported.body, /nina/);

    const auditLogs = await getJson(baseUrl, "/api/admin/audit-logs?limit=80", adminSession.token);
    const eventTypes = auditLogs.items.map((entry) => entry.event_type);
    assert.ok(eventTypes.includes("reseller-statement.create"));
    assert.ok(eventTypes.includes("reseller-statement.status"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("admin card controls and entitlement lifecycle can freeze, expire, and extend authorization", async () => {
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
        description: "Card and entitlement operations"
      },
      adminSession.token
    );

    const policy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "OPS_APP",
        name: "Ops Policy",
        durationDays: 30,
        maxDevices: 1
      },
      adminSession.token
    );

    const activeBatch = await postJson(
      baseUrl,
      "/api/admin/cards/batch",
      {
        productCode: "OPS_APP",
        policyId: policy.id,
        count: 1,
        prefix: "ACTOPS"
      },
      adminSession.token
    );

    const frozenBatch = await postJson(
      baseUrl,
      "/api/admin/cards/batch",
      {
        productCode: "OPS_APP",
        policyId: policy.id,
        count: 1,
        prefix: "FRZOPS"
      },
      adminSession.token
    );

    const expiredBatch = await postJson(
      baseUrl,
      "/api/admin/cards/batch",
      {
        productCode: "OPS_APP",
        policyId: policy.id,
        count: 1,
        prefix: "EXPOPS",
        expiresAt: new Date(Date.now() - 60_000).toISOString()
      },
      adminSession.token
    );

    await signedClientPost(baseUrl, "/api/client/register", product.sdkAppId, product.sdkAppSecret, {
      productCode: "OPS_APP",
      username: "opsuser",
      password: "Secret123!"
    });

    const cards = await getJson(baseUrl, "/api/admin/cards?productCode=OPS_APP", adminSession.token);
    assert.equal(cards.total, 3);
    assert.equal(cards.summary.unused, 2);
    assert.equal(cards.summary.expired, 1);

    const frozenCard = cards.items.find((item) => item.cardKey === frozenBatch.keys[0]);
    const expiredCard = cards.items.find((item) => item.cardKey === expiredBatch.keys[0]);
    assert.ok(frozenCard);
    assert.ok(expiredCard);
    assert.equal(expiredCard.displayStatus, "expired");

    const exported = await getText(baseUrl, "/api/admin/cards/export?productCode=OPS_APP", adminSession.token);
    assert.match(exported.contentType, /^text\/csv/);
    assert.match(exported.body, /displayStatus/);
    assert.match(exported.body, /OPS_APP/);

    const frozenControl = await postJson(
      baseUrl,
      `/api/admin/cards/${frozenCard.id}/status`,
      { status: "frozen", notes: "manual freeze" },
      adminSession.token
    );
    assert.equal(frozenControl.controlStatus, "frozen");
    assert.equal(frozenControl.displayStatus, "frozen");

    const frozenRecharge = await signedClientPostExpectError(
      baseUrl,
      "/api/client/recharge",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "OPS_APP",
        username: "opsuser",
        password: "Secret123!",
        cardKey: frozenBatch.keys[0]
      }
    );
    assert.equal(frozenRecharge.status, 403);
    assert.equal(frozenRecharge.error.code, "CARD_FROZEN");

    const expiredRecharge = await signedClientPostExpectError(
      baseUrl,
      "/api/client/recharge",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "OPS_APP",
        username: "opsuser",
        password: "Secret123!",
        cardKey: expiredBatch.keys[0]
      }
    );
    assert.equal(expiredRecharge.status, 403);
    assert.equal(expiredRecharge.error.code, "CARD_EXPIRED");

    const recharge = await signedClientPost(
      baseUrl,
      "/api/client/recharge",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "OPS_APP",
        username: "opsuser",
        password: "Secret123!",
        cardKey: activeBatch.keys[0]
      }
    );
    assert.equal(recharge.policyName, "Ops Policy");

    const login = await signedClientPost(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "OPS_APP",
        username: "opsuser",
        password: "Secret123!",
        deviceFingerprint: "ops-device-01",
        deviceName: "Ops Desktop"
      }
    );

    const entitlements = await getJson(
      baseUrl,
      "/api/admin/entitlements?productCode=OPS_APP&username=opsuser",
      adminSession.token
    );
    assert.equal(entitlements.total, 1);
    assert.equal(entitlements.items[0].lifecycleStatus, "active");
    const entitlement = entitlements.items[0];

    const frozenEntitlement = await postJson(
      baseUrl,
      `/api/admin/entitlements/${entitlement.id}/status`,
      { status: "frozen" },
      adminSession.token
    );
    assert.equal(frozenEntitlement.status, "frozen");
    assert.equal(frozenEntitlement.revokedSessions, 1);

    const frozenHeartbeat = await signedClientPostExpectError(
      baseUrl,
      "/api/client/heartbeat",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "OPS_APP",
        sessionToken: login.sessionToken,
        deviceFingerprint: "ops-device-01"
      }
    );
    assert.equal(frozenHeartbeat.status, 401);
    assert.equal(frozenHeartbeat.error.code, "SESSION_INVALID");

    const frozenLogin = await signedClientPostExpectError(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "OPS_APP",
        username: "opsuser",
        password: "Secret123!",
        deviceFingerprint: "ops-device-01",
        deviceName: "Ops Desktop"
      }
    );
    assert.equal(frozenLogin.status, 403);
    assert.equal(frozenLogin.error.code, "LICENSE_FROZEN");

    const extended = await postJson(
      baseUrl,
      `/api/admin/entitlements/${entitlement.id}/extend`,
      { days: 15 },
      adminSession.token
    );
    assert.equal(extended.addedDays, 15);
    assert.ok(new Date(extended.endsAt).getTime() > new Date(entitlement.endsAt).getTime());

    const resumed = await postJson(
      baseUrl,
      `/api/admin/entitlements/${entitlement.id}/status`,
      { status: "active" },
      adminSession.token
    );
    assert.equal(resumed.status, "active");

    const relogin = await signedClientPost(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "OPS_APP",
        username: "opsuser",
        password: "Secret123!",
        deviceFingerprint: "ops-device-01",
        deviceName: "Ops Desktop"
      }
    );
    assert.ok(relogin.sessionToken);

    const auditLogs = await getJson(baseUrl, "/api/admin/audit-logs?limit=120", adminSession.token);
    const eventTypes = auditLogs.items.map((entry) => entry.event_type);
    assert.ok(eventTypes.includes("card.status"));
    assert.ok(eventTypes.includes("entitlement.status"));
    assert.ok(eventTypes.includes("entitlement.extend"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reseller hierarchy can create descendants, transfer inventory, and isolate scope", async () => {
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
        code: "TREE_APP",
        name: "Tree App",
        description: "Hierarchical reseller coverage"
      },
      adminSession.token
    );

    const policy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "TREE_APP",
        name: "Tree Policy",
        durationDays: 30,
        maxDevices: 1
      },
      adminSession.token
    );

    const root = await postJson(
      baseUrl,
      "/api/admin/resellers",
      {
        code: "ROOT_AGENT",
        name: "Root Agent",
        loginUsername: "root.agent",
        loginPassword: "RootPass123!"
      },
      adminSession.token
    );
    assert.equal(root.parentResellerId, null);
    assert.equal(root.loginUser.username, "root.agent");

    await postJson(
      baseUrl,
      `/api/admin/resellers/${root.id}/allocate-cards`,
      {
        productCode: "TREE_APP",
        policyId: policy.id,
        count: 3,
        prefix: "TREEA"
      },
      adminSession.token
    );

    const rootSession = await postJson(baseUrl, "/api/reseller/login", {
      username: "root.agent",
      password: "RootPass123!"
    });

    const resellerMe = await getJson(baseUrl, "/api/reseller/me", rootSession.token);
    assert.equal(resellerMe.reseller.code, "ROOT_AGENT");

    const child = await postJson(
      baseUrl,
      "/api/reseller/resellers",
      {
        code: "CHILD_AGENT",
        name: "Child Agent",
        username: "child.agent",
        password: "ChildPass123!"
      },
      rootSession.token
    );
    assert.equal(child.parentResellerId, root.id);

    const sibling = await postJson(
      baseUrl,
      "/api/reseller/resellers",
      {
        code: "SIB_AGENT",
        name: "Sibling Agent",
        username: "sibling.agent",
        password: "Sibling123!"
      },
      rootSession.token
    );
    assert.equal(sibling.parentResellerId, root.id);

    const rootTree = await getJson(baseUrl, "/api/reseller/resellers?includeDescendants=true", rootSession.token);
    const rootTreeCodes = rootTree.items.map((item) => item.code);
    assert.ok(rootTreeCodes.includes("ROOT_AGENT"));
    assert.ok(rootTreeCodes.includes("CHILD_AGENT"));
    assert.ok(rootTreeCodes.includes("SIB_AGENT"));

    const transferToChild = await postJson(
      baseUrl,
      "/api/reseller/inventory/transfer",
      {
        targetResellerId: child.id,
        productCode: "TREE_APP",
        policyId: policy.id,
        count: 1
      },
      rootSession.token
    );
    assert.equal(transferToChild.count, 1);

    const transferToSibling = await postJson(
      baseUrl,
      "/api/reseller/inventory/transfer",
      {
        targetResellerId: sibling.id,
        productCode: "TREE_APP",
        policyId: policy.id,
        count: 1
      },
      rootSession.token
    );
    assert.equal(transferToSibling.count, 1);

    const childSession = await postJson(baseUrl, "/api/reseller/login", {
      username: "child.agent",
      password: "ChildPass123!"
    });

    const grandchild = await postJson(
      baseUrl,
      "/api/reseller/resellers",
      {
        code: "GRAND_AGENT",
        name: "Grand Agent",
        username: "grand.agent",
        password: "GrandPass123!"
      },
      childSession.token
    );
    assert.equal(grandchild.parentResellerId, child.id);

    const transferToGrandchild = await postJson(
      baseUrl,
      "/api/reseller/inventory/transfer",
      {
        targetResellerId: grandchild.id,
        productCode: "TREE_APP",
        policyId: policy.id,
        count: 1
      },
      childSession.token
    );
    assert.equal(transferToGrandchild.count, 1);

    const rootInventory = await getJson(baseUrl, "/api/reseller/inventory", rootSession.token);
    assert.equal(rootInventory.total, 1);
    assert.equal(rootInventory.items[0].resellerCode, "ROOT_AGENT");

    const rootScopedInventory = await getJson(
      baseUrl,
      "/api/reseller/inventory?includeDescendants=true",
      rootSession.token
    );
    assert.equal(rootScopedInventory.total, 3);
    const scopedCodes = new Set(rootScopedInventory.items.map((item) => item.resellerCode));
    assert.deepEqual(scopedCodes, new Set(["ROOT_AGENT", "SIB_AGENT", "GRAND_AGENT"]));

    const childSelfInventory = await getJson(baseUrl, "/api/reseller/inventory", childSession.token);
    assert.equal(childSelfInventory.total, 0);

    const childScopedInventory = await getJson(
      baseUrl,
      "/api/reseller/inventory?includeDescendants=true",
      childSession.token
    );
    assert.equal(childScopedInventory.total, 1);
    assert.equal(childScopedInventory.items[0].resellerCode, "GRAND_AGENT");

    const childTree = await getJson(
      baseUrl,
      "/api/reseller/resellers?includeDescendants=true",
      childSession.token
    );
    const childTreeCodes = childTree.items.map((item) => item.code);
    assert.ok(childTreeCodes.includes("CHILD_AGENT"));
    assert.ok(childTreeCodes.includes("GRAND_AGENT"));
    assert.ok(!childTreeCodes.includes("ROOT_AGENT"));
    assert.ok(!childTreeCodes.includes("SIB_AGENT"));

    const siblingSession = await postJson(baseUrl, "/api/reseller/login", {
      username: "sibling.agent",
      password: "Sibling123!"
    });
    const siblingInventory = await getJson(baseUrl, "/api/reseller/inventory", siblingSession.token);
    assert.equal(siblingInventory.total, 1);
    assert.equal(siblingInventory.items[0].resellerCode, "SIB_AGENT");

    const childForbidden = await fetch(`${baseUrl}/api/reseller/inventory?resellerId=${encodeURIComponent(sibling.id)}`, {
      headers: { authorization: `Bearer ${childSession.token}` }
    });
    const childForbiddenJson = await childForbidden.json();
    assert.equal(childForbidden.ok, false, JSON.stringify(childForbiddenJson));
    assert.equal(childForbidden.status, 403);
    assert.equal(childForbiddenJson.error.code, "RESELLER_SCOPE_FORBIDDEN");

    const scopedExport = await getText(
      baseUrl,
      "/api/reseller/inventory/export?includeDescendants=true",
      rootSession.token
    );
    assert.match(scopedExport.contentType, /^text\/csv/);
    assert.match(scopedExport.body, /ROOT_AGENT/);
    assert.match(scopedExport.body, /GRAND_AGENT/);

    const auditLogs = await getJson(baseUrl, "/api/admin/audit-logs?limit=160", adminSession.token);
    const eventTypes = auditLogs.items.map((entry) => entry.event_type);
    assert.ok(eventTypes.includes("reseller.child.create"));
    assert.ok(eventTypes.includes("reseller.inventory.transfer"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
