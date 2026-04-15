import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
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

async function getJson(baseUrl, requestPath, token = null) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const response = await fetch(`${baseUrl}${requestPath}`, { headers });
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json.data;
}

async function waitFor(check, { timeoutMs = 2000, intervalMs = 25 } = {}) {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    const result = await check();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out while waiting for condition.");
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

function parseRespArray(buffer, start = 0) {
  if (start >= buffer.length || buffer[start] !== "*".charCodeAt(0)) {
    return null;
  }

  const countEnd = buffer.indexOf("\r\n", start);
  if (countEnd < 0) {
    return null;
  }
  const count = Number(buffer.toString("utf8", start + 1, countEnd));
  let offset = countEnd + 2;
  const parts = [];

  for (let index = 0; index < count; index += 1) {
    if (offset >= buffer.length || buffer[offset] !== "$".charCodeAt(0)) {
      return null;
    }
    const lengthEnd = buffer.indexOf("\r\n", offset);
    if (lengthEnd < 0) {
      return null;
    }
    const length = Number(buffer.toString("utf8", offset + 1, lengthEnd));
    const bodyStart = lengthEnd + 2;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd + 2) {
      return null;
    }
    parts.push(buffer.toString("utf8", bodyStart, bodyEnd));
    offset = bodyEnd + 2;
  }

  return {
    command: parts,
    nextOffset: offset
  };
}

