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

async function startServer(overrides = {}) {
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
    serverTokenSecret: "test-secret",
    ...overrides
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

async function getJsonExpectError(baseUrl, path, token = null) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  const json = await response.json();
  assert.equal(response.ok, false, JSON.stringify(json));
  return {
    status: response.status,
    error: json.error
  };
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
    contentDisposition: response.headers.get("content-disposition"),
    body: text
  };
}

async function postText(baseUrl, path, body, token = null) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    contentDisposition: response.headers.get("content-disposition"),
    body: text
  };
}

async function getBinary(baseUrl, path, token = null) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(response.ok, true, body.toString("latin1"));
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    contentDisposition: response.headers.get("content-disposition"),
    body
  };
}

async function postBinary(baseUrl, path, body, token = null) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  const data = Buffer.from(await response.arrayBuffer());
  assert.equal(response.ok, true, data.toString("latin1"));
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    contentDisposition: response.headers.get("content-disposition"),
    body: data
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

test("launch readiness docs include the rehearsal-run evidence action", () => {
  const docs = [
    ["developer-launch-mainline.md", [/Record Launch Rehearsal Run/, /production_launch_rehearsal_run_recent/]],
    ["launch-mainline-rehearsal.md", [/Record Launch Rehearsal Run/, /rehearsal-guide/]],
    ["launch-timeline-playbook.md", [/Record Launch Rehearsal Run/]],
    ["production-launch-checklist.md", [/Record Launch Rehearsal Run/]],
    ["production-operations-runbook.md", [/Record Launch Rehearsal Run/]]
  ];

  for (const [docName, patterns] of docs) {
    const docText = fs.readFileSync(path.join("docs", docName), "utf8");
    for (const pattern of patterns) {
      assert.match(docText, pattern, `${docName} should include ${pattern}`);
    }
  }
});

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

test("client self-unbind can enforce policy quota, deduct days, and work over tcp", async () => {
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
        code: "UNBIND_APP",
        name: "Unbind App",
        description: "Client self-unbind coverage"
      },
      adminSession.token
    );

    const policy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "UNBIND_APP",
        name: "Unbind Policy",
        durationDays: 30,
        maxDevices: 1,
        allowClientUnbind: true,
        clientUnbindLimit: 1,
        clientUnbindWindowDays: 30,
        clientUnbindDeductDays: 3
      },
      adminSession.token
    );
    assert.equal(policy.allowClientUnbind, true);
    assert.equal(policy.clientUnbindDeductDays, 3);

    const cardBatch = await postJson(
      baseUrl,
      "/api/admin/cards/batch",
      {
        productCode: "UNBIND_APP",
        policyId: policy.id,
        count: 1,
        prefix: "UNBIND"
      },
      adminSession.token
    );

    await signedClientPost(baseUrl, "/api/client/register", product.sdkAppId, product.sdkAppSecret, {
      productCode: "UNBIND_APP",
      username: "unbinder",
      password: "Unbind123!"
    });

    await signedClientPost(baseUrl, "/api/client/recharge", product.sdkAppId, product.sdkAppSecret, {
      productCode: "UNBIND_APP",
      username: "unbinder",
      password: "Unbind123!",
      cardKey: cardBatch.keys[0]
    });

    const firstLogin = await signedClientPost(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "UNBIND_APP",
        username: "unbinder",
        password: "Unbind123!",
        deviceFingerprint: "unbind-device-001",
        deviceName: "Old Device"
      }
    );

    const entitlementBefore = await getJson(
      baseUrl,
      "/api/admin/entitlements?productCode=UNBIND_APP&username=unbinder",
      adminSession.token
    );
    const originalEndsAt = entitlementBefore.items[0].endsAt;

    const bindings = await signedClientPost(
      baseUrl,
      "/api/client/bindings",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "UNBIND_APP",
        username: "unbinder",
        password: "Unbind123!"
      }
    );
    assert.equal(bindings.bindings.length, 1);
    assert.equal(bindings.unbindPolicy.allowClientUnbind, true);
    assert.equal(bindings.unbindPolicy.clientUnbindLimit, 1);
    assert.equal(bindings.unbindPolicy.clientUnbindDeductDays, 3);

    const bindingId = bindings.bindings[0].id;
    const tcpUnbind = await signedTcpClientCall(
      tcpPort,
      "client.unbind",
      "/api/client/unbind",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "UNBIND_APP",
        username: "unbinder",
        password: "Unbind123!",
        bindingId
      }
    );
    assert.equal(tcpUnbind.changed, true);
    assert.equal(tcpUnbind.binding.status, "revoked");
    assert.equal(tcpUnbind.unbindPolicy.recentClientUnbinds, 1);
    assert.equal(tcpUnbind.unbindPolicy.remainingClientUnbinds, 0);
    assert.ok(new Date(tcpUnbind.entitlement.endsAt).getTime() < new Date(originalEndsAt).getTime());

    const oldHeartbeat = await signedClientPostExpectError(
      baseUrl,
      "/api/client/heartbeat",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "UNBIND_APP",
        sessionToken: firstLogin.sessionToken,
        deviceFingerprint: "unbind-device-001"
      }
    );
    assert.equal(oldHeartbeat.status, 401);
    assert.equal(oldHeartbeat.error.code, "SESSION_INVALID");

    const secondLogin = await signedClientPost(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "UNBIND_APP",
        username: "unbinder",
        password: "Unbind123!",
        deviceFingerprint: "unbind-device-002",
        deviceName: "New Device"
      }
    );
    assert.ok(secondLogin.sessionToken);

    const secondBindings = await signedTcpClientCall(
      tcpPort,
      "client.bindings",
      "/api/client/bindings",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "UNBIND_APP",
        username: "unbinder",
        password: "Unbind123!"
      }
    );
    assert.equal(secondBindings.bindings.filter((item) => item.status === "active").length, 1);

    const secondUnbind = await signedClientPostExpectError(
      baseUrl,
      "/api/client/unbind",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "UNBIND_APP",
        username: "unbinder",
        password: "Unbind123!",
        deviceFingerprint: "unbind-device-002"
      }
    );
    assert.equal(secondUnbind.status, 429);
    assert.equal(secondUnbind.error.code, "CLIENT_UNBIND_LIMIT_REACHED");

    const auditLogs = await getJson(baseUrl, "/api/admin/audit-logs?limit=80", adminSession.token);
    const eventTypes = auditLogs.items.map((entry) => entry.event_type);
    assert.ok(eventTypes.includes("device-binding.client-unbind"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("point-based policies can consume login credits in account and card-direct modes", async () => {
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
        code: "POINT_APP",
        name: "Point App",
        description: "Point-based authorization coverage"
      },
      adminSession.token
    );

    const policy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "POINT_APP",
        name: "Point Policy",
        grantType: "points",
        grantPoints: 2,
        durationDays: 0,
        maxDevices: 1
      },
      adminSession.token
    );
    assert.equal(policy.grantType, "points");
    assert.equal(policy.grantPoints, 2);

    const cards = await postJson(
      baseUrl,
      "/api/admin/cards/batch",
      {
        productCode: "POINT_APP",
        policyId: policy.id,
        count: 2,
        prefix: "POINT"
      },
      adminSession.token
    );

    await signedClientPost(baseUrl, "/api/client/register", product.sdkAppId, product.sdkAppSecret, {
      productCode: "POINT_APP",
      username: "credit_user",
      password: "Credit123!"
    });

    const recharge = await signedClientPost(
      baseUrl,
      "/api/client/recharge",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "POINT_APP",
        username: "credit_user",
        password: "Credit123!",
        cardKey: cards.keys[0]
      }
    );
    assert.equal(recharge.grantType, "points");
    assert.equal(recharge.totalPoints, 2);
    assert.equal(recharge.remainingPoints, 2);

    const entitlementRows = await getJson(
      baseUrl,
      "/api/admin/entitlements?productCode=POINT_APP&username=credit_user",
      adminSession.token
    );
    assert.equal(entitlementRows.items[0].grantType, "points");
    assert.equal(entitlementRows.items[0].remainingPoints, 2);

    const firstLogin = await signedClientPost(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "POINT_APP",
        username: "credit_user",
        password: "Credit123!",
        deviceFingerprint: "point-device-001",
        deviceName: "Point Device 1"
      }
    );
    assert.equal(firstLogin.quota.grantType, "points");
    assert.equal(firstLogin.quota.remainingPoints, 1);

    await signedClientPost(baseUrl, "/api/client/logout", product.sdkAppId, product.sdkAppSecret, {
      productCode: "POINT_APP",
      sessionToken: firstLogin.sessionToken
    });

    const secondLogin = await signedClientPost(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "POINT_APP",
        username: "credit_user",
        password: "Credit123!",
        deviceFingerprint: "point-device-001",
        deviceName: "Point Device 1"
      }
    );
    assert.equal(secondLogin.quota.remainingPoints, 0);

    await signedClientPost(baseUrl, "/api/client/logout", product.sdkAppId, product.sdkAppSecret, {
      productCode: "POINT_APP",
      sessionToken: secondLogin.sessionToken
    });

    const exhaustedLogin = await signedClientPostExpectError(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "POINT_APP",
        username: "credit_user",
        password: "Credit123!",
        deviceFingerprint: "point-device-001",
        deviceName: "Point Device 1"
      }
    );
    assert.equal(exhaustedLogin.status, 403);
    assert.equal(exhaustedLogin.error.code, "LICENSE_POINTS_EXHAUSTED");

    const cardDirectFirst = await signedClientPost(
      baseUrl,
      "/api/client/card-login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "POINT_APP",
        cardKey: cards.keys[1],
        deviceFingerprint: "point-card-device-001",
        deviceName: "Point Card Device 1"
      }
    );
    assert.equal(cardDirectFirst.quota.grantType, "points");
    assert.equal(cardDirectFirst.quota.remainingPoints, 1);

    await signedClientPost(baseUrl, "/api/client/logout", product.sdkAppId, product.sdkAppSecret, {
      productCode: "POINT_APP",
      sessionToken: cardDirectFirst.sessionToken
    });

    const cardDirectSecond = await signedClientPost(
      baseUrl,
      "/api/client/card-login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "POINT_APP",
        cardKey: cards.keys[1],
        deviceFingerprint: "point-card-device-001",
        deviceName: "Point Card Device 1"
      }
    );
    assert.equal(cardDirectSecond.quota.remainingPoints, 0);

    await signedClientPost(baseUrl, "/api/client/logout", product.sdkAppId, product.sdkAppSecret, {
      productCode: "POINT_APP",
      sessionToken: cardDirectSecond.sessionToken
    });

    const exhaustedCardLogin = await signedClientPostExpectError(
      baseUrl,
      "/api/client/card-login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "POINT_APP",
        cardKey: cards.keys[1],
        deviceFingerprint: "point-card-device-001",
        deviceName: "Point Card Device 1"
      }
    );
    assert.equal(exhaustedCardLogin.status, 403);
    assert.equal(exhaustedCardLogin.error.code, "LICENSE_POINTS_EXHAUSTED");
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("admin can add, subtract, and set remaining points for point entitlements", async () => {
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
        code: "POINT_OPS",
        name: "Point Ops",
        description: "Admin point adjustments"
      },
      adminSession.token
    );

    const policy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "POINT_OPS",
        name: "Point Ops Policy",
        grantType: "points",
        grantPoints: 2,
        durationDays: 0,
        maxDevices: 1
      },
      adminSession.token
    );

    const batch = await postJson(
      baseUrl,
      "/api/admin/cards/batch",
      {
        productCode: "POINT_OPS",
        policyId: policy.id,
        count: 1,
        prefix: "PTOPS"
      },
      adminSession.token
    );

    await signedClientPost(baseUrl, "/api/client/register", product.sdkAppId, product.sdkAppSecret, {
      productCode: "POINT_OPS",
      username: "ops_points_user",
      password: "Points123!"
    });

    await signedClientPost(baseUrl, "/api/client/recharge", product.sdkAppId, product.sdkAppSecret, {
      productCode: "POINT_OPS",
      username: "ops_points_user",
      password: "Points123!",
      cardKey: batch.keys[0]
    });

    const firstLogin = await signedClientPost(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "POINT_OPS",
        username: "ops_points_user",
        password: "Points123!",
        deviceFingerprint: "point-ops-device-001",
        deviceName: "Point Ops Device"
      }
    );
    assert.equal(firstLogin.quota.remainingPoints, 1);

    await signedClientPost(baseUrl, "/api/client/logout", product.sdkAppId, product.sdkAppSecret, {
      productCode: "POINT_OPS",
      sessionToken: firstLogin.sessionToken
    });

    const entitlements = await getJson(
      baseUrl,
      "/api/admin/entitlements?productCode=POINT_OPS&username=ops_points_user&grantType=points",
      adminSession.token
    );
    assert.equal(entitlements.total, 1);
    assert.equal(entitlements.items[0].remainingPoints, 1);
    const entitlementId = entitlements.items[0].id;

    const addResult = await postJson(
      baseUrl,
      `/api/admin/entitlements/${entitlementId}/points`,
      {
        mode: "add",
        points: 3
      },
      adminSession.token
    );
    assert.equal(addResult.previousRemainingPoints, 1);
    assert.equal(addResult.remainingPoints, 4);
    assert.equal(addResult.totalPoints, 5);

    const subtractResult = await postJson(
      baseUrl,
      `/api/admin/entitlements/${entitlementId}/points`,
      {
        mode: "subtract",
        points: 2
      },
      adminSession.token
    );
    assert.equal(subtractResult.previousRemainingPoints, 4);
    assert.equal(subtractResult.remainingPoints, 2);
    assert.equal(subtractResult.totalPoints, 3);

    const setResult = await postJson(
      baseUrl,
      `/api/admin/entitlements/${entitlementId}/points`,
      {
        mode: "set",
        points: 0
      },
      adminSession.token
    );
    assert.equal(setResult.remainingPoints, 0);
    assert.equal(setResult.totalPoints, 1);

    const blockedLogin = await signedClientPostExpectError(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "POINT_OPS",
        username: "ops_points_user",
        password: "Points123!",
        deviceFingerprint: "point-ops-device-001",
        deviceName: "Point Ops Device"
      }
    );
    assert.equal(blockedLogin.status, 403);
    assert.equal(blockedLogin.error.code, "LICENSE_POINTS_EXHAUSTED");

    const finalEntitlements = await getJson(
      baseUrl,
      "/api/admin/entitlements?productCode=POINT_OPS&username=ops_points_user&grantType=points",
      adminSession.token
    );
    assert.equal(finalEntitlements.items[0].remainingPoints, 0);
    assert.equal(finalEntitlements.items[0].consumedPoints, 1);

    const auditLogs = await getJson(baseUrl, "/api/admin/audit-logs?limit=100", adminSession.token);
    const eventTypes = auditLogs.items.map((entry) => entry.event_type);
    assert.ok(eventTypes.includes("entitlement.points.adjust"));
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

    const startupBootstrap = await signedClientPost(
      baseUrl,
      "/api/client/startup-bootstrap",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "VERSION_APP",
        clientVersion: "1.1.0",
        channel: "stable",
        includeTokenKeys: true
      }
    );
    assert.equal(startupBootstrap.versionManifest.status, "force_update_required");
    assert.equal(startupBootstrap.versionManifest.minimumAllowedVersion, "1.2.0");
    assert.equal(startupBootstrap.notices.notices.length, 0);
    assert.equal(startupBootstrap.hasTokenKeys, true);
    assert.equal(startupBootstrap.activeTokenKey.keyId, startupBootstrap.tokenKeys.activeKeyId);
    assert.ok(startupBootstrap.tokenKeys.keys.length > 0);

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

    const startupBootstrap = await signedClientPost(
      baseUrl,
      "/api/client/startup-bootstrap",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "NOTICE_APP",
        clientVersion: "1.0.0",
        channel: "stable",
        includeTokenKeys: true
      }
    );
    assert.equal(startupBootstrap.versionManifest.status, "no_version_rules");
    assert.equal(startupBootstrap.notices.notices.length, 2);
    assert.equal(startupBootstrap.notices.notices[0].blockLogin, true);
    assert.equal(startupBootstrap.hasTokenKeys, true);
    assert.equal(startupBootstrap.activeTokenKey.keyId, startupBootstrap.tokenKeys.activeKeyId);

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

test("developers can manage scoped network rules while operators stay read-only", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "sec.owner",
        password: "SecOwner123!",
        displayName: "Security Owner"
      },
      adminSession.token
    );

    const product = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "DEV_SEC_APP",
        name: "Developer Security App",
        ownerDeveloperId: owner.id
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "sec.owner",
      password: "SecOwner123!"
    });

    const policy = await postJson(
      baseUrl,
      "/api/developer/policies",
      {
        productCode: "DEV_SEC_APP",
        name: "Developer Security Policy",
        durationDays: 30,
        maxDevices: 1
      },
      ownerSession.token
    );

    const batch = await postJson(
      baseUrl,
      "/api/developer/cards/batch",
      {
        productCode: "DEV_SEC_APP",
        policyId: policy.id,
        count: 1,
        prefix: "DEVSEC"
      },
      ownerSession.token
    );

    await signedClientPost(baseUrl, "/api/client/register", product.sdkAppId, product.sdkAppSecret, {
      productCode: "DEV_SEC_APP",
      username: "secdevuser",
      password: "StrongPass123"
    });

    await signedClientPost(baseUrl, "/api/client/recharge", product.sdkAppId, product.sdkAppSecret, {
      productCode: "DEV_SEC_APP",
      username: "secdevuser",
      password: "StrongPass123",
      cardKey: batch.keys[0]
    });

    await postJson(
      baseUrl,
      "/api/developer/members",
      {
        username: "sec.operator",
        password: "SecOperator123!",
        displayName: "Security Operator",
        role: "operator",
        productCodes: ["DEV_SEC_APP"]
      },
      ownerSession.token
    );

    const operatorSession = await postJson(baseUrl, "/api/developer/login", {
      username: "sec.operator",
      password: "SecOperator123!"
    });

    const createdRule = await postJson(
      baseUrl,
      "/api/developer/network-rules",
      {
        productCode: "DEV_SEC_APP",
        targetType: "cidr",
        pattern: "127.0.0.0/24",
        actionScope: "login",
        status: "active",
        notes: "Developer local block"
      },
      ownerSession.token
    );
    assert.equal(createdRule.productCode, "DEV_SEC_APP");
    assert.equal(createdRule.actionScope, "login");

    const operatorRules = await getJson(
      baseUrl,
      "/api/developer/network-rules?productCode=DEV_SEC_APP&actionScope=login",
      operatorSession.token
    );
    assert.equal(operatorRules.total, 1);
    assert.equal(operatorRules.items[0].pattern, "127.0.0.0/24");

    const operatorCreateForbidden = await postJsonExpectError(
      baseUrl,
      "/api/developer/network-rules",
      {
        productCode: "DEV_SEC_APP",
        targetType: "ip",
        pattern: "127.0.0.1",
        actionScope: "heartbeat"
      },
      operatorSession.token
    );
    assert.equal(operatorCreateForbidden.status, 403);
    assert.equal(operatorCreateForbidden.error.code, "DEVELOPER_NETWORK_RULE_FORBIDDEN");

    const blockedLogin = await signedClientPostExpectError(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "DEV_SEC_APP",
        username: "secdevuser",
        password: "StrongPass123",
        deviceFingerprint: "dev-sec-device-001",
        deviceName: "Security Desktop"
      }
    );
    assert.equal(blockedLogin.status, 403);
    assert.equal(blockedLogin.error.code, "NETWORK_RULE_BLOCKED");

    const operatorArchiveForbidden = await postJsonExpectError(
      baseUrl,
      `/api/developer/network-rules/${createdRule.id}/status`,
      { status: "archived" },
      operatorSession.token
    );
    assert.equal(operatorArchiveForbidden.status, 403);
    assert.equal(operatorArchiveForbidden.error.code, "DEVELOPER_NETWORK_RULE_FORBIDDEN");

    const archivedRule = await postJson(
      baseUrl,
      `/api/developer/network-rules/${createdRule.id}/status`,
      { status: "archived" },
      ownerSession.token
    );
    assert.equal(archivedRule.status, "archived");

    const login = await signedClientPost(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "DEV_SEC_APP",
        username: "secdevuser",
        password: "StrongPass123",
        deviceFingerprint: "dev-sec-device-001",
        deviceName: "Security Desktop"
      }
    );
    assert.ok(login.sessionToken);

    const auditLogs = await getJson(baseUrl, "/api/developer/audit-logs?limit=80", ownerSession.token);
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

test("product feature config can selectively disable client-facing capabilities", async () => {
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
        code: "FEATURE_APP",
        name: "Feature App",
        description: "Product-level capability toggles"
      },
      adminSession.token
    );
    assert.equal(product.featureConfig.allowRegister, true);
    assert.equal(product.featureConfig.allowAccountLogin, true);
    assert.equal(product.featureConfig.allowCardLogin, true);
    assert.equal(product.featureConfig.allowCardRecharge, true);
    assert.equal(product.featureConfig.allowVersionCheck, true);
    assert.equal(product.featureConfig.allowNotices, true);
    assert.equal(product.featureConfig.allowClientUnbind, true);
    assert.equal(product.featureConfig.requireStartupBootstrap, true);
    assert.equal(product.featureConfig.requireLocalTokenValidation, true);
    assert.equal(product.featureConfig.requireHeartbeatGate, true);

    const policy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "FEATURE_APP",
        name: "Feature Policy",
        durationDays: 30,
        maxDevices: 1,
        heartbeatIntervalSeconds: 30,
        heartbeatTimeoutSeconds: 90,
        tokenTtlSeconds: 180
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      `/api/admin/policies/${policy.id}/unbind-config`,
      {
        allowClientUnbind: true,
        clientUnbindLimit: 2,
        clientUnbindWindowDays: 30,
        clientUnbindDeductDays: 0
      },
      adminSession.token
    );

    const batch = await postJson(
      baseUrl,
      "/api/admin/cards/batch",
      {
        productCode: "FEATURE_APP",
        policyId: policy.id,
        count: 3,
        prefix: "FEATOG"
      },
      adminSession.token
    );

    await signedClientPost(baseUrl, "/api/client/register", product.sdkAppId, product.sdkAppSecret, {
      productCode: "FEATURE_APP",
      username: "featureuser",
      password: "StrongPass123"
    });

    await signedClientPost(baseUrl, "/api/client/recharge", product.sdkAppId, product.sdkAppSecret, {
      productCode: "FEATURE_APP",
      username: "featureuser",
      password: "StrongPass123",
      cardKey: batch.keys[0]
    });

    await postJson(
      baseUrl,
      "/api/admin/client-versions",
      {
        productCode: "FEATURE_APP",
        version: "2.0.0",
        channel: "stable",
        status: "active",
        forceUpdate: true,
        downloadUrl: "https://example.com/feature-app-2.0.0.zip",
        noticeTitle: "Upgrade Required",
        noticeBody: "Please update to continue."
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/notices",
      {
        productCode: "FEATURE_APP",
        channel: "stable",
        kind: "maintenance",
        severity: "critical",
        title: "Maintenance Window",
        body: "Login should be blocked while notices are enabled.",
        status: "active",
        blockLogin: true
      },
      adminSession.token
    );

    const passiveToggleUpdate = await postJson(
      baseUrl,
      `/api/admin/products/${product.id}/feature-config`,
      {
        allowVersionCheck: false,
        allowNotices: false,
        requireLocalTokenValidation: false
      },
      adminSession.token
    );
    assert.equal(passiveToggleUpdate.featureConfig.allowVersionCheck, false);
    assert.equal(passiveToggleUpdate.featureConfig.allowNotices, false);
    assert.equal(passiveToggleUpdate.featureConfig.allowAccountLogin, true);
    assert.equal(passiveToggleUpdate.featureConfig.requireLocalTokenValidation, false);

    const manifest = await signedClientPost(
      baseUrl,
      "/api/client/version-check",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "FEATURE_APP",
        clientVersion: "1.0.0",
        channel: "stable"
      }
    );
    assert.equal(manifest.enabled, false);
    assert.equal(manifest.allowed, true);
    assert.equal(manifest.status, "disabled_by_product");

    const notices = await signedClientPost(
      baseUrl,
      "/api/client/notices",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "FEATURE_APP",
        channel: "stable"
      }
    );
    assert.equal(notices.enabled, false);
    assert.equal(notices.status, "disabled_by_product");
    assert.equal(notices.notices.length, 0);

    const startupBootstrap = await signedClientPost(
      baseUrl,
      "/api/client/startup-bootstrap",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "FEATURE_APP",
        clientVersion: "1.0.0",
        channel: "stable",
        includeTokenKeys: false
      }
    );
    assert.equal(startupBootstrap.versionManifest.enabled, false);
    assert.equal(startupBootstrap.notices.enabled, false);
    assert.equal(startupBootstrap.hasTokenKeys, false);
    assert.ok(startupBootstrap.activeTokenKey.keyId);

    const loginWhileChecksDisabled = await signedClientPost(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "FEATURE_APP",
        username: "featureuser",
        password: "StrongPass123",
        clientVersion: "1.0.0",
        channel: "stable",
        deviceFingerprint: "feature-device-01",
        deviceName: "Feature PC"
      }
    );
    assert.ok(loginWhileChecksDisabled.sessionToken);

    const restrictiveToggleUpdate = await postJson(
      baseUrl,
      `/api/admin/products/${product.id}/feature-config`,
      {
        allowRegister: false,
        allowAccountLogin: false,
        allowCardLogin: false,
        allowCardRecharge: false,
        allowClientUnbind: false,
        requireStartupBootstrap: false,
        requireHeartbeatGate: false
      },
      adminSession.token
    );
    assert.equal(restrictiveToggleUpdate.featureConfig.allowRegister, false);
    assert.equal(restrictiveToggleUpdate.featureConfig.allowAccountLogin, false);
    assert.equal(restrictiveToggleUpdate.featureConfig.allowCardLogin, false);
    assert.equal(restrictiveToggleUpdate.featureConfig.allowCardRecharge, false);
    assert.equal(restrictiveToggleUpdate.featureConfig.allowClientUnbind, false);
    assert.equal(restrictiveToggleUpdate.featureConfig.allowVersionCheck, false);
    assert.equal(restrictiveToggleUpdate.featureConfig.allowNotices, false);
    assert.equal(restrictiveToggleUpdate.featureConfig.requireStartupBootstrap, false);
    assert.equal(restrictiveToggleUpdate.featureConfig.requireLocalTokenValidation, false);
    assert.equal(restrictiveToggleUpdate.featureConfig.requireHeartbeatGate, false);

    const productList = await getJson(baseUrl, "/api/admin/products", adminSession.token);
    const listedProduct = productList.find((item) => item.code === "FEATURE_APP");
    assert.ok(listedProduct);
    assert.equal(listedProduct.featureConfig.allowRegister, false);
    assert.equal(listedProduct.featureConfig.allowVersionCheck, false);
    assert.equal(listedProduct.featureConfig.allowNotices, false);
    assert.equal(listedProduct.featureConfig.requireStartupBootstrap, false);
    assert.equal(listedProduct.featureConfig.requireLocalTokenValidation, false);
    assert.equal(listedProduct.featureConfig.requireHeartbeatGate, false);

    const registerDisabled = await signedClientPostExpectError(
      baseUrl,
      "/api/client/register",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "FEATURE_APP",
        username: "blockeduser",
        password: "StrongPass123"
      }
    );
    assert.equal(registerDisabled.status, 403);
    assert.equal(registerDisabled.error.code, "ACCOUNT_REGISTER_DISABLED");

    const rechargeDisabled = await signedClientPostExpectError(
      baseUrl,
      "/api/client/recharge",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "FEATURE_APP",
        username: "featureuser",
        password: "StrongPass123",
        cardKey: batch.keys[1]
      }
    );
    assert.equal(rechargeDisabled.status, 403);
    assert.equal(rechargeDisabled.error.code, "CARD_RECHARGE_DISABLED");

    const accountLoginDisabled = await signedClientPostExpectError(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "FEATURE_APP",
        username: "featureuser",
        password: "StrongPass123",
        clientVersion: "1.0.0",
        channel: "stable",
        deviceFingerprint: "feature-device-02",
        deviceName: "Feature Laptop"
      }
    );
    assert.equal(accountLoginDisabled.status, 403);
    assert.equal(accountLoginDisabled.error.code, "ACCOUNT_LOGIN_DISABLED_BY_PRODUCT");

    const cardLoginDisabled = await signedClientPostExpectError(
      baseUrl,
      "/api/client/card-login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "FEATURE_APP",
        cardKey: batch.keys[2],
        clientVersion: "1.0.0",
        channel: "stable",
        deviceFingerprint: "feature-card-device-01",
        deviceName: "Card Login PC"
      }
    );
    assert.equal(cardLoginDisabled.status, 403);
    assert.equal(cardLoginDisabled.error.code, "CARD_LOGIN_DISABLED_BY_PRODUCT");

    const bindings = await signedClientPost(
      baseUrl,
      "/api/client/bindings",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "FEATURE_APP",
        username: "featureuser",
        password: "StrongPass123"
      }
    );
    assert.equal(bindings.unbindPolicy.allowClientUnbind, false);
    assert.equal(bindings.unbindPolicy.productFeatureEnabled, false);

    const unbindDisabled = await signedClientPostExpectError(
      baseUrl,
      "/api/client/unbind",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "FEATURE_APP",
        username: "featureuser",
        password: "StrongPass123",
        bindingId: loginWhileChecksDisabled.binding.id
      }
    );
    assert.equal(unbindDisabled.status, 403);
    assert.equal(unbindDisabled.error.code, "CLIENT_UNBIND_DISABLED_BY_PRODUCT");

    const auditLogs = await getJson(baseUrl, "/api/admin/audit-logs?limit=80", adminSession.token);
    const eventTypes = auditLogs.items.map((entry) => entry.event_type);
    assert.ok(eventTypes.includes("product.feature-config"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("product code can also be addressed as projectCode or softwareCode", async () => {
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
        code: "ALIAS_APP",
        name: "Alias App",
        description: "Project/software code alias coverage"
      },
      adminSession.token
    );
    assert.equal(product.code, "ALIAS_APP");
    assert.equal(product.projectCode, "ALIAS_APP");
    assert.equal(product.softwareCode, "ALIAS_APP");

    const policy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        projectCode: "ALIAS_APP",
        name: "Alias Policy",
        durationDays: 30,
        maxDevices: 1
      },
      adminSession.token
    );

    const batch = await postJson(
      baseUrl,
      "/api/admin/cards/batch",
      {
        softwareCode: "ALIAS_APP",
        policyId: policy.id,
        count: 1,
        prefix: "ALIASX"
      },
      adminSession.token
    );

    const registration = await signedClientPost(
      baseUrl,
      "/api/client/register",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        softwareCode: "ALIAS_APP",
        username: "aliasuser",
        password: "StrongPass123"
      }
    );
    assert.equal(registration.productCode, "ALIAS_APP");

    const recharge = await signedClientPost(
      baseUrl,
      "/api/client/recharge",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        projectCode: "ALIAS_APP",
        username: "aliasuser",
        password: "StrongPass123",
        cardKey: batch.keys[0]
      }
    );
    assert.equal(recharge.policyName, "Alias Policy");

    const login = await signedClientPost(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        projectCode: "ALIAS_APP",
        username: "aliasuser",
        password: "StrongPass123",
        deviceFingerprint: "alias-device-01",
        deviceName: "Alias Desktop"
      }
    );
    assert.ok(login.sessionToken);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer accounts can manage only their own projects", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const alice = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "alice.dev",
        password: "AlicePass123!",
        displayName: "Alice"
      },
      adminSession.token
    );

    const bob = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "bob.dev",
        password: "BobPass123!",
        displayName: "Bob"
      },
      adminSession.token
    );

    const developers = await getJson(baseUrl, "/api/admin/developers", adminSession.token);
    assert.equal(developers.total, 2);
    assert.ok(developers.items.some((item) => item.username === "alice.dev"));
    assert.ok(developers.items.some((item) => item.username === "bob.dev"));

    const assignedByAdmin = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "ALICE_ASSIGNED",
        name: "Alice Assigned Project",
        ownerDeveloperId: alice.id
      },
      adminSession.token
    );
    assert.equal(assignedByAdmin.ownerDeveloper.id, alice.id);

    const aliceSession = await postJson(baseUrl, "/api/developer/login", {
      username: "alice.dev",
      password: "AlicePass123!"
    });
    const bobSession = await postJson(baseUrl, "/api/developer/login", {
      username: "bob.dev",
      password: "BobPass123!"
    });

    const aliceMe = await getJson(baseUrl, "/api/developer/me", aliceSession.token);
    assert.equal(aliceMe.developer.username, "alice.dev");

    const aliceOwned = await postJson(
      baseUrl,
      "/api/developer/products",
      {
        code: "ALICE_SELF",
        name: "Alice Self Project",
        description: "Owned by Alice",
        featureConfig: {
          allowCardLogin: false
        }
      },
      aliceSession.token
    );
    assert.equal(aliceOwned.ownerDeveloper.id, alice.id);
    assert.equal(aliceOwned.featureConfig.allowCardLogin, false);

    const bobOwned = await postJson(
      baseUrl,
      "/api/developer/products",
      {
        code: "BOB_SELF",
        name: "Bob Self Project"
      },
      bobSession.token
    );
    assert.equal(bobOwned.ownerDeveloper.id, bob.id);

    const aliceProjects = await getJson(baseUrl, "/api/developer/products", aliceSession.token);
    assert.equal(aliceProjects.length, 2);
    assert.ok(aliceProjects.some((item) => item.code === "ALICE_ASSIGNED"));
    assert.ok(aliceProjects.some((item) => item.code === "ALICE_SELF"));
    assert.ok(!aliceProjects.some((item) => item.code === "BOB_SELF"));

    const bobProjects = await getJson(baseUrl, "/api/developer/products", bobSession.token);
    assert.equal(bobProjects.length, 1);
    assert.equal(bobProjects[0].code, "BOB_SELF");

    const aliceToggleUpdate = await postJson(
      baseUrl,
      `/api/developer/products/${aliceOwned.id}/feature-config`,
      {
        allowNotices: false,
        allowVersionCheck: false
      },
      aliceSession.token
    );
    assert.equal(aliceToggleUpdate.featureConfig.allowNotices, false);
    assert.equal(aliceToggleUpdate.featureConfig.allowVersionCheck, false);

    const forbiddenUpdate = await postJsonExpectError(
      baseUrl,
      `/api/developer/products/${aliceOwned.id}/feature-config`,
      {
        allowRegister: false
      },
      bobSession.token
    );
    assert.equal(forbiddenUpdate.status, 403);
    assert.equal(forbiddenUpdate.error.code, "DEVELOPER_PRODUCT_FORBIDDEN");

    const transferred = await postJson(
      baseUrl,
      `/api/admin/products/${assignedByAdmin.id}/owner`,
      {
        ownerDeveloperId: bob.id
      },
      adminSession.token
    );
    assert.equal(transferred.ownerDeveloper.id, bob.id);

    const aliceProjectsAfterTransfer = await getJson(baseUrl, "/api/developer/products", aliceSession.token);
    assert.equal(aliceProjectsAfterTransfer.length, 1);
    assert.equal(aliceProjectsAfterTransfer[0].code, "ALICE_SELF");

    const bobProjectsAfterTransfer = await getJson(baseUrl, "/api/developer/products", bobSession.token);
    assert.equal(bobProjectsAfterTransfer.length, 2);
    assert.ok(bobProjectsAfterTransfer.some((item) => item.code === "ALICE_ASSIGNED"));
    assert.ok(bobProjectsAfterTransfer.some((item) => item.code === "BOB_SELF"));

    const auditLogs = await getJson(baseUrl, "/api/admin/audit-logs?limit=60", adminSession.token);
    const eventTypes = auditLogs.items.map((entry) => entry.event_type);
    assert.ok(eventTypes.includes("developer.create"));
    assert.ok(eventTypes.includes("product.owner.update"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer-owned projects can manage policies, cards, versions, and notices within scope", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const alice = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "alice.ops",
        password: "AliceOps123!",
        displayName: "Alice Ops"
      },
      adminSession.token
    );

    const bob = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "bob.ops",
        password: "BobOps123!",
        displayName: "Bob Ops"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "ALICE_OPS_APP",
        name: "Alice Ops App",
        ownerDeveloperId: alice.id
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "BOB_OPS_APP",
        name: "Bob Ops App",
        ownerDeveloperId: bob.id
      },
      adminSession.token
    );

    const aliceSession = await postJson(baseUrl, "/api/developer/login", {
      username: "alice.ops",
      password: "AliceOps123!"
    });

    const alicePolicy = await postJson(
      baseUrl,
      "/api/developer/policies",
      {
        productCode: "ALICE_OPS_APP",
        name: "Alice Policy",
        durationDays: 31,
        maxDevices: 2,
        bindMode: "selected_fields",
        bindFields: ["machineGuid"],
        allowConcurrentSessions: true,
        allowClientUnbind: true,
        clientUnbindLimit: 2,
        clientUnbindWindowDays: 30
      },
      aliceSession.token
    );
    assert.equal(alicePolicy.productCode, "ALICE_OPS_APP");
    assert.equal(alicePolicy.bindMode, "selected_fields");

    const bobPolicy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "BOB_OPS_APP",
        name: "Bob Policy",
        durationDays: 15,
        maxDevices: 1
      },
      adminSession.token
    );

    const alicePolicies = await getJson(baseUrl, "/api/developer/policies", aliceSession.token);
    assert.equal(alicePolicies.length, 1);
    assert.equal(alicePolicies[0].productCode, "ALICE_OPS_APP");
    assert.equal(alicePolicies[0].name, "Alice Policy");

    const aliceRuntime = await postJson(
      baseUrl,
      `/api/developer/policies/${alicePolicy.id}/runtime-config`,
      {
        allowConcurrentSessions: false,
        bindMode: "selected_fields",
        bindFields: ["machineGuid", "requestIp"]
      },
      aliceSession.token
    );
    assert.equal(aliceRuntime.allowConcurrentSessions, false);
    assert.deepEqual(aliceRuntime.bindFields, ["machineGuid", "requestIp"]);

    const aliceUnbind = await postJson(
      baseUrl,
      `/api/developer/policies/${alicePolicy.id}/unbind-config`,
      {
        allowClientUnbind: true,
        clientUnbindLimit: 3,
        clientUnbindWindowDays: 60,
        clientUnbindDeductDays: 1
      },
      aliceSession.token
    );
    assert.equal(aliceUnbind.clientUnbindLimit, 3);

    const forbiddenPolicyRuntime = await postJsonExpectError(
      baseUrl,
      `/api/developer/policies/${bobPolicy.id}/runtime-config`,
      {
        allowConcurrentSessions: false
      },
      aliceSession.token
    );
    assert.equal(forbiddenPolicyRuntime.status, 403);
    assert.equal(forbiddenPolicyRuntime.error.code, "DEVELOPER_POLICY_FORBIDDEN");

    const aliceBatch = await postJson(
      baseUrl,
      "/api/developer/cards/batch",
      {
        productCode: "ALICE_OPS_APP",
        policyId: alicePolicy.id,
        count: 2,
        prefix: "ALOPS"
      },
      aliceSession.token
    );
    assert.equal(aliceBatch.count, 2);
    assert.equal(aliceBatch.keys.length, 2);

    await postJson(
      baseUrl,
      "/api/admin/cards/batch",
      {
        productCode: "BOB_OPS_APP",
        policyId: bobPolicy.id,
        count: 1,
        prefix: "BOBOPS"
      },
      adminSession.token
    );

    const aliceCards = await getJson(baseUrl, "/api/developer/cards?productCode=ALICE_OPS_APP", aliceSession.token);
    assert.equal(aliceCards.items.length, 2);
    assert.ok(aliceCards.items.every((item) => item.productCode === "ALICE_OPS_APP"));

    const aliceCardStatus = await postJson(
      baseUrl,
      `/api/developer/cards/${aliceCards.items[0].id}/status`,
      {
        status: "frozen",
        notes: "developer_test"
      },
      aliceSession.token
    );
    assert.equal(aliceCardStatus.controlStatus, "frozen");

    const bobCards = await getJson(baseUrl, "/api/admin/cards?productCode=BOB_OPS_APP", adminSession.token);
    const forbiddenCardStatus = await postJsonExpectError(
      baseUrl,
      `/api/developer/cards/${bobCards.items[0].id}/status`,
      {
        status: "frozen"
      },
      aliceSession.token
    );
    assert.equal(forbiddenCardStatus.status, 403);
    assert.equal(forbiddenCardStatus.error.code, "DEVELOPER_CARD_FORBIDDEN");

    const csvResponse = await fetch(`${baseUrl}/api/developer/cards/export?productCode=ALICE_OPS_APP`, {
      headers: { Authorization: `Bearer ${aliceSession.token}` }
    });
    const csvText = await csvResponse.text();
    assert.equal(csvResponse.ok, true);
    assert.match(csvText, /ALICE_OPS_APP/);
    assert.doesNotMatch(csvText, /BOB_OPS_APP/);

    const jsonDownloadResponse = await fetch(
      `${baseUrl}/api/developer/cards/export/download?productCode=ALICE_OPS_APP&format=json`,
      {
        headers: { Authorization: `Bearer ${aliceSession.token}` }
      }
    );
    const jsonDownloadText = await jsonDownloadResponse.text();
    assert.equal(jsonDownloadResponse.ok, true);
    assert.match(jsonDownloadResponse.headers.get("content-type") || "", /^application\/json/);
    assert.match(jsonDownloadText, /ALICE_OPS_APP/);
    assert.doesNotMatch(jsonDownloadText, /BOB_OPS_APP/);

    const summaryDownloadResponse = await fetch(
      `${baseUrl}/api/developer/cards/export/download?productCode=ALICE_OPS_APP&format=summary`,
      {
        headers: { Authorization: `Bearer ${aliceSession.token}` }
      }
    );
    const summaryDownloadText = await summaryDownloadResponse.text();
    assert.equal(summaryDownloadResponse.ok, true);
    assert.match(summaryDownloadText, /RockSolid Developer Card Export/);
    assert.match(summaryDownloadText, /ALICE_OPS_APP/);
    assert.doesNotMatch(summaryDownloadText, /BOB_OPS_APP/);

    const checksumDownloadResponse = await fetch(
      `${baseUrl}/api/developer/cards/export/download?productCode=ALICE_OPS_APP&format=checksums`,
      {
        headers: { Authorization: `Bearer ${aliceSession.token}` }
      }
    );
    const checksumDownloadText = await checksumDownloadResponse.text();
    assert.equal(checksumDownloadResponse.ok, true);
    assert.match(checksumDownloadText, /# SHA-256 checksums/);
    assert.match(checksumDownloadText, /rocksolid-developer-cards-/);
    assert.match(checksumDownloadText, /\.csv/);
    assert.match(checksumDownloadText, /summary\.txt/);

    const zipDownloadResponse = await fetch(
      `${baseUrl}/api/developer/cards/export/download?productCode=ALICE_OPS_APP&format=zip`,
      {
        headers: { Authorization: `Bearer ${aliceSession.token}` }
      }
    );
    const zipDownloadBuffer = Buffer.from(await zipDownloadResponse.arrayBuffer());
    assert.equal(zipDownloadResponse.ok, true);
    assert.match(zipDownloadResponse.headers.get("content-type") || "", /^application\/zip/);
    assert.ok(zipDownloadBuffer.length > 0);

    const aliceVersion = await postJson(
      baseUrl,
      "/api/developer/client-versions",
      {
        productCode: "ALICE_OPS_APP",
        version: "1.0.0",
        channel: "stable",
        forceUpdate: false,
        downloadUrl: "https://example.invalid/alice"
      },
      aliceSession.token
    );
    assert.equal(aliceVersion.productCode, "ALICE_OPS_APP");

    const bobVersion = await postJson(
      baseUrl,
      "/api/admin/client-versions",
      {
        productCode: "BOB_OPS_APP",
        version: "2.0.0",
        channel: "stable",
        forceUpdate: true
      },
      adminSession.token
    );

    const aliceVersions = await getJson(baseUrl, "/api/developer/client-versions", aliceSession.token);
    assert.equal(aliceVersions.items.length, 1);
    assert.equal(aliceVersions.items[0].product_code, "ALICE_OPS_APP");

    const updatedAliceVersion = await postJson(
      baseUrl,
      `/api/developer/client-versions/${aliceVersion.id}/status`,
      {
        status: "disabled",
        forceUpdate: true
      },
      aliceSession.token
    );
    assert.equal(updatedAliceVersion.status, "disabled");
    assert.equal(updatedAliceVersion.forceUpdate, true);

    const forbiddenVersion = await postJsonExpectError(
      baseUrl,
      `/api/developer/client-versions/${bobVersion.id}/status`,
      {
        status: "disabled"
      },
      aliceSession.token
    );
    assert.equal(forbiddenVersion.status, 403);
    assert.equal(forbiddenVersion.error.code, "DEVELOPER_CLIENT_VERSION_FORBIDDEN");

    const aliceNotice = await postJson(
      baseUrl,
      "/api/developer/notices",
      {
        productCode: "ALICE_OPS_APP",
        title: "Alice Maintenance",
        body: "Alice maintenance window.",
        kind: "maintenance",
        channel: "stable",
        blockLogin: true
      },
      aliceSession.token
    );
    assert.equal(aliceNotice.productCode, "ALICE_OPS_APP");

    const bobNotice = await postJson(
      baseUrl,
      "/api/admin/notices",
      {
        productCode: "BOB_OPS_APP",
        title: "Bob Notice",
        body: "Bob side notice.",
        kind: "announcement"
      },
      adminSession.token
    );

    const aliceNotices = await getJson(baseUrl, "/api/developer/notices", aliceSession.token);
    assert.equal(aliceNotices.items.length, 1);
    assert.equal(aliceNotices.items[0].productCode, "ALICE_OPS_APP");

    const updatedAliceNotice = await postJson(
      baseUrl,
      `/api/developer/notices/${aliceNotice.id}/status`,
      {
        status: "archived",
        blockLogin: false
      },
      aliceSession.token
    );
    assert.equal(updatedAliceNotice.status, "archived");
    assert.equal(updatedAliceNotice.blockLogin, false);

    const forbiddenNotice = await postJsonExpectError(
      baseUrl,
      `/api/developer/notices/${bobNotice.id}/status`,
      {
        status: "archived"
      },
      aliceSession.token
    );
    assert.equal(forbiddenNotice.status, 403);
    assert.equal(forbiddenNotice.error.code, "DEVELOPER_NOTICE_FORBIDDEN");
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer dashboard summarizes only scoped project operations", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "dash.owner",
        password: "DashOwner123!",
        displayName: "Dash Owner"
      },
      adminSession.token
    );

    const other = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "dash.other",
        password: "DashOther123!",
        displayName: "Dash Other"
      },
      adminSession.token
    );

    const scopedProduct = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "DASH_SCOPE_APP",
        name: "Dash Scope App",
        ownerDeveloperId: owner.id
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "DASH_OTHER_APP",
        name: "Dash Other App",
        ownerDeveloperId: other.id
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "dash.owner",
      password: "DashOwner123!"
    });

    const scopedPolicy = await postJson(
      baseUrl,
      "/api/developer/policies",
      {
        productCode: "DASH_SCOPE_APP",
        name: "Dashboard Policy",
        durationDays: 30,
        maxDevices: 2,
        heartbeatIntervalSeconds: 30,
        heartbeatTimeoutSeconds: 90,
        tokenTtlSeconds: 180
      },
      ownerSession.token
    );

    const scopedBatch = await postJson(
      baseUrl,
      "/api/developer/cards/batch",
      {
        productCode: "DASH_SCOPE_APP",
        policyId: scopedPolicy.id,
        count: 2,
        prefix: "DASH"
      },
      ownerSession.token
    );

    await signedClientPost(baseUrl, "/api/client/register", scopedProduct.sdkAppId, scopedProduct.sdkAppSecret, {
      productCode: "DASH_SCOPE_APP",
      username: "dash_user",
      password: "DashUser123!"
    });

    await signedClientPost(baseUrl, "/api/client/recharge", scopedProduct.sdkAppId, scopedProduct.sdkAppSecret, {
      productCode: "DASH_SCOPE_APP",
      username: "dash_user",
      password: "DashUser123!",
      cardKey: scopedBatch.keys[0]
    });

    await signedClientPost(baseUrl, "/api/client/login", scopedProduct.sdkAppId, scopedProduct.sdkAppSecret, {
      productCode: "DASH_SCOPE_APP",
      username: "dash_user",
      password: "DashUser123!",
      clientVersion: "2.0.0",
      channel: "stable",
      deviceFingerprint: "dash-device-001",
      machineGuid: "dash-guid-001"
    });

    await postJson(
      baseUrl,
      "/api/developer/client-versions",
      {
        productCode: "DASH_SCOPE_APP",
        version: "2.0.0",
        channel: "stable",
        forceUpdate: true,
        downloadUrl: "https://example.invalid/dash-scope/2.0.0"
      },
      ownerSession.token
    );

    await postJson(
      baseUrl,
      "/api/developer/notices",
      {
        productCode: "DASH_SCOPE_APP",
        title: "Scoped maintenance",
        body: "Scoped maintenance body",
        kind: "maintenance",
        channel: "stable",
        blockLogin: true
      },
      ownerSession.token
    );

    await postJson(
      baseUrl,
      "/api/developer/network-rules",
      {
        productCode: "DASH_SCOPE_APP",
        targetType: "cidr",
        pattern: "10.0.0.0/24",
        actionScope: "login",
        status: "active",
        notes: "dashboard scoped rule"
      },
      ownerSession.token
    );

    await postJson(
      baseUrl,
      "/api/developer/device-blocks",
      {
        productCode: "DASH_SCOPE_APP",
        deviceFingerprint: "blocked-device-001",
        reason: "dashboard scoped block"
      },
      ownerSession.token
    );

    const otherPolicy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "DASH_OTHER_APP",
        name: "Other Policy",
        durationDays: 15,
        maxDevices: 1
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/cards/batch",
      {
        productCode: "DASH_OTHER_APP",
        policyId: otherPolicy.id,
        count: 1,
        prefix: "OTHER"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/client-versions",
      {
        productCode: "DASH_OTHER_APP",
        version: "9.9.9",
        channel: "stable",
        forceUpdate: true
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/notices",
      {
        productCode: "DASH_OTHER_APP",
        title: "Other notice",
        body: "Other notice body",
        kind: "maintenance",
        blockLogin: true
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/network-rules",
      {
        productCode: "DASH_OTHER_APP",
        targetType: "cidr",
        pattern: "192.168.0.0/24",
        actionScope: "login",
        status: "active"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/developer/members",
      {
        username: "dash.viewer",
        password: "DashViewer123!",
        displayName: "Dash Viewer",
        role: "viewer",
        productCodes: ["DASH_SCOPE_APP"]
      },
      ownerSession.token
    );

    const viewerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "dash.viewer",
      password: "DashViewer123!"
    });

    const ownerDashboard = await getJson(baseUrl, "/api/developer/dashboard", ownerSession.token);
    assert.equal(ownerDashboard.summary.projects, 1);
    assert.equal(ownerDashboard.summary.registerEnabledProjects, 1);
    assert.equal(ownerDashboard.summary.accountLoginEnabledProjects, 1);
    assert.equal(ownerDashboard.summary.cardLoginEnabledProjects, 1);
    assert.equal(ownerDashboard.summary.cardRechargeEnabledProjects, 1);
    assert.equal(ownerDashboard.summary.noticesEnabledProjects, 1);
    assert.equal(ownerDashboard.summary.versionCheckEnabledProjects, 1);
    assert.equal(ownerDashboard.summary.clientUnbindEnabledProjects, 1);
    assert.equal(ownerDashboard.summary.cardsFresh, 1);
    assert.equal(ownerDashboard.summary.cardsRedeemed, 1);
    assert.equal(ownerDashboard.summary.accounts, 1);
    assert.equal(ownerDashboard.summary.activeEntitlements, 1);
    assert.equal(ownerDashboard.summary.activeSessions, 1);
    assert.equal(ownerDashboard.summary.blockedDevices, 1);
    assert.equal(ownerDashboard.summary.activeClientVersions, 1);
    assert.equal(ownerDashboard.summary.forceUpdateVersions, 1);
    assert.equal(ownerDashboard.summary.activeNotices, 1);
    assert.equal(ownerDashboard.summary.blockingNotices, 1);
    assert.equal(ownerDashboard.summary.activeNetworkRules, 1);
    assert.equal(ownerDashboard.summary.teamMembers, 1);
    assert.equal(ownerDashboard.projects.length, 1);
    assert.equal(ownerDashboard.projects[0].code, "DASH_SCOPE_APP");
    assert.equal(ownerDashboard.projects[0].metrics.cardsFresh, 1);
    assert.equal(ownerDashboard.projects[0].metrics.cardsRedeemed, 1);
    assert.equal(ownerDashboard.projects[0].metrics.activeSessions, 1);
    assert.equal(ownerDashboard.projects[0].metrics.forceUpdateVersions, 1);
    assert.equal(ownerDashboard.projects[0].metrics.blockingNotices, 1);
    assert.equal(ownerDashboard.projects[0].metrics.activeNetworkRules, 1);

    const viewerDashboard = await getJson(baseUrl, "/api/developer/dashboard", viewerSession.token);
    assert.equal(viewerDashboard.summary.projects, 1);
    assert.equal(viewerDashboard.summary.accountLoginEnabledProjects, 1);
    assert.equal(viewerDashboard.summary.cardRechargeEnabledProjects, 1);
    assert.equal(viewerDashboard.summary.clientUnbindEnabledProjects, 1);
    assert.equal(viewerDashboard.summary.cardsFresh, 1);
    assert.equal(viewerDashboard.summary.cardsRedeemed, 1);
    assert.equal(viewerDashboard.summary.activeSessions, 1);
    assert.equal(viewerDashboard.summary.teamMembers, 0);
    assert.equal(viewerDashboard.projects.length, 1);
    assert.equal(viewerDashboard.projects[0].code, "DASH_SCOPE_APP");
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer release workspace keeps viewers read-only while owners manage scoped releases", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "release.owner",
        password: "ReleaseOwner123!",
        displayName: "Release Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "RELEASE_SCOPE_APP",
        name: "Release Scope App",
        ownerDeveloperId: owner.id
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "release.owner",
      password: "ReleaseOwner123!"
    });

    await postJson(
      baseUrl,
      "/api/developer/members",
      {
        username: "release.viewer",
        password: "ReleaseViewer123!",
        displayName: "Release Viewer",
        role: "viewer",
        productCodes: ["RELEASE_SCOPE_APP"]
      },
      ownerSession.token
    );

    const viewerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "release.viewer",
      password: "ReleaseViewer123!"
    });

    const ownerVersion = await postJson(
      baseUrl,
      "/api/developer/client-versions",
      {
        productCode: "RELEASE_SCOPE_APP",
        version: "2.3.0",
        channel: "stable",
        forceUpdate: true,
        downloadUrl: "https://example.invalid/release-scope/2.3.0",
        noticeTitle: "Mandatory upgrade",
        noticeBody: "Viewer members should still stay read-only."
      },
      ownerSession.token
    );
    assert.equal(ownerVersion.productCode, "RELEASE_SCOPE_APP");

    const ownerNotice = await postJson(
      baseUrl,
      "/api/developer/notices",
      {
        productCode: "RELEASE_SCOPE_APP",
        title: "Scoped maintenance",
        body: "Release viewers can inspect this notice but cannot edit it.",
        kind: "maintenance",
        channel: "stable",
        blockLogin: true
      },
      ownerSession.token
    );
    assert.equal(ownerNotice.productCode, "RELEASE_SCOPE_APP");

    const viewerVersions = await getJson(
      baseUrl,
      "/api/developer/client-versions?productCode=RELEASE_SCOPE_APP",
      viewerSession.token
    );
    assert.equal(viewerVersions.items.length, 1);
    assert.equal(viewerVersions.items[0].product_code, "RELEASE_SCOPE_APP");

    const viewerNotices = await getJson(
      baseUrl,
      "/api/developer/notices?productCode=RELEASE_SCOPE_APP",
      viewerSession.token
    );
    assert.equal(viewerNotices.items.length, 1);
    assert.equal(viewerNotices.items[0].productCode, "RELEASE_SCOPE_APP");

    const forbiddenVersionCreate = await postJsonExpectError(
      baseUrl,
      "/api/developer/client-versions",
      {
        productCode: "RELEASE_SCOPE_APP",
        version: "2.3.1",
        channel: "stable"
      },
      viewerSession.token
    );
    assert.equal(forbiddenVersionCreate.status, 403);
    assert.equal(forbiddenVersionCreate.error.code, "DEVELOPER_CLIENT_VERSION_FORBIDDEN");

    const forbiddenVersionUpdate = await postJsonExpectError(
      baseUrl,
      `/api/developer/client-versions/${ownerVersion.id}/status`,
      {
        status: "disabled"
      },
      viewerSession.token
    );
    assert.equal(forbiddenVersionUpdate.status, 403);
    assert.equal(forbiddenVersionUpdate.error.code, "DEVELOPER_CLIENT_VERSION_FORBIDDEN");

    const forbiddenNoticeCreate = await postJsonExpectError(
      baseUrl,
      "/api/developer/notices",
      {
        productCode: "RELEASE_SCOPE_APP",
        title: "Viewer cannot publish",
        body: "This should be rejected.",
        kind: "announcement"
      },
      viewerSession.token
    );
    assert.equal(forbiddenNoticeCreate.status, 403);
    assert.equal(forbiddenNoticeCreate.error.code, "DEVELOPER_NOTICE_FORBIDDEN");

    const forbiddenNoticeUpdate = await postJsonExpectError(
      baseUrl,
      `/api/developer/notices/${ownerNotice.id}/status`,
      {
        status: "archived"
      },
      viewerSession.token
    );
    assert.equal(forbiddenNoticeUpdate.status, 403);
    assert.equal(forbiddenNoticeUpdate.error.code, "DEVELOPER_NOTICE_FORBIDDEN");
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer release package export bundles integration, versions, and notices inside scope", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "release.package.owner",
        password: "ReleasePackageOwner123!",
        displayName: "Release Package Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "RELPKG_ALPHA",
        name: "Release Package Alpha",
        ownerDeveloperId: owner.id,
        featureConfig: {
          allowCardLogin: false,
          requireHeartbeatGate: false
        }
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "RELPKG_BETA",
        name: "Release Package Beta",
        ownerDeveloperId: owner.id
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "release.package.owner",
      password: "ReleasePackageOwner123!"
    });

    await postJson(
      baseUrl,
      "/api/developer/members",
      {
        username: "release.package.viewer",
        password: "ReleasePackageViewer123!",
        displayName: "Release Package Viewer",
        role: "viewer",
        productCodes: ["RELPKG_ALPHA"]
      },
      ownerSession.token
    );

    await postJson(
      baseUrl,
      "/api/developer/client-versions",
      {
        productCode: "RELPKG_ALPHA",
        version: "5.4.0",
        channel: "stable",
        forceUpdate: true,
        downloadUrl: "https://example.invalid/relpkg-alpha/5.4.0",
        noticeTitle: "Critical release",
        noticeBody: "All users should move to 5.4.0."
      },
      ownerSession.token
    );

    await postJson(
      baseUrl,
      "/api/developer/notices",
      {
        productCode: "RELPKG_ALPHA",
        title: "Scheduled maintenance",
        body: "Brief maintenance window for release rollout.",
        kind: "maintenance",
        channel: "stable",
        blockLogin: true
      },
      ownerSession.token
    );

    const viewerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "release.package.viewer",
      password: "ReleasePackageViewer123!"
    });

    const releasePackage = await getJson(
      baseUrl,
      "/api/developer/release-package?productCode=RELPKG_ALPHA&channel=stable",
      viewerSession.token
    );
    assert.match(releasePackage.fileName, /^rocksolid-release-package-RELPKG_ALPHA-stable-/);
    assert.equal(releasePackage.manifest.project.code, "RELPKG_ALPHA");
    assert.equal(releasePackage.manifest.release.channel, "stable");
    assert.equal(releasePackage.manifest.release.versionManifest.latestVersion, "5.4.0");
    assert.equal(releasePackage.manifest.release.versionManifest.minimumAllowedVersion, "5.4.0");
    assert.equal(releasePackage.manifest.release.versionManifest.latestDownloadUrl, "https://example.invalid/relpkg-alpha/5.4.0");
    assert.equal(releasePackage.manifest.release.startupPreview.request.clientVersion, "5.4.0");
    assert.equal(releasePackage.manifest.release.readiness.status, "hold");
    assert.equal(releasePackage.manifest.release.readiness.ready, false);
    assert.equal(releasePackage.manifest.release.readiness.candidateVersion, "5.4.0");
    assert.ok(releasePackage.manifest.release.readiness.blockingChecks >= 1);
    assert.ok(releasePackage.manifest.release.readiness.checks.some((item) => item.key === "client_hardening" && item.level === "attention"));
    assert.equal(releasePackage.deliverySummary.projectCode, "RELPKG_ALPHA");
    assert.equal(releasePackage.deliverySummary.channel, "stable");
    assert.equal(releasePackage.deliverySummary.candidateVersion, "5.4.0");
    assert.equal(releasePackage.deliverySummary.startupStatus, "blocking_notice");
    assert.equal(releasePackage.deliverySummary.clientHardeningProfile, "balanced");
    assert.equal(releasePackage.deliverySummary.blockingNotices, 1);
    assert.match(releasePackage.deliverySummary.headline, /hold/i);
    assert.equal(releasePackage.deliveryChecklist.status, "hold");
    assert.ok(releasePackage.deliveryChecklist.blockItems >= 1);
    assert.ok(Array.isArray(releasePackage.deliveryChecklist.items));
    assert.ok(releasePackage.deliveryChecklist.items.some((item) => item.key === "client_hardening" && item.status === "review"));
    assert.ok(releasePackage.deliveryChecklist.items.some((item) => item.key === "handoff_artifacts"));
    assert.equal(releasePackage.mainlineFollowUp.status, "hold");
    assert.ok(releasePackage.mainlineFollowUp.mainlineGate);
    assert.equal(releasePackage.mainlineFollowUp.mainlineGate.status, "hold");
    assert.ok((releasePackage.mainlineFollowUp.mainlineGate.blockingCount || 0) >= 1);
    assert.ok(releasePackage.mainlineFollowUp.mainlineGate.recommendedWorkspace?.key);
    assert.ok(releasePackage.mainlineFollowUp.mainlineGate.primaryAction?.key);
    assert.ok(releasePackage.mainlineFollowUp.mainlineGate.recommendedDownload?.key);
    assert.ok(releasePackage.mainlineFollowUp.recommendedWorkspace?.key);
    assert.ok(Array.isArray(releasePackage.mainlineFollowUp.workspaceActions));
    assert.ok(releasePackage.mainlineFollowUp.workspaceActions.some((item) => item.key === "release"));
    assert.ok(Array.isArray(releasePackage.mainlineFollowUp.actionPlan));
    assert.ok(releasePackage.mainlineFollowUp.actionPlan.some((item) => item.key === "clear_release_blockers"));
    assert.ok(releasePackage.mainlineFollowUp.actionPlan.some((item) => item.key === "launch_mainline_overview" && item.recommendedDownload?.key === "launch_mainline_rehearsal_guide"));
    assert.ok(Array.isArray(releasePackage.mainlineFollowUp.recommendedDownloads));
    assert.ok(releasePackage.mainlineFollowUp.recommendedDownloads.some((item) => item.key === "release_checklist"));
    assert.ok(releasePackage.mainlineFollowUp.recommendedDownloads.some((item) => item.key === "launch_mainline_summary" && item.source === "developer-launch-mainline"));
    assert.ok(releasePackage.mainlineFollowUp.recommendedDownloads.some((item) => item.key === "launch_mainline_rehearsal_guide" && item.source === "developer-launch-mainline"));
    assert.ok(
      releasePackage.mainlineFollowUp.recommendedDownloads.findIndex((item) => item.key === "launch_mainline_rehearsal_guide")
      < releasePackage.mainlineFollowUp.recommendedDownloads.findIndex((item) => item.key === "launch_mainline_summary")
    );
    assert.ok(releasePackage.mainlineFollowUp.recommendedDownloads.some((item) => item.key === "launch_mainline_zip" && item.source === "developer-launch-mainline"));
    assert.ok(releasePackage.mainlineFollowUp.recommendedDownloads.some((item) => item.key === "launch_mainline_checksums" && item.source === "developer-launch-mainline"));
    assert.equal(releasePackage.manifest.release.activeNotices.total, 1);
    assert.equal(releasePackage.manifest.release.activeNotices.blockingTotal, 1);
    assert.equal(releasePackage.manifest.release.mainlineFollowUp.status, "hold");
    assert.equal(releasePackage.manifest.release.mainlineFollowUp.mainlineGate?.status, "hold");
    assert.equal(releasePackage.manifest.integration.project.code, "RELPKG_ALPHA");
    assert.equal(releasePackage.manifest.integration.project.featureConfig.allowCardLogin, false);
    assert.equal(releasePackage.manifest.actor.type, "member");
    assert.equal(releasePackage.manifest.actor.role, "viewer");
    assert.equal(releasePackage.snippets.envFileName, "RELPKG_ALPHA.env");
    assert.equal(releasePackage.snippets.hostConfigFileName, "rocksolid_host_config.env");
    assert.match(releasePackage.snippets.hostConfigEnv, /Copy this file to sdk\/examples\/cmake_cpp_host_consumer\/rocksolid_host_config\.env/);
    assert.match(releasePackage.snippets.hostConfigEnv, /RS_PROJECT_CODE=RELPKG_ALPHA/);
    assert.equal(releasePackage.snippets.cmakeFileName, "CMakeLists.txt");
    assert.match(releasePackage.snippets.cmakeConsumerTemplate, /find_package\(RockSolidSDK CONFIG REQUIRED/);
    assert.match(releasePackage.snippets.cmakeConsumerTemplate, /relpkg_alpha_host_consumer/);
    assert.match(releasePackage.snippets.vs2022SolutionFileName, /RELPKG_ALPHA_host_consumer\.sln/i);
    assert.match(releasePackage.snippets.vs2022SolutionTemplate, /Visual Studio Solution File, Format Version 12\.00/);
    assert.match(releasePackage.snippets.vs2022SolutionTemplate, /RELPKG_ALPHA_host_consumer\.vcxproj/);
    assert.match(releasePackage.snippets.vs2022ProjectFileName, /RELPKG_ALPHA_host_consumer\.vcxproj/i);
    assert.match(releasePackage.snippets.vs2022ProjectTemplate, /PlatformToolset>v143</);
    assert.match(releasePackage.snippets.vs2022ProjectTemplate, /ROCKSOLID_SDK_ROOT/);
    assert.match(releasePackage.snippets.vs2022ProjectTemplate, /UseDebugLibraries>false</);
    assert.match(releasePackage.snippets.vs2022ProjectTemplate, /rocksolid_host_config\.env/);
    assert.match(releasePackage.snippets.vs2022ProjectTemplate, /RELPKG_ALPHA_vs2022_quickstart\.md/);
    assert.match(releasePackage.snippets.vs2022ProjectTemplate, /Import Project="RockSolidSDK\.props"/);
    assert.match(releasePackage.snippets.vs2022ProjectTemplate, /Import Project="RockSolidSDK\.local\.props"/);
    assert.match(releasePackage.snippets.vs2022FiltersFileName, /RELPKG_ALPHA_host_consumer\.vcxproj\.filters/i);
    assert.match(releasePackage.snippets.vs2022FiltersTemplate, /Source Files/);
    assert.match(releasePackage.snippets.vs2022FiltersTemplate, /Config/);
    assert.match(releasePackage.snippets.vs2022FiltersTemplate, /Docs/);
    assert.equal(releasePackage.snippets.vs2022PropsFileName, "RockSolidSDK.props");
    assert.match(releasePackage.snippets.vs2022PropsTemplate, /ROCKSOLID_SDK_ROOT/);
    assert.match(releasePackage.snippets.vs2022PropsTemplate, /AdditionalLibraryDirectories>/);
    assert.equal(releasePackage.snippets.vs2022LocalPropsFileName, "RockSolidSDK.local.props");
    assert.match(releasePackage.snippets.vs2022LocalPropsTemplate, /ROCKSOLID_SDK_ROOT_OVERRIDE/);
    assert.match(releasePackage.snippets.vs2022LocalPropsTemplate, /LocalDebuggerWorkingDirectory/);
    assert.match(releasePackage.snippets.vs2022GuideFileName, /RELPKG_ALPHA_vs2022_quickstart\.md/i);
    assert.match(releasePackage.snippets.vs2022GuideText, /VS2022 Quickstart for RELPKG_ALPHA/);
    assert.match(releasePackage.snippets.vs2022GuideText, /RockSolidSDK\.local\.props/);
    assert.match(releasePackage.snippets.vs2022GuideText, /RS_PROJECT_CODE=RELPKG_ALPHA/);
    assert.equal(releasePackage.snippets.cppFileName, "RELPKG_ALPHA.cpp");
    assert.equal(releasePackage.snippets.hostSkeletonFileName, "RELPKG_ALPHA-host-skeleton.cpp");
    assert.equal(releasePackage.snippets.hardeningFileName, "RELPKG_ALPHA-hardening-guide.txt");
    assert.match(releasePackage.snippets.envTemplate, /RS_PROJECT_CODE=RELPKG_ALPHA/);
    assert.match(releasePackage.snippets.cppQuickstart, /RELPKG_ALPHA/);
    assert.match(releasePackage.snippets.hostSkeletonCpp, /FeatureGate/);
    assert.match(releasePackage.snippets.hostSkeletonCpp, /startup_bootstrap_http/);
    assert.match(releasePackage.snippets.hostSkeletonCpp, /validate_license_token_with_bootstrap/);
    assert.match(releasePackage.snippets.hardeningGuide, /Profile: BALANCED/);
    assert.match(releasePackage.snippets.hardeningGuide, /Shipping Note:/);
    assert.match(releasePackage.summaryText, /Latest Version: 5.4.0/);
    assert.match(releasePackage.summaryText, /Blocking Notices: 1/);
    assert.match(releasePackage.summaryText, /Client Hardening: BALANCED/);
    assert.match(releasePackage.summaryText, /Release Readiness: HOLD/);
    assert.match(releasePackage.summaryText, /Delivery Summary:/);
    assert.match(releasePackage.summaryText, /Delivery Checklist:/);
    assert.match(releasePackage.summaryText, /Release Checks:/);
    assert.match(releasePackage.summaryText, /Release Mainline Follow-up:/);
    assert.match(releasePackage.summaryText, /Launch Mainline Gate:/);
    assert.match(releasePackage.summaryText, /- status: HOLD/);
    assert.match(releasePackage.summaryText, /hostConfig=host-config\/rocksolid_host_config\.env/);
    assert.match(releasePackage.summaryText, /cmake=cmake-consumer\/CMakeLists\.txt/);
    assert.match(releasePackage.summaryText, /vs2022Guide=vs2022-consumer\/RELPKG_ALPHA_vs2022_quickstart\.md/);
    assert.match(releasePackage.summaryText, /vs2022Sln=vs2022-consumer\/RELPKG_ALPHA_host_consumer\.sln/);
    assert.match(releasePackage.summaryText, /vs2022=vs2022-consumer\/RELPKG_ALPHA_host_consumer\.vcxproj/);
    assert.match(releasePackage.summaryText, /vs2022Filters=vs2022-consumer\/RELPKG_ALPHA_host_consumer\.vcxproj\.filters/);
    assert.match(releasePackage.summaryText, /vs2022Props=vs2022-consumer\/RockSolidSDK\.props/);
    assert.match(releasePackage.summaryText, /vs2022LocalProps=vs2022-consumer\/RockSolidSDK\.local\.props/);

    const releaseSummaryDownload = await getText(
      baseUrl,
      "/api/developer/release-package/download?productCode=RELPKG_ALPHA&channel=stable&format=summary",
      viewerSession.token
    );
    assert.match(releaseSummaryDownload.contentType || "", /^text\/plain/);
    assert.match(releaseSummaryDownload.contentDisposition || "", /attachment; filename="rocksolid-release-package-RELPKG_ALPHA-stable-.*\.txt"/);
    assert.match(releaseSummaryDownload.body, /Latest Version: 5.4.0/);
    assert.match(releaseSummaryDownload.body, /Blocking Notices: 1/);
    assert.match(releaseSummaryDownload.body, /Release Readiness: HOLD/);
    assert.match(releaseSummaryDownload.body, /Release Mainline Follow-up:/);
    assert.match(releaseSummaryDownload.body, /Launch Mainline Gate:/);

    const releaseChecklistDownload = await getText(
      baseUrl,
      "/api/developer/release-package/download?productCode=RELPKG_ALPHA&channel=stable&format=checklist",
      viewerSession.token
    );
    assert.match(releaseChecklistDownload.contentType || "", /^text\/plain/);
    assert.match(releaseChecklistDownload.contentDisposition || "", /attachment; filename="rocksolid-release-package-RELPKG_ALPHA-stable-.*-checklist\.txt"/);
    assert.match(releaseChecklistDownload.body, /RockSolid Release Delivery Checklist/);
    assert.match(releaseChecklistDownload.body, /Checklist Items:/);
    assert.match(releaseChecklistDownload.body, /Project active/);

    const releaseEnvDownload = await getText(
      baseUrl,
      "/api/developer/release-package/download?productCode=RELPKG_ALPHA&channel=stable&format=env",
      viewerSession.token
    );
    assert.match(releaseEnvDownload.contentDisposition || "", /attachment; filename="RELPKG_ALPHA\.env"/);
    assert.match(releaseEnvDownload.body, /RS_PROJECT_CODE=RELPKG_ALPHA/);

    const releaseHostConfigDownload = await getText(
      baseUrl,
      "/api/developer/release-package/download?productCode=RELPKG_ALPHA&channel=stable&format=host-config",
      viewerSession.token
    );
    assert.match(releaseHostConfigDownload.contentType || "", /^text\/plain/);
    assert.match(releaseHostConfigDownload.contentDisposition || "", /attachment; filename="rocksolid_host_config\.env"/);
    assert.match(releaseHostConfigDownload.body, /RS_PROJECT_CODE=RELPKG_ALPHA/);
    assert.match(releaseHostConfigDownload.body, /RS_RUN_NETWORK_DEMO=false/);

    const releaseCMakeDownload = await getText(
      baseUrl,
      "/api/developer/release-package/download?productCode=RELPKG_ALPHA&channel=stable&format=cmake",
      viewerSession.token
    );
    assert.match(releaseCMakeDownload.contentType || "", /^text\/plain/);
    assert.match(releaseCMakeDownload.contentDisposition || "", /attachment; filename="CMakeLists\.txt"/);
    assert.match(releaseCMakeDownload.body, /find_package\(RockSolidSDK CONFIG REQUIRED/);
    assert.match(releaseCMakeDownload.body, /relpkg_alpha_host_consumer/);

    const releaseVs2022GuideDownload = await getText(
      baseUrl,
      "/api/developer/release-package/download?productCode=RELPKG_ALPHA&channel=stable&format=vs2022-guide",
      viewerSession.token
    );
    assert.match(releaseVs2022GuideDownload.contentType || "", /^text\/plain/);
    assert.match(releaseVs2022GuideDownload.contentDisposition || "", /attachment; filename="RELPKG_ALPHA_vs2022_quickstart\.md"/);
    assert.match(releaseVs2022GuideDownload.body, /VS2022 Quickstart for RELPKG_ALPHA/);
    assert.match(releaseVs2022GuideDownload.body, /RS_PROJECT_CODE=RELPKG_ALPHA/);

    const releaseVs2022SlnDownload = await getText(
      baseUrl,
      "/api/developer/release-package/download?productCode=RELPKG_ALPHA&channel=stable&format=vs2022-sln",
      viewerSession.token
    );
    assert.match(releaseVs2022SlnDownload.contentType || "", /^text\/plain/);
    assert.match(releaseVs2022SlnDownload.contentDisposition || "", /attachment; filename="RELPKG_ALPHA_host_consumer\.sln"/);
    assert.match(releaseVs2022SlnDownload.body, /Visual Studio Solution File, Format Version 12\.00/);
    assert.match(releaseVs2022SlnDownload.body, /RELPKG_ALPHA_host_consumer\.vcxproj/);

    const releaseVs2022Download = await getText(
      baseUrl,
      "/api/developer/release-package/download?productCode=RELPKG_ALPHA&channel=stable&format=vs2022",
      viewerSession.token
    );
    assert.match(releaseVs2022Download.contentType || "", /^text\/plain/);
    assert.match(releaseVs2022Download.contentDisposition || "", /attachment; filename="RELPKG_ALPHA_host_consumer\.vcxproj"/);
    assert.match(releaseVs2022Download.body, /PlatformToolset>v143</);
    assert.match(releaseVs2022Download.body, /ROCKSOLID_SDK_ROOT/);

    const releaseVs2022FiltersDownload = await getText(
      baseUrl,
      "/api/developer/release-package/download?productCode=RELPKG_ALPHA&channel=stable&format=vs2022-filters",
      viewerSession.token
    );
    assert.match(releaseVs2022FiltersDownload.contentType || "", /^text\/plain/);
    assert.match(releaseVs2022FiltersDownload.contentDisposition || "", /attachment; filename="RELPKG_ALPHA_host_consumer\.vcxproj\.filters"/);
    assert.match(releaseVs2022FiltersDownload.body, /Source Files/);
    assert.match(releaseVs2022FiltersDownload.body, /Docs/);

    const releaseVs2022PropsDownload = await getText(
      baseUrl,
      "/api/developer/release-package/download?productCode=RELPKG_ALPHA&channel=stable&format=vs2022-props",
      viewerSession.token
    );
    assert.match(releaseVs2022PropsDownload.contentType || "", /^text\/plain/);
    assert.match(releaseVs2022PropsDownload.contentDisposition || "", /attachment; filename="RockSolidSDK\.props"/);
    assert.match(releaseVs2022PropsDownload.body, /ROCKSOLID_SDK_ROOT/);
    assert.match(releaseVs2022PropsDownload.body, /AdditionalLibraryDirectories>/);

    const releaseVs2022LocalPropsDownload = await getText(
      baseUrl,
      "/api/developer/release-package/download?productCode=RELPKG_ALPHA&channel=stable&format=vs2022-local-props",
      viewerSession.token
    );
    assert.match(releaseVs2022LocalPropsDownload.contentType || "", /^text\/plain/);
    assert.match(releaseVs2022LocalPropsDownload.contentDisposition || "", /attachment; filename="RockSolidSDK\.local\.props"/);
    assert.match(releaseVs2022LocalPropsDownload.body, /ROCKSOLID_SDK_ROOT_OVERRIDE/);
    assert.match(releaseVs2022LocalPropsDownload.body, /ROCKSOLID_TARGET_NAME_OVERRIDE/);

    const releaseHostSkeletonDownload = await getText(
      baseUrl,
      "/api/developer/release-package/download?productCode=RELPKG_ALPHA&channel=stable&format=host-skeleton",
      viewerSession.token
    );
    assert.match(releaseHostSkeletonDownload.contentType || "", /^text\/plain/);
    assert.match(releaseHostSkeletonDownload.contentDisposition || "", /attachment; filename="RELPKG_ALPHA-host-skeleton\.cpp"/);
    assert.match(releaseHostSkeletonDownload.body, /FeatureGate/);
    assert.match(releaseHostSkeletonDownload.body, /validate_license_token_with_bootstrap/);

    const releaseChecksumsDownload = await getText(
      baseUrl,
      "/api/developer/release-package/download?productCode=RELPKG_ALPHA&channel=stable&format=checksums",
      viewerSession.token
    );
    assert.match(releaseChecksumsDownload.contentType || "", /^text\/plain/);
    assert.match(releaseChecksumsDownload.contentDisposition || "", /attachment; filename="rocksolid-release-package-RELPKG_ALPHA-stable-.*-sha256\.txt"/);
    assert.match(releaseChecksumsDownload.body, /rocksolid-release-package-RELPKG_ALPHA-stable-.*\.json/);
    assert.match(releaseChecksumsDownload.body, /snippets\/RELPKG_ALPHA\.env/);
    assert.match(releaseChecksumsDownload.body, /host-config\/rocksolid_host_config\.env/);
    assert.match(releaseChecksumsDownload.body, /cmake-consumer\/CMakeLists\.txt/);
    assert.match(releaseChecksumsDownload.body, /cmake-consumer\/main\.cpp/);
    assert.match(releaseChecksumsDownload.body, /cmake-consumer\/rocksolid_host_config\.env/);
    assert.match(releaseChecksumsDownload.body, /vs2022-consumer\/RELPKG_ALPHA_vs2022_quickstart\.md/);
    assert.match(releaseChecksumsDownload.body, /vs2022-consumer\/RELPKG_ALPHA_host_consumer\.sln/);
    assert.match(releaseChecksumsDownload.body, /vs2022-consumer\/RELPKG_ALPHA_host_consumer\.vcxproj/);
    assert.match(releaseChecksumsDownload.body, /vs2022-consumer\/RELPKG_ALPHA_host_consumer\.vcxproj\.filters/);
    assert.match(releaseChecksumsDownload.body, /vs2022-consumer\/RockSolidSDK\.props/);
    assert.match(releaseChecksumsDownload.body, /vs2022-consumer\/RockSolidSDK\.local\.props/);
    assert.match(releaseChecksumsDownload.body, /vs2022-consumer\/main\.cpp/);
    assert.match(releaseChecksumsDownload.body, /vs2022-consumer\/rocksolid_host_config\.env/);
    assert.match(releaseChecksumsDownload.body, /snippets\/RELPKG_ALPHA-host-skeleton\.cpp/);
    assert.match(releaseChecksumsDownload.body, /snippets\/RELPKG_ALPHA-hardening-guide\.txt/);
    assert.match(releaseChecksumsDownload.body, /snippets\/RELPKG_ALPHA\.cpp/);

    const releaseZipDownload = await getBinary(
      baseUrl,
      "/api/developer/release-package/download?productCode=RELPKG_ALPHA&channel=stable&format=zip",
      viewerSession.token
    );
    assert.match(releaseZipDownload.contentType || "", /^application\/zip/);
    assert.match(releaseZipDownload.contentDisposition || "", /attachment; filename="rocksolid-release-package-RELPKG_ALPHA-stable-.*\.zip"/);
    assert.equal(releaseZipDownload.body.subarray(0, 4).toString("latin1"), "PK\u0003\u0004");
    const releaseZipText = releaseZipDownload.body.toString("latin1");
    assert.match(releaseZipText, /RELPKG_ALPHA\.env/);
    assert.match(releaseZipText, /rocksolid_host_config\.env/);
    assert.match(releaseZipText, /cmake-consumer\/CMakeLists\.txt/);
    assert.match(releaseZipText, /cmake-consumer\/main\.cpp/);
    assert.match(releaseZipText, /vs2022-consumer\/RELPKG_ALPHA_vs2022_quickstart\.md/);
    assert.match(releaseZipText, /vs2022-consumer\/RELPKG_ALPHA_host_consumer\.sln/);
    assert.match(releaseZipText, /vs2022-consumer\/RELPKG_ALPHA_host_consumer\.vcxproj/);
    assert.match(releaseZipText, /vs2022-consumer\/RELPKG_ALPHA_host_consumer\.vcxproj\.filters/);
    assert.match(releaseZipText, /vs2022-consumer\/RockSolidSDK\.props/);
    assert.match(releaseZipText, /vs2022-consumer\/RockSolidSDK\.local\.props/);
    assert.match(releaseZipText, /vs2022-consumer\/main\.cpp/);
    assert.match(releaseZipText, /RELPKG_ALPHA\.cpp/);
    assert.match(releaseZipText, /RELPKG_ALPHA-host-skeleton\.cpp/);
    assert.match(releaseZipText, /RELPKG_ALPHA-hardening-guide\.txt/);
    assert.match(releaseZipText, /rocksolid-release-package-RELPKG_ALPHA-stable-.*\.json/);
    assert.match(releaseZipText, /SHA256SUMS\.txt/);

    const launchWorkflow = await getJson(
      baseUrl,
      "/api/developer/launch-workflow?productCode=RELPKG_ALPHA&channel=stable",
      viewerSession.token
    );
    assert.match(launchWorkflow.fileName, /^rocksolid-launch-workflow-RELPKG_ALPHA-stable-/);
    assert.match(launchWorkflow.summaryFileName, /^rocksolid-launch-workflow-RELPKG_ALPHA-stable-.*\.txt$/);
    assert.match(launchWorkflow.checklistFileName, /^rocksolid-launch-workflow-RELPKG_ALPHA-stable-.*-checklist\.txt$/);
    assert.equal(launchWorkflow.workflowSummary.status, "hold");
    assert.equal(launchWorkflow.workflowSummary.releaseStatus, "hold");
    assert.equal(launchWorkflow.workflowSummary.startupStatus, "force_update_required");
    assert.equal(launchWorkflow.workflowSummary.clientHardeningProfile, "balanced");
    assert.equal(launchWorkflow.workflowSummary.authorizationStatus, "block");
    assert.match(launchWorkflow.workflowSummary.authorizationSummary || "", /policies=0/);
    assert.match(launchWorkflow.workflowSummary.authorizationModeSummary || "", /account\+register/);
    assert.ok(launchWorkflow.workflowSummary.mainlineGate);
    assert.equal(launchWorkflow.workflowSummary.mainlineGate.status, "hold");
    assert.ok((launchWorkflow.workflowSummary.mainlineGate.blockingCount || 0) >= 1);
    assert.equal(launchWorkflow.workflowSummary.mainlineGate.recommendedWorkspace?.key, "integration");
    assert.ok(launchWorkflow.workflowSummary.mainlineGate.primaryAction?.key);
    assert.ok(launchWorkflow.workflowSummary.mainlineGate.recommendedDownload?.key);
    assert.ok(Array.isArray(launchWorkflow.workflowSummary.recommendedDownloads));
    assert.ok(Array.isArray(launchWorkflow.workflowSummary.actionPlan));
    assert.ok(launchWorkflow.workflowSummary.actionPlan.length >= 1);
    assert.ok(Array.isArray(launchWorkflow.workflowSummary.authorizationLaunchRecommendations?.inventoryRecommendations));
    assert.ok(Array.isArray(launchWorkflow.workflowSummary.authorizationLaunchRecommendations?.firstBatchCardRecommendations));
    assert.ok(Array.isArray(launchWorkflow.workflowSummary.authorizationLaunchRecommendations?.firstOpsActions));
    assert.ok(launchWorkflow.workflowSummary.authorizationLaunchRecommendations.inventoryRecommendations.length >= 1);
    assert.ok(launchWorkflow.workflowSummary.authorizationLaunchRecommendations.firstOpsActions.length >= 1);
    assert.ok(launchWorkflow.workflowSummary.authorizationLaunchRecommendations.inventoryRecommendations.some((item) => item.workspaceAction?.key));
    assert.ok(launchWorkflow.workflowSummary.authorizationLaunchRecommendations.inventoryRecommendations.some((item) => item.bootstrapAction?.key));
    assert.ok(launchWorkflow.workflowSummary.authorizationLaunchRecommendations.firstBatchCardRecommendations.some((item) => item.workspaceAction?.key === "licenses"));
    assert.ok(launchWorkflow.workflowSummary.authorizationLaunchRecommendations.firstBatchCardRecommendations.every((item) => !item.setupAction));
    assert.ok(launchWorkflow.workflowSummary.authorizationLaunchRecommendations.firstOpsActions.some((item) => item.workspaceAction?.key));
    assert.ok(launchWorkflow.workflowSummary.authorizationLaunchRecommendations.firstOpsActions.some((item) => item.workspaceAction?.key === "ops"));
    assert.ok(launchWorkflow.workflowSummary.authorizationLaunchRecommendations.firstOpsActions.some((item) => item.workspaceAction?.autofocus === "snapshot"));
    assert.ok(launchWorkflow.workflowSummary.authorizationLaunchRecommendations.firstOpsActions.some((item) => item.workspaceAction?.autofocus === "sessions"));
    assert.ok(launchWorkflow.workflowSummary.authorizationLaunchRecommendations.firstOpsActions.some((item) => item.workspaceAction?.params?.eventType === "session.login"));
    assert.ok(launchWorkflow.workflowSummary.authorizationLaunchRecommendations.firstOpsActions.some((item) => item.workspaceAction?.params?.entityType === "license_key"));
    assert.ok(launchWorkflow.workflowSummary.authorizationLaunchRecommendations.firstOpsActions.some((item) => item.recommendedDownload?.source === "developer-ops"));
    assert.equal(launchWorkflow.workflowSummary.recommendedWorkspace.key, "integration");
    assert.match(launchWorkflow.workflowSummary.recommendedWorkspace.label, /Integration Workspace/);
    assert.ok(Array.isArray(launchWorkflow.workflowSummary.workspaceActions));
    assert.ok(launchWorkflow.workflowSummary.workspaceActions.some((item) => item.key === "integration"));
    assert.ok(launchWorkflow.workflowSummary.workspaceActions.some((item) => item.key === "release"));
    assert.ok(launchWorkflow.workflowSummary.workspaceActions.some((item) => item.key === "licenses"));
    assert.ok(launchWorkflow.workflowSummary.workspaceActions.some((item) => item.key === "ops"));
    assert.ok(launchWorkflow.workflowSummary.recommendedDownloads.some((item) => item.key === "launch_handoff_zip"));
    assert.ok(launchWorkflow.workflowSummary.recommendedDownloads.some((item) => item.key === "launch_handoff_checksums"));
    assert.ok(launchWorkflow.workflowSummary.recommendedDownloads.some((item) => item.key === "launch_workflow_zip"));
    assert.ok(launchWorkflow.workflowSummary.recommendedDownloads.some((item) => item.key === "launch_mainline_summary" && item.source === "developer-launch-mainline"));
    assert.ok(launchWorkflow.workflowSummary.recommendedDownloads.some((item) => item.key === "launch_mainline_rehearsal_guide" && item.source === "developer-launch-mainline"));
    assert.ok(
      launchWorkflow.workflowSummary.recommendedDownloads.findIndex((item) => item.key === "launch_mainline_rehearsal_guide")
      < launchWorkflow.workflowSummary.recommendedDownloads.findIndex((item) => item.key === "launch_mainline_summary")
    );
    assert.ok(launchWorkflow.workflowSummary.recommendedDownloads.some((item) => item.key === "launch_mainline_zip" && item.source === "developer-launch-mainline"));
    assert.ok(launchWorkflow.workflowSummary.recommendedDownloads.some((item) => item.key === "launch_mainline_checksums" && item.source === "developer-launch-mainline"));
    assert.equal(launchWorkflow.workflowSummary.launchBootstrapAction?.label, "Run Launch Bootstrap");
    assert.equal(launchWorkflow.workflowSummary.launchFirstBatchSetupAction, null);
    assert.match(launchWorkflow.handoffZipFileName, /^rocksolid-launch-workflow-RELPKG_ALPHA-stable-.*-handoff\.zip$/);
    assert.match(launchWorkflow.handoffChecksumsFileName, /^rocksolid-launch-workflow-RELPKG_ALPHA-stable-.*-handoff-sha256\.txt$/);
    assert.equal(launchWorkflow.workflowChecklist.status, "hold");
    assert.ok(launchWorkflow.workflowChecklist.blockItems >= 1);
    assert.ok(launchWorkflow.workflowChecklist.items.some((item) => item.key === "authorization_readiness" && item.workspaceAction?.key === "licenses"));
    assert.ok(launchWorkflow.workflowChecklist.items.some((item) => item.key === "authorization_readiness" && item.bootstrapAction?.key === "launch_bootstrap"));
    assert.ok(launchWorkflow.workflowChecklist.items.every((item) => !(item.key === "authorization_readiness" && item.setupAction?.key === "launch_first_batch_setup")));
    assert.ok(launchWorkflow.workflowChecklist.items.some((item) => item.key === "launch_handoff_package"));
    assert.ok(launchWorkflow.workflowChecklist.items.some((item) => item.workspaceAction?.key === "integration"));
    assert.ok(launchWorkflow.workflowChecklist.items.some((item) => item.recommendedDownload?.key === "release_summary"));
    assert.ok(launchWorkflow.workflowChecklist.items.some((item) => item.recommendedDownload?.key === "launch_handoff_zip"));
    assert.ok(launchWorkflow.workflowSummary.actionPlan.some((item) => item.key === "authorization_readiness" && item.workspaceAction?.key === "licenses"));
    assert.ok(launchWorkflow.workflowSummary.actionPlan.some((item) => item.key === "authorization_readiness" && item.bootstrapAction?.key === "launch_bootstrap"));
    assert.ok(launchWorkflow.workflowSummary.actionPlan.every((item) => !(item.key === "authorization_readiness" && item.setupAction?.key === "launch_first_batch_setup")));
    assert.ok(launchWorkflow.workflowSummary.actionPlan.every((item) => item.key !== "first_batch_setup"));
    assert.ok(launchWorkflow.workflowSummary.actionPlan.some((item) => item.workspaceAction?.key === "integration"));
    assert.ok(launchWorkflow.workflowSummary.actionPlan.some((item) => item.recommendedDownload?.key === "integration_env"));
    assert.ok(launchWorkflow.workflowSummary.actionPlan.some((item) => item.workspaceAction?.key === "ops"));
    assert.ok(launchWorkflow.workflowSummary.actionPlan.some((item) => item.key === "launch_day_ops_watch" && item.recommendedDownload?.source === "developer-ops"));
    assert.ok(launchWorkflow.workflowSummary.actionPlan.some((item) => item.key === "launch_mainline_overview" && item.recommendedDownload?.key === "launch_mainline_rehearsal_guide"));
    assert.equal(launchWorkflow.releasePackage.manifest.project.code, "RELPKG_ALPHA");
    assert.equal(launchWorkflow.integrationPackage.manifest.project.code, "RELPKG_ALPHA");
    assert.match(launchWorkflow.summaryText, /RockSolid Launch Workflow Package/);
    assert.match(launchWorkflow.summaryText, /Workflow Status: HOLD/);
    assert.match(launchWorkflow.summaryText, /Authorization Status: BLOCK/);
    assert.match(launchWorkflow.summaryText, /Launch Mainline Gate:/);
    assert.match(launchWorkflow.summaryText, /- status: HOLD/);
    assert.match(launchWorkflow.summaryText, /Authorization Summary: modes=account\+register/);
    assert.match(launchWorkflow.summaryText, /Recommended Downloads:/);
    assert.match(launchWorkflow.summaryText, /Recommended Workspace:/);
    assert.match(launchWorkflow.summaryText, /Launch Bootstrap:/);
    assert.doesNotMatch(launchWorkflow.summaryText, /First Batch Setup:/);
    assert.match(launchWorkflow.summaryText, /Initial Inventory Recommendations:/);
    assert.match(launchWorkflow.summaryText, /First Batch Card Suggestions:/);
    assert.match(launchWorkflow.summaryText, /First Ops Actions:/);
    assert.match(launchWorkflow.summaryText, /Action Plan:/);
    assert.match(launchWorkflow.summaryText, /workspace=Open Ops Workspace@/);
    assert.match(launchWorkflow.summaryText, /download=Runtime smoke summary:developer-ops-summary\.txt|download=Card redemption summary:developer-ops-summary\.txt|download=Early session summary:developer-ops-summary\.txt/);
    assert.match(launchWorkflow.summaryText, /eventType=session\.login|entityType=license_key/);
    assert.match(launchWorkflow.summaryText, /Recommended handoff zip/);
    assert.match(launchWorkflow.summaryText, /Combined launch workflow zip/);
    assert.match(launchWorkflow.summaryText, /workspace=Open License Workspace@quickstart/);
    assert.match(launchWorkflow.summaryText, /bootstrap=Run Launch Bootstrap/);
    assert.doesNotMatch(launchWorkflow.summaryText, /setup=Run First Batch Setup@recommended/);
    assert.match(launchWorkflow.summaryText, /workspace=Open Integration Workspace@startup/);
    assert.match(launchWorkflow.summaryText, /download=Release summary:/);
    assert.match(launchWorkflow.checklistText, /RockSolid Launch Workflow Checklist/);
    assert.match(launchWorkflow.checklistText, /\[BLOCK\] Authorization readiness/);
    assert.match(launchWorkflow.checklistText, /workspace: Open License Workspace \| focus=quickstart/);
    assert.match(launchWorkflow.checklistText, /bootstrap: Run Launch Bootstrap/);
    assert.doesNotMatch(launchWorkflow.checklistText, /setup: Run First Batch Setup \| mode=recommended/);
    assert.match(launchWorkflow.checklistText, /Initial Inventory Recommendations:/);
    assert.match(launchWorkflow.checklistText, /First Batch Card Suggestions:/);
    assert.match(launchWorkflow.checklistText, /First Ops Actions:/);
    assert.match(launchWorkflow.checklistText, /download=Runtime smoke summary:developer-ops-summary\.txt|download=Card redemption summary:developer-ops-summary\.txt|download=Early session summary:developer-ops-summary\.txt/);
    assert.match(launchWorkflow.checklistText, /Open Ops Workspace@|workspace: Open .*Workspace \| focus=.*filters=/);
    assert.match(launchWorkflow.checklistText, /\[BLOCK\] Startup bootstrap decision/);
    assert.match(launchWorkflow.checklistText, /workspace: Open Integration Workspace \| focus=startup/);
    assert.match(launchWorkflow.checklistText, /download: Recommended handoff zip \| rocksolid-launch-workflow-RELPKG_ALPHA-stable-.*-handoff\.zip/);

    const launchSummaryDownload = await getText(
      baseUrl,
      "/api/developer/launch-workflow/download?productCode=RELPKG_ALPHA&channel=stable&format=summary",
      viewerSession.token
    );
    assert.match(launchSummaryDownload.contentType || "", /^text\/plain/);
    assert.match(launchSummaryDownload.contentDisposition || "", /attachment; filename="rocksolid-launch-workflow-RELPKG_ALPHA-stable-.*\.txt"/);
    assert.match(launchSummaryDownload.body, /Workflow Status: HOLD/);
    assert.match(launchSummaryDownload.body, /Authorization Status: BLOCK/);
    assert.match(launchSummaryDownload.body, /Recommended handoff zip/);
    assert.match(launchSummaryDownload.body, /Combined launch workflow zip/);

    const launchChecklistDownload = await getText(
      baseUrl,
      "/api/developer/launch-workflow/download?productCode=RELPKG_ALPHA&channel=stable&format=checklist",
      viewerSession.token
    );
    assert.match(launchChecklistDownload.contentType || "", /^text\/plain/);
    assert.match(launchChecklistDownload.contentDisposition || "", /attachment; filename="rocksolid-launch-workflow-RELPKG_ALPHA-stable-.*-checklist\.txt"/);
    assert.match(launchChecklistDownload.body, /RockSolid Launch Workflow Checklist/);
    assert.match(launchChecklistDownload.body, /\[BLOCK\] Authorization readiness/);
    assert.match(launchChecklistDownload.body, /workspace: Open License Workspace \| focus=quickstart/);
    assert.match(launchChecklistDownload.body, /bootstrap: Run Launch Bootstrap/);
    assert.doesNotMatch(launchChecklistDownload.body, /setup: Run First Batch Setup \| mode=recommended/);
    assert.match(launchChecklistDownload.body, /\[BLOCK\] Startup bootstrap decision/);
    assert.match(launchChecklistDownload.body, /workspace: Open Integration Workspace \| focus=startup/);

    const launchChecksumsDownload = await getText(
      baseUrl,
      "/api/developer/launch-workflow/download?productCode=RELPKG_ALPHA&channel=stable&format=checksums",
      viewerSession.token
    );
    assert.match(launchChecksumsDownload.contentType || "", /^text\/plain/);
    assert.match(launchChecksumsDownload.contentDisposition || "", /attachment; filename="rocksolid-launch-workflow-RELPKG_ALPHA-stable-.*-sha256\.txt"/);
    assert.match(launchChecksumsDownload.body, /rocksolid-launch-workflow-RELPKG_ALPHA-stable-.*\.json/);
    assert.match(launchChecksumsDownload.body, /release\/rocksolid-release-package-RELPKG_ALPHA-stable-.*\.json/);
    assert.match(launchChecksumsDownload.body, /integration\/rocksolid-integration-RELPKG_ALPHA\.json/);

    const launchHandoffChecksumsDownload = await getText(
      baseUrl,
      "/api/developer/launch-workflow/download?productCode=RELPKG_ALPHA&channel=stable&format=handoff-checksums",
      viewerSession.token
    );
    assert.match(launchHandoffChecksumsDownload.contentType || "", /^text\/plain/);
    assert.match(launchHandoffChecksumsDownload.contentDisposition || "", /attachment; filename="rocksolid-launch-workflow-RELPKG_ALPHA-stable-.*-handoff-sha256\.txt"/);
    assert.match(launchHandoffChecksumsDownload.body, /launch\/rocksolid-launch-workflow-RELPKG_ALPHA-stable-.*\.txt/);
    assert.match(launchHandoffChecksumsDownload.body, /release\/rocksolid-release-package-RELPKG_ALPHA-stable-.*\.txt/);
    assert.match(launchHandoffChecksumsDownload.body, /integration\/host-config\/rocksolid_host_config\.env/);
    assert.doesNotMatch(launchHandoffChecksumsDownload.body, /release\/rocksolid-release-package-RELPKG_ALPHA-stable-.*\.json/);
    assert.doesNotMatch(launchHandoffChecksumsDownload.body, /integration\/rocksolid-integration-RELPKG_ALPHA\.json/);

    const launchLinkedReleaseSummaryDownload = await getText(
      baseUrl,
      "/api/developer/launch-workflow/download?productCode=RELPKG_ALPHA&channel=stable&format=release-summary",
      viewerSession.token
    );
    assert.match(launchLinkedReleaseSummaryDownload.contentType || "", /^text\/plain/);
    assert.match(launchLinkedReleaseSummaryDownload.contentDisposition || "", /attachment; filename="rocksolid-release-package-RELPKG_ALPHA-stable-.*\.txt"/);
    assert.match(launchLinkedReleaseSummaryDownload.body, /RockSolid Release Delivery Package/);

    const launchLinkedIntegrationEnvDownload = await getText(
      baseUrl,
      "/api/developer/launch-workflow/download?productCode=RELPKG_ALPHA&channel=stable&format=integration-env",
      viewerSession.token
    );
    assert.match(launchLinkedIntegrationEnvDownload.contentType || "", /^text\/plain/);
    assert.match(launchLinkedIntegrationEnvDownload.contentDisposition || "", /attachment; filename="RELPKG_ALPHA\.env"/);
    assert.match(launchLinkedIntegrationEnvDownload.body, /RS_PROJECT_CODE=RELPKG_ALPHA/);

    const launchLinkedHostConfigDownload = await getText(
      baseUrl,
      "/api/developer/launch-workflow/download?productCode=RELPKG_ALPHA&channel=stable&format=integration-host-config",
      viewerSession.token
    );
    assert.match(launchLinkedHostConfigDownload.contentType || "", /^text\/plain/);
    assert.match(launchLinkedHostConfigDownload.contentDisposition || "", /attachment; filename="rocksolid_host_config\.env"/);
    assert.match(launchLinkedHostConfigDownload.body, /RS_PROJECT_CODE=RELPKG_ALPHA/);

    const launchLinkedCppDownload = await getText(
      baseUrl,
      "/api/developer/launch-workflow/download?productCode=RELPKG_ALPHA&channel=stable&format=integration-cpp",
      viewerSession.token
    );
    assert.match(launchLinkedCppDownload.contentType || "", /^text\/plain/);
    assert.match(launchLinkedCppDownload.contentDisposition || "", /attachment; filename="RELPKG_ALPHA\.cpp"/);
    assert.match(launchLinkedCppDownload.body, /startup_bootstrap_http/);

    const launchHandoffZipDownload = await getBinary(
      baseUrl,
      "/api/developer/launch-workflow/download?productCode=RELPKG_ALPHA&channel=stable&format=handoff-zip",
      viewerSession.token
    );
    assert.match(launchHandoffZipDownload.contentType || "", /^application\/zip/);
    assert.match(launchHandoffZipDownload.contentDisposition || "", /attachment; filename="rocksolid-launch-workflow-RELPKG_ALPHA-stable-.*-handoff\.zip"/);
    assert.equal(launchHandoffZipDownload.body.subarray(0, 4).toString("latin1"), "PK\u0003\u0004");
    const launchHandoffZipText = launchHandoffZipDownload.body.toString("latin1");
    assert.match(launchHandoffZipText, /launch\/rocksolid-launch-workflow-RELPKG_ALPHA-stable-.*\.txt/);
    assert.match(launchHandoffZipText, /launch\/rocksolid-launch-workflow-RELPKG_ALPHA-stable-.*-checklist\.txt/);
    assert.match(launchHandoffZipText, /release\/rocksolid-release-package-RELPKG_ALPHA-stable-.*\.txt/);
    assert.match(launchHandoffZipText, /integration\/host-config\/rocksolid_host_config\.env/);
    assert.match(launchHandoffZipText, /integration\/cmake-consumer\/CMakeLists\.txt/);
    assert.match(launchHandoffZipText, /integration\/vs2022-consumer\/RELPKG_ALPHA_host_consumer\.sln/);
    assert.match(launchHandoffZipText, /integration\/vs2022-consumer\/RockSolidSDK\.props/);
    assert.match(launchHandoffZipText, /integration\/vs2022-consumer\/RockSolidSDK\.local\.props/);
    assert.match(launchHandoffZipText, /integration\/snippets\/RELPKG_ALPHA\.cpp/);
    assert.match(launchHandoffZipText, /integration\/snippets\/RELPKG_ALPHA-host-skeleton\.cpp/);
    assert.match(launchHandoffZipText, /integration\/snippets\/RELPKG_ALPHA-hardening-guide\.txt/);
    assert.match(launchHandoffZipText, /SHA256SUMS\.txt/);
    assert.doesNotMatch(launchHandoffZipText, /release\/rocksolid-release-package-RELPKG_ALPHA-stable-.*\.json/);
    assert.doesNotMatch(launchHandoffZipText, /integration\/rocksolid-integration-RELPKG_ALPHA\.json/);

    const launchZipDownload = await getBinary(
      baseUrl,
      "/api/developer/launch-workflow/download?productCode=RELPKG_ALPHA&channel=stable&format=zip",
      viewerSession.token
    );
    assert.match(launchZipDownload.contentType || "", /^application\/zip/);
    assert.match(launchZipDownload.contentDisposition || "", /attachment; filename="rocksolid-launch-workflow-RELPKG_ALPHA-stable-.*\.zip"/);
    assert.equal(launchZipDownload.body.subarray(0, 4).toString("latin1"), "PK\u0003\u0004");
      const launchZipText = launchZipDownload.body.toString("latin1");
      assert.match(launchZipText, /rocksolid-launch-workflow-RELPKG_ALPHA-stable-.*\.json/);
      assert.match(launchZipText, /rocksolid-launch-workflow-RELPKG_ALPHA-stable-.*-checklist\.txt/);
      assert.match(launchZipText, /release\/rocksolid-release-package-RELPKG_ALPHA-stable-.*\.json/);
      assert.match(launchZipText, /integration\/rocksolid-integration-RELPKG_ALPHA\.json/);
      assert.match(launchZipText, /integration\/host-config\/rocksolid_host_config\.env/);
      assert.match(launchZipText, /integration\/host-skeleton\/RELPKG_ALPHA-host-skeleton\.cpp/);
      assert.match(launchZipText, /SHA256SUMS\.txt/);

      const launchReview = await getJson(
        baseUrl,
        "/api/developer/launch-review?productCode=RELPKG_ALPHA&channel=stable&eventType=session.login&actorType=account&reviewMode=matched",
        viewerSession.token
      );
      assert.match(launchReview.fileName, /^rocksolid-developer-launch-review-RELPKG_ALPHA-stable-/);
      assert.equal(launchReview.manifest.project.code, "RELPKG_ALPHA");
      assert.equal(launchReview.filters.eventType, "session.login");
      assert.equal(launchReview.filters.actorType, "account");
      assert.equal(launchReview.filters.reviewMode, "matched");
      assert.equal(launchReview.launchWorkflow.manifest.project.code, "RELPKG_ALPHA");
      assert.equal(launchReview.opsSnapshot.scope.eventType, "session.login");
      assert.equal(launchReview.opsSnapshot.scope.actorType, "account");
      assert.ok(launchReview.reviewSummary);
      assert.ok(launchReview.reviewSummary.mainlineGate);
      assert.ok(["hold", "attention", "ready"].includes(launchReview.reviewSummary.mainlineGate.status));
      assert.ok(launchReview.reviewSummary.mainlineGate.recommendedWorkspace?.key);
      assert.ok(launchReview.reviewSummary.mainlineGate.primaryAction?.key);
      assert.ok(launchReview.reviewSummary.mainlineGate.recommendedDownload?.key);
      assert.ok(Array.isArray(launchReview.reviewSummary.actionPlan));
      assert.ok(launchReview.reviewSummary.actionPlan.length >= 1);
    assert.ok(launchReview.reviewSummary.actionPlan.some((item) =>
      /^Open (Account|Entitlement|Session|Device) Control in Ops$/.test(item.workspaceAction?.label || "")
      && /^developer-ops-primary-(account|entitlement|session|device)-summary\.txt$/.test(item.recommendedDownload?.fileName || "")
    ));
      assert.ok(launchReview.reviewSummary.actionPlan.some((item) =>
        item.key === "launch_review_primary_target"
        && /^Prepare (account re-enable|account control|entitlement resume|entitlement control|7-day extension|point top-up|session review|session control|device unblock review|device control)$/i.test(item.title || "")
      ));
      assert.ok(launchReview.reviewSummary.actionPlan.some((item) =>
        item.key === "launch_review_remaining_queue"
        && item.recommendedDownload?.fileName === "developer-ops-remaining-summary.txt"
      ));
      assert.ok(launchReview.reviewSummary.actionPlan.some((item) =>
        item.key === "launch_review_route_continuation"
        && item.workspaceAction?.key === "ops"
        && /^(review_next|complete_route_review)$/.test(item.workspaceAction?.params?.routeAction || "")
        && /^(route-review-next|summary)$/.test(item.recommendedDownload?.format || "")
      ));
      assert.ok(launchReview.reviewSummary.actionPlan.some((item) =>
        /^ops_/.test(item.key || "")
        && /^Prepare (account re-enable|account control|entitlement resume|entitlement control|7-day extension|point top-up|session review|session control|device unblock review|device control)$/i.test(item.title || "")
      ));
      assert.ok(Array.isArray(launchReview.reviewSummary.reviewTargets));
      assert.ok(launchReview.reviewSummary.reviewTargets.length >= 1);
      assert.ok(launchReview.reviewSummary.primaryReviewTarget);
      assert.equal(launchReview.reviewSummary.primaryReviewTarget?.workspaceAction?.key, "ops");
      assert.match(
        launchReview.reviewSummary.primaryReviewTarget?.workspaceAction?.label || "",
        /^Open (Account|Entitlement|Session|Device) Control in Ops$/
      );
      assert.match(
        launchReview.reviewSummary.primaryReviewTarget?.workspaceAction?.params?.routeAction || "",
        /^control-(account|entitlement|session|device)$/
      );
      assert.match(
        launchReview.reviewSummary.primaryReviewTarget?.routeActionLabel || "",
        /^Open (Account|Entitlement|Session|Device) Control$/
      );
      assert.ok(launchReview.reviewSummary.primaryReviewTarget?.recommendedControl);
      assert.match(
        launchReview.reviewSummary.primaryReviewTarget?.recommendedControl?.label || "",
        /^Prepare (account re-enable|account control|entitlement resume|entitlement control|7-day extension|point top-up|session review|session control|device unblock review|device control)$/i
      );
      assert.match(
        launchReview.reviewSummary.primaryReviewTarget?.recommendedDownload?.fileName || "",
        /^developer-ops-primary-(account|entitlement|session|device)-summary\.txt$/
      );
      assert.match(
        launchReview.reviewSummary.primaryReviewTarget?.recommendedDownload?.label || "",
        /^Primary (account|entitlement|session|device) summary$/i
      );
    assert.ok(launchReview.reviewSummary.recommendedDownloads?.some((item) => /^developer-ops-primary-(account|entitlement|session|device)-summary\.txt$/.test(item.fileName || "")));
    assert.ok(launchReview.reviewSummary.recommendedDownloads?.some((item) => item.fileName === "developer-ops-remaining-summary.txt"));
    assert.ok(launchReview.reviewSummary.recommendedDownloads?.some((item) => item.key === "launch_mainline_summary" && item.source === "developer-launch-mainline"));
    assert.ok(launchReview.reviewSummary.recommendedDownloads?.some((item) => item.key === "launch_mainline_rehearsal_guide" && item.source === "developer-launch-mainline"));
    assert.ok(
      launchReview.reviewSummary.recommendedDownloads.findIndex((item) => item.key === "launch_mainline_rehearsal_guide")
      < launchReview.reviewSummary.recommendedDownloads.findIndex((item) => item.key === "launch_mainline_summary")
    );
    assert.ok(launchReview.reviewSummary.recommendedDownloads?.some((item) => item.key === "launch_mainline_zip" && item.source === "developer-launch-mainline"));
    assert.ok(launchReview.reviewSummary.recommendedDownloads?.some((item) => item.key === "launch_mainline_checksums" && item.source === "developer-launch-mainline"));
      assert.ok(launchReview.reviewSummary.reviewTargets.some((item) => item.workspaceAction?.key === "ops"));
      assert.ok(launchReview.reviewSummary.reviewTargets.some((item) => item.routeAction));
      assert.ok(launchReview.reviewSummary.reviewTargets.some((item) => item.routeActionLabel));
      assert.ok(launchReview.reviewSummary.reviewTargets.some((item) => item.recommendedControl?.label));
      assert.ok(launchReview.reviewSummary.reviewTargets.some((item) => item.workspaceAction?.params?.routeAction));
      assert.ok(launchReview.reviewSummary.reviewTargets.some((item) => /^control-(account|entitlement|session|device)$/.test(item.workspaceAction?.params?.routeAction || "")));
      assert.ok(launchReview.reviewSummary.reviewTargets.some((item) =>
        /^control-(account|entitlement|session|device)$/.test(item.workspaceAction?.params?.routeAction || "")
        && /^Open (Account|Entitlement|Session|Device) Control in Ops$/.test(item.workspaceAction?.label || "")
        && /^Open (Account|Entitlement|Session|Device) Control$/.test(item.routeActionLabel || "")
      ));
      assert.ok(launchReview.reviewSummary.reviewTargets.some((item) => item.workspaceAction?.params?.focusKind));
      assert.ok(launchReview.reviewSummary.reviewTargets.some((item) => {
        const params = item.workspaceAction?.params || {};
        return Boolean(
          params.focusKind
          && (params.focusAccountId || params.focusEntitlementId || params.focusSessionId || params.focusBindingId || params.focusBlockId || params.focusUsername || params.focusFingerprint || params.focusProductCode)
        );
      }));
      assert.ok(Array.isArray(launchReview.reviewSummary.recommendedDownloads));
      assert.ok(launchReview.reviewSummary.recommendedDownloads.some((item) => item.key === "launch_review_summary"));
      assert.ok(launchReview.reviewSummary.actionPlan.some((item) => item.key === "launch_mainline_overview" && item.recommendedDownload?.key === "launch_mainline_rehearsal_guide"));
      assert.ok(launchReview.reviewSummary.workspaceActions?.some((item) => /^Open (Account|Entitlement|Session|Device) Control in Ops$/.test(item.label || "")));
      assert.ok(launchReview.reviewSummary.recommendedWorkspace?.key);
      assert.match(launchReview.summaryText, /RockSolid Developer Launch Review/);
      assert.match(launchReview.summaryText, /Launch Mainline Gate:/);
      assert.match(launchReview.summaryText, /RockSolid Launch Workflow Package/);
      assert.match(launchReview.summaryText, /RockSolid Developer Ops Snapshot/);
      assert.match(launchReview.summaryText, /Launch Review Action Plan:/);
      assert.match(launchReview.summaryText, /Launch Review Focus Targets:/);
      assert.match(launchReview.summaryText, /action=Open (Account|Entitlement|Session|Device) Control/);
      assert.match(
        launchReview.summaryText,
        /control=Prepare (account re-enable|account control|entitlement resume|entitlement control|7-day extension|point top-up|session review|session control|device unblock review|device control)/i
      );
      assert.match(launchReview.summaryText, /Launch Review Recommended Downloads:/);

      const launchReviewSummaryDownload = await getText(
        baseUrl,
        "/api/developer/launch-review/download?productCode=RELPKG_ALPHA&channel=stable&eventType=session.login&actorType=account&reviewMode=matched&format=summary",
        viewerSession.token
      );
      assert.match(launchReviewSummaryDownload.contentType || "", /^text\/plain/);
      assert.match(launchReviewSummaryDownload.contentDisposition || "", /attachment; filename="rocksolid-developer-launch-review-RELPKG_ALPHA-stable-.*-summary\.txt"/);
      assert.match(launchReviewSummaryDownload.body, /RockSolid Developer Launch Review/);
      assert.match(launchReviewSummaryDownload.body, /Ops Event Filter: session\.login/);
      assert.match(launchReviewSummaryDownload.body, /Ops Actor Filter: account/);
      assert.match(launchReviewSummaryDownload.body, /Launch Workflow Summary:/);
      assert.match(launchReviewSummaryDownload.body, /Ops Snapshot Summary:/);

      const launchMainline = await getJson(
        baseUrl,
        "/api/developer/launch-mainline?productCode=RELPKG_ALPHA&channel=stable&eventType=session.login&actorType=account&reviewMode=matched",
        viewerSession.token
      );
      assert.match(launchMainline.fileName, /^rocksolid-developer-launch-mainline-RELPKG_ALPHA-stable-/);
      assert.equal(launchMainline.manifest.project.code, "RELPKG_ALPHA");
      assert.ok(launchMainline.mainlineSummary);
      assert.equal(launchMainline.mainlineSummary.overallGate?.status, "hold");
      assert.equal(launchMainline.mainlineSummary.releaseGate?.status, "hold");
      assert.equal(launchMainline.mainlineSummary.workflowGate?.status, "hold");
      assert.ok(["hold", "attention", "ready"].includes(launchMainline.mainlineSummary.reviewGate?.status));
      assert.ok(["hold", "attention", "ready"].includes(launchMainline.mainlineSummary.smokeGate?.status));
      assert.ok(["hold", "attention", "ready"].includes(launchMainline.mainlineSummary.opsGate?.status));
      assert.ok(launchMainline.mainlineSummary.overallGate?.recommendedWorkspace?.key);
      assert.ok(launchMainline.mainlineSummary.primaryAction?.key);
      assert.ok(launchMainline.mainlineSummary.recommendedDownload?.key);
      assert.ok(Array.isArray(launchMainline.mainlineSummary.stages));
      assert.ok(Array.isArray(launchMainline.mainlineSummary.workspaceActions));
      assert.ok(launchMainline.mainlineSummary.workspaceActions.some((item) => item.key === "release"));
      assert.ok(launchMainline.mainlineSummary.workspaceActions.some((item) => item.key === "ops"));
      assert.deepEqual(
        Array.isArray(launchMainline.mainlineSummary.overviewCards)
          ? launchMainline.mainlineSummary.overviewCards.map((item) => item?.key || null)
          : [],
        ["overall_gate", "workspace_path", "recommended_downloads"]
      );
      assert.ok(
        launchMainline.mainlineSummary.overviewCards?.find((item) => item?.key === "overall_gate")?.controls?.some((control) => control?.workspaceAction?.key || control?.recommendedDownload?.key)
      );
      assert.ok(
        launchMainline.mainlineSummary.overviewCards?.find((item) => item?.key === "workspace_path")?.controls?.some((control) => control?.workspaceAction?.key === launchMainline.mainlineSummary.recommendedWorkspace?.key)
      );
      assert.ok(
        launchMainline.mainlineSummary.overviewCards?.find((item) => item?.key === "recommended_downloads")?.controls?.some((control) => control?.recommendedDownload?.key === "launch_mainline_summary")
      );
      assert.ok(launchMainline.mainlineSummary.stages.some((item) => item.key === "release" && item.workspaceAction?.key));
      assert.ok(launchMainline.mainlineSummary.stages.some((item) => item.key === "ops" && item.recommendedDownload?.key));
      assert.ok(launchMainline.mainlineSummary.productionGate);
      assert.ok(
        launchMainline.mainlineSummary.stages.some((item) =>
          item.key === "production"
          && item.workspaceAction?.key === launchMainline.mainlineSummary.productionGate?.recommendedWorkspace?.key
        )
      );
      assert.ok(launchMainline.mainlineSummary.continuation);
      assert.equal(launchMainline.mainlineSummary.continuation?.workspaceAction?.key, "ops");
      assert.match(launchMainline.mainlineSummary.continuation?.workspaceAction?.params?.routeAction || "", /^(review_next|complete_route_review)$/);
      assert.match(launchMainline.mainlineSummary.continuation?.recommendedDownload?.format || "", /^(route-review-next|summary)$/);
      assert.ok(launchMainline.mainlineSummary.actionPlan.some((item) => item.key === "launch_mainline_route_continuation" && item.workspaceAction?.key === "ops"));
      assert.ok(launchMainline.mainlineSummary.recommendedDownloads.some((item) => item.key === launchMainline.mainlineSummary.continuation?.recommendedDownload?.key));
      assert.equal(
        launchMainline.mainlineSummary.primaryAction?.key,
        launchMainline.mainlineSummary.overallGate?.primaryAction?.key
      );
      assert.equal(
        launchMainline.mainlineSummary.recommendedDownload?.key,
        launchMainline.mainlineSummary.overallGate?.recommendedDownload?.key
      );
      assert.ok(Array.isArray(launchMainline.mainlineSummary.actionPlan));
      assert.ok(launchMainline.mainlineSummary.actionPlan.some((item) => item.key === "release_mainline"));
      assert.ok(launchMainline.mainlineSummary.actionPlan.some((item) => item.key === "ops_mainline"));
      assert.ok(Array.isArray(launchMainline.mainlineSummary.recommendedDownloads));
      assert.ok(launchMainline.mainlineSummary.recommendedDownloads.some((item) => item.key === "release_summary"));
      assert.ok(launchMainline.mainlineSummary.recommendedDownloads.some((item) => item.key === "launch_summary"));
      assert.ok(launchMainline.mainlineSummary.recommendedDownloads.some((item) => item.key === "launch_review_summary"));
      assert.ok(launchMainline.mainlineSummary.recommendedDownloads.some((item) => item.key === "launch_smoke_kit_summary"));
      assert.ok(launchMainline.mainlineSummary.recommendedDownloads.some((item) => item.key === "route_review_primary"));
      assert.ok(launchMainline.mainlineSummary.recommendedDownloads.some((item) => item.key === "route_review_remaining"));
      assert.ok(launchMainline.mainlineSummary.recommendedDownloads.some((item) => item.key === "ops_summary"));
      assert.ok(launchMainline.mainlineSummary.recommendedDownloads.some((item) => item.key === "launch_mainline_production_handoff"));
      assert.ok(launchMainline.mainlineSummary.recommendedDownloads.some((item) => item.key === "launch_mainline_operations_handoff"));
      assert.ok(launchMainline.mainlineSummary.recommendedDownloads.some((item) => item.key === "launch_mainline_post_launch_sweep_handoff"));
      assert.ok(launchMainline.mainlineSummary.recommendedDownloads.some((item) => item.key === "launch_mainline_closeout_handoff"));
      assert.ok(launchMainline.mainlineSummary.recommendedDownloads.some((item) => item.key === "launch_mainline_stabilization_handoff"));
      assert.ok(launchMainline.mainlineSummary.recommendedDownloads.some((item) => item.key === "launch_mainline_rehearsal_guide"));
      assert.ok(
        launchMainline.mainlineSummary.recommendedDownloads.findIndex((item) => item.key === "launch_mainline_rehearsal_guide")
        < launchMainline.mainlineSummary.recommendedDownloads.findIndex((item) => item.key === "launch_mainline_summary")
      );
      assert.ok(
        launchMainline.mainlineSummary.overviewCards?.find((item) => item?.key === "recommended_downloads")?.controls?.findIndex((control) => control?.recommendedDownload?.key === "launch_mainline_rehearsal_guide")
        < launchMainline.mainlineSummary.overviewCards?.find((item) => item?.key === "recommended_downloads")?.controls?.findIndex((control) => control?.recommendedDownload?.key === "launch_mainline_summary")
      );
      assert.match(launchMainline.summaryText, /RockSolid Developer Launch Mainline/);
      assert.match(launchMainline.summaryText, /Launch Mainline Gate:/);
      assert.match(launchMainline.summaryText, /Primary Mainline Action:/);
      assert.match(launchMainline.summaryText, /Mainline Recommended Download:/);
      assert.match(launchMainline.summaryText, /Mainline Continuation:/);
      assert.match(launchMainline.summaryText, /Mainline Hero Controls:/);
      assert.match(launchMainline.summaryText, /Open Release Workspace/);
      assert.match(launchMainline.summaryText, /Download Launch Mainline Summary/);
      assert.match(launchMainline.summaryText, /Mainline Next Actions:/);
      assert.match(launchMainline.summaryText, /Stage Gates:/);
      assert.match(launchMainline.summaryText, /Production:/);
      assert.match(launchMainline.summaryText, /Ops:/);
      assert.match(launchMainline.summaryText, /Production Handoff:/);
      assert.match(launchMainline.summaryText, /healthcheck-rocksolid/);
      assert.match(launchMainline.summaryText, /backup-rocksolid/);
      assert.match(launchMainline.summaryText, /Production Cutover Handoff:/);
      assert.match(launchMainline.summaryText, /run-rocksolid/);
      assert.match(launchMainline.summaryText, /Production Recovery Drill Handoff:/);
      assert.match(launchMainline.summaryText, /restore-postgres/);
      assert.match(launchMainline.summaryText, /Production Operations Handoff:/);
      assert.match(launchMainline.summaryText, /observability-guide\.md/);
      assert.match(launchMainline.summaryText, /shift-handover-template\.md/);
      assert.match(launchMainline.summaryText, /Production Post-Launch Sweep Handoff:/);
      assert.match(launchMainline.summaryText, /Continue Routed Review/);
      assert.match(launchMainline.summaryText, /Remaining routed review queue/);
      assert.match(launchMainline.summaryText, /Production Launch Closeout Handoff:/);
      assert.match(launchMainline.summaryText, /Launch closeout review/);
      assert.match(launchMainline.summaryText, /first-wave ops sweep/i);
      assert.match(launchMainline.summaryText, /Production Stabilization Handoff:/);
      assert.match(launchMainline.summaryText, /Launch stabilization review/);
      assert.match(launchMainline.summaryText, /daily-operations-checklist\.md/);
      assert.match(launchMainline.summaryText, /Launch Mainline Rehearsal Guide:/);
      assert.match(launchMainline.summaryText, /Phase 1: Release And Workflow Precheck/);
      assert.match(launchMainline.summaryText, /Record Launch Rehearsal Run/);
      assert.match(launchMainline.summaryText, /Record Launch Stabilization Review/);

      const launchMainlineSummaryDownload = await getText(
        baseUrl,
        "/api/developer/launch-mainline/download?productCode=RELPKG_ALPHA&channel=stable&eventType=session.login&actorType=account&reviewMode=matched&format=summary",
        viewerSession.token
      );
      assert.match(launchMainlineSummaryDownload.contentType || "", /^text\/plain/);
      assert.match(launchMainlineSummaryDownload.contentDisposition || "", /attachment; filename="rocksolid-developer-launch-mainline-RELPKG_ALPHA-stable-.*-summary\.txt"/);
      assert.match(launchMainlineSummaryDownload.body, /RockSolid Developer Launch Mainline/);
      assert.match(launchMainlineSummaryDownload.body, /Primary Mainline Action:/);
      assert.match(launchMainlineSummaryDownload.body, /Mainline Hero Controls:/);
      assert.match(launchMainlineSummaryDownload.body, /Download Launch Mainline Zip/);
      assert.match(launchMainlineSummaryDownload.body, /Mainline Next Actions:/);
      assert.match(launchMainlineSummaryDownload.body, /Stage Gates:/);
      assert.match(launchMainlineSummaryDownload.body, /Production Handoff:/);
      assert.match(launchMainlineSummaryDownload.body, /Production Cutover Handoff:/);
      assert.match(launchMainlineSummaryDownload.body, /Production Recovery Drill Handoff:/);
      assert.match(launchMainlineSummaryDownload.body, /Production Operations Handoff:/);
      assert.match(launchMainlineSummaryDownload.body, /Production Post-Launch Sweep Handoff:/);
      assert.match(launchMainlineSummaryDownload.body, /Production Launch Closeout Handoff:/);
      assert.match(launchMainlineSummaryDownload.body, /Production Stabilization Handoff:/);
      assert.match(launchMainlineSummaryDownload.body, /Launch Mainline Rehearsal Guide:/);

      const productionHandoffDownload = await getText(
        baseUrl,
        "/api/developer/launch-mainline/download?productCode=RELPKG_ALPHA&channel=stable&eventType=session.login&actorType=account&reviewMode=matched&format=production-handoff",
        viewerSession.token
      );
      assert.match(productionHandoffDownload.contentType || "", /^text\/plain/);
      assert.match(productionHandoffDownload.contentDisposition || "", /attachment; filename="rocksolid-developer-launch-mainline-RELPKG_ALPHA-stable-.*-production-handoff\.txt"/);
      assert.match(productionHandoffDownload.body, /RockSolid Developer Launch Mainline Production Handoff/);
      assert.match(productionHandoffDownload.body, /deploy\/linux\/healthcheck-rocksolid\.sh/);
      assert.match(productionHandoffDownload.body, /deploy\/windows\/healthcheck-rocksolid\.ps1/);
      assert.match(productionHandoffDownload.body, /deploy\/linux\/backup-rocksolid\.sh/);
      assert.match(productionHandoffDownload.body, /docs\/linux-deployment\.md/);
      assert.match(productionHandoffDownload.body, /docs\/windows-deployment-guide\.md/);

      const cutoverHandoffDownload = await getText(
        baseUrl,
        "/api/developer/launch-mainline/download?productCode=RELPKG_ALPHA&channel=stable&eventType=session.login&actorType=account&reviewMode=matched&format=cutover-handoff",
        viewerSession.token
      );
      assert.match(cutoverHandoffDownload.contentType || "", /^text\/plain/);
      assert.match(cutoverHandoffDownload.contentDisposition || "", /attachment; filename="rocksolid-developer-launch-mainline-RELPKG_ALPHA-stable-.*-cutover-handoff\.txt"/);
      assert.match(cutoverHandoffDownload.body, /RockSolid Developer Launch Mainline Cutover Handoff/);
      assert.match(cutoverHandoffDownload.body, /deploy\/linux\/run-rocksolid\.sh/);
      assert.match(cutoverHandoffDownload.body, /deploy\/windows\/run-rocksolid\.ps1/);
      assert.match(cutoverHandoffDownload.body, /\/api\/health/);
      assert.match(cutoverHandoffDownload.body, /deploy\/linux\/Caddyfile\.example/);
      assert.match(cutoverHandoffDownload.body, /rollback/i);

      const recoveryDrillHandoffDownload = await getText(
        baseUrl,
        "/api/developer/launch-mainline/download?productCode=RELPKG_ALPHA&channel=stable&eventType=session.login&actorType=account&reviewMode=matched&format=recovery-drill-handoff",
        viewerSession.token
      );
      assert.match(recoveryDrillHandoffDownload.contentType || "", /^text\/plain/);
      assert.match(recoveryDrillHandoffDownload.contentDisposition || "", /attachment; filename="rocksolid-developer-launch-mainline-RELPKG_ALPHA-stable-.*-recovery-drill-handoff\.txt"/);
      assert.match(recoveryDrillHandoffDownload.body, /RockSolid Developer Launch Mainline Recovery Drill Handoff/);
      assert.match(recoveryDrillHandoffDownload.body, /docs\/postgres-backup-restore\.md/);
      assert.match(recoveryDrillHandoffDownload.body, /deploy\/postgres\/restore-postgres\.sh/);
      assert.match(recoveryDrillHandoffDownload.body, /deploy\/windows\/backup-rocksolid\.ps1/);

      const operationsHandoffDownload = await getText(
        baseUrl,
        "/api/developer/launch-mainline/download?productCode=RELPKG_ALPHA&channel=stable&eventType=session.login&actorType=account&reviewMode=matched&format=operations-handoff",
        viewerSession.token
      );
      assert.match(operationsHandoffDownload.contentType || "", /^text\/plain/);
      assert.match(operationsHandoffDownload.contentDisposition || "", /attachment; filename="rocksolid-developer-launch-mainline-RELPKG_ALPHA-stable-.*-operations-handoff\.txt"/);
      assert.match(operationsHandoffDownload.body, /RockSolid Developer Launch Mainline Operations Handoff/);
      assert.match(operationsHandoffDownload.body, /docs\/observability-guide\.md/);
      assert.match(operationsHandoffDownload.body, /docs\/production-operations-runbook\.md/);
      assert.match(operationsHandoffDownload.body, /docs\/incident-response-playbook\.md/);
      assert.match(operationsHandoffDownload.body, /docs\/shift-handover-template\.md/);

      const postLaunchSweepHandoffDownload = await getText(
        baseUrl,
        "/api/developer/launch-mainline/download?productCode=RELPKG_ALPHA&channel=stable&eventType=session.login&actorType=account&reviewMode=matched&format=post-launch-sweep-handoff",
        viewerSession.token
      );
      assert.match(postLaunchSweepHandoffDownload.contentType || "", /^text\/plain/);
      assert.match(postLaunchSweepHandoffDownload.contentDisposition || "", /attachment; filename="rocksolid-developer-launch-mainline-RELPKG_ALPHA-stable-.*-post-launch-sweep-handoff\.txt"/);
      assert.match(postLaunchSweepHandoffDownload.body, /RockSolid Developer Launch Mainline Post-Launch Sweep Handoff/);
      assert.match(postLaunchSweepHandoffDownload.body, /Continue Routed Review/);
      assert.match(postLaunchSweepHandoffDownload.body, /Remaining routed review queue/);
      assert.match(postLaunchSweepHandoffDownload.body, /developer-ops-summary/);

      const closeoutHandoffDownload = await getText(
        baseUrl,
        "/api/developer/launch-mainline/download?productCode=RELPKG_ALPHA&channel=stable&eventType=session.login&actorType=account&reviewMode=matched&format=closeout-handoff",
        viewerSession.token
      );
      assert.match(closeoutHandoffDownload.contentType || "", /^text\/plain/);
      assert.match(closeoutHandoffDownload.contentDisposition || "", /attachment; filename=\"rocksolid-developer-launch-mainline-RELPKG_ALPHA-stable-.*-closeout-handoff\.txt\"/);
      assert.match(closeoutHandoffDownload.body, /RockSolid Developer Launch Mainline Closeout Handoff/);
      assert.match(closeoutHandoffDownload.body, /Launch closeout review/);
      assert.match(closeoutHandoffDownload.body, /first-wave ops sweep/i);
      assert.match(closeoutHandoffDownload.body, /shift-handover-template\.md/);

      const stabilizationHandoffDownload = await getText(
        baseUrl,
        "/api/developer/launch-mainline/download?productCode=RELPKG_ALPHA&channel=stable&eventType=session.login&actorType=account&reviewMode=matched&format=stabilization-handoff",
        viewerSession.token
      );
      assert.match(stabilizationHandoffDownload.contentType || "", /^text\/plain/);
      assert.match(stabilizationHandoffDownload.contentDisposition || "", /attachment; filename=\"rocksolid-developer-launch-mainline-RELPKG_ALPHA-stable-.*-stabilization-handoff\.txt\"/);
      assert.match(stabilizationHandoffDownload.body, /RockSolid Developer Launch Mainline Stabilization Handoff/);
      assert.match(stabilizationHandoffDownload.body, /Launch stabilization review/);
      assert.match(stabilizationHandoffDownload.body, /shift-handover-template\.md/);
      assert.match(stabilizationHandoffDownload.body, /daily-operations-checklist\.md/);

      const rehearsalGuideDownload = await getText(
        baseUrl,
        "/api/developer/launch-mainline/download?productCode=RELPKG_ALPHA&channel=stable&eventType=session.login&actorType=account&reviewMode=matched&format=rehearsal-guide",
        viewerSession.token
      );
      assert.match(rehearsalGuideDownload.contentType || "", /^text\/plain/);
      assert.match(rehearsalGuideDownload.contentDisposition || "", /attachment; filename=\"rocksolid-developer-launch-mainline-RELPKG_ALPHA-stable-.*-rehearsal-guide\.txt\"/);
      assert.match(rehearsalGuideDownload.body, /RockSolid Developer Launch Mainline Rehearsal Guide/);
      assert.match(rehearsalGuideDownload.body, /Phase 1: Release And Workflow Precheck/);
      assert.match(rehearsalGuideDownload.body, /Phase 5: Evidence Recording Order/);
      assert.match(rehearsalGuideDownload.body, /Record Launch Rehearsal Run/);
      assert.match(rehearsalGuideDownload.body, /Record Launch Stabilization Review/);

      const launchMainlineChecksumsDownload = await getText(
        baseUrl,
        "/api/developer/launch-mainline/download?productCode=RELPKG_ALPHA&channel=stable&eventType=session.login&actorType=account&reviewMode=matched&format=checksums",
        viewerSession.token
      );
      assert.match(launchMainlineChecksumsDownload.contentType || "", /^text\/plain/);
      assert.match(launchMainlineChecksumsDownload.contentDisposition || "", /attachment; filename=\"rocksolid-developer-launch-mainline-RELPKG_ALPHA-stable-.*-sha256\.txt\"/);
      assert.match(launchMainlineChecksumsDownload.body, /rocksolid-developer-launch-mainline-RELPKG_ALPHA-stable-.*-rehearsal-guide\.txt/);

      const forbidden = await getJsonExpectError(
        baseUrl,
        "/api/developer/release-package?productCode=RELPKG_BETA&channel=stable",
        viewerSession.token
    );
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.error.code, "DEVELOPER_PRODUCT_FORBIDDEN");

    const viewerAuditLogs = await getJson(baseUrl, "/api/developer/audit-logs?limit=120", viewerSession.token);
    assert.ok(viewerAuditLogs.items.some((entry) => entry.event_type === "product.release-package.export"));
    assert.ok(viewerAuditLogs.items.some((entry) => entry.event_type === "product.launch-workflow.export"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer launch mainline production gate blocks default launch secrets and routes to security", async () => {
  const { app, baseUrl, tempDir } = await startServer({
    adminPassword: "ChangeMe!123",
    serverTokenSecret: "change-me-before-production-rocksolid"
  });

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "ChangeMe!123"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "launch.mainline.production.owner",
        password: "LaunchMainlineProductionOwner123!",
        displayName: "Launch Mainline Production Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "MAINLINE_PROD",
        name: "Mainline Production App",
        ownerDeveloperId: owner.id,
        featureConfig: {
          allowRegister: true,
          allowAccountLogin: true,
          allowCardLogin: true,
          allowCardRecharge: true
        }
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "launch.mainline.production.owner",
      password: "LaunchMainlineProductionOwner123!"
    });

    const launchMainline = await getJson(
      baseUrl,
      "/api/developer/launch-mainline?productCode=MAINLINE_PROD&channel=stable&reviewMode=matched",
      ownerSession.token
    );

    assert.equal(launchMainline.mainlineSummary.productionGate?.status, "hold");
    assert.ok(Number(launchMainline.mainlineSummary.productionGate?.blockingCount || 0) >= 2);
    assert.equal(launchMainline.mainlineSummary.productionGate?.recommendedWorkspace?.key, "security");
    assert.ok(Array.isArray(launchMainline.mainlineSummary.productionGate?.remainingEvidenceChecks));
    assert.ok(launchMainline.mainlineSummary.productionGate.remainingEvidenceChecks.length >= 1);
    assert.equal(
      launchMainline.mainlineSummary.productionGate.nextEvidenceAction?.setupAction?.operation,
      "record_launch_rehearsal_run"
    );
    assert.equal(
      launchMainline.mainlineSummary.productionGate.nextEvidenceAction?.key,
      launchMainline.mainlineSummary.productionGate.remainingEvidenceChecks[0]?.key
    );
    assert.equal(
      launchMainline.mainlineSummary.productionGate.evidenceQueue?.nextAction?.key,
      launchMainline.mainlineSummary.productionGate.nextEvidenceAction?.key
    );
    assert.equal(
      launchMainline.mainlineSummary.productionGate.evidenceQueue?.remainingCount,
      launchMainline.mainlineSummary.productionGate.remainingEvidenceChecks.length
    );
    assert.equal(launchMainline.mainlineSummary.productionGate.evidenceQueue?.completedCount, 0);
    assert.ok(Number(launchMainline.mainlineSummary.productionGate.evidenceQueue?.totalCount || 0) >= 8);
    assert.equal(
      launchMainline.mainlineSummary.productionGate.evidenceQueue?.items?.[0]?.setupAction?.operation,
      "record_launch_rehearsal_run"
    );
    const productionEvidenceQueueSection = Array.isArray(launchMainline.mainlineSummary.sections)
      ? launchMainline.mainlineSummary.sections.find((item) => item?.key === "production_evidence_queue")
      : null;
    assert.deepEqual(
      productionEvidenceQueueSection
        ? {
            key: productionEvidenceQueueSection.key || null,
            title: productionEvidenceQueueSection.title || null,
            emptyState: productionEvidenceQueueSection.emptyState || null,
            cards: Array.isArray(productionEvidenceQueueSection.cards)
              ? productionEvidenceQueueSection.cards.map((item) => item?.key || null)
              : []
          }
        : null,
      {
        key: "production_evidence_queue",
        title: "Production Evidence Queue",
        emptyState: "Generate a launch mainline package to inspect the production evidence queue here.",
        cards: [
          "production_evidence_queue_progress",
          "production_evidence_queue_next",
          ...(Array.isArray(launchMainline.mainlineSummary.productionGate.evidenceQueue?.items)
            ? launchMainline.mainlineSummary.productionGate.evidenceQueue.items.map((item) => item?.key || null)
            : [])
        ]
      }
    );
    const productionEvidenceQueueCards = Object.fromEntries(
      Array.isArray(productionEvidenceQueueSection?.cards)
        ? productionEvidenceQueueSection.cards.map((item) => [item?.key || null, item])
        : []
    );
    assert.deepEqual(
      Array.isArray(productionEvidenceQueueCards.production_evidence_queue_progress?.tags)
        ? productionEvidenceQueueCards.production_evidence_queue_progress.tags.map((item) => ({
            label: item?.label || null,
            value: item?.value ?? null,
            strong: Boolean(item?.strong)
          }))
        : [],
      [
        {
          label: "completed",
          value: launchMainline.mainlineSummary.productionGate.evidenceQueue?.completedCount,
          strong: true
        },
        {
          label: "remaining",
          value: launchMainline.mainlineSummary.productionGate.evidenceQueue?.remainingCount,
          strong: true
        },
        {
          label: "total",
          value: launchMainline.mainlineSummary.productionGate.evidenceQueue?.totalCount,
          strong: false
        }
      ]
    );
    assert.ok(productionEvidenceQueueCards.production_evidence_queue_progress?.details?.some((detail) => /Remaining:/i.test(String(detail || ""))));
    assert.ok(productionEvidenceQueueCards.production_evidence_queue_progress?.details?.some((detail) => /Completed:/i.test(String(detail || ""))));
    assert.equal(
      productionEvidenceQueueCards.production_evidence_queue_next?.controls?.some((control) =>
        control?.kind === "setup"
        && control?.setupAction?.operation === "record_launch_rehearsal_run"
      ),
      true
    );
    assert.equal(
      productionEvidenceQueueCards.production_launch_rehearsal_run_recent?.controls?.some((control) =>
        control?.kind === "setup"
        && control?.setupAction?.operation === "record_launch_rehearsal_run"
      ),
      true
    );
    assert.ok(launchMainline.mainlineSummary.productionGate.remainingEvidenceChecks.every((item) =>
      item?.setupAction?.operation
      && item?.status !== "pass"
    ));
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.productionGate?.checks)
      && launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_backup_restore_handoff"
        && item?.status === "pass"
      )
    );
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.productionGate?.checks)
      && launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_cutover_handoff"
        && item?.status === "pass"
      )
    );
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.productionGate?.checks)
      && launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_cutover_walkthrough_recent"
        && item?.status === "block"
        && item?.setupAction?.operation === "record_cutover_walkthrough"
      )
    );
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.productionGate?.checks)
      && launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_launch_day_readiness_review_recent"
        && item?.status === "block"
        && item?.setupAction?.operation === "record_launch_day_readiness_review"
      )
    );
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.productionGate?.checks)
      && launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_recovery_drill_handoff"
        && item?.status === "pass"
      )
    );
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.productionGate?.checks)
      && launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_recovery_drill_recent"
        && item?.status === "block"
        && item?.setupAction?.operation === "record_recovery_drill"
      )
    );
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.productionGate?.checks)
      && launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_backup_verification_recent"
        && item?.status === "block"
        && item?.setupAction?.operation === "record_backup_verification"
      )
    );
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.productionGate?.checks)
      && launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_operations_walkthrough_recent"
        && item?.status === "block"
        && item?.setupAction?.operation === "record_operations_walkthrough"
      )
    );
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.productionGate?.checks)
      && launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_deploy_verification_recent"
        && item?.status === "block"
        && item?.setupAction?.operation === "record_deploy_verification"
      )
    );
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.productionGate?.checks)
      && launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_health_verification_recent"
        && item?.status === "block"
        && item?.setupAction?.operation === "record_health_verification"
      )
    );
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.productionGate?.checks)
      && launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_rollback_walkthrough_recent"
        && item?.status === "block"
        && item?.setupAction?.operation === "record_rollback_walkthrough"
      )
    );
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.productionGate?.checks)
      && launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_operations_handoff"
        && item?.status === "pass"
      )
    );
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.productionGate?.checks)
      && launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_post_launch_sweep_handoff"
        && item?.status === "pass"
      )
    );
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.productionGate?.checks)
      && launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_launch_closeout_handoff"
        && item?.status === "pass"
      )
    );
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.productionGate?.checks)
      && launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_stabilization_handoff"
        && item?.status === "pass"
      )
    );
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.productionGate?.checks)
      && launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_post_launch_ops_sweep_recent"
        && item?.status === "block"
        && item?.setupAction?.operation === "record_post_launch_ops_sweep"
      )
    );
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.productionGate?.checks)
      && launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_launch_closeout_review_recent"
        && item?.status === "block"
        && item?.setupAction?.operation === "record_launch_closeout_review"
      )
    );
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.productionGate?.checks)
      && launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_launch_stabilization_review_recent"
        && item?.status === "block"
        && item?.setupAction?.operation === "record_launch_stabilization_review"
      )
    );
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.productionGate?.actionPlan)
      && launchMainline.mainlineSummary.productionGate.actionPlan.some((item) =>
        item?.key === "production_default_admin_password"
        && item?.workspaceAction?.key === "security"
      )
    );
    assert.deepEqual(
      Array.isArray(launchMainline.mainlineSummary.sections)
        ? (() => {
            const section = launchMainline.mainlineSummary.sections.find((item) => item?.key === "production_checks");
            return section
              ? {
                  key: section.key || null,
                  title: section.title || null,
                  emptyState: section.emptyState || null,
                  cards: Array.isArray(section.cards) ? section.cards.map((item) => item?.key || null) : []
                }
              : null;
          })()
        : null,
      {
        key: "production_checks",
        title: "Production Gate Checks",
        emptyState: "Generate a launch mainline package to inspect the production readiness checks here.",
        cards: Array.isArray(launchMainline.mainlineSummary.productionGate?.checks)
          ? launchMainline.mainlineSummary.productionGate.checks.map((item) => item?.key || null)
          : []
      }
    );
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.stages)
      && launchMainline.mainlineSummary.stages.some((item) =>
        item?.key === "production"
        && item?.workspaceAction?.key === "security"
      )
    );
    assert.match(launchMainline.summaryText || "", /Production:/);
    assert.match(launchMainline.summaryText || "", /default admin password/i);
    assert.match(launchMainline.summaryText || "", /server token secret/i);
    assert.match(launchMainline.summaryText || "", /backup and restore handoff/i);
    assert.match(launchMainline.summaryText || "", /Production Next Evidence Action:/);
    assert.match(launchMainline.summaryText || "", /record_launch_rehearsal_run/);
    assert.match(launchMainline.summaryText || "", /Production Evidence Queue:/);
    assert.match(launchMainline.summaryText || "", /completed=0/);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer launch mainline production gate blocks loopback entrypoints and flags single-host storage", async () => {
  const { app, baseUrl, tempDir } = await startServer({
    adminPassword: "ProdReadyAdmin123!",
    serverTokenSecret: "prod-ready-server-secret"
  });

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "ProdReadyAdmin123!"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "launch.mainline.runtime.owner",
        password: "LaunchMainlineRuntimeOwner123!",
        displayName: "Launch Mainline Runtime Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "MAINLINE_RUNTIME",
        name: "Mainline Runtime App",
        ownerDeveloperId: owner.id,
        featureConfig: {
          allowRegister: true,
          allowAccountLogin: true,
          allowCardLogin: true,
          allowCardRecharge: true
        }
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "launch.mainline.runtime.owner",
      password: "LaunchMainlineRuntimeOwner123!"
    });

    const launchMainline = await getJson(
      baseUrl,
      "/api/developer/launch-mainline?productCode=MAINLINE_RUNTIME&channel=stable&reviewMode=matched",
      ownerSession.token
    );

    assert.equal(launchMainline.mainlineSummary.productionGate?.status, "hold");
    assert.equal(launchMainline.mainlineSummary.productionGate?.recommendedWorkspace?.key, "ops");
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.productionGate?.actionPlan)
      && launchMainline.mainlineSummary.productionGate.actionPlan.some((item) =>
        item?.key === "production_public_entrypoint"
        && item?.workspaceAction?.key === "ops"
      )
    );
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.productionGate?.actionPlan)
      && launchMainline.mainlineSummary.productionGate.actionPlan.some((item) =>
        item?.key === "production_main_store_single_host"
        && item?.status === "review"
      )
    );
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.productionGate?.actionPlan)
      && launchMainline.mainlineSummary.productionGate.actionPlan.some((item) =>
        item?.key === "production_runtime_state_single_host"
        && item?.status === "review"
      )
    );
    assert.match(launchMainline.summaryText || "", /loopback/i);
    assert.match(launchMainline.summaryText || "", /sqlite/i);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer launch mainline production gate blocks loopback external data services", async () => {
  const { app, baseUrl, tempDir } = await startServer({
    adminPassword: "ProdExternalAdmin123!",
    serverTokenSecret: "prod-external-server-secret",
    mainStoreDriver: "postgres",
    postgresUrl: "postgresql://127.0.0.1:5432/rocksolid",
    stateStoreDriver: "redis",
    redisUrl: "redis://localhost:6379/0"
  });

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "ProdExternalAdmin123!"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "launch.mainline.external.owner",
        password: "LaunchMainlineExternalOwner123!",
        displayName: "Launch Mainline External Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "MAINLINE_EXTERNAL",
        name: "Mainline External App",
        ownerDeveloperId: owner.id,
        featureConfig: {
          allowRegister: true,
          allowAccountLogin: true,
          allowCardLogin: true,
          allowCardRecharge: true
        }
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "launch.mainline.external.owner",
      password: "LaunchMainlineExternalOwner123!"
    });

    const launchMainline = await getJson(
      baseUrl,
      "/api/developer/launch-mainline?productCode=MAINLINE_EXTERNAL&channel=stable&reviewMode=matched",
      ownerSession.token
    );

    assert.equal(launchMainline.mainlineSummary.productionGate?.status, "hold");
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.productionGate?.actionPlan)
      && launchMainline.mainlineSummary.productionGate.actionPlan.some((item) =>
        item?.key === "production_main_store_loopback"
        && item?.status === "block"
        && item?.workspaceAction?.key === "ops"
      )
    );
    assert.ok(
      Array.isArray(launchMainline.mainlineSummary.productionGate?.actionPlan)
      && launchMainline.mainlineSummary.productionGate.actionPlan.some((item) =>
        item?.key === "production_runtime_state_loopback"
        && item?.status === "block"
        && item?.workspaceAction?.key === "ops"
      )
    );
    assert.match(launchMainline.summaryText || "", /postgres/i);
    assert.match(launchMainline.summaryText || "", /redis/i);
    assert.match(launchMainline.summaryText || "", /127\.0\.0\.1|localhost/i);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer launch mainline action can record a recovery drill and refresh production evidence", async () => {
  const { app, baseUrl, tempDir } = await startServer({
    adminPassword: "RecoveryDrillAdmin123!",
    serverTokenSecret: "recovery-drill-server-secret"
  });

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "RecoveryDrillAdmin123!"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "launch.mainline.drill.owner",
        password: "LaunchMainlineDrillOwner123!",
        displayName: "Launch Mainline Drill Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "MAINLINE_DRILL",
        name: "Mainline Drill App",
        ownerDeveloperId: owner.id,
        featureConfig: {
          allowRegister: true,
          allowAccountLogin: true,
          allowCardLogin: true,
          allowCardRecharge: true
        }
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "launch.mainline.drill.owner",
      password: "LaunchMainlineDrillOwner123!"
    });

    const beforeMainline = await getJson(
      baseUrl,
      "/api/developer/launch-mainline?productCode=MAINLINE_DRILL&channel=stable&reviewMode=matched",
      ownerSession.token
    );

    assert.ok(
      Array.isArray(beforeMainline.mainlineSummary.productionGate?.checks)
      && beforeMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_recovery_drill_recent"
        && item?.status === "block"
      )
    );

    const actionResult = await postJson(
      baseUrl,
      "/api/developer/launch-mainline/action",
      {
        productCode: "MAINLINE_DRILL",
        channel: "stable",
        operation: "record_recovery_drill"
      },
      ownerSession.token
    );

    assert.equal(actionResult.operation, "record_recovery_drill");
    assert.match(actionResult.message || "", /recovery drill/i);
    assert.equal(actionResult.result?.productCode, "MAINLINE_DRILL");
    assert.equal(actionResult.result?.channel, "stable");
    assert.ok(actionResult.result?.recordedDrill?.createdAt);
    assert.equal(actionResult.followUp?.operation, "record_recovery_drill");
    assert.equal(actionResult.receipt?.operation, "record_recovery_drill");
    assert.match(actionResult.receipt?.summary || "", /recovery drill/i);
    assert.ok(Array.isArray(actionResult.receipt?.created));
    assert.ok(actionResult.receipt?.created?.some((item) => item.key === "recovery_drill"));
    assert.ok(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.productionGate?.checks)
      && actionResult.launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_recovery_drill_recent"
        && item?.status === "pass"
      )
    );
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer launch mainline action can record backup verification and operations walkthrough evidence", async () => {
  const { app, baseUrl, tempDir } = await startServer({
    adminPassword: "MainlineEvidenceAdmin123!",
    serverTokenSecret: "mainline-evidence-server-secret"
  });

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "MainlineEvidenceAdmin123!"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "launch.mainline.evidence.owner",
        password: "LaunchMainlineEvidenceOwner123!",
        displayName: "Launch Mainline Evidence Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "MAINLINE_EVIDENCE",
        name: "Mainline Evidence App",
        ownerDeveloperId: owner.id,
        featureConfig: {
          allowRegister: true,
          allowAccountLogin: true,
          allowCardLogin: true,
          allowCardRecharge: true
        }
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "launch.mainline.evidence.owner",
      password: "LaunchMainlineEvidenceOwner123!"
    });

    const backupResult = await postJson(
      baseUrl,
      "/api/developer/launch-mainline/action",
      {
        productCode: "MAINLINE_EVIDENCE",
        channel: "stable",
        operation: "record_backup_verification"
      },
      ownerSession.token
    );

    assert.equal(backupResult.operation, "record_backup_verification");
    assert.match(backupResult.message || "", /backup verification/i);
    assert.equal(backupResult.result?.productCode, "MAINLINE_EVIDENCE");
    assert.equal(backupResult.result?.channel, "stable");
    assert.equal(backupResult.result?.recordedEvidence?.key, "backup_verification");
    assert.ok(backupResult.result?.recordedEvidence?.createdAt);
    assert.equal(backupResult.receipt?.operation, "record_backup_verification");
    assert.ok(Array.isArray(backupResult.receipt?.created));
    assert.ok(backupResult.receipt.created.some((item) => item.key === "backup_verification"));
    assert.ok(
      Array.isArray(backupResult.launchMainline?.mainlineSummary?.productionGate?.checks)
      && backupResult.launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_backup_verification_recent"
        && item?.status === "pass"
      )
    );

    const operationsResult = await postJson(
      baseUrl,
      "/api/developer/launch-mainline/action",
      {
        productCode: "MAINLINE_EVIDENCE",
        channel: "stable",
        operation: "record_operations_walkthrough"
      },
      ownerSession.token
    );

    assert.equal(operationsResult.operation, "record_operations_walkthrough");
    assert.match(operationsResult.message || "", /operations walkthrough/i);
    assert.equal(operationsResult.result?.productCode, "MAINLINE_EVIDENCE");
    assert.equal(operationsResult.result?.channel, "stable");
    assert.equal(operationsResult.result?.recordedEvidence?.key, "operations_walkthrough");
    assert.ok(operationsResult.result?.recordedEvidence?.createdAt);
    assert.equal(operationsResult.receipt?.operation, "record_operations_walkthrough");
    assert.ok(Array.isArray(operationsResult.receipt?.created));
    assert.ok(operationsResult.receipt.created.some((item) => item.key === "operations_walkthrough"));
    assert.ok(
      Array.isArray(operationsResult.launchMainline?.mainlineSummary?.productionGate?.checks)
      && operationsResult.launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_operations_walkthrough_recent"
        && item?.status === "pass"
      )
    );
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer launch mainline action can record deploy, health, and rollback evidence", async () => {
  const { app, baseUrl, tempDir } = await startServer({
    adminPassword: "MainlineProdEvidenceAdmin123!",
    serverTokenSecret: "mainline-prod-evidence-server-secret"
  });

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "MainlineProdEvidenceAdmin123!"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "launch.mainline.prodev.owner",
        password: "LaunchMainlineProdEvidenceOwner123!",
        displayName: "Launch Mainline Production Evidence Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "MAINLINE_PROD_EVIDENCE",
        name: "Mainline Production Evidence App",
        ownerDeveloperId: owner.id,
        featureConfig: {
          allowRegister: true,
          allowAccountLogin: true,
          allowCardLogin: true,
          allowCardRecharge: true
        }
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "launch.mainline.prodev.owner",
      password: "LaunchMainlineProdEvidenceOwner123!"
    });

    const deployResult = await postJson(
      baseUrl,
      "/api/developer/launch-mainline/action",
      {
        productCode: "MAINLINE_PROD_EVIDENCE",
        channel: "stable",
        operation: "record_deploy_verification"
      },
      ownerSession.token
    );

    assert.equal(deployResult.operation, "record_deploy_verification");
    assert.match(deployResult.message || "", /deploy verification/i);
    assert.equal(deployResult.result?.recordedEvidence?.key, "deploy_verification");
    assert.ok(deployResult.result?.recordedEvidence?.createdAt);
    assert.ok(Array.isArray(deployResult.receipt?.created));
    assert.ok(deployResult.receipt.created.some((item) => item.key === "deploy_verification"));

    const healthResult = await postJson(
      baseUrl,
      "/api/developer/launch-mainline/action",
      {
        productCode: "MAINLINE_PROD_EVIDENCE",
        channel: "stable",
        operation: "record_health_verification"
      },
      ownerSession.token
    );

    assert.equal(healthResult.operation, "record_health_verification");
    assert.match(healthResult.message || "", /health verification/i);
    assert.equal(healthResult.result?.recordedEvidence?.key, "health_verification");
    assert.ok(healthResult.result?.recordedEvidence?.createdAt);
    assert.ok(Array.isArray(healthResult.receipt?.created));
    assert.ok(healthResult.receipt.created.some((item) => item.key === "health_verification"));

    const rollbackResult = await postJson(
      baseUrl,
      "/api/developer/launch-mainline/action",
      {
        productCode: "MAINLINE_PROD_EVIDENCE",
        channel: "stable",
        operation: "record_rollback_walkthrough"
      },
      ownerSession.token
    );

    assert.equal(rollbackResult.operation, "record_rollback_walkthrough");
    assert.match(rollbackResult.message || "", /rollback walkthrough/i);
    assert.equal(rollbackResult.result?.recordedEvidence?.key, "rollback_walkthrough");
    assert.ok(rollbackResult.result?.recordedEvidence?.createdAt);
    assert.ok(Array.isArray(rollbackResult.receipt?.created));
    assert.ok(rollbackResult.receipt.created.some((item) => item.key === "rollback_walkthrough"));
    assert.ok(
      Array.isArray(rollbackResult.launchMainline?.mainlineSummary?.productionGate?.checks)
      && rollbackResult.launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_deploy_verification_recent"
        && item?.status === "pass"
      )
    );
    assert.ok(
      Array.isArray(rollbackResult.launchMainline?.mainlineSummary?.productionGate?.checks)
      && rollbackResult.launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_health_verification_recent"
        && item?.status === "pass"
      )
    );
    assert.ok(
      Array.isArray(rollbackResult.launchMainline?.mainlineSummary?.productionGate?.checks)
      && rollbackResult.launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_rollback_walkthrough_recent"
        && item?.status === "pass"
      )
    );
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer launch mainline action can record a cutover walkthrough and refresh grouped production evidence", async () => {
  const { app, baseUrl, tempDir } = await startServer({
    adminPassword: "MainlineCutoverAdmin123!",
    serverTokenSecret: "mainline-cutover-server-secret"
  });

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "MainlineCutoverAdmin123!"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "launch.mainline.cutover.owner",
        password: "LaunchMainlineCutoverOwner123!",
        displayName: "Launch Mainline Cutover Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "MAINLINE_CUTOVER",
        name: "Mainline Cutover App",
        ownerDeveloperId: owner.id,
        featureConfig: {
          allowRegister: true,
          allowAccountLogin: true,
          allowCardLogin: true,
          allowCardRecharge: true
        }
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "launch.mainline.cutover.owner",
      password: "LaunchMainlineCutoverOwner123!"
    });

    const beforeMainline = await getJson(
      baseUrl,
      "/api/developer/launch-mainline?productCode=MAINLINE_CUTOVER&channel=stable&reviewMode=matched",
      ownerSession.token
    );

    assert.ok(
      Array.isArray(beforeMainline.mainlineSummary.productionGate?.checks)
      && beforeMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_cutover_walkthrough_recent"
        && item?.status === "block"
      )
    );

    const actionResult = await postJson(
      baseUrl,
      "/api/developer/launch-mainline/action",
      {
        productCode: "MAINLINE_CUTOVER",
        channel: "stable",
        operation: "record_cutover_walkthrough"
      },
      ownerSession.token
    );

    assert.equal(actionResult.operation, "record_cutover_walkthrough");
    assert.match(actionResult.message || "", /cutover walkthrough/i);
    assert.equal(actionResult.result?.recordedEvidence?.key, "cutover_walkthrough");
    assert.ok(actionResult.result?.recordedEvidence?.createdAt);
    assert.equal(actionResult.receipt?.operation, "record_cutover_walkthrough");
    assert.ok(Array.isArray(actionResult.receipt?.created));
    assert.ok(actionResult.receipt.created.some((item) => item.key === "cutover_walkthrough"));
    assert.ok(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.productionGate?.checks)
      && actionResult.launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_cutover_walkthrough_recent"
        && item?.status === "pass"
      )
    );
    assert.ok(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.productionGate?.checks)
      && actionResult.launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_deploy_verification_recent"
        && item?.status === "pass"
      )
    );
    assert.ok(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.productionGate?.checks)
      && actionResult.launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_health_verification_recent"
        && item?.status === "pass"
      )
    );
    assert.ok(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.productionGate?.checks)
      && actionResult.launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_rollback_walkthrough_recent"
        && item?.status === "pass"
      )
    );
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer launch mainline action can record a launch day readiness review and refresh grouped production evidence", async () => {
  const { app, baseUrl, tempDir } = await startServer({
    adminPassword: "MainlineLaunchDayAdmin123!",
    serverTokenSecret: "mainline-launch-day-server-secret"
  });

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "MainlineLaunchDayAdmin123!"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "launch.mainline.lday.owner",
        password: "LaunchMainlineLDayOwner123!",
        displayName: "Launch Mainline Launch Day Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "MAINLINE_LAUNCH_DAY",
        name: "Mainline Launch Day App",
        ownerDeveloperId: owner.id,
        featureConfig: {
          allowRegister: true,
          allowAccountLogin: true,
          allowCardLogin: true,
          allowCardRecharge: true
        }
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "launch.mainline.lday.owner",
      password: "LaunchMainlineLDayOwner123!"
    });

    const beforeMainline = await getJson(
      baseUrl,
      "/api/developer/launch-mainline?productCode=MAINLINE_LAUNCH_DAY&channel=stable&reviewMode=matched",
      ownerSession.token
    );

    assert.ok(
      Array.isArray(beforeMainline.mainlineSummary.productionGate?.checks)
      && beforeMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_launch_day_readiness_review_recent"
        && item?.status === "block"
      )
    );

    const actionResult = await postJson(
      baseUrl,
      "/api/developer/launch-mainline/action",
      {
        productCode: "MAINLINE_LAUNCH_DAY",
        channel: "stable",
        operation: "record_launch_day_readiness_review"
      },
      ownerSession.token
    );

    assert.equal(actionResult.operation, "record_launch_day_readiness_review");
    assert.match(actionResult.message || "", /launch day readiness review/i);
    assert.equal(actionResult.result?.recordedEvidence?.key, "launch_day_readiness_review");
    assert.ok(actionResult.result?.recordedEvidence?.createdAt);
    assert.equal(actionResult.receipt?.operation, "record_launch_day_readiness_review");
    assert.ok(Array.isArray(actionResult.receipt?.created));
    assert.ok(actionResult.receipt.created.some((item) => item.key === "launch_day_readiness_review"));
    assert.ok(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.productionGate?.checks)
      && actionResult.launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_launch_day_readiness_review_recent"
        && item?.status === "pass"
      )
    );
    assert.ok(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.productionGate?.checks)
      && actionResult.launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_backup_verification_recent"
        && item?.status === "pass"
      )
    );
    assert.ok(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.productionGate?.checks)
      && actionResult.launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_recovery_drill_recent"
        && item?.status === "pass"
      )
    );
    assert.ok(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.productionGate?.checks)
      && actionResult.launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_operations_walkthrough_recent"
        && item?.status === "pass"
      )
    );
    assert.ok(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.productionGate?.checks)
      && actionResult.launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_cutover_walkthrough_recent"
        && item?.status === "pass"
      )
    );
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer launch mainline action can record a first-wave ops sweep and refresh post-launch evidence", async () => {
  const { app, baseUrl, tempDir } = await startServer({
    adminPassword: "MainlineOpsSweepAdmin123!",
    serverTokenSecret: "mainline-ops-sweep-server-secret"
  });

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "MainlineOpsSweepAdmin123!"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "launch.mainline.opssweep.owner",
        password: "LaunchMainlineOpsSweepOwner123!",
        displayName: "Launch Mainline Ops Sweep Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "MAINLINE_OPS_SWEEP",
        name: "Mainline Ops Sweep App",
        ownerDeveloperId: owner.id,
        featureConfig: {
          allowRegister: true,
          allowAccountLogin: true,
          allowCardLogin: true,
          allowCardRecharge: true
        }
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "launch.mainline.opssweep.owner",
      password: "LaunchMainlineOpsSweepOwner123!"
    });

    const beforeMainline = await getJson(
      baseUrl,
      "/api/developer/launch-mainline?productCode=MAINLINE_OPS_SWEEP&channel=stable&reviewMode=matched",
      ownerSession.token
    );

    assert.ok(
      Array.isArray(beforeMainline.mainlineSummary.productionGate?.checks)
      && beforeMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_post_launch_ops_sweep_recent"
        && item?.status === "block"
      )
    );

    const actionResult = await postJson(
      baseUrl,
      "/api/developer/launch-mainline/action",
      {
        productCode: "MAINLINE_OPS_SWEEP",
        channel: "stable",
        operation: "record_post_launch_ops_sweep"
      },
      ownerSession.token
    );

    assert.equal(actionResult.operation, "record_post_launch_ops_sweep");
    assert.match(actionResult.message || "", /ops sweep/i);
    assert.equal(actionResult.result?.recordedEvidence?.key, "post_launch_ops_sweep");
    assert.ok(actionResult.result?.recordedEvidence?.createdAt);
    assert.equal(actionResult.receipt?.operation, "record_post_launch_ops_sweep");
    assert.ok(Array.isArray(actionResult.receipt?.created));
    assert.ok(actionResult.receipt.created.some((item) => item.key === "post_launch_ops_sweep"));
    assert.ok(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.productionGate?.checks)
      && actionResult.launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_post_launch_ops_sweep_recent"
        && item?.status === "pass"
      )
    );
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer launch mainline action can record a launch closeout review and refresh grouped closeout evidence", async () => {
  const { app, baseUrl, tempDir } = await startServer({
    adminPassword: "MainlineCloseoutAdmin123!",
    serverTokenSecret: "mainline-closeout-server-secret"
  });

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "MainlineCloseoutAdmin123!"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "launch.mainline.closeout.owner",
        password: "LaunchMainlineCloseoutOwner123!",
        displayName: "Launch Mainline Closeout Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "MAINLINE_CLOSEOUT",
        name: "Mainline Closeout App",
        ownerDeveloperId: owner.id,
        featureConfig: {
          allowRegister: true,
          allowAccountLogin: true,
          allowCardLogin: true,
          allowCardRecharge: true
        }
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "launch.mainline.closeout.owner",
      password: "LaunchMainlineCloseoutOwner123!"
    });

    const beforeMainline = await getJson(
      baseUrl,
      "/api/developer/launch-mainline?productCode=MAINLINE_CLOSEOUT&channel=stable&reviewMode=matched",
      ownerSession.token
    );

    assert.ok(
      Array.isArray(beforeMainline.mainlineSummary.productionGate?.checks)
      && beforeMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_launch_closeout_review_recent"
        && item?.status === "block"
      )
    );

    const actionResult = await postJson(
      baseUrl,
      "/api/developer/launch-mainline/action",
      {
        productCode: "MAINLINE_CLOSEOUT",
        channel: "stable",
        operation: "record_launch_closeout_review"
      },
      ownerSession.token
    );

    assert.equal(actionResult.operation, "record_launch_closeout_review");
    assert.match(actionResult.message || "", /launch closeout review/i);
    assert.equal(actionResult.result?.recordedEvidence?.key, "launch_closeout_review");
    assert.ok(actionResult.result?.recordedEvidence?.createdAt);
    assert.equal(actionResult.receipt?.operation, "record_launch_closeout_review");
    assert.ok(Array.isArray(actionResult.receipt?.created));
    assert.ok(actionResult.receipt.created.some((item) => item.key === "launch_closeout_review"));
    assert.ok(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.productionGate?.checks)
      && actionResult.launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_launch_closeout_review_recent"
        && item?.status === "pass"
      )
    );
    assert.ok(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.productionGate?.checks)
      && actionResult.launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_launch_day_readiness_review_recent"
        && item?.status === "pass"
      )
    );
    assert.ok(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.productionGate?.checks)
      && actionResult.launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_post_launch_ops_sweep_recent"
        && item?.status === "pass"
      )
    );
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer launch mainline action can record a launch stabilization review and refresh grouped stabilization evidence", async () => {
  const { app, baseUrl, tempDir } = await startServer({
    adminPassword: "MainlineStabilizationAdmin123!",
    serverTokenSecret: "mainline-stabilization-server-secret"
  });

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "MainlineStabilizationAdmin123!"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "launch.mainline.stab.owner",
        password: "LaunchMainlineStabilizationOwner123!",
        displayName: "Launch Mainline Stabilization Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "MAINLINE_STABILIZE",
        name: "Mainline Stabilization App",
        ownerDeveloperId: owner.id,
        featureConfig: {
          allowRegister: true,
          allowAccountLogin: true,
          allowCardLogin: true,
          allowCardRecharge: true
        }
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "launch.mainline.stab.owner",
      password: "LaunchMainlineStabilizationOwner123!"
    });

    const beforeMainline = await getJson(
      baseUrl,
      "/api/developer/launch-mainline?productCode=MAINLINE_STABILIZE&channel=stable&reviewMode=matched",
      ownerSession.token
    );

    assert.ok(
      Array.isArray(beforeMainline.mainlineSummary.productionGate?.checks)
      && beforeMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_launch_stabilization_review_recent"
        && item?.status === "block"
      )
    );

    const actionResult = await postJson(
      baseUrl,
      "/api/developer/launch-mainline/action",
      {
        productCode: "MAINLINE_STABILIZE",
        channel: "stable",
        operation: "record_launch_stabilization_review"
      },
      ownerSession.token
    );

    assert.equal(actionResult.operation, "record_launch_stabilization_review");
    assert.match(actionResult.message || "", /launch stabilization review/i);
    assert.equal(actionResult.result?.recordedEvidence?.key, "launch_stabilization_review");
    assert.ok(actionResult.result?.recordedEvidence?.createdAt);
    assert.equal(actionResult.receipt?.operation, "record_launch_stabilization_review");
    assert.ok(Array.isArray(actionResult.receipt?.created));
    assert.ok(actionResult.receipt.created.some((item) => item.key === "launch_stabilization_review"));
    assert.ok(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.productionGate?.checks)
      && actionResult.launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_launch_stabilization_review_recent"
        && item?.status === "pass"
      )
    );
    assert.ok(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.productionGate?.checks)
      && actionResult.launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_launch_closeout_review_recent"
        && item?.status === "pass"
      )
    );
    assert.ok(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.productionGate?.checks)
      && actionResult.launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_post_launch_ops_sweep_recent"
        && item?.status === "pass"
      )
    );
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer launch mainline action can record a launch rehearsal run and refresh production evidence", async () => {
  const { app, baseUrl, tempDir } = await startServer({
    adminPassword: "MainlineRehearsalAdmin123!",
    serverTokenSecret: "mainline-rehearsal-server-secret"
  });

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "MainlineRehearsalAdmin123!"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "launch.mainline.rehearsal.owner",
        password: "LaunchMainlineRehearsalOwner123!",
        displayName: "Launch Mainline Rehearsal Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "MAINLINE_REHEARSAL",
        name: "Mainline Rehearsal App",
        ownerDeveloperId: owner.id,
        featureConfig: {
          allowRegister: true,
          allowAccountLogin: true,
          allowCardLogin: true,
          allowCardRecharge: true
        }
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "launch.mainline.rehearsal.owner",
      password: "LaunchMainlineRehearsalOwner123!"
    });

    const beforeMainline = await getJson(
      baseUrl,
      "/api/developer/launch-mainline?productCode=MAINLINE_REHEARSAL&channel=stable&reviewMode=matched",
      ownerSession.token
    );

    assert.ok(
      Array.isArray(beforeMainline.mainlineSummary.productionGate?.checks)
      && beforeMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_launch_rehearsal_run_recent"
        && item?.status === "block"
        && item?.setupAction?.operation === "record_launch_rehearsal_run"
      )
    );

    const actionResult = await postJson(
      baseUrl,
      "/api/developer/launch-mainline/action",
      {
        productCode: "MAINLINE_REHEARSAL",
        channel: "stable",
        operation: "record_launch_rehearsal_run"
      },
      ownerSession.token
    );

    assert.equal(actionResult.operation, "record_launch_rehearsal_run");
    assert.match(actionResult.message || "", /launch rehearsal run/i);
    assert.equal(actionResult.result?.recordedEvidence?.key, "launch_rehearsal_run");
    assert.ok(actionResult.result?.recordedEvidence?.createdAt);
    assert.ok(actionResult.followUp);
    assert.match(actionResult.followUp.summary || "", /Launch rehearsal run evidence recorded/i);
    assert.equal(actionResult.followUp.productionGate?.status, "hold");
    assert.ok(Array.isArray(actionResult.followUp.remainingProductionChecks));
    assert.ok(actionResult.followUp.remainingProductionChecks.length >= 1);
    assert.ok(!actionResult.followUp.remainingProductionChecks.some((item) =>
      item?.key === "production_launch_rehearsal_run_recent"
    ));
    assert.ok(actionResult.followUp.remainingProductionChecks.some((item) =>
      item?.status === "block"
      && item?.setupAction?.operation
      && item.setupAction.operation !== "record_launch_rehearsal_run"
    ));
    assert.ok(actionResult.followUp.nextProductionAction?.key);
    assert.ok(actionResult.followUp.nextProductionAction?.setupAction?.operation);
    assert.notEqual(actionResult.followUp.nextProductionAction.setupAction.operation, "record_launch_rehearsal_run");
    assert.ok(actionResult.followUp.remainingProductionChecks.some((item) =>
      item?.key === actionResult.followUp.nextProductionAction.key
    ));
    assert.ok(actionResult.followUp.evidenceQueue);
    assert.ok(Number(actionResult.followUp.evidenceQueue.totalCount || 0) >= 8);
    assert.ok(Number(actionResult.followUp.evidenceQueue.completedCount || 0) >= 1);
    assert.equal(
      actionResult.followUp.evidenceQueue.remainingCount,
      actionResult.followUp.remainingProductionChecks.length
    );
    assert.equal(
      actionResult.followUp.evidenceQueue.nextAction?.key,
      actionResult.followUp.nextProductionAction.key
    );
    assert.ok(actionResult.followUp.evidenceQueue.completedChecks.some((item) =>
      item?.key === "production_launch_rehearsal_run_recent"
      && item?.setupAction?.operation === "record_launch_rehearsal_run"
    ));
    assert.ok(Array.isArray(actionResult.receipt?.mainlineFollowUpCards));
    assert.ok(actionResult.receipt.mainlineFollowUpCards.some((item) =>
      item?.key === actionResult.followUp.nextProductionAction.key
      && Array.isArray(item.controls)
      && item.controls.some((control) =>
        control?.setupAction?.operation
        && control.setupAction.operation !== "record_launch_rehearsal_run"
      )
    ));
    assert.ok(actionResult.receipt?.mainlineEvidenceQueue);
    assert.equal(
      actionResult.receipt.mainlineEvidenceQueue.nextAction?.key,
      actionResult.followUp.evidenceQueue.nextAction?.key
    );
    assert.equal(
      actionResult.receipt.mainlineEvidenceQueue.remainingCount,
      actionResult.followUp.evidenceQueue.remainingCount
    );
    assert.ok(actionResult.receipt.mainlineRecapCards.some((item) =>
      item?.key === "mainline_status"
      && Array.isArray(item.details)
      && item.details.some((detail) => /Evidence queue:/i.test(String(detail || "")))
    ));
    assert.ok(Array.isArray(actionResult.followUp.actions));
    assert.ok(actionResult.followUp.actions.some((item) =>
      item?.recommendedDownload?.key === "launch_mainline_rehearsal_guide"
    ));
    assert.ok(actionResult.followUp.actions.some((item) =>
      item?.workspaceAction?.key || item?.setupAction?.operation
    ));
    assert.equal(actionResult.receipt?.operation, "record_launch_rehearsal_run");
    assert.ok(Array.isArray(actionResult.receipt?.created));
    assert.ok(actionResult.receipt.created.some((item) => item.key === "launch_rehearsal_run"));
    assert.ok(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.productionGate?.checks)
      && actionResult.launchMainline.mainlineSummary.productionGate.checks.some((item) =>
        item?.key === "production_launch_rehearsal_run_recent"
        && item?.status === "pass"
      )
    );
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("launch workflow routes login-path blockers to project authorization presets", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "launch.authpreset.owner",
        password: "LaunchAuthPresetOwner123!",
        displayName: "Launch Auth Preset Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "AUTHPRESET_ALPHA",
        name: "Auth Preset Alpha",
        ownerDeveloperId: owner.id,
        featureConfig: {
          allowRegister: false,
          allowAccountLogin: false,
          allowCardLogin: false,
          allowCardRecharge: false
        }
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "launch.authpreset.owner",
      password: "LaunchAuthPresetOwner123!"
    });

    const launchWorkflow = await getJson(
      baseUrl,
      "/api/developer/launch-workflow?productCode=AUTHPRESET_ALPHA&channel=stable",
      ownerSession.token
    );

    assert.equal(launchWorkflow.workflowSummary.authorizationStatus, "block");
    assert.match(launchWorkflow.workflowSummary.authorizationSummary || "", /modes=no-login-path/);

    const authChecklistItem = launchWorkflow.workflowChecklist.items.find((item) => item.key === "authorization_readiness");
    assert.ok(authChecklistItem);
    assert.equal(authChecklistItem.workspaceAction?.key, "project");
    assert.equal(authChecklistItem.workspaceAction?.autofocus, "auth-preset");

    const authActionPlanItem = launchWorkflow.workflowSummary.actionPlan.find((item) => item.key === "authorization_readiness");
    assert.ok(authActionPlanItem);
    assert.equal(authActionPlanItem.workspaceAction?.key, "project");
    assert.equal(authActionPlanItem.workspaceAction?.autofocus, "auth-preset");
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("launch workflow routes starter-account blockers into developer licenses and clears after seeding", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "launch.seed.owner",
        password: "LaunchSeedOwner123!",
        displayName: "Launch Seed Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "SEEDACC_ALPHA",
        name: "Seed Account Alpha",
        ownerDeveloperId: owner.id,
        featureConfig: {
          allowRegister: false,
          allowAccountLogin: true,
          allowCardLogin: false,
          allowCardRecharge: false
        }
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "launch.seed.owner",
      password: "LaunchSeedOwner123!"
    });

    await postJson(
      baseUrl,
      "/api/developer/policies",
      {
        productCode: "SEEDACC_ALPHA",
        name: "Starter Duration",
        durationDays: 30,
        totalPoints: null,
        maxDevices: 1
      },
      ownerSession.token
    );

    const beforeLaunch = await getJson(
      baseUrl,
      "/api/developer/launch-workflow?productCode=SEEDACC_ALPHA&channel=stable",
      ownerSession.token
    );

    assert.equal(beforeLaunch.workflowSummary.authorizationStatus, "block");
    assert.match(beforeLaunch.workflowSummary.authorizationMessage || "", /no starter accounts exist/i);

    const beforeChecklistItem = beforeLaunch.workflowChecklist.items.find((item) => item.key === "authorization_readiness");
    assert.ok(beforeChecklistItem);
    assert.equal(beforeChecklistItem.workspaceAction?.key, "licenses");
    assert.equal(beforeChecklistItem.workspaceAction?.autofocus, "quickstart");
    assert.equal(beforeChecklistItem.bootstrapAction?.key, "launch_bootstrap");

    const beforeActionPlanItem = beforeLaunch.workflowSummary.actionPlan.find((item) => item.key === "authorization_readiness");
    assert.ok(beforeActionPlanItem);
    assert.equal(beforeActionPlanItem.workspaceAction?.key, "licenses");
    assert.equal(beforeActionPlanItem.workspaceAction?.autofocus, "quickstart");
    assert.equal(beforeActionPlanItem.bootstrapAction?.key, "launch_bootstrap");

    const seededAccount = await postJson(
      baseUrl,
      "/api/developer/accounts",
      {
        productCode: "SEEDACC_ALPHA",
        username: "seedacc_alpha_01",
        password: "SeedStarter123!"
      },
      ownerSession.token
    );

    assert.equal(seededAccount.productCode, "SEEDACC_ALPHA");
    assert.equal(seededAccount.username, "seedacc_alpha_01");
    assert.equal(seededAccount.created, true);

    const accounts = await getJson(
      baseUrl,
      "/api/developer/accounts?productCode=SEEDACC_ALPHA",
      ownerSession.token
    );
    assert.ok(accounts.items.some((item) => item.username === "seedacc_alpha_01"));

    const afterLaunch = await getJson(
      baseUrl,
      "/api/developer/launch-workflow?productCode=SEEDACC_ALPHA&channel=stable",
      ownerSession.token
    );

    assert.notEqual(afterLaunch.workflowSummary.authorizationStatus, "block");
    assert.doesNotMatch(afterLaunch.workflowSummary.authorizationMessage || "", /no starter accounts exist/i);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer license quickstart bootstrap can create starter launch assets in one pass", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "launch.bootstrap.owner",
        password: "LaunchBootstrapOwner123!",
        displayName: "Launch Bootstrap Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "BOOT_ALPHA",
        name: "Bootstrap Alpha",
        ownerDeveloperId: owner.id,
        featureConfig: {
          allowRegister: false,
          allowAccountLogin: true,
          allowCardLogin: false,
          allowCardRecharge: true
        }
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "launch.bootstrap.owner",
      password: "LaunchBootstrapOwner123!"
    });

    const bootstrap = await postJson(
      baseUrl,
      "/api/developer/license-quickstart/bootstrap",
      { productCode: "BOOT_ALPHA" },
      ownerSession.token
    );

    assert.equal(bootstrap.productCode, "BOOT_ALPHA");
    assert.ok(bootstrap.created.policy);
    assert.ok(bootstrap.created.cardBatch);
    assert.ok(bootstrap.created.account);
    assert.match(bootstrap.created.policy.name, /Launch/i);
    assert.equal(bootstrap.created.cardBatch.count, 50);
    assert.match(bootstrap.created.account.username, /^boot_alpha_seed_/);
    assert.match(bootstrap.created.account.temporaryPassword || "", /@/);
    assert.equal(bootstrap.before.authorization.status, "block");
    assert.notEqual(bootstrap.after.authorization.status, "block");
    assert.equal(bootstrap.followUp.operation, "bootstrap");
    assert.equal(bootstrap.followUp.primaryAction?.key, "launch_recheck");
    assert.ok(Array.isArray(bootstrap.followUp.actions));
      assert.ok(bootstrap.followUp.actions.some((item) => item.key === "launch_recheck"));
      assert.ok(bootstrap.followUp.actions.some((item) => item.key === "launch_smoke_kit"));
      assert.ok(bootstrap.followUp.actions.some((item) => item.key === "inventory_recheck"));
      assert.ok(bootstrap.followUp.actions.some((item) => item.key === "starter_account_handoff"));
      assert.ok(bootstrap.followUp.actions.some((item) => item.key === "runtime_smoke"));
      assert.ok(bootstrap.followUp.actions.some((item) => item.key === "card_redemption_watch"));
      assert.ok(bootstrap.followUp.recommendedDownloads.some((item) => item.key === "launch_mainline_summary"));
      assert.ok(bootstrap.followUp.recommendedDownloads.some((item) => item.key === "launch_mainline_rehearsal_guide"));
      assert.ok(bootstrap.followUp.recommendedDownloads.some((item) => item.key === "launch_mainline_zip"));
      assert.ok(bootstrap.followUp.recommendedDownloads.some((item) => item.key === "launch_mainline_checksums"));
      assert.ok(bootstrap.followUp.recommendedDownloads.some((item) => item.key === "launch_smoke_kit_summary"));
      assert.ok(bootstrap.followUp.recommendedDownloads.some((item) => item.key === "launch_checklist"));
      assert.ok(bootstrap.followUp.recommendedDownloads.some((item) => item.key === "ops_runtime_smoke_summary"));
      assert.equal(
        bootstrap.followUp.actions.find((item) => item.key === "launch_recheck")?.workspaceAction?.key,
        "launch-mainline"
      );
      assert.equal(
        bootstrap.followUp.actions.find((item) => item.key === "launch_recheck")?.recommendedDownload?.source,
        "developer-launch-mainline"
      );
      assert.equal(
        bootstrap.followUp.actions.find((item) => item.key === "launch_recheck")?.recommendedDownload?.key,
        "launch_mainline_rehearsal_guide"
      );
      assert.match(bootstrap.followUp.summary, /Next:/);

    const policies = await getJson(
      baseUrl,
      "/api/developer/policies?productCode=BOOT_ALPHA",
      ownerSession.token
    );
    assert.ok(policies.some((item) => item.id === bootstrap.created.policy.id));

    const cards = await getJson(
      baseUrl,
      "/api/developer/cards?productCode=BOOT_ALPHA",
      ownerSession.token
    );
    assert.ok(cards.items.some((item) => item.batchCode === bootstrap.created.cardBatch.batchCode));

    const accounts = await getJson(
      baseUrl,
      "/api/developer/accounts?productCode=BOOT_ALPHA",
      ownerSession.token
    );
    assert.ok(accounts.items.some((item) => item.username === bootstrap.created.account.username));

    const launchWorkflow = await getJson(
      baseUrl,
      "/api/developer/launch-workflow?productCode=BOOT_ALPHA&channel=stable",
      ownerSession.token
    );
    assert.notEqual(launchWorkflow.workflowSummary.authorizationStatus, "block");
    assert.doesNotMatch(launchWorkflow.workflowSummary.authorizationMessage || "", /no starter accounts exist/i);
    assert.doesNotMatch(launchWorkflow.workflowSummary.authorizationMessage || "", /no fresh cards/i);
    assert.doesNotMatch(launchWorkflow.workflowSummary.authorizationMessage || "", /no entitlement policies/i);

    const smokeKit = await getJson(
      baseUrl,
      "/api/developer/launch-smoke-kit?productCode=BOOT_ALPHA&channel=stable",
      ownerSession.token
    );
    assert.equal(smokeKit.manifest?.project?.code, "BOOT_ALPHA");
    assert.equal(smokeKit.smokeSummary?.startupRequest?.productCode, "BOOT_ALPHA");
    assert.equal(smokeKit.smokeSummary?.recommendedWorkspace?.key, "launch-smoke");
    assert.ok(Array.isArray(smokeKit.smokeSummary?.accountCandidates));
    assert.ok(smokeKit.smokeSummary.accountCandidates.length >= 1);
    assert.ok(Array.isArray(smokeKit.smokeSummary?.rechargeCardCandidates));
    assert.ok(smokeKit.smokeSummary.rechargeCardCandidates.length >= 1);
    assert.equal(smokeKit.smokeSummary?.directCardCandidates?.length || 0, 0);
    assert.ok(smokeKit.smokeSummary?.verificationPaths?.some((item) => item.key === "startup_bootstrap"));
    assert.ok(smokeKit.smokeSummary?.verificationPaths?.some((item) => item.key === "account_login"));
    assert.ok(smokeKit.smokeSummary?.verificationPaths?.some((item) => item.key === "recharge_flow"));
    assert.ok(smokeKit.smokeSummary?.workspaceActions?.some((item) => item.key === "launch-review"));
    assert.ok(smokeKit.smokeSummary?.workspaceActions?.some((item) => item.key === "ops"));
    assert.ok(smokeKit.smokeSummary?.actionPlan?.some((item) => item.workspaceAction?.key === "launch-smoke"));
    assert.ok(smokeKit.smokeSummary?.actionPlan?.some((item) =>
      /^Open (Account|Entitlement|Session|Device) Control in Ops$/.test(item.workspaceAction?.label || "")
      && /^developer-ops-primary-(account|entitlement|session|device)-summary\.txt$/.test(item.recommendedDownload?.fileName || "")
    ));
    assert.ok(smokeKit.smokeSummary?.actionPlan?.some((item) =>
      item.key === "launch_smoke_primary_review"
      && /^Prepare (account re-enable|account control|entitlement resume|entitlement control|7-day extension|point top-up|session review|session control|device unblock review|device control)$/i.test(item.title || "")
    ));
    assert.ok(smokeKit.smokeSummary?.actionPlan?.some((item) =>
      /^launch_smoke_(accounts|entitlements)_review$/.test(item.key || "")
      && /^Prepare (account re-enable|account control|entitlement resume|entitlement control|7-day extension|point top-up|session review|session control|device unblock review|device control)$/i.test(item.title || "")
    ));
    assert.ok(smokeKit.smokeSummary?.actionPlan?.some((item) =>
      item.key === "launch_smoke_remaining_queue"
      && item.recommendedDownload?.fileName === "developer-ops-remaining-summary.txt"
    ));
    assert.ok(smokeKit.smokeSummary?.actionPlan?.some((item) =>
      item.key === "launch_smoke_route_continuation"
      && item.workspaceAction?.key === "ops"
      && /^(review_next|complete_route_review)$/.test(item.workspaceAction?.params?.routeAction || "")
      && /^(route-review-next|summary)$/.test(item.recommendedDownload?.format || "")
    ));
    assert.ok(Array.isArray(smokeKit.smokeSummary?.reviewTargets));
    assert.ok(smokeKit.smokeSummary?.primaryReviewTarget);
    assert.equal(smokeKit.smokeSummary?.primaryReviewTarget?.workspaceAction?.key, "ops");
    assert.match(
      smokeKit.smokeSummary?.primaryReviewTarget?.workspaceAction?.label || "",
      /^Open (Account|Entitlement|Session|Device) Control in Ops$/
    );
    assert.match(
      smokeKit.smokeSummary?.primaryReviewTarget?.workspaceAction?.params?.routeAction || "",
      /^control-(account|entitlement|session|device)$/
    );
    assert.match(
      smokeKit.smokeSummary?.primaryReviewTarget?.routeActionLabel || "",
      /^Open (Account|Entitlement|Session|Device) Control$/
    );
    assert.match(
      smokeKit.smokeSummary?.primaryReviewTarget?.recommendedDownload?.fileName || "",
      /^developer-ops-primary-(account|entitlement|session|device)-summary\.txt$/
    );
    assert.match(
      smokeKit.smokeSummary?.primaryReviewTarget?.recommendedDownload?.label || "",
      /^Primary (account|entitlement|session|device) summary$/i
    );
    assert.ok(smokeKit.smokeSummary?.recommendedDownloads?.some((item) => /^developer-ops-primary-(account|entitlement|session|device)-summary\.txt$/.test(item.fileName || "")));
    assert.ok(smokeKit.smokeSummary?.mainlineGate);
    assert.ok(["hold", "attention", "ready"].includes(smokeKit.smokeSummary.mainlineGate.status));
    assert.ok(smokeKit.smokeSummary.mainlineGate.recommendedWorkspace?.key);
    assert.ok(smokeKit.smokeSummary.mainlineGate.primaryAction?.key);
    assert.ok(smokeKit.smokeSummary.mainlineGate.recommendedDownload?.key);
    assert.ok(smokeKit.smokeSummary?.workspaceActions?.some((item) => /^Open (Account|Entitlement|Session|Device) Control in Ops$/.test(item.label || "")));
    assert.ok(smokeKit.smokeSummary?.reviewTargets?.some((item) => item.workspaceAction?.key === "ops" || item.workspaceAction?.key === "licenses"));
    assert.ok(smokeKit.smokeSummary?.reviewTargets?.some((item) => {
      const params = item.workspaceAction?.params || {};
      return params.focusKind && /^control-(account|entitlement|session|device)$/.test(params.routeAction || "");
    }));
    assert.ok(smokeKit.smokeSummary?.reviewTargets?.some((item) => {
      const params = item.workspaceAction?.params || {};
      return params.focusKind && /^control-(account|entitlement|session|device)$/.test(params.routeAction || "")
        && /^Open (Account|Entitlement|Session|Device) Control in Ops$/.test(item.workspaceAction?.label || "")
        && /^Open (Account|Entitlement|Session|Device) Control$/.test(item.routeActionLabel || "");
    }));
    assert.ok(smokeKit.smokeSummary?.recommendedDownloads?.some((item) => item.source === "developer-launch-smoke-kit"));
    assert.ok(smokeKit.smokeSummary?.recommendedDownloads?.some((item) => item.fileName === "developer-ops-remaining-summary.txt"));
    assert.ok(smokeKit.smokeSummary?.recommendedDownloads?.some((item) => item.key === "launch_mainline_summary" && item.source === "developer-launch-mainline"));
    assert.ok(smokeKit.smokeSummary?.recommendedDownloads?.some((item) => item.key === "launch_mainline_rehearsal_guide" && item.source === "developer-launch-mainline"));
    assert.ok(
      smokeKit.smokeSummary.recommendedDownloads.findIndex((item) => item.key === "launch_mainline_rehearsal_guide")
      < smokeKit.smokeSummary.recommendedDownloads.findIndex((item) => item.key === "launch_mainline_summary")
    );
    assert.ok(smokeKit.smokeSummary?.recommendedDownloads?.some((item) => item.key === "launch_mainline_zip" && item.source === "developer-launch-mainline"));
    assert.ok(smokeKit.smokeSummary?.recommendedDownloads?.some((item) => item.key === "launch_mainline_checksums" && item.source === "developer-launch-mainline"));
    assert.ok(smokeKit.smokeSummary?.actionPlan?.some((item) => item.key === "launch_mainline_overview" && item.recommendedDownload?.key === "launch_mainline_rehearsal_guide"));
    assert.match(smokeKit.summaryText || "", /Launch Smoke Paths:/);
    assert.match(smokeKit.summaryText || "", /Launch Mainline Gate:/);
    assert.match(smokeKit.summaryText || "", /Launch Smoke Primary Review Target:/);
    assert.match(smokeKit.summaryText || "", /action=Open (Account|Entitlement|Session|Device) Control/);
    assert.match(smokeKit.summaryText || "", /Launch Smoke Review Targets:/);

    const smokeKitSummaryDownload = await getText(
      baseUrl,
      "/api/developer/launch-smoke-kit/download?productCode=BOOT_ALPHA&channel=stable&format=summary",
      ownerSession.token
    );
    assert.equal(smokeKitSummaryDownload.status, 200);
    assert.match(smokeKitSummaryDownload.contentDisposition || "", /attachment; filename="rocksolid-developer-launch-smoke-kit-BOOT_ALPHA-stable-.*-summary\.txt"/);
    assert.match(smokeKitSummaryDownload.body, /Launch Smoke Paths:/);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer license quickstart bootstrap can seed an internal starter entitlement for account-only launch lanes", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "launch.entitlement.owner",
        password: "LaunchEntitlementOwner123!",
        displayName: "Launch Entitlement Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "BOOT_ACCOUNT_ONLY",
        name: "Bootstrap Account Only",
        ownerDeveloperId: owner.id,
        featureConfig: {
          allowRegister: false,
          allowAccountLogin: true,
          allowCardLogin: false,
          allowCardRecharge: false
        }
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "launch.entitlement.owner",
      password: "LaunchEntitlementOwner123!"
    });

    const bootstrap = await postJson(
      baseUrl,
      "/api/developer/license-quickstart/bootstrap",
      { productCode: "BOOT_ACCOUNT_ONLY" },
      ownerSession.token
    );

    assert.equal(bootstrap.productCode, "BOOT_ACCOUNT_ONLY");
    assert.ok(bootstrap.created.policy);
    assert.ok(bootstrap.created.account);
    assert.ok(bootstrap.created.entitlement);
    assert.equal(bootstrap.created.cardBatch, undefined);
    assert.equal(bootstrap.before.counts.activeEntitlements, 0);
    assert.equal(bootstrap.after.counts.activeEntitlements, 1);
    assert.equal(bootstrap.created.entitlement.username, bootstrap.created.account.username);
    assert.ok(bootstrap.created.entitlement.seedBatchCode);
      assert.equal(bootstrap.followUp.operation, "bootstrap");
      assert.equal(bootstrap.followUp.primaryAction?.key, "launch_recheck");
      assert.ok(bootstrap.followUp.actions.some((item) => item.key === "launch_recheck"));
      assert.ok(bootstrap.followUp.actions.some((item) => item.key === "launch_smoke_kit"));
      assert.ok(!bootstrap.followUp.actions.some((item) => item.key === "inventory_recheck"));
      assert.ok(bootstrap.followUp.recommendedDownloads.some((item) => item.key === "launch_mainline_summary"));
      assert.ok(bootstrap.followUp.recommendedDownloads.some((item) => item.key === "launch_mainline_rehearsal_guide"));
      assert.ok(bootstrap.followUp.recommendedDownloads.some((item) => item.key === "launch_smoke_kit_summary"));
      assert.ok(!bootstrap.followUp.actions.some((item) => item.key === "card_redemption_watch"));
      assert.ok(bootstrap.followUp.actions.some((item) => item.key === "runtime_smoke"));
      assert.equal(
        bootstrap.followUp.actions.find((item) => item.key === "launch_recheck")?.workspaceAction?.key,
        "launch-review"
      );
      assert.equal(
        bootstrap.followUp.actions.find((item) => item.key === "launch_recheck")?.recommendedDownload?.source,
        "developer-launch-mainline"
      );
      assert.equal(
        bootstrap.followUp.actions.find((item) => item.key === "launch_recheck")?.recommendedDownload?.key,
        "launch_mainline_rehearsal_guide"
      );

    const entitlements = await getJson(
      baseUrl,
      "/api/developer/entitlements?productCode=BOOT_ACCOUNT_ONLY",
      ownerSession.token
    );
    assert.ok(entitlements.items.some((item) =>
      item.id === bootstrap.created.entitlement.id
        && item.username === bootstrap.created.account.username
        && item.lifecycleStatus === "active"
    ));

    const launchWorkflow = await getJson(
      baseUrl,
      "/api/developer/launch-workflow?productCode=BOOT_ACCOUNT_ONLY&channel=stable",
      ownerSession.token
    );
    assert.notEqual(launchWorkflow.workflowSummary.authorizationStatus, "block");
    assert.ok(Array.isArray(launchWorkflow.workflowSummary.authorizationLaunchRecommendations?.inventoryRecommendations));
    assert.ok(
      !launchWorkflow.workflowSummary.authorizationLaunchRecommendations.inventoryRecommendations.some(
        (item) => item.key === "starter_entitlements" && item.status === "recommended"
      )
    );
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer license quickstart first-batch setup can create recommended launch card batches", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "launch.batch.owner",
        password: "LaunchBatchOwner123!",
        displayName: "Launch Batch Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "FIRSTBATCH",
        name: "First Batch App",
        ownerDeveloperId: owner.id,
        featureConfig: {
          allowRegister: false,
          allowAccountLogin: true,
          allowCardLogin: true,
          allowCardRecharge: true
        }
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "launch.batch.owner",
      password: "LaunchBatchOwner123!"
    });

    await postJson(
      baseUrl,
      "/api/developer/policies",
      {
        productCode: "FIRSTBATCH",
        name: "Starter Duration",
        durationDays: 30,
        totalPoints: null,
        maxDevices: 1
      },
      ownerSession.token
    );

    const launchWorkflowBeforeSetup = await getJson(
      baseUrl,
      "/api/developer/launch-workflow?productCode=FIRSTBATCH&channel=stable",
      ownerSession.token
    );
    assert.equal(launchWorkflowBeforeSetup.workflowSummary.launchFirstBatchSetupAction?.label, "Run First Batch Setup");
    assert.ok(launchWorkflowBeforeSetup.workflowSummary.authorizationLaunchRecommendations.firstBatchCardRecommendations.some((item) => item.setupAction?.key === "launch_first_batch_setup_direct_card"));
    assert.ok(launchWorkflowBeforeSetup.workflowSummary.authorizationLaunchRecommendations.firstBatchCardRecommendations.some((item) => item.setupAction?.key === "launch_first_batch_setup_recharge"));
    assert.ok(launchWorkflowBeforeSetup.workflowChecklist.items.some((item) => item.key === "authorization_readiness" && item.setupAction?.key === "launch_first_batch_setup"));
    assert.ok(launchWorkflowBeforeSetup.workflowSummary.actionPlan.some((item) => item.key === "authorization_readiness" && item.setupAction?.key === "launch_first_batch_setup"));
    assert.match(launchWorkflowBeforeSetup.summaryText, /Card Inventory Setup:/);
    assert.match(launchWorkflowBeforeSetup.summaryText, /setup=Run First Batch Setup@recommended:first_batch_setup/);

    const setup = await postJson(
      baseUrl,
      "/api/developer/license-quickstart/first-batches",
      {
        productCode: "FIRSTBATCH",
        mode: "recommended"
      },
      ownerSession.token
    );

    assert.equal(setup.productCode, "FIRSTBATCH");
    assert.equal(setup.requestedMode, "recommended");
    assert.equal(setup.before.counts.freshCards, 0);
    assert.equal(setup.after.counts.freshCards, 150);
    assert.equal(setup.createdBatches.length, 2);
    assert.ok(setup.createdBatches.some((item) => item.mode === "direct_card" && item.prefix === "FIRSTBATCHDL"));
    assert.ok(setup.createdBatches.some((item) => item.mode === "recharge" && item.prefix === "FIRSTBATCHRC"));
    assert.equal(setup.followUp.operation, "first_batch_setup");
      assert.equal(setup.followUp.primaryAction?.key, "inventory_recheck");
      assert.ok(setup.followUp.actions.some((item) => item.key === "inventory_recheck"));
      assert.ok(setup.followUp.actions.some((item) => item.key === "launch_recheck"));
      assert.ok(setup.followUp.actions.some((item) => item.key === "launch_smoke_kit"));
      assert.ok(setup.followUp.actions.some((item) => item.key === "runtime_smoke"));
      assert.ok(setup.followUp.recommendedDownloads.some((item) => item.key === "launch_mainline_summary"));
      assert.ok(setup.followUp.recommendedDownloads.some((item) => item.key === "launch_mainline_rehearsal_guide"));
      assert.ok(setup.followUp.recommendedDownloads.some((item) => item.key === "launch_mainline_zip"));
      assert.ok(setup.followUp.recommendedDownloads.some((item) => item.key === "launch_mainline_checksums"));
      assert.ok(setup.followUp.recommendedDownloads.some((item) => item.key === "launch_smoke_kit_summary"));
      assert.ok(setup.followUp.recommendedDownloads.some((item) => item.key === "launch_checklist"));
      assert.ok(setup.followUp.recommendedDownloads.some((item) => item.key === "ops_card_redemption_watch_summary"));
      assert.equal(
        setup.followUp.actions.find((item) => item.key === "launch_recheck")?.workspaceAction?.key,
        "launch-mainline"
      );
      assert.equal(
        setup.followUp.actions.find((item) => item.key === "launch_recheck")?.recommendedDownload?.source,
        "developer-launch-mainline"
      );
      assert.equal(
        setup.followUp.actions.find((item) => item.key === "launch_recheck")?.recommendedDownload?.key,
        "launch_mainline_rehearsal_guide"
      );

    const cards = await getJson(
      baseUrl,
      "/api/developer/cards?productCode=FIRSTBATCH",
      ownerSession.token
    );
    assert.equal(cards.items.filter((item) => ["fresh", "unused"].includes(String(item.usageStatus || item.displayStatus || "").toLowerCase())).length, 150);
    assert.ok(cards.items.some((item) => /^FIRSTBATCHDL/i.test(item.cardKey)));
    assert.ok(cards.items.some((item) => /^FIRSTBATCHRC/i.test(item.cardKey)));

    const repeatSetup = await postJsonExpectError(
      baseUrl,
      "/api/developer/license-quickstart/first-batches",
      {
        productCode: "FIRSTBATCH",
        mode: "recommended"
      },
      ownerSession.token
    );

    assert.equal(repeatSetup.status, 409);
    assert.equal(repeatSetup.error.code, "FIRST_BATCH_SETUP_NOT_NEEDED");

    const launchWorkflowAfterSetup = await getJson(
      baseUrl,
      "/api/developer/launch-workflow?productCode=FIRSTBATCH&channel=stable",
      ownerSession.token
    );
    assert.equal(launchWorkflowAfterSetup.workflowSummary.launchFirstBatchSetupAction, null);
    assert.ok(launchWorkflowAfterSetup.workflowSummary.actionPlan.every((item) => item.key !== "first_batch_setup"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer launch workflow can restock low launch inventory buffers", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "launch.restock.owner",
        password: "LaunchRestockOwner123!",
        displayName: "Launch Restock Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "RESTOCKAPP",
        name: "Restock App",
        ownerDeveloperId: owner.id,
        featureConfig: {
          allowRegister: false,
          allowAccountLogin: true,
          allowCardLogin: true,
          allowCardRecharge: true
        }
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "launch.restock.owner",
      password: "LaunchRestockOwner123!"
    });

    const policy = await postJson(
      baseUrl,
      "/api/developer/policies",
      {
        productCode: "RESTOCKAPP",
        name: "Restock Duration",
        durationDays: 30,
        totalPoints: null,
        maxDevices: 1
      },
      ownerSession.token
    );

    await postJson(
      baseUrl,
      "/api/developer/cards/batch",
      {
        productCode: "RESTOCKAPP",
        policyId: policy.id,
        count: 10,
        prefix: "RESTOCKAPPDL",
        notes: "Direct-card low stock seed"
      },
      ownerSession.token
    );

    await postJson(
      baseUrl,
      "/api/developer/cards/batch",
      {
        productCode: "RESTOCKAPP",
        policyId: policy.id,
        count: 20,
        prefix: "RESTOCKAPPRC",
        notes: "Recharge low stock seed"
      },
      ownerSession.token
    );

    const launchWorkflowBeforeRestock = await getJson(
      baseUrl,
      "/api/developer/launch-workflow?productCode=RESTOCKAPP&channel=stable",
      ownerSession.token
    );
    assert.equal(launchWorkflowBeforeRestock.workflowSummary.launchFirstBatchSetupAction?.label, "Run Inventory Refill");
    assert.equal(launchWorkflowBeforeRestock.workflowSummary.launchFirstBatchSetupAction?.operation, "restock");
    assert.ok(launchWorkflowBeforeRestock.workflowSummary.authorizationLaunchRecommendations.firstBatchCardRecommendations.some((item) => item.mode === "direct_card" && item.inventoryStatus === "low" && item.setupAction?.operation === "restock"));
    assert.ok(launchWorkflowBeforeRestock.workflowSummary.authorizationLaunchRecommendations.firstBatchCardRecommendations.some((item) => item.mode === "recharge" && item.inventoryStatus === "low" && item.setupAction?.operation === "restock"));
    assert.match(launchWorkflowBeforeRestock.summaryText, /Card Inventory Setup:/);
    assert.match(launchWorkflowBeforeRestock.summaryText, /Run Inventory Refill/);
    assert.match(launchWorkflowBeforeRestock.summaryText, /operation: restock/);
    assert.match(launchWorkflowBeforeRestock.checklistText, /setup: Run Inventory Refill \| mode=recommended \| operation=restock/);

    const restock = await postJson(
      baseUrl,
      "/api/developer/license-quickstart/restock",
      {
        productCode: "RESTOCKAPP",
        mode: "recommended"
      },
      ownerSession.token
    );

    assert.equal(restock.productCode, "RESTOCKAPP");
    assert.equal(restock.requestedMode, "recommended");
    assert.equal(restock.before.counts.freshCards, 30);
    assert.equal(restock.after.counts.freshCards, 150);
    assert.equal(restock.createdBatches.length, 2);
    assert.ok(restock.createdBatches.some((item) => item.mode === "direct_card" && item.refillCount === 40));
    assert.ok(restock.createdBatches.some((item) => item.mode === "recharge" && item.refillCount === 80));
    assert.equal(restock.followUp.operation, "restock");
      assert.equal(restock.followUp.primaryAction?.key, "inventory_recheck");
      assert.ok(restock.followUp.actions.some((item) => item.key === "inventory_recheck"));
      assert.ok(restock.followUp.actions.some((item) => item.key === "launch_recheck"));
      assert.ok(restock.followUp.actions.some((item) => item.key === "launch_smoke_kit"));
      assert.ok(restock.followUp.actions.some((item) => item.key === "session_review"));
      assert.ok(restock.followUp.recommendedDownloads.some((item) => item.key === "launch_mainline_summary"));
      assert.ok(restock.followUp.recommendedDownloads.some((item) => item.key === "launch_mainline_rehearsal_guide"));
      assert.ok(restock.followUp.recommendedDownloads.some((item) => item.key === "launch_mainline_zip"));
      assert.ok(restock.followUp.recommendedDownloads.some((item) => item.key === "launch_mainline_checksums"));
      assert.ok(restock.followUp.recommendedDownloads.some((item) => item.key === "launch_smoke_kit_summary"));
      assert.ok(restock.followUp.recommendedDownloads.some((item) => item.key === "launch_checklist"));
      assert.ok(restock.followUp.recommendedDownloads.some((item) => item.key === "ops_card_redemption_watch_summary"));
      assert.equal(
        restock.followUp.actions.find((item) => item.key === "launch_recheck")?.workspaceAction?.key,
        "launch-mainline"
      );
      assert.equal(
        restock.followUp.actions.find((item) => item.key === "launch_recheck")?.recommendedDownload?.source,
        "developer-launch-mainline"
      );
      assert.equal(
        restock.followUp.actions.find((item) => item.key === "launch_recheck")?.recommendedDownload?.key,
        "launch_mainline_rehearsal_guide"
      );

    const launchWorkflowAfterRestock = await getJson(
      baseUrl,
      "/api/developer/launch-workflow?productCode=RESTOCKAPP&channel=stable",
      ownerSession.token
    );
    assert.equal(launchWorkflowAfterRestock.workflowSummary.launchFirstBatchSetupAction, null);
    assert.ok(launchWorkflowAfterRestock.workflowSummary.authorizationLaunchRecommendations.firstBatchCardRecommendations.every((item) => item.inventoryStatus === "ready"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer launch mainline action can restock low inventory and return duty chain", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "launch.mainline.restock.owner",
        password: "LaunchMainlineRestockOwner123!",
        displayName: "Launch Mainline Restock Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "MAINLINE_RESTOCK",
        name: "Mainline Restock App",
        ownerDeveloperId: owner.id,
        featureConfig: {
          allowRegister: false,
          allowAccountLogin: true,
          allowCardLogin: true,
          allowCardRecharge: true
        }
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "launch.mainline.restock.owner",
      password: "LaunchMainlineRestockOwner123!"
    });

    const policy = await postJson(
      baseUrl,
      "/api/developer/policies",
      {
        productCode: "MAINLINE_RESTOCK",
        name: "Mainline Restock Duration",
        durationDays: 30,
        totalPoints: null,
        maxDevices: 1
      },
      ownerSession.token
    );

    await postJson(
      baseUrl,
      "/api/developer/cards/batch",
      {
        productCode: "MAINLINE_RESTOCK",
        policyId: policy.id,
        count: 10,
        prefix: "MAINLINEREDL",
        notes: "Direct-card low stock seed"
      },
      ownerSession.token
    );

    await postJson(
      baseUrl,
      "/api/developer/cards/batch",
      {
        productCode: "MAINLINE_RESTOCK",
        policyId: policy.id,
        count: 20,
        prefix: "MAINLINERERC",
        notes: "Recharge low stock seed"
      },
      ownerSession.token
    );

    const actionResult = await postJson(
      baseUrl,
      "/api/developer/launch-mainline/action",
      {
        productCode: "MAINLINE_RESTOCK",
        channel: "stable",
        operation: "restock",
        mode: "recommended"
      },
      ownerSession.token
    );

    assert.equal(actionResult.operation, "restock");
    assert.equal(actionResult.result?.productCode, "MAINLINE_RESTOCK");
    assert.equal(actionResult.result?.requestedMode, "recommended");
    assert.equal(actionResult.result?.createdBatches?.length, 2);
    assert.ok(actionResult.result.createdBatches.some((item) => item.mode === "direct_card" && item.refillCount === 40));
    assert.ok(actionResult.result.createdBatches.some((item) => item.mode === "recharge" && item.refillCount === 80));
    assert.ok(actionResult.result.inventoryStates.every((item) => item.status === "ready"));
    assert.deepEqual(
      actionResult.receipt?.firstLaunchDutySummary?.inventory
        ? {
            operation: actionResult.receipt.firstLaunchDutySummary.inventory.operation || null,
            createdBatchCount: actionResult.receipt.firstLaunchDutySummary.inventory.createdBatchCount ?? null,
            createdCardCount: actionResult.receipt.firstLaunchDutySummary.inventory.createdCardCount ?? null,
            refillCardCount: actionResult.receipt.firstLaunchDutySummary.inventory.refillCardCount ?? null,
            modes: actionResult.receipt.firstLaunchDutySummary.inventory.modes || []
          }
        : null,
      {
        operation: "restock",
        createdBatchCount: 2,
        createdCardCount: 120,
        refillCardCount: 120,
        modes: ["direct_card", "recharge"]
      }
    );
    assert.deepEqual(
      actionResult.receipt?.firstLaunchDutySummary?.inventory?.health || null,
      {
        status: "ready",
        readyStateCount: 2,
        lowStateCount: 0,
        missingStateCount: 0,
        readyModes: ["direct_card", "recharge"],
        lowModes: [],
        missingModes: []
      }
    );
    assert.deepEqual(
      actionResult.receipt?.firstLaunchDutySummary?.productionEvidence
        ? {
            status: actionResult.receipt.firstLaunchDutySummary.productionEvidence.status || null,
            totalCount: actionResult.receipt.firstLaunchDutySummary.productionEvidence.totalCount ?? null,
            completedCount: actionResult.receipt.firstLaunchDutySummary.productionEvidence.completedCount ?? null,
            remainingCount: actionResult.receipt.firstLaunchDutySummary.productionEvidence.remainingCount ?? null,
            nextActionKey: actionResult.receipt.firstLaunchDutySummary.productionEvidence.nextAction?.key || null,
            nextOperation: actionResult.receipt.firstLaunchDutySummary.productionEvidence.nextAction?.setupAction?.operation || null
          }
        : null,
      {
        status: Number(actionResult.receipt.mainlineEvidenceQueue?.remainingCount || 0) > 0 ? "review" : "ready",
        totalCount: actionResult.receipt.mainlineEvidenceQueue?.totalCount ?? null,
        completedCount: actionResult.receipt.mainlineEvidenceQueue?.completedCount ?? null,
        remainingCount: actionResult.receipt.mainlineEvidenceQueue?.remainingCount ?? null,
        nextActionKey: actionResult.receipt.mainlineEvidenceQueue?.nextAction?.key || null,
        nextOperation: actionResult.receipt.mainlineEvidenceQueue?.nextAction?.setupAction?.operation || null
      }
    );
    assert.ok(
      Array.isArray(actionResult.receipt?.firstLaunchDutySummary?.productionEvidence?.controls)
      && actionResult.receipt.firstLaunchDutySummary.productionEvidence.controls.some((control) =>
        control?.kind === "setup"
        && control?.setupAction?.operation === actionResult.receipt.mainlineEvidenceQueue?.nextAction?.setupAction?.operation
      )
      && actionResult.receipt.firstLaunchDutySummary.productionEvidence.controls.some((control) =>
        control?.kind === "workspace"
        && control?.workspaceAction?.key === actionResult.receipt.mainlineEvidenceQueue?.nextAction?.workspaceAction?.key
      )
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.firstLaunchDutySummary?.ops?.stageGroups)
        ? actionResult.receipt.firstLaunchDutySummary.ops.stageGroups.map((item) => ({
            key: item?.key || null,
            ownerRole: item?.ownerRole || null,
            actionKeys: Array.isArray(item?.actions) ? item.actions.map((action) => action?.key || null) : []
          }))
        : [],
      Array.isArray(actionResult.receipt?.firstLaunchOpsQueue?.stageGroups)
        ? actionResult.receipt.firstLaunchOpsQueue.stageGroups.map((item) => ({
            key: item?.key || null,
            ownerRole: item?.ownerRole || null,
            actionKeys: Array.isArray(item?.actions) ? item.actions.map((action) => action?.key || null) : []
          }))
        : []
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.firstLaunchDutySummary?.ops?.ownerPath)
        ? actionResult.receipt.firstLaunchDutySummary.ops.ownerPath.map((item) => ({
            key: item?.key || null,
            actionCount: item?.actionCount ?? null
          }))
        : [],
      [
        { key: "launch_ops", actionCount: 1 },
        { key: "release_manager", actionCount: 2 },
        { key: "support", actionCount: 2 },
        { key: "qa", actionCount: 1 },
        { key: "ops", actionCount: 2 }
      ]
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.firstLaunchDutySummary?.ops?.stagePath)
        ? actionResult.receipt.firstLaunchDutySummary.ops.stagePath.map((item) => ({
            key: item?.key || null,
            ownerRole: item?.ownerRole || null,
            actionCount: item?.actionCount ?? null
          }))
        : [],
      [
        { key: "inventory_handoff", ownerRole: "launch_ops", actionCount: 1 },
        { key: "launch_recheck", ownerRole: "release_manager", actionCount: 2 },
        { key: "first_sale_watch", ownerRole: "support", actionCount: 1 },
        { key: "runtime_validation", ownerRole: "qa", actionCount: 1 },
        { key: "runtime_ops_watch", ownerRole: "ops", actionCount: 2 },
        { key: "support_handoff", ownerRole: "support", actionCount: 1 }
      ]
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.firstLaunchDutySummary?.ops?.handoffs)
        ? actionResult.receipt.firstLaunchDutySummary.ops.handoffs.map((item) => ({
            key: item?.key || null,
            ownerRole: item?.ownerRole || null,
            stageKeys: Array.isArray(item?.stageKeys) ? item.stageKeys : [],
            actionKeys: Array.isArray(item?.actions) ? item.actions.map((action) => action?.key || null) : []
          }))
        : [],
      Array.isArray(actionResult.receipt?.firstLaunchOpsQueue?.handoffChecklist)
        ? actionResult.receipt.firstLaunchOpsQueue.handoffChecklist.map((item) => ({
            key: item?.key || null,
            ownerRole: item?.ownerRole || null,
            stageKeys: Array.isArray(item?.stageKeys) ? item.stageKeys : [],
            actionKeys: Array.isArray(item?.actions) ? item.actions.map((action) => action?.key || null) : []
          }))
        : []
    );
    assert.deepEqual(
      actionResult.receipt?.firstLaunchDutySummary?.ops?.primaryHandoff
        ? {
            key: actionResult.receipt.firstLaunchDutySummary.ops.primaryHandoff.key || null,
            ownerRole: actionResult.receipt.firstLaunchDutySummary.ops.primaryHandoff.ownerRole || null,
            stageKeys: Array.isArray(actionResult.receipt.firstLaunchDutySummary.ops.primaryHandoff.stageKeys)
              ? actionResult.receipt.firstLaunchDutySummary.ops.primaryHandoff.stageKeys
              : [],
            actionKeys: Array.isArray(actionResult.receipt.firstLaunchDutySummary.ops.primaryHandoff.actions)
              ? actionResult.receipt.firstLaunchDutySummary.ops.primaryHandoff.actions.map((action) => action?.key || null)
              : [],
            controlKeys: Array.isArray(actionResult.receipt.firstLaunchDutySummary.ops.primaryHandoff.controls)
              ? actionResult.receipt.firstLaunchDutySummary.ops.primaryHandoff.controls.map((control) =>
                  control?.workspaceAction?.key
                  || control?.recommendedDownload?.key
                  || control?.bootstrapAction?.key
                  || control?.setupAction?.key
                  || null
                ).filter(Boolean)
              : []
          }
        : null,
      {
        key: "launch_ops_handoff",
        ownerRole: "launch_ops",
        stageKeys: ["inventory_handoff"],
        actionKeys: ["inventory_recheck"],
        controlKeys: ["licenses", "launch_checklist"]
      }
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.firstLaunchDutySummary?.ops?.launchWindowFlow)
        ? actionResult.receipt.firstLaunchDutySummary.ops.launchWindowFlow.map((item) => ({
            key: item?.key || null,
            stage: item?.stage || null,
            ownerRole: item?.ownerRole || null,
            timing: item?.timing || null
          }))
        : [],
      Array.isArray(actionResult.receipt?.firstLaunchOpsQueue?.actions)
        ? actionResult.receipt.firstLaunchOpsQueue.actions.map((item) => ({
            key: item?.key || null,
            stage: item?.stage || null,
            ownerRole: item?.ownerRole || null,
            timing: item?.timing || null
          }))
        : []
    );
    assert.deepEqual(
      (() => {
        const supportHandoff = Array.isArray(actionResult.receipt?.firstLaunchDutySummary?.ops?.handoffs)
          ? actionResult.receipt.firstLaunchDutySummary.ops.handoffs.find((item) => item?.key === "support_handoff")
          : null;
        return supportHandoff
          ? (Array.isArray(supportHandoff.controls)
            ? supportHandoff.controls.map((control) =>
                control?.workspaceAction?.key
                || control?.recommendedDownload?.key
                || control?.bootstrapAction?.key
                || control?.setupAction?.key
                || null
              ).filter(Boolean)
            : [])
          : [];
      })(),
      ["ops", "ops_card_redemption_watch_summary", "licenses"]
    );
    assert.ok(
      Array.isArray(actionResult.receipt?.firstLaunchDutySummary?.details)
      && actionResult.receipt.firstLaunchDutySummary.details.some((detail) =>
        /Inventory health: READY \| ready=2 \| low=0 \| missing=0 \| readyModes=direct_card,recharge/i.test(String(detail || ""))
      )
      && actionResult.receipt.firstLaunchDutySummary.details.some((detail) =>
        /Production evidence: remaining=\d+ \| completed=\d+ \| next=.+ \| operation=record_/i.test(String(detail || ""))
      )
      && actionResult.receipt.firstLaunchDutySummary.details.some((detail) =>
        /Launch window flow:/i.test(String(detail || ""))
      )
      && actionResult.receipt.firstLaunchDutySummary.details.some((detail) =>
        /Owner path: Launch Ops -> Release Manager -> Support -> QA -> Ops/i.test(String(detail || ""))
      )
      && actionResult.receipt.firstLaunchDutySummary.details.some((detail) =>
        /Stage path: Inventory Handoff -> Launch Recheck -> First-Sale Watch -> Runtime Validation -> Runtime Ops Watch -> Support Handoff/i.test(String(detail || ""))
      )
    );
    assert.ok(
      Array.isArray(actionResult.receipt?.firstLaunchDutySummary?.controls)
      && actionResult.receipt.firstLaunchDutySummary.controls.some((control) =>
        control?.kind === "setup"
        && control?.setupAction?.operation === actionResult.receipt.mainlineEvidenceQueue?.nextAction?.setupAction?.operation
      )
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.firstLaunchDutySummary?.inventory?.refillPlan)
        ? actionResult.receipt.firstLaunchDutySummary.inventory.refillPlan.map((item) => ({
            mode: item?.mode || null,
            beforeFresh: item?.beforeFresh ?? null,
            refillCount: item?.refillCount ?? null,
            targetCount: item?.targetCount ?? null,
            batchCode: item?.batchCode || null
          }))
        : [],
      actionResult.result.createdBatches.map((item) => ({
        mode: item.mode,
        beforeFresh: item.beforeFresh,
        refillCount: item.refillCount,
        targetCount: item.targetCount,
        batchCode: item.batchCode
      }))
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.firstLaunchDutySummary?.dutyChain)
        ? actionResult.receipt.firstLaunchDutySummary.dutyChain.map((item) => ({
            key: item?.key || null,
            kind: item?.kind || null,
            ownerRole: item?.ownerRole || null
          }))
        : [],
      [
        { key: "restock", kind: "operation", ownerRole: "launch_ops" },
        ...actionResult.receipt.firstLaunchOpsQueue.actions.map((item) => ({
          key: item.key,
          kind: "action",
          ownerRole: item.ownerRole
        })),
        { key: "launch_mainline_first_launch_handoff", kind: "download", ownerRole: "launch_ops" },
        {
          key: actionResult.receipt.mainlineEvidenceQueue?.nextAction?.key || null,
          kind: "production_evidence",
          ownerRole: "ops"
        }
      ].filter((item) => item.key)
    );
    assert.ok(
      actionResult.receipt?.mainlineRecapCards?.some((item) =>
        item?.key === "first_launch_duty_summary"
        && Array.isArray(item.controls)
        && item.controls.some((control) => control?.recommendedDownload?.key === "launch_mainline_first_launch_handoff")
      )
    );

    const firstLaunchHandoffDownload = actionResult.receipt?.firstLaunchHandoffDownload || null;
    const firstLaunchHandoffDownloadResponse = await getText(
      baseUrl,
      firstLaunchHandoffDownload.href,
      ownerSession.token
    );
    assert.match(firstLaunchHandoffDownloadResponse.body, /Launch Duty Summary:/);
    assert.match(firstLaunchHandoffDownloadResponse.body, /Inventory Health: READY \| ready=2 \| low=0 \| missing=0 \| readyModes=direct_card,recharge/);
    assert.match(firstLaunchHandoffDownloadResponse.body, /Production Evidence: remaining=\d+ \| completed=\d+ \| next=.+ \| operation=record_/);
    assert.match(firstLaunchHandoffDownloadResponse.body, /Duty Chain:/);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer launch mainline action can bootstrap starter launch assets and return refreshed mainline", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "launch.mainline.bootstrap.owner",
        password: "LaunchMainlineBootstrapOwner123!",
        displayName: "Launch Mainline Bootstrap Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "MAINLINE_BOOT",
        name: "Mainline Bootstrap App",
        ownerDeveloperId: owner.id,
        featureConfig: {
          allowRegister: false,
          allowAccountLogin: true,
          allowCardLogin: false,
          allowCardRecharge: true
        }
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "launch.mainline.bootstrap.owner",
      password: "LaunchMainlineBootstrapOwner123!"
    });

    const actionResult = await postJson(
      baseUrl,
      "/api/developer/launch-mainline/action",
      {
        productCode: "MAINLINE_BOOT",
        channel: "stable",
        operation: "bootstrap"
      },
      ownerSession.token
    );

    assert.equal(actionResult.operation, "bootstrap");
    assert.match(actionResult.message || "", /Launch quickstart bootstrap created/i);
    assert.equal(actionResult.result?.productCode, "MAINLINE_BOOT");
    assert.equal(actionResult.followUp?.operation, "bootstrap");
    assert.equal(actionResult.receipt?.operation, "bootstrap");
    assert.match(actionResult.receipt?.summary || "", /Launch quickstart bootstrap created/i);
    assert.ok(Array.isArray(actionResult.receipt?.transitions));
    assert.ok(actionResult.receipt?.transitions?.some((item) => item.key === "policies"));
    assert.ok(Array.isArray(actionResult.receipt?.created));
    assert.ok(actionResult.receipt?.created?.some((item) => item.key === "policy"));
    assert.ok(Array.isArray(actionResult.receipt?.actions));
    assert.ok(actionResult.receipt?.actions?.length >= 1);
    assert.ok(actionResult.result?.created?.policy);
    assert.ok(actionResult.result?.created?.account);
    assert.ok(actionResult.result?.created?.cardBatch);
    assert.equal(actionResult.launchMainline?.manifest?.project?.code, "MAINLINE_BOOT");
    assert.ok(actionResult.launchMainline?.mainlineSummary?.overallGate);
    assert.ok(actionResult.launchMainline?.mainlineSummary?.primaryAction?.key);
    assert.deepEqual(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.actionPlan)
        ? actionResult.launchMainline.mainlineSummary.actionPlan.slice(0, 4).map((item) =>
            Array.isArray(item?.controls)
              ? item.controls.map((control) => ({
                  kind: control?.kind || null,
                  key:
                    control?.workspaceAction?.key
                    || control?.recommendedDownload?.key
                    || control?.bootstrapAction?.key
                    || control?.setupAction?.key
                    || null
                }))
              : []
          )
        : [],
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.actionPlan)
        ? actionResult.launchMainline.mainlineSummary.actionPlan.slice(0, 4).map((item) => [
            item?.workspaceAction?.key ? { kind: "workspace", key: item.workspaceAction.key } : null,
            item?.recommendedDownload?.key ? { kind: "download", key: item.recommendedDownload.key } : null,
            item?.bootstrapAction?.key ? { kind: "bootstrap", key: item.bootstrapAction.key } : null,
            item?.setupAction?.key ? { kind: "setup", key: item.setupAction.key } : null
          ].filter(Boolean))
        : []
    );
    assert.deepEqual(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.heroControls)
        ? actionResult.launchMainline.mainlineSummary.heroControls.map((item) => ({
            kind: item?.kind || null,
            key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
          }))
        : [],
      [
        ...(Array.isArray(actionResult.launchMainline?.mainlineSummary?.workspaceActions)
          ? actionResult.launchMainline.mainlineSummary.workspaceActions.slice(0, 5).map((item) => ({
              kind: "workspace",
              key: item?.key || null
            }))
          : []),
        { kind: "download", key: "launch_mainline_json" },
        { kind: "download", key: "launch_mainline_rehearsal_guide" },
        { kind: "download", key: "launch_mainline_summary" },
        { kind: "download", key: "launch_mainline_checksums" },
        { kind: "download", key: "launch_mainline_zip" }
      ].filter((item) => item.key)
    );
    assert.ok(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.heroControls)
      && actionResult.launchMainline.mainlineSummary.heroControls.every((item) =>
        item?.workspaceAction?.key
          ? /^\/developer\//.test(String(item.workspaceAction.href || ""))
          : item?.recommendedDownload?.key
            ? /^\/api\/developer\//.test(String(item.recommendedDownload.href || ""))
            : false
      )
    );
    assert.equal(actionResult.receipt?.mainlinePrimaryAction?.key, actionResult.launchMainline?.mainlineSummary?.primaryAction?.key);
    assert.equal(actionResult.receipt?.mainlineRecommendedDownload?.key, actionResult.launchMainline?.mainlineSummary?.recommendedDownload?.key);
    assert.equal(
      actionResult.receipt?.mainlineContinuation?.workspaceAction?.key,
      actionResult.launchMainline?.mainlineSummary?.continuation?.workspaceAction?.key
    );
    assert.equal(
      actionResult.receipt?.mainlineContinuation?.recommendedDownload?.key,
      actionResult.launchMainline?.mainlineSummary?.continuation?.recommendedDownload?.key
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineContinuationActions)
        ? actionResult.receipt.mainlineContinuationActions.map((item) => ({
            kind: item?.kind || null,
            key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
          }))
        : [],
      [
        { kind: "workspace", key: actionResult.launchMainline?.mainlineSummary?.continuation?.workspaceAction?.key || null },
        { kind: "download", key: actionResult.launchMainline?.mainlineSummary?.continuation?.recommendedDownload?.key || null }
      ].filter((item) => item.key)
    );
    assert.equal(actionResult.receipt?.mainlineOverallGate?.status, actionResult.launchMainline?.mainlineSummary?.overallGate?.status);
    assert.deepEqual(actionResult.receipt?.mainlineNextActions, actionResult.launchMainline?.mainlineSummary?.nextActions);
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineStages)
        ? actionResult.receipt.mainlineStages.map((item) => ({
            key: item?.key || null,
            status: item?.gate?.status || null
          }))
        : [],
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.stages)
        ? actionResult.launchMainline.mainlineSummary.stages.map((item) => ({
            key: item?.key || null,
            status: item?.gate?.status || null
          }))
        : []
    );
    assert.deepEqual(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.stages)
        ? actionResult.launchMainline.mainlineSummary.stages.map((item) =>
            Array.isArray(item?.controls)
              ? item.controls.map((control) => ({
                  kind: control?.kind || null,
                  key:
                    control?.workspaceAction?.key
                    || control?.recommendedDownload?.key
                    || null
                }))
              : []
          )
        : [],
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.stages)
        ? actionResult.launchMainline.mainlineSummary.stages.map((item) => [
            item?.workspaceAction?.key ? { kind: "workspace", key: item.workspaceAction.key } : null,
            item?.recommendedDownload?.key ? { kind: "download", key: item.recommendedDownload.key } : null
          ].filter(Boolean))
        : []
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineOverviewCards)
        ? actionResult.receipt.mainlineOverviewCards.map((item) => ({
            key: item?.key || null,
            controls: Array.isArray(item?.controls)
              ? item.controls.map((control) => ({
                  kind: control?.kind || null,
                  key:
                    control?.workspaceAction?.key
                    || control?.recommendedDownload?.key
                    || null
                }))
              : []
          }))
        : [],
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.overviewCards)
        ? actionResult.launchMainline.mainlineSummary.overviewCards.map((item) => ({
            key: item?.key || null,
            controls: Array.isArray(item?.controls)
              ? item.controls.map((control) => ({
                  kind: control?.kind || null,
                  key:
                    control?.workspaceAction?.key
                    || control?.recommendedDownload?.key
                    || null
                }))
              : []
          }))
        : []
    );
    const bootstrapMainlineSections = Object.fromEntries(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.sections)
        ? actionResult.launchMainline.mainlineSummary.sections.map((item) => [
            item?.key || null,
            Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
          ])
        : []
    );
    assert.deepEqual(bootstrapMainlineSections.overall_gate, ["overall_gate"]);
    assert.deepEqual(
      bootstrapMainlineSections.production_checks,
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.productionGate?.checks)
        ? actionResult.launchMainline.mainlineSummary.productionGate.checks.map((item) => item?.key || null)
        : []
    );
    assert.deepEqual(bootstrapMainlineSections.workspace_path, ["workspace_path"]);
    assert.deepEqual(
      bootstrapMainlineSections.action_plan,
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.actionPlan)
        ? actionResult.launchMainline.mainlineSummary.actionPlan.map((item) => item?.key || null)
        : []
    );
    assert.deepEqual(bootstrapMainlineSections.recommended_downloads, ["recommended_downloads"]);
    assert.deepEqual(
      bootstrapMainlineSections.stages,
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.stages)
        ? actionResult.launchMainline.mainlineSummary.stages.map((item) => item?.key || null)
        : []
    );
    assert.deepEqual(
      {
        heroControls: Array.isArray(actionResult.launchMainline?.mainlineSummary?.screen?.heroControls)
          ? actionResult.launchMainline.mainlineSummary.screen.heroControls.map((item) => ({
              kind: item?.kind || null,
              key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
            }))
          : [],
        sections: Array.isArray(actionResult.launchMainline?.mainlineSummary?.screen?.sections)
          ? actionResult.launchMainline.mainlineSummary.screen.sections.map((item) => ({
              key: item?.key || null,
              cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
            }))
          : []
      },
      {
        heroControls: Array.isArray(actionResult.launchMainline?.mainlineSummary?.heroControls)
          ? actionResult.launchMainline.mainlineSummary.heroControls.map((item) => ({
              kind: item?.kind || null,
              key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
            }))
          : [],
        sections: Array.isArray(actionResult.launchMainline?.mainlineSummary?.sections)
          ? actionResult.launchMainline.mainlineSummary.sections.map((item) => ({
              key: item?.key || null,
              cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
            }))
          : []
      }
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineSections)
        ? actionResult.receipt.mainlineSections.map((item) => ({
            key: item?.key || null,
            cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
          }))
        : [],
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.sections)
        ? actionResult.launchMainline.mainlineSummary.sections.map((item) => ({
            key: item?.key || null,
            cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
          }))
        : []
    );
    assert.deepEqual(
      {
        heroControls: Array.isArray(actionResult.receipt?.mainlineScreen?.heroControls)
          ? actionResult.receipt.mainlineScreen.heroControls.map((item) => ({
              kind: item?.kind || null,
              key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
            }))
          : [],
        sections: Array.isArray(actionResult.receipt?.mainlineScreen?.sections)
          ? actionResult.receipt.mainlineScreen.sections.map((item) => ({
              key: item?.key || null,
              cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
            }))
          : []
      },
      {
        heroControls: Array.isArray(actionResult.launchMainline?.mainlineSummary?.screen?.heroControls)
          ? actionResult.launchMainline.mainlineSummary.screen.heroControls.map((item) => ({
              kind: item?.kind || null,
              key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
            }))
          : [],
        sections: Array.isArray(actionResult.launchMainline?.mainlineSummary?.screen?.sections)
          ? actionResult.launchMainline.mainlineSummary.screen.sections.map((item) => ({
              key: item?.key || null,
              cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
            }))
          : []
      }
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineRecapCards)
        ? actionResult.receipt.mainlineRecapCards.filter((item) =>
            item?.key !== "first_launch_duty_summary"
          ).map((item) => ({
            key: item?.key || null,
            controls: Array.isArray(item?.controls)
              ? item.controls.map((control) => ({
                  kind: control?.kind || null,
                  key:
                    control?.workspaceAction?.key
                    || control?.recommendedDownload?.key
                    || control?.bootstrapAction?.key
                    || control?.setupAction?.key
                    || null
                }))
              : []
          }))
        : [],
      [
        { key: "result_status", controls: [] },
        {
          key: "mainline_status",
          controls: Array.isArray(actionResult.receipt?.mainlineFollowUpActions)
            ? actionResult.receipt.mainlineFollowUpActions.map((item) => ({
                kind: item?.kind || null,
                key: item?.workspaceAction?.key || item?.recommendedDownload?.key || item?.bootstrapAction?.key || item?.setupAction?.key || null
              }))
            : []
        },
        { key: "transition_summary", controls: [] }
      ]
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineFollowUpCards)
        ? actionResult.receipt.mainlineFollowUpCards.map((item) => ({
            key: item?.key || null,
            controls: Array.isArray(item?.controls)
              ? item.controls.map((control) => ({
                  kind: control?.kind || null,
                  key:
                    control?.workspaceAction?.key
                    || control?.recommendedDownload?.key
                    || control?.bootstrapAction?.key
                    || control?.setupAction?.key
                    || null
                }))
              : []
          }))
        : [],
      Array.isArray(actionResult.receipt?.mainlineActions)
        ? actionResult.receipt.mainlineActions.map((item) => ({
            key: item?.key || null,
            controls: Array.isArray(item?.controls)
              ? item.controls.map((control) => ({
                  kind: control?.kind || null,
                  key:
                    control?.workspaceAction?.key
                    || control?.recommendedDownload?.key
                    || control?.bootstrapAction?.key
                    || control?.setupAction?.key
                    || null
                }))
              : []
          }))
        : []
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineLastActionScreen?.sections)
        ? actionResult.receipt.mainlineLastActionScreen.sections.map((item) => ({
            key: item?.key || null,
            cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
          }))
        : [],
      [
        {
          key: "recap",
          cards: Array.isArray(actionResult.receipt?.mainlineRecapCards)
            ? actionResult.receipt.mainlineRecapCards.map((item) => item?.key || null)
            : []
        },
        ...(actionResult.receipt?.firstLaunchInventoryQueue
          ? [
              {
                key: "first_launch_inventory_queue",
                cards: [
                  "first_launch_inventory_progress",
                  "first_launch_inventory_next_action",
                  ...actionResult.receipt.firstLaunchInventoryQueue.createdBatches.map((item) => `first_launch_batch_${item.key}`)
                ]
              }
            ]
          : []),
        {
          key: "follow_up",
          cards: Array.isArray(actionResult.receipt?.mainlineFollowUpCards)
            ? actionResult.receipt.mainlineFollowUpCards.map((item) => item?.key || null)
            : []
        }
      ]
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineLastActionScreen?.sections)
        ? actionResult.receipt.mainlineLastActionScreen.sections.flatMap((section) =>
            Array.isArray(section?.cards)
              ? section.cards.flatMap((card) =>
                  Array.isArray(card?.controls)
                    ? card.controls.flatMap((control) => {
                        if (control?.workspaceAction?.key && !/^\/developer\//.test(String(control.workspaceAction.href || ""))) {
                          return [`workspace:${section?.key || "?"}:${card?.key || "?"}:${control.workspaceAction.key}`];
                        }
                        if (control?.recommendedDownload?.key && !/^\/api\/developer\//.test(String(control.recommendedDownload.href || ""))) {
                          return [`download:${section?.key || "?"}:${card?.key || "?"}:${control.recommendedDownload.key}`];
                        }
                        return [];
                      })
                    : []
                )
              : []
          )
        : [],
      []
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineHeroControls)
        ? actionResult.receipt.mainlineHeroControls.map((item) => ({
            kind: item?.kind || null,
            key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
          }))
        : [],
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.heroControls)
        ? actionResult.launchMainline.mainlineSummary.heroControls.map((item) => ({
            kind: item?.kind || null,
            key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
          }))
        : []
    );
    assert.deepEqual(
      {
        heroControls: Array.isArray(actionResult.receipt?.mainlineView?.heroControls)
          ? actionResult.receipt.mainlineView.heroControls.map((item) => ({
              kind: item?.kind || null,
              key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
            }))
          : [],
        form: actionResult.receipt?.mainlineView?.form
          ? {
              productCode: actionResult.receipt.mainlineView.form.productCode || null,
              channel: actionResult.receipt.mainlineView.form.channel || null,
              reviewMode: actionResult.receipt.mainlineView.form.reviewMode || null
            }
          : null,
        routeFocus: actionResult.receipt?.mainlineView?.routeFocus
          ? {
              title: actionResult.receipt.mainlineView.routeFocus.title || null,
              summary: actionResult.receipt.mainlineView.routeFocus.summary || null
            }
          : null,
        sections: Array.isArray(actionResult.receipt?.mainlineView?.sections)
          ? actionResult.receipt.mainlineView.sections.map((item) => ({
              key: item?.key || null,
              cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
            }))
          : [],
        lastAction: Array.isArray(actionResult.receipt?.mainlineView?.lastActionScreen?.sections)
          ? actionResult.receipt.mainlineView.lastActionScreen.sections.map((item) => ({
              key: item?.key || null,
              cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
            }))
          : []
      },
      {
        heroControls: Array.isArray(actionResult.receipt?.mainlinePage?.heroControls)
          ? actionResult.receipt.mainlinePage.heroControls.map((item) => ({
              kind: item?.kind || null,
              key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
            }))
          : [],
        form: actionResult.receipt?.mainlinePage?.form
          ? {
              productCode: actionResult.receipt.mainlinePage.form.productCode || null,
              channel: actionResult.receipt.mainlinePage.form.channel || null,
              reviewMode: actionResult.receipt.mainlinePage.form.reviewMode || null
            }
          : null,
        routeFocus: actionResult.receipt?.mainlinePage?.routeFocus
          ? {
              title: actionResult.receipt.mainlinePage.routeFocus.title || null,
              summary: actionResult.receipt.mainlinePage.routeFocus.summary || null
            }
          : null,
        sections: Array.isArray(actionResult.receipt?.mainlinePage?.sections)
          ? actionResult.receipt.mainlinePage.sections.map((item) => ({
              key: item?.key || null,
              cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
            }))
          : [],
        lastAction: Array.isArray(actionResult.receipt?.mainlinePage?.lastActionScreen?.sections)
          ? actionResult.receipt.mainlinePage.lastActionScreen.sections.map((item) => ({
              key: item?.key || null,
              cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
            }))
          : []
      }
    );
    assert.equal(actionResult.receipt?.mainlinePage?.summaryText, actionResult.launchMainline?.summaryText || "");
    assert.equal(actionResult.receipt?.mainlinePage?.form?.productCode, "MAINLINE_BOOT");
    assert.equal(actionResult.receipt?.mainlinePage?.form?.channel, "stable");
    assert.equal(actionResult.receipt?.mainlinePage?.form?.reviewMode, "matched");
    assert.equal(typeof actionResult.receipt?.mainlinePage?.routeFocus?.title, "string");
    assert.equal(typeof actionResult.receipt?.mainlinePage?.routeFocus?.summary, "string");
    assert.deepEqual(
      {
        heroControls: Array.isArray(actionResult.launchMainline?.mainlineSummary?.mainlinePage?.heroControls)
          ? actionResult.launchMainline.mainlineSummary.mainlinePage.heroControls.map((item) => ({
              kind: item?.kind || null,
              key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
            }))
          : [],
        form: actionResult.launchMainline?.mainlineSummary?.mainlinePage?.form
          ? {
              productCode: actionResult.launchMainline.mainlineSummary.mainlinePage.form.productCode || null,
              channel: actionResult.launchMainline.mainlineSummary.mainlinePage.form.channel || null,
              reviewMode: actionResult.launchMainline.mainlineSummary.mainlinePage.form.reviewMode || null
            }
          : null,
        routeFocus: actionResult.launchMainline?.mainlineSummary?.mainlinePage?.routeFocus
          ? {
              title: actionResult.launchMainline.mainlineSummary.mainlinePage.routeFocus.title || null,
              summary: actionResult.launchMainline.mainlineSummary.mainlinePage.routeFocus.summary || null
            }
          : null,
        sections: Array.isArray(actionResult.launchMainline?.mainlineSummary?.mainlinePage?.sections)
          ? actionResult.launchMainline.mainlineSummary.mainlinePage.sections.map((item) => ({
              key: item?.key || null,
              cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
            }))
          : [],
        lastAction: Array.isArray(actionResult.launchMainline?.mainlineSummary?.mainlinePage?.lastActionScreen?.sections)
          ? actionResult.launchMainline.mainlineSummary.mainlinePage.lastActionScreen.sections.map((item) => ({
              key: item?.key || null,
              cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
            }))
          : []
      },
      {
        heroControls: Array.isArray(actionResult.launchMainline?.mainlineSummary?.heroControls)
          ? actionResult.launchMainline.mainlineSummary.heroControls.map((item) => ({
              kind: item?.kind || null,
              key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
            }))
          : [],
        form: actionResult.launchMainline?.mainlineSummary?.form
          ? {
              productCode: actionResult.launchMainline.mainlineSummary.form.productCode || null,
              channel: actionResult.launchMainline.mainlineSummary.form.channel || null,
              reviewMode: actionResult.launchMainline.mainlineSummary.form.reviewMode || null
            }
          : null,
        routeFocus: actionResult.launchMainline?.mainlineSummary?.routeFocus
          ? {
              title: actionResult.launchMainline.mainlineSummary.routeFocus.title || null,
              summary: actionResult.launchMainline.mainlineSummary.routeFocus.summary || null
            }
          : null,
        sections: Array.isArray(actionResult.launchMainline?.mainlineSummary?.sections)
          ? actionResult.launchMainline.mainlineSummary.sections.map((item) => ({
              key: item?.key || null,
              cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
            }))
          : [],
        lastAction: []
      }
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineWorkspaceActions)
        ? actionResult.receipt.mainlineWorkspaceActions.map((item) => item?.key || null)
        : [],
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.workspaceActions)
        ? actionResult.launchMainline.mainlineSummary.workspaceActions.slice(0, 5).map((item) => item?.key || null)
        : []
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineRecommendedDownloads)
        ? actionResult.receipt.mainlineRecommendedDownloads.map((item) => item?.key || null)
        : [],
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.recommendedDownloads)
        ? actionResult.launchMainline.mainlineSummary.recommendedDownloads.slice(0, 6).map((item) => item?.key || null)
        : []
    );
    assert.ok(
      actionResult.receipt?.mainlineRecommendedDownloads?.findIndex((item) => item?.key === "launch_mainline_rehearsal_guide")
      < actionResult.receipt?.mainlineRecommendedDownloads?.findIndex((item) => item?.key === "launch_mainline_summary")
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineActions) ? actionResult.receipt.mainlineActions.map((item) => item?.key || null) : [],
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.actionPlan) ? actionResult.launchMainline.mainlineSummary.actionPlan.slice(0, 4).map((item) => item?.key || null) : []
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineActions)
        ? actionResult.receipt.mainlineActions.map((item) =>
            Array.isArray(item?.controls)
              ? item.controls.map((control) => ({
                  kind: control?.kind || null,
                  key:
                    control?.workspaceAction?.key
                    || control?.recommendedDownload?.key
                    || control?.bootstrapAction?.key
                    || control?.setupAction?.key
                    || null
                }))
              : []
          )
        : [],
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.actionPlan)
        ? actionResult.launchMainline.mainlineSummary.actionPlan.slice(0, 4).map((item) => [
            item?.workspaceAction?.key ? { kind: "workspace", key: item.workspaceAction.key } : null,
            item?.recommendedDownload?.key ? { kind: "download", key: item.recommendedDownload.key } : null,
            item?.bootstrapAction?.key ? { kind: "bootstrap", key: item.bootstrapAction.key } : null,
            item?.setupAction?.key ? { kind: "setup", key: item.setupAction.key } : null
          ].filter(Boolean))
        : []
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineFollowUpActions)
        ? actionResult.receipt.mainlineFollowUpActions.map((item) => ({
            kind: item?.kind || null,
            key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
          }))
        : [],
      [
        ...(Array.isArray(actionResult.receipt?.mainlineContinuationActions) ? actionResult.receipt.mainlineContinuationActions : []),
        ...(Array.isArray(actionResult.receipt?.mainlineHeroControls)
          ? actionResult.receipt.mainlineHeroControls.map((item) => ({
              kind: item?.kind || null,
              workspaceAction: item?.workspaceAction || null,
              recommendedDownload: item?.recommendedDownload || null
            }))
          : [])
      ]
        .map((item) => ({
          kind: item?.kind || null,
          key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
        }))
        .filter((item) => item.key)
    );
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer launch mainline action can create first launch batches and return refreshed mainline", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "launch.mainline.setup.owner",
        password: "LaunchMainlineSetupOwner123!",
        displayName: "Launch Mainline Setup Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "MAINLINE_SETUP",
        name: "Mainline Setup App",
        ownerDeveloperId: owner.id,
        featureConfig: {
          allowRegister: false,
          allowAccountLogin: true,
          allowCardLogin: true,
          allowCardRecharge: true
        }
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "launch.mainline.setup.owner",
      password: "LaunchMainlineSetupOwner123!"
    });

    await postJson(
      baseUrl,
      "/api/developer/policies",
      {
        productCode: "MAINLINE_SETUP",
        name: "Mainline Starter Duration",
        durationDays: 30,
        totalPoints: null,
        maxDevices: 1
      },
      ownerSession.token
    );

    const actionResult = await postJson(
      baseUrl,
      "/api/developer/launch-mainline/action",
      {
        productCode: "MAINLINE_SETUP",
        channel: "stable",
        operation: "first_batch_setup",
        mode: "recommended"
      },
      ownerSession.token
    );

    assert.equal(actionResult.operation, "first_batch_setup");
    assert.equal(actionResult.result?.productCode, "MAINLINE_SETUP");
    assert.equal(actionResult.result?.requestedMode, "recommended");
    assert.equal(actionResult.followUp?.operation, "first_batch_setup");
    assert.equal(actionResult.receipt?.operation, "first_batch_setup");
    assert.match(actionResult.receipt?.summary || "", /First-?batch setup/i);
    assert.ok(Array.isArray(actionResult.receipt?.transitions));
    assert.ok(actionResult.receipt?.transitions?.some((item) => item.key === "freshCards"));
    assert.ok(Array.isArray(actionResult.receipt?.created));
    assert.ok(actionResult.receipt?.created?.some((item) => item.key === "batch"));
    assert.ok(Array.isArray(actionResult.receipt?.actions));
    assert.ok(actionResult.receipt?.actions?.length >= 1);
    assert.equal(actionResult.result?.createdBatches?.length, 2);
    assert.ok(actionResult.result.inventoryStates.every((item) => item.status === "ready"));
    assert.deepEqual(
      actionResult.receipt?.firstLaunchInventoryQueue
        ? {
            operation: actionResult.receipt.firstLaunchInventoryQueue.operation || null,
            requestedMode: actionResult.receipt.firstLaunchInventoryQueue.requestedMode || null,
            createdBatchCount: actionResult.receipt.firstLaunchInventoryQueue.createdBatchCount ?? null,
            createdCardCount: actionResult.receipt.firstLaunchInventoryQueue.createdCardCount ?? null,
            skippedCount: actionResult.receipt.firstLaunchInventoryQueue.skippedCount ?? null,
            inventoryStateCount: actionResult.receipt.firstLaunchInventoryQueue.inventoryStateCount ?? null,
            nextActionKey: actionResult.receipt.firstLaunchInventoryQueue.nextAction?.key || null
          }
        : null,
      {
        operation: "first_batch_setup",
        requestedMode: "recommended",
        createdBatchCount: actionResult.result.createdBatches.length,
        createdCardCount: actionResult.result.createdBatches.reduce((sum, item) => sum + Number(item?.count || 0), 0),
        skippedCount: 0,
        inventoryStateCount: actionResult.result.inventoryStates.length,
        nextActionKey: actionResult.followUp.primaryAction?.key
      }
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.firstLaunchInventoryQueue?.createdBatches)
        ? actionResult.receipt.firstLaunchInventoryQueue.createdBatches.map((item) => ({
            key: item?.key || null,
            mode: item?.mode || null,
            label: item?.label || null,
            count: item?.count ?? null,
            batchCode: item?.batchCode || null,
            prefix: item?.prefix || null
          }))
        : [],
      actionResult.result.createdBatches.map((item) => ({
        key: item?.key || null,
        mode: item?.mode || null,
        label: item?.label || null,
        count: item?.count ?? null,
        batchCode: item?.batchCode || null,
        prefix: item?.prefix || null
      }))
    );
    assert.ok(
      actionResult.receipt?.firstLaunchInventoryQueue?.nextActions?.some((item) =>
        item?.key === "inventory_recheck"
        && item?.workspaceAction?.key === "licenses"
        && item?.recommendedDownload?.key
      )
    );
    const firstLaunchInventorySection = Array.isArray(actionResult.receipt?.mainlineLastActionScreen?.sections)
      ? actionResult.receipt.mainlineLastActionScreen.sections.find((item) => item?.key === "first_launch_inventory_queue")
      : null;
    assert.deepEqual(
      firstLaunchInventorySection
        ? {
            key: firstLaunchInventorySection.key || null,
            title: firstLaunchInventorySection.title || null,
            cards: Array.isArray(firstLaunchInventorySection.cards)
              ? firstLaunchInventorySection.cards.map((item) => item?.key || null)
              : []
          }
        : null,
      {
        key: "first_launch_inventory_queue",
        title: "First Launch Inventory Queue",
        cards: [
          "first_launch_inventory_progress",
          "first_launch_inventory_next_action",
          ...actionResult.result.createdBatches.map((item) => `first_launch_batch_${item.key}`)
        ]
      }
    );
    assert.ok(
      firstLaunchInventorySection?.cards?.find((item) => item?.key === "first_launch_inventory_next_action")?.controls?.some((control) =>
        control?.kind === "workspace"
        && control?.workspaceAction?.key === actionResult.followUp.primaryAction?.workspaceAction?.key
      )
    );
    assert.deepEqual(
      actionResult.receipt?.firstLaunchOpsQueue
        ? {
            operation: actionResult.receipt.firstLaunchOpsQueue.operation || null,
            actionCount: actionResult.receipt.firstLaunchOpsQueue.actionCount ?? null,
            runtimeActionCount: actionResult.receipt.firstLaunchOpsQueue.runtimeActionCount ?? null,
            watchActionCount: actionResult.receipt.firstLaunchOpsQueue.watchActionCount ?? null,
            nextActionKey: actionResult.receipt.firstLaunchOpsQueue.nextAction?.key || null
          }
        : null,
      {
        operation: "first_batch_setup",
        actionCount: actionResult.followUp.actions.length,
        runtimeActionCount: actionResult.followUp.actions.filter((item) => ["runtime_smoke", "session_review"].includes(item?.key)).length,
        watchActionCount: actionResult.followUp.actions.filter((item) => /watch|review|smoke/i.test(String(item?.key || ""))).length,
        nextActionKey: actionResult.followUp.actions[0]?.key
      }
    );
    assert.ok(
      actionResult.receipt?.firstLaunchOpsQueue?.actions?.some((item) =>
        item?.key === "runtime_smoke"
        && item?.stage === "runtime_validation"
        && item?.ownerRole === "qa"
        && item?.workspaceAction?.key === "ops"
        && item?.recommendedDownload?.key
      )
    );
    assert.ok(
      actionResult.receipt?.firstLaunchOpsQueue?.actions?.some((item) =>
        item?.key === "card_redemption_watch"
        && item?.stage === "first_sale_watch"
        && item?.ownerRole === "support"
        && item?.workspaceAction?.key === "ops"
        && item?.recommendedDownload?.key
      )
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.firstLaunchOpsQueue?.stageGroups)
        ? actionResult.receipt.firstLaunchOpsQueue.stageGroups.map((item) => ({
            key: item?.key || null,
            ownerRole: item?.ownerRole || null,
            actionKeys: Array.isArray(item?.actions) ? item.actions.map((action) => action?.key || null) : []
          }))
        : [],
      [
        {
          key: "inventory_handoff",
          ownerRole: "launch_ops",
          actionKeys: ["inventory_recheck"]
        },
        {
          key: "launch_recheck",
          ownerRole: "release_manager",
          actionKeys: ["launch_recheck", "launch_smoke_kit"]
        },
        {
          key: "first_sale_watch",
          ownerRole: "support",
          actionKeys: ["card_redemption_watch"]
        },
        {
          key: "runtime_validation",
          ownerRole: "qa",
          actionKeys: ["runtime_smoke"]
        },
        {
          key: "runtime_ops_watch",
          ownerRole: "ops",
          actionKeys: ["session_review", "startup_rule_watch"]
        },
        {
          key: "support_handoff",
          ownerRole: "support",
          actionKeys: ["starter_account_handoff"]
        }
      ]
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.firstLaunchOpsQueue?.ownerGroups)
        ? actionResult.receipt.firstLaunchOpsQueue.ownerGroups.map((item) => ({
            key: item?.key || null,
            actionCount: item?.actionCount ?? null
          }))
        : [],
      [
        { key: "launch_ops", actionCount: 1 },
        { key: "release_manager", actionCount: 2 },
        { key: "support", actionCount: 2 },
        { key: "qa", actionCount: 1 },
        { key: "ops", actionCount: 2 }
      ]
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.firstLaunchOpsQueue?.handoffChecklist)
        ? actionResult.receipt.firstLaunchOpsQueue.handoffChecklist.map((item) => ({
            key: item?.key || null,
            ownerRole: item?.ownerRole || null,
            stageKeys: Array.isArray(item?.stageKeys) ? item.stageKeys : [],
            actionKeys: Array.isArray(item?.actions) ? item.actions.map((action) => action?.key || null) : []
          }))
        : [],
      [
        {
          key: "launch_ops_handoff",
          ownerRole: "launch_ops",
          stageKeys: ["inventory_handoff"],
          actionKeys: ["inventory_recheck"]
        },
        {
          key: "release_manager_handoff",
          ownerRole: "release_manager",
          stageKeys: ["launch_recheck"],
          actionKeys: ["launch_recheck", "launch_smoke_kit"]
        },
        {
          key: "support_handoff",
          ownerRole: "support",
          stageKeys: ["first_sale_watch", "support_handoff"],
          actionKeys: ["card_redemption_watch", "starter_account_handoff"]
        },
        {
          key: "qa_handoff",
          ownerRole: "qa",
          stageKeys: ["runtime_validation"],
          actionKeys: ["runtime_smoke"]
        },
        {
          key: "ops_handoff",
          ownerRole: "ops",
          stageKeys: ["runtime_ops_watch"],
          actionKeys: ["session_review", "startup_rule_watch"]
        }
      ]
    );
    const firstLaunchOpsSection = Array.isArray(actionResult.receipt?.mainlineLastActionScreen?.sections)
      ? actionResult.receipt.mainlineLastActionScreen.sections.find((item) => item?.key === "first_launch_ops_queue")
      : null;
    assert.deepEqual(
      firstLaunchOpsSection
        ? {
            key: firstLaunchOpsSection.key || null,
            title: firstLaunchOpsSection.title || null,
            cards: Array.isArray(firstLaunchOpsSection.cards)
              ? firstLaunchOpsSection.cards.map((item) => item?.key || null)
              : []
          }
        : null,
      {
        key: "first_launch_ops_queue",
        title: "First Launch Ops Queue",
        cards: [
          "first_launch_ops_progress",
          ...actionResult.followUp.actions.map((item) => `first_launch_ops_${item.key}`)
        ]
      }
    );
    assert.ok(
      firstLaunchOpsSection?.cards?.find((item) => item?.key === "first_launch_ops_runtime_smoke")?.controls?.some((control) =>
        control?.kind === "workspace"
        && control?.workspaceAction?.key === "ops"
      )
    );
    assert.ok(firstLaunchOpsSection?.cards?.find((item) =>
      item?.key === "first_launch_ops_progress"
      && Array.isArray(item?.details)
      && item.details.some((detail) => /Handoff checklist:/i.test(String(detail || "")))
      && item.details.some((detail) => /Support:2/i.test(String(detail || "")))
    ));
    const firstLaunchHandoffSection = Array.isArray(actionResult.receipt?.mainlineLastActionScreen?.sections)
      ? actionResult.receipt.mainlineLastActionScreen.sections.find((item) => item?.key === "first_launch_handoff_checklist")
      : null;
    assert.deepEqual(
      firstLaunchHandoffSection
        ? {
            key: firstLaunchHandoffSection.key || null,
            title: firstLaunchHandoffSection.title || null,
            cards: Array.isArray(firstLaunchHandoffSection.cards)
              ? firstLaunchHandoffSection.cards.map((item) => item?.key || null)
              : []
          }
        : null,
      {
        key: "first_launch_handoff_checklist",
        title: "First Launch Handoff Checklist",
        cards: [
          "first_launch_handoff_summary",
          ...actionResult.receipt.firstLaunchOpsQueue.handoffChecklist.map((item) => item?.key || null)
        ]
      }
    );
    const firstLaunchHandoffCards = Object.fromEntries(
      Array.isArray(firstLaunchHandoffSection?.cards)
        ? firstLaunchHandoffSection.cards.map((item) => [item?.key || null, item])
        : []
    );
    const firstLaunchHandoffDownload = firstLaunchHandoffCards.first_launch_handoff_summary?.controls?.find((control) =>
      control?.kind === "download"
      && control?.recommendedDownload?.key === "launch_mainline_first_launch_handoff"
    )?.recommendedDownload || null;
    assert.deepEqual(
      firstLaunchHandoffDownload
        ? {
            label: firstLaunchHandoffDownload.label || null,
            fileName: firstLaunchHandoffDownload.fileName || null,
            hasHref: /^\/api\/developer\/launch-mainline\/download/.test(String(firstLaunchHandoffDownload.href || "")),
            format: /format=first-launch-handoff/.test(String(firstLaunchHandoffDownload.href || "")),
            productCode: /productCode=MAINLINE_SETUP/.test(String(firstLaunchHandoffDownload.href || ""))
          }
        : null,
      {
        label: "First launch handoff",
        fileName: "launch-mainline-first-launch-handoff.txt",
        hasHref: true,
        format: true,
        productCode: true
      }
    );
    assert.ok(
      Array.isArray(firstLaunchHandoffCards.first_launch_handoff_summary?.details)
      && firstLaunchHandoffCards.first_launch_handoff_summary.details.some((detail) => /Owners: Launch Ops:1 \| Release Manager:2 \| Support:2 \| QA:1 \| Ops:2/i.test(String(detail || "")))
      && firstLaunchHandoffCards.first_launch_handoff_summary.details.some((detail) => /Stages: Inventory Handoff \| Launch Recheck \| First-Sale Watch \| Runtime Validation \| Runtime Ops Watch \| Support Handoff/i.test(String(detail || "")))
      && firstLaunchHandoffCards.first_launch_handoff_summary.details.some((detail) => /Production evidence: remaining=\d+ \| completed=\d+ \| next=.+ \| operation=record_/i.test(String(detail || "")))
    );
    assert.ok(
      Array.isArray(firstLaunchHandoffCards.first_launch_handoff_summary?.controls)
      && firstLaunchHandoffCards.first_launch_handoff_summary.controls.some((control) =>
        control?.kind === "setup"
        && control?.setupAction?.operation === actionResult.receipt.mainlineEvidenceQueue?.nextAction?.setupAction?.operation
      )
    );
    const firstLaunchHandoffDownloadResponse = await getText(
      baseUrl,
      firstLaunchHandoffDownload.href,
      ownerSession.token
    );
    assert.match(firstLaunchHandoffDownloadResponse.contentType || "", /^text\/plain/);
    assert.match(firstLaunchHandoffDownloadResponse.contentDisposition || "", /attachment; filename="rocksolid-developer-launch-mainline-MAINLINE_SETUP-stable-.*-first-launch-handoff\.txt"/);
    assert.match(firstLaunchHandoffDownloadResponse.body, /RockSolid Developer Launch Mainline First Launch Handoff/);
    assert.match(firstLaunchHandoffDownloadResponse.body, /Launch Duty Summary:/);
    assert.match(firstLaunchHandoffDownloadResponse.body, /Inventory Health: READY \| ready=2 \| low=0 \| missing=0 \| readyModes=direct_card,recharge/);
    assert.match(firstLaunchHandoffDownloadResponse.body, /Production Evidence: remaining=\d+ \| completed=\d+ \| next=.+ \| operation=record_/);
    assert.match(firstLaunchHandoffDownloadResponse.body, /Duty Chain:/);
    assert.match(firstLaunchHandoffDownloadResponse.body, /First Batch Card Suggestions:/);
    assert.match(firstLaunchHandoffDownloadResponse.body, /First Ops Actions:/);
    assert.match(firstLaunchHandoffDownloadResponse.body, /Watch first card redemptions/);
    assert.match(firstLaunchHandoffDownloadResponse.body, /Verify first real sign-ins/);
    assert.deepEqual(
      firstLaunchHandoffCards.support_handoff
        ? {
            title: firstLaunchHandoffCards.support_handoff.title || null,
            actions: Array.isArray(firstLaunchHandoffCards.support_handoff.details)
              ? firstLaunchHandoffCards.support_handoff.details.filter((item) => /^Action:/i.test(String(item || ""))).length
              : 0,
            controlKeys: Array.isArray(firstLaunchHandoffCards.support_handoff.controls)
              ? firstLaunchHandoffCards.support_handoff.controls.map((control) =>
                  control?.workspaceAction?.key
                  || control?.recommendedDownload?.key
                  || control?.bootstrapAction?.key
                  || control?.setupAction?.key
                  || null
                ).filter(Boolean)
              : []
          }
        : null,
      {
        title: "Support Handoff",
        actions: 2,
        controlKeys: ["ops", "ops_card_redemption_watch_summary", "licenses"]
      }
    );
    assert.deepEqual(
      actionResult.receipt?.firstLaunchDutySummary
        ? {
            key: actionResult.receipt.firstLaunchDutySummary.key || null,
            status: actionResult.receipt.firstLaunchDutySummary.status || null,
            inventoryBatches: actionResult.receipt.firstLaunchDutySummary.inventory?.createdBatchCount ?? null,
            inventoryCards: actionResult.receipt.firstLaunchDutySummary.inventory?.createdCardCount ?? null,
            opsActions: actionResult.receipt.firstLaunchDutySummary.ops?.actionCount ?? null,
            ownerCount: actionResult.receipt.firstLaunchDutySummary.ops?.ownerCount ?? null,
            nextActionKey: actionResult.receipt.firstLaunchDutySummary.nextAction?.key || null,
            handoffDownloadKey: actionResult.receipt.firstLaunchDutySummary.handoffDownload?.key || null,
            productionNextActionKey: actionResult.receipt.firstLaunchDutySummary.productionNextAction?.key || null
          }
        : null,
      {
        key: "first_launch_duty_summary",
        status: "ready",
        inventoryBatches: actionResult.result.createdBatches.length,
        inventoryCards: actionResult.result.createdBatches.reduce((sum, item) => sum + Number(item?.count || 0), 0),
        opsActions: actionResult.followUp.actions.length,
        ownerCount: actionResult.receipt.firstLaunchOpsQueue.handoffChecklist.length,
        nextActionKey: actionResult.receipt.firstLaunchOpsQueue.nextAction?.key,
        handoffDownloadKey: "launch_mainline_first_launch_handoff",
        productionNextActionKey: actionResult.receipt.mainlineEvidenceQueue?.nextAction?.key || null
      }
    );
    assert.deepEqual(
      actionResult.receipt?.firstLaunchDutySummary?.inventory
        ? {
            batchCodes: actionResult.receipt.firstLaunchDutySummary.inventory.batchCodes || [],
            modes: actionResult.receipt.firstLaunchDutySummary.inventory.modes || [],
            refillCardCount: actionResult.receipt.firstLaunchDutySummary.inventory.refillCardCount ?? null
          }
        : null,
      {
        batchCodes: actionResult.result.createdBatches.map((item) => item.batchCode),
        modes: actionResult.result.createdBatches.map((item) => item.mode),
        refillCardCount: 0
      }
    );
    assert.deepEqual(
      actionResult.receipt?.firstLaunchDutySummary?.inventory?.health || null,
      {
        status: "ready",
        readyStateCount: 2,
        lowStateCount: 0,
        missingStateCount: 0,
        readyModes: ["direct_card", "recharge"],
        lowModes: [],
        missingModes: []
      }
    );
    assert.deepEqual(
      actionResult.receipt?.firstLaunchDutySummary?.productionEvidence
        ? {
            status: actionResult.receipt.firstLaunchDutySummary.productionEvidence.status || null,
            totalCount: actionResult.receipt.firstLaunchDutySummary.productionEvidence.totalCount ?? null,
            completedCount: actionResult.receipt.firstLaunchDutySummary.productionEvidence.completedCount ?? null,
            remainingCount: actionResult.receipt.firstLaunchDutySummary.productionEvidence.remainingCount ?? null,
            nextActionKey: actionResult.receipt.firstLaunchDutySummary.productionEvidence.nextAction?.key || null,
            nextOperation: actionResult.receipt.firstLaunchDutySummary.productionEvidence.nextAction?.setupAction?.operation || null
          }
        : null,
      {
        status: Number(actionResult.receipt.mainlineEvidenceQueue?.remainingCount || 0) > 0 ? "review" : "ready",
        totalCount: actionResult.receipt.mainlineEvidenceQueue?.totalCount ?? null,
        completedCount: actionResult.receipt.mainlineEvidenceQueue?.completedCount ?? null,
        remainingCount: actionResult.receipt.mainlineEvidenceQueue?.remainingCount ?? null,
        nextActionKey: actionResult.receipt.mainlineEvidenceQueue?.nextAction?.key || null,
        nextOperation: actionResult.receipt.mainlineEvidenceQueue?.nextAction?.setupAction?.operation || null
      }
    );
    assert.ok(
      Array.isArray(actionResult.receipt?.firstLaunchDutySummary?.productionEvidence?.controls)
      && actionResult.receipt.firstLaunchDutySummary.productionEvidence.controls.some((control) =>
        control?.kind === "setup"
        && control?.setupAction?.operation === actionResult.receipt.mainlineEvidenceQueue?.nextAction?.setupAction?.operation
      )
      && actionResult.receipt.firstLaunchDutySummary.productionEvidence.controls.some((control) =>
        control?.kind === "workspace"
        && control?.workspaceAction?.key === actionResult.receipt.mainlineEvidenceQueue?.nextAction?.workspaceAction?.key
      )
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.firstLaunchDutySummary?.ops?.stageGroups)
        ? actionResult.receipt.firstLaunchDutySummary.ops.stageGroups.map((item) => ({
            key: item?.key || null,
            ownerRole: item?.ownerRole || null,
            actionKeys: Array.isArray(item?.actions) ? item.actions.map((action) => action?.key || null) : []
          }))
        : [],
      Array.isArray(actionResult.receipt?.firstLaunchOpsQueue?.stageGroups)
        ? actionResult.receipt.firstLaunchOpsQueue.stageGroups.map((item) => ({
            key: item?.key || null,
            ownerRole: item?.ownerRole || null,
            actionKeys: Array.isArray(item?.actions) ? item.actions.map((action) => action?.key || null) : []
          }))
        : []
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.firstLaunchDutySummary?.ops?.ownerPath)
        ? actionResult.receipt.firstLaunchDutySummary.ops.ownerPath.map((item) => ({
            key: item?.key || null,
            actionCount: item?.actionCount ?? null
          }))
        : [],
      [
        { key: "launch_ops", actionCount: 1 },
        { key: "release_manager", actionCount: 2 },
        { key: "support", actionCount: 2 },
        { key: "qa", actionCount: 1 },
        { key: "ops", actionCount: 2 }
      ]
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.firstLaunchDutySummary?.ops?.stagePath)
        ? actionResult.receipt.firstLaunchDutySummary.ops.stagePath.map((item) => ({
            key: item?.key || null,
            ownerRole: item?.ownerRole || null,
            actionCount: item?.actionCount ?? null
          }))
        : [],
      [
        { key: "inventory_handoff", ownerRole: "launch_ops", actionCount: 1 },
        { key: "launch_recheck", ownerRole: "release_manager", actionCount: 2 },
        { key: "first_sale_watch", ownerRole: "support", actionCount: 1 },
        { key: "runtime_validation", ownerRole: "qa", actionCount: 1 },
        { key: "runtime_ops_watch", ownerRole: "ops", actionCount: 2 },
        { key: "support_handoff", ownerRole: "support", actionCount: 1 }
      ]
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.firstLaunchDutySummary?.ops?.handoffs)
        ? actionResult.receipt.firstLaunchDutySummary.ops.handoffs.map((item) => ({
            key: item?.key || null,
            ownerRole: item?.ownerRole || null,
            stageKeys: Array.isArray(item?.stageKeys) ? item.stageKeys : [],
            actionKeys: Array.isArray(item?.actions) ? item.actions.map((action) => action?.key || null) : []
          }))
        : [],
      Array.isArray(actionResult.receipt?.firstLaunchOpsQueue?.handoffChecklist)
        ? actionResult.receipt.firstLaunchOpsQueue.handoffChecklist.map((item) => ({
            key: item?.key || null,
            ownerRole: item?.ownerRole || null,
            stageKeys: Array.isArray(item?.stageKeys) ? item.stageKeys : [],
            actionKeys: Array.isArray(item?.actions) ? item.actions.map((action) => action?.key || null) : []
          }))
        : []
    );
    assert.deepEqual(
      actionResult.receipt?.firstLaunchDutySummary?.ops?.primaryHandoff
        ? {
            key: actionResult.receipt.firstLaunchDutySummary.ops.primaryHandoff.key || null,
            ownerRole: actionResult.receipt.firstLaunchDutySummary.ops.primaryHandoff.ownerRole || null,
            stageKeys: Array.isArray(actionResult.receipt.firstLaunchDutySummary.ops.primaryHandoff.stageKeys)
              ? actionResult.receipt.firstLaunchDutySummary.ops.primaryHandoff.stageKeys
              : [],
            actionKeys: Array.isArray(actionResult.receipt.firstLaunchDutySummary.ops.primaryHandoff.actions)
              ? actionResult.receipt.firstLaunchDutySummary.ops.primaryHandoff.actions.map((action) => action?.key || null)
              : [],
            controlKeys: Array.isArray(actionResult.receipt.firstLaunchDutySummary.ops.primaryHandoff.controls)
              ? actionResult.receipt.firstLaunchDutySummary.ops.primaryHandoff.controls.map((control) =>
                  control?.workspaceAction?.key
                  || control?.recommendedDownload?.key
                  || control?.bootstrapAction?.key
                  || control?.setupAction?.key
                  || null
                ).filter(Boolean)
              : []
          }
        : null,
      {
        key: "launch_ops_handoff",
        ownerRole: "launch_ops",
        stageKeys: ["inventory_handoff"],
        actionKeys: ["inventory_recheck"],
        controlKeys: ["licenses", "launch_checklist"]
      }
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.firstLaunchDutySummary?.ops?.launchWindowFlow)
        ? actionResult.receipt.firstLaunchDutySummary.ops.launchWindowFlow.map((item) => ({
            key: item?.key || null,
            stage: item?.stage || null,
            ownerRole: item?.ownerRole || null,
            timing: item?.timing || null
          }))
        : [],
      Array.isArray(actionResult.receipt?.firstLaunchOpsQueue?.actions)
        ? actionResult.receipt.firstLaunchOpsQueue.actions.map((item) => ({
            key: item?.key || null,
            stage: item?.stage || null,
            ownerRole: item?.ownerRole || null,
            timing: item?.timing || null
          }))
        : []
    );
    assert.deepEqual(
      (() => {
        const supportHandoff = Array.isArray(actionResult.receipt?.firstLaunchDutySummary?.ops?.handoffs)
          ? actionResult.receipt.firstLaunchDutySummary.ops.handoffs.find((item) => item?.key === "support_handoff")
          : null;
        return supportHandoff
          ? (Array.isArray(supportHandoff.controls)
            ? supportHandoff.controls.map((control) =>
                control?.workspaceAction?.key
                || control?.recommendedDownload?.key
                || control?.bootstrapAction?.key
                || control?.setupAction?.key
                || null
              ).filter(Boolean)
            : [])
          : [];
      })(),
      ["ops", "ops_card_redemption_watch_summary", "licenses"]
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.firstLaunchDutySummary?.dutyChain)
        ? actionResult.receipt.firstLaunchDutySummary.dutyChain.map((item) => ({
            key: item?.key || null,
            kind: item?.kind || null,
            ownerRole: item?.ownerRole || null
          }))
        : [],
      [
        { key: "first_batch_setup", kind: "operation", ownerRole: "launch_ops" },
        ...actionResult.receipt.firstLaunchOpsQueue.actions.map((item) => ({
          key: item.key,
          kind: "action",
          ownerRole: item.ownerRole
        })),
        { key: "launch_mainline_first_launch_handoff", kind: "download", ownerRole: "launch_ops" },
        {
          key: actionResult.receipt.mainlineEvidenceQueue?.nextAction?.key || null,
          kind: "production_evidence",
          ownerRole: "ops"
        }
      ].filter((item) => item.key)
    );
    assert.ok(
      Array.isArray(actionResult.receipt?.firstLaunchDutySummary?.details)
      && actionResult.receipt.firstLaunchDutySummary.details.some((detail) => /Duty chain:/i.test(String(detail || "")))
      && actionResult.receipt.firstLaunchDutySummary.details.some((detail) => /Inventory health: READY \| ready=2 \| low=0 \| missing=0 \| readyModes=direct_card,recharge/i.test(String(detail || "")))
      && actionResult.receipt.firstLaunchDutySummary.details.some((detail) => /Production evidence: remaining=\d+ \| completed=\d+ \| next=.+ \| operation=record_/i.test(String(detail || "")))
      && actionResult.receipt.firstLaunchDutySummary.details.some((detail) => /Launch window flow:/i.test(String(detail || "")))
      && actionResult.receipt.firstLaunchDutySummary.details.some((detail) => /Owner path: Launch Ops -> Release Manager -> Support -> QA -> Ops/i.test(String(detail || "")))
      && actionResult.receipt.firstLaunchDutySummary.details.some((detail) => /Stage path: Inventory Handoff -> Launch Recheck -> First-Sale Watch -> Runtime Validation -> Runtime Ops Watch -> Support Handoff/i.test(String(detail || "")))
      && actionResult.receipt.firstLaunchDutySummary.details.some((detail) => /Owners: Launch Ops:1 \| Release Manager:2 \| Support:2 \| QA:1 \| Ops:2/i.test(String(detail || "")))
    );
    assert.ok(
      Array.isArray(actionResult.receipt?.firstLaunchDutySummary?.controls)
      && actionResult.receipt.firstLaunchDutySummary.controls.some((control) =>
        control?.kind === "download"
        && control?.recommendedDownload?.key === "launch_mainline_first_launch_handoff"
      )
      && actionResult.receipt.firstLaunchDutySummary.controls.some((control) =>
        control?.kind === "workspace"
        && control?.workspaceAction?.key === actionResult.receipt.firstLaunchOpsQueue.nextAction?.workspaceAction?.key
      )
      && actionResult.receipt.firstLaunchDutySummary.controls.some((control) =>
        control?.kind === "setup"
        && control?.setupAction?.operation === actionResult.receipt.mainlineEvidenceQueue?.nextAction?.setupAction?.operation
      )
    );
    assert.ok(
      actionResult.receipt?.mainlineRecapCards?.some((item) =>
        item?.key === "first_launch_duty_summary"
        && Array.isArray(item.details)
        && item.details.some((detail) => /Duty chain:/i.test(String(detail || "")))
        && item.details.some((detail) => /Production evidence: remaining=\d+ \| completed=\d+ \| next=.+ \| operation=record_/i.test(String(detail || "")))
        && item.details.some((detail) => /Launch window flow:/i.test(String(detail || "")))
        && item.details.some((detail) => /Owner path: Launch Ops -> Release Manager -> Support -> QA -> Ops/i.test(String(detail || "")))
        && item.details.some((detail) => /Stage path: Inventory Handoff -> Launch Recheck -> First-Sale Watch -> Runtime Validation -> Runtime Ops Watch -> Support Handoff/i.test(String(detail || "")))
        && Array.isArray(item.controls)
        && item.controls.some((control) => control?.recommendedDownload?.key === "launch_mainline_first_launch_handoff")
        && item.controls.some((control) => control?.setupAction?.operation === actionResult.receipt.mainlineEvidenceQueue?.nextAction?.setupAction?.operation)
      )
    );
    assert.equal(actionResult.launchMainline?.manifest?.project?.code, "MAINLINE_SETUP");
    assert.ok(actionResult.launchMainline?.mainlineSummary?.overallGate);
    assert.ok(actionResult.launchMainline?.mainlineSummary?.recommendedDownloads?.some((item) => item.key === "launch_summary"));
    assert.deepEqual(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.actionPlan)
        ? actionResult.launchMainline.mainlineSummary.actionPlan.slice(0, 4).map((item) =>
            Array.isArray(item?.controls)
              ? item.controls.map((control) => ({
                  kind: control?.kind || null,
                  key:
                    control?.workspaceAction?.key
                    || control?.recommendedDownload?.key
                    || control?.bootstrapAction?.key
                    || control?.setupAction?.key
                    || null
                }))
              : []
          )
        : [],
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.actionPlan)
        ? actionResult.launchMainline.mainlineSummary.actionPlan.slice(0, 4).map((item) => [
            item?.workspaceAction?.key ? { kind: "workspace", key: item.workspaceAction.key } : null,
            item?.recommendedDownload?.key ? { kind: "download", key: item.recommendedDownload.key } : null,
            item?.bootstrapAction?.key ? { kind: "bootstrap", key: item.bootstrapAction.key } : null,
            item?.setupAction?.key ? { kind: "setup", key: item.setupAction.key } : null
          ].filter(Boolean))
        : []
    );
    assert.deepEqual(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.heroControls)
        ? actionResult.launchMainline.mainlineSummary.heroControls.map((item) => ({
            kind: item?.kind || null,
            key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
          }))
        : [],
      [
        ...(Array.isArray(actionResult.launchMainline?.mainlineSummary?.workspaceActions)
          ? actionResult.launchMainline.mainlineSummary.workspaceActions.slice(0, 5).map((item) => ({
              kind: "workspace",
              key: item?.key || null
            }))
          : []),
        { kind: "download", key: "launch_mainline_json" },
        { kind: "download", key: "launch_mainline_rehearsal_guide" },
        { kind: "download", key: "launch_mainline_summary" },
        { kind: "download", key: "launch_mainline_checksums" },
        { kind: "download", key: "launch_mainline_zip" }
      ].filter((item) => item.key)
    );
    assert.ok(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.heroControls)
      && actionResult.launchMainline.mainlineSummary.heroControls.every((item) =>
        item?.workspaceAction?.key
          ? /^\/developer\//.test(String(item.workspaceAction.href || ""))
          : item?.recommendedDownload?.key
            ? /^\/api\/developer\//.test(String(item.recommendedDownload.href || ""))
            : false
      )
    );
    assert.equal(actionResult.receipt?.mainlinePrimaryAction?.key, actionResult.launchMainline?.mainlineSummary?.primaryAction?.key);
    assert.equal(actionResult.receipt?.mainlineRecommendedDownload?.key, actionResult.launchMainline?.mainlineSummary?.recommendedDownload?.key);
    assert.equal(
      actionResult.receipt?.mainlineContinuation?.workspaceAction?.key,
      actionResult.launchMainline?.mainlineSummary?.continuation?.workspaceAction?.key
    );
    assert.equal(
      actionResult.receipt?.mainlineContinuation?.recommendedDownload?.key,
      actionResult.launchMainline?.mainlineSummary?.continuation?.recommendedDownload?.key
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineContinuationActions)
        ? actionResult.receipt.mainlineContinuationActions.map((item) => ({
            kind: item?.kind || null,
            key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
          }))
        : [],
      [
        { kind: "workspace", key: actionResult.launchMainline?.mainlineSummary?.continuation?.workspaceAction?.key || null },
        { kind: "download", key: actionResult.launchMainline?.mainlineSummary?.continuation?.recommendedDownload?.key || null }
      ].filter((item) => item.key)
    );
    assert.equal(actionResult.receipt?.mainlineOverallGate?.status, actionResult.launchMainline?.mainlineSummary?.overallGate?.status);
    assert.deepEqual(actionResult.receipt?.mainlineNextActions, actionResult.launchMainline?.mainlineSummary?.nextActions);
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineStages)
        ? actionResult.receipt.mainlineStages.map((item) => ({
            key: item?.key || null,
            status: item?.gate?.status || null
          }))
        : [],
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.stages)
        ? actionResult.launchMainline.mainlineSummary.stages.map((item) => ({
            key: item?.key || null,
            status: item?.gate?.status || null
          }))
        : []
    );
    assert.deepEqual(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.stages)
        ? actionResult.launchMainline.mainlineSummary.stages.map((item) =>
            Array.isArray(item?.controls)
              ? item.controls.map((control) => ({
                  kind: control?.kind || null,
                  key:
                    control?.workspaceAction?.key
                    || control?.recommendedDownload?.key
                    || null
                }))
              : []
          )
        : [],
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.stages)
        ? actionResult.launchMainline.mainlineSummary.stages.map((item) => [
            item?.workspaceAction?.key ? { kind: "workspace", key: item.workspaceAction.key } : null,
            item?.recommendedDownload?.key ? { kind: "download", key: item.recommendedDownload.key } : null
          ].filter(Boolean))
        : []
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineOverviewCards)
        ? actionResult.receipt.mainlineOverviewCards.map((item) => ({
            key: item?.key || null,
            controls: Array.isArray(item?.controls)
              ? item.controls.map((control) => ({
                  kind: control?.kind || null,
                  key:
                    control?.workspaceAction?.key
                    || control?.recommendedDownload?.key
                    || null
                }))
              : []
          }))
        : [],
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.overviewCards)
        ? actionResult.launchMainline.mainlineSummary.overviewCards.map((item) => ({
            key: item?.key || null,
            controls: Array.isArray(item?.controls)
              ? item.controls.map((control) => ({
                  kind: control?.kind || null,
                  key:
                    control?.workspaceAction?.key
                    || control?.recommendedDownload?.key
                    || null
                }))
              : []
          }))
        : []
    );
    const setupMainlineSections = Object.fromEntries(
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.sections)
        ? actionResult.launchMainline.mainlineSummary.sections.map((item) => [
            item?.key || null,
            Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
          ])
        : []
    );
    assert.deepEqual(setupMainlineSections.overall_gate, ["overall_gate"]);
    assert.deepEqual(
      setupMainlineSections.production_checks,
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.productionGate?.checks)
        ? actionResult.launchMainline.mainlineSummary.productionGate.checks.map((item) => item?.key || null)
        : []
    );
    assert.deepEqual(setupMainlineSections.workspace_path, ["workspace_path"]);
    assert.deepEqual(
      setupMainlineSections.action_plan,
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.actionPlan)
        ? actionResult.launchMainline.mainlineSummary.actionPlan.map((item) => item?.key || null)
        : []
    );
    assert.deepEqual(setupMainlineSections.recommended_downloads, ["recommended_downloads"]);
    assert.deepEqual(
      setupMainlineSections.stages,
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.stages)
        ? actionResult.launchMainline.mainlineSummary.stages.map((item) => item?.key || null)
        : []
    );
    assert.deepEqual(
      {
        heroControls: Array.isArray(actionResult.launchMainline?.mainlineSummary?.screen?.heroControls)
          ? actionResult.launchMainline.mainlineSummary.screen.heroControls.map((item) => ({
              kind: item?.kind || null,
              key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
            }))
          : [],
        sections: Array.isArray(actionResult.launchMainline?.mainlineSummary?.screen?.sections)
          ? actionResult.launchMainline.mainlineSummary.screen.sections.map((item) => ({
              key: item?.key || null,
              cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
            }))
          : []
      },
      {
        heroControls: Array.isArray(actionResult.launchMainline?.mainlineSummary?.heroControls)
          ? actionResult.launchMainline.mainlineSummary.heroControls.map((item) => ({
              kind: item?.kind || null,
              key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
            }))
          : [],
        sections: Array.isArray(actionResult.launchMainline?.mainlineSummary?.sections)
          ? actionResult.launchMainline.mainlineSummary.sections.map((item) => ({
              key: item?.key || null,
              cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
            }))
          : []
      }
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineSections)
        ? actionResult.receipt.mainlineSections.map((item) => ({
            key: item?.key || null,
            cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
          }))
        : [],
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.sections)
        ? actionResult.launchMainline.mainlineSummary.sections.map((item) => ({
            key: item?.key || null,
            cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
          }))
        : []
    );
    assert.deepEqual(
      {
        heroControls: Array.isArray(actionResult.receipt?.mainlineScreen?.heroControls)
          ? actionResult.receipt.mainlineScreen.heroControls.map((item) => ({
              kind: item?.kind || null,
              key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
            }))
          : [],
        sections: Array.isArray(actionResult.receipt?.mainlineScreen?.sections)
          ? actionResult.receipt.mainlineScreen.sections.map((item) => ({
              key: item?.key || null,
              cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
            }))
          : []
      },
      {
        heroControls: Array.isArray(actionResult.launchMainline?.mainlineSummary?.screen?.heroControls)
          ? actionResult.launchMainline.mainlineSummary.screen.heroControls.map((item) => ({
              kind: item?.kind || null,
              key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
            }))
          : [],
        sections: Array.isArray(actionResult.launchMainline?.mainlineSummary?.screen?.sections)
          ? actionResult.launchMainline.mainlineSummary.screen.sections.map((item) => ({
              key: item?.key || null,
              cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
            }))
          : []
      }
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineRecapCards)
        ? actionResult.receipt.mainlineRecapCards.filter((item) =>
            item?.key !== "first_launch_duty_summary"
          ).map((item) => ({
            key: item?.key || null,
            controls: Array.isArray(item?.controls)
              ? item.controls.map((control) => ({
                  kind: control?.kind || null,
                  key:
                    control?.workspaceAction?.key
                    || control?.recommendedDownload?.key
                    || control?.bootstrapAction?.key
                    || control?.setupAction?.key
                    || null
                }))
              : []
          }))
        : [],
      [
        { key: "result_status", controls: [] },
        {
          key: "mainline_status",
          controls: Array.isArray(actionResult.receipt?.mainlineFollowUpActions)
            ? actionResult.receipt.mainlineFollowUpActions.map((item) => ({
                kind: item?.kind || null,
                key: item?.workspaceAction?.key || item?.recommendedDownload?.key || item?.bootstrapAction?.key || item?.setupAction?.key || null
              }))
            : []
        },
        { key: "transition_summary", controls: [] }
      ]
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineFollowUpCards)
        ? actionResult.receipt.mainlineFollowUpCards.map((item) => ({
            key: item?.key || null,
            controls: Array.isArray(item?.controls)
              ? item.controls.map((control) => ({
                  kind: control?.kind || null,
                  key:
                    control?.workspaceAction?.key
                    || control?.recommendedDownload?.key
                    || control?.bootstrapAction?.key
                    || control?.setupAction?.key
                    || null
                }))
              : []
          }))
        : [],
      Array.isArray(actionResult.receipt?.mainlineActions)
        ? actionResult.receipt.mainlineActions.map((item) => ({
            key: item?.key || null,
            controls: Array.isArray(item?.controls)
              ? item.controls.map((control) => ({
                  kind: control?.kind || null,
                  key:
                    control?.workspaceAction?.key
                    || control?.recommendedDownload?.key
                    || control?.bootstrapAction?.key
                    || control?.setupAction?.key
                    || null
                }))
              : []
          }))
        : []
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineLastActionScreen?.sections)
        ? actionResult.receipt.mainlineLastActionScreen.sections.map((item) => ({
            key: item?.key || null,
            cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
          }))
        : [],
      [
        {
          key: "recap",
          cards: Array.isArray(actionResult.receipt?.mainlineRecapCards)
            ? actionResult.receipt.mainlineRecapCards.map((item) => item?.key || null)
            : []
        },
        ...(actionResult.receipt?.firstLaunchInventoryQueue
          ? [
              {
                key: "first_launch_inventory_queue",
                cards: [
                  "first_launch_inventory_progress",
                  "first_launch_inventory_next_action",
                  ...actionResult.receipt.firstLaunchInventoryQueue.createdBatches.map((item) => `first_launch_batch_${item.key}`)
                ]
              }
            ]
          : []),
        ...(actionResult.receipt?.firstLaunchOpsQueue
          ? [
              {
                key: "first_launch_ops_queue",
                cards: [
                  "first_launch_ops_progress",
                  ...actionResult.receipt.firstLaunchOpsQueue.actions.map((item) => `first_launch_ops_${item.key}`)
                ]
              }
            ]
          : []),
        ...(actionResult.receipt?.firstLaunchOpsQueue?.handoffChecklist
          ? [
              {
                key: "first_launch_handoff_checklist",
                cards: [
                  "first_launch_handoff_summary",
                  ...actionResult.receipt.firstLaunchOpsQueue.handoffChecklist.map((item) => item?.key || null)
                ]
              }
            ]
          : []),
        {
          key: "follow_up",
          cards: Array.isArray(actionResult.receipt?.mainlineFollowUpCards)
            ? actionResult.receipt.mainlineFollowUpCards.map((item) => item?.key || null)
            : []
        }
      ]
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineLastActionScreen?.sections)
        ? actionResult.receipt.mainlineLastActionScreen.sections.flatMap((section) =>
            Array.isArray(section?.cards)
              ? section.cards.flatMap((card) =>
                  Array.isArray(card?.controls)
                    ? card.controls.flatMap((control) => {
                        if (control?.workspaceAction?.key && !/^\/developer\//.test(String(control.workspaceAction.href || ""))) {
                          return [`workspace:${section?.key || "?"}:${card?.key || "?"}:${control.workspaceAction.key}`];
                        }
                        if (control?.recommendedDownload?.key && !/^\/api\/developer\//.test(String(control.recommendedDownload.href || ""))) {
                          return [`download:${section?.key || "?"}:${card?.key || "?"}:${control.recommendedDownload.key}`];
                        }
                        return [];
                      })
                    : []
                )
              : []
          )
        : [],
      []
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineHeroControls)
        ? actionResult.receipt.mainlineHeroControls.map((item) => ({
            kind: item?.kind || null,
            key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
          }))
        : [],
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.heroControls)
        ? actionResult.launchMainline.mainlineSummary.heroControls.map((item) => ({
            kind: item?.kind || null,
            key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
          }))
        : []
    );
    assert.deepEqual(
      {
        heroControls: Array.isArray(actionResult.receipt?.mainlineView?.heroControls)
          ? actionResult.receipt.mainlineView.heroControls.map((item) => ({
              kind: item?.kind || null,
              key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
            }))
          : [],
        form: actionResult.receipt?.mainlineView?.form
          ? {
              productCode: actionResult.receipt.mainlineView.form.productCode || null,
              channel: actionResult.receipt.mainlineView.form.channel || null,
              reviewMode: actionResult.receipt.mainlineView.form.reviewMode || null
            }
          : null,
        routeFocus: actionResult.receipt?.mainlineView?.routeFocus
          ? {
              title: actionResult.receipt.mainlineView.routeFocus.title || null,
              summary: actionResult.receipt.mainlineView.routeFocus.summary || null
            }
          : null,
        sections: Array.isArray(actionResult.receipt?.mainlineView?.sections)
          ? actionResult.receipt.mainlineView.sections.map((item) => ({
              key: item?.key || null,
              cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
            }))
          : [],
        lastAction: Array.isArray(actionResult.receipt?.mainlineView?.lastActionScreen?.sections)
          ? actionResult.receipt.mainlineView.lastActionScreen.sections.map((item) => ({
              key: item?.key || null,
              cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
            }))
          : []
      },
      {
        heroControls: Array.isArray(actionResult.receipt?.mainlinePage?.heroControls)
          ? actionResult.receipt.mainlinePage.heroControls.map((item) => ({
              kind: item?.kind || null,
              key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
            }))
          : [],
        form: actionResult.receipt?.mainlinePage?.form
          ? {
              productCode: actionResult.receipt.mainlinePage.form.productCode || null,
              channel: actionResult.receipt.mainlinePage.form.channel || null,
              reviewMode: actionResult.receipt.mainlinePage.form.reviewMode || null
            }
          : null,
        routeFocus: actionResult.receipt?.mainlinePage?.routeFocus
          ? {
              title: actionResult.receipt.mainlinePage.routeFocus.title || null,
              summary: actionResult.receipt.mainlinePage.routeFocus.summary || null
            }
          : null,
        sections: Array.isArray(actionResult.receipt?.mainlinePage?.sections)
          ? actionResult.receipt.mainlinePage.sections.map((item) => ({
              key: item?.key || null,
              cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
            }))
          : [],
        lastAction: Array.isArray(actionResult.receipt?.mainlinePage?.lastActionScreen?.sections)
          ? actionResult.receipt.mainlinePage.lastActionScreen.sections.map((item) => ({
              key: item?.key || null,
              cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
            }))
          : []
      }
    );
    assert.equal(actionResult.receipt?.mainlinePage?.summaryText, actionResult.launchMainline?.summaryText || "");
    assert.equal(actionResult.receipt?.mainlinePage?.form?.productCode, "MAINLINE_SETUP");
    assert.equal(actionResult.receipt?.mainlinePage?.form?.channel, "stable");
    assert.equal(actionResult.receipt?.mainlinePage?.form?.reviewMode, "matched");
    assert.equal(typeof actionResult.receipt?.mainlinePage?.routeFocus?.title, "string");
    assert.equal(typeof actionResult.receipt?.mainlinePage?.routeFocus?.summary, "string");
    assert.deepEqual(
      {
        heroControls: Array.isArray(actionResult.launchMainline?.mainlineSummary?.mainlinePage?.heroControls)
          ? actionResult.launchMainline.mainlineSummary.mainlinePage.heroControls.map((item) => ({
              kind: item?.kind || null,
              key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
            }))
          : [],
        form: actionResult.launchMainline?.mainlineSummary?.mainlinePage?.form
          ? {
              productCode: actionResult.launchMainline.mainlineSummary.mainlinePage.form.productCode || null,
              channel: actionResult.launchMainline.mainlineSummary.mainlinePage.form.channel || null,
              reviewMode: actionResult.launchMainline.mainlineSummary.mainlinePage.form.reviewMode || null
            }
          : null,
        routeFocus: actionResult.launchMainline?.mainlineSummary?.mainlinePage?.routeFocus
          ? {
              title: actionResult.launchMainline.mainlineSummary.mainlinePage.routeFocus.title || null,
              summary: actionResult.launchMainline.mainlineSummary.mainlinePage.routeFocus.summary || null
            }
          : null,
        sections: Array.isArray(actionResult.launchMainline?.mainlineSummary?.mainlinePage?.sections)
          ? actionResult.launchMainline.mainlineSummary.mainlinePage.sections.map((item) => ({
              key: item?.key || null,
              cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
            }))
          : [],
        lastAction: Array.isArray(actionResult.launchMainline?.mainlineSummary?.mainlinePage?.lastActionScreen?.sections)
          ? actionResult.launchMainline.mainlineSummary.mainlinePage.lastActionScreen.sections.map((item) => ({
              key: item?.key || null,
              cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
            }))
          : []
      },
      {
        heroControls: Array.isArray(actionResult.launchMainline?.mainlineSummary?.heroControls)
          ? actionResult.launchMainline.mainlineSummary.heroControls.map((item) => ({
              kind: item?.kind || null,
              key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
            }))
          : [],
        form: actionResult.launchMainline?.mainlineSummary?.form
          ? {
              productCode: actionResult.launchMainline.mainlineSummary.form.productCode || null,
              channel: actionResult.launchMainline.mainlineSummary.form.channel || null,
              reviewMode: actionResult.launchMainline.mainlineSummary.form.reviewMode || null
            }
          : null,
        routeFocus: actionResult.launchMainline?.mainlineSummary?.routeFocus
          ? {
              title: actionResult.launchMainline.mainlineSummary.routeFocus.title || null,
              summary: actionResult.launchMainline.mainlineSummary.routeFocus.summary || null
            }
          : null,
        sections: Array.isArray(actionResult.launchMainline?.mainlineSummary?.sections)
          ? actionResult.launchMainline.mainlineSummary.sections.map((item) => ({
              key: item?.key || null,
              cards: Array.isArray(item?.cards) ? item.cards.map((card) => card?.key || null) : []
            }))
          : [],
        lastAction: []
      }
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineWorkspaceActions)
        ? actionResult.receipt.mainlineWorkspaceActions.map((item) => item?.key || null)
        : [],
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.workspaceActions)
        ? actionResult.launchMainline.mainlineSummary.workspaceActions.slice(0, 5).map((item) => item?.key || null)
        : []
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineRecommendedDownloads)
        ? actionResult.receipt.mainlineRecommendedDownloads.map((item) => item?.key || null)
        : [],
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.recommendedDownloads)
        ? actionResult.launchMainline.mainlineSummary.recommendedDownloads.slice(0, 6).map((item) => item?.key || null)
        : []
    );
    assert.ok(
      actionResult.receipt?.mainlineRecommendedDownloads?.findIndex((item) => item?.key === "launch_mainline_rehearsal_guide")
      < actionResult.receipt?.mainlineRecommendedDownloads?.findIndex((item) => item?.key === "launch_mainline_summary")
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineActions) ? actionResult.receipt.mainlineActions.map((item) => item?.key || null) : [],
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.actionPlan) ? actionResult.launchMainline.mainlineSummary.actionPlan.slice(0, 4).map((item) => item?.key || null) : []
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineActions)
        ? actionResult.receipt.mainlineActions.map((item) =>
            Array.isArray(item?.controls)
              ? item.controls.map((control) => ({
                  kind: control?.kind || null,
                  key:
                    control?.workspaceAction?.key
                    || control?.recommendedDownload?.key
                    || control?.bootstrapAction?.key
                    || control?.setupAction?.key
                    || null
                }))
              : []
          )
        : [],
      Array.isArray(actionResult.launchMainline?.mainlineSummary?.actionPlan)
        ? actionResult.launchMainline.mainlineSummary.actionPlan.slice(0, 4).map((item) => [
            item?.workspaceAction?.key ? { kind: "workspace", key: item.workspaceAction.key } : null,
            item?.recommendedDownload?.key ? { kind: "download", key: item.recommendedDownload.key } : null,
            item?.bootstrapAction?.key ? { kind: "bootstrap", key: item.bootstrapAction.key } : null,
            item?.setupAction?.key ? { kind: "setup", key: item.setupAction.key } : null
          ].filter(Boolean))
        : []
    );
    assert.deepEqual(
      Array.isArray(actionResult.receipt?.mainlineFollowUpActions)
        ? actionResult.receipt.mainlineFollowUpActions.map((item) => ({
            kind: item?.kind || null,
            key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
          }))
        : [],
      [
        ...(Array.isArray(actionResult.receipt?.mainlineContinuationActions) ? actionResult.receipt.mainlineContinuationActions : []),
        ...(Array.isArray(actionResult.receipt?.mainlineHeroControls)
          ? actionResult.receipt.mainlineHeroControls.map((item) => ({
              kind: item?.kind || null,
              workspaceAction: item?.workspaceAction || null,
              recommendedDownload: item?.recommendedDownload || null
            }))
          : [])
      ]
        .map((item) => ({
          kind: item?.kind || null,
          key: item?.workspaceAction?.key || item?.recommendedDownload?.key || null
        }))
        .filter((item) => item.key)
    );
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer accounts can change password, logout, and be disabled by admin", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const developer = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "lifecycle.dev",
        password: "LifeCycle123!",
        displayName: "Lifecycle Dev"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "LIFECYCLE_APP",
        name: "Lifecycle App",
        ownerDeveloperId: developer.id
      },
      adminSession.token
    );

    const firstLogin = await postJson(baseUrl, "/api/developer/login", {
      username: "lifecycle.dev",
      password: "LifeCycle123!"
    });
    assert.ok(firstLogin.token);

    const changed = await postJson(
      baseUrl,
      "/api/developer/change-password",
      {
        currentPassword: "LifeCycle123!",
        newPassword: "LifeCycle456!"
      },
      firstLogin.token
    );
    assert.equal(changed.status, "password_changed");
    assert.ok(changed.revokedSessions >= 1);

    const meAfterPasswordChange = await getJsonExpectError(baseUrl, "/api/developer/me", firstLogin.token);
    assert.equal(meAfterPasswordChange.status, 401);
    assert.equal(meAfterPasswordChange.error.code, "DEVELOPER_AUTH_INVALID");

    const oldPasswordLogin = await postJsonExpectError(
      baseUrl,
      "/api/developer/login",
      {
        username: "lifecycle.dev",
        password: "LifeCycle123!"
      }
    );
    assert.equal(oldPasswordLogin.status, 401);
    assert.equal(oldPasswordLogin.error.code, "DEVELOPER_LOGIN_FAILED");

    const secondLogin = await postJson(baseUrl, "/api/developer/login", {
      username: "lifecycle.dev",
      password: "LifeCycle456!"
    });
    assert.ok(secondLogin.token);

    const logoutResult = await postJson(baseUrl, "/api/developer/logout", {}, secondLogin.token);
    assert.equal(logoutResult.status, "logged_out");

    const meAfterLogout = await getJsonExpectError(baseUrl, "/api/developer/me", secondLogin.token);
    assert.equal(meAfterLogout.status, 401);
    assert.equal(meAfterLogout.error.code, "DEVELOPER_AUTH_INVALID");

    const thirdLogin = await postJson(baseUrl, "/api/developer/login", {
      username: "lifecycle.dev",
      password: "LifeCycle456!"
    });
    assert.ok(thirdLogin.token);

    const disabledDeveloper = await postJson(
      baseUrl,
      `/api/admin/developers/${developer.id}/status`,
      {
        status: "disabled"
      },
      adminSession.token
    );
    assert.equal(disabledDeveloper.status, "disabled");

    const projectsAfterDisable = await getJsonExpectError(baseUrl, "/api/developer/products", thirdLogin.token);
    assert.equal(projectsAfterDisable.status, 401);
    assert.equal(projectsAfterDisable.error.code, "DEVELOPER_AUTH_INVALID");

    const disabledLogin = await postJsonExpectError(
      baseUrl,
      "/api/developer/login",
      {
        username: "lifecycle.dev",
        password: "LifeCycle456!"
      }
    );
    assert.equal(disabledLogin.status, 403);
    assert.equal(disabledLogin.error.code, "DEVELOPER_LOGIN_DISABLED");

    const reenabledDeveloper = await postJson(
      baseUrl,
      `/api/admin/developers/${developer.id}/status`,
      {
        status: "active"
      },
      adminSession.token
    );
    assert.equal(reenabledDeveloper.status, "active");

    const fourthLogin = await postJson(baseUrl, "/api/developer/login", {
      username: "lifecycle.dev",
      password: "LifeCycle456!"
    });
    assert.ok(fourthLogin.token);

    const meAfterReenable = await getJson(baseUrl, "/api/developer/me", fourthLogin.token);
    assert.equal(meAfterReenable.developer.username, "lifecycle.dev");

    const auditLogs = await getJson(baseUrl, "/api/admin/audit-logs?limit=80", adminSession.token);
    const eventTypes = auditLogs.items.map((entry) => entry.event_type);
    assert.ok(eventTypes.includes("developer.password.change"));
    assert.ok(eventTypes.includes("developer.logout"));
    assert.ok(eventTypes.includes("developer.status"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer owners can manage scoped team members with project roles", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "owner.team",
        password: "OwnerTeam123!",
        displayName: "Owner Team"
      },
      adminSession.token
    );

    const alphaProduct = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "TEAM_ALPHA",
        name: "Team Alpha",
        ownerDeveloperId: owner.id
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "TEAM_BETA",
        name: "Team Beta",
        ownerDeveloperId: owner.id
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "owner.team",
      password: "OwnerTeam123!"
    });
    assert.equal(ownerSession.actor.type, "owner");

    const ownerProfile = await postJson(
      baseUrl,
      "/api/developer/profile",
      {
        displayName: "Owner Prime"
      },
      ownerSession.token
    );
    assert.equal(ownerProfile.status, "profile_updated");

    const ownerMe = await getJson(baseUrl, "/api/developer/me", ownerSession.token);
    assert.equal(ownerMe.developer.displayName, "Owner Prime");
    assert.equal(ownerMe.actor.type, "owner");

    const alphaPolicy = await postJson(
      baseUrl,
      "/api/developer/policies",
      {
        productCode: "TEAM_ALPHA",
        name: "Alpha Policy",
        durationDays: 30,
        maxDevices: 1
      },
      ownerSession.token
    );

    const betaPolicy = await postJson(
      baseUrl,
      "/api/developer/policies",
      {
        productCode: "TEAM_BETA",
        name: "Beta Policy",
        durationDays: 30,
        maxDevices: 1
      },
      ownerSession.token
    );

    const member = await postJson(
      baseUrl,
      "/api/developer/members",
      {
        username: "ops.member",
        password: "OpsMember123!",
        displayName: "Ops Member",
        role: "operator",
        productCodes: ["TEAM_ALPHA"]
      },
      ownerSession.token
    );
    assert.equal(member.role, "operator");
    assert.equal(member.productAccess.length, 1);
    assert.equal(member.productAccess[0].productCode, "TEAM_ALPHA");

    const memberList = await getJson(baseUrl, "/api/developer/members", ownerSession.token);
    assert.equal(memberList.total, 1);
    assert.equal(memberList.items[0].username, "ops.member");

    const memberLogin = await postJson(baseUrl, "/api/developer/login", {
      username: "ops.member",
      password: "OpsMember123!"
    });
    assert.equal(memberLogin.actor.type, "member");
    assert.equal(memberLogin.actor.role, "operator");

    const memberMe = await getJson(baseUrl, "/api/developer/me", memberLogin.token);
    assert.equal(memberMe.actor.type, "member");
    assert.equal(memberMe.actor.role, "operator");
    assert.equal(memberMe.developer.username, "owner.team");

    const memberProjects = await getJson(baseUrl, "/api/developer/products", memberLogin.token);
    assert.equal(memberProjects.length, 1);
    assert.equal(memberProjects[0].code, "TEAM_ALPHA");

    const memberBatch = await postJson(
      baseUrl,
      "/api/developer/cards/batch",
      {
        productCode: "TEAM_ALPHA",
        policyId: alphaPolicy.id,
        count: 1,
        prefix: "TEAMOP"
      },
      memberLogin.token
    );
    assert.equal(memberBatch.count, 1);

    const forbiddenBatch = await postJsonExpectError(
      baseUrl,
      "/api/developer/cards/batch",
      {
        productCode: "TEAM_BETA",
        policyId: betaPolicy.id,
        count: 1,
        prefix: "TEAMOP"
      },
      memberLogin.token
    );
    assert.equal(forbiddenBatch.status, 403);
    assert.equal(forbiddenBatch.error.code, "DEVELOPER_PRODUCT_FORBIDDEN");

    const forbiddenFeature = await postJsonExpectError(
      baseUrl,
      `/api/developer/products/${alphaProduct.id}/feature-config`,
      {
        allowNotices: false
      },
      memberLogin.token
    );
    assert.equal(forbiddenFeature.status, 403);
    assert.equal(forbiddenFeature.error.code, "DEVELOPER_PRODUCT_FORBIDDEN");

    const elevatedMember = await postJson(
      baseUrl,
      `/api/developer/members/${member.id}`,
      {
        role: "admin",
        productCodes: ["TEAM_ALPHA", "TEAM_BETA"]
      },
      ownerSession.token
    );
    assert.equal(elevatedMember.role, "admin");
    assert.equal(elevatedMember.productAccess.length, 2);

    const memberProjectsAfterGrant = await getJson(baseUrl, "/api/developer/products", memberLogin.token);
    assert.equal(memberProjectsAfterGrant.length, 2);

    const featureSaved = await postJson(
      baseUrl,
      `/api/developer/products/${alphaProduct.id}/feature-config`,
      {
        allowNotices: false,
        allowVersionCheck: false
      },
      memberLogin.token
    );
    assert.equal(featureSaved.featureConfig.allowNotices, false);
    assert.equal(featureSaved.featureConfig.allowVersionCheck, false);

    const disabledMember = await postJson(
      baseUrl,
      `/api/developer/members/${member.id}`,
      {
        status: "disabled"
      },
      ownerSession.token
    );
    assert.equal(disabledMember.status, "disabled");
    assert.ok(disabledMember.revokedSessions >= 1);

    const memberAfterDisable = await getJsonExpectError(baseUrl, "/api/developer/products", memberLogin.token);
    assert.equal(memberAfterDisable.status, 401);
    assert.equal(memberAfterDisable.error.code, "DEVELOPER_AUTH_INVALID");

    const disabledMemberLogin = await postJsonExpectError(
      baseUrl,
      "/api/developer/login",
      {
        username: "ops.member",
        password: "OpsMember123!"
      }
    );
    assert.equal(disabledMemberLogin.status, 403);
    assert.equal(disabledMemberLogin.error.code, "DEVELOPER_MEMBER_LOGIN_DISABLED");

    const auditLogs = await getJson(baseUrl, "/api/admin/audit-logs?limit=120", adminSession.token);
    const eventTypes = auditLogs.items.map((entry) => entry.event_type);
    assert.ok(eventTypes.includes("developer.profile.update"));
    assert.ok(eventTypes.includes("developer-member.create"));
    assert.ok(eventTypes.includes("developer-member.update"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer operators can manage scoped authorization operations for assigned projects", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "scope.owner",
        password: "ScopeOwner123!",
        displayName: "Scope Owner"
      },
      adminSession.token
    );

    const alphaProduct = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "DEV_ALPHA",
        name: "Developer Alpha",
        ownerDeveloperId: owner.id
      },
      adminSession.token
    );

    const betaProduct = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "DEV_BETA",
        name: "Developer Beta",
        ownerDeveloperId: owner.id
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "scope.owner",
      password: "ScopeOwner123!"
    });

    const alphaDurationPolicy = await postJson(
      baseUrl,
      "/api/developer/policies",
      {
        productCode: "DEV_ALPHA",
        name: "Alpha Duration",
        durationDays: 30,
        maxDevices: 1
      },
      ownerSession.token
    );

    const alphaPointsPolicy = await postJson(
      baseUrl,
      "/api/developer/policies",
      {
        productCode: "DEV_ALPHA",
        name: "Alpha Points",
        grantType: "points",
        grantPoints: 3,
        durationDays: 0,
        maxDevices: 1
      },
      ownerSession.token
    );

    const betaPolicy = await postJson(
      baseUrl,
      "/api/developer/policies",
      {
        productCode: "DEV_BETA",
        name: "Beta Duration",
        durationDays: 30,
        maxDevices: 1
      },
      ownerSession.token
    );

    const alphaDurationCards = await postJson(
      baseUrl,
      "/api/developer/cards/batch",
      {
        productCode: "DEV_ALPHA",
        policyId: alphaDurationPolicy.id,
        count: 1,
        prefix: "ADURA"
      },
      ownerSession.token
    );

    const alphaPointsCards = await postJson(
      baseUrl,
      "/api/developer/cards/batch",
      {
        productCode: "DEV_ALPHA",
        policyId: alphaPointsPolicy.id,
        count: 1,
        prefix: "APOINT"
      },
      ownerSession.token
    );

    const betaCards = await postJson(
      baseUrl,
      "/api/developer/cards/batch",
      {
        productCode: "DEV_BETA",
        policyId: betaPolicy.id,
        count: 1,
        prefix: "BDURA"
      },
      ownerSession.token
    );

    await signedClientPost(baseUrl, "/api/client/register", alphaProduct.sdkAppId, alphaProduct.sdkAppSecret, {
      productCode: "DEV_ALPHA",
      username: "alphauser",
      password: "AlphaUser123!"
    });

    await signedClientPost(baseUrl, "/api/client/register", alphaProduct.sdkAppId, alphaProduct.sdkAppSecret, {
      productCode: "DEV_ALPHA",
      username: "alphapoints",
      password: "AlphaPoints123!"
    });

    await signedClientPost(baseUrl, "/api/client/register", betaProduct.sdkAppId, betaProduct.sdkAppSecret, {
      productCode: "DEV_BETA",
      username: "betauser",
      password: "BetaUser123!"
    });

    await signedClientPost(baseUrl, "/api/client/recharge", alphaProduct.sdkAppId, alphaProduct.sdkAppSecret, {
      productCode: "DEV_ALPHA",
      username: "alphauser",
      password: "AlphaUser123!",
      cardKey: alphaDurationCards.keys[0]
    });

    await signedClientPost(baseUrl, "/api/client/recharge", alphaProduct.sdkAppId, alphaProduct.sdkAppSecret, {
      productCode: "DEV_ALPHA",
      username: "alphapoints",
      password: "AlphaPoints123!",
      cardKey: alphaPointsCards.keys[0]
    });

    await signedClientPost(baseUrl, "/api/client/recharge", betaProduct.sdkAppId, betaProduct.sdkAppSecret, {
      productCode: "DEV_BETA",
      username: "betauser",
      password: "BetaUser123!",
      cardKey: betaCards.keys[0]
    });

    const alphaLogin = await signedClientPost(
      baseUrl,
      "/api/client/login",
      alphaProduct.sdkAppId,
      alphaProduct.sdkAppSecret,
      {
        productCode: "DEV_ALPHA",
        username: "alphauser",
        password: "AlphaUser123!",
        deviceFingerprint: "alpha-scope-device-001",
        deviceName: "Alpha Scope Desktop"
      }
    );

    await signedClientPost(
      baseUrl,
      "/api/client/login",
      betaProduct.sdkAppId,
      betaProduct.sdkAppSecret,
      {
        productCode: "DEV_BETA",
        username: "betauser",
        password: "BetaUser123!",
        deviceFingerprint: "beta-scope-device-001",
        deviceName: "Beta Scope Desktop"
      }
    );

    const alphaAccounts = await getJson(baseUrl, "/api/admin/accounts?productCode=DEV_ALPHA", adminSession.token);
    const betaAccounts = await getJson(baseUrl, "/api/admin/accounts?productCode=DEV_BETA", adminSession.token);
    const alphaDurationAccount = alphaAccounts.items.find((item) => item.username === "alphauser");
    const alphaPointsAccount = alphaAccounts.items.find((item) => item.username === "alphapoints");
    const betaAccount = betaAccounts.items.find((item) => item.username === "betauser");
    assert.ok(alphaDurationAccount);
    assert.ok(alphaPointsAccount);
    assert.ok(betaAccount);

    const alphaDurationEntitlements = await getJson(
      baseUrl,
      "/api/admin/entitlements?productCode=DEV_ALPHA&username=alphauser",
      adminSession.token
    );
    const alphaPointsEntitlements = await getJson(
      baseUrl,
      "/api/admin/entitlements?productCode=DEV_ALPHA&username=alphapoints",
      adminSession.token
    );
    const alphaDurationEntitlement = alphaDurationEntitlements.items[0];
    const alphaPointsEntitlement = alphaPointsEntitlements.items[0];
    assert.equal(alphaDurationEntitlement.grantType, "duration");
    assert.equal(alphaPointsEntitlement.grantType, "points");

    const member = await postJson(
      baseUrl,
      "/api/developer/members",
      {
        username: "scope.operator",
        password: "ScopeOperator123!",
        displayName: "Scoped Operator",
        role: "operator",
        productCodes: ["DEV_ALPHA"]
      },
      ownerSession.token
    );
    assert.equal(member.role, "operator");

    const memberSession = await postJson(baseUrl, "/api/developer/login", {
      username: "scope.operator",
      password: "ScopeOperator123!"
    });

    const scopedAccounts = await getJson(baseUrl, "/api/developer/accounts", memberSession.token);
    assert.equal(scopedAccounts.total, 2);
    assert.deepEqual(
      scopedAccounts.items.map((item) => item.username).sort(),
      ["alphapoints", "alphauser"]
    );

    const scopedEntitlements = await getJson(baseUrl, "/api/developer/entitlements", memberSession.token);
    assert.equal(scopedEntitlements.total, 2);
    assert.deepEqual(
      scopedEntitlements.items.map((item) => item.grantType).sort(),
      ["duration", "points"]
    );

    const scopedSessions = await getJson(baseUrl, "/api/developer/sessions", memberSession.token);
    assert.equal(scopedSessions.total, 1);
    assert.equal(scopedSessions.items[0].username, "alphauser");
    assert.equal(scopedSessions.items[0].product_code, "DEV_ALPHA");

    const scopedBindings = await getJson(baseUrl, "/api/developer/device-bindings", memberSession.token);
    assert.equal(scopedBindings.total, 1);
    assert.equal(scopedBindings.items[0].product_code, "DEV_ALPHA");

    const betaForbidden = await postJsonExpectError(
      baseUrl,
      `/api/developer/accounts/${betaAccount.id}/status`,
      { status: "disabled" },
      memberSession.token
    );
    assert.equal(betaForbidden.status, 403);
    assert.equal(betaForbidden.error.code, "DEVELOPER_OPS_FORBIDDEN");

    const disabledAccount = await postJson(
      baseUrl,
      `/api/developer/accounts/${alphaDurationAccount.id}/status`,
      { status: "disabled" },
      memberSession.token
    );
    assert.equal(disabledAccount.status, "disabled");
    assert.equal(disabledAccount.changed, true);
    assert.ok(disabledAccount.revokedSessions >= 1);

    const disabledHeartbeat = await signedClientPostExpectError(
      baseUrl,
      "/api/client/heartbeat",
      alphaProduct.sdkAppId,
      alphaProduct.sdkAppSecret,
      {
        productCode: "DEV_ALPHA",
        sessionToken: alphaLogin.sessionToken,
        deviceFingerprint: "alpha-scope-device-001"
      }
    );
    assert.equal(disabledHeartbeat.status, 401);
    assert.equal(disabledHeartbeat.error.code, "SESSION_INVALID");

    const enabledAccount = await postJson(
      baseUrl,
      `/api/developer/accounts/${alphaDurationAccount.id}/status`,
      { status: "active" },
      memberSession.token
    );
    assert.equal(enabledAccount.status, "active");

    const reloginAfterAccountEnable = await signedClientPost(
      baseUrl,
      "/api/client/login",
      alphaProduct.sdkAppId,
      alphaProduct.sdkAppSecret,
      {
        productCode: "DEV_ALPHA",
        username: "alphauser",
        password: "AlphaUser123!",
        deviceFingerprint: "alpha-scope-device-001",
        deviceName: "Alpha Scope Desktop"
      }
    );
    assert.ok(reloginAfterAccountEnable.sessionToken);

    const frozenEntitlement = await postJson(
      baseUrl,
      `/api/developer/entitlements/${alphaDurationEntitlement.id}/status`,
      { status: "frozen" },
      memberSession.token
    );
    assert.equal(frozenEntitlement.status, "frozen");
    assert.ok(frozenEntitlement.revokedSessions >= 1);

    const frozenHeartbeat = await signedClientPostExpectError(
      baseUrl,
      "/api/client/heartbeat",
      alphaProduct.sdkAppId,
      alphaProduct.sdkAppSecret,
      {
        productCode: "DEV_ALPHA",
        sessionToken: reloginAfterAccountEnable.sessionToken,
        deviceFingerprint: "alpha-scope-device-001"
      }
    );
    assert.equal(frozenHeartbeat.status, 401);
    assert.equal(frozenHeartbeat.error.code, "SESSION_INVALID");

    const reactivatedEntitlement = await postJson(
      baseUrl,
      `/api/developer/entitlements/${alphaDurationEntitlement.id}/status`,
      { status: "active" },
      memberSession.token
    );
    assert.equal(reactivatedEntitlement.status, "active");

    const extendedEntitlement = await postJson(
      baseUrl,
      `/api/developer/entitlements/${alphaDurationEntitlement.id}/extend`,
      { days: 5 },
      memberSession.token
    );
    assert.equal(extendedEntitlement.addedDays, 5);
    assert.ok(new Date(extendedEntitlement.endsAt).getTime() > new Date(alphaDurationEntitlement.endsAt).getTime());

    const adjustedPoints = await postJson(
      baseUrl,
      `/api/developer/entitlements/${alphaPointsEntitlement.id}/points`,
      { mode: "add", points: 2 },
      memberSession.token
    );
    assert.equal(adjustedPoints.mode, "add");
    assert.ok(adjustedPoints.current.remainingPoints >= 5);

    const reloginForSession = await signedClientPost(
      baseUrl,
      "/api/client/login",
      alphaProduct.sdkAppId,
      alphaProduct.sdkAppSecret,
      {
        productCode: "DEV_ALPHA",
        username: "alphauser",
        password: "AlphaUser123!",
        deviceFingerprint: "alpha-scope-device-001",
        deviceName: "Alpha Scope Desktop"
      }
    );

    const refreshedSessions = await getJson(
      baseUrl,
      "/api/developer/sessions?status=active",
      memberSession.token
    );
    assert.equal(refreshedSessions.total, 1);

    const revokedSession = await postJson(
      baseUrl,
      `/api/developer/sessions/${refreshedSessions.items[0].id}/revoke`,
      { reason: "scoped_operator_revoked" },
      memberSession.token
    );
    assert.equal(revokedSession.status, "expired");
    assert.equal(revokedSession.revokedReason, "scoped_operator_revoked");

    const revokedHeartbeat = await signedClientPostExpectError(
      baseUrl,
      "/api/client/heartbeat",
      alphaProduct.sdkAppId,
      alphaProduct.sdkAppSecret,
      {
        productCode: "DEV_ALPHA",
        sessionToken: reloginForSession.sessionToken,
        deviceFingerprint: "alpha-scope-device-001"
      }
    );
    assert.equal(revokedHeartbeat.status, 401);
    assert.equal(revokedHeartbeat.error.code, "SESSION_INVALID");

    const refreshedBindings = await getJson(baseUrl, "/api/developer/device-bindings", memberSession.token);
    assert.equal(refreshedBindings.total, 1);

    const releasedBinding = await postJson(
      baseUrl,
      `/api/developer/device-bindings/${refreshedBindings.items[0].id}/release`,
      { reason: "scoped_operator_released" },
      memberSession.token
    );
    assert.equal(releasedBinding.status, "revoked");
    assert.equal(releasedBinding.reason, "scoped_operator_released");

    const reloginForBlock = await signedClientPost(
      baseUrl,
      "/api/client/login",
      alphaProduct.sdkAppId,
      alphaProduct.sdkAppSecret,
      {
        productCode: "DEV_ALPHA",
        username: "alphauser",
        password: "AlphaUser123!",
        deviceFingerprint: "alpha-scope-device-001",
        deviceName: "Alpha Scope Desktop"
      }
    );
    assert.ok(reloginForBlock.sessionToken);

    const blockedDevice = await postJson(
      baseUrl,
      "/api/developer/device-blocks",
      {
        projectCode: "DEV_ALPHA",
        deviceFingerprint: "alpha-scope-device-001",
        reason: "member_device_block"
      },
      memberSession.token
    );
    assert.equal(blockedDevice.status, "active");
    assert.ok(blockedDevice.affectedSessions >= 1);

    const blockedHeartbeat = await signedClientPostExpectError(
      baseUrl,
      "/api/client/heartbeat",
      alphaProduct.sdkAppId,
      alphaProduct.sdkAppSecret,
      {
        productCode: "DEV_ALPHA",
        sessionToken: reloginForBlock.sessionToken,
        deviceFingerprint: "alpha-scope-device-001"
      }
    );
    assert.equal(blockedHeartbeat.status, 401);
    assert.equal(blockedHeartbeat.error.code, "SESSION_INVALID");

    const scopedBlocks = await getJson(baseUrl, "/api/developer/device-blocks", memberSession.token);
    assert.equal(scopedBlocks.total, 1);
    assert.equal(scopedBlocks.items[0].fingerprint, "alpha-scope-device-001");

    const unblockedDevice = await postJson(
      baseUrl,
      `/api/developer/device-blocks/${scopedBlocks.items[0].id}/unblock`,
      { reason: "member_device_unblock" },
      memberSession.token
    );
    assert.equal(unblockedDevice.status, "released");

    const loginAfterUnblock = await signedClientPost(
      baseUrl,
      "/api/client/login",
      alphaProduct.sdkAppId,
      alphaProduct.sdkAppSecret,
      {
        productCode: "DEV_ALPHA",
        username: "alphauser",
        password: "AlphaUser123!",
        deviceFingerprint: "alpha-scope-device-001",
        deviceName: "Alpha Scope Desktop"
      }
    );
    assert.ok(loginAfterUnblock.sessionToken);

    const developerAuditLogs = await getJson(baseUrl, "/api/developer/audit-logs?limit=120", memberSession.token);
    const eventTypes = developerAuditLogs.items.map((entry) => entry.event_type);
    assert.ok(eventTypes.includes("account.disable"));
    assert.ok(eventTypes.includes("entitlement.extend"));
    assert.ok(eventTypes.includes("entitlement.points.adjust"));
    assert.ok(eventTypes.includes("session.revoke"));
    assert.ok(eventTypes.includes("device-binding.release"));
    assert.ok(eventTypes.includes("device-block.activate"));
    assert.ok(eventTypes.includes("device-block.release"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer ops export bundles scoped data and downloadable assets", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "ops.export.owner",
        password: "OpsExportOwner123!",
        displayName: "Ops Export Owner"
      },
      adminSession.token
    );

    const alphaProduct = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "EXPORT_ALPHA",
        name: "Export Alpha",
        ownerDeveloperId: owner.id
      },
      adminSession.token
    );

    const betaProduct = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "EXPORT_BETA",
        name: "Export Beta",
        ownerDeveloperId: owner.id
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "ops.export.owner",
      password: "OpsExportOwner123!"
    });

    const alphaPolicy = await postJson(
      baseUrl,
      "/api/developer/policies",
      {
        productCode: "EXPORT_ALPHA",
        name: "Export Alpha Policy",
        durationDays: 30,
        maxDevices: 1
      },
      ownerSession.token
    );

    const betaPolicy = await postJson(
      baseUrl,
      "/api/developer/policies",
      {
        productCode: "EXPORT_BETA",
        name: "Export Beta Policy",
        durationDays: 30,
        maxDevices: 1
      },
      ownerSession.token
    );

    const alphaCards = await postJson(
      baseUrl,
      "/api/developer/cards/batch",
      {
        productCode: "EXPORT_ALPHA",
        policyId: alphaPolicy.id,
        count: 1,
        prefix: "EXALPHA"
      },
      ownerSession.token
    );

    const betaCards = await postJson(
      baseUrl,
      "/api/developer/cards/batch",
      {
        productCode: "EXPORT_BETA",
        policyId: betaPolicy.id,
        count: 1,
        prefix: "EXBETA"
      },
      ownerSession.token
    );

    await signedClientPost(baseUrl, "/api/client/register", alphaProduct.sdkAppId, alphaProduct.sdkAppSecret, {
      productCode: "EXPORT_ALPHA",
      username: "alphaexport",
      password: "AlphaExport123!"
    });
    await signedClientPost(baseUrl, "/api/client/register", betaProduct.sdkAppId, betaProduct.sdkAppSecret, {
      productCode: "EXPORT_BETA",
      username: "betaexport",
      password: "BetaExport123!"
    });

    await signedClientPost(baseUrl, "/api/client/recharge", alphaProduct.sdkAppId, alphaProduct.sdkAppSecret, {
      productCode: "EXPORT_ALPHA",
      username: "alphaexport",
      password: "AlphaExport123!",
      cardKey: alphaCards.keys[0]
    });
    await signedClientPost(baseUrl, "/api/client/recharge", betaProduct.sdkAppId, betaProduct.sdkAppSecret, {
      productCode: "EXPORT_BETA",
      username: "betaexport",
      password: "BetaExport123!",
      cardKey: betaCards.keys[0]
    });

    await signedClientPost(
      baseUrl,
      "/api/client/login",
      alphaProduct.sdkAppId,
      alphaProduct.sdkAppSecret,
      {
        productCode: "EXPORT_ALPHA",
        username: "alphaexport",
        password: "AlphaExport123!",
        deviceFingerprint: "export-alpha-device-01",
        deviceName: "Export Alpha Desktop"
      }
    );

    await signedClientPost(
      baseUrl,
      "/api/client/login",
      betaProduct.sdkAppId,
      betaProduct.sdkAppSecret,
      {
        productCode: "EXPORT_BETA",
        username: "betaexport",
        password: "BetaExport123!",
        deviceFingerprint: "export-beta-device-01",
        deviceName: "Export Beta Desktop"
      }
    );

    await postJson(
      baseUrl,
      "/api/developer/members",
      {
        username: "ops.export.operator",
        password: "OpsExportOperator123!",
        displayName: "Ops Export Operator",
        role: "operator",
        productCodes: ["EXPORT_ALPHA"]
      },
      ownerSession.token
    );

    const operatorSession = await postJson(baseUrl, "/api/developer/login", {
      username: "ops.export.operator",
      password: "OpsExportOperator123!"
    });

    const scopedSessions = await getJson(baseUrl, "/api/developer/sessions?status=active", operatorSession.token);
    assert.equal(scopedSessions.total, 1);
    assert.equal(scopedSessions.items[0].product_code, "EXPORT_ALPHA");

    const revokedSession = await postJson(
      baseUrl,
      `/api/developer/sessions/${scopedSessions.items[0].id}/revoke`,
      { reason: "ops_export_snapshot" },
      operatorSession.token
    );
    assert.equal(revokedSession.status, "expired");

    const exportSnapshot = await getJson(
      baseUrl,
      "/api/developer/ops/export?productCode=EXPORT_ALPHA&eventType=session.revoke&limit=20",
      operatorSession.token
    );
    assert.equal(exportSnapshot.scope.productCode, "EXPORT_ALPHA");
    assert.equal(exportSnapshot.summary.projects, 1);
    assert.equal(exportSnapshot.accounts.total, 1);
    assert.equal(exportSnapshot.sessions.total, 1);
    assert.equal(exportSnapshot.bindings.total, 1);
    assert.equal(exportSnapshot.blocks.total, 0);
    assert.ok(exportSnapshot.auditLogs.total >= 1);
    assert.equal(exportSnapshot.accounts.items[0].productCode, "EXPORT_ALPHA");
    assert.equal(exportSnapshot.sessions.items[0].productCode, "EXPORT_ALPHA");
    assert.equal(exportSnapshot.bindings.items[0].productCode, "EXPORT_ALPHA");
    assert.ok(exportSnapshot.auditLogs.items.every((item) => item.eventType === "session.revoke"));
    assert.ok(exportSnapshot.auditLogs.items.every((item) => item.metadata?.productCode === "EXPORT_ALPHA"));
    assert.equal(exportSnapshot.overview.status, "ok");
    assert.ok(Array.isArray(exportSnapshot.overview.highlights));
    assert.ok(exportSnapshot.overview.topAuditEvents.some((item) => item.eventType === "session.revoke"));
    assert.ok(exportSnapshot.overview.topReasons.some((item) => item.reason === "ops_export_snapshot"));
    assert.ok(exportSnapshot.overview.focusUsernames.some((item) => item.username === "alphaexport"));
    assert.ok(exportSnapshot.overview.focusAccounts.some((item) => item.username === "alphaexport"));
    assert.ok(exportSnapshot.overview.focusSessions.some((item) => item.username === "alphaexport"));
    assert.ok(exportSnapshot.overview.focusDevices.some((item) => item.fingerprint === "export-alpha-device-01"));
    assert.ok(exportSnapshot.overview.focusAccounts.some((item) => item.severity && item.actionHint));
    assert.ok(exportSnapshot.overview.focusSessions.some((item) => item.severity && item.actionHint));
    assert.ok(exportSnapshot.overview.focusDevices.some((item) => item.severity && item.actionHint));
    assert.ok(Array.isArray(exportSnapshot.overview.recommendedQueue));
    assert.ok(exportSnapshot.overview.recommendedQueue.some((item) => item.sourceType === "session" && item.severity));
    assert.ok(exportSnapshot.overview.recommendedQueue.some((item) => item.recommendedControl?.label));
    assert.ok(exportSnapshot.overview.recommendedQueue.some((item) => item.sourceType === "account" && typeof item.issueCount === "number"));
    assert.ok(exportSnapshot.overview.recommendedQueue.some((item) => item.sourceType === "device" && typeof item.relatedSessionCount === "number"));
    assert.equal(exportSnapshot.overview.queueSummary.total, exportSnapshot.overview.recommendedQueue.length);
    assert.equal(exportSnapshot.routeReview?.active, true);
    assert.equal(exportSnapshot.routeReview?.focus, "sessions");
    assert.equal(exportSnapshot.routeReview?.matchedCounts?.sessions, 1);
    assert.equal(exportSnapshot.routeReview?.primaryMatch?.kind, "session");
    assert.equal(exportSnapshot.routeReview?.primaryMatch?.routeAction, "control-session");
    assert.equal(exportSnapshot.routeReview?.nextMatch?.kind, "audit");
    assert.equal(exportSnapshot.routeReview?.downloads?.primary?.format, "route-review-primary");
    assert.match(exportSnapshot.routeReview?.downloads?.primary?.fileName || "", /developer-ops-primary-session-summary\.txt/);
    assert.equal(exportSnapshot.routeReview?.downloads?.remaining?.format, "route-review-remaining");
    assert.equal(exportSnapshot.routeReview?.downloads?.remaining?.fileName, "developer-ops-remaining-summary.txt");
    assert.equal(exportSnapshot.routeReview?.downloads?.sections?.sessions?.fileName, "developer-ops-sessions-summary.txt");
    assert.equal(exportSnapshot.routeReview?.sections?.sessions?.primaryMatch?.kind, "session");
    assert.deepEqual(exportSnapshot.routeReview?.matchedIds?.sessions, [exportSnapshot.routeReview?.primaryMatch?.item?.sessionId]);
    assert.deepEqual(exportSnapshot.routeReview?.matchedIds?.audit, [exportSnapshot.routeReview?.nextMatch?.item?.id]);
    assert.equal(exportSnapshot.routeReview?.continuation?.remainingCount, 1);
    assert.equal(exportSnapshot.routeReview?.continuation?.primaryAction, "review_next");
    assert.equal(exportSnapshot.routeReview?.continuation?.secondaryAction, "download_next");
    assert.equal(exportSnapshot.routeReview?.continuation?.nextDownload?.format, "route-review-next");
    const primaryContinuationKey = `${exportSnapshot.routeReview?.primaryMatch?.kind}:${exportSnapshot.routeReview?.primaryMatch?.item?.sessionId || exportSnapshot.routeReview?.primaryMatch?.item?.id}`;
    const nextContinuationKey = `${exportSnapshot.routeReview?.nextMatch?.kind}:${exportSnapshot.routeReview?.nextMatch?.item?.id}`;
    assert.equal(exportSnapshot.routeReview?.continuations?.[primaryContinuationKey]?.primaryAction, "review_next");
    assert.equal(exportSnapshot.routeReview?.continuations?.[primaryContinuationKey]?.nextMatch?.kind, "audit");
    assert.equal(exportSnapshot.routeReview?.continuations?.[primaryContinuationKey]?.nextDownload?.format, "route-review-next");
    assert.match(exportSnapshot.routeReview?.continuations?.[nextContinuationKey]?.primaryAction || "", /^(review_next|complete_route_review)$/);
    assert.equal(exportSnapshot.routeReview?.continuations?.[nextContinuationKey]?.completionWorkspaceAction?.key, "launch-mainline");
    assert.equal(exportSnapshot.routeReview?.continuations?.[nextContinuationKey]?.completionDownload?.key, "launch_mainline_summary");
    assert.equal(exportSnapshot.routeReview?.continuations?.[nextContinuationKey]?.completionGuideDownload?.key, "launch_mainline_rehearsal_guide");
    assert.equal(exportSnapshot.routeReview?.continuations?.[nextContinuationKey]?.completionFirstLaunchHandoffDownload?.key, "launch_mainline_first_launch_handoff");
    const completionContinuation = Object.values(exportSnapshot.routeReview?.continuations || {})
      .find((item) => item?.primaryAction === "complete_route_review") || null;
    assert.equal(completionContinuation?.secondaryAction, "download-mainline-first-launch-handoff");
    assert.equal(completionContinuation?.secondaryLabel, "Download First Launch Handoff");
    assert.equal(completionContinuation?.completionFirstLaunchHandoffDownload?.key, "launch_mainline_first_launch_handoff");
    assert.equal(exportSnapshot.routeReview?.continuation?.completionGuideDownload?.key, "launch_mainline_rehearsal_guide");
    assert.equal(exportSnapshot.routeReview?.continuation?.completionFirstLaunchHandoffDownload?.key, "launch_mainline_first_launch_handoff");
    assert.equal(exportSnapshot.mainlineHandoff?.workspaceAction?.key, "launch-mainline");
    assert.equal(exportSnapshot.mainlineHandoff?.downloads?.summary?.key, "launch_mainline_summary");
    assert.equal(exportSnapshot.mainlineHandoff?.downloads?.rehearsalGuide?.key, "launch_mainline_rehearsal_guide");
    assert.equal(exportSnapshot.mainlineHandoff?.downloads?.firstLaunchHandoff?.key, "launch_mainline_first_launch_handoff");
    assert.match(exportSnapshot.mainlineHandoff?.downloads?.firstLaunchHandoff?.href || "", /\/api\/developer\/launch-mainline\/download\?/);
    assert.match(exportSnapshot.mainlineHandoff?.downloads?.firstLaunchHandoff?.href || "", /format=first-launch-handoff/);
    assert.equal(exportSnapshot.routeReview?.mainlineHandoff?.workspaceAction?.key, "launch-mainline");
    assert.equal(exportSnapshot.routeReview?.mainlineHandoff?.downloads?.summary?.key, "launch_mainline_summary");
    assert.equal(exportSnapshot.routeReview?.mainlineHandoff?.downloads?.rehearsalGuide?.key, "launch_mainline_rehearsal_guide");
    assert.equal(exportSnapshot.routeReview?.mainlineHandoff?.downloads?.firstLaunchHandoff?.key, "launch_mainline_first_launch_handoff");
    assert.ok(Array.isArray(exportSnapshot.routeReview?.actions));
    assert.ok(exportSnapshot.routeReview?.actions.some((item) => item.action === "review-primary" && item.label === "Review Primary Match"));
    assert.ok(exportSnapshot.routeReview?.actions.some((item) => item.action === "review-next" && item.label === "Review Next Match"));
    assert.ok(exportSnapshot.routeReview?.actions.some((item) => item.action === "open-mainline" && item.label === "Open Launch Mainline"));
    assert.ok(exportSnapshot.routeReview?.actions.some((item) => item.action === "download-mainline" && item.label === "Download Launch Mainline Summary"));
    assert.ok(exportSnapshot.routeReview?.actions.some((item) => item.action === "download-mainline-rehearsal" && item.label === "Download Launch Mainline Rehearsal Guide"));
    assert.ok(exportSnapshot.routeReview?.actions.some((item) => item.action === "download-mainline-first-launch-handoff" && item.label === "Download First Launch Handoff"));
    assert.ok(exportSnapshot.routeReview?.actions.some((item) => item.action === "download-remaining" && item.label === "Download Remaining Queue Summary"));
    assert.ok(Array.isArray(exportSnapshot.routeReview?.remainingMatches));
    assert.equal(exportSnapshot.routeReview?.remainingMatches?.[0]?.kind, "audit");
    assert.match(exportSnapshot.summaryText, /RockSolid Developer Ops Snapshot/);
    assert.match(exportSnapshot.summaryText, /Project Filter: EXPORT_ALPHA/);
    assert.match(exportSnapshot.summaryText, /Overview Status: ok/);
    assert.match(exportSnapshot.summaryText, /Route Review Focus: sessions/);
    assert.match(exportSnapshot.summaryText, /Route Review Primary Match:/);
    assert.match(exportSnapshot.summaryText, /Route Review Remaining Matches:/);
    assert.match(exportSnapshot.summaryText, /Launch Mainline Handoff:/);
    assert.match(exportSnapshot.summaryText, /Open Launch Mainline@summary/);
    assert.match(exportSnapshot.summaryText, /Launch mainline rehearsal guide/i);
    assert.match(exportSnapshot.summaryText, /First launch handoff/i);
    assert.match(exportSnapshot.summaryText, /Top Reasons:/);
    assert.match(exportSnapshot.summaryText, /Focus Account Details:/);
    assert.match(exportSnapshot.summaryText, /Focus Sessions:/);
    assert.match(exportSnapshot.summaryText, /Focus Devices:/);
    assert.match(exportSnapshot.summaryText, /Escalate First:/);
    assert.match(exportSnapshot.summaryText, /Recommended Queue Counts:/);
    assert.match(exportSnapshot.summaryText, /Recommended Queue:/);
    assert.match(exportSnapshot.summaryText, /impacts=/);
    assert.match(exportSnapshot.summaryText, /control=/);
    assert.match(exportSnapshot.summaryText, /severity=/);
    assert.match(exportSnapshot.summaryText, /next=/);

    const forbiddenExport = await getJsonExpectError(
      baseUrl,
      "/api/developer/ops/export?productCode=EXPORT_BETA",
      operatorSession.token
    );
    assert.equal(forbiddenExport.status, 403);
    assert.equal(forbiddenExport.error.code, "DEVELOPER_PRODUCT_FORBIDDEN");

    const summaryDownload = await getText(
      baseUrl,
      "/api/developer/ops/export/download?productCode=EXPORT_ALPHA&eventType=session.revoke&format=summary",
      operatorSession.token
    );
    assert.equal(summaryDownload.contentType, "text/plain; charset=utf-8");
    assert.match(summaryDownload.contentDisposition || "", /developer-ops/i);
    assert.match(summaryDownload.body, /RockSolid Developer Ops Snapshot/);
    assert.match(summaryDownload.body, /Project Filter: EXPORT_ALPHA/);

    const primaryRouteReviewDownload = await getText(
      baseUrl,
      "/api/developer/ops/export/download?productCode=EXPORT_ALPHA&eventType=session.revoke&format=route-review-primary",
      operatorSession.token
    );
    assert.equal(primaryRouteReviewDownload.contentType, "text/plain; charset=utf-8");
    assert.match(primaryRouteReviewDownload.contentDisposition || "", /developer-ops-primary-session-summary\.txt/);
    assert.match(primaryRouteReviewDownload.body, /Route Review Primary Match/);
    assert.match(primaryRouteReviewDownload.body, /action=Open Session Control/);

    const nextRouteReviewDownload = await getText(
      baseUrl,
      "/api/developer/ops/export/download?productCode=EXPORT_ALPHA&eventType=session.revoke&format=route-review-next",
      operatorSession.token
    );
    assert.equal(nextRouteReviewDownload.contentType, "text/plain; charset=utf-8");
    assert.match(nextRouteReviewDownload.contentDisposition || "", /developer-ops-next-audit-summary\.txt/);
    assert.match(nextRouteReviewDownload.body, /Route Review Next Match/);
    assert.match(nextRouteReviewDownload.body, /action=Review Audit/);

    const remainingRouteReviewDownload = await getText(
      baseUrl,
      "/api/developer/ops/export/download?productCode=EXPORT_ALPHA&eventType=session.revoke&format=route-review-remaining",
      operatorSession.token
    );
    assert.equal(remainingRouteReviewDownload.contentType, "text/plain; charset=utf-8");
    assert.match(remainingRouteReviewDownload.contentDisposition || "", /developer-ops-remaining-summary\.txt/);
    assert.match(remainingRouteReviewDownload.body, /Route Review Remaining Matches/);
    assert.match(remainingRouteReviewDownload.body, /Review Audit/);

    const firstLaunchHandoffDownload = await getText(
      baseUrl,
      exportSnapshot.mainlineHandoff.downloads.firstLaunchHandoff.href,
      operatorSession.token
    );
    assert.equal(firstLaunchHandoffDownload.contentType, "text/plain; charset=utf-8");
    assert.match(firstLaunchHandoffDownload.contentDisposition || "", /first-launch-handoff\.txt/);
    assert.match(firstLaunchHandoffDownload.body, /RockSolid Developer Launch Mainline First Launch Handoff/);
    assert.match(firstLaunchHandoffDownload.body, /First Ops Actions:/);

    const checksumsDownload = await getText(
      baseUrl,
      "/api/developer/ops/export/download?productCode=EXPORT_ALPHA&eventType=session.revoke&format=checksums",
      operatorSession.token
    );
    assert.equal(checksumsDownload.contentType, "text/plain; charset=utf-8");
    assert.match(checksumsDownload.body, /csv\/projects\.csv/);
    assert.match(checksumsDownload.body, /csv\/audit-logs\.csv/);

    const zipDownload = await getBinary(
      baseUrl,
      "/api/developer/ops/export/download?productCode=EXPORT_ALPHA&eventType=session.revoke&format=zip",
      operatorSession.token
    );
    assert.equal(zipDownload.contentType, "application/zip");
    assert.equal(zipDownload.body.subarray(0, 2).toString("utf8"), "PK");
    const zipText = zipDownload.body.toString("latin1");
    assert.match(zipText, /csv\/projects\.csv/);
    assert.match(zipText, /csv\/accounts\.csv/);
    assert.match(zipText, /csv\/audit-logs\.csv/);
    assert.match(zipText, /SHA256SUMS\.txt/);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("admin ops export bundles platform snapshots and filtered downloadable assets", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "admin.export.owner",
        password: "AdminExportOwner123!",
        displayName: "Admin Export Owner"
      },
      adminSession.token
    );

    const alphaProduct = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "ADMIN_EXPORT_ALPHA",
        name: "Admin Export Alpha"
      },
      adminSession.token
    );

    const betaProduct = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "ADMIN_EXPORT_BETA",
        name: "Admin Export Beta"
      },
      adminSession.token
    );

    const alphaPolicy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "ADMIN_EXPORT_ALPHA",
        name: "Admin Export Alpha Policy",
        durationDays: 30,
        maxDevices: 1
      },
      adminSession.token
    );

    const betaPolicy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "ADMIN_EXPORT_BETA",
        name: "Admin Export Beta Policy",
        durationDays: 30,
        maxDevices: 1
      },
      adminSession.token
    );

    const alphaCards = await postJson(
      baseUrl,
      "/api/admin/cards/batch",
      {
        productCode: "ADMIN_EXPORT_ALPHA",
        policyId: alphaPolicy.id,
        count: 1,
        prefix: "AEXA"
      },
      adminSession.token
    );

    const betaCards = await postJson(
      baseUrl,
      "/api/admin/cards/batch",
      {
        productCode: "ADMIN_EXPORT_BETA",
        policyId: betaPolicy.id,
        count: 1,
        prefix: "AEXB"
      },
      adminSession.token
    );

    await signedClientPost(baseUrl, "/api/client/register", alphaProduct.sdkAppId, alphaProduct.sdkAppSecret, {
      productCode: "ADMIN_EXPORT_ALPHA",
      username: "adminalpha",
      password: "AdminAlpha123!"
    });
    await signedClientPost(baseUrl, "/api/client/register", betaProduct.sdkAppId, betaProduct.sdkAppSecret, {
      productCode: "ADMIN_EXPORT_BETA",
      username: "adminbeta",
      password: "AdminBeta123!"
    });

    await signedClientPost(baseUrl, "/api/client/recharge", alphaProduct.sdkAppId, alphaProduct.sdkAppSecret, {
      productCode: "ADMIN_EXPORT_ALPHA",
      username: "adminalpha",
      password: "AdminAlpha123!",
      cardKey: alphaCards.keys[0]
    });
    await signedClientPost(baseUrl, "/api/client/recharge", betaProduct.sdkAppId, betaProduct.sdkAppSecret, {
      productCode: "ADMIN_EXPORT_BETA",
      username: "adminbeta",
      password: "AdminBeta123!",
      cardKey: betaCards.keys[0]
    });

    await signedClientPost(
      baseUrl,
      "/api/client/login",
      alphaProduct.sdkAppId,
      alphaProduct.sdkAppSecret,
      {
        productCode: "ADMIN_EXPORT_ALPHA",
        username: "adminalpha",
        password: "AdminAlpha123!",
        deviceFingerprint: "admin-export-alpha-device-01",
        deviceName: "Admin Export Alpha Desktop"
      }
    );

    await signedClientPost(
      baseUrl,
      "/api/client/login",
      betaProduct.sdkAppId,
      betaProduct.sdkAppSecret,
      {
        productCode: "ADMIN_EXPORT_BETA",
        username: "adminbeta",
        password: "AdminBeta123!",
        deviceFingerprint: "admin-export-beta-device-01",
        deviceName: "Admin Export Beta Desktop"
      }
    );

    const alphaSessions = await getJson(
      baseUrl,
      "/api/admin/sessions?productCode=ADMIN_EXPORT_ALPHA&status=active&username=adminalpha",
      adminSession.token
    );
    assert.equal(alphaSessions.total, 1);

    const revoked = await postJson(
      baseUrl,
      `/api/admin/sessions/${alphaSessions.items[0].id}/revoke`,
      { reason: "admin_ops_export_snapshot" },
      adminSession.token
    );
    assert.equal(revoked.status, "expired");

    const blocked = await postJson(
      baseUrl,
      "/api/admin/device-blocks",
      {
        productCode: "ADMIN_EXPORT_ALPHA",
        deviceFingerprint: "admin-export-alpha-device-01",
        reason: "admin_ops_export_review",
        notes: "captured for admin export snapshot"
      },
      adminSession.token
    );
    assert.equal(blocked.productCode, "ADMIN_EXPORT_ALPHA");

    const exportSnapshot = await getJson(
      baseUrl,
      "/api/admin/ops/export?productCode=ADMIN_EXPORT_ALPHA&eventType=session.revoke&limit=20",
      adminSession.token
    );
    assert.equal(exportSnapshot.scope.productCode, "ADMIN_EXPORT_ALPHA");
    assert.equal(exportSnapshot.summary.projects, 1);
    assert.equal(exportSnapshot.accounts.total, 1);
    assert.equal(exportSnapshot.sessions.total, 1);
    assert.equal(exportSnapshot.bindings.total, 1);
    assert.equal(exportSnapshot.blocks.total, 1);
    assert.ok(exportSnapshot.auditLogs.total >= 1);
    assert.equal(exportSnapshot.accounts.items[0].productCode, "ADMIN_EXPORT_ALPHA");
    assert.equal(exportSnapshot.sessions.items[0].productCode, "ADMIN_EXPORT_ALPHA");
    assert.equal(exportSnapshot.bindings.items[0].productCode, "ADMIN_EXPORT_ALPHA");
    assert.equal(exportSnapshot.blocks.items[0].productCode, "ADMIN_EXPORT_ALPHA");
    assert.ok(exportSnapshot.auditLogs.items.every((item) => item.eventType === "session.revoke"));
    assert.ok(exportSnapshot.auditLogs.items.every((item) => item.metadata?.productCode === "ADMIN_EXPORT_ALPHA"));
    assert.equal(exportSnapshot.overview.status, "attention");
    assert.equal(exportSnapshot.overview.metrics.activeBlocks, 1);
    assert.ok(exportSnapshot.overview.topAuditEvents.some((item) => item.eventType === "session.revoke"));
    assert.ok(exportSnapshot.overview.topReasons.some((item) => item.reason === "admin_ops_export_review" || item.reason === "admin_ops_export_snapshot"));
    assert.ok(exportSnapshot.overview.focusAccounts.some((item) => item.username === "adminalpha"));
    assert.ok(exportSnapshot.overview.focusSessions.some((item) => item.username === "adminalpha"));
    assert.ok(exportSnapshot.overview.focusDevices.some((item) => item.fingerprint === "admin-export-alpha-device-01"));
    assert.ok(exportSnapshot.overview.focusAccounts.some((item) => item.severity && item.actionHint));
    assert.ok(exportSnapshot.overview.focusSessions.some((item) => item.severity && item.actionHint));
    assert.ok(exportSnapshot.overview.focusDevices.some((item) => item.severity === "critical" && item.actionHint));
    assert.ok(Array.isArray(exportSnapshot.overview.recommendedQueue));
    assert.equal(exportSnapshot.overview.recommendedQueue[0].severity, "critical");
    assert.equal(exportSnapshot.overview.recommendedQueue[0].recommendedControl?.type, "unblock_device");
    assert.ok(exportSnapshot.overview.recommendedQueue.some((item) => item.sourceType === "account" && typeof item.activeSessionCount === "number"));
    assert.ok(exportSnapshot.overview.recommendedQueue.some((item) => item.sourceType === "device" && typeof item.relatedSessionCount === "number"));
    assert.equal(exportSnapshot.overview.queueSummary.critical >= 1, true);
    assert.ok(exportSnapshot.overview.focusFingerprints.some((item) => item.fingerprint === "admin-export-alpha-device-01"));
    assert.match(exportSnapshot.summaryText, /RockSolid Admin Ops Snapshot/);
    assert.match(exportSnapshot.summaryText, /Project Filter: ADMIN_EXPORT_ALPHA/);
    assert.match(exportSnapshot.summaryText, /Overview Status: attention/);
    assert.match(exportSnapshot.summaryText, /Focus Account Details:/);
    assert.match(exportSnapshot.summaryText, /Focus Sessions:/);
    assert.match(exportSnapshot.summaryText, /Focus Devices:/);
    assert.match(exportSnapshot.summaryText, /Focus Fingerprints:/);
    assert.match(exportSnapshot.summaryText, /Escalate First:/);
    assert.match(exportSnapshot.summaryText, /Recommended Queue Counts:/);
    assert.match(exportSnapshot.summaryText, /Recommended Queue:/);
    assert.match(exportSnapshot.summaryText, /impacts=/);
    assert.match(exportSnapshot.summaryText, /control=/);
    assert.match(exportSnapshot.summaryText, /severity=/);
    assert.match(exportSnapshot.summaryText, /next=/);

    const fullSnapshot = await getJson(
      baseUrl,
      "/api/admin/ops/export?limit=120",
      adminSession.token
    );
    assert.ok(fullSnapshot.summary.projects >= 2);
    assert.ok(fullSnapshot.auditLogs.items.some((item) => item.eventType === "developer.create"));

    const summaryDownload = await getText(
      baseUrl,
      "/api/admin/ops/export/download?productCode=ADMIN_EXPORT_ALPHA&eventType=session.revoke&format=summary",
      adminSession.token
    );
    assert.equal(summaryDownload.contentType, "text/plain; charset=utf-8");
    assert.match(summaryDownload.contentDisposition || "", /admin-ops/i);
    assert.match(summaryDownload.body, /RockSolid Admin Ops Snapshot/);
    assert.match(summaryDownload.body, /Project Filter: ADMIN_EXPORT_ALPHA/);

    const checksumsDownload = await getText(
      baseUrl,
      "/api/admin/ops/export/download?productCode=ADMIN_EXPORT_ALPHA&eventType=session.revoke&format=checksums",
      adminSession.token
    );
    assert.equal(checksumsDownload.contentType, "text/plain; charset=utf-8");
    assert.match(checksumsDownload.body, /csv\/projects\.csv/);
    assert.match(checksumsDownload.body, /csv\/audit-logs\.csv/);

    const zipDownload = await getBinary(
      baseUrl,
      "/api/admin/ops/export/download?productCode=ADMIN_EXPORT_ALPHA&eventType=session.revoke&format=zip",
      adminSession.token
    );
    assert.equal(zipDownload.contentType, "application/zip");
    assert.equal(zipDownload.body.subarray(0, 2).toString("utf8"), "PK");
    const zipText = zipDownload.body.toString("latin1");
    assert.match(zipText, /csv\/projects\.csv/);
    assert.match(zipText, /csv\/accounts\.csv/);
    assert.match(zipText, /csv\/audit-logs\.csv/);
    assert.match(zipText, /SHA256SUMS\.txt/);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("admin and developer audit logs support product, entity, username, and search filters", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "audit.filter.owner",
        password: "AuditFilterOwner123!",
        displayName: "Audit Filter Owner"
      },
      adminSession.token
    );

    const alphaProduct = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "AUDIT_FILTER_ALPHA",
        name: "Audit Filter Alpha",
        ownerDeveloperId: owner.id
      },
      adminSession.token
    );

    const betaProduct = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "AUDIT_FILTER_BETA",
        name: "Audit Filter Beta",
        ownerDeveloperId: owner.id
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "audit.filter.owner",
      password: "AuditFilterOwner123!"
    });

    const alphaPolicy = await postJson(
      baseUrl,
      "/api/developer/policies",
      {
        productCode: "AUDIT_FILTER_ALPHA",
        name: "Audit Filter Alpha Policy",
        durationDays: 30,
        maxDevices: 1
      },
      ownerSession.token
    );

    const betaPolicy = await postJson(
      baseUrl,
      "/api/developer/policies",
      {
        productCode: "AUDIT_FILTER_BETA",
        name: "Audit Filter Beta Policy",
        durationDays: 30,
        maxDevices: 1
      },
      ownerSession.token
    );

    const alphaCards = await postJson(
      baseUrl,
      "/api/developer/cards/batch",
      {
        productCode: "AUDIT_FILTER_ALPHA",
        policyId: alphaPolicy.id,
        count: 1,
        prefix: "AUFA"
      },
      ownerSession.token
    );

    const betaCards = await postJson(
      baseUrl,
      "/api/developer/cards/batch",
      {
        productCode: "AUDIT_FILTER_BETA",
        policyId: betaPolicy.id,
        count: 1,
        prefix: "AUFB"
      },
      ownerSession.token
    );

    await signedClientPost(baseUrl, "/api/client/register", alphaProduct.sdkAppId, alphaProduct.sdkAppSecret, {
      productCode: "AUDIT_FILTER_ALPHA",
      username: "auditalpha",
      password: "AuditAlpha123!"
    });
    await signedClientPost(baseUrl, "/api/client/register", betaProduct.sdkAppId, betaProduct.sdkAppSecret, {
      productCode: "AUDIT_FILTER_BETA",
      username: "auditbeta",
      password: "AuditBeta123!"
    });

    await signedClientPost(baseUrl, "/api/client/recharge", alphaProduct.sdkAppId, alphaProduct.sdkAppSecret, {
      productCode: "AUDIT_FILTER_ALPHA",
      username: "auditalpha",
      password: "AuditAlpha123!",
      cardKey: alphaCards.keys[0]
    });
    await signedClientPost(baseUrl, "/api/client/recharge", betaProduct.sdkAppId, betaProduct.sdkAppSecret, {
      productCode: "AUDIT_FILTER_BETA",
      username: "auditbeta",
      password: "AuditBeta123!",
      cardKey: betaCards.keys[0]
    });

    await signedClientPost(
      baseUrl,
      "/api/client/login",
      alphaProduct.sdkAppId,
      alphaProduct.sdkAppSecret,
      {
        productCode: "AUDIT_FILTER_ALPHA",
        username: "auditalpha",
        password: "AuditAlpha123!",
        deviceFingerprint: "audit-filter-alpha-device-01",
        deviceName: "Audit Filter Alpha Desktop"
      }
    );

    await signedClientPost(
      baseUrl,
      "/api/client/login",
      betaProduct.sdkAppId,
      betaProduct.sdkAppSecret,
      {
        productCode: "AUDIT_FILTER_BETA",
        username: "auditbeta",
        password: "AuditBeta123!",
        deviceFingerprint: "audit-filter-beta-device-01",
        deviceName: "Audit Filter Beta Desktop"
      }
    );

    const alphaSessions = await getJson(
      baseUrl,
      "/api/developer/sessions?productCode=AUDIT_FILTER_ALPHA&status=active&username=auditalpha",
      ownerSession.token
    );
    assert.equal(alphaSessions.total, 1);

    await postJson(
      baseUrl,
      `/api/developer/sessions/${alphaSessions.items[0].id}/revoke`,
      { reason: "audit_filter_marker" },
      ownerSession.token
    );

    const adminAudit = await getJson(
      baseUrl,
      "/api/admin/audit-logs?productCode=AUDIT_FILTER_ALPHA&username=auditalpha&eventType=session.revoke&entityType=session&search=audit_filter_marker&limit=20",
      adminSession.token
    );
    assert.equal(adminAudit.total, 1);
    assert.ok(adminAudit.items.every((entry) => entry.event_type === "session.revoke"));
    assert.ok(adminAudit.items.every((entry) => entry.entity_type === "session"));
    assert.ok(adminAudit.items.every((entry) => entry.metadata?.productCode === "AUDIT_FILTER_ALPHA"));
    assert.ok(adminAudit.items.every((entry) => entry.metadata?.username === "auditalpha"));
    assert.ok(adminAudit.items.every((entry) => entry.metadata?.reason === "audit_filter_marker"));

    const developerAudit = await getJson(
      baseUrl,
      "/api/developer/audit-logs?productCode=AUDIT_FILTER_ALPHA&username=auditalpha&eventType=session.revoke&entityType=session&search=audit_filter_marker&limit=20",
      ownerSession.token
    );
    assert.equal(developerAudit.total, 1);
    assert.ok(developerAudit.items.every((entry) => entry.event_type === "session.revoke"));
    assert.ok(developerAudit.items.every((entry) => entry.entity_type === "session"));
    assert.ok(developerAudit.items.every((entry) => entry.metadata?.productCode === "AUDIT_FILTER_ALPHA"));
    assert.ok(developerAudit.items.every((entry) => entry.metadata?.username === "auditalpha"));
    assert.ok(developerAudit.items.every((entry) => entry.metadata?.reason === "audit_filter_marker"));

    const betaAdminAudit = await getJson(
      baseUrl,
      "/api/admin/audit-logs?productCode=AUDIT_FILTER_BETA&search=audit_filter_marker&limit=20",
      adminSession.token
    );
    assert.equal(betaAdminAudit.total, 0);

    const betaDeveloperAudit = await getJson(
      baseUrl,
      "/api/developer/audit-logs?productCode=AUDIT_FILTER_BETA&search=audit_filter_marker&limit=20",
      ownerSession.token
    );
    assert.equal(betaDeveloperAudit.total, 0);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("admin and developers can rotate project sdk credentials with scoped permission checks", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "rotate.owner",
        password: "RotateOwner123!",
        displayName: "Rotate Owner"
      },
      adminSession.token
    );

    const product = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "ROTATE_APP",
        name: "Rotate App",
        ownerDeveloperId: owner.id
      },
      adminSession.token
    );

    const originalAppId = product.sdkAppId;
    const originalSecret = product.sdkAppSecret;

    await signedClientPost(baseUrl, "/api/client/register", originalAppId, originalSecret, {
      productCode: "ROTATE_APP",
      username: "before_admin_rotate",
      password: "RotateUser123!"
    });

    const adminRotation = await postJson(
      baseUrl,
      `/api/admin/products/${product.id}/sdk-credentials/rotate`,
      {},
      adminSession.token
    );
    assert.equal(adminRotation.sdkAppId, originalAppId);
    assert.notEqual(adminRotation.sdkAppSecret, originalSecret);
    assert.equal(adminRotation.rotation.rotateAppId, false);
    assert.equal(adminRotation.rotation.previousSdkAppId, originalAppId);

    const oldSecretFailure = await signedClientPostExpectError(
      baseUrl,
      "/api/client/register",
      originalAppId,
      originalSecret,
      {
        productCode: "ROTATE_APP",
        username: "old_secret_user",
        password: "RotateUser123!"
      }
    );
    assert.equal(oldSecretFailure.status, 401);
    assert.equal(oldSecretFailure.error.code, "SDK_SIGNATURE_INVALID");

    await signedClientPost(baseUrl, "/api/client/register", adminRotation.sdkAppId, adminRotation.sdkAppSecret, {
      productCode: "ROTATE_APP",
      username: "after_admin_rotate",
      password: "RotateUser123!"
    });

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "rotate.owner",
      password: "RotateOwner123!"
    });

    await postJson(
      baseUrl,
      "/api/developer/members",
      {
        username: "rotate.operator",
        password: "RotateOperator123!",
        displayName: "Rotate Operator",
        role: "operator",
        productCodes: ["ROTATE_APP"]
      },
      ownerSession.token
    );

    const operatorSession = await postJson(baseUrl, "/api/developer/login", {
      username: "rotate.operator",
      password: "RotateOperator123!"
    });

    const forbiddenDeveloperRotate = await postJsonExpectError(
      baseUrl,
      `/api/developer/products/${product.id}/sdk-credentials/rotate`,
      { rotateAppId: true },
      operatorSession.token
    );
    assert.equal(forbiddenDeveloperRotate.status, 403);
    assert.equal(forbiddenDeveloperRotate.error.code, "DEVELOPER_PRODUCT_FORBIDDEN");

    const developerRotation = await postJson(
      baseUrl,
      `/api/developer/products/${product.id}/sdk-credentials/rotate`,
      { rotateAppId: true },
      ownerSession.token
    );
    assert.equal(developerRotation.rotation.rotateAppId, true);
    assert.notEqual(developerRotation.sdkAppId, adminRotation.sdkAppId);
    assert.notEqual(developerRotation.sdkAppSecret, adminRotation.sdkAppSecret);

    const oldAppIdFailure = await signedClientPostExpectError(
      baseUrl,
      "/api/client/register",
      adminRotation.sdkAppId,
      adminRotation.sdkAppSecret,
      {
        productCode: "ROTATE_APP",
        username: "old_appid_user",
        password: "RotateUser123!"
      }
    );
    assert.equal(oldAppIdFailure.status, 401);
    assert.equal(oldAppIdFailure.error.code, "SDK_APP_INVALID");

    await signedClientPost(
      baseUrl,
      "/api/client/register",
      developerRotation.sdkAppId,
      developerRotation.sdkAppSecret,
      {
        productCode: "ROTATE_APP",
        username: "after_developer_rotate",
        password: "RotateUser123!"
      }
    );

    const adminAuditLogs = await getJson(baseUrl, "/api/admin/audit-logs?limit=120", adminSession.token);
    const developerAuditLogs = await getJson(baseUrl, "/api/developer/audit-logs?limit=120", ownerSession.token);
    assert.ok(adminAuditLogs.items.some((entry) => entry.event_type === "product.sdk-credentials.rotate"));
    assert.ok(developerAuditLogs.items.some((entry) => entry.event_type === "product.sdk-credentials.rotate"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("admin and developers can update project profile with scoped permission checks", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "profile.owner",
        password: "ProfileOwner123!",
        displayName: "Profile Owner"
      },
      adminSession.token
    );

    const product = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "PROFILE_APP",
        name: "Profile App",
        description: "Original profile description",
        ownerDeveloperId: owner.id
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "profile.owner",
      password: "ProfileOwner123!"
    });

    await postJson(
      baseUrl,
      "/api/developer/members",
      {
        username: "profile.admin",
        password: "ProfileAdmin123!",
        displayName: "Profile Admin",
        role: "admin",
        productCodes: ["PROFILE_APP"]
      },
      ownerSession.token
    );

    await postJson(
      baseUrl,
      "/api/developer/members",
      {
        username: "profile.operator",
        password: "ProfileOperator123!",
        displayName: "Profile Operator",
        role: "operator",
        productCodes: ["PROFILE_APP"]
      },
      ownerSession.token
    );

    const adminMemberSession = await postJson(baseUrl, "/api/developer/login", {
      username: "profile.admin",
      password: "ProfileAdmin123!"
    });
    const operatorSession = await postJson(baseUrl, "/api/developer/login", {
      username: "profile.operator",
      password: "ProfileOperator123!"
    });

    const developerProfileUpdate = await postJson(
      baseUrl,
      `/api/developer/products/${product.id}/profile`,
      {
        code: "PROFILE_MEMBER_APP",
        name: "Profile Member App",
        description: "Updated by developer admin"
      },
      adminMemberSession.token
    );
    assert.equal(developerProfileUpdate.code, "PROFILE_MEMBER_APP");
    assert.equal(developerProfileUpdate.projectCode, "PROFILE_MEMBER_APP");
    assert.equal(developerProfileUpdate.softwareCode, "PROFILE_MEMBER_APP");
    assert.equal(developerProfileUpdate.name, "Profile Member App");
    assert.equal(developerProfileUpdate.description, "Updated by developer admin");

    const forbiddenOperatorUpdate = await postJsonExpectError(
      baseUrl,
      `/api/developer/products/${product.id}/profile`,
      {
        name: "Operator should not update this"
      },
      operatorSession.token
    );
    assert.equal(forbiddenOperatorUpdate.status, 403);
    assert.equal(forbiddenOperatorUpdate.error.code, "DEVELOPER_PRODUCT_FORBIDDEN");

    const adminProfileUpdate = await postJson(
      baseUrl,
      `/api/admin/products/${product.id}/profile`,
      {
        code: "PROFILE_ADMIN_APP",
        name: "Profile Admin App",
        description: "Updated by administrator"
      },
      adminSession.token
    );
    assert.equal(adminProfileUpdate.code, "PROFILE_ADMIN_APP");
    assert.equal(adminProfileUpdate.name, "Profile Admin App");
    assert.equal(adminProfileUpdate.description, "Updated by administrator");

    const ownerProducts = await getJson(baseUrl, "/api/developer/products", ownerSession.token);
    assert.equal(ownerProducts.length, 1);
    assert.equal(ownerProducts[0].code, "PROFILE_ADMIN_APP");
    assert.equal(ownerProducts[0].description, "Updated by administrator");

    await signedClientPost(
      baseUrl,
      "/api/client/register",
      adminProfileUpdate.sdkAppId,
      adminProfileUpdate.sdkAppSecret,
      {
        productCode: "PROFILE_ADMIN_APP",
        username: "profile_user",
        password: "ProfileUser123!"
      }
    );

    const oldCodeFailure = await signedClientPostExpectError(
      baseUrl,
      "/api/client/register",
      adminProfileUpdate.sdkAppId,
      adminProfileUpdate.sdkAppSecret,
      {
        productCode: "PROFILE_MEMBER_APP",
        username: "old_profile_user",
        password: "ProfileUser123!"
      }
    );
    assert.equal(oldCodeFailure.status, 400);
    assert.equal(oldCodeFailure.error.code, "PRODUCT_MISMATCH");

    const adminAuditLogs = await getJson(baseUrl, "/api/admin/audit-logs?limit=120", adminSession.token);
    const developerAuditLogs = await getJson(baseUrl, "/api/developer/audit-logs?limit=120", ownerSession.token);
    assert.ok(adminAuditLogs.items.some((entry) => entry.event_type === "product.profile.update"));
    assert.ok(developerAuditLogs.items.some((entry) => entry.event_type === "product.profile.update"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("project status control can disable runtime and revoke scoped sessions", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "status.owner",
        password: "StatusOwner123!",
        displayName: "Status Owner"
      },
      adminSession.token
    );

    const product = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "STATUS_APP",
        name: "Status App",
        ownerDeveloperId: owner.id
      },
      adminSession.token
    );

    const policy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "STATUS_APP",
        name: "Status Policy",
        durationDays: 30,
        maxDevices: 1
      },
      adminSession.token
    );

    const batch = await postJson(
      baseUrl,
      "/api/admin/cards/batch",
      {
        productCode: "STATUS_APP",
        policyId: policy.id,
        count: 1,
        prefix: "STATUS"
      },
      adminSession.token
    );

    await signedClientPost(baseUrl, "/api/client/register", product.sdkAppId, product.sdkAppSecret, {
      productCode: "STATUS_APP",
      username: "status_user",
      password: "StatusUser123!"
    });

    await signedClientPost(baseUrl, "/api/client/recharge", product.sdkAppId, product.sdkAppSecret, {
      productCode: "STATUS_APP",
      username: "status_user",
      password: "StatusUser123!",
      cardKey: batch.keys[0]
    });

    const activeLogin = await signedClientPost(baseUrl, "/api/client/login", product.sdkAppId, product.sdkAppSecret, {
      productCode: "STATUS_APP",
      username: "status_user",
      password: "StatusUser123!",
      deviceFingerprint: "status-device-001",
      deviceName: "Status Desktop"
    });
    assert.ok(activeLogin.sessionToken);

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "status.owner",
      password: "StatusOwner123!"
    });

    await postJson(
      baseUrl,
      "/api/developer/members",
      {
        username: "status.admin",
        password: "StatusAdmin123!",
        displayName: "Status Admin",
        role: "admin",
        productCodes: ["STATUS_APP"]
      },
      ownerSession.token
    );

    await postJson(
      baseUrl,
      "/api/developer/members",
      {
        username: "status.operator",
        password: "StatusOperator123!",
        displayName: "Status Operator",
        role: "operator",
        productCodes: ["STATUS_APP"]
      },
      ownerSession.token
    );

    const adminMemberSession = await postJson(baseUrl, "/api/developer/login", {
      username: "status.admin",
      password: "StatusAdmin123!"
    });
    const operatorSession = await postJson(baseUrl, "/api/developer/login", {
      username: "status.operator",
      password: "StatusOperator123!"
    });

    const activeSessionsBeforeDisable = await getJson(
      baseUrl,
      "/api/admin/sessions?productCode=STATUS_APP&status=active",
      adminSession.token
    );
    assert.equal(activeSessionsBeforeDisable.total, 1);

    const disabledProject = await postJson(
      baseUrl,
      `/api/developer/products/${product.id}/status`,
      { status: "disabled" },
      adminMemberSession.token
    );
    assert.equal(disabledProject.status, "disabled");
    assert.equal(disabledProject.changed, true);
    assert.ok(disabledProject.revokedSessions >= 1);

    const activeSessionsAfterDisable = await getJson(
      baseUrl,
      "/api/admin/sessions?productCode=STATUS_APP&status=active",
      adminSession.token
    );
    assert.equal(activeSessionsAfterDisable.total, 0);

    const expiredSessionsAfterDisable = await getJson(
      baseUrl,
      "/api/admin/sessions?productCode=STATUS_APP&status=expired",
      adminSession.token
    );
    assert.equal(expiredSessionsAfterDisable.total, 1);
    assert.equal(expiredSessionsAfterDisable.items[0].revoked_reason, "product_disabled");

    const ownerProductsAfterDisable = await getJson(baseUrl, "/api/developer/products", ownerSession.token);
    assert.equal(ownerProductsAfterDisable.length, 1);
    assert.equal(ownerProductsAfterDisable[0].status, "disabled");

    const disabledRegister = await signedClientPostExpectError(
      baseUrl,
      "/api/client/register",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "STATUS_APP",
        username: "status_user_disabled",
        password: "StatusUser123!"
      }
    );
    assert.equal(disabledRegister.status, 401);
    assert.equal(disabledRegister.error.code, "SDK_APP_INVALID");

    const disabledHeartbeat = await signedClientPostExpectError(
      baseUrl,
      "/api/client/heartbeat",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "STATUS_APP",
        sessionToken: activeLogin.sessionToken,
        deviceFingerprint: "status-device-001"
      }
    );
    assert.equal(disabledHeartbeat.status, 401);
    assert.equal(disabledHeartbeat.error.code, "SDK_APP_INVALID");

    const operatorForbidden = await postJsonExpectError(
      baseUrl,
      `/api/developer/products/${product.id}/status`,
      { status: "active" },
      operatorSession.token
    );
    assert.equal(operatorForbidden.status, 403);
    assert.equal(operatorForbidden.error.code, "DEVELOPER_PRODUCT_FORBIDDEN");

    const reenabledProject = await postJson(
      baseUrl,
      `/api/admin/products/${product.id}/status`,
      { status: "active" },
      adminSession.token
    );
    assert.equal(reenabledProject.status, "active");
    assert.equal(reenabledProject.changed, true);
    assert.equal(reenabledProject.revokedSessions, 0);

    const registerAfterEnable = await signedClientPost(
      baseUrl,
      "/api/client/register",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: "STATUS_APP",
        username: "status_user_reenabled",
        password: "StatusUser123!"
      }
    );
    assert.equal(registerAfterEnable.username, "status_user_reenabled");

    const adminAuditLogs = await getJson(baseUrl, "/api/admin/audit-logs?limit=120", adminSession.token);
    const developerAuditLogs = await getJson(baseUrl, "/api/developer/audit-logs?limit=120", ownerSession.token);
    assert.ok(adminAuditLogs.items.some((entry) => entry.event_type === "product.status"));
    assert.ok(developerAuditLogs.items.some((entry) => entry.event_type === "product.status"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("batch project status control can update multiple scoped projects", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "batch.owner",
        password: "BatchOwner123!",
        displayName: "Batch Owner"
      },
      adminSession.token
    );

    const alphaProduct = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "BATCH_ALPHA",
        name: "Batch Alpha",
        ownerDeveloperId: owner.id
      },
      adminSession.token
    );

    const betaProduct = await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "BATCH_BETA",
        name: "Batch Beta",
        ownerDeveloperId: owner.id
      },
      adminSession.token
    );

    const alphaPolicy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "BATCH_ALPHA",
        name: "Batch Alpha Policy",
        durationDays: 30,
        maxDevices: 1
      },
      adminSession.token
    );

    const betaPolicy = await postJson(
      baseUrl,
      "/api/admin/policies",
      {
        productCode: "BATCH_BETA",
        name: "Batch Beta Policy",
        durationDays: 30,
        maxDevices: 1
      },
      adminSession.token
    );

    const alphaBatch = await postJson(
      baseUrl,
      "/api/admin/cards/batch",
      {
        productCode: "BATCH_ALPHA",
        policyId: alphaPolicy.id,
        count: 1,
        prefix: "BALPHA"
      },
      adminSession.token
    );

    const betaBatch = await postJson(
      baseUrl,
      "/api/admin/cards/batch",
      {
        productCode: "BATCH_BETA",
        policyId: betaPolicy.id,
        count: 1,
        prefix: "BBETA"
      },
      adminSession.token
    );

    await signedClientPost(baseUrl, "/api/client/register", alphaProduct.sdkAppId, alphaProduct.sdkAppSecret, {
      productCode: "BATCH_ALPHA",
      username: "batch_alpha_user",
      password: "BatchAlphaUser123!"
    });

    await signedClientPost(baseUrl, "/api/client/recharge", alphaProduct.sdkAppId, alphaProduct.sdkAppSecret, {
      productCode: "BATCH_ALPHA",
      username: "batch_alpha_user",
      password: "BatchAlphaUser123!",
      cardKey: alphaBatch.keys[0]
    });

    const alphaLogin = await signedClientPost(baseUrl, "/api/client/login", alphaProduct.sdkAppId, alphaProduct.sdkAppSecret, {
      productCode: "BATCH_ALPHA",
      username: "batch_alpha_user",
      password: "BatchAlphaUser123!",
      deviceFingerprint: "batch-alpha-device",
      deviceName: "Batch Alpha Desktop"
    });
    assert.ok(alphaLogin.sessionToken);

    await signedClientPost(baseUrl, "/api/client/register", betaProduct.sdkAppId, betaProduct.sdkAppSecret, {
      productCode: "BATCH_BETA",
      username: "batch_beta_user",
      password: "BatchBetaUser123!"
    });

    await signedClientPost(baseUrl, "/api/client/recharge", betaProduct.sdkAppId, betaProduct.sdkAppSecret, {
      productCode: "BATCH_BETA",
      username: "batch_beta_user",
      password: "BatchBetaUser123!",
      cardKey: betaBatch.keys[0]
    });

    const betaLogin = await signedClientPost(baseUrl, "/api/client/login", betaProduct.sdkAppId, betaProduct.sdkAppSecret, {
      productCode: "BATCH_BETA",
      username: "batch_beta_user",
      password: "BatchBetaUser123!",
      deviceFingerprint: "batch-beta-device",
      deviceName: "Batch Beta Desktop"
    });
    assert.ok(betaLogin.sessionToken);

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "batch.owner",
      password: "BatchOwner123!"
    });

    await postJson(
      baseUrl,
      "/api/developer/members",
      {
        username: "batch.admin",
        password: "BatchAdmin123!",
        displayName: "Batch Admin",
        role: "admin",
        productCodes: ["BATCH_ALPHA", "BATCH_BETA"]
      },
      ownerSession.token
    );

    await postJson(
      baseUrl,
      "/api/developer/members",
      {
        username: "batch.operator",
        password: "BatchOperator123!",
        displayName: "Batch Operator",
        role: "operator",
        productCodes: ["BATCH_ALPHA", "BATCH_BETA"]
      },
      ownerSession.token
    );

    const adminMemberSession = await postJson(baseUrl, "/api/developer/login", {
      username: "batch.admin",
      password: "BatchAdmin123!"
    });

    const operatorSession = await postJson(baseUrl, "/api/developer/login", {
      username: "batch.operator",
      password: "BatchOperator123!"
    });

    const disableBatch = await postJson(
      baseUrl,
      "/api/developer/products/status/batch",
      {
        productIds: [alphaProduct.id, betaProduct.id],
        status: "disabled"
      },
      adminMemberSession.token
    );
    assert.equal(disableBatch.status, "disabled");
    assert.equal(disableBatch.total, 2);
    assert.equal(disableBatch.changed, 2);
    assert.equal(disableBatch.unchanged, 0);
    assert.ok(disableBatch.revokedSessions >= 2);
    assert.equal(disableBatch.items.length, 2);
    assert.deepEqual(disableBatch.items.map((item) => item.status).sort(), ["disabled", "disabled"]);

    const alphaSessionsAfterDisable = await getJson(
      baseUrl,
      "/api/admin/sessions?productCode=BATCH_ALPHA&status=active",
      adminSession.token
    );
    assert.equal(alphaSessionsAfterDisable.total, 0);

    const betaSessionsAfterDisable = await getJson(
      baseUrl,
      "/api/admin/sessions?productCode=BATCH_BETA&status=active",
      adminSession.token
    );
    assert.equal(betaSessionsAfterDisable.total, 0);

    const ownerProductsAfterDisable = await getJson(baseUrl, "/api/developer/products", ownerSession.token);
    const disabledCodes = ownerProductsAfterDisable
      .filter((item) => ["BATCH_ALPHA", "BATCH_BETA"].includes(item.code))
      .map((item) => item.status)
      .sort();
    assert.deepEqual(disabledCodes, ["disabled", "disabled"]);

    const operatorForbidden = await postJsonExpectError(
      baseUrl,
      "/api/developer/products/status/batch",
      {
        productIds: [alphaProduct.id],
        status: "active"
      },
      operatorSession.token
    );
    assert.equal(operatorForbidden.status, 403);
    assert.equal(operatorForbidden.error.code, "DEVELOPER_PRODUCT_FORBIDDEN");

    const reenableBatch = await postJson(
      baseUrl,
      "/api/admin/products/status/batch",
      {
        projectCodes: ["BATCH_ALPHA", "BATCH_BETA"],
        status: "active"
      },
      adminSession.token
    );
    assert.equal(reenableBatch.status, "active");
    assert.equal(reenableBatch.total, 2);
    assert.equal(reenableBatch.changed, 2);
    assert.equal(reenableBatch.unchanged, 0);
    assert.equal(reenableBatch.revokedSessions, 0);

    const registerAfterEnable = await signedClientPost(baseUrl, "/api/client/register", alphaProduct.sdkAppId, alphaProduct.sdkAppSecret, {
      productCode: "BATCH_ALPHA",
      username: "batch_alpha_return",
      password: "BatchAlphaReturn123!"
    });
    assert.equal(registerAfterEnable.username, "batch_alpha_return");

    const adminAuditLogs = await getJson(baseUrl, "/api/admin/audit-logs?limit=200", adminSession.token);
    const developerAuditLogs = await getJson(baseUrl, "/api/developer/audit-logs?limit=200", adminMemberSession.token);
    assert.ok(adminAuditLogs.items.some((entry) => entry.event_type === "product.status.batch"));
    assert.ok(developerAuditLogs.items.some((entry) => entry.event_type === "product.status.batch"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("batch project feature config control can update multiple scoped projects", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "feature.owner",
        password: "FeatureOwner123!",
        displayName: "Feature Owner"
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "feature.owner",
      password: "FeatureOwner123!"
    });

    const alphaProduct = await postJson(
      baseUrl,
      "/api/developer/products",
      {
        code: "FEAT_ALPHA",
        name: "Feature Alpha",
        featureConfig: {
          allowCardRecharge: false
        }
      },
      ownerSession.token
    );

    const betaProduct = await postJson(
      baseUrl,
      "/api/developer/products",
      {
        code: "FEAT_BETA",
        name: "Feature Beta",
        featureConfig: {
          allowRegister: false,
          allowNotices: false
        }
      },
      ownerSession.token
    );

    await postJson(
      baseUrl,
      "/api/developer/members",
      {
        username: "feature.admin",
        password: "FeatureAdmin123!",
        displayName: "Feature Admin",
        role: "admin",
        productCodes: ["FEAT_ALPHA", "FEAT_BETA"]
      },
      ownerSession.token
    );

    await postJson(
      baseUrl,
      "/api/developer/members",
      {
        username: "feature.operator",
        password: "FeatureOperator123!",
        displayName: "Feature Operator",
        role: "operator",
        productCodes: ["FEAT_ALPHA", "FEAT_BETA"]
      },
      ownerSession.token
    );

    const adminMemberSession = await postJson(baseUrl, "/api/developer/login", {
      username: "feature.admin",
      password: "FeatureAdmin123!"
    });

    const operatorSession = await postJson(baseUrl, "/api/developer/login", {
      username: "feature.operator",
      password: "FeatureOperator123!"
    });

    const developerBatch = await postJson(
      baseUrl,
      "/api/developer/products/feature-config/batch",
      {
        productIds: [alphaProduct.id, betaProduct.id],
        allowRegister: false,
        allowAccountLogin: true,
        allowCardLogin: false,
        allowCardRecharge: false,
        allowVersionCheck: true,
        allowNotices: false,
        allowClientUnbind: true
      },
      adminMemberSession.token
    );
    assert.equal(developerBatch.total, 2);
    assert.equal(developerBatch.changed, 2);
    assert.equal(developerBatch.unchanged, 0);
    assert.equal(developerBatch.items.length, 2);
    assert.deepEqual(developerBatch.items.map((item) => item.code).sort(), ["FEAT_ALPHA", "FEAT_BETA"]);
    assert.ok(developerBatch.items.every((item) => item.featureConfig.allowRegister === false));
    assert.ok(developerBatch.items.every((item) => item.featureConfig.allowCardLogin === false));
    assert.ok(developerBatch.items.every((item) => item.featureConfig.allowCardRecharge === false));
    assert.ok(developerBatch.items.every((item) => item.featureConfig.allowNotices === false));

    const operatorForbidden = await postJsonExpectError(
      baseUrl,
      "/api/developer/products/feature-config/batch",
      {
        productIds: [alphaProduct.id],
        allowRegister: true
      },
      operatorSession.token
    );
    assert.equal(operatorForbidden.status, 403);
    assert.equal(operatorForbidden.error.code, "DEVELOPER_PRODUCT_FORBIDDEN");

    const adminBatch = await postJson(
      baseUrl,
      "/api/admin/products/feature-config/batch",
      {
        projectCodes: ["FEAT_ALPHA", "FEAT_BETA"],
        featureConfig: {
          allowRegister: true,
          allowAccountLogin: true,
          allowCardLogin: true,
          allowCardRecharge: true,
          allowVersionCheck: true,
          allowNotices: true,
          allowClientUnbind: true
        }
      },
      adminSession.token
    );
    assert.equal(adminBatch.total, 2);
    assert.equal(adminBatch.changed, 2);
    assert.equal(adminBatch.unchanged, 0);
    assert.ok(adminBatch.items.every((item) => item.featureConfig.allowRegister === true));
    assert.ok(adminBatch.items.every((item) => item.featureConfig.allowCardLogin === true));
    assert.ok(adminBatch.items.every((item) => item.featureConfig.allowCardRecharge === true));
    assert.ok(adminBatch.items.every((item) => item.featureConfig.allowNotices === true));

    const ownerProducts = await getJson(baseUrl, "/api/developer/products", ownerSession.token);
    const updatedProducts = ownerProducts.filter((item) => ["FEAT_ALPHA", "FEAT_BETA"].includes(item.code));
    assert.equal(updatedProducts.length, 2);
    assert.ok(updatedProducts.every((item) => item.featureConfig.allowRegister === true));
    assert.ok(updatedProducts.every((item) => item.featureConfig.allowCardLogin === true));
    assert.ok(updatedProducts.every((item) => item.featureConfig.allowCardRecharge === true));
    assert.ok(updatedProducts.every((item) => item.featureConfig.allowNotices === true));

    const adminAuditLogs = await getJson(baseUrl, "/api/admin/audit-logs?limit=200", adminSession.token);
    const developerAuditLogs = await getJson(baseUrl, "/api/developer/audit-logs?limit=200", adminMemberSession.token);
    assert.ok(adminAuditLogs.items.some((entry) => entry.event_type === "product.feature-config.batch"));
    assert.ok(developerAuditLogs.items.some((entry) => entry.event_type === "product.feature-config.batch"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("batch project sdk credential rotation can rotate multiple scoped projects", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "batch.rotate.owner",
        password: "BatchRotateOwner123!",
        displayName: "Batch Rotate Owner"
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "batch.rotate.owner",
      password: "BatchRotateOwner123!"
    });

    const alphaProduct = await postJson(
      baseUrl,
      "/api/developer/products",
      {
        code: "BROT_ALPHA",
        name: "Batch Rotate Alpha"
      },
      ownerSession.token
    );

    const betaProduct = await postJson(
      baseUrl,
      "/api/developer/products",
      {
        code: "BROT_BETA",
        name: "Batch Rotate Beta"
      },
      ownerSession.token
    );

    const originalCredentials = new Map([
      [alphaProduct.code, { sdkAppId: alphaProduct.sdkAppId, sdkAppSecret: alphaProduct.sdkAppSecret }],
      [betaProduct.code, { sdkAppId: betaProduct.sdkAppId, sdkAppSecret: betaProduct.sdkAppSecret }]
    ]);

    await signedClientPost(baseUrl, "/api/client/register", alphaProduct.sdkAppId, alphaProduct.sdkAppSecret, {
      productCode: "BROT_ALPHA",
      username: "brot_alpha_before",
      password: "BatchRotateUser123!"
    });

    await signedClientPost(baseUrl, "/api/client/register", betaProduct.sdkAppId, betaProduct.sdkAppSecret, {
      productCode: "BROT_BETA",
      username: "brot_beta_before",
      password: "BatchRotateUser123!"
    });

    await postJson(
      baseUrl,
      "/api/developer/members",
      {
        username: "batch.rotate.admin",
        password: "BatchRotateAdmin123!",
        displayName: "Batch Rotate Admin",
        role: "admin",
        productCodes: ["BROT_ALPHA", "BROT_BETA"]
      },
      ownerSession.token
    );

    await postJson(
      baseUrl,
      "/api/developer/members",
      {
        username: "batch.rotate.operator",
        password: "BatchRotateOperator123!",
        displayName: "Batch Rotate Operator",
        role: "operator",
        productCodes: ["BROT_ALPHA", "BROT_BETA"]
      },
      ownerSession.token
    );

    const adminMemberSession = await postJson(baseUrl, "/api/developer/login", {
      username: "batch.rotate.admin",
      password: "BatchRotateAdmin123!"
    });

    const operatorSession = await postJson(baseUrl, "/api/developer/login", {
      username: "batch.rotate.operator",
      password: "BatchRotateOperator123!"
    });

    const developerBatch = await postJson(
      baseUrl,
      "/api/developer/products/sdk-credentials/rotate/batch",
      {
        productIds: [alphaProduct.id, betaProduct.id],
        rotateAppId: false
      },
      adminMemberSession.token
    );
    assert.equal(developerBatch.rotateAppId, false);
    assert.equal(developerBatch.total, 2);
    assert.equal(developerBatch.items.length, 2);

    const developerBatchByCode = new Map(developerBatch.items.map((item) => [item.code, item]));
    for (const code of ["BROT_ALPHA", "BROT_BETA"]) {
      const original = originalCredentials.get(code);
      const rotated = developerBatchByCode.get(code);
      assert.ok(rotated);
      assert.equal(rotated.sdkAppId, original.sdkAppId);
      assert.notEqual(rotated.sdkAppSecret, original.sdkAppSecret);
      assert.equal(rotated.rotation.rotateAppId, false);
      assert.equal(rotated.rotation.previousSdkAppId, original.sdkAppId);
    }

    const oldSecretFailure = await signedClientPostExpectError(
      baseUrl,
      "/api/client/register",
      originalCredentials.get("BROT_ALPHA").sdkAppId,
      originalCredentials.get("BROT_ALPHA").sdkAppSecret,
      {
        productCode: "BROT_ALPHA",
        username: "brot_alpha_old_secret",
        password: "BatchRotateUser123!"
      }
    );
    assert.equal(oldSecretFailure.status, 401);
    assert.equal(oldSecretFailure.error.code, "SDK_SIGNATURE_INVALID");

    const alphaAfterDeveloperRotate = developerBatchByCode.get("BROT_ALPHA");
    await signedClientPost(
      baseUrl,
      "/api/client/register",
      alphaAfterDeveloperRotate.sdkAppId,
      alphaAfterDeveloperRotate.sdkAppSecret,
      {
        productCode: "BROT_ALPHA",
        username: "brot_alpha_after_member_rotate",
        password: "BatchRotateUser123!"
      }
    );

    const operatorForbidden = await postJsonExpectError(
      baseUrl,
      "/api/developer/products/sdk-credentials/rotate/batch",
      {
        productIds: [alphaProduct.id],
        rotateAppId: true
      },
      operatorSession.token
    );
    assert.equal(operatorForbidden.status, 403);
    assert.equal(operatorForbidden.error.code, "DEVELOPER_PRODUCT_FORBIDDEN");

    const adminBatch = await postJson(
      baseUrl,
      "/api/admin/products/sdk-credentials/rotate/batch",
      {
        projectCodes: ["BROT_ALPHA", "BROT_BETA"],
        rotateAppId: true
      },
      adminSession.token
    );
    assert.equal(adminBatch.rotateAppId, true);
    assert.equal(adminBatch.total, 2);
    assert.equal(adminBatch.items.length, 2);

    const adminBatchByCode = new Map(adminBatch.items.map((item) => [item.code, item]));
    for (const code of ["BROT_ALPHA", "BROT_BETA"]) {
      const previous = developerBatchByCode.get(code);
      const rotated = adminBatchByCode.get(code);
      assert.ok(rotated);
      assert.notEqual(rotated.sdkAppId, previous.sdkAppId);
      assert.notEqual(rotated.sdkAppSecret, previous.sdkAppSecret);
      assert.equal(rotated.rotation.rotateAppId, true);
      assert.equal(rotated.rotation.previousSdkAppId, previous.sdkAppId);
    }

    const oldAppIdFailure = await signedClientPostExpectError(
      baseUrl,
      "/api/client/register",
      developerBatchByCode.get("BROT_BETA").sdkAppId,
      developerBatchByCode.get("BROT_BETA").sdkAppSecret,
      {
        productCode: "BROT_BETA",
        username: "brot_beta_old_appid",
        password: "BatchRotateUser123!"
      }
    );
    assert.equal(oldAppIdFailure.status, 401);
    assert.equal(oldAppIdFailure.error.code, "SDK_APP_INVALID");

    const betaAfterAdminRotate = adminBatchByCode.get("BROT_BETA");
    await signedClientPost(
      baseUrl,
      "/api/client/register",
      betaAfterAdminRotate.sdkAppId,
      betaAfterAdminRotate.sdkAppSecret,
      {
        productCode: "BROT_BETA",
        username: "brot_beta_after_admin_rotate",
        password: "BatchRotateUser123!"
      }
    );

    const adminAuditLogs = await getJson(baseUrl, "/api/admin/audit-logs?limit=200", adminSession.token);
    const developerAuditLogs = await getJson(baseUrl, "/api/developer/audit-logs?limit=200", adminMemberSession.token);
    assert.ok(adminAuditLogs.items.some((entry) => entry.event_type === "product.sdk-credentials.rotate.batch"));
    assert.ok(developerAuditLogs.items.some((entry) => entry.event_type === "product.sdk-credentials.rotate.batch"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("batch project sdk credential export can bundle selected projects with scoped access", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "export.bundle.owner",
        password: "ExportBundleOwner123!",
        displayName: "Export Bundle Owner"
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "export.bundle.owner",
      password: "ExportBundleOwner123!"
    });

    const alphaProduct = await postJson(
      baseUrl,
      "/api/developer/products",
      {
        code: "EXPBUNDLE_ALPHA",
        name: "Export Bundle Alpha"
      },
      ownerSession.token
    );

    const betaProduct = await postJson(
      baseUrl,
      "/api/developer/products",
      {
        code: "EXPBUNDLE_BETA",
        name: "Export Bundle Beta"
      },
      ownerSession.token
    );

    await postJson(
      baseUrl,
      "/api/developer/members",
      {
        username: "export.bundle.viewer",
        password: "ExportBundleViewer123!",
        displayName: "Export Bundle Viewer",
        role: "viewer",
        productCodes: ["EXPBUNDLE_ALPHA"]
      },
      ownerSession.token
    );

    const viewerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "export.bundle.viewer",
      password: "ExportBundleViewer123!"
    });

    const developerExport = await postJson(
      baseUrl,
      "/api/developer/products/sdk-credentials/export",
      {
        productIds: [alphaProduct.id]
      },
      viewerSession.token
    );
    assert.equal(developerExport.total, 1);
    assert.equal(developerExport.items.length, 1);
    assert.equal(developerExport.items[0].code, "EXPBUNDLE_ALPHA");
    assert.equal(developerExport.items[0].sdkAppId, alphaProduct.sdkAppId);
    assert.equal(developerExport.items[0].sdkAppSecret, alphaProduct.sdkAppSecret);
    assert.match(developerExport.csvText, /^code,projectCode,softwareCode,name,status,sdkAppId,sdkAppSecret,updatedAt/m);
    assert.match(developerExport.csvText, /EXPBUNDLE_ALPHA/);
    assert.equal(developerExport.envFiles.length, 1);
    assert.equal(developerExport.envFiles[0].fileName, "EXPBUNDLE_ALPHA.env");
    assert.match(developerExport.envFiles[0].content, /RS_PROJECT_CODE=EXPBUNDLE_ALPHA/);
    assert.match(developerExport.envFiles[0].content, new RegExp(`RS_SDK_APP_ID=${alphaProduct.sdkAppId}`));
    assert.match(developerExport.envFiles[0].content, new RegExp(`RS_SDK_APP_SECRET=${alphaProduct.sdkAppSecret}`));
    assert.match(developerExport.envFiles[0].content, new RegExp(`RS_HTTP_BASE_URL=${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(developerExport.envBundleText, /### EXPBUNDLE_ALPHA\.env/);

    const developerEnvDownload = await postText(
      baseUrl,
      "/api/developer/products/sdk-credentials/export/download",
      {
        productIds: [alphaProduct.id],
        format: "env"
      },
      viewerSession.token
    );
    assert.equal(developerEnvDownload.contentType, "text/plain; charset=utf-8");
    assert.match(developerEnvDownload.contentDisposition || "", /rocksolid-sdk-credentials-.*-env\.txt/);
    assert.match(developerEnvDownload.body, /### EXPBUNDLE_ALPHA\.env/);
    assert.match(developerEnvDownload.body, /RS_PROJECT_CODE=EXPBUNDLE_ALPHA/);

    const developerZipDownload = await postBinary(
      baseUrl,
      "/api/developer/products/sdk-credentials/export/download",
      {
        productIds: [alphaProduct.id],
        format: "zip"
      },
      viewerSession.token
    );
    assert.equal(developerZipDownload.contentType, "application/zip");
    assert.match(developerZipDownload.contentDisposition || "", /rocksolid-sdk-credentials-.*\.zip/);
    assert.equal(developerZipDownload.body.subarray(0, 4).toString("latin1"), "PK\u0003\u0004");
    const developerZipText = developerZipDownload.body.toString("latin1");
    assert.match(developerZipText, /EXPBUNDLE_ALPHA\.env/);
    assert.match(developerZipText, /rocksolid-sdk-credentials-.*\.csv/);
    assert.match(developerZipText, /code,projectCode,softwareCode,name,status,sdkAppId,sdkAppSecret,updatedAt/);
    assert.match(developerZipText, /SHA256SUMS\.txt/);

    const developerChecksumsDownload = await postText(
      baseUrl,
      "/api/developer/products/sdk-credentials/export/download",
      {
        productIds: [alphaProduct.id],
        format: "checksums"
      },
      viewerSession.token
    );
    assert.equal(developerChecksumsDownload.contentType, "text/plain; charset=utf-8");
    assert.match(developerChecksumsDownload.contentDisposition || "", /rocksolid-sdk-credentials-.*-sha256\.txt/);
    assert.match(developerChecksumsDownload.body, /rocksolid-sdk-credentials-.*\.json/);
    assert.match(developerChecksumsDownload.body, /rocksolid-sdk-credentials-.*\.csv/);
    assert.match(developerChecksumsDownload.body, /env\/EXPBUNDLE_ALPHA\.env/);

    const viewerForbidden = await postJsonExpectError(
      baseUrl,
      "/api/developer/products/sdk-credentials/export",
      {
        productIds: [betaProduct.id]
      },
      viewerSession.token
    );
    assert.equal(viewerForbidden.status, 403);
    assert.equal(viewerForbidden.error.code, "DEVELOPER_PRODUCT_FORBIDDEN");

    const adminExport = await postJson(
      baseUrl,
      "/api/admin/products/sdk-credentials/export",
      {
        projectCodes: ["EXPBUNDLE_ALPHA", "EXPBUNDLE_BETA"]
      },
      adminSession.token
    );
    assert.equal(adminExport.total, 2);
    assert.equal(adminExport.items.length, 2);
    assert.ok(adminExport.items.every((item) => item.ownerDeveloper?.id === owner.id));
    assert.ok(adminExport.items.every((item) => item.ownerDeveloper?.username === "export.bundle.owner"));
    assert.match(adminExport.csvText, /ownerUsername,ownerDisplayName,ownerStatus/);
    assert.match(adminExport.csvText, /EXPBUNDLE_ALPHA/);
    assert.match(adminExport.csvText, /EXPBUNDLE_BETA/);
    assert.equal(adminExport.envFiles.length, 2);

    const adminCsvDownload = await postText(
      baseUrl,
      "/api/admin/products/sdk-credentials/export/download",
      {
        projectCodes: ["EXPBUNDLE_ALPHA", "EXPBUNDLE_BETA"],
        format: "csv"
      },
      adminSession.token
    );
    assert.equal(adminCsvDownload.contentType, "text/csv; charset=utf-8");
    assert.match(adminCsvDownload.contentDisposition || "", /rocksolid-sdk-credentials-.*\.csv/);
    assert.match(adminCsvDownload.body, /ownerUsername,ownerDisplayName,ownerStatus/);
    assert.match(adminCsvDownload.body, /EXPBUNDLE_BETA/);

    const adminZipDownload = await postBinary(
      baseUrl,
      "/api/admin/products/sdk-credentials/export/download",
      {
        projectCodes: ["EXPBUNDLE_ALPHA", "EXPBUNDLE_BETA"],
        format: "zip"
      },
      adminSession.token
    );
    assert.equal(adminZipDownload.contentType, "application/zip");
    assert.match(adminZipDownload.contentDisposition || "", /rocksolid-sdk-credentials-.*\.zip/);
    assert.equal(adminZipDownload.body.subarray(0, 4).toString("latin1"), "PK\u0003\u0004");
    const adminZipText = adminZipDownload.body.toString("latin1");
    assert.match(adminZipText, /EXPBUNDLE_ALPHA\.env/);
    assert.match(adminZipText, /EXPBUNDLE_BETA\.env/);
    assert.match(adminZipText, /ownerUsername,ownerDisplayName,ownerStatus/);
    assert.match(adminZipText, /SHA256SUMS\.txt/);

    const adminAuditLogs = await getJson(baseUrl, "/api/admin/audit-logs?limit=200", adminSession.token);
    const ownerAuditLogs = await getJson(baseUrl, "/api/developer/audit-logs?limit=200", ownerSession.token);
    assert.ok(adminAuditLogs.items.some((entry) => entry.event_type === "product.sdk-credentials.export.batch"));
    assert.ok(ownerAuditLogs.items.some((entry) => entry.event_type === "product.sdk-credentials.export.batch"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("batch project integration package export can bundle selected projects with scoped access", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "integration.bundle.owner",
        password: "IntegrationBundleOwner123!",
        displayName: "Integration Bundle Owner"
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "integration.bundle.owner",
      password: "IntegrationBundleOwner123!"
    });

    const alphaProduct = await postJson(
      baseUrl,
      "/api/developer/products",
      {
        code: "INTBUNDLE_ALPHA",
        name: "Integration Bundle Alpha",
        featureConfig: {
          allowCardLogin: false,
          requireStartupBootstrap: false,
          requireLocalTokenValidation: false
        }
      },
      ownerSession.token
    );

    const betaProduct = await postJson(
      baseUrl,
      "/api/developer/products",
      {
        code: "INTBUNDLE_BETA",
        name: "Integration Bundle Beta"
      },
      ownerSession.token
    );

    await postJson(
      baseUrl,
      "/api/developer/members",
      {
        username: "integration.bundle.viewer",
        password: "IntegrationBundleViewer123!",
        displayName: "Integration Bundle Viewer",
        role: "viewer",
        productCodes: ["INTBUNDLE_ALPHA"]
      },
      ownerSession.token
    );

    const viewerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "integration.bundle.viewer",
      password: "IntegrationBundleViewer123!"
    });

    const developerExport = await postJson(
      baseUrl,
      "/api/developer/products/integration-packages/export",
      {
        productIds: [alphaProduct.id]
      },
      viewerSession.token
    );
    assert.equal(developerExport.total, 1);
    assert.equal(developerExport.items.length, 1);
    assert.equal(developerExport.items[0].code, "INTBUNDLE_ALPHA");
    assert.equal(developerExport.items[0].fileName, "rocksolid-integration-INTBUNDLE_ALPHA.json");
    assert.equal(developerExport.items[0].manifest.project.code, "INTBUNDLE_ALPHA");
    assert.equal(developerExport.items[0].manifest.project.featureConfig.allowCardLogin, false);
    assert.equal(developerExport.items[0].manifest.clientHardening.profile, "relaxed");
    assert.equal(developerExport.items[0].manifest.startupPreview.clientHardening.profile, "relaxed");
    assert.equal(developerExport.items[0].manifest.startupPreview.request.includeTokenKeys, false);
    assert.equal(developerExport.items[0].manifest.credentials.sdkAppId, alphaProduct.sdkAppId);
    assert.equal(developerExport.items[0].manifest.credentials.sdkAppSecret, alphaProduct.sdkAppSecret);
    assert.equal(developerExport.items[0].manifest.actor.type, "member");
    assert.equal(developerExport.items[0].manifest.actor.role, "viewer");
    assert.match(developerExport.items[0].snippets.cppQuickstart, /rocksolid::LicenseClientWin/);
    assert.match(developerExport.items[0].snippets.cppQuickstart, /INTBUNDLE_ALPHA/);
    assert.match(developerExport.items[0].snippets.cppQuickstart, /Startup bootstrap is still recommended/);
    assert.equal(developerExport.items[0].snippets.hostSkeletonFileName, "INTBUNDLE_ALPHA-host-skeleton.cpp");
    assert.match(developerExport.items[0].snippets.hostSkeletonCpp, /FeatureGate/);
    assert.match(developerExport.items[0].snippets.hostSkeletonCpp, /optional local validation/);
    assert.equal(developerExport.items[0].snippets.hardeningFileName, "INTBUNDLE_ALPHA-hardening-guide.txt");
    assert.match(developerExport.items[0].snippets.hardeningGuide, /Profile: RELAXED/);
    assert.match(developerExport.items[0].snippets.hardeningGuide, /Project-level Controls:/);
    assert.match(
      developerExport.items[0].snippets.envTemplate,
      new RegExp(`RS_HTTP_BASE_URL=${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
    assert.match(developerExport.items[0].snippets.envTemplate, /RS_REQUIRE_STARTUP_BOOTSTRAP=false/);
    assert.match(developerExport.items[0].snippets.envTemplate, /RS_REQUIRE_LOCAL_TOKEN_VALIDATION=false/);
    assert.match(developerExport.items[0].snippets.envTemplate, /RS_INCLUDE_TOKEN_KEYS=false/);
    assert.match(developerExport.items[0].snippets.envTemplate, /RS_RUN_NETWORK_DEMO=false/);
    assert.match(developerExport.items[0].snippets.envTemplate, /RS_DEMO_USERNAME=demo_user/);
    assert.equal(developerExport.items[0].snippets.hostConfigFileName, "rocksolid_host_config.env");
    assert.match(developerExport.items[0].snippets.hostConfigEnv, /Copy this file to sdk\/examples\/cmake_cpp_host_consumer\/rocksolid_host_config\.env/);
    assert.match(developerExport.items[0].snippets.hostConfigEnv, /RS_PROJECT_CODE=INTBUNDLE_ALPHA/);
    assert.equal(developerExport.items[0].snippets.cmakeFileName, "CMakeLists.txt");
    assert.match(developerExport.items[0].snippets.cmakeConsumerTemplate, /find_package\(RockSolidSDK CONFIG REQUIRED/);
    assert.match(developerExport.items[0].snippets.cmakeConsumerTemplate, /rocksolid_sdk_cmake_dir/i);
    assert.match(developerExport.items[0].snippets.vs2022SolutionFileName, /INTBUNDLE_ALPHA_host_consumer\.sln/i);
    assert.match(developerExport.items[0].snippets.vs2022SolutionTemplate, /Visual Studio Solution File, Format Version 12\.00/);
    assert.match(developerExport.items[0].snippets.vs2022SolutionTemplate, /INTBUNDLE_ALPHA_host_consumer\.vcxproj/);
    assert.match(developerExport.items[0].snippets.vs2022ProjectFileName, /INTBUNDLE_ALPHA_host_consumer\.vcxproj/i);
    assert.match(developerExport.items[0].snippets.vs2022ProjectTemplate, /PlatformToolset>v143</);
    assert.match(developerExport.items[0].snippets.vs2022ProjectTemplate, /ROCKSOLID_SDK_ROOT/);
    assert.match(developerExport.items[0].snippets.vs2022ProjectTemplate, /UseDebugLibraries>false</);
    assert.match(developerExport.items[0].snippets.vs2022ProjectTemplate, /rocksolid_host_config\.env/);
    assert.match(developerExport.items[0].snippets.vs2022ProjectTemplate, /INTBUNDLE_ALPHA_vs2022_quickstart\.md/);
    assert.match(developerExport.items[0].snippets.vs2022ProjectTemplate, /Import Project="RockSolidSDK\.props"/);
    assert.match(developerExport.items[0].snippets.vs2022ProjectTemplate, /Import Project="RockSolidSDK\.local\.props"/);
    assert.match(developerExport.items[0].snippets.vs2022FiltersFileName, /INTBUNDLE_ALPHA_host_consumer\.vcxproj\.filters/i);
    assert.match(developerExport.items[0].snippets.vs2022FiltersTemplate, /Docs/);
    assert.equal(developerExport.items[0].snippets.vs2022PropsFileName, "RockSolidSDK.props");
    assert.match(developerExport.items[0].snippets.vs2022PropsTemplate, /ROCKSOLID_SDK_ROOT/);
    assert.match(developerExport.items[0].snippets.vs2022PropsTemplate, /AdditionalLibraryDirectories>/);
    assert.equal(developerExport.items[0].snippets.vs2022LocalPropsFileName, "RockSolidSDK.local.props");
    assert.match(developerExport.items[0].snippets.vs2022LocalPropsTemplate, /ROCKSOLID_SDK_ROOT_OVERRIDE/);
    assert.match(developerExport.items[0].snippets.vs2022GuideFileName, /INTBUNDLE_ALPHA_vs2022_quickstart\.md/i);
    assert.match(developerExport.items[0].snippets.vs2022GuideText, /VS2022 Quickstart for INTBUNDLE_ALPHA/);
    assert.match(developerExport.items[0].snippets.vs2022GuideText, /RockSolidSDK\.local\.props/);
    assert.equal(developerExport.manifestFiles.length, 1);
    assert.equal(developerExport.manifestFiles[0].fileName, "rocksolid-integration-INTBUNDLE_ALPHA.json");
    assert.match(developerExport.manifestFiles[0].content, /"code": "INTBUNDLE_ALPHA"/);
    assert.equal(developerExport.envFiles[0].fileName, "INTBUNDLE_ALPHA.env");
    assert.equal(developerExport.hostConfigFiles[0].fileName, "INTBUNDLE_ALPHA-rocksolid_host_config.env");
    assert.equal(developerExport.cmakeFiles[0].fileName, "INTBUNDLE_ALPHA/CMakeLists.txt");
    assert.equal(developerExport.vs2022GuideFiles[0].fileName, "INTBUNDLE_ALPHA/INTBUNDLE_ALPHA_vs2022_quickstart.md");
    assert.equal(developerExport.vs2022SolutionFiles[0].fileName, "INTBUNDLE_ALPHA/INTBUNDLE_ALPHA_host_consumer.sln");
    assert.equal(developerExport.vs2022Files[0].fileName, "INTBUNDLE_ALPHA/INTBUNDLE_ALPHA_host_consumer.vcxproj");
    assert.equal(developerExport.vs2022FiltersFiles[0].fileName, "INTBUNDLE_ALPHA/INTBUNDLE_ALPHA_host_consumer.vcxproj.filters");
    assert.equal(developerExport.vs2022PropsFiles[0].fileName, "INTBUNDLE_ALPHA/RockSolidSDK.props");
    assert.equal(developerExport.vs2022LocalPropsFiles[0].fileName, "INTBUNDLE_ALPHA/RockSolidSDK.local.props");
    assert.equal(developerExport.cppFiles[0].fileName, "INTBUNDLE_ALPHA.cpp");
    assert.equal(developerExport.hostSkeletonFiles[0].fileName, "INTBUNDLE_ALPHA-host-skeleton.cpp");
    assert.match(developerExport.manifestBundleText, /### rocksolid-integration-INTBUNDLE_ALPHA\.json/);
    assert.match(developerExport.cppBundleText, /### INTBUNDLE_ALPHA\.cpp/);
    assert.match(developerExport.hostConfigBundleText, /### INTBUNDLE_ALPHA-rocksolid_host_config\.env/);
    assert.match(developerExport.cmakeBundleText, /### INTBUNDLE_ALPHA\/CMakeLists\.txt/);
    assert.match(developerExport.vs2022GuideBundleText, /### INTBUNDLE_ALPHA\/INTBUNDLE_ALPHA_vs2022_quickstart\.md/);
    assert.match(developerExport.vs2022SolutionBundleText, /### INTBUNDLE_ALPHA\/INTBUNDLE_ALPHA_host_consumer\.sln/);
    assert.match(developerExport.vs2022BundleText, /### INTBUNDLE_ALPHA\/INTBUNDLE_ALPHA_host_consumer\.vcxproj/);
    assert.match(developerExport.vs2022FiltersBundleText, /### INTBUNDLE_ALPHA\/INTBUNDLE_ALPHA_host_consumer\.vcxproj\.filters/);
    assert.match(developerExport.vs2022PropsBundleText, /### INTBUNDLE_ALPHA\/RockSolidSDK\.props/);
    assert.match(developerExport.vs2022LocalPropsBundleText, /### INTBUNDLE_ALPHA\/RockSolidSDK\.local\.props/);
    assert.match(developerExport.hostSkeletonBundleText, /### INTBUNDLE_ALPHA-host-skeleton\.cpp/);

    const manifestDownload = await postText(
      baseUrl,
      "/api/developer/products/integration-packages/export/download",
      {
        productIds: [alphaProduct.id],
        format: "manifests"
      },
      viewerSession.token
    );
    assert.match(manifestDownload.contentType || "", /^text\/plain/);
    assert.match(manifestDownload.contentDisposition || "", /attachment; filename="rocksolid-integration-packages-.*-manifests\.txt"/);
    assert.match(manifestDownload.body, /### rocksolid-integration-INTBUNDLE_ALPHA\.json/);
    assert.match(manifestDownload.body, /"code": "INTBUNDLE_ALPHA"/);

    const hostSkeletonBundleDownload = await postText(
      baseUrl,
      "/api/developer/products/integration-packages/export/download",
      {
        productIds: [alphaProduct.id],
        format: "host-skeleton"
      },
      viewerSession.token
    );
    assert.match(hostSkeletonBundleDownload.contentType || "", /^text\/plain/);
    assert.match(hostSkeletonBundleDownload.contentDisposition || "", /attachment; filename="rocksolid-integration-packages-.*-host-skeleton\.txt"/);
    assert.match(hostSkeletonBundleDownload.body, /### INTBUNDLE_ALPHA-host-skeleton\.cpp/);
    assert.match(hostSkeletonBundleDownload.body, /FeatureGate/);

    const hostConfigBundleDownload = await postText(
      baseUrl,
      "/api/developer/products/integration-packages/export/download",
      {
        productIds: [alphaProduct.id],
        format: "host-config"
      },
      viewerSession.token
    );
    assert.match(hostConfigBundleDownload.contentType || "", /^text\/plain/);
    assert.match(hostConfigBundleDownload.contentDisposition || "", /attachment; filename="rocksolid-integration-packages-.*-host-config\.txt"/);
    assert.match(hostConfigBundleDownload.body, /### INTBUNDLE_ALPHA-rocksolid_host_config\.env/);
    assert.match(hostConfigBundleDownload.body, /RS_RUN_NETWORK_DEMO=false/);

    const cmakeBundleDownload = await postText(
      baseUrl,
      "/api/developer/products/integration-packages/export/download",
      {
        productIds: [alphaProduct.id],
        format: "cmake"
      },
      viewerSession.token
    );
    assert.match(cmakeBundleDownload.contentType || "", /^text\/plain/);
    assert.match(cmakeBundleDownload.contentDisposition || "", /attachment; filename="rocksolid-integration-packages-.*-cmake\.txt"/);
    assert.match(cmakeBundleDownload.body, /### INTBUNDLE_ALPHA\/CMakeLists\.txt/);
    assert.match(cmakeBundleDownload.body, /find_package\(RockSolidSDK CONFIG REQUIRED/);

    const vs2022GuideBundleDownload = await postText(
      baseUrl,
      "/api/developer/products/integration-packages/export/download",
      {
        productIds: [alphaProduct.id],
        format: "vs2022-guide"
      },
      viewerSession.token
    );
    assert.match(vs2022GuideBundleDownload.contentType || "", /^text\/plain/);
    assert.match(vs2022GuideBundleDownload.contentDisposition || "", /attachment; filename="rocksolid-integration-packages-.*-vs2022-guide\.txt"/);
    assert.match(vs2022GuideBundleDownload.body, /### INTBUNDLE_ALPHA\/INTBUNDLE_ALPHA_vs2022_quickstart\.md/);
    assert.match(vs2022GuideBundleDownload.body, /VS2022 Quickstart for INTBUNDLE_ALPHA/);

    const vs2022SolutionBundleDownload = await postText(
      baseUrl,
      "/api/developer/products/integration-packages/export/download",
      {
        productIds: [alphaProduct.id],
        format: "vs2022-sln"
      },
      viewerSession.token
    );
    assert.match(vs2022SolutionBundleDownload.contentType || "", /^text\/plain/);
    assert.match(vs2022SolutionBundleDownload.contentDisposition || "", /attachment; filename="rocksolid-integration-packages-.*-vs2022-sln\.txt"/);
    assert.match(vs2022SolutionBundleDownload.body, /### INTBUNDLE_ALPHA\/INTBUNDLE_ALPHA_host_consumer\.sln/);
    assert.match(vs2022SolutionBundleDownload.body, /INTBUNDLE_ALPHA_host_consumer\.vcxproj/);

    const vs2022BundleDownload = await postText(
      baseUrl,
      "/api/developer/products/integration-packages/export/download",
      {
        productIds: [alphaProduct.id],
        format: "vs2022"
      },
      viewerSession.token
    );
    assert.match(vs2022BundleDownload.contentType || "", /^text\/plain/);
    assert.match(vs2022BundleDownload.contentDisposition || "", /attachment; filename="rocksolid-integration-packages-.*-vs2022\.txt"/);
    assert.match(vs2022BundleDownload.body, /### INTBUNDLE_ALPHA\/INTBUNDLE_ALPHA_host_consumer\.vcxproj/);
    assert.match(vs2022BundleDownload.body, /PlatformToolset>v143</);

    const vs2022FiltersBundleDownload = await postText(
      baseUrl,
      "/api/developer/products/integration-packages/export/download",
      {
        productIds: [alphaProduct.id],
        format: "vs2022-filters"
      },
      viewerSession.token
    );
    assert.match(vs2022FiltersBundleDownload.contentType || "", /^text\/plain/);
    assert.match(vs2022FiltersBundleDownload.contentDisposition || "", /attachment; filename="rocksolid-integration-packages-.*-vs2022-filters\.txt"/);
    assert.match(vs2022FiltersBundleDownload.body, /### INTBUNDLE_ALPHA\/INTBUNDLE_ALPHA_host_consumer\.vcxproj\.filters/);
    assert.match(vs2022FiltersBundleDownload.body, /Docs/);

    const vs2022PropsBundleDownload = await postText(
      baseUrl,
      "/api/developer/products/integration-packages/export/download",
      {
        productIds: [alphaProduct.id],
        format: "vs2022-props"
      },
      viewerSession.token
    );
    assert.match(vs2022PropsBundleDownload.contentType || "", /^text\/plain/);
    assert.match(vs2022PropsBundleDownload.contentDisposition || "", /attachment; filename="rocksolid-integration-packages-.*-vs2022-props\.txt"/);
    assert.match(vs2022PropsBundleDownload.body, /### INTBUNDLE_ALPHA\/RockSolidSDK\.props/);
    assert.match(vs2022PropsBundleDownload.body, /ROCKSOLID_SDK_ROOT/);

    const vs2022LocalPropsBundleDownload = await postText(
      baseUrl,
      "/api/developer/products/integration-packages/export/download",
      {
        productIds: [alphaProduct.id],
        format: "vs2022-local-props"
      },
      viewerSession.token
    );
    assert.match(vs2022LocalPropsBundleDownload.contentType || "", /^text\/plain/);
    assert.match(vs2022LocalPropsBundleDownload.contentDisposition || "", /attachment; filename="rocksolid-integration-packages-.*-vs2022-local-props\.txt"/);
    assert.match(vs2022LocalPropsBundleDownload.body, /### INTBUNDLE_ALPHA\/RockSolidSDK\.local\.props/);
    assert.match(vs2022LocalPropsBundleDownload.body, /ROCKSOLID_SDK_ROOT_OVERRIDE/);

    const developerZipDownload = await postBinary(
      baseUrl,
      "/api/developer/products/integration-packages/export/download",
      {
        productIds: [alphaProduct.id],
        format: "zip"
      },
      viewerSession.token
    );
    assert.match(developerZipDownload.contentType || "", /^application\/zip/);
    assert.match(developerZipDownload.contentDisposition || "", /attachment; filename="rocksolid-integration-packages-.*\.zip"/);
    assert.equal(developerZipDownload.body.subarray(0, 4).toString("latin1"), "PK\u0003\u0004");
    const developerZipText = developerZipDownload.body.toString("latin1");
    assert.match(developerZipText, /INTBUNDLE_ALPHA\.env/);
    assert.match(developerZipText, /INTBUNDLE_ALPHA-rocksolid_host_config\.env/);
    assert.match(developerZipText, /cmake-consumer\/INTBUNDLE_ALPHA\/CMakeLists\.txt/);
    assert.match(developerZipText, /cmake-consumer\/INTBUNDLE_ALPHA\/main\.cpp/);
    assert.match(developerZipText, /cmake-consumer\/INTBUNDLE_ALPHA\/rocksolid_host_config\.env/);
    assert.match(developerZipText, /vs2022-consumer\/INTBUNDLE_ALPHA\/INTBUNDLE_ALPHA_vs2022_quickstart\.md/);
    assert.match(developerZipText, /vs2022-consumer\/INTBUNDLE_ALPHA\/INTBUNDLE_ALPHA_host_consumer\.sln/);
    assert.match(developerZipText, /vs2022-consumer\/INTBUNDLE_ALPHA\/INTBUNDLE_ALPHA_host_consumer\.vcxproj/);
    assert.match(developerZipText, /vs2022-consumer\/INTBUNDLE_ALPHA\/INTBUNDLE_ALPHA_host_consumer\.vcxproj\.filters/);
    assert.match(developerZipText, /vs2022-consumer\/INTBUNDLE_ALPHA\/RockSolidSDK\.props/);
    assert.match(developerZipText, /vs2022-consumer\/INTBUNDLE_ALPHA\/RockSolidSDK\.local\.props/);
    assert.match(developerZipText, /vs2022-consumer\/INTBUNDLE_ALPHA\/main\.cpp/);
    assert.match(developerZipText, /vs2022-consumer\/INTBUNDLE_ALPHA\/rocksolid_host_config\.env/);
    assert.match(developerZipText, /INTBUNDLE_ALPHA\.cpp/);
    assert.match(developerZipText, /INTBUNDLE_ALPHA-host-skeleton\.cpp/);
    assert.match(developerZipText, /INTBUNDLE_ALPHA-hardening-guide\.txt/);
    assert.match(developerZipText, /rocksolid-integration-INTBUNDLE_ALPHA\.json/);
    assert.match(developerZipText, /SHA256SUMS\.txt/);

    const developerChecksumsDownload = await postText(
      baseUrl,
      "/api/developer/products/integration-packages/export/download",
      {
        productIds: [alphaProduct.id],
        format: "checksums"
      },
      viewerSession.token
    );
    assert.equal(developerChecksumsDownload.contentType, "text/plain; charset=utf-8");
    assert.match(developerChecksumsDownload.contentDisposition || "", /attachment; filename="rocksolid-integration-packages-.*-sha256\.txt"/);
    assert.match(developerChecksumsDownload.body, /rocksolid-integration-INTBUNDLE_ALPHA\.json/);
    assert.match(developerChecksumsDownload.body, /env\/INTBUNDLE_ALPHA\.env/);
    assert.match(developerChecksumsDownload.body, /host-config\/INTBUNDLE_ALPHA-rocksolid_host_config\.env/);
    assert.match(developerChecksumsDownload.body, /cmake-consumer\/INTBUNDLE_ALPHA\/CMakeLists\.txt/);
    assert.match(developerChecksumsDownload.body, /cmake-consumer\/INTBUNDLE_ALPHA\/main\.cpp/);
    assert.match(developerChecksumsDownload.body, /cmake-consumer\/INTBUNDLE_ALPHA\/rocksolid_host_config\.env/);
    assert.match(developerChecksumsDownload.body, /vs2022-consumer\/INTBUNDLE_ALPHA\/INTBUNDLE_ALPHA_vs2022_quickstart\.md/);
    assert.match(developerChecksumsDownload.body, /vs2022-consumer\/INTBUNDLE_ALPHA\/INTBUNDLE_ALPHA_host_consumer\.sln/);
    assert.match(developerChecksumsDownload.body, /vs2022-consumer\/INTBUNDLE_ALPHA\/INTBUNDLE_ALPHA_host_consumer\.vcxproj/);
    assert.match(developerChecksumsDownload.body, /vs2022-consumer\/INTBUNDLE_ALPHA\/INTBUNDLE_ALPHA_host_consumer\.vcxproj\.filters/);
    assert.match(developerChecksumsDownload.body, /vs2022-consumer\/INTBUNDLE_ALPHA\/RockSolidSDK\.props/);
    assert.match(developerChecksumsDownload.body, /vs2022-consumer\/INTBUNDLE_ALPHA\/RockSolidSDK\.local\.props/);
    assert.match(developerChecksumsDownload.body, /vs2022-consumer\/INTBUNDLE_ALPHA\/main\.cpp/);
    assert.match(developerChecksumsDownload.body, /vs2022-consumer\/INTBUNDLE_ALPHA\/rocksolid_host_config\.env/);
    assert.match(developerChecksumsDownload.body, /cpp\/INTBUNDLE_ALPHA\.cpp/);
    assert.match(developerChecksumsDownload.body, /host-skeleton\/INTBUNDLE_ALPHA-host-skeleton\.cpp/);
    assert.match(developerChecksumsDownload.body, /hardening\/INTBUNDLE_ALPHA-hardening-guide\.txt/);

    const viewerForbidden = await postJsonExpectError(
      baseUrl,
      "/api/developer/products/integration-packages/export",
      {
        productIds: [betaProduct.id]
      },
      viewerSession.token
    );
    assert.equal(viewerForbidden.status, 403);
    assert.equal(viewerForbidden.error.code, "DEVELOPER_PRODUCT_FORBIDDEN");

    const adminExport = await postJson(
      baseUrl,
      "/api/admin/products/integration-packages/export",
      {
        projectCodes: ["INTBUNDLE_ALPHA", "INTBUNDLE_BETA"]
      },
      adminSession.token
    );
    assert.equal(adminExport.total, 2);
    assert.equal(adminExport.items.length, 2);
    assert.equal(adminExport.actor.type, "admin");
    assert.ok(adminExport.items.every((item) => item.ownerDeveloper?.id === owner.id));
    assert.ok(adminExport.items.every((item) => item.manifest.ownerDeveloper?.username === "integration.bundle.owner"));
    assert.ok(adminExport.items.every((item) => item.manifest.actor?.type === "admin"));
    assert.equal(adminExport.manifestFiles.length, 2);
    assert.equal(adminExport.cppFiles.length, 2);
    assert.match(adminExport.manifestBundleText, /rocksolid-integration-INTBUNDLE_ALPHA\.json/);
    assert.match(adminExport.manifestBundleText, /rocksolid-integration-INTBUNDLE_BETA\.json/);

    const adminCppDownload = await postText(
      baseUrl,
      "/api/admin/products/integration-packages/export/download",
      {
        projectCodes: ["INTBUNDLE_ALPHA", "INTBUNDLE_BETA"],
        format: "cpp"
      },
      adminSession.token
    );
    assert.match(adminCppDownload.contentType || "", /^text\/plain/);
    assert.match(adminCppDownload.contentDisposition || "", /attachment; filename="rocksolid-integration-packages-.*-cpp\.txt"/);
    assert.match(adminCppDownload.body, /### INTBUNDLE_ALPHA\.cpp/);
    assert.match(adminCppDownload.body, /### INTBUNDLE_BETA\.cpp/);

    const adminZipDownload = await postBinary(
      baseUrl,
      "/api/admin/products/integration-packages/export/download",
      {
        projectCodes: ["INTBUNDLE_ALPHA", "INTBUNDLE_BETA"],
        format: "zip"
      },
      adminSession.token
    );
    assert.match(adminZipDownload.contentType || "", /^application\/zip/);
    assert.match(adminZipDownload.contentDisposition || "", /attachment; filename="rocksolid-integration-packages-.*\.zip"/);
    assert.equal(adminZipDownload.body.subarray(0, 4).toString("latin1"), "PK\u0003\u0004");
    const adminZipText = adminZipDownload.body.toString("latin1");
    assert.match(adminZipText, /INTBUNDLE_ALPHA\.env/);
    assert.match(adminZipText, /INTBUNDLE_BETA\.env/);
    assert.match(adminZipText, /rocksolid-integration-INTBUNDLE_BETA\.json/);
    assert.match(adminZipText, /SHA256SUMS\.txt/);

    const adminAuditLogs = await getJson(baseUrl, "/api/admin/audit-logs?limit=200", adminSession.token);
    const ownerAuditLogs = await getJson(baseUrl, "/api/developer/audit-logs?limit=200", ownerSession.token);
    assert.ok(adminAuditLogs.items.some((entry) => entry.event_type === "product.integration-packages.export.batch"));
    assert.ok(ownerAuditLogs.items.some((entry) => entry.event_type === "product.integration-packages.export.batch"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("product center page is served from the dedicated admin route", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const response = await fetch(`${baseUrl}/admin/products`);
    const html = await response.text();
    assert.equal(response.ok, true);
    assert.match(response.headers.get("content-type") || "", /^text\/html/);
    assert.match(html, /Product Center/);
    assert.match(html, /feature-config/);
    assert.match(html, /Developer Accounts/);
    assert.match(html, /api\/admin\/developers/);
    assert.match(html, /developers\/:developerId\/status/);
    assert.match(html, /products\/:productId\/status/);
    assert.match(html, /products\/status\/batch/);
    assert.match(html, /products\/feature-config\/batch/);
    assert.match(html, /sdk-credentials\/rotate\/batch/);
    assert.match(html, /sdk-credentials\/export/);
    assert.match(html, /integration-packages\/export/);
    assert.match(html, /integration-packages\/export\/download/);
    assert.match(html, /products\/:productId\/profile/);
    assert.match(html, /sdk-credentials\/rotate/);
    assert.match(html, /Save Project Status/);
    assert.match(html, /Apply Batch Status/);
    assert.match(html, /Apply Batch Feature Config/);
    assert.match(html, /Apply Batch SDK Rotation/);
    assert.match(html, /Export Batch SDK Credentials/);
    assert.match(html, /Download Batch SDK Zip/);
    assert.match(html, /Export Batch Integration Packages/);
    assert.match(html, /Download Batch Integration Zip/);
    assert.match(html, /sdk-credentials\/export\/download/);
    assert.match(html, /Select Visible/);
    assert.match(html, /Status Filter/);
    assert.match(html, /Apply Filter/);
    assert.match(html, /Save Project Profile/);
    assert.match(html, /Rotate SDK Credentials/);
    assert.match(html, /\/assets\/product-features\.js/);
    assert.match(html, /window\.RSProductFeatures/);
    assert.match(html, /feature-summary-box/);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer center page is served from the dedicated route", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const response = await fetch(`${baseUrl}/developer`);
    const html = await response.text();
      assert.equal(response.ok, true);
      assert.match(response.headers.get("content-type") || "", /^text\/html/);
      assert.match(html, /Developer Project Center/);
      assert.match(html, /Developer Launch Review/);
      assert.match(html, /api\/developer\/dashboard/);
    assert.match(html, /api\/developer\/products/);
    assert.match(html, /api\/developer\/policies/);
    assert.match(html, /api\/developer\/profile/);
    assert.match(html, /api\/developer\/members/);
    assert.match(html, /change-password/);
    assert.match(html, /Create Team Member/);
    assert.match(html, /\/assets\/product-features\.js/);
    assert.match(html, /sdk-credentials\/rotate/);
    assert.match(html, /Rotate SDK Credentials/);
    assert.match(html, /Developer Launch Workflow/);
    assert.match(html, /Developer Launch Smoke/);
    assert.match(html, /\/developer\/launch-workflow/);
    assert.match(html, /\/developer\/launch-smoke/);
    assert.match(html, /api\/developer\/launch-workflow/);
    assert.match(html, /api\/developer\/launch-smoke-kit/);
    assert.match(html, /Software Author Workflow/);
    assert.match(html, /End User Runtime Flow/);
    assert.match(html, /not the place where end users download the finished protected client/i);
    assert.match(html, /Open Integration Center/);
    assert.match(html, /Open Release Center/);
    assert.match(html, /Open Launch Smoke/);
    assert.match(html, /window\.RSProductFeatures/);
    assert.match(html, /feature-summary-box/);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer launch workflow page is served from the dedicated route", async () => {
    const { app, baseUrl, tempDir } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/developer/launch-workflow`);
    const html = await response.text();
    assert.equal(response.ok, true);
    assert.match(response.headers.get("content-type") || "", /^text\/html/);
    assert.match(html, /Developer Launch Workflow/);
    assert.match(html, /Developer Launch Smoke/);
    assert.match(html, /api\/developer\/launch-workflow/);
    assert.match(html, /api\/developer\/launch-workflow\/download/);
    assert.match(html, /api\/developer\/launch-review\/download/);
    assert.match(html, /api\/developer\/launch-smoke-kit\/download/);
    assert.match(html, /\/developer\/launch-review/);
    assert.match(html, /\/developer\/launch-smoke/);
      assert.match(html, /Generate Launch Workflow/);
    assert.match(html, /Download Launch JSON/);
    assert.match(html, /Download Launch Summary/);
    assert.match(html, /Download Launch Checklist/);
    assert.match(html, /Download Launch Checksums/);
    assert.match(html, /Download Launch Zip/);
    assert.match(html, /Run Launch Bootstrap/);
    assert.match(html, /Run First Batch Setup/);
    assert.match(html, /Run Inventory Refill|run-first-batch-setup-btn/);
    assert.match(html, /Recommended Handoff/);
    assert.match(html, /Last Launch Action/);
    assert.match(html, /Open Recommended Workspace/);
    assert.match(html, /Download Recommended Handoff Zip/);
    assert.match(html, /Download Handoff Checksums/);
    assert.match(html, /Download Release Summary/);
    assert.match(html, /Download Integration Env/);
    assert.match(html, /Download Host Config/);
    assert.match(html, /Download CMake Template/);
    assert.match(html, /Download VS2022 Quickstart/);
    assert.match(html, /Download C\+\+ Quickstart/);
    assert.match(html, /Download Host Skeleton/);
    assert.match(html, /recommended-download-box/);
    assert.match(html, /hydrateLaunchAutofocus/);
    assert.match(html, /renderWorkspaceActionButtons/);
    assert.match(html, /renderRecommendedDownloadButtons/);
    assert.match(html, /renderLaunchRecommendationList/);
    assert.match(html, /Initial Inventory Recommendations/);
    assert.match(html, /First Batch Card Suggestions/);
    assert.match(html, /First Ops Actions/);
    assert.match(html, /data-recommendation-workspace-index/);
    assert.match(html, /data-recommendation-bootstrap-index/);
    assert.match(html, /data-recommendation-setup-index/);
    assert.match(html, /renderChecklistItemButtons/);
    assert.match(html, /renderActionPlanCards/);
    assert.match(html, /formatWorkspaceActionRouteBits/);
    assert.match(html, /filters=/);
    assert.match(html, /api\/developer\/license-quickstart\/bootstrap/);
    assert.match(html, /api\/developer\/license-quickstart\/first-batches/);
    assert.match(html, /api\/developer\/license-quickstart\/restock/);
    assert.match(html, /api\/developer\/ops\/export\/download/);
    assert.match(html, /runLaunchBootstrap/);
    assert.match(html, /runLaunchFirstBatchSetup/);
    assert.match(html, /currentLaunchBootstrapAction/);
    assert.match(html, /currentLaunchFirstBatchSetupAction/);
    assert.match(html, /currentLastLaunchActionResult/);
    assert.match(html, /currentLastLaunchFollowUp/);
    assert.match(html, /renderLastLaunchFollowUp/);
    assert.match(html, /launch-action-followup-box/);
    assert.match(html, /data-last-launch-workspace-index/);
    assert.match(html, /data-last-launch-download-index/);
    assert.match(html, /data-workspace-action-index/);
    assert.match(html, /data-recommended-download-index/);
    assert.match(html, /data-checklist-workspace-index/);
    assert.match(html, /data-checklist-download-index/);
    assert.match(html, /data-checklist-bootstrap-index/);
    assert.match(html, /data-checklist-setup-index/);
    assert.match(html, /data-action-plan-workspace-index/);
    assert.match(html, /data-action-plan-download-index/);
    assert.match(html, /data-action-plan-bootstrap-index/);
    assert.match(html, /data-action-plan-setup-index/);
    assert.match(html, /Workspace path:/);
    assert.match(html, /autofocus/);
    assert.match(html, /routeTitle/);
    assert.match(html, /routeReason/);
    assert.match(html, /Open Project Workspace/);
    assert.match(html, /Open Integration Package/);
    assert.match(html, /Open Release Check/);
    assert.match(html, /Launch Workflow Summary/);
    assert.match(html, /Linked Release Signals/);
    assert.match(html, /Launch Workflow Checklist/);
    assert.match(html, /Launch Summary/);
    assert.match(html, /VS2022 Quickstart/);
    assert.match(html, /VS2022 Filters/);
    assert.match(html, /CMake Consumer/);
    assert.match(html, /Hardening Guide/);
    assert.match(html, /window\.location\.search/);
    assert.match(html, /\/developer\/launch-workflow/);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

test("developer launch mainline page is served from the dedicated route", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const response = await fetch(`${baseUrl}/developer/launch-mainline`);
    const html = await response.text();
    assert.equal(response.ok, true);
    assert.match(response.headers.get("content-type") || "", /^text\/html/);
    assert.match(html, /Developer Launch Mainline/);
    assert.match(html, /api\/developer\/launch-mainline/);
    assert.match(html, /api\/developer\/launch-mainline\/download/);
    assert.match(html, /api\/developer\/launch-mainline\/action/);
    assert.match(html, /Generate Launch Mainline/);
    assert.match(html, /Launch Mainline Overview/);
    assert.match(html, /Production Gate Checks/);
    assert.match(html, /Next Production Evidence/);
    assert.match(html, /mainline-next-evidence-box/);
    assert.match(html, /currentMainlineProductionEvidenceQueue/);
    assert.match(html, /currentMainlineNextEvidenceAction/);
    assert.match(html, /renderNextProductionEvidenceAction/);
    assert.match(html, /remainingEvidenceChecks/);
    assert.match(html, /production-checks-title/);
    assert.match(html, /production-checks-box/);
    assert.match(html, /Last Mainline Action/);
    assert.match(html, /Release Mainline/);
    assert.match(html, /Launch Workflow/);
    assert.match(html, /Launch Review/);
    assert.match(html, /Launch Smoke/);
    assert.match(html, /Developer Ops/);
    assert.match(html, /mainlineView/);
    assert.match(html, /mainlinePage/);
    assert.match(html, /currentMainlineView/);
    assert.match(html, /currentMainlinePage/);
    assert.match(html, /currentMainlineForm/);
    assert.match(html, /applyMainlineForm/);
    assert.match(html, /currentMainlineRouteFocus/);
    assert.match(html, /mainlineHeroControls/);
    assert.match(html, /currentMainlineSections/);
    assert.match(html, /mainlineScreen/);
    assert.match(html, /currentMainlineLastActionScreen/);
    assert.match(html, /mainlineRecapCards/);
    assert.match(html, /mainlineFollowUpCards/);
    assert.doesNotMatch(html, /currentRouteContext/);
    assert.doesNotMatch(html, /currentMainlineRecapCards/);
    assert.doesNotMatch(html, /currentMainlineFollowUpCards/);
    assert.doesNotMatch(html, /currentMainlineScreen/);
    assert.doesNotMatch(html, /buildWorkspaceUrl\("/);
    assert.doesNotMatch(html, /action\.key === "project"/);
    assert.doesNotMatch(html, /item\.source === "developer-launch-mainline"/);
    assert.doesNotMatch(html, /item\.source === "developer-ops"/);
    assert.match(html, /data-mainline-hero-control-index/);
    assert.match(html, /data-mainline-next-evidence-control-index/);
    assert.match(html, /data-mainline-section-control-index/);
    assert.match(html, /data-mainline-receipt-card-control-index/);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer launch review page is served from the dedicated route", async () => {
    const { app, baseUrl, tempDir } = await startServer();

    try {
      const response = await fetch(`${baseUrl}/developer/launch-review`);
      const html = await response.text();
      assert.equal(response.ok, true);
      assert.match(response.headers.get("content-type") || "", /^text\/html/);
      assert.match(html, /Developer Launch Review/);
      assert.match(html, /Developer Launch Smoke/);
      assert.match(html, /api\/developer\/launch-review/);
      assert.match(html, /api\/developer\/launch-review\/download/);
      assert.match(html, /api\/developer\/launch-smoke-kit\/download/);
      assert.match(html, /\/developer\/launch-smoke/);
      assert.match(html, /Generate Launch Review/);
      assert.match(html, /Review Actions/);
      assert.match(html, /Primary Review Target/);
      assert.match(html, /Review Targets/);
      assert.match(html, /Workspace Path/);
      assert.match(html, /Last Review Action/);
      assert.match(html, /Open Recommended Workspace/);
      assert.match(html, /Download Review JSON/);
      assert.match(html, /Download Review Summary/);
      assert.match(html, /Download Review Checksums/);
      assert.match(html, /Download Review Zip/);
      assert.match(html, /Open Launch Workflow/);
      assert.match(html, /Open Ops Workspace/);
      assert.match(html, /Open License Workspace/);
      assert.match(html, /review-followup-box/);
      assert.match(html, /renderLastReviewFollowUp/);
      assert.match(html, /currentPrimaryReviewTarget/);
      assert.match(html, /currentReviewTargets/);
      assert.match(html, /runLaunchReviewBootstrap/);
      assert.match(html, /runLaunchReviewSetup/);
      assert.match(html, /Review Mainline Handoff/);
      assert.match(html, /currentReviewMainlineWorkspaceAction/);
      assert.match(html, /currentReviewMainlineRehearsalDownload/);
      assert.match(html, /data-review-mainline-workspace/);
      assert.match(html, /data-review-mainline-rehearsal-download/);
      assert.match(html, /data-review-target-workspace-index/);
      assert.match(html, /data-review-target-download-index/);
      assert.match(html, /data-review-action-bootstrap-index/);
      assert.match(html, /data-review-action-setup-index/);
    } finally {
      await app.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

test("developer launch smoke page is served from the dedicated route", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const response = await fetch(`${baseUrl}/developer/launch-smoke`);
    const html = await response.text();
    assert.equal(response.ok, true);
    assert.match(response.headers.get("content-type") || "", /^text\/html/);
    assert.match(html, /Developer Launch Smoke/);
    assert.match(html, /api\/developer\/launch-smoke-kit/);
    assert.match(html, /api\/developer\/launch-smoke-kit\/download/);
    assert.match(html, /Generate Launch Smoke Kit/);
    assert.match(html, /Smoke Actions/);
    assert.match(html, /Review Targets/);
    assert.match(html, /Workspace Path/);
    assert.match(html, /Smoke Summary/);
    assert.match(html, /Startup Request/);
    assert.match(html, /Smoke Paths/);
    assert.match(html, /Account Candidates/);
    assert.match(html, /Direct-Card Candidates/);
    assert.match(html, /Recharge Candidates/);
    assert.match(html, /Last Smoke Action/);
    assert.match(html, /Open Recommended Workspace/);
    assert.match(html, /Open Launch Workflow/);
    assert.match(html, /Open Launch Review/);
    assert.match(html, /Open Ops Workspace/);
    assert.match(html, /Run Launch Bootstrap/);
    assert.match(html, /Run First Batch Setup/);
    assert.match(html, /Run Inventory Refill/);
    assert.match(html, /Primary Review Target/);
    assert.match(html, /downloadSmokeRecommendedItem/);
    assert.match(html, /openWorkspaceAction/);
    assert.match(html, /runLaunchSmokeBootstrap/);
    assert.match(html, /runLaunchSmokeSetup/);
    assert.match(html, /renderLastSmokeFollowUp/);
    assert.match(html, /currentSmokeSummary/);
    assert.match(html, /currentActionPlan/);
    assert.match(html, /currentPrimarySmokeReviewTarget/);
    assert.match(html, /currentSmokeReviewTargets/);
    assert.match(html, /currentWorkspaceActions/);
    assert.match(html, /currentRecommendedDownloads/);
    assert.match(html, /Smoke Mainline Handoff/);
    assert.match(html, /currentSmokeMainlineWorkspaceAction/);
    assert.match(html, /currentSmokeMainlineRehearsalDownload/);
    assert.match(html, /data-smoke-mainline-workspace/);
    assert.match(html, /data-smoke-mainline-rehearsal-download/);
    assert.match(html, /data-smoke-review-target-workspace-index/);
    assert.match(html, /data-smoke-review-target-download-index/);
    assert.match(html, /data-smoke-action-bootstrap-index/);
    assert.match(html, /data-smoke-action-setup-index/);
    assert.match(html, /\/developer\/launch-smoke/);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer integration snapshot is scoped to visible projects", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "integration.owner",
        password: "IntegrationOwner123!",
        displayName: "Integration Owner"
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "integration.owner",
      password: "IntegrationOwner123!"
    });

    const alphaProject = await postJson(
      baseUrl,
      "/api/developer/products",
      {
        code: "INT_ALPHA",
        name: "Integration Alpha"
      },
      ownerSession.token
    );

    await postJson(
      baseUrl,
      "/api/developer/products",
      {
        code: "INT_BETA",
        name: "Integration Beta"
      },
      ownerSession.token
    );

    await postJson(
      baseUrl,
      "/api/developer/members",
      {
        username: "integration.viewer",
        password: "IntegrationViewer123!",
        displayName: "Integration Viewer",
        role: "viewer",
        productCodes: ["INT_ALPHA"]
      },
      ownerSession.token
    );

    const viewerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "integration.viewer",
      password: "IntegrationViewer123!"
    });

    const snapshot = await getJson(baseUrl, "/api/developer/integration", viewerSession.token);
    assert.equal(snapshot.actor.type, "member");
    assert.equal(snapshot.actor.role, "viewer");
    assert.equal(snapshot.products.length, 1);
    assert.equal(snapshot.products[0].id, alphaProject.id);
    assert.equal(snapshot.products[0].code, "INT_ALPHA");
    assert.equal(snapshot.transport.http.baseUrl, baseUrl);
    assert.equal(snapshot.transport.tcp.enabled, true);
    assert.ok(snapshot.signing.activeKeyId);
    assert.ok(Array.isArray(snapshot.tokenKeys.keys));
    assert.ok(snapshot.tokenKeys.keys.length >= 1);
    assert.ok(snapshot.examples.http.some((entry) => entry.path === "/api/client/login"));
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer integration package export is scoped and includes cpp quickstart snippets", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "export.owner",
        password: "ExportOwner123!",
        displayName: "Export Owner"
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "export.owner",
      password: "ExportOwner123!"
    });

    const alphaProject = await postJson(
      baseUrl,
      "/api/developer/products",
      {
        code: "EXPORT_ALPHA",
        name: "Export Alpha",
        featureConfig: {
          allowCardLogin: false,
          requireStartupBootstrap: false,
          requireLocalTokenValidation: false
        }
      },
      ownerSession.token
    );

    const betaProject = await postJson(
      baseUrl,
      "/api/developer/products",
      {
        code: "EXPORT_BETA",
        name: "Export Beta"
      },
      ownerSession.token
    );

    await postJson(
      baseUrl,
      "/api/developer/members",
      {
        username: "export.viewer",
        password: "ExportViewer123!",
        displayName: "Export Viewer",
        role: "viewer",
        productCodes: ["EXPORT_ALPHA"]
      },
      ownerSession.token
    );

    const viewerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "export.viewer",
      password: "ExportViewer123!"
    });

    const byProductId = await getJson(
      baseUrl,
      `/api/developer/integration/package?productId=${encodeURIComponent(alphaProject.id)}`,
      viewerSession.token
    );
    assert.equal(byProductId.fileName, "rocksolid-integration-EXPORT_ALPHA.json");
    assert.equal(byProductId.manifest.project.code, "EXPORT_ALPHA");
    assert.equal(byProductId.manifest.project.featureConfig.allowCardLogin, false);
    assert.equal(byProductId.manifest.clientHardening.profile, "relaxed");
    assert.equal(byProductId.manifest.credentials.sdkAppId, alphaProject.sdkAppId);
    assert.equal(byProductId.manifest.credentials.sdkAppSecret, alphaProject.sdkAppSecret);
    assert.equal(byProductId.manifest.startupPreview.request.productCode, "EXPORT_ALPHA");
    assert.equal(byProductId.manifest.startupPreview.expectedResponse.versionManifest.status, "no_version_rules");
    assert.equal(byProductId.manifest.startupPreview.noticeSummary.blockingTotal, 0);
    assert.equal(byProductId.manifest.startupPreview.tokenKeySummary.hasTokenKeys, false);
    assert.equal(byProductId.manifest.startupPreview.decision.ready, true);
    assert.equal(byProductId.manifest.startupPreview.clientHardening.profile, "relaxed");
    assert.equal(byProductId.manifest.startupDefaults.includeTokenKeys, false);
    assert.match(byProductId.snippets.cppQuickstart, /rocksolid::ClientIdentity/);
    assert.match(byProductId.snippets.cppQuickstart, /startup_bootstrap_http/);
    assert.match(byProductId.snippets.cppQuickstart, /evaluate_startup_decision/);
    assert.match(byProductId.snippets.cppQuickstart, /EXPORT_ALPHA/);
    assert.match(byProductId.snippets.cppQuickstart, /Local licenseToken validation is optional/);
    assert.equal(byProductId.snippets.hostSkeletonFileName, "EXPORT_ALPHA-host-skeleton.cpp");
    assert.match(byProductId.snippets.hostSkeletonCpp, /FeatureGate/);
    assert.match(byProductId.snippets.hostSkeletonCpp, /startup_bootstrap_http/);
    assert.match(byProductId.snippets.hostSkeletonCpp, /heartbeat_http_parsed|heartbeat_tcp_parsed/);
    assert.equal(byProductId.snippets.hardeningFileName, "EXPORT_ALPHA-hardening-guide.txt");
    assert.match(byProductId.snippets.hardeningGuide, /Profile: RELAXED/);
    assert.match(byProductId.snippets.hardeningGuide, /Recommended Integration Order:/);
    assert.match(byProductId.snippets.envTemplate, /RS_PROJECT_CODE=EXPORT_ALPHA/);
    assert.match(byProductId.snippets.envTemplate, /RS_SDK_APP_ID=/);
    assert.match(byProductId.snippets.envTemplate, /RS_SDK_APP_SECRET=/);
    assert.match(byProductId.snippets.envTemplate, /RS_REQUIRE_STARTUP_BOOTSTRAP=false/);
    assert.match(byProductId.snippets.envTemplate, /RS_REQUIRE_LOCAL_TOKEN_VALIDATION=false/);
    assert.match(byProductId.snippets.envTemplate, /RS_REQUIRE_HEARTBEAT_GATE=true/);
    assert.match(byProductId.snippets.envTemplate, /RS_CLIENT_VERSION=1.0.0/);
    assert.match(byProductId.snippets.envTemplate, /RS_CHANNEL=stable/);
    assert.match(byProductId.snippets.envTemplate, /RS_RUN_NETWORK_DEMO=false/);
    assert.equal(byProductId.snippets.envFileName, "EXPORT_ALPHA.env");
    assert.equal(byProductId.snippets.hostConfigFileName, "rocksolid_host_config.env");
    assert.match(byProductId.snippets.hostConfigEnv, /Copy this file to sdk\/examples\/cmake_cpp_host_consumer\/rocksolid_host_config\.env/);
    assert.match(byProductId.snippets.hostConfigEnv, /RS_PROJECT_CODE=EXPORT_ALPHA/);
    const byChannel = await getJson(
      baseUrl,
      `/api/developer/integration/package?productId=${encodeURIComponent(alphaProject.id)}&channel=beta`,
      viewerSession.token
    );
    assert.equal(byChannel.manifest.startupPreview.request.channel, "beta");
    assert.equal(byChannel.manifest.startupDefaults.channel, "beta");
    assert.match(byChannel.snippets.envTemplate, /RS_CHANNEL=beta/);
    assert.match(byChannel.snippets.hostConfigEnv, /RS_CHANNEL=beta/);
    assert.equal(byProductId.snippets.cmakeFileName, "CMakeLists.txt");
    assert.match(byProductId.snippets.cmakeConsumerTemplate, /find_package\(RockSolidSDK CONFIG REQUIRED/);
    assert.match(byProductId.snippets.cmakeConsumerTemplate, /export_alpha_host_consumer/);
    assert.match(byProductId.snippets.vs2022SolutionFileName, /EXPORT_ALPHA_host_consumer\.sln/i);
    assert.match(byProductId.snippets.vs2022SolutionTemplate, /Visual Studio Solution File, Format Version 12\.00/);
    assert.match(byProductId.snippets.vs2022SolutionTemplate, /EXPORT_ALPHA_host_consumer\.vcxproj/);
    assert.match(byProductId.snippets.vs2022ProjectFileName, /EXPORT_ALPHA_host_consumer\.vcxproj/i);
    assert.match(byProductId.snippets.vs2022ProjectTemplate, /PlatformToolset>v143</);
    assert.match(byProductId.snippets.vs2022ProjectTemplate, /ROCKSOLID_SDK_ROOT/);
    assert.match(byProductId.snippets.vs2022ProjectTemplate, /UseDebugLibraries>false</);
    assert.match(byProductId.snippets.vs2022ProjectTemplate, /rocksolid_host_config\.env/);
    assert.match(byProductId.snippets.vs2022ProjectTemplate, /EXPORT_ALPHA_vs2022_quickstart\.md/);
    assert.match(byProductId.snippets.vs2022ProjectTemplate, /Import Project="RockSolidSDK\.props"/);
    assert.match(byProductId.snippets.vs2022ProjectTemplate, /Import Project="RockSolidSDK\.local\.props"/);
    assert.match(byProductId.snippets.vs2022FiltersFileName, /EXPORT_ALPHA_host_consumer\.vcxproj\.filters/i);
    assert.match(byProductId.snippets.vs2022FiltersTemplate, /Docs/);
    assert.equal(byProductId.snippets.vs2022PropsFileName, "RockSolidSDK.props");
    assert.match(byProductId.snippets.vs2022PropsTemplate, /ROCKSOLID_SDK_ROOT/);
    assert.match(byProductId.snippets.vs2022PropsTemplate, /AdditionalLibraryDirectories>/);
    assert.equal(byProductId.snippets.vs2022LocalPropsFileName, "RockSolidSDK.local.props");
    assert.match(byProductId.snippets.vs2022LocalPropsTemplate, /ROCKSOLID_SDK_ROOT_OVERRIDE/);
    assert.match(byProductId.snippets.vs2022GuideFileName, /EXPORT_ALPHA_vs2022_quickstart\.md/i);
    assert.match(byProductId.snippets.vs2022GuideText, /VS2022 Quickstart for EXPORT_ALPHA/);
    assert.match(byProductId.snippets.vs2022GuideText, /RockSolidSDK\.local\.props/);
    assert.equal(byProductId.snippets.cppFileName, "EXPORT_ALPHA.cpp");

    const byProjectCode = await getJson(
      baseUrl,
      "/api/developer/integration/package?projectCode=EXPORT_ALPHA",
      viewerSession.token
    );
    assert.equal(byProjectCode.manifest.project.id, alphaProject.id);
    assert.equal(byProjectCode.manifest.project.code, "EXPORT_ALPHA");

    const jsonDownload = await getText(
      baseUrl,
      `/api/developer/integration/package/download?productId=${encodeURIComponent(alphaProject.id)}&format=json`,
      viewerSession.token
    );
    assert.equal(jsonDownload.contentType, "application/json; charset=utf-8");
    assert.match(jsonDownload.contentDisposition || "", /rocksolid-integration-EXPORT_ALPHA\.json/);
    assert.match(jsonDownload.body, /"code": "EXPORT_ALPHA"/);

    const envDownload = await getText(
      baseUrl,
      "/api/developer/integration/package/download?projectCode=EXPORT_ALPHA&format=env",
      viewerSession.token
    );
    assert.equal(envDownload.contentType, "text/plain; charset=utf-8");
    assert.match(envDownload.contentDisposition || "", /EXPORT_ALPHA\.env/);
    assert.match(envDownload.body, /RS_PROJECT_CODE=EXPORT_ALPHA/);

    const hostConfigDownload = await getText(
      baseUrl,
      "/api/developer/integration/package/download?projectCode=EXPORT_ALPHA&format=host-config",
      viewerSession.token
    );
    assert.equal(hostConfigDownload.contentType, "text/plain; charset=utf-8");
    assert.match(hostConfigDownload.contentDisposition || "", /rocksolid_host_config\.env/);
    assert.match(hostConfigDownload.body, /RS_PROJECT_CODE=EXPORT_ALPHA/);
    assert.match(hostConfigDownload.body, /RS_RUN_NETWORK_DEMO=false/);

    const cmakeDownload = await getText(
      baseUrl,
      "/api/developer/integration/package/download?projectCode=EXPORT_ALPHA&format=cmake",
      viewerSession.token
    );
    assert.equal(cmakeDownload.contentType, "text/plain; charset=utf-8");
    assert.match(cmakeDownload.contentDisposition || "", /CMakeLists\.txt/);
    assert.match(cmakeDownload.body, /find_package\(RockSolidSDK CONFIG REQUIRED/);
    assert.match(cmakeDownload.body, /export_alpha_host_consumer/);

    const vs2022GuideDownload = await getText(
      baseUrl,
      "/api/developer/integration/package/download?projectCode=EXPORT_ALPHA&format=vs2022-guide",
      viewerSession.token
    );
    assert.equal(vs2022GuideDownload.contentType, "text/plain; charset=utf-8");
    assert.match(vs2022GuideDownload.contentDisposition || "", /EXPORT_ALPHA_vs2022_quickstart\.md/);
    assert.match(vs2022GuideDownload.body, /VS2022 Quickstart for EXPORT_ALPHA/);
    assert.match(vs2022GuideDownload.body, /RS_PROJECT_CODE=EXPORT_ALPHA/);

    const vs2022SolutionDownload = await getText(
      baseUrl,
      "/api/developer/integration/package/download?projectCode=EXPORT_ALPHA&format=vs2022-sln",
      viewerSession.token
    );
    assert.equal(vs2022SolutionDownload.contentType, "text/plain; charset=utf-8");
    assert.match(vs2022SolutionDownload.contentDisposition || "", /EXPORT_ALPHA_host_consumer\.sln/);
    assert.match(vs2022SolutionDownload.body, /Visual Studio Solution File, Format Version 12\.00/);
    assert.match(vs2022SolutionDownload.body, /EXPORT_ALPHA_host_consumer\.vcxproj/);

    const vs2022Download = await getText(
      baseUrl,
      "/api/developer/integration/package/download?projectCode=EXPORT_ALPHA&format=vs2022",
      viewerSession.token
    );
    assert.equal(vs2022Download.contentType, "text/plain; charset=utf-8");
    assert.match(vs2022Download.contentDisposition || "", /EXPORT_ALPHA_host_consumer\.vcxproj/);
    assert.match(vs2022Download.body, /PlatformToolset>v143</);
    assert.match(vs2022Download.body, /ROCKSOLID_SDK_ROOT/);

    const vs2022FiltersDownload = await getText(
      baseUrl,
      "/api/developer/integration/package/download?projectCode=EXPORT_ALPHA&format=vs2022-filters",
      viewerSession.token
    );
    assert.equal(vs2022FiltersDownload.contentType, "text/plain; charset=utf-8");
    assert.match(vs2022FiltersDownload.contentDisposition || "", /EXPORT_ALPHA_host_consumer\.vcxproj\.filters/);
    assert.match(vs2022FiltersDownload.body, /Source Files/);
    assert.match(vs2022FiltersDownload.body, /Docs/);

    const vs2022PropsDownload = await getText(
      baseUrl,
      "/api/developer/integration/package/download?projectCode=EXPORT_ALPHA&format=vs2022-props",
      viewerSession.token
    );
    assert.equal(vs2022PropsDownload.contentType, "text/plain; charset=utf-8");
    assert.match(vs2022PropsDownload.contentDisposition || "", /RockSolidSDK\.props/);
    assert.match(vs2022PropsDownload.body, /ROCKSOLID_SDK_ROOT/);
    assert.match(vs2022PropsDownload.body, /AdditionalLibraryDirectories>/);

    const vs2022LocalPropsDownload = await getText(
      baseUrl,
      "/api/developer/integration/package/download?projectCode=EXPORT_ALPHA&format=vs2022-local-props",
      viewerSession.token
    );
    assert.equal(vs2022LocalPropsDownload.contentType, "text/plain; charset=utf-8");
    assert.match(vs2022LocalPropsDownload.contentDisposition || "", /RockSolidSDK\.local\.props/);
    assert.match(vs2022LocalPropsDownload.body, /ROCKSOLID_SDK_ROOT_OVERRIDE/);
    assert.match(vs2022LocalPropsDownload.body, /ROCKSOLID_TARGET_NAME_OVERRIDE/);

    const cppDownload = await getText(
      baseUrl,
      "/api/developer/integration/package/download?softwareCode=EXPORT_ALPHA&format=cpp",
      viewerSession.token
    );
    assert.equal(cppDownload.contentType, "text/plain; charset=utf-8");
    assert.match(cppDownload.contentDisposition || "", /EXPORT_ALPHA\.cpp/);
    assert.match(cppDownload.body, /startup_bootstrap_http/);

    const hostSkeletonDownload = await getText(
      baseUrl,
      "/api/developer/integration/package/download?softwareCode=EXPORT_ALPHA&format=host-skeleton",
      viewerSession.token
    );
    assert.equal(hostSkeletonDownload.contentType, "text/plain; charset=utf-8");
    assert.match(hostSkeletonDownload.contentDisposition || "", /EXPORT_ALPHA-host-skeleton\.cpp/);
    assert.match(hostSkeletonDownload.body, /FeatureGate/);
    assert.match(hostSkeletonDownload.body, /startup_bootstrap_http/);

    const checksumsDownload = await getText(
      baseUrl,
      "/api/developer/integration/package/download?softwareCode=EXPORT_ALPHA&format=checksums",
      viewerSession.token
    );
    assert.equal(checksumsDownload.contentType, "text/plain; charset=utf-8");
    assert.match(checksumsDownload.contentDisposition || "", /rocksolid-integration-EXPORT_ALPHA-sha256\.txt/);
    assert.match(checksumsDownload.body, /rocksolid-integration-EXPORT_ALPHA\.json/);
    assert.match(checksumsDownload.body, /env\/EXPORT_ALPHA\.env/);
    assert.match(checksumsDownload.body, /host-config\/rocksolid_host_config\.env/);
    assert.match(checksumsDownload.body, /cmake-consumer\/CMakeLists\.txt/);
    assert.match(checksumsDownload.body, /cmake-consumer\/main\.cpp/);
    assert.match(checksumsDownload.body, /cmake-consumer\/rocksolid_host_config\.env/);
    assert.match(checksumsDownload.body, /vs2022-consumer\/EXPORT_ALPHA_vs2022_quickstart\.md/);
    assert.match(checksumsDownload.body, /vs2022-consumer\/EXPORT_ALPHA_host_consumer\.sln/);
    assert.match(checksumsDownload.body, /vs2022-consumer\/EXPORT_ALPHA_host_consumer\.vcxproj/);
    assert.match(checksumsDownload.body, /vs2022-consumer\/EXPORT_ALPHA_host_consumer\.vcxproj\.filters/);
    assert.match(checksumsDownload.body, /vs2022-consumer\/RockSolidSDK\.props/);
    assert.match(checksumsDownload.body, /vs2022-consumer\/RockSolidSDK\.local\.props/);
    assert.match(checksumsDownload.body, /vs2022-consumer\/main\.cpp/);
    assert.match(checksumsDownload.body, /vs2022-consumer\/rocksolid_host_config\.env/);
    assert.match(checksumsDownload.body, /cpp\/EXPORT_ALPHA\.cpp/);
    assert.match(checksumsDownload.body, /host-skeleton\/EXPORT_ALPHA-host-skeleton\.cpp/);

    const zipDownload = await getBinary(
      baseUrl,
      "/api/developer/integration/package/download?softwareCode=EXPORT_ALPHA&format=zip",
      viewerSession.token
    );
    assert.equal(zipDownload.contentType, "application/zip");
    assert.match(zipDownload.contentDisposition || "", /rocksolid-integration-EXPORT_ALPHA\.zip/);
    assert.equal(zipDownload.body.subarray(0, 4).toString("latin1"), "PK\u0003\u0004");
    const zipText = zipDownload.body.toString("latin1");
    assert.match(zipText, /rocksolid-integration-EXPORT_ALPHA\.json/);
    assert.match(zipText, /EXPORT_ALPHA\.env/);
    assert.match(zipText, /rocksolid_host_config\.env/);
    assert.match(zipText, /cmake-consumer\/CMakeLists\.txt/);
    assert.match(zipText, /cmake-consumer\/main\.cpp/);
    assert.match(zipText, /vs2022-consumer\/EXPORT_ALPHA_vs2022_quickstart\.md/);
    assert.match(zipText, /vs2022-consumer\/EXPORT_ALPHA_host_consumer\.sln/);
    assert.match(zipText, /vs2022-consumer\/EXPORT_ALPHA_host_consumer\.vcxproj/);
    assert.match(zipText, /vs2022-consumer\/EXPORT_ALPHA_host_consumer\.vcxproj\.filters/);
    assert.match(zipText, /vs2022-consumer\/RockSolidSDK\.props/);
    assert.match(zipText, /vs2022-consumer\/RockSolidSDK\.local\.props/);
    assert.match(zipText, /vs2022-consumer\/main\.cpp/);
    assert.match(zipText, /EXPORT_ALPHA\.cpp/);
    assert.match(zipText, /EXPORT_ALPHA-host-skeleton\.cpp/);
    assert.match(zipText, /SHA256SUMS\.txt/);

    const forbidden = await getJsonExpectError(
      baseUrl,
      `/api/developer/integration/package?productId=${encodeURIComponent(betaProject.id)}`,
      viewerSession.token
    );
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.error.code, "DEVELOPER_PRODUCT_FORBIDDEN");

    const forbiddenDownload = await getJsonExpectError(
      baseUrl,
      `/api/developer/integration/package/download?productId=${encodeURIComponent(betaProject.id)}&format=json`,
      viewerSession.token
    );
    assert.equal(forbiddenDownload.status, 403);
    assert.equal(forbiddenDownload.error.code, "DEVELOPER_PRODUCT_FORBIDDEN");
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer projects page is served from the dedicated route", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const response = await fetch(`${baseUrl}/developer/projects`);
    const html = await response.text();
    assert.equal(response.ok, true);
    assert.match(response.headers.get("content-type") || "", /^text\/html/);
    assert.match(html, /Developer Project Workspace/);
    assert.match(html, /api\/developer\/products/);
    assert.match(html, /feature-config/);
    assert.match(html, /products\/:productId\/status/);
    assert.match(html, /products\/status\/batch/);
    assert.match(html, /products\/feature-config\/batch/);
    assert.match(html, /sdk-credentials\/rotate\/batch/);
    assert.match(html, /sdk-credentials\/export/);
      assert.match(html, /integration-packages\/export/);
      assert.match(html, /integration-packages\/export\/download/);
      assert.match(html, /api\/developer\/launch-review\/download/);
      assert.match(html, /api\/developer\/launch-smoke-kit\/download/);
      assert.match(html, /\/developer\/launch-review/);
      assert.match(html, /products\/:productId\/profile/);
    assert.match(html, /\/assets\/product-features\.js/);
    assert.match(html, /sdk-credentials\/rotate/);
    assert.match(html, /Create Project/);
    assert.match(html, /Save Project Status/);
    assert.match(html, /Apply Batch Status/);
    assert.match(html, /Apply Batch Feature Config/);
    assert.match(html, /Apply Batch SDK Rotation/);
    assert.match(html, /Export Batch SDK Credentials/);
    assert.match(html, /Download Batch SDK Zip/);
    assert.match(html, /Export Batch Integration Packages/);
    assert.match(html, /Download Batch Integration Zip/);
    assert.match(html, /sdk-credentials\/export\/download/);
    assert.match(html, /Select Visible/);
    assert.match(html, /Status Filter/);
    assert.match(html, /Apply Filter/);
    assert.match(html, /Open Integration Package/);
    assert.match(html, /Open Launch Workflow/);
    assert.match(html, /Open Release Check/);
    assert.match(html, /Preview Release Readiness/);
    assert.match(html, /Clear Release Preview/);
    assert.match(html, /Preview Launch Workflow/);
    assert.match(html, /Run Launch Bootstrap/);
    assert.match(html, /Run First Batch Setup/);
    assert.match(html, /launch-run-first-batch-setup-btn/);
    assert.match(html, /Download Release Summary/);
    assert.match(html, /Download Release Checksums/);
    assert.match(html, /Download Release Zip/);
    assert.match(html, /Preview Integration Snapshot/);
    assert.match(html, /Clear Integration Preview/);
    assert.match(html, /Download Integration JSON/);
    assert.match(html, /Download Integration Env/);
    assert.match(html, /Download Integration Host Config/);
    assert.match(html, /Download Integration Checksums/);
    assert.match(html, /renderProjectRecommendedDownloadButtons/);
    assert.match(html, /renderProjectRecommendationList/);
    assert.match(html, /renderProjectChecklistActionCards/);
    assert.match(html, /renderProjectActionPlanCards/);
    assert.match(html, /formatProjectWorkspaceActionRouteBits/);
    assert.match(html, /filters=/);
    assert.match(html, /api\/developer\/license-quickstart\/bootstrap/);
    assert.match(html, /api\/developer\/license-quickstart\/first-batches/);
    assert.match(html, /api\/developer\/license-quickstart\/restock/);
    assert.match(html, /api\/developer\/ops\/export\/download/);
    assert.match(html, /runLaunchWorkflowBootstrap/);
    assert.match(html, /runLaunchWorkflowFirstBatchSetup/);
    assert.match(html, /currentLaunchWorkflowBootstrapAction/);
    assert.match(html, /currentLaunchWorkflowFirstBatchSetupAction/);
    assert.match(html, /currentLastLaunchWorkflowActionResult/);
    assert.match(html, /currentLastLaunchWorkflowFollowUp/);
    assert.match(html, /renderProjectLastLaunchFollowUp/);
    assert.match(html, /detail-last-launch-action/);
    assert.match(html, /data-launch-last-action-workspace-index/);
    assert.match(html, /data-launch-last-action-download-index/);
    assert.match(html, /data-launch-download-index/);
    assert.match(html, /data-launch-checklist-workspace-index/);
    assert.match(html, /data-launch-checklist-download-index/);
    assert.match(html, /data-launch-checklist-bootstrap-index/);
    assert.match(html, /data-launch-checklist-setup-index/);
    assert.match(html, /data-launch-action-plan-workspace-index/);
    assert.match(html, /data-launch-action-plan-download-index/);
    assert.match(html, /data-launch-action-plan-bootstrap-index/);
    assert.match(html, /data-launch-action-plan-setup-index/);
    assert.match(html, /Download C\+\+ Quickstart/);
    assert.match(html, /Download CMake Template/);
    assert.match(html, /Download VS2022 Quickstart/);
    assert.match(html, /Download VS2022 Solution/);
    assert.match(html, /Download VS2022 Project/);
    assert.match(html, /Download VS2022 Filters/);
    assert.match(html, /Download VS2022 Props/);
    assert.match(html, /Download VS2022 Local Props/);
    assert.match(html, /Download Host Skeleton/);
    assert.match(html, /Download Integration Zip/);
    assert.match(html, /Download Recommended Handoff/);
    assert.match(html, /Run Launch Bootstrap or First Batch Setup here to keep the next launch-day follow-up visible in the project workspace\./);
    assert.match(html, /Open Recommended Workspace/);
    assert.match(html, /Launch Summary/);
    assert.match(html, /Launch Checklist/);
    assert.match(html, /Launch Checksums/);
    assert.match(html, /Launch Zip/);
    assert.match(html, /Initial Inventory Recommendations/);
    assert.match(html, /First Batch Card Suggestions/);
    assert.match(html, /First Ops Actions/);
    assert.match(html, /data-launch-recommendation-workspace-index/);
    assert.match(html, /data-launch-recommendation-setup-index/);
    assert.match(html, /data-launch-recommendation-bootstrap-index/);
    assert.match(html, /Open Launch Workspace/);
    assert.match(html, /Release Summary/);
    assert.match(html, /Integration Env/);
    assert.match(html, /Host Config/);
    assert.match(html, /Open Integration Workspace/);
    assert.match(html, /Open Release Workspace/);
    assert.match(html, /autofocus/);
    assert.match(html, /window\.location\.search/);
    assert.match(html, /Delivery quick signals/);
    assert.match(html, /detail-release-channel/);
    assert.match(html, /detail-release-readiness/);
    assert.match(html, /detail-integration-preview/);
    assert.match(html, /detail-launch-workflow/);
    assert.match(html, /renderReleasePreview/);
    assert.match(html, /renderIntegrationPreview/);
    assert.match(html, /renderLaunchWorkflow/);
    assert.match(html, /api\/developer\/release-package\/download/);
    assert.match(html, /api\/developer\/launch-workflow/);
    assert.match(html, /api\/developer\/launch-workflow\/download/);
    assert.match(html, /api\/developer\/integration\/package/);
    assert.match(html, /api\/developer\/integration\/package\/download/);
    assert.match(html, /downloadInlineReleaseAsset/);
    assert.match(html, /downloadLaunchWorkflowAsset/);
    assert.match(html, /downloadInlineIntegrationAsset/);
    assert.match(html, /requestedAutofocus/);
    assert.match(html, /requestedRouteTitle/);
    assert.match(html, /requestedRouteReason/);
    assert.match(html, /currentProjectAutofocusTarget/);
    assert.match(html, /currentProjectRouteFocus/);
    assert.match(html, /focusProjectAutofocusTarget/);
    assert.match(html, /hydrateProjectAutofocus/);
    assert.match(html, /loadInlineReleasePreview/);
    assert.match(html, /loadInlineIntegrationPreview/);
    assert.match(html, /loadInlineLaunchWorkflow/);
    assert.match(html, /renderProjectRouteFocus/);
    assert.match(html, /handleProjectRouteFocusAction/);
    assert.match(html, /renderProjectWorkspaceActionButtons/);
    assert.match(html, /openLaunchWorkspaceAction/);
    assert.match(html, /detail-route-focus-box/);
    assert.match(html, /data-project-route-focus-action/);
    assert.match(html, /Route reason:/);
    assert.match(html, /data-launch-workspace-action-index/);
    assert.match(html, /autofocus: action\.autofocus \|\| "detail"/);
    assert.match(html, /autofocus: action\.autofocus \|\| "package"/);
    assert.match(html, /routeTitle/);
    assert.match(html, /routeReason/);
    assert.match(html, /downloadUrlFile/);
    assert.match(html, /buildDeliveryQuickSignals/);
    assert.match(html, /Save Project Profile/);
    assert.match(html, /window\.RSProductFeatures/);
    assert.match(html, /feature-summary-box/);
    assert.match(html, /Authorization Strategy/);
    assert.match(html, /Authorization Preset/);
    assert.match(html, /Batch Authorization Preset/);
    assert.match(html, /Load Preset To Form/);
    assert.match(html, /Apply Preset Now/);
    assert.match(html, /Project authorization preset focus/);
    assert.match(html, /syncAuthorizationPresetUi/);
    assert.match(html, /loadAuthorizationPresetToForm/);
    assert.match(html, /auth-preset/);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("admin console page exposes admin ops export controls", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const response = await fetch(`${baseUrl}/admin`);
    const html = await response.text();
    assert.equal(response.ok, true);
    assert.match(response.headers.get("content-type") || "", /^text\/html/);
    assert.match(html, /RockSolidLicense Console/);
    assert.match(html, /api\/admin\/ops\/export/);
    assert.match(html, /api\/admin\/ops\/export\/download/);
    assert.match(html, /Preview Ops Snapshot/);
    assert.match(html, /Download Summary/);
    assert.match(html, /Download Checksums/);
    assert.match(html, /Download Zip/);
    assert.match(html, /ops-entity-type/);
    assert.match(html, /clear-audit-filters-btn/);
    assert.match(html, /ops-preview-summary/);
    assert.match(html, /load-entitlements-btn/);
    assert.match(html, /set-entitlement-status-btn/);
    assert.match(html, /extend-entitlement-btn/);
    assert.match(html, /adjust-points-btn/);
    assert.match(html, /Entitlements Review/);
    assert.match(html, /entitlements-body/);
    assert.match(html, /row-focus/);
    assert.match(html, /drillIntoFocusTables/);
    assert.match(html, /panel-focus/);
    assert.match(html, /focusAdminControlPanel/);
    assert.match(html, /rememberAdminFocus/);
    assert.match(html, /refreshAdminAfterMutation/);
    assert.match(html, /Last Action Result/);
    assert.match(html, /buildAdminMutationRecap/);
    assert.match(html, /compareAdminMutationSignals/);
    assert.match(html, /isEscalateFirstSummary/);
    assert.match(html, /buildAdminEscalationOutcome/);
    assert.match(html, /tuneAdminFollowUpPlan/);
    assert.match(html, /Prepared Control/);
    assert.match(html, /rememberAdminPreparedFocus/);
    assert.match(html, /runAdminPreparedAction/);
    assert.match(html, /buildAdminMutationFollowUp/);
    assert.match(html, /buildAdminFollowUpImpactBits/);
    assert.match(html, /runAdminMutationAction/);
    assert.match(html, /data-mutation-action/);
    assert.match(html, /Escalate First/);
    assert.match(html, /isUrgentQueueItem/);
    assert.match(html, /renderEscalationSummaryTags/);
    assert.match(html, /renderEscalationActionButtons/);
    assert.match(html, /runAdminEscalationAction/);
    assert.match(html, /data-escalation-action/);
    assert.match(html, /Open Control/);
    assert.match(html, /Load Full Context/);
    assert.match(html, /ESCALATE/);
    assert.match(html, /Escalate First Cleared/);
    assert.match(html, /Mitigated/);
    assert.match(html, /Mitigation:/);
    assert.match(html, /Confirm Mitigation/);
    assert.match(html, /Return To Escalation Control/);
    assert.match(html, /escalate:/);
    assert.match(html, /Follow-up:/);
    assert.match(html, /follow-up:/);
    assert.match(html, /Impact:/);
    assert.match(html, /entitlements=/);
    assert.match(html, /signals:/);
    assert.match(html, /高频原因/);
    assert.match(html, /建议优先处理/);
    assert.match(html, /重点账号明细/);
    assert.match(html, /重点会话/);
    assert.match(html, /重点设备明细/);
    assert.match(html, /prepare=/);
    assert.match(html, /severity=/);
    assert.match(html, /next=/);
    assert.match(html, /session\.login/);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer integration page is served from the dedicated route", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const response = await fetch(`${baseUrl}/developer/integration`);
    const html = await response.text();
    assert.equal(response.ok, true);
    assert.match(response.headers.get("content-type") || "", /^text\/html/);
    assert.match(html, /Developer Integration Center/);
    assert.match(html, /api\/developer\/integration/);
    assert.match(html, /api\/developer\/integration\/package/);
    assert.match(html, /api\/developer\/integration\/package\/download/);
    assert.match(html, /not an end-user download page/i);
    assert.match(html, /api\/client\/login/);
    assert.match(html, /\/assets\/product-features\.js/);
    assert.match(html, /Token Keys/);
    assert.match(html, /Refresh Integration Package/);
    assert.match(html, /Download JSON/);
    assert.match(html, /Download Env/);
    assert.match(html, /Download Host Config/);
    assert.match(html, /Download CMake Template/);
    assert.match(html, /Download VS2022 Quickstart/);
    assert.match(html, /Download VS2022 Solution/);
    assert.match(html, /Download VS2022 Project/);
    assert.match(html, /Download VS2022 Filters/);
    assert.match(html, /Download VS2022 Props/);
    assert.match(html, /Download VS2022 Local Props/);
    assert.match(html, /Download C\+\+/);
    assert.match(html, /Download Host Skeleton/);
    assert.match(html, /Download Checksums/);
    assert.match(html, /Download Zip/);
    assert.match(html, /Open Project Workspace/);
    assert.match(html, /Open Launch Workflow/);
    assert.match(html, /Open Release Check/);
    assert.match(html, /autofocus/);
    assert.match(html, /window\.location\.search/);
    assert.match(html, /Startup Bootstrap Preview/);
    assert.match(html, /Startup Bootstrap Example/);
    assert.match(html, /api\/client\/startup-bootstrap/);
    assert.match(html, /C\+\+ Quickstart/);
    assert.match(html, /Host Skeleton/);
    assert.match(html, /Environment Template/);
    assert.match(html, /Host Config/);
    assert.match(html, /VS2022 Solution/);
    assert.match(html, /VS2022 Project/);
    assert.match(html, /VS2022 Filters/);
    assert.match(html, /VS2022 Props/);
    assert.match(html, /VS2022 Local Props/);
    assert.match(html, /VS2022 Quickstart/);
    assert.match(html, /CMake Consumer/);
    assert.match(html, /Hardening Guide/);
    assert.match(html, /x-rs-app-id/);
    assert.match(html, /window\.RSProductFeatures/);
    assert.match(html, /feature-summary-box/);
    assert.match(html, /requestedAutofocus/);
    assert.match(html, /requestedRouteTitle/);
    assert.match(html, /requestedRouteReason/);
    assert.match(html, /currentIntegrationAutofocusTarget/);
    assert.match(html, /currentIntegrationRouteFocus/);
    assert.match(html, /renderIntegrationRouteFocus/);
    assert.match(html, /focusIntegrationAutofocusTarget/);
    assert.match(html, /hydrateIntegrationAutofocus/);
    assert.match(html, /route-focus-box/);
    assert.match(html, /Route reason:/);
    assert.match(html, /data-route-focus-action/);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("shared product feature helper asset is served for dashboard pages", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const response = await fetch(`${baseUrl}/assets/product-features.js`);
    const script = await response.text();
    assert.equal(response.ok, true);
    assert.match(response.headers.get("content-type") || "", /^application\/javascript/);
    assert.match(script, /globalThisRef\.RSProductFeatures/);
    assert.match(script, /summaryLabel/);
    assert.match(script, /fieldId/);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer operations page is served from the dedicated route", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const response = await fetch(`${baseUrl}/developer/ops`);
    const html = await response.text();
    assert.equal(response.ok, true);
    assert.match(response.headers.get("content-type") || "", /^text\/html/);
    assert.match(html, /Developer Authorization Ops/);
    assert.match(html, /api\/developer\/accounts/);
    assert.match(html, /api\/developer\/entitlements/);
    assert.match(html, /api\/developer\/device-bindings/);
    assert.match(html, /api\/developer\/audit-logs/);
    assert.match(html, /api\/developer\/ops\/export/);
    assert.match(html, /Download Summary/);
    assert.match(html, /Download Zip/);
    assert.match(html, /filter-entity-type/);
    assert.match(html, /snapshot-overview/);
    assert.match(html, /Escalate First/);
    assert.match(html, /Prepared Control/);
    assert.match(html, /Last Action Result/);
    assert.match(html, /Focus accounts/);
    assert.match(html, /Recommended next actions/);
    assert.match(html, /buildDeveloperMutationRecap/);
    assert.match(html, /compareDeveloperMutationSignals/);
    assert.match(html, /buildDeveloperFollowUpImpactBits/);
    assert.match(html, /buildDeveloperEscalationOutcome/);
    assert.match(html, /Escalate First Cleared/);
    assert.match(html, /Snapshot hits/);
    assert.match(html, /tuneDeveloperFollowUpPlan/);
    assert.match(html, /inferDeveloperActionFocus/);
    assert.match(html, /runDeveloperMutationAction/);
    assert.match(html, /runDeveloperEscalationAction/);
    assert.match(html, /runDeveloperPreparedAction/);
    assert.match(html, /data-escalation-action/);
    assert.match(html, /data-prepared-action/);
    assert.match(html, /data-mutation-action/);
    assert.match(html, /Open Control/);
    assert.match(html, /Load Full Context/);
    assert.match(html, /Jump To Controls/);
    assert.match(html, /Mitigation:/);
    assert.match(html, /Follow-up:/);
    assert.match(html, /Focus account details/);
    assert.match(html, /Focus sessions/);
    assert.match(html, /Focus devices/);
    assert.match(html, /prepare=/);
    assert.match(html, /severity=/);
    assert.match(html, /next=/);
    assert.match(html, /Session Login/);
    assert.match(html, /license_key/);
    assert.match(html, /route-focus-box/);
    assert.match(html, /window\.location\.search/);
    assert.match(html, /requestedAutofocus/);
    assert.match(html, /requestedRouteAction/);
    assert.match(html, /requestedReviewMode/);
    assert.match(html, /Route reason:/);
    assert.match(html, /Route review action:/);
    assert.match(html, /Route review mode:/);
    assert.match(html, /Review Primary Match/);
    assert.match(html, /Review Next Match/);
    assert.match(html, /Open Primary Control/);
    assert.match(html, /Open Next Control/);
    assert.match(html, /Continue Routed Review/);
    assert.match(html, /Complete Routed Review/);
    assert.match(html, /Download Next Match Summary/);
    assert.match(html, /Download Remaining Queue Summary/);
    assert.match(html, /Primary control ready while reviewing:/);
    assert.match(html, /Next routed review ready\./);
    assert.match(html, /focus_account/);
    assert.match(html, /focus_entitlement/);
    assert.match(html, /focus_session/);
    assert.match(html, /focus_device/);
    assert.match(html, /Account focus prepared/);
    assert.match(html, /Entitlement focus prepared/);
    assert.match(html, /Session focus prepared/);
    assert.match(html, /Device focus prepared/);
    assert.match(html, /Download Primary Match Summary/);
    assert.match(html, /Primary account summary/);
    assert.match(html, /Primary entitlement summary/);
    assert.match(html, /Primary session summary/);
    assert.match(html, /Primary device summary/);
    assert.match(html, /developer-ops-primary-account-summary\.txt/);
    assert.match(html, /developer-ops-primary-entitlement-summary\.txt/);
    assert.match(html, /developer-ops-primary-session-summary\.txt/);
    assert.match(html, /developer-ops-primary-device-summary\.txt/);
    assert.match(html, /Download Accounts Summary/);
    assert.match(html, /Download Sessions Summary/);
    assert.match(html, /Download Audit Summary/);
    assert.match(html, /Open this page from launch workflow or another routed workspace action/);
    assert.match(html, /handleOpsRouteFocusAction/);
    assert.match(html, /data-ops-route-focus-action/);
    assert.match(html, /requestedEventType/);
    assert.match(html, /requestedActorType/);
    assert.match(html, /requestedEntityType/);
    assert.match(html, /requestedFocusKind/);
    assert.match(html, /Route filters:/);
    assert.match(html, /Direct review target:/);
    assert.match(html, /route-review-box/);
    assert.match(html, /buildRouteReviewPrimaryDownloadDescriptor/);
    assert.match(html, /buildRouteReviewSectionDownloadDescriptor/);
    assert.match(html, /serverRouteReview\?\.continuations/);
    assert.match(html, /serverRouteReview\?\.actions/);
    assert.match(html, /renderRouteReview/);
    assert.match(html, /handleRouteReviewAction/);
    assert.match(html, /data-route-review-action/);
    assert.match(html, /Matching records:/);
    assert.match(html, /Highlighted audit events/);
    assert.match(html, /Primary Match/);
    assert.match(html, /Prepare Primary Match/);
    assert.match(html, /route-hit/);
    assert.match(html, /Show Routed Hits Only/);
    assert.match(html, /Show Full Scope/);
    assert.match(html, /routeReviewDisplayMode/);
    assert.match(html, /Review Accounts/);
    assert.match(html, /Review Sessions/);
    assert.match(html, /routeReviewScopedItems/);
    assert.match(html, /routeReviewPreparedKey/);
    assert.match(html, /buildDeveloperFocusFromAudit/);
    assert.match(html, /buildPrimaryRouteReviewFocus/);
    assert.match(html, /applyDeveloperFocusItem/);
    assert.match(html, /preparePrimaryRouteReviewFocus/);
    assert.match(html, /action === "open-mainline"/);
    assert.match(html, /action === "download-mainline"/);
    assert.match(html, /action === "download-mainline-rehearsal"/);
    assert.match(html, /action === "download-mainline-first-launch-handoff"/);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer license page is served from the dedicated route", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const response = await fetch(`${baseUrl}/developer/licenses`);
    const html = await response.text();
    assert.equal(response.ok, true);
    assert.match(response.headers.get("content-type") || "", /^text\/html/);
    assert.match(html, /Developer License Center/);
    assert.match(html, /api\/developer\/policies/);
    assert.match(html, /api\/developer\/cards/);
    assert.match(html, /api\/developer\/dashboard/);
      assert.match(html, /api\/developer\/cards\/export/);
      assert.match(html, /api\/developer\/cards\/export\/download/);
      assert.match(html, /api\/developer\/launch-review\/download/);
      assert.match(html, /api\/developer\/launch-smoke-kit\/download/);
      assert.match(html, /\/developer\/launch-review/);
      assert.match(html, /\/assets\/product-features\.js/);
    assert.match(html, /Issue Card Batch/);
    assert.match(html, /Download Summary/);
    assert.match(html, /Download Checksums/);
    assert.match(html, /Download Zip/);
    assert.match(html, /Launch Authorization Quickstart/);
    assert.match(html, /Load Duration Policy Template/);
    assert.match(html, /Load Points Policy Template/);
    assert.match(html, /Load Starter Account Template/);
    assert.match(html, /Load Starter Card Batch/);
    assert.match(html, /Run Launch Bootstrap/);
    assert.match(html, /Create Starter Account/);
    assert.match(html, /api\/developer\/accounts/);
    assert.match(html, /api\/developer\/license-quickstart\/bootstrap/);
    assert.match(html, /api\/developer\/license-quickstart\/first-batches/);
    assert.match(html, /api\/developer\/license-quickstart\/restock/);
    assert.match(html, /api\/developer\/launch-workflow\/download/);
    assert.match(html, /account-product-code/);
    assert.match(html, /launch-quickstart-box/);
    assert.match(html, /route-focus-box/);
    assert.match(html, /window\.location\.search/);
    assert.match(html, /requestedAutofocus/);
    assert.match(html, /Last Quickstart Action/);
    assert.match(html, /renderQuickstartResultRecap/);
    assert.match(html, /renderQuickstartCountTransition\("freshCards"/);
    assert.match(html, /reviewMode/);
    assert.match(html, /Route reason:/);
    assert.match(html, /Open this page from launch workflow or a routed workspace action/);
    assert.match(html, /renderLaunchQuickstart/);
    assert.match(html, /buildQuickstartInventoryRecommendations/);
    assert.match(html, /buildQuickstartCardBatchRecommendations/);
    assert.match(html, /buildQuickstartOpsActions/);
    assert.match(html, /renderQuickstartRecommendationList/);
    assert.match(html, /Next Launch Follow-up/);
    assert.match(html, /renderQuickstartFollowUp/);
    assert.match(html, /downloadLaunchQuickstartFollowUpItem/);
    assert.match(html, /openLaunchQuickstartWorkspaceAction/);
    assert.match(html, /findProjectMetrics/);
    assert.match(html, /fillStarterPolicyTemplate/);
    assert.match(html, /fillStarterAccountTemplate/);
    assert.match(html, /fillStarterBatchTemplate/);
    assert.match(html, /runLaunchFirstBatchSetup/);
    assert.match(html, /runLaunchInventoryRefill/);
    assert.match(html, /runLaunchQuickstartBootstrap/);
    assert.match(html, /run-first-batch-setup/);
    assert.match(html, /run-inventory-refill/);
    assert.match(html, /run-bootstrap/);
    assert.match(html, /run-direct-card-setup/);
    assert.match(html, /run-recharge-card-setup/);
    assert.match(html, /run-refill-direct-card/);
    assert.match(html, /run-refill-recharge/);
    assert.match(html, /load-direct-card-batch/);
    assert.match(html, /load-recharge-card-batch/);
    assert.match(html, /open-ops-snapshot/);
    assert.match(html, /open-ops-audit/);
    assert.match(html, /open-ops-sessions/);
    assert.match(html, /open-release-versions/);
    assert.match(html, /\/developer\/ops/);
    assert.match(html, /\/developer\/releases/);
    assert.match(html, /Bootstrap plan:/);
    assert.match(html, /Recommended first-batch gaps:/);
    assert.match(html, /Low inventory warnings:/);
    assert.match(html, /activeEntitlements=/);
    assert.match(html, /Initial Inventory Recommendations/);
    assert.match(html, /First Batch Card Suggestions/);
    assert.match(html, /First Ops Actions/);
    assert.match(html, /starterAccountUsername/);
    assert.match(html, /openProjectAuthorizationPreset/);
    assert.match(html, /data-launch-quickstart-action/);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer release package mainline follow-up carries launch authorization actions", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "release.mainline.owner",
        password: "ReleaseMainlineOwner123!",
        displayName: "Release Mainline Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "RELMAIN_ALPHA",
        name: "Release Mainline Alpha",
        ownerDeveloperId: owner.id
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "release.mainline.owner",
      password: "ReleaseMainlineOwner123!"
    });

    const firstReleasePackage = await getJson(
      baseUrl,
      "/api/developer/release-package?productCode=RELMAIN_ALPHA&channel=stable",
      ownerSession.token
    );

    assert.ok(
      firstReleasePackage.mainlineFollowUp.actionPlan.some((item) => item.bootstrapAction?.key === "launch_bootstrap")
    );
    assert.match(firstReleasePackage.summaryText, /\| bootstrap=Run Launch Bootstrap/);

    await postJson(
      baseUrl,
      "/api/developer/license-quickstart/bootstrap",
      { productCode: "RELMAIN_ALPHA" },
      ownerSession.token
    );

    const secondReleasePackage = await getJson(
      baseUrl,
      "/api/developer/release-package?productCode=RELMAIN_ALPHA&channel=stable",
      ownerSession.token
    );

    assert.ok(
      secondReleasePackage.mainlineFollowUp.actionPlan.some((item) => item.setupAction?.operation === "first_batch_setup")
    );
    assert.match(secondReleasePackage.summaryText, /\| setup=Run First Batch Setup@recommended:first_batch_setup/);
  } finally {
    await stopServer(app, tempDir);
  }
});

test("developer release page is served from the dedicated route", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const response = await fetch(`${baseUrl}/developer/releases`);
    const html = await response.text();
    assert.equal(response.ok, true);
    assert.match(response.headers.get("content-type") || "", /^text\/html/);
    assert.match(html, /Developer Release Center/);
    assert.match(html, /api\/developer\/client-versions/);
    assert.match(html, /api\/developer\/notices/);
    assert.match(html, /api\/developer\/release-package/);
    assert.match(html, /api\/developer\/release-package\/download/);
    assert.match(html, /api\/developer\/launch-review\/download/);
    assert.match(html, /api\/developer\/launch-smoke-kit\/download/);
    assert.match(html, /not the page where end users download the final encrypted client build/i);
    assert.match(html, /Scoped to assigned projects/);
    assert.match(html, /Release Delivery Package/);
    assert.match(html, /Generate Release Package/);
    assert.match(html, /Release Readiness/);
      assert.match(html, /Delivery Summary/);
      assert.match(html, /Delivery Checklist/);
      assert.match(html, /Release Mainline Follow-up/);
      assert.match(html, /Last Mainline Action/);
      assert.match(html, /Package Summary/);
      assert.match(html, /Host Skeleton/);
    assert.match(html, /Host Config/);
    assert.match(html, /CMake Consumer/);
    assert.match(html, /VS2022 Solution/);
    assert.match(html, /VS2022 Project/);
    assert.match(html, /VS2022 Filters/);
    assert.match(html, /VS2022 Props/);
    assert.match(html, /VS2022 Local Props/);
    assert.match(html, /VS2022 Quickstart/);
    assert.match(html, /Hardening Guide/);
    assert.match(html, /Download Host Config/);
    assert.match(html, /Download CMake Template/);
    assert.match(html, /Download VS2022 Quickstart/);
    assert.match(html, /Download VS2022 Solution/);
    assert.match(html, /Download VS2022 Project/);
    assert.match(html, /Download VS2022 Filters/);
    assert.match(html, /Download VS2022 Props/);
    assert.match(html, /Download VS2022 Local Props/);
    assert.match(html, /Download Host Skeleton/);
    assert.match(html, /Download Package JSON/);
    assert.match(html, /Download Checksums/);
    assert.match(html, /Download Checklist/);
    assert.match(html, /Download Zip Archive/);
    assert.match(html, /Open Project Workspace/);
    assert.match(html, /Open Launch Workflow/);
    assert.match(html, /Open Integration Package/);
    assert.match(html, /autofocus/);
    assert.match(html, /release-route-hint/);
    assert.match(html, /applyRoutePrefill/);
    assert.match(html, /requestedAutofocus/);
    assert.match(html, /requestedRouteTitle/);
    assert.match(html, /requestedRouteReason/);
    assert.match(html, /currentReleaseAutofocusTarget/);
    assert.match(html, /currentReleaseRouteFocus/);
    assert.match(html, /renderReleaseRouteFocus/);
    assert.match(html, /focusReleaseAutofocusTarget/);
    assert.match(html, /hydrateReleaseAutofocus/);
    assert.match(html, /release-route-focus-box/);
    assert.match(html, /Route reason:/);
    assert.match(html, /data-release-route-focus-action/);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("developer security page is served from the dedicated route", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const response = await fetch(`${baseUrl}/developer/security`);
    const html = await response.text();
    assert.equal(response.ok, true);
    assert.match(response.headers.get("content-type") || "", /^text\/html/);
    assert.match(html, /Developer Security Center/);
    assert.match(html, /api\/developer\/network-rules/);
    assert.match(html, /Project-scoped only/);
    assert.match(html, /Create Rule/);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
