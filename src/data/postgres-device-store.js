import { AppError } from "../http.js";
import { addDays, generateId, nowIso } from "../security.js";

function safeParseJsonObject(value, fallback = {}) {
  if (!value) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Ignore malformed legacy payloads and fall back to a safe object.
  }

  return fallback;
}

function compactDeviceProfile(profile = {}) {
  return Object.fromEntries(
    Object.entries(profile).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

function resolveMaxDevices(entitlement) {
  return Number(entitlement.max_devices ?? entitlement.maxDevices ?? 0);
}

async function loadDeviceRecord(tx, deviceId) {
  const rows = await Promise.resolve(tx.query(
    `
      SELECT *
      FROM devices
      WHERE id = $1
      LIMIT 1
    `,
    [deviceId],
    {
      repository: "devices",
      operation: "loadDeviceRecordById",
      deviceId
    }
  ));

  return rows[0] ?? null;
}

async function loadDeviceByFingerprint(tx, productId, fingerprint) {
  const rows = await Promise.resolve(tx.query(
    `
      SELECT *
      FROM devices
      WHERE product_id = $1 AND fingerprint = $2
      LIMIT 1
    `,
    [productId, fingerprint],
    {
      repository: "devices",
      operation: "loadDeviceByFingerprint",
      productId,
      fingerprint
    }
  ));

  return rows[0] ?? null;
}

async function loadBindingRecord(tx, bindingId) {
  const rows = await Promise.resolve(tx.query(
    `
      SELECT *
      FROM device_bindings
      WHERE id = $1
      LIMIT 1
    `,
    [bindingId],
    {
      repository: "devices",
      operation: "loadBindingRecordById",
      bindingId
    }
  ));

  return rows[0] ?? null;
}

async function loadEntitlementUnbindLog(tx, logId) {
  const rows = await Promise.resolve(tx.query(
    `
      SELECT *
      FROM entitlement_unbind_logs
      WHERE id = $1
      LIMIT 1
    `,
    [logId],
    {
      repository: "devices",
      operation: "loadEntitlementUnbindLog",
      logId
    }
  ));

  return rows[0] ?? null;
}

async function loadBindingByEntitlementDevice(tx, entitlementId, deviceId) {
  const rows = await Promise.resolve(tx.query(
    `
      SELECT *
      FROM device_bindings
      WHERE entitlement_id = $1 AND device_id = $2
      LIMIT 1
    `,
    [entitlementId, deviceId],
    {
      repository: "devices",
      operation: "loadBindingByEntitlementDevice",
      entitlementId,
      deviceId
    }
  ));

  return rows[0] ?? null;
}

async function loadBindingByIdentityHash(tx, entitlementId, identityHash) {
  const rows = await Promise.resolve(tx.query(
    `
      SELECT b.*, bp.identity_hash
      FROM device_binding_profiles bp
      JOIN device_bindings b ON b.id = bp.binding_id
      WHERE bp.entitlement_id = $1 AND bp.identity_hash = $2
      LIMIT 1
    `,
    [entitlementId, identityHash],
    {
      repository: "devices",
      operation: "loadBindingByIdentityHash",
      entitlementId,
      identityHash
    }
  ));

  return rows[0] ?? null;
}

async function countActiveBindingsForEntitlement(tx, entitlementId) {
  const rows = await Promise.resolve(tx.query(
    `
      SELECT COUNT(*) AS count
      FROM device_bindings
      WHERE entitlement_id = $1 AND status = 'active'
    `,
    [entitlementId],
    {
      repository: "devices",
      operation: "countActiveBindingsForEntitlement",
      entitlementId
    }
  ));

  return Number(rows[0]?.count ?? 0);
}

async function upsertBindingProfile(tx, binding, device, bindingIdentity, timestamp = nowIso()) {
  await Promise.resolve(tx.query(
    `
      INSERT INTO device_binding_profiles
      (binding_id, entitlement_id, device_id, identity_hash, match_fields_json, identity_json, request_ip, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT(binding_id) DO UPDATE SET
        entitlement_id = EXCLUDED.entitlement_id,
        device_id = EXCLUDED.device_id,
        identity_hash = EXCLUDED.identity_hash,
        match_fields_json = EXCLUDED.match_fields_json,
        identity_json = EXCLUDED.identity_json,
        request_ip = EXCLUDED.request_ip,
        updated_at = EXCLUDED.updated_at
    `,
    [
      binding.id,
      binding.entitlement_id,
      device.id,
      bindingIdentity.identityHash,
      JSON.stringify(bindingIdentity.bindFields),
      JSON.stringify(bindingIdentity.identity),
      bindingIdentity.requestIp ?? null,
      timestamp,
      timestamp
    ],
    {
      repository: "devices",
      operation: "upsertBindingProfile",
      bindingId: binding.id,
      entitlementId: binding.entitlement_id,
      deviceId: device.id
    }
  ));
}

export function createPostgresDeviceStore(adapter) {
  if (!adapter || typeof adapter.withTransaction !== "function") {
    return {};
  }

  return {
    async upsertDevice(productId, fingerprint, deviceName, meta = {}, deviceProfile = {}, timestamp = nowIso()) {
      return adapter.withTransaction(async (tx) => {
        const existing = await loadDeviceByFingerprint(tx, productId, fingerprint);
        const previousMetadata = existing ? safeParseJsonObject(existing.metadata_json) : {};
        const metadataJson = JSON.stringify({
          ...previousMetadata,
          userAgent: meta.userAgent,
          requestIp: meta.ip ?? null,
          deviceProfile: compactDeviceProfile(deviceProfile)
        });

        if (existing) {
          await Promise.resolve(tx.query(
            `
              UPDATE devices
              SET device_name = $1, last_seen_at = $2, last_seen_ip = $3, metadata_json = $4
              WHERE id = $5
            `,
            [
              deviceName ?? existing.device_name,
              timestamp,
              meta.ip ?? null,
              metadataJson,
              existing.id
            ],
            {
              repository: "devices",
              operation: "updateDevice",
              deviceId: existing.id,
              productId
            }
          ));

          return loadDeviceRecord(tx, existing.id);
        }

        const deviceId = generateId("dev");
        await Promise.resolve(tx.query(
          `
            INSERT INTO devices
            (id, product_id, fingerprint, device_name, first_seen_at, last_seen_at, last_seen_ip, metadata_json)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [
            deviceId,
            productId,
            fingerprint,
            deviceName ?? "Unnamed Device",
            timestamp,
            timestamp,
            meta.ip ?? null,
            metadataJson
          ],
          {
            repository: "devices",
            operation: "createDevice",
            deviceId,
            productId,
            fingerprint
          }
        ));

        return loadDeviceRecord(tx, deviceId);
      });
    },

    async releaseBinding(bindingId, timestamp = nowIso()) {
      return adapter.withTransaction(async (tx) => {
        await Promise.resolve(tx.query(
          `
            UPDATE device_bindings
            SET status = 'revoked', revoked_at = $1, last_bound_at = $2
            WHERE id = $3
          `,
          [timestamp, timestamp, bindingId],
          {
            repository: "devices",
            operation: "releaseBinding",
            bindingId
          }
        ));

        return loadBindingRecord(tx, bindingId);
      });
    },

    async bindDeviceToEntitlement(entitlement, device, bindingIdentity, options = {}) {
      const releaseSessions = typeof options.releaseSessions === "function"
        ? options.releaseSessions
        : () => 0;
      const now = options.timestamp ?? nowIso();

      return adapter.withTransaction(async (tx) => {
        const existing = await loadBindingByEntitlementDevice(tx, entitlement.id, device.id);

        if (existing?.status === "active") {
          await Promise.resolve(tx.query(
            `
              UPDATE device_bindings
              SET last_bound_at = $1
              WHERE id = $2
            `,
            [now, existing.id],
            {
              repository: "devices",
              operation: "touchBinding",
              bindingId: existing.id
            }
          ));

          const binding = await loadBindingRecord(tx, existing.id);
          await upsertBindingProfile(tx, binding, device, bindingIdentity, now);
          return {
            binding,
            mode: "exact_active",
            releasedSessions: 0
          };
        }

        if (existing) {
          await Promise.resolve(tx.query(
            `
              UPDATE device_bindings
              SET status = 'active', revoked_at = NULL, last_bound_at = $1
              WHERE id = $2
            `,
            [now, existing.id],
            {
              repository: "devices",
              operation: "reactivateBinding",
              bindingId: existing.id
            }
          ));

          const binding = await loadBindingRecord(tx, existing.id);
          await upsertBindingProfile(tx, binding, device, bindingIdentity, now);
          return {
            binding,
            mode: "exact_reactivated",
            releasedSessions: 0
          };
        }

        const profileMatch = await loadBindingByIdentityHash(tx, entitlement.id, bindingIdentity.identityHash);
        if (profileMatch) {
          let releasedSessions = 0;

          if (profileMatch.status === "active" && profileMatch.device_id !== device.id) {
            releasedSessions = Number(await Promise.resolve(releaseSessions({
              entitlementId: entitlement.id,
              deviceId: profileMatch.device_id,
              reason: "binding_rebound"
            })) ?? 0);
          }

          await Promise.resolve(tx.query(
            `
              UPDATE device_bindings
              SET device_id = $1, status = 'active', revoked_at = NULL, last_bound_at = $2
              WHERE id = $3
            `,
            [device.id, now, profileMatch.id],
            {
              repository: "devices",
              operation: "rebindIdentityMatch",
              bindingId: profileMatch.id,
              deviceId: device.id
            }
          ));

          const binding = await loadBindingRecord(tx, profileMatch.id);
          await upsertBindingProfile(tx, binding, device, bindingIdentity, now);
          return {
            binding,
            mode: profileMatch.status === "active" ? "identity_rebound" : "identity_reactivated",
            releasedSessions
          };
        }

        const activeCount = await countActiveBindingsForEntitlement(tx, entitlement.id);
        const maxDevices = resolveMaxDevices(entitlement);
        if (activeCount >= maxDevices) {
          throw new AppError(
            409,
            "DEVICE_LIMIT_REACHED",
            `This license plan allows at most ${maxDevices} bound device(s).`,
            {
              bindMode: bindingIdentity.bindMode,
              bindFields: bindingIdentity.bindFields
            }
          );
        }

        const bindingId = generateId("bind");
        await Promise.resolve(tx.query(
          `
            INSERT INTO device_bindings
            (id, entitlement_id, device_id, status, first_bound_at, last_bound_at)
            VALUES ($1, $2, $3, 'active', $4, $5)
          `,
          [bindingId, entitlement.id, device.id, now, now],
          {
            repository: "devices",
            operation: "createBinding",
            bindingId,
            entitlementId: entitlement.id,
            deviceId: device.id
          }
        ));

        const binding = await loadBindingRecord(tx, bindingId);
        await upsertBindingProfile(tx, binding, device, bindingIdentity, now);
        return {
          binding,
          mode: "new_binding",
          releasedSessions: 0
        };
      });
    },

    async countRecentClientUnbinds(_db, entitlementId, windowDays, referenceTime = nowIso()) {
      const since = addDays(referenceTime, -Math.max(1, Number(windowDays ?? 1)));
      const rows = await Promise.resolve(adapter.query(
        `
          SELECT COUNT(*) AS count
          FROM entitlement_unbind_logs
          WHERE entitlement_id = $1
            AND actor_type = 'client'
            AND created_at >= $2
        `,
        [entitlementId, since],
        {
          repository: "devices",
          operation: "countRecentClientUnbinds",
          entitlementId,
          since
        }
      ));

      return Number(rows[0]?.count ?? 0);
    },

    async recordEntitlementUnbind(entitlementId, bindingId, actorType, actorId, reason, deductedDays, timestamp = nowIso()) {
      return adapter.withTransaction(async (tx) => {
        const logId = generateId("unbind");
        await Promise.resolve(tx.query(
          `
            INSERT INTO entitlement_unbind_logs
            (id, entitlement_id, binding_id, actor_type, actor_id, reason, deducted_days, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [logId, entitlementId, bindingId, actorType, actorId, reason, deductedDays, timestamp],
          {
            repository: "devices",
            operation: "recordEntitlementUnbind",
            logId,
            entitlementId,
            bindingId
          }
        ));

        return loadEntitlementUnbindLog(tx, logId);
      });
    }
  };
}
