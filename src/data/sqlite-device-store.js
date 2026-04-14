import { AppError } from "../http.js";
import { generateId, nowIso } from "../security.js";

function one(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

function run(db, sql, ...params) {
  return db.prepare(sql).run(...params);
}

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

function getBindingRowById(db, bindingId) {
  return one(db, "SELECT * FROM device_bindings WHERE id = ?", bindingId);
}

function upsertBindingProfile(db, binding, device, bindingIdentity, timestamp = nowIso()) {
  const existing = one(db, "SELECT binding_id FROM device_binding_profiles WHERE binding_id = ?", binding.id);
  const matchFieldsJson = JSON.stringify(bindingIdentity.bindFields);
  const identityJson = JSON.stringify(bindingIdentity.identity);

  if (existing) {
    run(
      db,
      `
        UPDATE device_binding_profiles
        SET entitlement_id = ?, device_id = ?, identity_hash = ?, match_fields_json = ?, identity_json = ?,
            request_ip = ?, updated_at = ?
        WHERE binding_id = ?
      `,
      binding.entitlement_id,
      device.id,
      bindingIdentity.identityHash,
      matchFieldsJson,
      identityJson,
      bindingIdentity.requestIp,
      timestamp,
      binding.id
    );
    return;
  }

  run(
    db,
    `
      INSERT INTO device_binding_profiles
      (binding_id, entitlement_id, device_id, identity_hash, match_fields_json, identity_json, request_ip, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    binding.id,
    binding.entitlement_id,
    device.id,
    bindingIdentity.identityHash,
    matchFieldsJson,
    identityJson,
    bindingIdentity.requestIp,
    timestamp,
    timestamp
  );
}

export function createSqliteDeviceStore({ db }) {
  return {
    upsertDevice(productId, fingerprint, deviceName, meta = {}, deviceProfile = {}, timestamp = nowIso()) {
      const existing = one(
        db,
        "SELECT * FROM devices WHERE product_id = ? AND fingerprint = ?",
        productId,
        fingerprint
      );

      const previousMetadata = existing ? safeParseJsonObject(existing.metadata_json) : {};
      const metadataJson = JSON.stringify({
        ...previousMetadata,
        userAgent: meta.userAgent,
        requestIp: meta.ip ?? null,
        deviceProfile: compactDeviceProfile(deviceProfile)
      });

      if (existing) {
        run(
          db,
          `
            UPDATE devices
            SET device_name = ?, last_seen_at = ?, last_seen_ip = ?, metadata_json = ?
            WHERE id = ?
          `,
          deviceName ?? existing.device_name,
          timestamp,
          meta.ip ?? null,
          metadataJson,
          existing.id
        );
        return one(db, "SELECT * FROM devices WHERE id = ?", existing.id);
      }

      const deviceId = generateId("dev");
      run(
        db,
        `
          INSERT INTO devices (id, product_id, fingerprint, device_name, first_seen_at, last_seen_at, last_seen_ip, metadata_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        deviceId,
        productId,
        fingerprint,
        deviceName ?? "Unnamed Device",
        timestamp,
        timestamp,
        meta.ip ?? null,
        metadataJson
      );

      return one(db, "SELECT * FROM devices WHERE id = ?", deviceId);
    },

    bindDeviceToEntitlement(entitlement, device, bindingIdentity, options = {}) {
      const releaseSessions = typeof options.releaseSessions === "function"
        ? options.releaseSessions
        : () => 0;
      const now = options.timestamp ?? nowIso();

      const existing = one(
        db,
        `
          SELECT * FROM device_bindings
          WHERE entitlement_id = ? AND device_id = ?
        `,
        entitlement.id,
        device.id
      );

      if (existing?.status === "active") {
        run(db, "UPDATE device_bindings SET last_bound_at = ? WHERE id = ?", now, existing.id);
        const binding = getBindingRowById(db, existing.id);
        upsertBindingProfile(db, binding, device, bindingIdentity, now);
        return {
          binding,
          mode: "exact_active",
          releasedSessions: 0
        };
      }

      if (existing) {
        run(
          db,
          `
            UPDATE device_bindings
            SET status = 'active', revoked_at = NULL, last_bound_at = ?
            WHERE id = ?
          `,
          now,
          existing.id
        );
        const binding = getBindingRowById(db, existing.id);
        upsertBindingProfile(db, binding, device, bindingIdentity, now);
        return {
          binding,
          mode: "exact_reactivated",
          releasedSessions: 0
        };
      }

      const profileMatch = one(
        db,
        `
          SELECT b.*, bp.identity_hash
          FROM device_binding_profiles bp
          JOIN device_bindings b ON b.id = bp.binding_id
          WHERE bp.entitlement_id = ? AND bp.identity_hash = ?
        `,
        entitlement.id,
        bindingIdentity.identityHash
      );

      if (profileMatch) {
        let releasedSessions = 0;

        if (profileMatch.status === "active" && profileMatch.device_id !== device.id) {
          releasedSessions = Number(releaseSessions({
            entitlementId: entitlement.id,
            deviceId: profileMatch.device_id,
            reason: "binding_rebound"
          }) ?? 0);
        }

        run(
          db,
          `
            UPDATE device_bindings
            SET device_id = ?, status = 'active', revoked_at = NULL, last_bound_at = ?
            WHERE id = ?
          `,
          device.id,
          now,
          profileMatch.id
        );

        const binding = getBindingRowById(db, profileMatch.id);
        upsertBindingProfile(db, binding, device, bindingIdentity, now);
        return {
          binding,
          mode: profileMatch.status === "active" ? "identity_rebound" : "identity_reactivated",
          releasedSessions
        };
      }

      const activeCount = one(
        db,
        `
          SELECT COUNT(*) AS count
          FROM device_bindings
          WHERE entitlement_id = ? AND status = 'active'
        `,
        entitlement.id
      );

      const maxDevices = Number(entitlement.max_devices ?? entitlement.maxDevices ?? 0);
      if (activeCount.count >= maxDevices) {
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
      run(
        db,
        `
          INSERT INTO device_bindings (id, entitlement_id, device_id, status, first_bound_at, last_bound_at)
          VALUES (?, ?, ?, 'active', ?, ?)
        `,
        bindingId,
        entitlement.id,
        device.id,
        now,
        now
      );
      const binding = getBindingRowById(db, bindingId);
      upsertBindingProfile(db, binding, device, bindingIdentity, now);
      return {
        binding,
        mode: "new_binding",
        releasedSessions: 0
      };
    }
  };
}
