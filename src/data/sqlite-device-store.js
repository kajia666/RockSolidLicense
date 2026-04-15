import { AppError } from "../http.js";
import {
  appendSqliteInCondition,
  formatBindingQueryRow,
  formatBindingRow,
  formatDeviceBlockQueryRow,
  likeFilter,
  normalizeDeviceBindingFilters,
  normalizeDeviceBlockFilters
} from "./device-repository.js";
import { addDays, generateId, nowIso } from "../security.js";

function one(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

function many(db, sql, ...params) {
  return db.prepare(sql).all(...params);
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

function getDeviceRecordByFingerprintRow(db, productId, fingerprint) {
  return one(
    db,
    "SELECT * FROM devices WHERE product_id = ? AND fingerprint = ?",
    productId,
    fingerprint
  );
}

function getDeviceBlockRowById(db, blockId) {
  return one(db, "SELECT * FROM device_blocks WHERE id = ?", blockId);
}

function getDeviceBlockByProductFingerprint(db, productId, fingerprint) {
  return one(
    db,
    "SELECT * FROM device_blocks WHERE product_id = ? AND fingerprint = ?",
    productId,
    fingerprint
  );
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
    getActiveDeviceBlock(_db, productId, fingerprint) {
      return one(
        db,
        `
          SELECT *
          FROM device_blocks
          WHERE product_id = ? AND fingerprint = ? AND status = 'active'
        `,
        productId,
        fingerprint
      );
    },

    getDeviceRecordByFingerprint(_db, productId, fingerprint) {
      return getDeviceRecordByFingerprintRow(db, productId, fingerprint);
    },

    getDeviceBlockManageRowById(_db, blockId) {
      return one(
        db,
        `
          SELECT b.*, pr.code AS product_code, pr.owner_developer_id,
                 d.id AS device_id, d.device_name, d.last_seen_at, d.last_seen_ip
          FROM device_blocks b
          JOIN products pr ON pr.id = b.product_id
          LEFT JOIN devices d ON d.product_id = b.product_id AND d.fingerprint = b.fingerprint
          WHERE b.id = ?
        `,
        blockId
      );
    },

    activateDeviceBlock(productId, fingerprint, reason, notes, timestamp = nowIso()) {
      const existing = getDeviceBlockByProductFingerprint(db, productId, fingerprint);
      let blockId = existing?.id ?? generateId("dblock");
      let changed = false;

      if (!existing) {
        run(
          db,
          `
            INSERT INTO device_blocks
            (id, product_id, fingerprint, status, reason, notes, created_at, updated_at, released_at)
            VALUES (?, ?, ?, 'active', ?, ?, ?, ?, NULL)
          `,
          blockId,
          productId,
          fingerprint,
          reason,
          notes,
          timestamp,
          timestamp
        );
        changed = true;
      } else if (existing.status !== "active" || existing.reason !== reason || String(existing.notes ?? "") !== notes) {
        run(
          db,
          `
            UPDATE device_blocks
            SET status = 'active', reason = ?, notes = ?, updated_at = ?, released_at = NULL
            WHERE id = ?
          `,
          reason,
          notes,
          timestamp,
          existing.id
        );
        blockId = existing.id;
        changed = true;
      }

      return {
        ...getDeviceBlockRowById(db, blockId),
        changed
      };
    },

    upsertDevice(productId, fingerprint, deviceName, meta = {}, deviceProfile = {}, timestamp = nowIso()) {
      const existing = getDeviceRecordByFingerprintRow(db, productId, fingerprint);

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

    revokeActiveBindingsByDevice(deviceId, timestamp = nowIso()) {
      const result = run(
        db,
        `
          UPDATE device_bindings
          SET status = 'revoked', revoked_at = ?, last_bound_at = ?
          WHERE device_id = ? AND status = 'active'
        `,
        timestamp,
        timestamp,
        deviceId
      );
      return Number(result.changes ?? 0);
    },

    queryBindingsForEntitlement(_db, entitlementId) {
      return many(
        db,
        `
          SELECT b.id, b.entitlement_id, b.device_id, b.status, b.first_bound_at, b.last_bound_at, b.revoked_at,
                 d.fingerprint, d.device_name, d.last_seen_at, d.last_seen_ip,
                 bp.match_fields_json, bp.identity_json, bp.request_ip,
                 COALESCE(sess.active_session_count, 0) AS active_session_count
          FROM device_bindings b
          JOIN devices d ON d.id = b.device_id
          LEFT JOIN device_binding_profiles bp ON bp.binding_id = b.id
          LEFT JOIN (
            SELECT entitlement_id, device_id, COUNT(*) AS active_session_count
            FROM sessions
            WHERE status = 'active'
            GROUP BY entitlement_id, device_id
          ) sess ON sess.entitlement_id = b.entitlement_id AND sess.device_id = b.device_id
          WHERE b.entitlement_id = ?
          ORDER BY CASE WHEN b.status = 'active' THEN 0 ELSE 1 END, b.last_bound_at DESC
        `,
        entitlementId
      ).map((row) => formatBindingRow(row));
    },

    getBindingManageRowById(_db, bindingId) {
      return one(
        db,
        `
          SELECT b.id, b.entitlement_id, b.device_id, b.status,
                 pr.id AS product_id, pr.code AS product_code, pr.owner_developer_id,
                 a.id AS account_id, a.username,
                 d.fingerprint, d.device_name
          FROM device_bindings b
          JOIN entitlements e ON e.id = b.entitlement_id
          JOIN customer_accounts a ON a.id = e.account_id
          JOIN products pr ON pr.id = e.product_id
          JOIN devices d ON d.id = b.device_id
          WHERE b.id = ?
        `,
        bindingId
      );
    },

    queryDeviceBindingRows(_db, filters = {}) {
      const conditions = [];
      const params = [];
      const normalizedFilters = normalizeDeviceBindingFilters(filters);

      if (normalizedFilters.productCode) {
        conditions.push("pr.code = ?");
        params.push(normalizedFilters.productCode);
      }

      appendSqliteInCondition("pr.id", filters.productIds, conditions, params);

      if (normalizedFilters.username) {
        conditions.push("a.username = ?");
        params.push(normalizedFilters.username);
      }

      if (normalizedFilters.status) {
        conditions.push("b.status = ?");
        params.push(normalizedFilters.status);
      }

      if (normalizedFilters.search) {
        const pattern = likeFilter(normalizedFilters.search);
        conditions.push(
          "(d.fingerprint LIKE ? ESCAPE '\\' OR d.device_name LIKE ? ESCAPE '\\' OR a.username LIKE ? ESCAPE '\\')"
        );
        params.push(pattern, pattern, pattern);
      }

      const items = many(
        db,
        `
          SELECT b.id, b.entitlement_id, b.device_id, b.status, b.first_bound_at, b.last_bound_at, b.revoked_at,
                 pr.id AS product_id, pr.code AS product_code, pr.name AS product_name,
                 a.id AS account_id, a.username,
                 pol.name AS policy_name,
                 e.ends_at AS entitlement_ends_at,
                 d.fingerprint, d.device_name, d.last_seen_at, d.last_seen_ip,
                 bp.identity_hash, bp.match_fields_json, bp.identity_json, bp.request_ip AS bind_request_ip,
                 COALESCE(sess.active_session_count, 0) AS active_session_count
          FROM device_bindings b
          JOIN entitlements e ON e.id = b.entitlement_id
          JOIN customer_accounts a ON a.id = e.account_id
          JOIN products pr ON pr.id = e.product_id
          JOIN policies pol ON pol.id = e.policy_id
          JOIN devices d ON d.id = b.device_id
          LEFT JOIN device_binding_profiles bp ON bp.binding_id = b.id
          LEFT JOIN (
            SELECT entitlement_id, device_id, COUNT(*) AS active_session_count
            FROM sessions
            WHERE status = 'active'
            GROUP BY entitlement_id, device_id
          ) sess ON sess.entitlement_id = b.entitlement_id AND sess.device_id = b.device_id
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY b.last_bound_at DESC
          LIMIT 100
        `,
        ...params
      );

      return {
        items: items.map((row) => formatBindingQueryRow(row)),
        total: items.length,
        filters: normalizedFilters
      };
    },

    queryDeviceBlockRows(_db, filters = {}) {
      const conditions = [];
      const params = [];
      const normalizedFilters = normalizeDeviceBlockFilters(filters);

      if (normalizedFilters.productCode) {
        conditions.push("pr.code = ?");
        params.push(normalizedFilters.productCode);
      }

      appendSqliteInCondition("pr.id", filters.productIds, conditions, params);

      if (normalizedFilters.status) {
        conditions.push("b.status = ?");
        params.push(normalizedFilters.status);
      }

      if (normalizedFilters.search) {
        const pattern = likeFilter(normalizedFilters.search);
        conditions.push(
          "(b.fingerprint LIKE ? ESCAPE '\\' OR b.reason LIKE ? ESCAPE '\\' OR COALESCE(b.notes, '') LIKE ? ESCAPE '\\')"
        );
        params.push(pattern, pattern, pattern);
      }

      const items = many(
        db,
        `
          SELECT b.id, b.product_id, b.fingerprint, b.status, b.reason, b.notes, b.created_at, b.updated_at, b.released_at,
                 pr.code AS product_code, pr.name AS product_name,
                 d.id AS device_id, d.device_name, d.last_seen_at, d.last_seen_ip,
                 COALESCE(sess.active_session_count, 0) AS active_session_count
          FROM device_blocks b
          JOIN products pr ON pr.id = b.product_id
          LEFT JOIN devices d ON d.product_id = b.product_id AND d.fingerprint = b.fingerprint
          LEFT JOIN (
            SELECT device_id, COUNT(*) AS active_session_count
            FROM sessions
            WHERE status = 'active'
            GROUP BY device_id
          ) sess ON sess.device_id = d.id
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY CASE WHEN b.status = 'active' THEN 0 ELSE 1 END, b.updated_at DESC
          LIMIT 100
        `,
        ...params
      );

      return {
        items: items.map((row) => formatDeviceBlockQueryRow(row)),
        total: items.length,
        filters: normalizedFilters
      };
    },

    countActiveBindingsByProductIds(_db, productIds = null) {
      const conditions = ["b.status = 'active'"];
      const params = [];

      appendSqliteInCondition("e.product_id", productIds, conditions, params);

      return many(
        db,
        `
          SELECT e.product_id, COUNT(*) AS count
          FROM device_bindings b
          JOIN entitlements e ON e.id = b.entitlement_id
          WHERE ${conditions.join(" AND ")}
          GROUP BY e.product_id
        `,
        ...params
      ).map((row) => ({
        ...row,
        count: Number(row.count ?? 0)
      }));
    },

    countActiveBlocksByProductIds(_db, productIds = null) {
      const conditions = ["status = 'active'"];
      const params = [];

      appendSqliteInCondition("product_id", productIds, conditions, params);

      return many(
        db,
        `
          SELECT product_id, COUNT(*) AS count
          FROM device_blocks
          WHERE ${conditions.join(" AND ")}
          GROUP BY product_id
        `,
        ...params
      ).map((row) => ({
        ...row,
        count: Number(row.count ?? 0)
      }));
    },

    releaseDeviceBlock(blockId, timestamp = nowIso()) {
      run(
        db,
        `
          UPDATE device_blocks
          SET status = 'released', updated_at = ?, released_at = ?
          WHERE id = ?
        `,
        timestamp,
        timestamp,
        blockId
      );
      return getDeviceBlockRowById(db, blockId);
    },

    releaseBinding(bindingId, timestamp = nowIso()) {
      run(
        db,
        `
          UPDATE device_bindings
          SET status = 'revoked', revoked_at = ?, last_bound_at = ?
          WHERE id = ?
        `,
        timestamp,
        timestamp,
        bindingId
      );
      return getBindingRowById(db, bindingId);
    },

    countRecentClientUnbinds(_db, entitlementId, windowDays, referenceTime = nowIso()) {
      const since = addDays(referenceTime, -Math.max(1, Number(windowDays ?? 1)));
      const row = one(
        db,
        `
          SELECT COUNT(*) AS count
          FROM entitlement_unbind_logs
          WHERE entitlement_id = ?
            AND actor_type = 'client'
            AND created_at >= ?
        `,
        entitlementId,
        since
      );
      return Number(row?.count ?? 0);
    },

    recordEntitlementUnbind(entitlementId, bindingId, actorType, actorId, reason, deductedDays, timestamp = nowIso()) {
      const logId = generateId("unbind");
      run(
        db,
        `
          INSERT INTO entitlement_unbind_logs
          (id, entitlement_id, binding_id, actor_type, actor_id, reason, deducted_days, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        logId,
        entitlementId,
        bindingId,
        actorType,
        actorId,
        reason,
        deductedDays,
        timestamp
      );
      return one(db, "SELECT * FROM entitlement_unbind_logs WHERE id = ?", logId);
    },

    async bindDeviceToEntitlement(entitlement, device, bindingIdentity, options = {}) {
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
          releasedSessions = Number(await Promise.resolve(releaseSessions({
            entitlementId: entitlement.id,
            deviceId: profileMatch.device_id,
            reason: "binding_rebound"
          })) ?? 0);
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