async function startFakeRedisServer() {
  const keyStore = new Map();
  const commandLog = [];

  function purgeExpiredKeys(now = Date.now()) {
    for (const [key, value] of keyStore.entries()) {
      if (value.expiresAt !== null && value.expiresAt <= now) {
        keyStore.delete(key);
      }
    }
  }

  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let parsed = parseRespArray(buffer);
      while (parsed) {
        buffer = buffer.subarray(parsed.nextOffset);
        const [rawName, ...args] = parsed.command;
        const command = rawName.toUpperCase();
        commandLog.push([command, ...args]);
        purgeExpiredKeys();

        if (command === "PING" || command === "AUTH" || command === "SELECT") {
          socket.write("+OK\r\n".replace("OK", command === "PING" ? "PONG" : "OK"));
        } else if (command === "SET") {
          const [key, value] = args;
          const flags = args.slice(2);
          const hasNx = flags.includes("NX");
          const pxIndex = flags.indexOf("PX");
          const ttlMs = pxIndex >= 0 ? Number(flags[pxIndex + 1]) : null;
          const existing = keyStore.get(key);
          if (hasNx && existing) {
            socket.write("$-1\r\n");
          } else {
            keyStore.set(key, {
              type: "string",
              value,
              expiresAt: ttlMs !== null ? Date.now() + ttlMs : null
            });
            socket.write("+OK\r\n");
          }
        } else if (command === "GETSET") {
          const [key, value] = args;
          const existing = keyStore.get(key);
          if (!existing || existing.type !== "string") {
            socket.write("$-1\r\n");
          } else {
            const previous = String(existing.value ?? "");
            socket.write(`$${Buffer.byteLength(previous, "utf8")}\r\n${previous}\r\n`);
          }
          keyStore.set(key, {
            type: "string",
            value,
            expiresAt: existing?.expiresAt ?? null
          });
        } else if (command === "HSET") {
          const [key, ...fields] = args;
          const existing = keyStore.get(key);
          const hash = existing?.type === "hash" ? { ...existing.value } : {};
          let added = 0;
          for (let index = 0; index < fields.length; index += 2) {
            const field = fields[index];
            const value = fields[index + 1] ?? "";
            if (!(field in hash)) {
              added += 1;
            }
            hash[field] = value;
          }
          keyStore.set(key, {
            type: "hash",
            value: hash,
            expiresAt: existing?.expiresAt ?? null
          });
          socket.write(`:${added}\r\n`);
        } else if (command === "HGETALL") {
          const [key] = args;
          const existing = keyStore.get(key);
          if (!existing || existing.type !== "hash") {
            socket.write("*0\r\n");
          } else {
            const entries = Object.entries(existing.value);
            let response = `*${entries.length * 2}\r\n`;
            for (const [field, value] of entries) {
              response += `$${Buffer.byteLength(field, "utf8")}\r\n${field}\r\n`;
              response += `$${Buffer.byteLength(String(value), "utf8")}\r\n${value}\r\n`;
            }
            socket.write(response);
          }
        } else if (command === "EXPIRE") {
          const [key, seconds] = args;
          const existing = keyStore.get(key);
          if (!existing) {
            socket.write(":0\r\n");
          } else {
            existing.expiresAt = Date.now() + Number(seconds) * 1000;
            keyStore.set(key, existing);
            socket.write(":1\r\n");
          }
        } else if (command === "DEL") {
          let removed = 0;
          for (const key of args) {
            if (keyStore.delete(key)) {
              removed += 1;
            }
          }
          socket.write(`:${removed}\r\n`);
        } else if (command === "ZADD") {
          const [key, score, member] = args;
          const existing = keyStore.get(key);
          const zset = existing?.type === "zset" ? new Map(existing.value) : new Map();
          const wasNew = !zset.has(member);
          zset.set(member, Number(score));
          keyStore.set(key, {
            type: "zset",
            value: zset,
            expiresAt: existing?.expiresAt ?? null
          });
          socket.write(`:${wasNew ? 1 : 0}\r\n`);
        } else if (command === "ZREM") {
          const [key, member] = args;
          const existing = keyStore.get(key);
          if (!existing || existing.type !== "zset") {
            socket.write(":0\r\n");
          } else {
            const removed = existing.value.delete(member) ? 1 : 0;
            keyStore.set(key, existing);
            socket.write(`:${removed}\r\n`);
          }
        } else if (command === "ZREMRANGEBYSCORE") {
          const [key, minValue, maxValue] = args;
          const existing = keyStore.get(key);
          if (!existing || existing.type !== "zset") {
            socket.write(":0\r\n");
          } else {
            const min = minValue === "-inf" ? Number.NEGATIVE_INFINITY : Number(minValue);
            const max = maxValue === "+inf" ? Number.POSITIVE_INFINITY : Number(maxValue);
            let removed = 0;
            for (const [member, score] of existing.value.entries()) {
              if (score >= min && score <= max) {
                existing.value.delete(member);
                removed += 1;
              }
            }
            keyStore.set(key, existing);
            socket.write(`:${removed}\r\n`);
          }
        } else if (command === "ZCARD") {
          const [key] = args;
          const existing = keyStore.get(key);
          if (!existing || existing.type !== "zset") {
            socket.write(":0\r\n");
          } else {
            socket.write(`:${existing.value.size}\r\n`);
          }
        } else {
          socket.write(`-ERR unsupported command ${command}\r\n`);
        }

        parsed = parseRespArray(buffer);
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error) => (error ? reject(error) : resolve()));
  });

  const address = server.address();
  return {
    url: `redis://127.0.0.1:${address.port}/0`,
    commandLog,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
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
    assert.equal(health.storage.mainStore.driver, "sqlite");
    assert.deepEqual(
      health.storage.mainStore.repositories,
      ["products", "policies", "cards", "entitlements", "accounts", "versions", "notices", "networkRules", "devices", "sessions"]
    );
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

test("redis runtime state uses external nonce replay protection", async () => {
  const fakeRedis = await startFakeRedisServer();
  const { app, baseUrl } = await startServer({
    stateStoreDriver: "redis",
    redisUrl: fakeRedis.url,
    redisKeyPrefix: "rocksolid:test:redis"
  });

  try {
    const adminLogin = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const product = await postJson(baseUrl, "/api/admin/products", {
      code: "REDISSDK",
      name: "Redis SDK Product"
    }, adminLogin.token);

    const payload = {
      productCode: product.code,
      clientVersion: "1.0.0",
      channel: "stable"
    };
    const signatureWindow = {
      nonce: "redis-replay-nonce-001",
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

    const health = await getJson(baseUrl, "/api/health");
    assert.equal(health.storage.runtimeState.driver, "redis");
    assert.equal(health.storage.runtimeState.nonceReplayStore, "redis");
    assert.equal(health.storage.runtimeState.externalReady, true);

    assert.ok(
      fakeRedis.commandLog.some((entry) => entry[0] === "SET" && entry[1].includes(":nonce:")),
      JSON.stringify(fakeRedis.commandLog)
    );
  } finally {
    await app.close();
    await fakeRedis.close();
  }
});

test("redis runtime state tracks active sessions in the runtime index", async () => {
  const fakeRedis = await startFakeRedisServer();
  const { app, baseUrl } = await startServer({
    stateStoreDriver: "redis",
    redisUrl: fakeRedis.url,
    redisKeyPrefix: "rocksolid:test:sessions"
  });

  try {
    const adminLogin = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const product = await postJson(baseUrl, "/api/admin/products", {
      code: "RUNTIMESESS",
      name: "Runtime Session Product"
    }, adminLogin.token);

    const policy = await postJson(baseUrl, "/api/admin/policies", {
      productCode: product.code,
      name: "Default Policy",
      durationDays: 30,
      bindMode: "strict"
    }, adminLogin.token);

    await postJson(baseUrl, "/api/admin/cards/batch", {
      productCode: product.code,
      policyId: policy.id,
      prefix: "RTS",
      count: 1
    }, adminLogin.token);

    const cards = await getJson(baseUrl, `/api/admin/cards?productCode=${product.code}`, adminLogin.token);
    const cardKey = cards.items[0].cardKey;

    await signedClientRequest(
      baseUrl,
      "/api/client/register",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: product.code,
        username: "runtime_user",
        password: "Pass123!abc",
        deviceFingerprint: "runtime-device-001"
      },
      { nonce: "runtime-register-001", timestamp: new Date().toISOString() }
    );

    await signedClientRequest(
      baseUrl,
      "/api/client/recharge",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: product.code,
        username: "runtime_user",
        password: "Pass123!abc",
        cardKey
      },
      { nonce: "runtime-recharge-001", timestamp: new Date().toISOString() }
    );

    const loginResult = await signedClientRequest(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: product.code,
        username: "runtime_user",
        password: "Pass123!abc",
        deviceFingerprint: "runtime-device-001"
      },
      { nonce: "runtime-login-001", timestamp: new Date().toISOString() }
    );
    assert.equal(loginResult.status, 200, JSON.stringify(loginResult.json));

    await waitFor(async () => {
      const health = await getJson(baseUrl, "/api/health");
      return health.storage.runtimeState.activeSessions === 1 ? health : null;
    });

    const dashboard = await getJson(baseUrl, "/api/admin/dashboard", adminLogin.token);
    assert.equal(dashboard.summary.onlineSessions, 1);
    assert.ok(
      fakeRedis.commandLog.some((entry) => entry[0] === "ZADD" && entry[1].includes(":sessions:active")),
      JSON.stringify(fakeRedis.commandLog)
    );
  } finally {
    await app.close();
    await fakeRedis.close();
  }
});

