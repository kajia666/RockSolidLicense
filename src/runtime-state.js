import net from "node:net";

function isoNow() {
  return new Date().toISOString();
}

function parseIso(value) {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function mapRedisHashArray(entries) {
  if (!Array.isArray(entries) || !entries.length) {
    return null;
  }

  const mapped = {};
  for (let index = 0; index < entries.length; index += 2) {
    const key = entries[index];
    const value = entries[index + 1];
    if (key !== null && key !== undefined) {
      mapped[key] = value;
    }
  }
  return mapped;
}

function normalizeStateStoreDriver(value) {
  const normalized = String(value ?? "sqlite").trim().toLowerCase();
  if (!["sqlite", "memory", "redis"].includes(normalized)) {
    throw new Error("RSL_STATE_STORE_DRIVER must be sqlite, memory, or redis.");
  }
  return normalized;
}

function countSqliteActiveSessions(db) {
  const row = db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE status = 'active'").get();
  return Number(row?.count ?? 0);
}

function parseRedisUrl(redisUrl) {
  const parsed = new URL(redisUrl);
  if (!["redis:", "rediss:"].includes(parsed.protocol)) {
    throw new Error("RSL_REDIS_URL must use redis:// or rediss://.");
  }
  if (parsed.protocol === "rediss:") {
    throw new Error("rediss:// is not supported yet. Use redis:// behind a trusted private network.");
  }

  return {
    host: parsed.hostname || "127.0.0.1",
    port: Number(parsed.port || 6379),
    password: parsed.password ? decodeURIComponent(parsed.password) : null,
    database: parsed.pathname && parsed.pathname !== "/"
      ? Number(parsed.pathname.slice(1))
      : 0
  };
}

function encodeRedisCommand(parts) {
  const segments = [`*${parts.length}\r\n`];
  for (const part of parts) {
    const value = String(part);
    segments.push(`$${Buffer.byteLength(value, "utf8")}\r\n${value}\r\n`);
  }
  return segments.join("");
}

function parseRedisResponse(buffer, offset = 0) {
  if (offset >= buffer.length) {
    return null;
  }

  const prefix = String.fromCharCode(buffer[offset]);
  if (prefix === "+" || prefix === "-" || prefix === ":") {
    const end = buffer.indexOf("\r\n", offset);
    if (end < 0) {
      return null;
    }
    const raw = buffer.toString("utf8", offset + 1, end);
    return {
      value:
        prefix === "+" ? raw :
        prefix === "-" ? { error: raw } :
        Number(raw),
      nextOffset: end + 2
    };
  }

  if (prefix === "$") {
    const end = buffer.indexOf("\r\n", offset);
    if (end < 0) {
      return null;
    }
    const length = Number(buffer.toString("utf8", offset + 1, end));
    if (length === -1) {
      return {
        value: null,
        nextOffset: end + 2
      };
    }
    const bodyStart = end + 2;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd + 2) {
      return null;
    }
    return {
      value: buffer.toString("utf8", bodyStart, bodyEnd),
      nextOffset: bodyEnd + 2
    };
  }

  if (prefix === "*") {
    const end = buffer.indexOf("\r\n", offset);
    if (end < 0) {
      return null;
    }
    const count = Number(buffer.toString("utf8", offset + 1, end));
    if (count === -1) {
      return {
        value: null,
        nextOffset: end + 2
      };
    }

    const values = [];
    let nextOffset = end + 2;
    for (let index = 0; index < count; index += 1) {
      const result = parseRedisResponse(buffer, nextOffset);
      if (!result) {
        return null;
      }
      values.push(result.value);
      nextOffset = result.nextOffset;
    }
    return {
      value: values,
      nextOffset
    };
  }

  throw new Error(`Unsupported Redis RESP prefix: ${prefix}`);
}

