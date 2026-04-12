function isoNow() {
  return new Date().toISOString();
}

function parseIso(value) {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function normalizeStateStoreDriver(value) {
  const normalized = String(value ?? "sqlite").trim().toLowerCase();
  if (!["sqlite", "memory"].includes(normalized)) {
    throw new Error("RSL_STATE_STORE_DRIVER must be sqlite or memory.");
  }
  return normalized;
}

export class NonceReplayError extends Error {
  constructor(appId, nonce) {
    super("Nonce has already been used.");
    this.name = "NonceReplayError";
    this.appId = appId;
    this.nonce = nonce;
  }
}

export function createRuntimeStateStore({ db, config }) {
  const driver = normalizeStateStoreDriver(config.stateStoreDriver);
  if (driver === "memory") {
    return createMemoryRuntimeStateStore(config);
  }
  return createSqliteRuntimeStateStore(db, config);
}

function createSqliteRuntimeStateStore(db, config) {
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

    touchSession() {},

    expireSession() {},

    countActiveSessions() {
      const row = db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE status = 'active'").get();
      return Number(row?.count ?? 0);
    },

    health() {
      return {
        driver: "sqlite",
        nonceReplayStore: "sqlite_table",
        sessionPresenceStore: "database",
        persistence: "database",
        activeSessions: this.countActiveSessions(),
        redisUrlConfigured: Boolean(config.redisUrl),
        redisKeyPrefix: config.redisKeyPrefix,
        externalReady: false
      };
    },

    close() {}
  };
}

function createMemoryRuntimeStateStore(config) {
  const nonces = new Map();
  const sessions = new Map();

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
    },

    countActiveSessions() {
      pruneExpiredSessions();
      let count = 0;
      for (const session of sessions.values()) {
        if (session.status === "active") {
          count += 1;
        }
      }
      return count;
    },

    health() {
      pruneExpiredNonces();
      pruneExpiredSessions();
      return {
        driver: "memory",
        nonceReplayStore: "process_memory",
        sessionPresenceStore: "process_memory",
        persistence: "ephemeral",
        activeSessions: this.countActiveSessions(),
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
