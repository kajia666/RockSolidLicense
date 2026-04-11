import { AppError } from "./http.js";
import { rotateLicenseKeyStore } from "./license-keys.js";
import {
  addDays,
  addSeconds,
  generateId,
  hashPassword,
  issueLicenseToken,
  nowIso,
  randomAppId,
  randomCardKey,
  randomToken,
  signClientRequest,
  verifyPassword
} from "./security.js";

function one(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

function many(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

function run(db, sql, ...params) {
  return db.prepare(sql).run(...params);
}

function withTransaction(db, action) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function audit(db, actorType, actorId, eventType, entityType, entityId, metadata = {}) {
  run(
    db,
    `
      INSERT INTO audit_logs (id, actor_type, actor_id, event_type, entity_type, entity_id, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    generateId("audit"),
    actorType,
    actorId,
    eventType,
    entityType,
    entityId,
    JSON.stringify(metadata),
    nowIso()
  );
}

function issueLicenseKeys(db, { productId, policyId, prefix, count, batchCode, notes, issuedAt }) {
  const created = [];
  for (let index = 0; index < count; index += 1) {
    const licenseKeyId = generateId("card");
    const cardKey = randomCardKey(prefix);
    run(
      db,
      `
        INSERT INTO license_keys
        (id, product_id, policy_id, card_key, batch_code, status, notes, issued_at)
        VALUES (?, ?, ?, ?, ?, 'fresh', ?, ?)
      `,
      licenseKeyId,
      productId,
      policyId,
      cardKey,
      batchCode,
      notes,
      issuedAt
    );
    created.push({
      licenseKeyId,
      cardKey
    });
  }
  return created;
}

function requireField(body, field, message) {
  if (!body[field]) {
    throw new AppError(400, "VALIDATION_ERROR", message ?? `${field} is required.`);
  }
}

function requireAdminSession(db, token) {
  if (!token) {
    throw new AppError(401, "ADMIN_AUTH_REQUIRED", "Missing admin bearer token.");
  }

  const session = one(
    db,
    `
      SELECT s.*, a.username
      FROM admin_sessions s
      JOIN admins a ON a.id = s.admin_id
      WHERE s.token = ? AND s.expires_at > ?
    `,
    token,
    nowIso()
  );

  if (!session) {
    throw new AppError(401, "ADMIN_AUTH_INVALID", "Admin session is invalid or expired.");
  }

  run(db, "UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?", nowIso(), session.id);
  return session;
}

function requireProductByCode(db, code) {
  const product = one(db, "SELECT * FROM products WHERE code = ? AND status = 'active'", code);
  if (!product) {
    throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist or is inactive.");
  }
  return product;
}

function getActiveEntitlement(db, accountId, productId, now) {
  return one(
    db,
    `
      SELECT e.*, p.name AS policy_name, p.max_devices, p.allow_concurrent_sessions,
             p.heartbeat_interval_seconds, p.heartbeat_timeout_seconds, p.token_ttl_seconds
      FROM entitlements e
      JOIN policies p ON p.id = e.policy_id
      WHERE e.account_id = ?
        AND e.product_id = ?
        AND e.status = 'active'
        AND e.starts_at <= ?
        AND e.ends_at > ?
      ORDER BY e.ends_at DESC
      LIMIT 1
    `,
    accountId,
    productId,
    now,
    now
  );
}

function upsertDevice(db, productId, fingerprint, deviceName, meta) {
  const existing = one(
    db,
    "SELECT * FROM devices WHERE product_id = ? AND fingerprint = ?",
    productId,
    fingerprint
  );

  const timestamp = nowIso();
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
      meta.ip,
      JSON.stringify({ userAgent: meta.userAgent }),
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
    meta.ip,
    JSON.stringify({ userAgent: meta.userAgent })
  );
  return one(db, "SELECT * FROM devices WHERE id = ?", deviceId);
}

function bindDeviceToEntitlement(db, entitlement, device) {
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
    run(db, "UPDATE device_bindings SET last_bound_at = ? WHERE id = ?", nowIso(), existing.id);
    return existing;
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

  if (activeCount.count >= entitlement.max_devices) {
    throw new AppError(
      409,
      "DEVICE_LIMIT_REACHED",
      `This license plan allows at most ${entitlement.max_devices} bound device(s).`
    );
  }

  if (existing) {
    const timestamp = nowIso();
    run(
      db,
      `
        UPDATE device_bindings
        SET status = 'active', revoked_at = NULL, last_bound_at = ?
        WHERE id = ?
      `,
      timestamp,
      existing.id
    );
    return one(db, "SELECT * FROM device_bindings WHERE id = ?", existing.id);
  }

  const timestamp = nowIso();
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
    timestamp,
    timestamp
  );
  return one(db, "SELECT * FROM device_bindings WHERE id = ?", bindingId);
}

function expireStaleSessions(db) {
  const rows = many(
    db,
    `
      SELECT s.id, s.expires_at, s.last_heartbeat_at, p.heartbeat_timeout_seconds
      FROM sessions s
      JOIN entitlements e ON e.id = s.entitlement_id
      JOIN policies p ON p.id = e.policy_id
      WHERE s.status = 'active'
    `
  );

  const now = Date.now();
  for (const row of rows) {
    const expiresAt = new Date(row.expires_at).getTime();
    const lastHeartbeat = new Date(row.last_heartbeat_at).getTime();
    const heartbeatDeadline = lastHeartbeat + row.heartbeat_timeout_seconds * 1000;

    if (expiresAt <= now || heartbeatDeadline <= now) {
      run(
        db,
        "UPDATE sessions SET status = 'expired', revoked_reason = ? WHERE id = ?",
        expiresAt <= now ? "token_expired" : "heartbeat_timeout",
        row.id
      );
    }
  }
}

function escapeLikeText(value) {
  return String(value).replace(/[%_]/g, "\\$&");
}

function likeFilter(value) {
  return `%${escapeLikeText(value).trim()}%`;
}

function normalizeReason(value, fallback) {
  const normalized = String(value ?? fallback)
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 64);
  return normalized || fallback;
}

function normalizeResellerCode(value) {
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "");
}

function getResellerAllocationByLicenseKey(db, licenseKeyId) {
  return one(
    db,
    `
      SELECT ri.id, ri.allocation_batch_code, ri.allocated_at,
             r.id AS reseller_id, r.code AS reseller_code, r.name AS reseller_name
      FROM reseller_inventory ri
      JOIN resellers r ON r.id = ri.reseller_id
      WHERE ri.license_key_id = ? AND ri.status = 'active'
    `,
    licenseKeyId
  );
}

function normalizeResellerInventoryFilters(filters = {}) {
  return {
    resellerId: filters.resellerId ? String(filters.resellerId).trim() : null,
    productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
    cardStatus: filters.cardStatus ? String(filters.cardStatus).trim().toLowerCase() : null,
    search: filters.search ? String(filters.search).trim() : null
  };
}

function queryResellerInventoryRows(db, filters = {}, options = {}) {
  const normalizedFilters = normalizeResellerInventoryFilters(filters);
  const conditions = ["ri.status = 'active'"];
  const params = [];

  if (normalizedFilters.resellerId) {
    conditions.push("r.id = ?");
    params.push(normalizedFilters.resellerId);
  }

  if (normalizedFilters.productCode) {
    conditions.push("pr.code = ?");
    params.push(normalizedFilters.productCode);
  }

  if (normalizedFilters.cardStatus) {
    if (!["fresh", "redeemed"].includes(normalizedFilters.cardStatus)) {
      throw new AppError(400, "INVALID_CARD_STATUS", "Card status must be fresh or redeemed.");
    }
    conditions.push("lk.status = ?");
    params.push(normalizedFilters.cardStatus);
  }

  if (normalizedFilters.search) {
    const pattern = likeFilter(normalizedFilters.search);
    conditions.push(
      "(r.code LIKE ? ESCAPE '\\' OR lk.card_key LIKE ? ESCAPE '\\' OR COALESCE(a.username, '') LIKE ? ESCAPE '\\')"
    );
    params.push(pattern, pattern, pattern);
  }

  const limit = options.limit === undefined || options.limit === null
    ? ""
    : `LIMIT ${Math.max(1, Number(options.limit))}`;

  const items = many(
    db,
    `
      SELECT ri.id, ri.allocation_batch_code, ri.allocated_at, ri.notes, ri.status,
             r.id AS reseller_id, r.code AS reseller_code, r.name AS reseller_name, r.status AS reseller_status,
             pr.code AS product_code, pr.name AS product_name, pol.id AS policy_id, pol.name AS policy_name,
             lk.card_key, lk.status AS card_status, lk.issued_at, lk.redeemed_at,
             a.username AS redeemed_username
      FROM reseller_inventory ri
      JOIN resellers r ON r.id = ri.reseller_id
      JOIN products pr ON pr.id = ri.product_id
      JOIN policies pol ON pol.id = ri.policy_id
      JOIN license_keys lk ON lk.id = ri.license_key_id
      LEFT JOIN customer_accounts a ON a.id = lk.redeemed_by_account_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY ri.allocated_at DESC, lk.issued_at DESC
      ${limit}
    `,
    ...params
  ).map((row) => ({
    id: row.id,
    allocationBatchCode: row.allocation_batch_code,
    allocatedAt: row.allocated_at,
    notes: row.notes ?? null,
    status: row.status,
    resellerId: row.reseller_id,
    resellerCode: row.reseller_code,
    resellerName: row.reseller_name,
    resellerStatus: row.reseller_status,
    productCode: row.product_code,
    productName: row.product_name,
    policyId: row.policy_id,
    policyName: row.policy_name,
    cardKey: row.card_key,
    cardStatus: row.card_status,
    issuedAt: row.issued_at,
    redeemedAt: row.redeemed_at,
    redeemedUsername: row.redeemed_username ?? null
  }));

  return {
    items,
    filters: normalizedFilters
  };
}

function summarizeResellerInventory(items) {
  return items.reduce(
    (accumulator, item) => {
      accumulator.total += 1;
      if (item.cardStatus === "fresh") {
        accumulator.fresh += 1;
      }
      if (item.cardStatus === "redeemed") {
        accumulator.redeemed += 1;
      }
      return accumulator;
    },
    { total: 0, fresh: 0, redeemed: 0 }
  );
}

function toCsvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function activeDeviceBlock(db, productId, fingerprint) {
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
}

function requireDeviceNotBlocked(db, productId, fingerprint) {
  const block = activeDeviceBlock(db, productId, fingerprint);
  if (!block) {
    return;
  }

  throw new AppError(403, "DEVICE_BLOCKED", "This device fingerprint has been blocked by the operator.", {
    reason: block.reason,
    blockedAt: block.created_at
  });
}

function normalizeChannel(value, fallback = "stable") {
  return String(value ?? fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "") || fallback;
}

function normalizeOptionalChannel(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  return normalizeChannel(value);
}

function normalizeNoticeChannel(value, fallback = "all") {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  return normalizeChannel(value, fallback);
}

function parseVersionParts(version) {
  return String(version)
    .trim()
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()));
}

function compareVersions(left, right) {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];

    if (leftPart === undefined && rightPart === undefined) {
      return 0;
    }

    if (leftPart === undefined) {
      return typeof rightPart === "number" ? (rightPart === 0 ? 0 : -1) : -1;
    }

    if (rightPart === undefined) {
      return typeof leftPart === "number" ? (leftPart === 0 ? 0 : 1) : 1;
    }

    if (typeof leftPart === "number" && typeof rightPart === "number") {
      if (leftPart !== rightPart) {
        return leftPart < rightPart ? -1 : 1;
      }
      continue;
    }

    const compared = String(leftPart).localeCompare(String(rightPart));
    if (compared !== 0) {
      return compared < 0 ? -1 : 1;
    }
  }

  return 0;
}

function selectHighestVersion(rows) {
  if (!rows.length) {
    return null;
  }

  return rows.reduce((best, row) =>
    !best || compareVersions(best.version, row.version) < 0 ? row : best
  , null);
}

function listProductVersions(db, productId, channel) {
  return many(
    db,
    `
      SELECT *
      FROM client_versions
      WHERE product_id = ? AND channel = ?
      ORDER BY released_at DESC, created_at DESC
    `,
    productId,
    channel
  );
}

function buildVersionManifest(db, product, clientVersion, channel = "stable") {
  const normalizedChannel = normalizeChannel(channel);
  const rows = listProductVersions(db, product.id, normalizedChannel);
  const activeRows = rows.filter((row) => row.status === "active");
  const latestVersion = selectHighestVersion(activeRows);
  const minimumAllowedVersion = selectHighestVersion(activeRows.filter((row) => row.force_update));
  const disabledExact = clientVersion
    ? rows.find((row) => row.status === "disabled" && row.version === clientVersion)
    : null;
  const latestNotice = activeRows
    .filter((row) => row.notice_title || row.notice_body || row.release_notes)
    .sort((left, right) => compareVersions(right.version, left.version))[0] ?? null;

  let allowed = true;
  let status = "allowed";
  let message = "Client version is allowed.";

  if (clientVersion && disabledExact) {
    allowed = false;
    status = "disabled_version";
    message = "This client version has been disabled by the operator.";
  } else if (
    clientVersion &&
    minimumAllowedVersion &&
    compareVersions(clientVersion, minimumAllowedVersion.version) < 0
  ) {
    allowed = false;
    status = "force_update_required";
    message = `Client must upgrade to ${minimumAllowedVersion.version} or later.`;
  } else if (
    clientVersion &&
    latestVersion &&
    compareVersions(clientVersion, latestVersion.version) < 0
  ) {
    status = "upgrade_recommended";
    message = `A newer client version ${latestVersion.version} is available.`;
  } else if (clientVersion && !rows.length) {
    status = "no_version_rules";
    message = "No version rules are configured for this product channel.";
  }

  return {
    productCode: product.code,
    channel: normalizedChannel,
    clientVersion: clientVersion ?? null,
    allowed,
    status,
    message,
    latestVersion: latestVersion?.version ?? null,
    minimumAllowedVersion: minimumAllowedVersion?.version ?? null,
    latestDownloadUrl: latestVersion?.download_url ?? null,
    notice: latestNotice
      ? {
          version: latestNotice.version,
          title: latestNotice.notice_title || null,
          body: latestNotice.notice_body || null,
          releaseNotes: latestNotice.release_notes || null
        }
      : null,
    versions: rows
      .slice()
      .sort((left, right) => compareVersions(right.version, left.version))
      .slice(0, 10)
      .map((row) => ({
        id: row.id,
        version: row.version,
        channel: row.channel,
        status: row.status,
        forceUpdate: Boolean(row.force_update),
        downloadUrl: row.download_url,
        releasedAt: row.released_at,
        noticeTitle: row.notice_title || null
      }))
  };
}

function requireClientVersionAllowed(db, product, clientVersion, channel = "stable") {
  if (!clientVersion) {
    return null;
  }

  const manifest = buildVersionManifest(db, product, clientVersion, channel);
  if (!manifest.allowed) {
    throw new AppError(426, "CLIENT_VERSION_REJECTED", manifest.message, {
      status: manifest.status,
      latestVersion: manifest.latestVersion,
      minimumAllowedVersion: manifest.minimumAllowedVersion,
      latestDownloadUrl: manifest.latestDownloadUrl,
      notice: manifest.notice
    });
  }

  return manifest;
}

function activeNoticesForProduct(db, productId, channel = "all") {
  const now = nowIso();
  const normalizedChannel = normalizeNoticeChannel(channel, "stable");
  return many(
    db,
    `
      SELECT n.*, pr.code AS product_code, pr.name AS product_name
      FROM notices n
      LEFT JOIN products pr ON pr.id = n.product_id
      WHERE n.status = 'active'
        AND n.starts_at <= ?
        AND (n.ends_at IS NULL OR n.ends_at > ?)
        AND (n.product_id IS NULL OR n.product_id = ?)
        AND (n.channel = 'all' OR n.channel = ?)
      ORDER BY n.block_login DESC, n.starts_at DESC, n.created_at DESC
    `,
    now,
    now,
    productId,
    normalizedChannel
  );
}

function formatNotice(row) {
  return {
    id: row.id,
    productCode: row.product_code ?? null,
    productName: row.product_name ?? null,
    channel: row.channel,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    body: row.body,
    actionUrl: row.action_url,
    status: row.status,
    blockLogin: Boolean(row.block_login),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function requireNoBlockingNotices(db, product, channel = "all") {
  const blocking = activeNoticesForProduct(db, product.id, channel).filter((row) => row.block_login);
  if (!blocking.length) {
    return [];
  }

  throw new AppError(503, "LOGIN_BLOCKED_BY_NOTICE", blocking[0].title, {
    notices: blocking.map(formatNotice)
  });
}

function normalizeIpAddress(value) {
  const raw = String(value ?? "")
    .trim()
    .replace(/^\[|\]$/g, "");
  if (!raw) {
    return "";
  }
  if (raw.startsWith("::ffff:")) {
    return raw.slice("::ffff:".length);
  }
  return raw;
}

function ipv4ToInt(value) {
  const parts = normalizeIpAddress(value).split(".");
  if (parts.length !== 4) {
    return null;
  }

  let result = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet < 0 || octet > 255) {
      return null;
    }
    result = (result << 8) + octet;
  }

  return result >>> 0;
}

function ipv4CidrMatch(ip, cidr) {
  const [network, prefixText] = String(cidr).split("/");
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }

  const ipValue = ipv4ToInt(ip);
  const networkValue = ipv4ToInt(network);
  if (ipValue === null || networkValue === null) {
    return false;
  }

  if (prefix === 0) {
    return true;
  }

  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ipValue & mask) === (networkValue & mask);
}

function networkRuleMatchesIp(rule, ip) {
  const normalizedIp = normalizeIpAddress(ip);
  if (!normalizedIp) {
    return false;
  }

  if (rule.target_type === "cidr") {
    return ipv4CidrMatch(normalizedIp, rule.pattern);
  }

  return normalizeIpAddress(rule.pattern) === normalizedIp;
}

function enforceNetworkRules(db, product, ip, actionScope) {
  const normalizedIp = normalizeIpAddress(ip);
  if (!normalizedIp) {
    return;
  }

  const rules = many(
    db,
    `
      SELECT nr.*, pr.code AS product_code
      FROM network_rules nr
      LEFT JOIN products pr ON pr.id = nr.product_id
      WHERE nr.status = 'active'
        AND nr.decision = 'block'
        AND (nr.product_id IS NULL OR nr.product_id = ?)
        AND (nr.action_scope = 'all' OR nr.action_scope = ?)
      ORDER BY CASE WHEN nr.product_id IS NULL THEN 1 ELSE 0 END, nr.created_at DESC
    `,
    product.id,
    actionScope
  );

  const matched = rules.find((rule) => networkRuleMatchesIp(rule, normalizedIp));
  if (!matched) {
    return;
  }

  throw new AppError(403, "NETWORK_RULE_BLOCKED", "Request was blocked by a network access rule.", {
    ruleId: matched.id,
    actionScope,
    targetType: matched.target_type,
    pattern: matched.pattern,
    ip: normalizedIp,
    productCode: matched.product_code ?? null
  });
}

function requireSignedProduct(db, config, reqLike, rawBody) {
  const appId = reqLike.headers["x-rs-app-id"];
  const timestamp = reqLike.headers["x-rs-timestamp"];
  const nonce = reqLike.headers["x-rs-nonce"];
  const signature = reqLike.headers["x-rs-signature"];

  if (!appId || !timestamp || !nonce || !signature) {
    throw new AppError(401, "SDK_SIGNATURE_REQUIRED", "Missing signed SDK headers.");
  }

  const product = one(
    db,
    "SELECT * FROM products WHERE sdk_app_id = ? AND status = 'active'",
    appId
  );
  if (!product) {
    throw new AppError(401, "SDK_APP_INVALID", "Unknown SDK app id.");
  }

  const requestTime = Date.parse(timestamp);
  if (Number.isNaN(requestTime)) {
    throw new AppError(400, "INVALID_TIMESTAMP", "Timestamp must be an ISO-8601 string.");
  }

  const skew = Math.abs(Date.now() - requestTime);
  if (skew > config.requestSkewSeconds * 1000) {
    throw new AppError(401, "SDK_SIGNATURE_EXPIRED", "Request timestamp is outside the allowed window.");
  }

  run(db, "DELETE FROM request_nonces WHERE expires_at <= ?", nowIso());

  const expected = signClientRequest(product.sdk_app_secret, {
    method: reqLike.method,
    path: reqLike.path,
    timestamp,
    nonce,
    body: rawBody
  });

  if (expected !== signature) {
    throw new AppError(401, "SDK_SIGNATURE_INVALID", "Request signature does not match.");
  }

  try {
    run(
      db,
      `
        INSERT INTO request_nonces (app_id, nonce, expires_at)
        VALUES (?, ?, ?)
      `,
      appId,
      nonce,
      addSeconds(nowIso(), config.requestSkewSeconds)
    );
  } catch {
    throw new AppError(409, "SDK_NONCE_REPLAY", "Nonce has already been used.");
  }

  return product;
}

export function createServices(db, config) {
  return {
    health() {
      expireStaleSessions(db);
      return {
        status: "ok",
        time: nowIso(),
        env: config.env
      };
    },

    tokenKey() {
      return {
        algorithm: config.licenseKeys.algorithm,
        keyId: config.licenseKeys.keyId,
        issuer: config.tokenIssuer,
        publicKeyFingerprint: config.licenseKeys.publicKeyFingerprint,
        publicKeyPem: config.licenseKeys.publicKeyPem
      };
    },

    tokenKeys() {
      return {
        algorithm: config.licenseKeys.algorithm,
        issuer: config.tokenIssuer,
        activeKeyId: config.licenseKeys.keyId,
        keys: config.licenseKeys.keyring.keys.map((entry) => ({
          keyId: entry.keyId,
          algorithm: entry.algorithm,
          status: entry.status,
          createdAt: entry.createdAt,
          publicKeyFingerprint: entry.publicKeyFingerprint,
          publicKeyPem: entry.publicKeyPem
        }))
      };
    },

    adminLogin(body) {
      requireField(body, "username");
      requireField(body, "password");

      const admin = one(db, "SELECT * FROM admins WHERE username = ?", body.username);
      if (!admin || !verifyPassword(body.password, admin.password_hash)) {
        throw new AppError(401, "ADMIN_LOGIN_FAILED", "Username or password is incorrect.");
      }

      const now = nowIso();
      const token = randomToken(32);
      const expiresAt = addSeconds(now, config.adminSessionHours * 3600);

      run(
        db,
        `
          INSERT INTO admin_sessions (id, admin_id, token, expires_at, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        generateId("adminsess"),
        admin.id,
        token,
        expiresAt,
        now,
        now
      );

      run(db, "UPDATE admins SET last_login_at = ?, updated_at = ? WHERE id = ?", now, now, admin.id);
      audit(db, "admin", admin.id, "admin.login", "admin", admin.id, { username: admin.username });

      return {
        token,
        expiresAt,
        admin: {
          id: admin.id,
          username: admin.username
        }
      };
    },

    listProducts(token) {
      requireAdminSession(db, token);
      return many(
        db,
        `
          SELECT id, code, name, description, status, sdk_app_id, sdk_app_secret, created_at, updated_at
          FROM products
          ORDER BY created_at DESC
        `
      );
    },

    createProduct(token, body) {
      const admin = requireAdminSession(db, token);
      requireField(body, "code");
      requireField(body, "name");

      const code = String(body.code).trim().toUpperCase();
      if (!/^[A-Z0-9_]{3,32}$/.test(code)) {
        throw new AppError(400, "INVALID_PRODUCT_CODE", "Product code must be 3-32 chars: A-Z, 0-9 or underscore.");
      }

      if (one(db, "SELECT id FROM products WHERE code = ?", code)) {
        throw new AppError(409, "PRODUCT_EXISTS", "Product code already exists.");
      }

      const now = nowIso();
      const product = {
        id: generateId("prod"),
        code,
        name: String(body.name).trim(),
        description: String(body.description ?? "").trim(),
        status: "active",
        sdkAppId: randomAppId(),
        sdkAppSecret: randomToken(24),
        createdAt: now,
        updatedAt: now
      };

      run(
        db,
        `
          INSERT INTO products (id, code, name, description, status, sdk_app_id, sdk_app_secret, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        product.id,
        product.code,
        product.name,
        product.description,
        product.status,
        product.sdkAppId,
        product.sdkAppSecret,
        product.createdAt,
        product.updatedAt
      );

      audit(db, "admin", admin.admin_id, "product.create", "product", product.id, {
        code: product.code,
        sdkAppId: product.sdkAppId
      });
      return product;
    },

    listPolicies(token, productCode = null) {
      requireAdminSession(db, token);
      const sql = productCode
        ? `
            SELECT p.*, pr.code AS product_code, pr.name AS product_name
            FROM policies p
            JOIN products pr ON pr.id = p.product_id
            WHERE pr.code = ?
            ORDER BY p.created_at DESC
          `
        : `
            SELECT p.*, pr.code AS product_code, pr.name AS product_name
            FROM policies p
            JOIN products pr ON pr.id = p.product_id
            ORDER BY p.created_at DESC
          `;
      return productCode ? many(db, sql, productCode) : many(db, sql);
    },

    createPolicy(token, body) {
      const admin = requireAdminSession(db, token);
      requireField(body, "productCode");
      requireField(body, "name");

      const product = requireProductByCode(db, String(body.productCode).trim().toUpperCase());
      const now = nowIso();
      const policy = {
        id: generateId("pol"),
        productId: product.id,
        name: String(body.name).trim(),
        durationDays: Number(body.durationDays ?? 30),
        maxDevices: Number(body.maxDevices ?? 1),
        allowConcurrentSessions: body.allowConcurrentSessions === false ? 0 : 1,
        heartbeatIntervalSeconds: Number(body.heartbeatIntervalSeconds ?? 60),
        heartbeatTimeoutSeconds: Number(body.heartbeatTimeoutSeconds ?? 180),
        tokenTtlSeconds: Number(body.tokenTtlSeconds ?? 300),
        bindMode: String(body.bindMode ?? "strict"),
        status: "active",
        createdAt: now,
        updatedAt: now
      };

      if (
        policy.durationDays <= 0 ||
        policy.maxDevices <= 0 ||
        policy.heartbeatIntervalSeconds <= 0 ||
        policy.heartbeatTimeoutSeconds <= 0 ||
        policy.tokenTtlSeconds <= 0
      ) {
        throw new AppError(400, "INVALID_POLICY", "Policy values must be positive numbers.");
      }

      run(
        db,
        `
          INSERT INTO policies
          (id, product_id, name, duration_days, max_devices, allow_concurrent_sessions, heartbeat_interval_seconds,
           heartbeat_timeout_seconds, token_ttl_seconds, bind_mode, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        policy.id,
        policy.productId,
        policy.name,
        policy.durationDays,
        policy.maxDevices,
        policy.allowConcurrentSessions,
        policy.heartbeatIntervalSeconds,
        policy.heartbeatTimeoutSeconds,
        policy.tokenTtlSeconds,
        policy.bindMode,
        policy.status,
        policy.createdAt,
        policy.updatedAt
      );

      audit(db, "admin", admin.admin_id, "policy.create", "policy", policy.id, {
        productCode: product.code,
        name: policy.name
      });
      return policy;
    },

    createCardBatch(token, body) {
      const admin = requireAdminSession(db, token);
      requireField(body, "productCode");
      requireField(body, "policyId");

      const product = requireProductByCode(db, String(body.productCode).trim().toUpperCase());
      const policy = one(
        db,
        `
          SELECT * FROM policies
          WHERE id = ? AND product_id = ? AND status = 'active'
        `,
        body.policyId,
        product.id
      );

      if (!policy) {
        throw new AppError(404, "POLICY_NOT_FOUND", "Policy does not exist for the product.");
      }

      const count = Number(body.count ?? 1);
      if (!Number.isInteger(count) || count < 1 || count > 5000) {
        throw new AppError(400, "INVALID_BATCH_SIZE", "Batch count must be between 1 and 5000.");
      }

      const prefix = String(body.prefix ?? product.code.slice(0, 6)).replace(/[^A-Z0-9]/gi, "").toUpperCase();
      const batchCode = `BATCH-${Date.now()}`;
      const issuedAt = nowIso();

      const keys = withTransaction(db, () => {
        return issueLicenseKeys(db, {
          productId: product.id,
          policyId: policy.id,
          prefix,
          count,
          batchCode,
          notes: String(body.notes ?? ""),
          issuedAt
        });
      });

      audit(db, "admin", admin.admin_id, "card.batch.create", "policy", policy.id, {
        productCode: product.code,
        batchCode,
        count
      });

      return {
        batchCode,
        count,
        preview: keys.slice(0, 10).map((entry) => entry.cardKey),
        keys: keys.map((entry) => entry.cardKey)
      };
    },

    listResellers(token, filters = {}) {
      requireAdminSession(db, token);

      const conditions = [];
      const params = [];
      const normalizedFilters = {
        status: filters.status ? String(filters.status).trim().toLowerCase() : null,
        search: filters.search ? String(filters.search).trim() : null
      };

      if (normalizedFilters.status) {
        if (!["active", "disabled"].includes(normalizedFilters.status)) {
          throw new AppError(400, "INVALID_RESELLER_STATUS", "Reseller status must be active or disabled.");
        }
        conditions.push("r.status = ?");
        params.push(normalizedFilters.status);
      }

      if (normalizedFilters.search) {
        const pattern = likeFilter(normalizedFilters.search);
        conditions.push(
          "(r.code LIKE ? ESCAPE '\\' OR r.name LIKE ? ESCAPE '\\' OR COALESCE(r.contact_email, '') LIKE ? ESCAPE '\\')"
        );
        params.push(pattern, pattern, pattern);
      }

      const items = many(
        db,
        `
          SELECT r.*,
                 COALESCE(inv.total_allocated, 0) AS total_allocated,
                 COALESCE(inv.fresh_keys, 0) AS fresh_keys,
                 COALESCE(inv.redeemed_keys, 0) AS redeemed_keys
          FROM resellers r
          LEFT JOIN (
            SELECT ri.reseller_id,
                   COUNT(*) AS total_allocated,
                   SUM(CASE WHEN lk.status = 'fresh' THEN 1 ELSE 0 END) AS fresh_keys,
                   SUM(CASE WHEN lk.status = 'redeemed' THEN 1 ELSE 0 END) AS redeemed_keys
            FROM reseller_inventory ri
            JOIN license_keys lk ON lk.id = ri.license_key_id
            WHERE ri.status = 'active'
            GROUP BY ri.reseller_id
          ) inv ON inv.reseller_id = r.id
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY r.created_at DESC
          LIMIT 100
        `,
        ...params
      ).map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        contactName: row.contact_name ?? null,
        contactEmail: row.contact_email ?? null,
        status: row.status,
        notes: row.notes ?? null,
        totalAllocated: Number(row.total_allocated ?? 0),
        freshKeys: Number(row.fresh_keys ?? 0),
        redeemedKeys: Number(row.redeemed_keys ?? 0),
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));

      return {
        items,
        total: items.length,
        filters: normalizedFilters
      };
    },

    createReseller(token, body) {
      const admin = requireAdminSession(db, token);
      requireField(body, "code");
      requireField(body, "name");

      const code = normalizeResellerCode(body.code);
      if (!/^[A-Z0-9_]{3,32}$/.test(code)) {
        throw new AppError(400, "INVALID_RESELLER_CODE", "Reseller code must be 3-32 chars: A-Z, 0-9 or underscore.");
      }

      if (one(db, "SELECT id FROM resellers WHERE code = ?", code)) {
        throw new AppError(409, "RESELLER_EXISTS", "Reseller code already exists.");
      }

      const now = nowIso();
      const reseller = {
        id: generateId("reseller"),
        code,
        name: String(body.name).trim(),
        contactName: String(body.contactName ?? "").trim() || null,
        contactEmail: String(body.contactEmail ?? "").trim() || null,
        status: "active",
        notes: String(body.notes ?? "").trim() || null,
        createdAt: now,
        updatedAt: now
      };

      run(
        db,
        `
          INSERT INTO resellers
          (id, code, name, contact_name, contact_email, status, notes, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        reseller.id,
        reseller.code,
        reseller.name,
        reseller.contactName,
        reseller.contactEmail,
        reseller.status,
        reseller.notes,
        reseller.createdAt,
        reseller.updatedAt
      );

      audit(db, "admin", admin.admin_id, "reseller.create", "reseller", reseller.id, {
        code: reseller.code,
        name: reseller.name
      });

      return reseller;
    },

    updateResellerStatus(token, resellerId, body = {}) {
      const admin = requireAdminSession(db, token);
      const reseller = one(db, "SELECT * FROM resellers WHERE id = ?", resellerId);
      if (!reseller) {
        throw new AppError(404, "RESELLER_NOT_FOUND", "Reseller does not exist.");
      }

      const status = String(body.status ?? "").trim().toLowerCase();
      if (!["active", "disabled"].includes(status)) {
        throw new AppError(400, "INVALID_RESELLER_STATUS", "Reseller status must be active or disabled.");
      }

      const now = nowIso();
      run(
        db,
        `
          UPDATE resellers
          SET status = ?, updated_at = ?
          WHERE id = ?
        `,
        status,
        now,
        reseller.id
      );

      audit(db, "admin", admin.admin_id, "reseller.status", "reseller", reseller.id, {
        code: reseller.code,
        status
      });

      return {
        id: reseller.id,
        code: reseller.code,
        status,
        changed: status !== reseller.status,
        updatedAt: now
      };
    },

    allocateResellerInventory(token, resellerId, body) {
      const admin = requireAdminSession(db, token);
      requireField(body, "productCode");
      requireField(body, "policyId");

      const reseller = one(db, "SELECT * FROM resellers WHERE id = ?", resellerId);
      if (!reseller) {
        throw new AppError(404, "RESELLER_NOT_FOUND", "Reseller does not exist.");
      }
      if (reseller.status !== "active") {
        throw new AppError(409, "RESELLER_DISABLED", "Reseller is disabled and cannot receive inventory.");
      }

      const product = requireProductByCode(db, String(body.productCode).trim().toUpperCase());
      const policy = one(
        db,
        `
          SELECT * FROM policies
          WHERE id = ? AND product_id = ? AND status = 'active'
        `,
        body.policyId,
        product.id
      );
      if (!policy) {
        throw new AppError(404, "POLICY_NOT_FOUND", "Policy does not exist for the product.");
      }

      const count = Number(body.count ?? 1);
      if (!Number.isInteger(count) || count < 1 || count > 5000) {
        throw new AppError(400, "INVALID_BATCH_SIZE", "Batch count must be between 1 and 5000.");
      }

      const defaultPrefix = reseller.code.slice(0, 6) || product.code.slice(0, 6);
      const prefix = String(body.prefix ?? defaultPrefix)
        .replace(/[^A-Z0-9]/gi, "")
        .toUpperCase();
      const allocationBatchCode = `ALLOC-${Date.now()}`;
      const allocatedAt = nowIso();

      const keys = withTransaction(db, () => {
        const issued = issueLicenseKeys(db, {
          productId: product.id,
          policyId: policy.id,
          prefix,
          count,
          batchCode: allocationBatchCode,
          notes: String(body.notes ?? ""),
          issuedAt: allocatedAt
        });

        for (const entry of issued) {
          run(
            db,
            `
              INSERT INTO reseller_inventory
              (id, reseller_id, product_id, policy_id, license_key_id, allocation_batch_code, notes, allocated_at, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
            `,
            generateId("rstock"),
            reseller.id,
            product.id,
            policy.id,
            entry.licenseKeyId,
            allocationBatchCode,
            String(body.notes ?? "") || null,
            allocatedAt
          );
        }

        return issued;
      });

      audit(db, "admin", admin.admin_id, "reseller.inventory.allocate", "reseller", reseller.id, {
        resellerCode: reseller.code,
        productCode: product.code,
        policyId: policy.id,
        count,
        allocationBatchCode
      });

      return {
        reseller: {
          id: reseller.id,
          code: reseller.code,
          name: reseller.name
        },
        productCode: product.code,
        policyId: policy.id,
        allocationBatchCode,
        count,
        preview: keys.slice(0, 10).map((entry) => entry.cardKey),
        keys: keys.map((entry) => entry.cardKey)
      };
    },

    listResellerInventory(token, filters = {}) {
      requireAdminSession(db, token);
      const { items, filters: normalizedFilters } = queryResellerInventoryRows(db, filters, { limit: 200 });
      const summary = summarizeResellerInventory(items);

      return {
        items,
        summary,
        filters: normalizedFilters
      };
    },

    resellerReport(token, filters = {}) {
      requireAdminSession(db, token);
      const { items, filters: normalizedFilters } = queryResellerInventoryRows(db, filters);
      const totals = summarizeResellerInventory(items);

      const resellerGroups = new Map();
      const productGroups = new Map();

      for (const item of items) {
        const resellerKey = item.resellerId;
        const resellerEntry = resellerGroups.get(resellerKey) ?? {
          resellerId: item.resellerId,
          resellerCode: item.resellerCode,
          resellerName: item.resellerName,
          resellerStatus: item.resellerStatus,
          totalAllocated: 0,
          freshKeys: 0,
          redeemedKeys: 0,
          firstAllocatedAt: item.allocatedAt,
          lastAllocatedAt: item.allocatedAt,
          lastRedeemedAt: item.redeemedAt ?? null
        };
        resellerEntry.totalAllocated += 1;
        if (item.cardStatus === "fresh") {
          resellerEntry.freshKeys += 1;
        }
        if (item.cardStatus === "redeemed") {
          resellerEntry.redeemedKeys += 1;
          if (!resellerEntry.lastRedeemedAt || item.redeemedAt > resellerEntry.lastRedeemedAt) {
            resellerEntry.lastRedeemedAt = item.redeemedAt;
          }
        }
        if (item.allocatedAt < resellerEntry.firstAllocatedAt) {
          resellerEntry.firstAllocatedAt = item.allocatedAt;
        }
        if (item.allocatedAt > resellerEntry.lastAllocatedAt) {
          resellerEntry.lastAllocatedAt = item.allocatedAt;
        }
        resellerGroups.set(resellerKey, resellerEntry);

        const productKey = item.productCode;
        const productEntry = productGroups.get(productKey) ?? {
          productCode: item.productCode,
          productName: item.productName,
          totalAllocated: 0,
          freshKeys: 0,
          redeemedKeys: 0
        };
        productEntry.totalAllocated += 1;
        if (item.cardStatus === "fresh") {
          productEntry.freshKeys += 1;
        }
        if (item.cardStatus === "redeemed") {
          productEntry.redeemedKeys += 1;
        }
        productGroups.set(productKey, productEntry);
      }

      return {
        totals: {
          ...totals,
          resellerCount: resellerGroups.size,
          productCount: productGroups.size
        },
        byReseller: Array.from(resellerGroups.values()).sort((left, right) => {
          if (right.redeemedKeys !== left.redeemedKeys) {
            return right.redeemedKeys - left.redeemedKeys;
          }
          return right.totalAllocated - left.totalAllocated;
        }),
        byProduct: Array.from(productGroups.values()).sort((left, right) => right.totalAllocated - left.totalAllocated),
        filters: normalizedFilters
      };
    },

    exportResellerInventoryCsv(token, filters = {}) {
      requireAdminSession(db, token);
      const { items } = queryResellerInventoryRows(db, filters);

      const header = [
        "resellerId",
        "resellerCode",
        "resellerName",
        "resellerStatus",
        "productCode",
        "productName",
        "policyId",
        "policyName",
        "allocationBatchCode",
        "cardKey",
        "cardStatus",
        "redeemedUsername",
        "allocatedAt",
        "issuedAt",
        "redeemedAt",
        "notes"
      ];

      const lines = [
        header.map(toCsvCell).join(","),
        ...items.map((item) => ([
          item.resellerId,
          item.resellerCode,
          item.resellerName,
          item.resellerStatus,
          item.productCode,
          item.productName,
          item.policyId,
          item.policyName,
          item.allocationBatchCode,
          item.cardKey,
          item.cardStatus,
          item.redeemedUsername ?? "",
          item.allocatedAt,
          item.issuedAt,
          item.redeemedAt ?? "",
          item.notes ?? ""
        ].map(toCsvCell).join(",")))
      ];

      return lines.join("\r\n");
    },

    dashboard(token) {
      requireAdminSession(db, token);
      expireStaleSessions(db);

      const summary = {
        products: one(db, "SELECT COUNT(*) AS count FROM products").count,
        policies: one(db, "SELECT COUNT(*) AS count FROM policies").count,
        cardsFresh: one(db, "SELECT COUNT(*) AS count FROM license_keys WHERE status = 'fresh'").count,
        cardsRedeemed: one(db, "SELECT COUNT(*) AS count FROM license_keys WHERE status = 'redeemed'").count,
        accounts: one(db, "SELECT COUNT(*) AS count FROM customer_accounts").count,
        disabledAccounts: one(
          db,
          "SELECT COUNT(*) AS count FROM customer_accounts WHERE status = 'disabled'"
        ).count,
        activeBindings: one(
          db,
          "SELECT COUNT(*) AS count FROM device_bindings WHERE status = 'active'"
        ).count,
        releasedBindings: one(
          db,
          "SELECT COUNT(*) AS count FROM device_bindings WHERE status = 'revoked'"
        ).count,
        blockedDevices: one(
          db,
          "SELECT COUNT(*) AS count FROM device_blocks WHERE status = 'active'"
        ).count,
        activeClientVersions: one(
          db,
          "SELECT COUNT(*) AS count FROM client_versions WHERE status = 'active'"
        ).count,
        forceUpdateVersions: one(
          db,
          "SELECT COUNT(*) AS count FROM client_versions WHERE status = 'active' AND force_update = 1"
        ).count,
        activeNotices: one(
          db,
          "SELECT COUNT(*) AS count FROM notices WHERE status = 'active'"
        ).count,
        blockingNotices: one(
          db,
          "SELECT COUNT(*) AS count FROM notices WHERE status = 'active' AND block_login = 1"
        ).count,
        activeNetworkRules: one(
          db,
          "SELECT COUNT(*) AS count FROM network_rules WHERE status = 'active'"
        ).count,
        resellers: one(
          db,
          "SELECT COUNT(*) AS count FROM resellers"
        ).count,
        resellerKeysAllocated: one(
          db,
          "SELECT COUNT(*) AS count FROM reseller_inventory WHERE status = 'active'"
        ).count,
        onlineSessions: one(db, "SELECT COUNT(*) AS count FROM sessions WHERE status = 'active'").count
      };

      const sessions = many(
        db,
        `
          SELECT s.id, s.status, s.issued_at, s.expires_at, s.last_heartbeat_at, s.last_seen_ip,
                 a.username, d.fingerprint, d.device_name, pr.code AS product_code, pol.name AS policy_name
          FROM sessions s
          JOIN customer_accounts a ON a.id = s.account_id
          JOIN devices d ON d.id = s.device_id
          JOIN products pr ON pr.id = s.product_id
          JOIN entitlements e ON e.id = s.entitlement_id
          JOIN policies pol ON pol.id = e.policy_id
          ORDER BY s.issued_at DESC
          LIMIT 25
        `
      );

      return { summary, sessions };
    },

    listAccounts(token, filters = {}) {
      requireAdminSession(db, token);
      expireStaleSessions(db);

      const conditions = [];
      const params = [nowIso()];
      const normalizedFilters = {
        productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
        status: filters.status ? String(filters.status).trim().toLowerCase() : null,
        search: filters.search ? String(filters.search).trim() : null
      };

      if (normalizedFilters.status && !["active", "disabled"].includes(normalizedFilters.status)) {
        throw new AppError(400, "INVALID_ACCOUNT_STATUS", "Account status must be active or disabled.");
      }

      if (normalizedFilters.productCode) {
        conditions.push("pr.code = ?");
        params.push(normalizedFilters.productCode);
      }

      if (normalizedFilters.status) {
        conditions.push("a.status = ?");
        params.push(normalizedFilters.status);
      }

      if (normalizedFilters.search) {
        const pattern = likeFilter(normalizedFilters.search);
        conditions.push("(a.username LIKE ? ESCAPE '\\' OR pr.code LIKE ? ESCAPE '\\')");
        params.push(pattern, pattern);
      }

      const items = many(
        db,
        `
          SELECT a.id, a.username, a.status, a.created_at, a.updated_at, a.last_login_at,
                 pr.code AS product_code, pr.name AS product_name,
                 COALESCE(ent.active_entitlement_count, 0) AS active_entitlement_count,
                 ent.latest_entitlement_ends_at,
                 COALESCE(sess.active_session_count, 0) AS active_session_count
          FROM customer_accounts a
          JOIN products pr ON pr.id = a.product_id
          LEFT JOIN (
            SELECT account_id,
                   COUNT(*) AS active_entitlement_count,
                   MAX(ends_at) AS latest_entitlement_ends_at
            FROM entitlements
            WHERE status = 'active' AND ends_at > ?
            GROUP BY account_id
          ) ent ON ent.account_id = a.id
          LEFT JOIN (
            SELECT account_id, COUNT(*) AS active_session_count
            FROM sessions
            WHERE status = 'active'
            GROUP BY account_id
          ) sess ON sess.account_id = a.id
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY a.created_at DESC
          LIMIT 100
        `,
        ...params
      );

      return {
        items,
        total: items.length,
        filters: normalizedFilters
      };
    },

    updateAccountStatus(token, accountId, body = {}) {
      const admin = requireAdminSession(db, token);
      const account = one(
        db,
        `
          SELECT a.id, a.username, a.status, pr.code AS product_code
          FROM customer_accounts a
          JOIN products pr ON pr.id = a.product_id
          WHERE a.id = ?
        `,
        accountId
      );

      if (!account) {
        throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account does not exist.");
      }

      const nextStatus = String(body.status ?? "")
        .trim()
        .toLowerCase();
      if (!["active", "disabled"].includes(nextStatus)) {
        throw new AppError(400, "INVALID_ACCOUNT_STATUS", "Account status must be active or disabled.");
      }

      if (account.status === nextStatus) {
        return {
          ...account,
          status: nextStatus,
          changed: false,
          revokedSessions: 0
        };
      }

      return withTransaction(db, () => {
        const timestamp = nowIso();
        run(
          db,
          `
            UPDATE customer_accounts
            SET status = ?, updated_at = ?
            WHERE id = ?
          `,
          nextStatus,
          timestamp,
          account.id
        );

        let revokedSessions = 0;
        if (nextStatus === "disabled") {
          const result = run(
            db,
            `
              UPDATE sessions
              SET status = 'expired', revoked_reason = 'account_disabled'
              WHERE account_id = ? AND status = 'active'
            `,
            account.id
          );
          revokedSessions = Number(result.changes ?? 0);
        }

        audit(
          db,
          "admin",
          admin.admin_id,
          nextStatus === "disabled" ? "account.disable" : "account.enable",
          "account",
          account.id,
          {
            username: account.username,
            productCode: account.product_code,
            revokedSessions
          }
        );

        return {
          ...account,
          status: nextStatus,
          updatedAt: timestamp,
          changed: true,
          revokedSessions
        };
      });
    },

    listDeviceBindings(token, filters = {}) {
      requireAdminSession(db, token);
      expireStaleSessions(db);

      const conditions = [];
      const params = [];
      const normalizedFilters = {
        productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
        username: filters.username ? String(filters.username).trim() : null,
        status: filters.status ? String(filters.status).trim().toLowerCase() : null,
        search: filters.search ? String(filters.search).trim() : null
      };

      if (normalizedFilters.status && !["active", "revoked"].includes(normalizedFilters.status)) {
        throw new AppError(400, "INVALID_BINDING_STATUS", "Binding status must be active or revoked.");
      }

      if (normalizedFilters.productCode) {
        conditions.push("pr.code = ?");
        params.push(normalizedFilters.productCode);
      }

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
                 pr.code AS product_code, pr.name AS product_name,
                 a.id AS account_id, a.username,
                 pol.name AS policy_name,
                 e.ends_at AS entitlement_ends_at,
                 d.fingerprint, d.device_name, d.last_seen_at, d.last_seen_ip,
                 COALESCE(sess.active_session_count, 0) AS active_session_count
          FROM device_bindings b
          JOIN entitlements e ON e.id = b.entitlement_id
          JOIN customer_accounts a ON a.id = e.account_id
          JOIN products pr ON pr.id = e.product_id
          JOIN policies pol ON pol.id = e.policy_id
          JOIN devices d ON d.id = b.device_id
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
        items,
        total: items.length,
        filters: normalizedFilters
      };
    },

    releaseDeviceBinding(token, bindingId, body = {}) {
      const admin = requireAdminSession(db, token);
      const binding = one(
        db,
        `
          SELECT b.id, b.entitlement_id, b.device_id, b.status,
                 pr.code AS product_code,
                 a.username,
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

      if (!binding) {
        throw new AppError(404, "BINDING_NOT_FOUND", "Device binding does not exist.");
      }

      if (binding.status !== "active") {
        return {
          ...binding,
          changed: false,
          releasedSessions: 0
        };
      }

      return withTransaction(db, () => {
        const timestamp = nowIso();
        const reason = normalizeReason(body.reason, "device_binding_released");
        run(
          db,
          `
            UPDATE device_bindings
            SET status = 'revoked', revoked_at = ?, last_bound_at = ?
            WHERE id = ?
          `,
          timestamp,
          timestamp,
          binding.id
        );

        const result = run(
          db,
          `
            UPDATE sessions
            SET status = 'expired', revoked_reason = ?
            WHERE entitlement_id = ? AND device_id = ? AND status = 'active'
          `,
          reason,
          binding.entitlement_id,
          binding.device_id
        );
        const releasedSessions = Number(result.changes ?? 0);

        audit(db, "admin", admin.admin_id, "device-binding.release", "device_binding", binding.id, {
          productCode: binding.product_code,
          username: binding.username,
          fingerprint: binding.fingerprint,
          reason,
          releasedSessions
        });

        return {
          ...binding,
          status: "revoked",
          revokedAt: timestamp,
          changed: true,
          reason,
          releasedSessions
        };
      });
    },

    listDeviceBlocks(token, filters = {}) {
      requireAdminSession(db, token);

      const conditions = [];
      const params = [];
      const normalizedFilters = {
        productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
        status: filters.status ? String(filters.status).trim().toLowerCase() : null,
        search: filters.search ? String(filters.search).trim() : null
      };

      if (normalizedFilters.status && !["active", "released"].includes(normalizedFilters.status)) {
        throw new AppError(400, "INVALID_DEVICE_BLOCK_STATUS", "Device block status must be active or released.");
      }

      if (normalizedFilters.productCode) {
        conditions.push("pr.code = ?");
        params.push(normalizedFilters.productCode);
      }

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
        items,
        total: items.length,
        filters: normalizedFilters
      };
    },

    blockDevice(token, body = {}) {
      const admin = requireAdminSession(db, token);
      requireField(body, "productCode");
      requireField(body, "deviceFingerprint");

      const product = requireProductByCode(db, String(body.productCode).trim().toUpperCase());
      const fingerprint = String(body.deviceFingerprint).trim();
      if (fingerprint.length < 6) {
        throw new AppError(400, "INVALID_DEVICE_FINGERPRINT", "Device fingerprint must be at least 6 characters.");
      }

      const reason = normalizeReason(body.reason, "operator_blocked");
      const notes = String(body.notes ?? "").trim();
      const existing = one(
        db,
        `
          SELECT *
          FROM device_blocks
          WHERE product_id = ? AND fingerprint = ?
        `,
        product.id,
        fingerprint
      );
      const device = one(
        db,
        `
          SELECT *
          FROM devices
          WHERE product_id = ? AND fingerprint = ?
        `,
        product.id,
        fingerprint
      );

      return withTransaction(db, () => {
        const timestamp = nowIso();
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
            product.id,
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

        let affectedSessions = 0;
        let affectedBindings = 0;
        if (device) {
          const sessionResult = run(
            db,
            `
              UPDATE sessions
              SET status = 'expired', revoked_reason = 'device_blocked'
              WHERE product_id = ? AND device_id = ? AND status = 'active'
            `,
            product.id,
            device.id
          );
          affectedSessions = Number(sessionResult.changes ?? 0);

          const bindingResult = run(
            db,
            `
              UPDATE device_bindings
              SET status = 'revoked', revoked_at = ?, last_bound_at = ?
              WHERE device_id = ? AND status = 'active'
            `,
            timestamp,
            timestamp,
            device.id
          );
          affectedBindings = Number(bindingResult.changes ?? 0);
        }

        if (changed || affectedSessions > 0 || affectedBindings > 0) {
          audit(db, "admin", admin.admin_id, "device-block.activate", "device_block", blockId, {
            productCode: product.code,
            fingerprint,
            reason,
            notes,
            affectedSessions,
            affectedBindings
          });
        }

        return {
          id: blockId,
          productCode: product.code,
          fingerprint,
          status: "active",
          reason,
          notes,
          changed,
          affectedSessions,
          affectedBindings
        };
      });
    },

    unblockDevice(token, blockId, body = {}) {
      const admin = requireAdminSession(db, token);
      const block = one(
        db,
        `
          SELECT b.*, pr.code AS product_code
          FROM device_blocks b
          JOIN products pr ON pr.id = b.product_id
          WHERE b.id = ?
        `,
        blockId
      );

      if (!block) {
        throw new AppError(404, "DEVICE_BLOCK_NOT_FOUND", "Device block does not exist.");
      }

      const releaseReason = normalizeReason(body.reason, "operator_unblocked");
      if (block.status !== "active") {
        return {
          id: block.id,
          productCode: block.product_code,
          fingerprint: block.fingerprint,
          status: block.status,
          changed: false,
          releaseReason
        };
      }

      const timestamp = nowIso();
      run(
        db,
        `
          UPDATE device_blocks
          SET status = 'released', updated_at = ?, released_at = ?
          WHERE id = ?
        `,
        timestamp,
        timestamp,
        block.id
      );

      audit(db, "admin", admin.admin_id, "device-block.release", "device_block", block.id, {
        productCode: block.product_code,
        fingerprint: block.fingerprint,
        releaseReason
      });

      return {
        id: block.id,
        productCode: block.product_code,
        fingerprint: block.fingerprint,
        status: "released",
        changed: true,
        releaseReason,
        releasedAt: timestamp
      };
    },

    listClientVersions(token, filters = {}) {
      requireAdminSession(db, token);

      const conditions = [];
      const params = [];
      const normalizedFilters = {
        productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
        channel: normalizeOptionalChannel(filters.channel),
        status: filters.status ? String(filters.status).trim().toLowerCase() : null,
        search: filters.search ? String(filters.search).trim() : null
      };

      if (normalizedFilters.productCode) {
        conditions.push("pr.code = ?");
        params.push(normalizedFilters.productCode);
      }

      if (normalizedFilters.channel) {
        conditions.push("v.channel = ?");
        params.push(normalizedFilters.channel);
      }

      if (normalizedFilters.status) {
        if (!["active", "disabled"].includes(normalizedFilters.status)) {
          throw new AppError(400, "INVALID_CLIENT_VERSION_STATUS", "Version status must be active or disabled.");
        }
        conditions.push("v.status = ?");
        params.push(normalizedFilters.status);
      }

      if (normalizedFilters.search) {
        const pattern = likeFilter(normalizedFilters.search);
        conditions.push(
          "(v.version LIKE ? ESCAPE '\\' OR COALESCE(v.notice_title, '') LIKE ? ESCAPE '\\' OR COALESCE(v.release_notes, '') LIKE ? ESCAPE '\\')"
        );
        params.push(pattern, pattern, pattern);
      }

      const items = many(
        db,
        `
          SELECT v.id, v.channel, v.version, v.status, v.force_update, v.download_url, v.release_notes,
                 v.notice_title, v.notice_body, v.released_at, v.created_at, v.updated_at,
                 pr.code AS product_code, pr.name AS product_name
          FROM client_versions v
          JOIN products pr ON pr.id = v.product_id
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY pr.code ASC, v.channel ASC, v.released_at DESC, v.created_at DESC
          LIMIT 100
        `,
        ...params
      ).map((row) => ({
        ...row,
        force_update: Boolean(row.force_update),
        forceUpdate: Boolean(row.force_update)
      }));

      return {
        items,
        total: items.length,
        filters: normalizedFilters
      };
    },

    createClientVersion(token, body = {}) {
      const admin = requireAdminSession(db, token);
      requireField(body, "productCode");
      requireField(body, "version");

      const product = requireProductByCode(db, String(body.productCode).trim().toUpperCase());
      const version = String(body.version).trim();
      const channel = normalizeChannel(body.channel);
      const status = String(body.status ?? "active").trim().toLowerCase();
      const forceUpdate = body.forceUpdate === true || body.forceUpdate === 1 || body.forceUpdate === "true" ? 1 : 0;
      const downloadUrl = String(body.downloadUrl ?? "").trim();
      const releaseNotes = String(body.releaseNotes ?? "").trim();
      const noticeTitle = String(body.noticeTitle ?? "").trim();
      const noticeBody = String(body.noticeBody ?? "").trim();
      const releasedAt = body.releasedAt ? new Date(body.releasedAt).toISOString() : nowIso();

      if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/.test(version)) {
        throw new AppError(400, "INVALID_CLIENT_VERSION", "Version must be 1-32 chars using letters, digits, dot, underscore, or hyphen.");
      }

      if (!["active", "disabled"].includes(status)) {
        throw new AppError(400, "INVALID_CLIENT_VERSION_STATUS", "Version status must be active or disabled.");
      }

      if (one(
        db,
        "SELECT id FROM client_versions WHERE product_id = ? AND channel = ? AND version = ?",
        product.id,
        channel,
        version
      )) {
        throw new AppError(409, "CLIENT_VERSION_EXISTS", "This version already exists for the product channel.");
      }

      const timestamp = nowIso();
      const id = generateId("ver");
      run(
        db,
        `
          INSERT INTO client_versions
          (id, product_id, channel, version, status, force_update, download_url, release_notes, notice_title, notice_body, released_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        id,
        product.id,
        channel,
        version,
        status,
        forceUpdate,
        downloadUrl || null,
        releaseNotes || null,
        noticeTitle || null,
        noticeBody || null,
        releasedAt,
        timestamp,
        timestamp
      );

      audit(db, "admin", admin.admin_id, "client-version.create", "client_version", id, {
        productCode: product.code,
        channel,
        version,
        status,
        forceUpdate: Boolean(forceUpdate)
      });

      return {
        id,
        productCode: product.code,
        channel,
        version,
        status,
        forceUpdate: Boolean(forceUpdate),
        downloadUrl: downloadUrl || null,
        noticeTitle: noticeTitle || null,
        noticeBody: noticeBody || null,
        releaseNotes: releaseNotes || null,
        releasedAt
      };
    },

    updateClientVersionStatus(token, versionId, body = {}) {
      const admin = requireAdminSession(db, token);
      const row = one(
        db,
        `
          SELECT v.*, pr.code AS product_code
          FROM client_versions v
          JOIN products pr ON pr.id = v.product_id
          WHERE v.id = ?
        `,
        versionId
      );

      if (!row) {
        throw new AppError(404, "CLIENT_VERSION_NOT_FOUND", "Client version does not exist.");
      }

      const nextStatus = String(body.status ?? "").trim().toLowerCase();
      if (!["active", "disabled"].includes(nextStatus)) {
        throw new AppError(400, "INVALID_CLIENT_VERSION_STATUS", "Version status must be active or disabled.");
      }

      const forceUpdate = body.forceUpdate === undefined
        ? Number(row.force_update)
        : body.forceUpdate === true || body.forceUpdate === 1 || body.forceUpdate === "true"
          ? 1
          : 0;

      const timestamp = nowIso();
      run(
        db,
        `
          UPDATE client_versions
          SET status = ?, force_update = ?, updated_at = ?
          WHERE id = ?
        `,
        nextStatus,
        forceUpdate,
        timestamp,
        row.id
      );

      audit(db, "admin", admin.admin_id, "client-version.status", "client_version", row.id, {
        productCode: row.product_code,
        version: row.version,
        channel: row.channel,
        status: nextStatus,
        forceUpdate: Boolean(forceUpdate)
      });

      return {
        id: row.id,
        productCode: row.product_code,
        channel: row.channel,
        version: row.version,
        status: nextStatus,
        forceUpdate: Boolean(forceUpdate),
        changed: nextStatus !== row.status || forceUpdate !== Number(row.force_update),
        updatedAt: timestamp
      };
    },

    listNotices(token, filters = {}) {
      requireAdminSession(db, token);

      const conditions = [];
      const params = [];
      const normalizedFilters = {
        productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
        channel: normalizeOptionalChannel(filters.channel) ?? "all",
        kind: filters.kind ? String(filters.kind).trim().toLowerCase() : null,
        status: filters.status ? String(filters.status).trim().toLowerCase() : null,
        search: filters.search ? String(filters.search).trim() : null
      };

      if (normalizedFilters.productCode) {
        conditions.push("pr.code = ?");
        params.push(normalizedFilters.productCode);
      }

      if (filters.channel !== undefined && filters.channel !== null && String(filters.channel).trim() !== "") {
        conditions.push("n.channel = ?");
        params.push(normalizedFilters.channel);
      }

      if (normalizedFilters.kind) {
        if (!["announcement", "maintenance"].includes(normalizedFilters.kind)) {
          throw new AppError(400, "INVALID_NOTICE_KIND", "Notice kind must be announcement or maintenance.");
        }
        conditions.push("n.kind = ?");
        params.push(normalizedFilters.kind);
      }

      if (normalizedFilters.status) {
        if (!["active", "archived"].includes(normalizedFilters.status)) {
          throw new AppError(400, "INVALID_NOTICE_STATUS", "Notice status must be active or archived.");
        }
        conditions.push("n.status = ?");
        params.push(normalizedFilters.status);
      }

      if (normalizedFilters.search) {
        const pattern = likeFilter(normalizedFilters.search);
        conditions.push(
          "(n.title LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\' OR COALESCE(pr.code, '') LIKE ? ESCAPE '\\')"
        );
        params.push(pattern, pattern, pattern);
      }

      const items = many(
        db,
        `
          SELECT n.*, pr.code AS product_code, pr.name AS product_name
          FROM notices n
          LEFT JOIN products pr ON pr.id = n.product_id
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY n.starts_at DESC, n.created_at DESC
          LIMIT 100
        `,
        ...params
      ).map(formatNotice);

      return {
        items,
        total: items.length,
        filters: normalizedFilters
      };
    },

    createNotice(token, body = {}) {
      const admin = requireAdminSession(db, token);
      requireField(body, "title");
      requireField(body, "body");

      const productCode = body.productCode ? String(body.productCode).trim().toUpperCase() : null;
      const product = productCode ? requireProductByCode(db, productCode) : null;
      const kind = String(body.kind ?? "announcement").trim().toLowerCase();
      const severity = String(body.severity ?? "info").trim().toLowerCase();
      const status = String(body.status ?? "active").trim().toLowerCase();
      const channel = normalizeNoticeChannel(body.channel, "all");
      const blockLogin = body.blockLogin === true || body.blockLogin === 1 || body.blockLogin === "true" ? 1 : 0;
      const title = String(body.title).trim();
      const content = String(body.body).trim();
      const actionUrl = String(body.actionUrl ?? "").trim();
      const startsAt = body.startsAt ? new Date(body.startsAt).toISOString() : nowIso();
      const endsAt = body.endsAt ? new Date(body.endsAt).toISOString() : null;

      if (!["announcement", "maintenance"].includes(kind)) {
        throw new AppError(400, "INVALID_NOTICE_KIND", "Notice kind must be announcement or maintenance.");
      }
      if (!["info", "warning", "critical"].includes(severity)) {
        throw new AppError(400, "INVALID_NOTICE_SEVERITY", "Notice severity must be info, warning, or critical.");
      }
      if (!["active", "archived"].includes(status)) {
        throw new AppError(400, "INVALID_NOTICE_STATUS", "Notice status must be active or archived.");
      }
      if (endsAt && endsAt <= startsAt) {
        throw new AppError(400, "INVALID_NOTICE_WINDOW", "Notice end time must be later than start time.");
      }

      const timestamp = nowIso();
      const id = generateId("notice");
      run(
        db,
        `
          INSERT INTO notices
          (id, product_id, channel, kind, severity, title, body, action_url, status, block_login, starts_at, ends_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        id,
        product?.id ?? null,
        channel,
        kind,
        severity,
        title,
        content,
        actionUrl || null,
        status,
        blockLogin,
        startsAt,
        endsAt,
        timestamp,
        timestamp
      );

      audit(db, "admin", admin.admin_id, "notice.create", "notice", id, {
        productCode: product?.code ?? null,
        channel,
        kind,
        severity,
        status,
        blockLogin: Boolean(blockLogin)
      });

      return {
        id,
        productCode: product?.code ?? null,
        channel,
        kind,
        severity,
        title,
        body: content,
        actionUrl: actionUrl || null,
        status,
        blockLogin: Boolean(blockLogin),
        startsAt,
        endsAt
      };
    },

    updateNoticeStatus(token, noticeId, body = {}) {
      const admin = requireAdminSession(db, token);
      const row = one(
        db,
        `
          SELECT n.*, pr.code AS product_code
          FROM notices n
          LEFT JOIN products pr ON pr.id = n.product_id
          WHERE n.id = ?
        `,
        noticeId
      );

      if (!row) {
        throw new AppError(404, "NOTICE_NOT_FOUND", "Notice does not exist.");
      }

      const status = String(body.status ?? "").trim().toLowerCase();
      if (!["active", "archived"].includes(status)) {
        throw new AppError(400, "INVALID_NOTICE_STATUS", "Notice status must be active or archived.");
      }

      const blockLogin = body.blockLogin === undefined
        ? Number(row.block_login)
        : body.blockLogin === true || body.blockLogin === 1 || body.blockLogin === "true"
          ? 1
          : 0;

      const timestamp = nowIso();
      run(
        db,
        `
          UPDATE notices
          SET status = ?, block_login = ?, updated_at = ?
          WHERE id = ?
        `,
        status,
        blockLogin,
        timestamp,
        row.id
      );

      audit(db, "admin", admin.admin_id, "notice.status", "notice", row.id, {
        productCode: row.product_code ?? null,
        channel: row.channel,
        status,
        blockLogin: Boolean(blockLogin)
      });

      return {
        id: row.id,
        productCode: row.product_code ?? null,
        channel: row.channel,
        status,
        blockLogin: Boolean(blockLogin),
        changed: status !== row.status || blockLogin !== Number(row.block_login),
        updatedAt: timestamp
      };
    },

    clientNotices(reqLike, body, rawBody) {
      const product = requireSignedProduct(db, config, reqLike, rawBody);
      requireField(body, "productCode");

      if (String(body.productCode).trim().toUpperCase() !== product.code) {
        throw new AppError(400, "PRODUCT_MISMATCH", "Signed app id does not match the product code.");
      }

      const notices = activeNoticesForProduct(db, product.id, body.channel).map(formatNotice);
      return {
        productCode: product.code,
        channel: normalizeNoticeChannel(body.channel, "stable"),
        notices
      };
    },

    listNetworkRules(token, filters = {}) {
      requireAdminSession(db, token);

      const conditions = [];
      const params = [];
      const normalizedFilters = {
        productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
        actionScope: filters.actionScope ? String(filters.actionScope).trim().toLowerCase() : null,
        status: filters.status ? String(filters.status).trim().toLowerCase() : null,
        search: filters.search ? String(filters.search).trim() : null
      };

      if (normalizedFilters.productCode) {
        conditions.push("pr.code = ?");
        params.push(normalizedFilters.productCode);
      }

      if (normalizedFilters.actionScope) {
        conditions.push("nr.action_scope = ?");
        params.push(normalizedFilters.actionScope);
      }

      if (normalizedFilters.status) {
        if (!["active", "archived"].includes(normalizedFilters.status)) {
          throw new AppError(400, "INVALID_NETWORK_RULE_STATUS", "Rule status must be active or archived.");
        }
        conditions.push("nr.status = ?");
        params.push(normalizedFilters.status);
      }

      if (normalizedFilters.search) {
        const pattern = likeFilter(normalizedFilters.search);
        conditions.push(
          "(nr.pattern LIKE ? ESCAPE '\\' OR COALESCE(nr.notes, '') LIKE ? ESCAPE '\\' OR COALESCE(pr.code, '') LIKE ? ESCAPE '\\')"
        );
        params.push(pattern, pattern, pattern);
      }

      const items = many(
        db,
        `
          SELECT nr.*, pr.code AS product_code, pr.name AS product_name
          FROM network_rules nr
          LEFT JOIN products pr ON pr.id = nr.product_id
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY nr.created_at DESC
          LIMIT 100
        `,
        ...params
      ).map((row) => ({
        id: row.id,
        productCode: row.product_code ?? null,
        productName: row.product_name ?? null,
        targetType: row.target_type,
        pattern: row.pattern,
        actionScope: row.action_scope,
        decision: row.decision,
        status: row.status,
        notes: row.notes ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));

      return {
        items,
        total: items.length,
        filters: normalizedFilters
      };
    },

    createNetworkRule(token, body = {}) {
      const admin = requireAdminSession(db, token);
      requireField(body, "pattern");

      const productCode = body.productCode ? String(body.productCode).trim().toUpperCase() : null;
      const product = productCode ? requireProductByCode(db, productCode) : null;
      const targetType = String(body.targetType ?? (String(body.pattern).includes("/") ? "cidr" : "ip"))
        .trim()
        .toLowerCase();
      const pattern = String(body.pattern).trim();
      const actionScope = String(body.actionScope ?? "all").trim().toLowerCase();
      const decision = String(body.decision ?? "block").trim().toLowerCase();
      const status = String(body.status ?? "active").trim().toLowerCase();
      const notes = String(body.notes ?? "").trim();

      if (!["ip", "cidr"].includes(targetType)) {
        throw new AppError(400, "INVALID_NETWORK_TARGET_TYPE", "Target type must be ip or cidr.");
      }
      if (!["all", "register", "recharge", "login", "heartbeat"].includes(actionScope)) {
        throw new AppError(400, "INVALID_NETWORK_ACTION_SCOPE", "Action scope is not supported.");
      }
      if (decision !== "block") {
        throw new AppError(400, "INVALID_NETWORK_DECISION", "Only block rules are supported in this version.");
      }
      if (!["active", "archived"].includes(status)) {
        throw new AppError(400, "INVALID_NETWORK_RULE_STATUS", "Rule status must be active or archived.");
      }

      if (targetType === "ip" && !normalizeIpAddress(pattern)) {
        throw new AppError(400, "INVALID_NETWORK_PATTERN", "IP pattern is invalid.");
      }
      if (targetType === "cidr" && !ipv4CidrMatch(pattern.split("/")[0], pattern)) {
        throw new AppError(400, "INVALID_NETWORK_PATTERN", "CIDR pattern must be a valid IPv4 CIDR.");
      }

      const timestamp = nowIso();
      const id = generateId("nrule");
      run(
        db,
        `
          INSERT INTO network_rules
          (id, product_id, target_type, pattern, action_scope, decision, status, notes, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        id,
        product?.id ?? null,
        targetType,
        pattern,
        actionScope,
        decision,
        status,
        notes || null,
        timestamp,
        timestamp
      );

      audit(db, "admin", admin.admin_id, "network-rule.create", "network_rule", id, {
        productCode: product?.code ?? null,
        targetType,
        pattern,
        actionScope,
        status
      });

      return {
        id,
        productCode: product?.code ?? null,
        targetType,
        pattern,
        actionScope,
        decision,
        status,
        notes: notes || null
      };
    },

    updateNetworkRuleStatus(token, ruleId, body = {}) {
      const admin = requireAdminSession(db, token);
      const row = one(
        db,
        `
          SELECT nr.*, pr.code AS product_code
          FROM network_rules nr
          LEFT JOIN products pr ON pr.id = nr.product_id
          WHERE nr.id = ?
        `,
        ruleId
      );

      if (!row) {
        throw new AppError(404, "NETWORK_RULE_NOT_FOUND", "Network rule does not exist.");
      }

      const status = String(body.status ?? "").trim().toLowerCase();
      if (!["active", "archived"].includes(status)) {
        throw new AppError(400, "INVALID_NETWORK_RULE_STATUS", "Rule status must be active or archived.");
      }

      const timestamp = nowIso();
      run(
        db,
        `
          UPDATE network_rules
          SET status = ?, updated_at = ?
          WHERE id = ?
        `,
        status,
        timestamp,
        row.id
      );

      audit(db, "admin", admin.admin_id, "network-rule.status", "network_rule", row.id, {
        productCode: row.product_code ?? null,
        pattern: row.pattern,
        actionScope: row.action_scope,
        status
      });

      return {
        id: row.id,
        productCode: row.product_code ?? null,
        pattern: row.pattern,
        actionScope: row.action_scope,
        status,
        changed: status !== row.status,
        updatedAt: timestamp
      };
    },

    listSessions(token, filters = {}) {
      requireAdminSession(db, token);
      expireStaleSessions(db);

      const conditions = [];
      const params = [];
      const normalizedFilters = {
        productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
        username: filters.username ? String(filters.username).trim() : null,
        status: filters.status ? String(filters.status).trim().toLowerCase() : null,
        search: filters.search ? String(filters.search).trim() : null
      };

      if (
        normalizedFilters.status &&
        !["active", "expired"].includes(normalizedFilters.status)
      ) {
        throw new AppError(400, "INVALID_SESSION_STATUS", "Session status must be active or expired.");
      }

      if (normalizedFilters.productCode) {
        conditions.push("pr.code = ?");
        params.push(normalizedFilters.productCode);
      }

      if (normalizedFilters.username) {
        conditions.push("a.username = ?");
        params.push(normalizedFilters.username);
      }

      if (normalizedFilters.status) {
        conditions.push("s.status = ?");
        params.push(normalizedFilters.status);
      }

      if (normalizedFilters.search) {
        const pattern = likeFilter(normalizedFilters.search);
        conditions.push(
          "(a.username LIKE ? ESCAPE '\\' OR d.fingerprint LIKE ? ESCAPE '\\' OR s.id LIKE ? ESCAPE '\\')"
        );
        params.push(pattern, pattern, pattern);
      }

      const items = many(
        db,
        `
          SELECT s.id, s.account_id, s.entitlement_id, s.device_id, s.status, s.issued_at, s.expires_at,
                 s.last_heartbeat_at, s.last_seen_ip, s.user_agent, s.revoked_reason,
                 pr.code AS product_code, pr.name AS product_name,
                 a.username,
                 d.fingerprint, d.device_name,
                 pol.name AS policy_name
          FROM sessions s
          JOIN customer_accounts a ON a.id = s.account_id
          JOIN devices d ON d.id = s.device_id
          JOIN products pr ON pr.id = s.product_id
          JOIN entitlements e ON e.id = s.entitlement_id
          JOIN policies pol ON pol.id = e.policy_id
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY s.last_heartbeat_at DESC
          LIMIT 100
        `,
        ...params
      );

      return {
        items,
        total: items.length,
        filters: normalizedFilters
      };
    },

    revokeSession(token, sessionId, body = {}) {
      const admin = requireAdminSession(db, token);
      const session = one(
        db,
        `
          SELECT s.id, s.status, s.revoked_reason,
                 pr.code AS product_code,
                 a.username,
                 d.fingerprint
          FROM sessions s
          JOIN customer_accounts a ON a.id = s.account_id
          JOIN devices d ON d.id = s.device_id
          JOIN products pr ON pr.id = s.product_id
          WHERE s.id = ?
        `,
        sessionId
      );

      if (!session) {
        throw new AppError(404, "SESSION_NOT_FOUND", "Session does not exist.");
      }

      const reason = normalizeReason(body.reason, "admin_revoked");
      if (session.status !== "active") {
        return {
          ...session,
          changed: false,
          revokedReason: session.revoked_reason ?? reason
        };
      }

      run(
        db,
        `
          UPDATE sessions
          SET status = 'expired', revoked_reason = ?
          WHERE id = ?
        `,
        reason,
        session.id
      );

      audit(db, "admin", admin.admin_id, "session.revoke", "session", session.id, {
        productCode: session.product_code,
        username: session.username,
        fingerprint: session.fingerprint,
        reason
      });

      return {
        ...session,
        status: "expired",
        changed: true,
        revokedReason: reason
      };
    },

    listAuditLogs(token, filters = {}) {
      requireAdminSession(db, token);

      const conditions = [];
      const params = [];
      const limit = Math.min(Math.max(Number(filters.limit ?? 50), 1), 200);
      const normalizedFilters = {
        eventType: filters.eventType ? String(filters.eventType).trim() : null,
        actorType: filters.actorType ? String(filters.actorType).trim() : null,
        limit
      };

      if (normalizedFilters.eventType) {
        conditions.push("event_type = ?");
        params.push(normalizedFilters.eventType);
      }

      if (normalizedFilters.actorType) {
        conditions.push("actor_type = ?");
        params.push(normalizedFilters.actorType);
      }

      const items = many(
        db,
        `
          SELECT id, actor_type, actor_id, event_type, entity_type, entity_id, metadata_json, created_at
          FROM audit_logs
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY created_at DESC
          LIMIT ?
        `,
        ...params,
        limit
      ).map((row) => ({
        ...row,
        metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null
      }));

      return {
        items,
        total: items.length,
        filters: normalizedFilters
      };
    },

    rotateTokenKey(token) {
      const admin = requireAdminSession(db, token);
      config.licenseKeys = rotateLicenseKeyStore(config, config.licenseKeys);

      audit(db, "admin", admin.admin_id, "token-key.rotate", "token_key", config.licenseKeys.keyId, {
        activeKeyId: config.licenseKeys.keyId
      });

      return {
        activeKeyId: config.licenseKeys.keyId,
        publicKeyFingerprint: config.licenseKeys.publicKeyFingerprint,
        keys: config.licenseKeys.keyring.keys.map((entry) => ({
          keyId: entry.keyId,
          status: entry.status,
          createdAt: entry.createdAt,
          publicKeyFingerprint: entry.publicKeyFingerprint
        }))
      };
    },

    checkClientVersion(reqLike, body, rawBody) {
      const product = requireSignedProduct(db, config, reqLike, rawBody);
      requireField(body, "productCode");
      requireField(body, "clientVersion");

      if (String(body.productCode).trim().toUpperCase() !== product.code) {
        throw new AppError(400, "PRODUCT_MISMATCH", "Signed app id does not match the product code.");
      }

      return buildVersionManifest(
        db,
        product,
        String(body.clientVersion).trim(),
        body.channel
      );
    },

    registerClient(reqLike, body, rawBody, meta = {}) {
      const product = requireSignedProduct(db, config, reqLike, rawBody);
      requireField(body, "productCode");
      requireField(body, "username");
      requireField(body, "password");

      if (String(body.productCode).trim().toUpperCase() !== product.code) {
        throw new AppError(400, "PRODUCT_MISMATCH", "Signed app id does not match the product code.");
      }

      enforceNetworkRules(db, product, meta.ip, "register");

      const username = String(body.username).trim();
      const password = String(body.password);
      if (username.length < 3 || password.length < 8) {
        throw new AppError(400, "INVALID_ACCOUNT", "Username must be 3+ chars and password 8+ chars.");
      }

      if (
        one(
          db,
          "SELECT id FROM customer_accounts WHERE product_id = ? AND username = ?",
          product.id,
          username
        )
      ) {
        throw new AppError(409, "ACCOUNT_EXISTS", "This username has already been registered.");
      }

      const now = nowIso();
      const accountId = generateId("acct");
      run(
        db,
        `
          INSERT INTO customer_accounts
          (id, product_id, username, password_hash, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'active', ?, ?)
        `,
        accountId,
        product.id,
        username,
        hashPassword(password),
        now,
        now
      );

      audit(db, "account", accountId, "account.register", "account", accountId, {
        productCode: product.code,
        username
      });

      return {
        accountId,
        productCode: product.code,
        username
      };
    },

    redeemCard(reqLike, body, rawBody, meta = {}) {
      const product = requireSignedProduct(db, config, reqLike, rawBody);
      requireField(body, "productCode");
      requireField(body, "username");
      requireField(body, "password");
      requireField(body, "cardKey");

      if (String(body.productCode).trim().toUpperCase() !== product.code) {
        throw new AppError(400, "PRODUCT_MISMATCH", "Signed app id does not match the product code.");
      }

      enforceNetworkRules(db, product, meta.ip, "recharge");

      return withTransaction(db, () => {
        const account = one(
          db,
          `
            SELECT * FROM customer_accounts
            WHERE product_id = ? AND username = ? AND status = 'active'
          `,
          product.id,
          String(body.username).trim()
        );

        if (!account || !verifyPassword(String(body.password), account.password_hash)) {
          throw new AppError(401, "ACCOUNT_LOGIN_FAILED", "Username or password is incorrect.");
        }

        const card = one(
          db,
          `
            SELECT lk.*, p.duration_days, p.name AS policy_name
            FROM license_keys lk
            JOIN policies p ON p.id = lk.policy_id
            WHERE lk.product_id = ? AND lk.card_key = ? AND lk.status = 'fresh'
          `,
          product.id,
          String(body.cardKey).trim().toUpperCase()
        );

        if (!card) {
          throw new AppError(404, "CARD_NOT_AVAILABLE", "Card key is invalid, already redeemed, or revoked.");
        }

        const latest = one(
          db,
          `
            SELECT ends_at
            FROM entitlements
            WHERE account_id = ? AND product_id = ? AND policy_id = ?
            ORDER BY ends_at DESC
            LIMIT 1
          `,
          account.id,
          product.id,
          card.policy_id
        );

        const now = nowIso();
        const startsAt = latest && latest.ends_at > now ? latest.ends_at : now;
        const endsAt = addDays(startsAt, card.duration_days);
        const entitlementId = generateId("ent");
        const resellerAllocation = getResellerAllocationByLicenseKey(db, card.id);

        run(
          db,
          `
            INSERT INTO entitlements
            (id, product_id, policy_id, account_id, source_license_key_id, status, starts_at, ends_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
          `,
          entitlementId,
          product.id,
          card.policy_id,
          account.id,
          card.id,
          startsAt,
          endsAt,
          now,
          now
        );

        run(
          db,
          `
            UPDATE license_keys
            SET status = 'redeemed', redeemed_at = ?, redeemed_by_account_id = ?
            WHERE id = ?
          `,
          now,
          account.id,
          card.id
        );

        audit(db, "account", account.id, "card.redeem", "license_key", card.id, {
          cardKey: card.card_key,
          policyName: card.policy_name,
          resellerCode: resellerAllocation?.reseller_code ?? null,
          resellerName: resellerAllocation?.reseller_name ?? null,
          startsAt,
          endsAt
        });

        return {
          entitlementId,
          policyName: card.policy_name,
          reseller: resellerAllocation
            ? {
                id: resellerAllocation.reseller_id,
                code: resellerAllocation.reseller_code,
                name: resellerAllocation.reseller_name,
                allocationBatchCode: resellerAllocation.allocation_batch_code,
                allocatedAt: resellerAllocation.allocated_at
              }
            : null,
          startsAt,
          endsAt
        };
      });
    },

    loginClient(reqLike, body, rawBody, meta) {
      const product = requireSignedProduct(db, config, reqLike, rawBody);
      requireField(body, "productCode");
      requireField(body, "username");
      requireField(body, "password");
      requireField(body, "deviceFingerprint");

      if (String(body.productCode).trim().toUpperCase() !== product.code) {
        throw new AppError(400, "PRODUCT_MISMATCH", "Signed app id does not match the product code.");
      }

      enforceNetworkRules(db, product, meta.ip, "login");
      requireNoBlockingNotices(db, product, body.channel);
      requireClientVersionAllowed(
        db,
        product,
        body.clientVersion ? String(body.clientVersion).trim() : null,
        body.channel
      );

      return withTransaction(db, () => {
        expireStaleSessions(db);

        const account = one(
          db,
          `
            SELECT * FROM customer_accounts
            WHERE product_id = ? AND username = ? AND status = 'active'
          `,
          product.id,
          String(body.username).trim()
        );

        if (!account || !verifyPassword(String(body.password), account.password_hash)) {
          throw new AppError(401, "ACCOUNT_LOGIN_FAILED", "Username or password is incorrect.");
        }

        const now = nowIso();
        const deviceFingerprint = String(body.deviceFingerprint).trim();
        requireDeviceNotBlocked(db, product.id, deviceFingerprint);
        const entitlement = getActiveEntitlement(db, account.id, product.id, now);
        if (!entitlement) {
          throw new AppError(403, "LICENSE_INACTIVE", "No active subscription window is available for this account.");
        }

        const device = upsertDevice(
          db,
          product.id,
          deviceFingerprint,
          String(body.deviceName ?? "Client Device"),
          meta
        );
        bindDeviceToEntitlement(db, entitlement, device);

        if (!entitlement.allow_concurrent_sessions) {
          run(
            db,
            `
              UPDATE sessions
              SET status = 'expired', revoked_reason = 'single_session_policy'
              WHERE account_id = ? AND product_id = ? AND status = 'active'
            `,
            account.id,
            product.id
          );
        }

        const issuedAt = now;
        const expiresAt = addSeconds(issuedAt, entitlement.token_ttl_seconds);
        const sessionId = generateId("sess");
        const sessionToken = randomToken(32);
        const licenseToken = issueLicenseToken(config.licenseKeys, {
          sid: sessionId,
          pid: product.code,
          sub: account.username,
          did: device.fingerprint,
          plan: entitlement.policy_name,
          iss: config.tokenIssuer,
          kid: config.licenseKeys.keyId,
          iat: issuedAt,
          exp: expiresAt
        });

        run(
          db,
          `
            INSERT INTO sessions
            (id, product_id, account_id, entitlement_id, device_id, session_token, license_token, status, issued_at,
             expires_at, last_heartbeat_at, last_seen_ip, user_agent)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
          `,
          sessionId,
          product.id,
          account.id,
          entitlement.id,
          device.id,
          sessionToken,
          licenseToken,
          issuedAt,
          expiresAt,
          issuedAt,
          meta.ip,
          meta.userAgent
        );

        run(
          db,
          "UPDATE customer_accounts SET last_login_at = ?, updated_at = ? WHERE id = ?",
          issuedAt,
          issuedAt,
          account.id
        );

        audit(db, "account", account.id, "session.login", "session", sessionId, {
          productCode: product.code,
          deviceFingerprint: device.fingerprint
        });

        return {
          sessionId,
          sessionToken,
          licenseToken,
          expiresAt,
          heartbeat: {
            intervalSeconds: entitlement.heartbeat_interval_seconds,
            timeoutSeconds: entitlement.heartbeat_timeout_seconds
          },
          device: {
            id: device.id,
            fingerprint: device.fingerprint,
            name: device.device_name
          },
          entitlement: {
            id: entitlement.id,
            policyName: entitlement.policy_name,
            endsAt: entitlement.ends_at
          }
        };
      });
    },

    heartbeatClient(reqLike, body, rawBody, meta) {
      const product = requireSignedProduct(db, config, reqLike, rawBody);
      requireField(body, "productCode");
      requireField(body, "sessionToken");
      requireField(body, "deviceFingerprint");

      if (String(body.productCode).trim().toUpperCase() !== product.code) {
        throw new AppError(400, "PRODUCT_MISMATCH", "Signed app id does not match the product code.");
      }

      enforceNetworkRules(db, product, meta.ip, "heartbeat");

      return withTransaction(db, () => {
        expireStaleSessions(db);
        const session = one(
          db,
          `
            SELECT s.*, d.fingerprint, a.username, pol.heartbeat_interval_seconds, pol.heartbeat_timeout_seconds, pol.token_ttl_seconds
            FROM sessions s
            JOIN devices d ON d.id = s.device_id
            JOIN customer_accounts a ON a.id = s.account_id
            JOIN entitlements e ON e.id = s.entitlement_id
            JOIN policies pol ON pol.id = e.policy_id
            WHERE s.product_id = ? AND s.session_token = ? AND s.status = 'active'
          `,
          product.id,
          String(body.sessionToken).trim()
        );

        if (!session) {
          throw new AppError(401, "SESSION_INVALID", "Session token is invalid or expired.");
        }

        if (session.fingerprint !== String(body.deviceFingerprint).trim()) {
          run(
            db,
            "UPDATE sessions SET status = 'expired', revoked_reason = 'device_mismatch' WHERE id = ?",
            session.id
          );
          throw new AppError(401, "DEVICE_MISMATCH", "Device fingerprint does not match this session.");
        }

        const block = activeDeviceBlock(db, product.id, session.fingerprint);
        if (block) {
          run(
            db,
            "UPDATE sessions SET status = 'expired', revoked_reason = 'device_blocked' WHERE id = ?",
            session.id
          );
          throw new AppError(403, "DEVICE_BLOCKED", "This device fingerprint has been blocked by the operator.", {
            reason: block.reason,
            blockedAt: block.created_at
          });
        }

        requireClientVersionAllowed(
          db,
          product,
          body.clientVersion ? String(body.clientVersion).trim() : null,
          body.channel
        );

        const now = nowIso();
        const expiresAt = addSeconds(now, session.token_ttl_seconds);
        run(
          db,
          `
            UPDATE sessions
            SET last_heartbeat_at = ?, expires_at = ?, last_seen_ip = ?, user_agent = ?
            WHERE id = ?
          `,
          now,
          expiresAt,
          meta.ip,
          meta.userAgent,
          session.id
        );

        return {
          status: "active",
          account: session.username,
          expiresAt,
          nextHeartbeatInSeconds: session.heartbeat_interval_seconds
        };
      });
    },

    logoutClient(reqLike, body, rawBody) {
      const product = requireSignedProduct(db, config, reqLike, rawBody);
      requireField(body, "productCode");
      requireField(body, "sessionToken");

      if (String(body.productCode).trim().toUpperCase() !== product.code) {
        throw new AppError(400, "PRODUCT_MISMATCH", "Signed app id does not match the product code.");
      }

      const session = one(
        db,
        "SELECT * FROM sessions WHERE product_id = ? AND session_token = ?",
        product.id,
        String(body.sessionToken).trim()
      );
      if (!session) {
        throw new AppError(404, "SESSION_NOT_FOUND", "Session token does not exist.");
      }

      run(
        db,
        "UPDATE sessions SET status = 'expired', revoked_reason = 'client_logout' WHERE id = ?",
        session.id
      );

      audit(db, "account", session.account_id, "session.logout", "session", session.id, {});
      return { status: "logged_out" };
    }
  };
}