function runRedisCommands(connection, commands) {
  const preparedCommands = [];
  if (connection.password) {
    preparedCommands.push(["AUTH", connection.password]);
  }
  if (connection.database > 0) {
    preparedCommands.push(["SELECT", connection.database]);
  }
  preparedCommands.push(...commands);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: connection.host,
      port: connection.port
    });
    const expectedResponses = preparedCommands.length;
    const responses = [];
    let buffer = Buffer.alloc(0);
    let settled = false;

    function finishWithError(error) {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(error);
    }

    function finishWithSuccess(value) {
      if (settled) {
        return;
      }
      settled = true;
      socket.end();
      resolve(value);
    }

    socket.setNoDelay(true);

    socket.on("connect", () => {
      const payload = preparedCommands.map((command) => encodeRedisCommand(command)).join("");
      socket.write(payload);
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (responses.length < expectedResponses) {
        const parsed = parseRedisResponse(buffer, 0);
        if (!parsed) {
          break;
        }
        buffer = buffer.subarray(parsed.nextOffset);
        if (parsed.value && typeof parsed.value === "object" && "error" in parsed.value) {
          finishWithError(new Error(`Redis error: ${parsed.value.error}`));
          return;
        }
        responses.push(parsed.value);
      }

      if (responses.length >= expectedResponses) {
        const offset = expectedResponses - commands.length;
        finishWithSuccess(responses.slice(offset));
      }
    });

    socket.on("error", (error) => {
      finishWithError(error);
    });

    socket.on("end", () => {
      if (!settled && responses.length < expectedResponses) {
        finishWithError(new Error("Redis connection closed before all responses were received."));
      }
    });
  });
}

export class NonceReplayError extends Error {
  constructor(appId, nonce) {
    super("Nonce has already been used.");
    this.name = "NonceReplayError";
    this.appId = appId;
    this.nonce = nonce;
  }
}

function formatDatabaseSessionState(row) {
  if (!row) {
    return null;
  }

  return {
    status: row.status ?? null,
    revokedReason: row.revoked_reason ?? null,
    expiresAt: row.expires_at ?? null,
    lastHeartbeatAt: row.last_heartbeat_at ?? null
  };
}

async function getMainStoreSessionState(db, mainStore, sessionToken) {
  if (!mainStore?.sessions?.getSessionRecordByToken) {
    return null;
  }

  const row = await Promise.resolve(mainStore.sessions.getSessionRecordByToken(db, sessionToken));
  return formatDatabaseSessionState(row);
}

async function countMainStoreActiveSessions(db, mainStore) {
  if (!mainStore?.sessions?.countActiveSessionsByProductIds) {
    return countSqliteActiveSessions(db);
  }

  const rows = await Promise.resolve(mainStore.sessions.countActiveSessionsByProductIds(db, null));
  return rows.reduce((total, row) => total + Number(row.count ?? 0), 0);
}

export function createRuntimeStateStore({ db, config, mainStore = null }) {
  const driver = normalizeStateStoreDriver(config.stateStoreDriver);
  if (driver === "memory") {
    return createMemoryRuntimeStateStore(db, config);
  }
  if (driver === "redis") {
    return createRedisRuntimeStateStore(db, config);
  }
  return createSqliteRuntimeStateStore(db, config, mainStore);
}

function createSqliteRuntimeStateStore(db, config, mainStore = null) {
  return {
    driver: "sqlite",

    registerNonceOrThrow(appId, nonce, expiresAt) {
      db.prepare("DELETE FROM request_nonces WHERE expires_at <= ?").run(isoNow());
      try {
        db.prepare(
          `
            INSERT INTO request_nonces (app_id, nonce, expires_at)
            VALUES (?, ?, ?)
          `
        ).run(appId, nonce, expiresAt);
      } catch {
        throw new NonceReplayError(appId, nonce);
      }
    },

    recordSession() {},

    async commitSessionRuntime() {
      return { previousSessionToken: null };
    },

    touchSession() {},

    expireSession() {},

    async getSessionState(sessionToken) {
      const storeRow = await getMainStoreSessionState(db, mainStore, sessionToken);
      if (storeRow) {
        return storeRow;
      }

      const row = db.prepare(
        `
          SELECT status, revoked_reason, expires_at, last_heartbeat_at
          FROM sessions
          WHERE session_token = ?
        `
      ).get(sessionToken);
      return formatDatabaseSessionState(row);
    },

    async countActiveSessions() {
      return countMainStoreActiveSessions(db, mainStore);
    },

    async health() {
      return {
        driver: "sqlite",
        nonceReplayStore: "sqlite_table",
        sessionPresenceStore: "database",
        persistence: "database",
        activeSessions: await this.countActiveSessions(),
        redisUrlConfigured: Boolean(config.redisUrl),
        redisKeyPrefix: config.redisKeyPrefix,
        externalReady: false
      };
    },

    close() {}
  };
}