test("redis runtime state can invalidate heartbeat even if database session is manually reactivated", async () => {
  const fakeRedis = await startFakeRedisServer();
  const { app, baseUrl } = await startServer({
    stateStoreDriver: "redis",
    redisUrl: fakeRedis.url,
    redisKeyPrefix: "rocksolid:test:runtime-guard"
  });

  try {
    const adminLogin = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const product = await postJson(baseUrl, "/api/admin/products", {
      code: "RUNTIMEGUARD",
      name: "Runtime Guard Product"
    }, adminLogin.token);

    const policy = await postJson(baseUrl, "/api/admin/policies", {
      productCode: product.code,
      name: "Default Policy",
      durationDays: 30,
      bindMode: "strict"
    }, adminLogin.token);

    await postJson(baseUrl, "/api/admin/cards/batch", {
      productCode: product.code,
      policyId: policy.id,
      prefix: "RTG",
      count: 1
    }, adminLogin.token);

    const cards = await getJson(baseUrl, `/api/admin/cards?productCode=${product.code}`, adminLogin.token);
    const cardKey = cards.items[0].cardKey;

    await signedClientRequest(
      baseUrl,
      "/api/client/register",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: product.code,
        username: "runtime_guard",
        password: "Pass123!abc",
        deviceFingerprint: "runtime-guard-device"
      },
      { nonce: "runtime-guard-register", timestamp: new Date().toISOString() }
    );

    await signedClientRequest(
      baseUrl,
      "/api/client/recharge",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: product.code,
        username: "runtime_guard",
        password: "Pass123!abc",
        cardKey
      },
      { nonce: "runtime-guard-recharge", timestamp: new Date().toISOString() }
    );

    const loginResult = await signedClientRequest(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: product.code,
        username: "runtime_guard",
        password: "Pass123!abc",
        deviceFingerprint: "runtime-guard-device"
      },
      { nonce: "runtime-guard-login", timestamp: new Date().toISOString() }
    );
    assert.equal(loginResult.status, 200, JSON.stringify(loginResult.json));
    const sessionToken = loginResult.json.data.sessionToken;

    const logoutResult = await signedClientRequest(
      baseUrl,
      "/api/client/logout",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: product.code,
        sessionToken
      },
      { nonce: "runtime-guard-logout", timestamp: new Date().toISOString() }
    );
    assert.equal(logoutResult.status, 200, JSON.stringify(logoutResult.json));

    await waitFor(() =>
      fakeRedis.commandLog.some(
        (entry) => entry[0] === "HSET" && entry.includes("revokedReason") && entry.includes("client_logout")
      )
    );

    app.db.prepare(
      `
        UPDATE sessions
        SET status = 'active', revoked_reason = NULL
        WHERE session_token = ?
      `
    ).run(sessionToken);

    const heartbeatResult = await signedClientRequest(
      baseUrl,
      "/api/client/heartbeat",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: product.code,
        sessionToken,
        deviceFingerprint: "runtime-guard-device"
      },
      { nonce: "runtime-guard-heartbeat", timestamp: new Date().toISOString() }
    );
    assert.equal(heartbeatResult.status, 401, JSON.stringify(heartbeatResult.json));
    assert.equal(heartbeatResult.json.ok, false);
    assert.equal(heartbeatResult.json.error.code, "SESSION_INVALID");
    assert.equal(heartbeatResult.json.error.details.runtimeRevokedReason, "client_logout");
    assert.ok(
      fakeRedis.commandLog.some((entry) => entry[0] === "HGETALL"),
      JSON.stringify(fakeRedis.commandLog)
    );
  } finally {
    await app.close();
    await fakeRedis.close();
  }
});

test("redis single-session ownership invalidates the previous runtime owner", async () => {
  const fakeRedis = await startFakeRedisServer();
  const { app, baseUrl } = await startServer({
    stateStoreDriver: "redis",
    redisUrl: fakeRedis.url,
    redisKeyPrefix: "rocksolid:test:single-owner"
  });

  try {
    const adminLogin = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const product = await postJson(baseUrl, "/api/admin/products", {
      code: "SINGLEOWN",
      name: "Single Owner Product"
    }, adminLogin.token);

    const policy = await postJson(baseUrl, "/api/admin/policies", {
      productCode: product.code,
      name: "Single Policy",
      durationDays: 30,
      bindMode: "strict",
      allowConcurrentSessions: false
    }, adminLogin.token);

    await postJson(baseUrl, "/api/admin/cards/batch", {
      productCode: product.code,
      policyId: policy.id,
      prefix: "SGO",
      count: 1
    }, adminLogin.token);

    const cards = await getJson(baseUrl, `/api/admin/cards?productCode=${product.code}`, adminLogin.token);
    const cardKey = cards.items[0].cardKey;

    await signedClientRequest(
      baseUrl,
      "/api/client/register",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: product.code,
        username: "owner_user",
        password: "Pass123!abc",
        deviceFingerprint: "owner-device"
      },
      { nonce: "single-owner-register", timestamp: new Date().toISOString() }
    );

    await signedClientRequest(
      baseUrl,
      "/api/client/recharge",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: product.code,
        username: "owner_user",
        password: "Pass123!abc",
        cardKey
      },
      { nonce: "single-owner-recharge", timestamp: new Date().toISOString() }
    );

    const firstLogin = await signedClientRequest(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: product.code,
        username: "owner_user",
        password: "Pass123!abc",
        deviceFingerprint: "owner-device"
      },
      { nonce: "single-owner-login-1", timestamp: new Date().toISOString() }
    );
    assert.equal(firstLogin.status, 200, JSON.stringify(firstLogin.json));
    const firstSessionToken = firstLogin.json.data.sessionToken;

    const secondLogin = await signedClientRequest(
      baseUrl,
      "/api/client/login",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: product.code,
        username: "owner_user",
        password: "Pass123!abc",
        deviceFingerprint: "owner-device"
      },
      { nonce: "single-owner-login-2", timestamp: new Date().toISOString() }
    );
    assert.equal(secondLogin.status, 200, JSON.stringify(secondLogin.json));

    await waitFor(() =>
      fakeRedis.commandLog.some(
        (entry) => entry[0] === "GETSET" && entry[1].includes(":owner:")
      )
    );

    app.db.prepare(
      `
        UPDATE sessions
        SET status = 'active', revoked_reason = NULL
        WHERE session_token = ?
      `
    ).run(firstSessionToken);

    const heartbeatResult = await signedClientRequest(
      baseUrl,
      "/api/client/heartbeat",
      product.sdkAppId,
      product.sdkAppSecret,
      {
        productCode: product.code,
        sessionToken: firstSessionToken,
        deviceFingerprint: "owner-device"
      },
      { nonce: "single-owner-heartbeat-old", timestamp: new Date().toISOString() }
    );
    assert.equal(heartbeatResult.status, 401, JSON.stringify(heartbeatResult.json));
    assert.equal(heartbeatResult.json.ok, false);
    assert.equal(heartbeatResult.json.error.code, "SESSION_INVALID");
    assert.equal(heartbeatResult.json.error.details.runtimeRevokedReason, "single_session_runtime");
  } finally {
    await app.close();
    await fakeRedis.close();
  }
});