function createMemoryRuntimeStateStore(db, config) {
  const nonces = new Map();
  const sessions = new Map();
  const singleSessionOwners = new Map();

  function ownerKey(productId, accountId) {
    return `${productId}:${accountId}`;
  }

  function pruneExpiredNonces(now = Date.now()) {
    for (const [key, expiresAt] of nonces.entries()) {
      if (expiresAt <= now) {
        nonces.delete(key);
      }
    }
  }

  function pruneExpiredSessions(now = Date.now()) {
    for (const [sessionToken, session] of sessions.entries()) {
      if (session.status !== "active") {
        continue;
      }
      const expiresAt = parseIso(session.expiresAt);
      if (expiresAt !== null && expiresAt <= now) {
        sessions.set(sessionToken, {
          ...session,
          status: "expired",
          revokedReason: session.revokedReason ?? "token_expired"
        });
      }
    }
  }

  return {
    driver: "memory",

    registerNonceOrThrow(appId, nonce, expiresAt) {
      pruneExpiredNonces();
      const expiresAtMs = parseIso(expiresAt) ?? Date.now();
      const key = `${appId}:${nonce}`;
      if (nonces.has(key)) {
        throw new NonceReplayError(appId, nonce);
      }
      nonces.set(key, expiresAtMs);
    },

    recordSession(session) {
      pruneExpiredSessions();
      sessions.set(session.sessionToken, {
        ...session,
        status: session.status ?? "active"
      });
    },

    async commitSessionRuntime(session, options = {}) {
      this.recordSession(session);
      if (!options.claimSingleOwner) {
        return { previousSessionToken: null };
      }

      const key = ownerKey(session.productId, session.accountId);
      const previousSessionToken = singleSessionOwners.get(key) ?? null;
      singleSessionOwners.set(key, session.sessionToken);
      if (previousSessionToken && previousSessionToken !== session.sessionToken) {
        this.expireSession(previousSessionToken, "single_session_runtime");
      }

      return {
        previousSessionToken:
          previousSessionToken && previousSessionToken !== session.sessionToken
            ? previousSessionToken
            : null
      };
    },

    touchSession(sessionToken, patch = {}) {
      pruneExpiredSessions();
      const existing = sessions.get(sessionToken);
      if (!existing) {
        return;
      }
      sessions.set(sessionToken, {
        ...existing,
        ...patch
      });
    },

    expireSession(sessionToken, reason) {
      const existing = sessions.get(sessionToken);
      if (!existing) {
        return;
      }
      sessions.set(sessionToken, {
        ...existing,
        status: "expired",
        revokedReason: reason
      });

      for (const [key, ownerToken] of singleSessionOwners.entries()) {
        if (ownerToken === sessionToken) {
          singleSessionOwners.delete(key);
        }
      }
    },

    async getSessionState(sessionToken) {
      pruneExpiredSessions();
      const existing = sessions.get(sessionToken);
      if (!existing) {
        return null;
      }
      return {
        status: existing.status ?? null,
        revokedReason: existing.revokedReason ?? null,
        expiresAt: existing.expiresAt ?? null,
        lastHeartbeatAt: existing.lastHeartbeatAt ?? null
      };
    },

    async countActiveSessions() {
      pruneExpiredSessions();
      let count = 0;
      for (const session of sessions.values()) {
        if (session.status === "active") {
          count += 1;
        }
      }
      return count;
    },

    async health() {
      pruneExpiredNonces();
      pruneExpiredSessions();
      return {
        driver: "memory",
        nonceReplayStore: "process_memory",
        sessionPresenceStore: "process_memory",
        persistence: "ephemeral",
        activeSessions: await this.countActiveSessions(),
        trackedNonces: nonces.size,
        redisUrlConfigured: Boolean(config.redisUrl),
        redisKeyPrefix: config.redisKeyPrefix,
        externalReady: false
      };
    },

    close() {
      nonces.clear();
      sessions.clear();
    }
  };
}

function createRedisRuntimeStateStore(db, config) {
  if (!config.redisUrl) {
    throw new Error("RSL_REDIS_URL is required when RSL_STATE_STORE_DRIVER=redis.");
  }

  const connection = parseRedisUrl(config.redisUrl);
  const state = {
    externalReady: false,
    lastError: null,
    lastSyncAt: null,
    closed: false
  };

  function nonceKey(appId, nonce) {
    return `${config.redisKeyPrefix}:nonce:${appId}:${nonce}`;
  }

  function sessionKey(sessionToken) {
    return `${config.redisKeyPrefix}:session:${sessionToken}`;
  }

  function activeSessionsKey() {
    return `${config.redisKeyPrefix}:sessions:active`;
  }

  function ownerKey(productId, accountId) {
    return `${config.redisKeyPrefix}:owner:${productId}:${accountId}`;
  }

  async function execute(commands, { background = false } = {}) {
    if (state.closed) {
      return [];
    }

    try {
      const result = await runRedisCommands(connection, commands);
      state.externalReady = true;
      state.lastError = null;
      state.lastSyncAt = isoNow();
      return result;
    } catch (error) {
      state.externalReady = false;
      state.lastError = error.message;
      if (!background) {
        throw error;
      }
      return [];
    }
  }

  function dispatchSessionMirror(commands) {
    void execute(commands, { background: true });
  }

  void execute([["PING"]], { background: true });

  return {
    driver: "redis",

    async registerNonceOrThrow(appId, nonce, expiresAt) {
      const expiresAtMs = parseIso(expiresAt);
      const ttlMs = Math.max(1000, (expiresAtMs ?? Date.now()) - Date.now());
      const [reply] = await execute([
        ["SET", nonceKey(appId, nonce), "1", "NX", "PX", ttlMs]
      ]);

      if (reply !== "OK") {
        throw new NonceReplayError(appId, nonce);
      }
    },

    recordSession(session) {
      const expiresAtMs = parseIso(session.expiresAt);
      const ttlSeconds = Math.max(
        1,
        Math.ceil(((expiresAtMs ?? Date.now()) - Date.now()) / 1000)
      );
      dispatchSessionMirror([
        [
          "HSET",
          sessionKey(session.sessionToken),
          "sessionId", session.sessionId,
          "productId", session.productId,
          "accountId", session.accountId,
          "entitlementId", session.entitlementId,
          "deviceId", session.deviceId,
          "status", session.status ?? "active",
          "issuedAt", session.issuedAt,
          "expiresAt", session.expiresAt,
          "lastHeartbeatAt", session.lastHeartbeatAt,
          "lastSeenIp", session.lastSeenIp ?? "",
          "userAgent", session.userAgent ?? ""
        ],
        ["EXPIRE", sessionKey(session.sessionToken), ttlSeconds],
        ["ZADD", activeSessionsKey(), expiresAtMs ?? Date.now(), session.sessionToken]
      ]);
    },

    async commitSessionRuntime(session, options = {}) {
      const expiresAtMs = parseIso(session.expiresAt);
      const ttlSeconds = Math.max(
        1,
        Math.ceil(((expiresAtMs ?? Date.now()) - Date.now()) / 1000)
      );
      const commands = [
        [
          "HSET",
          sessionKey(session.sessionToken),
          "sessionId", session.sessionId,
          "productId", session.productId,
          "accountId", session.accountId,
          "entitlementId", session.entitlementId,
          "deviceId", session.deviceId,
          "status", session.status ?? "active",
          "issuedAt", session.issuedAt,
          "expiresAt", session.expiresAt,
          "lastHeartbeatAt", session.lastHeartbeatAt,
          "lastSeenIp", session.lastSeenIp ?? "",
          "userAgent", session.userAgent ?? ""
        ],
        ["EXPIRE", sessionKey(session.sessionToken), ttlSeconds],
        ["ZADD", activeSessionsKey(), expiresAtMs ?? Date.now(), session.sessionToken]
      ];

      let previousOwnerOffset = -1;
      if (options.claimSingleOwner) {
        previousOwnerOffset = commands.length;
        commands.push(["GETSET", ownerKey(session.productId, session.accountId), session.sessionToken]);
        commands.push(["EXPIRE", ownerKey(session.productId, session.accountId), ttlSeconds]);
      }

      const replies = await execute(commands, { background: false });
      const previousSessionToken = previousOwnerOffset >= 0
        ? replies[previousOwnerOffset]
        : null;

      if (previousSessionToken && previousSessionToken !== session.sessionToken) {
        await execute([
          ["HSET", sessionKey(previousSessionToken), "status", "expired", "revokedReason", "single_session_runtime"],
          ["EXPIRE", sessionKey(previousSessionToken), 60],
          ["ZREM", activeSessionsKey(), previousSessionToken]
        ], { background: false });
      }

      return {
        previousSessionToken:
          previousSessionToken && previousSessionToken !== session.sessionToken
            ? previousSessionToken
            : null
      };
    },

    touchSession(sessionToken, patch = {}) {
      const updates = [];
      if (patch.expiresAt) {
        updates.push("expiresAt", patch.expiresAt);
      }
      if (patch.lastHeartbeatAt) {
        updates.push("lastHeartbeatAt", patch.lastHeartbeatAt);
      }
      if (patch.lastSeenIp) {
        updates.push("lastSeenIp", patch.lastSeenIp);
      }
      if (patch.userAgent) {
        updates.push("userAgent", patch.userAgent);
      }
      if (!updates.length) {
        return;
      }

      const commands = [["HSET", sessionKey(sessionToken), ...updates]];
      if (patch.expiresAt) {
        const expiresAtMs = parseIso(patch.expiresAt);
        const ttlSeconds = Math.max(
          1,
          Math.ceil(((expiresAtMs ?? Date.now()) - Date.now()) / 1000)
        );
        commands.push(["EXPIRE", sessionKey(sessionToken), ttlSeconds]);
        commands.push(["ZADD", activeSessionsKey(), expiresAtMs ?? Date.now(), sessionToken]);
      }
      dispatchSessionMirror(commands);
    },

    expireSession(sessionToken, reason) {
      dispatchSessionMirror([
        ["HSET", sessionKey(sessionToken), "status", "expired", "revokedReason", reason],
        ["EXPIRE", sessionKey(sessionToken), 60],
        ["ZREM", activeSessionsKey(), sessionToken]
      ]);
    },

    async getSessionState(sessionToken) {
      const [entries] = await execute([
        ["HGETALL", sessionKey(sessionToken)]
      ], { background: false });
      const mapped = mapRedisHashArray(entries);
      if (!mapped) {
        return null;
      }
      return {
        status: mapped.status ?? null,
        revokedReason: mapped.revokedReason ?? null,
        expiresAt: mapped.expiresAt ?? null,
        lastHeartbeatAt: mapped.lastHeartbeatAt ?? null
      };
    },

    async countActiveSessions() {
      const [, activeCount] = await execute([
        ["ZREMRANGEBYSCORE", activeSessionsKey(), "-inf", Date.now()],
        ["ZCARD", activeSessionsKey()]
      ], { background: false });
      return Number(activeCount ?? 0);
    },

    async health() {
      return {
        driver: "redis",
        nonceReplayStore: "redis",
        sessionPresenceStore: "redis_mirror",
        persistence: "external_runtime",
        activeSessions: await this.countActiveSessions(),
        redisUrlConfigured: true,
        redisKeyPrefix: config.redisKeyPrefix,
        externalReady: state.externalReady,
        lastSyncAt: state.lastSyncAt,
        lastError: state.lastError
      };
    },

    close() {
      state.closed = true;
    }
  };
}
