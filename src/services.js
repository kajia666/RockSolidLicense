import { AppError } from "./http.js";
import { rotateLicenseKeyStore } from "./license-keys.js";
import { NonceReplayError } from "./runtime-state.js";
import {
  DEFAULT_PRODUCT_FEATURE_CONFIG,
  findOwnedProductIdByCode,
  getActiveProductRecordByCode,
  getActiveProductRecordBySdkAppId,
  getProductRecordById,
  getProductRowById,
  listAssignedDeveloperProductIds,
  listOwnedProductIds,
  parseProductFeatureConfigRow,
  productCodeExists,
  queryProductRows
} from "./data/product-repository.js";
import {
  describeLicenseKeyControl,
  getCardRowById,
  maskCardKey,
  normalizeCardControlStatus,
  queryCardRows
} from "./data/card-repository.js";
import {
  entitlementLifecycleStatus,
  formatEntitlementGrant,
  getLatestEntitlementSnapshot,
  getUsableEntitlement,
  loadPointEntitlementForAdmin,
  normalizeEntitlementStatus,
  queryEntitlementRows
} from "./data/entitlement-repository.js";
import {
  getPolicyAccessRowById,
  normalizeBindMode,
  normalizeGrantType,
  parseBindFieldsInput,
  parsePolicyBindConfigRow,
  parsePolicyGrantConfigRow,
  parsePolicyUnbindConfigRow,
  queryPolicyRows
} from "./data/policy-repository.js";
import { createSqliteMainStore } from "./data/sqlite-main-store.js";
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
  sha256Hex,
  signClientRequest,
  verifyPassword
} from "./security.js";

const DEVELOPER_MEMBER_ROLE_PERMISSIONS = Object.freeze({
  owner: [
    "*"
  ],
  admin: [
    "products.read",
    "products.write",
    "policies.read",
    "policies.write",
    "cards.read",
    "cards.write",
    "versions.read",
    "versions.write",
    "notices.read",
    "notices.write",
    "ops.read",
    "ops.write",
    "profile.write"
  ],
  operator: [
    "products.read",
    "policies.read",
    "policies.write",
    "cards.read",
    "cards.write",
    "versions.read",
    "versions.write",
    "notices.read",
    "notices.write",
    "ops.read",
    "ops.write",
    "profile.write"
  ],
  viewer: [
    "products.read",
    "policies.read",
    "cards.read",
    "versions.read",
    "notices.read",
    "ops.read",
    "profile.write"
  ]
});

function one(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

function many(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

function run(db, sql, ...params) {
  return db.prepare(sql).run(...params);
}

function makeSqlPlaceholders(count) {
  return Array.from({ length: Math.max(0, Number(count) || 0) }, () => "?").join(", ");
}

function appendInCondition(columnSql, values, conditions, params) {
  if (!Array.isArray(values)) {
    return;
  }

  const normalized = Array.from(
    new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    )
  );

  if (!normalized.length) {
    conditions.push("1 = 0");
    return;
  }

  conditions.push(`${columnSql} IN (${makeSqlPlaceholders(normalized.length)})`);
  params.push(...normalized);
}

function expireActiveSessions(db, stateStore, whereSql, params, reason) {
  const rows = many(
    db,
    `
      SELECT id, session_token
      FROM sessions
      WHERE status = 'active' AND ${whereSql}
    `,
    ...params
  );

  if (!rows.length) {
    return 0;
  }

  run(
    db,
    `
      UPDATE sessions
      SET status = 'expired', revoked_reason = ?
      WHERE status = 'active' AND ${whereSql}
    `,
    reason,
    ...params
  );

  for (const row of rows) {
    stateStore?.expireSession(row.session_token, reason, { sessionId: row.id });
  }

  return rows.length;
}

function expireSessionById(db, stateStore, sessionId, reason) {
  return expireActiveSessions(db, stateStore, "id = ?", [sessionId], reason);
}

function expireSessionByToken(db, stateStore, sessionToken, reason) {
  return expireActiveSessions(db, stateStore, "session_token = ?", [sessionToken], reason);
}

function revokeDeveloperSessions(db, whereSql, params = []) {
  const rows = many(
    db,
    `
      SELECT id, token
      FROM developer_sessions
      WHERE ${whereSql}
    `,
    ...params
  );

  if (!rows.length) {
    return 0;
  }

  run(
    db,
    `DELETE FROM developer_sessions WHERE ${whereSql}`,
    ...params
  );
  return rows.length;
}

function revokeDeveloperMemberSessions(db, whereSql, params = []) {
  const rows = many(
    db,
    `
      SELECT id, token
      FROM developer_member_sessions
      WHERE ${whereSql}
    `,
    ...params
  );

  if (!rows.length) {
    return 0;
  }

  run(
    db,
    `DELETE FROM developer_member_sessions WHERE ${whereSql}`,
    ...params
  );
  return rows.length;
}

async function finalizeIssuedSessionRuntime(db, stateStore, payload) {
  if (!payload?.runtime) {
    return payload;
  }

  const runtime = payload.runtime;
  if (stateStore?.commitSessionRuntime) {
    const result = await stateStore.commitSessionRuntime(runtime.session, {
      claimSingleOwner: runtime.claimSingleOwner
    });
    if (result?.previousSessionToken) {
      expireSessionByToken(db, stateStore, result.previousSessionToken, "single_session_runtime");
    }
  } else if (stateStore?.recordSession) {
    stateStore.recordSession(runtime.session);
  }

  const { runtime: _runtime, ...publicPayload } = payload;
  return publicPayload;
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

const PRODUCT_CODE_FIELD_CANDIDATES = ["productCode", "projectCode", "softwareCode"];

function readProductCodeInput(body = {}, required = true) {
  for (const fieldName of PRODUCT_CODE_FIELD_CANDIDATES) {
    const value = body?.[fieldName];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim().toUpperCase();
    }
  }

  if (required) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "productCode is required. projectCode or softwareCode are also accepted."
    );
  }

  return null;
}

function requireSignedProductCodeMatch(product, body = {}) {
  const requestedCode = readProductCodeInput(body, true);
  if (requestedCode !== product.code) {
    throw new AppError(400, "PRODUCT_MISMATCH", "Signed app id does not match the product code.");
  }
  return requestedCode;
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

function normalizeDeveloperUsername(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
}

function normalizeDeveloperMemberRole(value = "viewer") {
  const role = String(value ?? "viewer").trim().toLowerCase();
  if (!Object.hasOwn(DEVELOPER_MEMBER_ROLE_PERMISSIONS, role) || role === "owner") {
    throw new AppError(400, "INVALID_DEVELOPER_MEMBER_ROLE", "Developer member role must be admin, operator, or viewer.");
  }
  return role;
}

function normalizeDeveloperMemberStatus(value = "active") {
  const status = String(value ?? "active").trim().toLowerCase();
  if (!["active", "disabled"].includes(status)) {
    throw new AppError(400, "INVALID_DEVELOPER_MEMBER_STATUS", "Developer member status must be active or disabled.");
  }
  return status;
}

function developerRolePermissions(role = "viewer") {
  const normalizedRole = role === "owner" ? "owner" : normalizeDeveloperMemberRole(role);
  return [...(DEVELOPER_MEMBER_ROLE_PERMISSIONS[normalizedRole] ?? [])];
}

function hasDeveloperPermission(session, permission) {
  if (!session) {
    return false;
  }
  if (session.actor_scope === "owner") {
    return true;
  }
  return Array.isArray(session.permissions)
    && (session.permissions.includes("*") || session.permissions.includes(permission));
}

function requireDeveloperPermission(session, permission, code, message) {
  if (hasDeveloperPermission(session, permission)) {
    return;
  }
  throw new AppError(403, code, message);
}

function formatDeveloperRow(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name ?? "",
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at ?? null
  };
}

function formatDeveloperMemberRow(row, productAccess = []) {
  const role = normalizeDeveloperMemberRole(row.role ?? "viewer");
  return {
    id: row.id,
    developerId: row.developer_id,
    username: row.username,
    displayName: row.display_name ?? "",
    role,
    permissions: developerRolePermissions(role),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at ?? null,
    productAccess
  };
}

function buildDeveloperActor(session) {
  return {
    type: session.actor_scope === "owner" ? "owner" : "member",
    id: session.actor_id,
    username: session.username,
    displayName: session.display_name ?? "",
    role: session.member_role ?? "owner",
    permissions: session.permissions ?? developerRolePermissions(session.member_role ?? "owner")
  };
}

function auditDeveloperSession(db, session, eventType, entityType, entityId, metadata = {}) {
  const actorType = session.actor_scope === "member" ? "developer_member" : "developer";
  audit(db, actorType, session.actor_id, eventType, entityType, entityId, {
    developerId: session.developer_id,
    actorType: session.actor_scope,
    actorUsername: session.username,
    actorRole: session.member_role ?? "owner",
    ...metadata
  });
}

function requireDeveloperSession(db, token) {
  if (!token) {
    throw new AppError(401, "DEVELOPER_AUTH_REQUIRED", "Missing developer bearer token.");
  }

  const session = one(
    db,
    `
      SELECT ds.*, da.username, da.display_name, da.status AS developer_status
      FROM developer_sessions ds
      JOIN developer_accounts da ON da.id = ds.developer_id
      WHERE ds.token = ? AND ds.expires_at > ?
    `,
    token,
    nowIso()
  );

  if (session) {
    if (session.developer_status !== "active") {
      throw new AppError(401, "DEVELOPER_AUTH_INVALID", "Developer session is invalid or expired.");
    }

    run(db, "UPDATE developer_sessions SET last_seen_at = ? WHERE id = ?", nowIso(), session.id);
    return {
      ...session,
      actor_scope: "owner",
      actor_type: "developer",
      actor_id: session.developer_id,
      developer_username: session.username,
      developer_display_name: session.display_name ?? "",
      member_role: "owner",
      permissions: developerRolePermissions("owner")
    };
  }

  const memberSession = one(
    db,
    `
      SELECT dms.*, dm.username, dm.display_name, dm.status AS member_status, dm.role AS member_role,
             da.username AS developer_username, da.display_name AS developer_display_name, da.status AS developer_status
      FROM developer_member_sessions dms
      JOIN developer_members dm ON dm.id = dms.member_id
      JOIN developer_accounts da ON da.id = dms.developer_id
      WHERE dms.token = ? AND dms.expires_at > ?
    `,
    token,
    nowIso()
  );

  if (
    !memberSession
    || memberSession.member_status !== "active"
    || memberSession.developer_status !== "active"
  ) {
    throw new AppError(401, "DEVELOPER_AUTH_INVALID", "Developer session is invalid or expired.");
  }

  run(db, "UPDATE developer_member_sessions SET last_seen_at = ? WHERE id = ?", nowIso(), memberSession.id);
  return {
    ...memberSession,
    actor_scope: "member",
    actor_type: "developer_member",
    actor_id: memberSession.member_id,
    member_id: memberSession.member_id,
    developer_id: memberSession.developer_id,
    member_role: normalizeDeveloperMemberRole(memberSession.member_role),
    permissions: developerRolePermissions(memberSession.member_role)
  };
}

function requireDeveloperOwnerSession(db, token) {
  const session = requireDeveloperSession(db, token);
  if (session.actor_scope !== "owner") {
    throw new AppError(
      403,
      "DEVELOPER_MEMBERS_FORBIDDEN",
      "Only the primary developer account can manage developer team members."
    );
  }
  return session;
}

function listDeveloperAccessibleProductIds(db, session) {
  if (session.actor_scope === "owner") {
    return listOwnedProductIds(db, session.developer_id);
  }

  return listAssignedDeveloperProductIds(db, session.member_id, session.developer_id);
}

function listDeveloperAccessibleProductRows(db, session) {
  if (session.actor_scope === "owner") {
    return queryProductRows(db, { ownerDeveloperId: session.developer_id });
  }

  const productIds = listDeveloperAccessibleProductIds(db, session);
  return queryProductRows(db, { productIds });
}

function listDeveloperAccessibleProductCodes(db, session) {
  return listDeveloperAccessibleProductRows(db, session).map((item) => item.code);
}

function numberCount(value) {
  return Number(value ?? 0);
}

function buildMetricMap(rows, keyField = "product_id", valueField = "count") {
  const map = new Map();
  for (const row of rows) {
    map.set(String(row[keyField]), numberCount(row[valueField]));
  }
  return map;
}

function queryDeveloperDashboardPayload(db, session, runtimeState) {
  expireStaleSessions(db, runtimeState);

  const products = listDeveloperAccessibleProductRows(db, session);
  const summary = {
    projects: products.length,
    registerEnabledProjects: products.filter((item) => item.featureConfig?.allowRegister !== false).length,
    cardLoginEnabledProjects: products.filter((item) => item.featureConfig?.allowCardLogin !== false).length,
    noticesEnabledProjects: products.filter((item) => item.featureConfig?.allowNotices !== false).length,
    versionCheckEnabledProjects: products.filter((item) => item.featureConfig?.allowVersionCheck !== false).length,
    policies: 0,
    cardsFresh: 0,
    cardsRedeemed: 0,
    accounts: 0,
    disabledAccounts: 0,
    activeEntitlements: 0,
    activeSessions: 0,
    activeBindings: 0,
    blockedDevices: 0,
    activeClientVersions: 0,
    forceUpdateVersions: 0,
    activeNotices: 0,
    blockingNotices: 0,
    activeNetworkRules: 0,
    teamMembers: session.actor_scope === "owner"
      ? numberCount(one(db, "SELECT COUNT(*) AS count FROM developer_members WHERE developer_id = ?", session.developer_id)?.count)
      : 0
  };

  if (!products.length) {
    return {
      summary,
      projects: [],
      generatedAt: nowIso()
    };
  }

  const productIds = products.map((item) => item.id);
  const placeholders = makeSqlPlaceholders(productIds.length);
  const now = nowIso();

  const policyCounts = buildMetricMap(many(
    db,
    `
      SELECT product_id, COUNT(*) AS count
      FROM policies
      WHERE product_id IN (${placeholders})
      GROUP BY product_id
    `,
    ...productIds
  ));
  const freshCardCounts = buildMetricMap(many(
    db,
    `
      SELECT product_id, COUNT(*) AS count
      FROM license_keys
      WHERE product_id IN (${placeholders}) AND status = 'fresh'
      GROUP BY product_id
    `,
    ...productIds
  ));
  const redeemedCardCounts = buildMetricMap(many(
    db,
    `
      SELECT product_id, COUNT(*) AS count
      FROM license_keys
      WHERE product_id IN (${placeholders}) AND status = 'redeemed'
      GROUP BY product_id
    `,
    ...productIds
  ));
  const accountCounts = buildMetricMap(many(
    db,
    `
      SELECT product_id, COUNT(*) AS count
      FROM customer_accounts
      WHERE product_id IN (${placeholders})
      GROUP BY product_id
    `,
    ...productIds
  ));
  const disabledAccountCounts = buildMetricMap(many(
    db,
    `
      SELECT product_id, COUNT(*) AS count
      FROM customer_accounts
      WHERE product_id IN (${placeholders}) AND status = 'disabled'
      GROUP BY product_id
    `,
    ...productIds
  ));
  const activeEntitlementCounts = buildMetricMap(many(
    db,
    `
      SELECT product_id, COUNT(*) AS count
      FROM entitlements
      WHERE product_id IN (${placeholders}) AND status = 'active' AND ends_at > ?
      GROUP BY product_id
    `,
    ...productIds,
    now
  ));
  const activeSessionCounts = buildMetricMap(many(
    db,
    `
      SELECT product_id, COUNT(*) AS count
      FROM sessions
      WHERE product_id IN (${placeholders}) AND status = 'active'
      GROUP BY product_id
    `,
    ...productIds
  ));
  const activeBindingCounts = buildMetricMap(many(
    db,
    `
      SELECT e.product_id, COUNT(*) AS count
      FROM device_bindings b
      JOIN entitlements e ON e.id = b.entitlement_id
      WHERE e.product_id IN (${placeholders}) AND b.status = 'active'
      GROUP BY e.product_id
    `,
    ...productIds
  ));
  const blockedDeviceCounts = buildMetricMap(many(
    db,
    `
      SELECT product_id, COUNT(*) AS count
      FROM device_blocks
      WHERE product_id IN (${placeholders}) AND status = 'active'
      GROUP BY product_id
    `,
    ...productIds
  ));
  const activeClientVersionCounts = buildMetricMap(many(
    db,
    `
      SELECT product_id, COUNT(*) AS count
      FROM client_versions
      WHERE product_id IN (${placeholders}) AND status = 'active'
      GROUP BY product_id
    `,
    ...productIds
  ));
  const forceUpdateVersionCounts = buildMetricMap(many(
    db,
    `
      SELECT product_id, COUNT(*) AS count
      FROM client_versions
      WHERE product_id IN (${placeholders}) AND status = 'active' AND force_update = 1
      GROUP BY product_id
    `,
    ...productIds
  ));
  const activeNoticeCounts = buildMetricMap(many(
    db,
    `
      SELECT product_id, COUNT(*) AS count
      FROM notices
      WHERE product_id IN (${placeholders}) AND status = 'active'
      GROUP BY product_id
    `,
    ...productIds
  ));
  const blockingNoticeCounts = buildMetricMap(many(
    db,
    `
      SELECT product_id, COUNT(*) AS count
      FROM notices
      WHERE product_id IN (${placeholders}) AND status = 'active' AND block_login = 1
      GROUP BY product_id
    `,
    ...productIds
  ));
  const activeNetworkRuleCounts = buildMetricMap(many(
    db,
    `
      SELECT product_id, COUNT(*) AS count
      FROM network_rules
      WHERE product_id IN (${placeholders}) AND status = 'active'
      GROUP BY product_id
    `,
    ...productIds
  ));

  const projectSummaries = products.map((product) => {
    const key = String(product.id);
    const metrics = {
      policies: policyCounts.get(key) ?? 0,
      cardsFresh: freshCardCounts.get(key) ?? 0,
      cardsRedeemed: redeemedCardCounts.get(key) ?? 0,
      accounts: accountCounts.get(key) ?? 0,
      disabledAccounts: disabledAccountCounts.get(key) ?? 0,
      activeEntitlements: activeEntitlementCounts.get(key) ?? 0,
      activeSessions: activeSessionCounts.get(key) ?? 0,
      activeBindings: activeBindingCounts.get(key) ?? 0,
      blockedDevices: blockedDeviceCounts.get(key) ?? 0,
      activeClientVersions: activeClientVersionCounts.get(key) ?? 0,
      forceUpdateVersions: forceUpdateVersionCounts.get(key) ?? 0,
      activeNotices: activeNoticeCounts.get(key) ?? 0,
      blockingNotices: blockingNoticeCounts.get(key) ?? 0,
      activeNetworkRules: activeNetworkRuleCounts.get(key) ?? 0
    };

    summary.policies += metrics.policies;
    summary.cardsFresh += metrics.cardsFresh;
    summary.cardsRedeemed += metrics.cardsRedeemed;
    summary.accounts += metrics.accounts;
    summary.disabledAccounts += metrics.disabledAccounts;
    summary.activeEntitlements += metrics.activeEntitlements;
    summary.activeSessions += metrics.activeSessions;
    summary.activeBindings += metrics.activeBindings;
    summary.blockedDevices += metrics.blockedDevices;
    summary.activeClientVersions += metrics.activeClientVersions;
    summary.forceUpdateVersions += metrics.forceUpdateVersions;
    summary.activeNotices += metrics.activeNotices;
    summary.blockingNotices += metrics.blockingNotices;
    summary.activeNetworkRules += metrics.activeNetworkRules;

    return {
      id: product.id,
      code: product.code,
      name: product.name,
      status: product.status,
      updatedAt: product.updatedAt,
      featureConfig: product.featureConfig || {},
      metrics
    };
  });

  return {
    summary,
    projects: projectSummaries.sort((left, right) => {
      if (right.metrics.activeSessions !== left.metrics.activeSessions) {
        return right.metrics.activeSessions - left.metrics.activeSessions;
      }
      if (right.metrics.cardsRedeemed !== left.metrics.cardsRedeemed) {
        return right.metrics.cardsRedeemed - left.metrics.cardsRedeemed;
      }
      return String(left.code).localeCompare(String(right.code));
    }),
    generatedAt: nowIso()
  };
}

function ensureDeveloperCanAccessProduct(db, session, product, permission, code, message) {
  const ownerDeveloperId = product?.owner_developer_id ?? product?.ownerDeveloperId ?? product?.ownerDeveloper?.id ?? null;
  const productId = product?.id ?? null;

  if (!product || ownerDeveloperId !== session.developer_id) {
    throw new AppError(403, code, message);
  }

  requireDeveloperPermission(session, permission, code, message);

  if (session.actor_scope === "member") {
    const access = one(
      db,
      "SELECT id FROM developer_member_products WHERE member_id = ? AND product_id = ?",
      session.member_id,
      productId
    );
    if (!access) {
      throw new AppError(403, code, message);
    }
  }

  return product;
}

function resolveDeveloperAccessibleProductByCode(db, session, productCode, permission, code, message) {
  const product = requireProductByCode(db, productCode);
  return ensureDeveloperCanAccessProduct(db, session, product, permission, code, message);
}

function queryDeveloperMemberRows(db, developerId) {
  const members = many(
    db,
    `
      SELECT *
      FROM developer_members
      WHERE developer_id = ?
      ORDER BY created_at DESC
    `,
    developerId
  );

  if (!members.length) {
    return [];
  }

  const accessRows = many(
    db,
    `
      SELECT dmp.member_id, dmp.product_id, dmp.created_at,
             p.code AS product_code, p.name AS product_name
      FROM developer_member_products dmp
      JOIN developer_members dm ON dm.id = dmp.member_id
      JOIN products p ON p.id = dmp.product_id
      WHERE dm.developer_id = ?
      ORDER BY p.created_at DESC
    `,
    developerId
  );

  const accessMap = new Map();
  for (const row of accessRows) {
    const items = accessMap.get(row.member_id) ?? [];
    items.push({
      productId: row.product_id,
      productCode: row.product_code,
      productName: row.product_name,
      assignedAt: row.created_at
    });
    accessMap.set(row.member_id, items);
  }

  return members.map((row) => formatDeveloperMemberRow(row, accessMap.get(row.id) ?? []));
}

function syncDeveloperMemberProductAccess(db, developerId, memberId, productIds = [], timestamp = nowIso()) {
  const normalizedIds = Array.from(
    new Set(
      (Array.isArray(productIds) ? productIds : [])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    )
  );

  if (normalizedIds.length) {
    const rows = many(
      db,
      `
        SELECT id
        FROM products
        WHERE owner_developer_id = ?
          AND id IN (${makeSqlPlaceholders(normalizedIds.length)})
      `,
      developerId,
      ...normalizedIds
    );

    if (rows.length !== normalizedIds.length) {
      throw new AppError(403, "DEVELOPER_PRODUCT_FORBIDDEN", "You can only assign member access to your own projects.");
    }
  }

  const existingRows = many(
    db,
    "SELECT id, product_id FROM developer_member_products WHERE member_id = ?",
    memberId
  );
  const existingMap = new Map(existingRows.map((row) => [row.product_id, row]));

  for (const row of existingRows) {
    if (!normalizedIds.includes(row.product_id)) {
      run(db, "DELETE FROM developer_member_products WHERE id = ?", row.id);
    }
  }

  for (const productId of normalizedIds) {
    const existing = existingMap.get(productId);
    if (existing) {
      run(
        db,
        "UPDATE developer_member_products SET updated_at = ? WHERE id = ?",
        timestamp,
        existing.id
      );
      continue;
    }

    run(
      db,
      `
        INSERT INTO developer_member_products (id, member_id, product_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      generateId("devmap"),
      memberId,
      productId,
      timestamp,
      timestamp
    );
  }
}

function resolveDeveloperOwnedProductIdsInput(db, developerId, body = {}) {
  const productIds = Array.isArray(body.productIds) ? body.productIds : [];
  const productCodes = Array.isArray(body.productCodes)
    ? body.productCodes
    : Array.isArray(body.projectCodes)
      ? body.projectCodes
      : Array.isArray(body.softwareCodes)
        ? body.softwareCodes
        : [];

  if (
    body.productIds === undefined
    && body.productCodes === undefined
    && body.projectCodes === undefined
    && body.softwareCodes === undefined
  ) {
    return null;
  }

  const normalizedIds = productIds
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  const normalizedCodes = productCodes
    .map((value) => String(value ?? "").trim().toUpperCase())
    .filter(Boolean);

  const resolved = new Set(normalizedIds);
  for (const productCode of normalizedCodes) {
    const productId = findOwnedProductIdByCode(db, developerId, productCode);
    if (!productId) {
      throw new AppError(403, "DEVELOPER_PRODUCT_FORBIDDEN", "You can only assign member access to your own projects.");
    }
    resolved.add(productId);
  }

  return [...resolved];
}

function assertDeveloperUsernameAvailable(db, username, conflictCode = "DEVELOPER_EXISTS") {
  if (one(db, "SELECT id FROM developer_accounts WHERE username = ?", username)) {
    throw new AppError(409, conflictCode, "Developer username already exists.");
  }
  if (one(db, "SELECT id FROM developer_members WHERE username = ?", username)) {
    throw new AppError(409, conflictCode, "Developer username already exists.");
  }
}

function requireProductByCode(db, code) {
  const product = getActiveProductRecordByCode(db, code);
  if (!product) {
    throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist or is inactive.");
  }
  return product;
}


function safeParseJsonObject(value, fallback = {}) {
  if (!value) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeOptionalText(value, maxLength = 256) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value)
    .trim()
    .slice(0, maxLength);
}

function normalizeOptionalIsoDate(value, fieldName) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(400, "INVALID_DATE", `${fieldName} must be a valid ISO-8601 date string.`);
  }

  return parsed.toISOString();
}

function parseOptionalBoolean(value, fieldName) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new AppError(400, "INVALID_BOOLEAN", `${fieldName} must be a boolean value.`);
}

function extractProductFeatureConfigInput(body = {}) {
  if (
    body &&
    typeof body === "object" &&
    body.featureConfig &&
    typeof body.featureConfig === "object" &&
    !Array.isArray(body.featureConfig)
  ) {
    return body.featureConfig;
  }
  return body ?? {};
}

function loadProductFeatureConfig(db, productId, fallbackUpdatedAt = null) {
  const row = one(db, "SELECT * FROM product_feature_configs WHERE product_id = ?", productId);
  return parseProductFeatureConfigRow(row, fallbackUpdatedAt);
}

function persistProductFeatureConfig(db, productId, body = {}, timestamp = nowIso()) {
  const source = extractProductFeatureConfigInput(body);
  const config = {
    allowRegister: parseOptionalBoolean(source.allowRegister, "allowRegister"),
    allowAccountLogin: parseOptionalBoolean(source.allowAccountLogin, "allowAccountLogin"),
    allowCardLogin: parseOptionalBoolean(source.allowCardLogin, "allowCardLogin"),
    allowCardRecharge: parseOptionalBoolean(source.allowCardRecharge, "allowCardRecharge"),
    allowVersionCheck: parseOptionalBoolean(source.allowVersionCheck, "allowVersionCheck"),
    allowNotices: parseOptionalBoolean(source.allowNotices, "allowNotices"),
    allowClientUnbind: parseOptionalBoolean(source.allowClientUnbind, "allowClientUnbind")
  };

  const existing = one(db, "SELECT * FROM product_feature_configs WHERE product_id = ?", productId);
  const current = existing
    ? parseProductFeatureConfigRow(existing, timestamp)
    : DEFAULT_PRODUCT_FEATURE_CONFIG;
  const resolved = {
    allowRegister: config.allowRegister ?? current.allowRegister,
    allowAccountLogin: config.allowAccountLogin ?? current.allowAccountLogin,
    allowCardLogin: config.allowCardLogin ?? current.allowCardLogin,
    allowCardRecharge: config.allowCardRecharge ?? current.allowCardRecharge,
    allowVersionCheck: config.allowVersionCheck ?? current.allowVersionCheck,
    allowNotices: config.allowNotices ?? current.allowNotices,
    allowClientUnbind: config.allowClientUnbind ?? current.allowClientUnbind
  };

  if (existing) {
    run(
      db,
      `
        UPDATE product_feature_configs
        SET allow_register = ?, allow_account_login = ?, allow_card_login = ?, allow_card_recharge = ?,
            allow_version_check = ?, allow_notices = ?, allow_client_unbind = ?, updated_at = ?
        WHERE product_id = ?
      `,
      resolved.allowRegister ? 1 : 0,
      resolved.allowAccountLogin ? 1 : 0,
      resolved.allowCardLogin ? 1 : 0,
      resolved.allowCardRecharge ? 1 : 0,
      resolved.allowVersionCheck ? 1 : 0,
      resolved.allowNotices ? 1 : 0,
      resolved.allowClientUnbind ? 1 : 0,
      timestamp,
      productId
    );
  } else {
    run(
      db,
      `
        INSERT INTO product_feature_configs
        (
          product_id,
          allow_register,
          allow_account_login,
          allow_card_login,
          allow_card_recharge,
          allow_version_check,
          allow_notices,
          allow_client_unbind,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      productId,
      resolved.allowRegister ? 1 : 0,
      resolved.allowAccountLogin ? 1 : 0,
      resolved.allowCardLogin ? 1 : 0,
      resolved.allowCardRecharge ? 1 : 0,
      resolved.allowVersionCheck ? 1 : 0,
      resolved.allowNotices ? 1 : 0,
      resolved.allowClientUnbind ? 1 : 0,
      timestamp,
      timestamp
    );
  }

  return {
    ...resolved,
    createdAt: existing?.created_at ?? timestamp,
    updatedAt: timestamp
  };
}

function resolveProductOwnerDeveloperId(db, ownerDeveloperId, allowNull = true) {
  const normalizedId = String(ownerDeveloperId ?? "").trim();
  if (!normalizedId) {
    if (allowNull) {
      return null;
    }
    throw new AppError(400, "OWNER_DEVELOPER_REQUIRED", "ownerDeveloperId is required.");
  }

  const developer = one(
    db,
    "SELECT * FROM developer_accounts WHERE id = ?",
    normalizedId
  );
  if (!developer) {
    throw new AppError(404, "DEVELOPER_NOT_FOUND", "Developer account does not exist.");
  }
  if (developer.status !== "active") {
    throw new AppError(409, "DEVELOPER_DISABLED", "Developer account is disabled.");
  }
  return developer.id;
}

function createProductRecord(db, body = {}, ownerDeveloperId = null) {
  requireField(body, "code");
  requireField(body, "name");

  const code = String(body.code).trim().toUpperCase();
  if (!/^[A-Z0-9_]{3,32}$/.test(code)) {
    throw new AppError(400, "INVALID_PRODUCT_CODE", "Product code must be 3-32 chars: A-Z, 0-9 or underscore.");
  }

  if (productCodeExists(db, code)) {
    throw new AppError(409, "PRODUCT_EXISTS", "Product code already exists.");
  }

  const now = nowIso();
  const product = {
    id: generateId("prod"),
    code,
    name: String(body.name).trim(),
    description: String(body.description ?? "").trim(),
    status: "active",
    ownerDeveloperId,
    sdkAppId: randomAppId(),
    sdkAppSecret: randomToken(24),
    createdAt: now,
    updatedAt: now
  };

  run(
    db,
    `
      INSERT INTO products
      (id, code, name, description, status, owner_developer_id, sdk_app_id, sdk_app_secret, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    product.id,
    product.code,
    product.name,
    product.description,
    product.status,
    product.ownerDeveloperId,
    product.sdkAppId,
    product.sdkAppSecret,
    product.createdAt,
    product.updatedAt
  );
  persistProductFeatureConfig(db, product.id, body, now);

  return getProductRowById(db, product.id);
}

function updateProductOwnerRecord(db, productId, ownerDeveloperId, timestamp = nowIso()) {
  run(
    db,
    `
      UPDATE products
      SET owner_developer_id = ?, updated_at = ?
      WHERE id = ?
    `,
    ownerDeveloperId,
    timestamp,
    productId
  );
  return getProductRowById(db, productId);
}

function updateProductFeatureConfigRecord(db, productId, body = {}, timestamp = nowIso()) {
  const product = getProductRecordById(db, productId);
  if (!product) {
    throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
  }

  const featureConfig = persistProductFeatureConfig(db, product.id, body, timestamp);
  run(db, "UPDATE products SET updated_at = ? WHERE id = ?", timestamp, product.id);

  return {
    product: getProductRowById(db, product.id),
    featureConfig
  };
}

function rotateProductSdkCredentialsRecord(db, productId, body = {}, timestamp = nowIso()) {
  const product = getProductRecordById(db, productId);
  if (!product) {
    throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
  }

  const rotateAppId = parseOptionalBoolean(body.rotateAppId, "rotateAppId") === true;
  const nextSdkAppId = rotateAppId ? randomAppId() : product.sdk_app_id;
  const nextSdkAppSecret = randomToken(24);

  run(
    db,
    `
      UPDATE products
      SET sdk_app_id = ?, sdk_app_secret = ?, updated_at = ?
      WHERE id = ?
    `,
    nextSdkAppId,
    nextSdkAppSecret,
    timestamp,
    product.id
  );

  return {
    product: getProductRowById(db, product.id),
    rotated: {
      rotateAppId,
      previousSdkAppId: product.sdk_app_id,
      previousSdkAppSecretMasked: maskToken(product.sdk_app_secret),
      sdkAppId: nextSdkAppId,
      sdkAppSecret: nextSdkAppSecret,
      updatedAt: timestamp
    }
  };
}

function requireDeveloperOwnedProduct(db, session, productId, permission = "products.read") {
  const product = getProductRowById(db, productId);
  if (!product) {
    throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
  }
  return ensureDeveloperCanAccessProduct(
    db,
    session,
    {
      ...product,
      owner_developer_id: product.ownerDeveloperId ?? product.ownerDeveloper?.id ?? null
    },
    permission,
    "DEVELOPER_PRODUCT_FORBIDDEN",
    "You can only manage products owned by your developer account."
  );
}

function requireDeveloperOwnedProductByCode(db, session, productCode, permission = "products.read") {
  return resolveDeveloperAccessibleProductByCode(
    db,
    session,
    productCode,
    permission,
    "DEVELOPER_PRODUCT_FORBIDDEN",
    "You can only manage products owned by your developer account."
  );
}

function requireDeveloperOwnedPolicy(db, session, policyId, permission = "policies.read") {
  const row = getPolicyAccessRowById(db, policyId);

  if (!row) {
    throw new AppError(404, "POLICY_NOT_FOUND", "Policy does not exist.");
  }
  ensureDeveloperCanAccessProduct(
    db,
    session,
    { id: row.product_id, owner_developer_id: row.owner_developer_id },
    permission,
    "DEVELOPER_POLICY_FORBIDDEN",
    "You can only manage policies under your own projects."
  );

  return row;
}

function requireDeveloperOwnedCard(db, session, cardId, permission = "cards.read") {
  const row = one(
    db,
    `
      SELECT lk.id, lk.card_key, lk.status, lk.product_id, lk.redeemed_by_account_id,
             pr.code AS product_code, pr.name AS product_name, pr.owner_developer_id,
             pol.name AS policy_name
      FROM license_keys lk
      JOIN products pr ON pr.id = lk.product_id
      JOIN policies pol ON pol.id = lk.policy_id
      WHERE lk.id = ?
    `,
    cardId
  );

  if (!row) {
    throw new AppError(404, "CARD_NOT_FOUND", "Card key does not exist.");
  }
  ensureDeveloperCanAccessProduct(
    db,
    session,
    { id: row.product_id, owner_developer_id: row.owner_developer_id },
    permission,
    "DEVELOPER_CARD_FORBIDDEN",
    "You can only manage card keys under your own projects."
  );

  return row;
}

function requireDeveloperOwnedClientVersion(db, session, versionId, permission = "versions.read") {
  const row = one(
    db,
    `
      SELECT v.*, pr.code AS product_code, pr.owner_developer_id
      FROM client_versions v
      JOIN products pr ON pr.id = v.product_id
      WHERE v.id = ?
    `,
    versionId
  );

  if (!row) {
    throw new AppError(404, "CLIENT_VERSION_NOT_FOUND", "Client version does not exist.");
  }
  ensureDeveloperCanAccessProduct(
    db,
    session,
    { id: row.product_id, owner_developer_id: row.owner_developer_id },
    permission,
    "DEVELOPER_CLIENT_VERSION_FORBIDDEN",
    "You can only manage client versions under your own projects."
  );

  return row;
}

function requireDeveloperOwnedNotice(db, session, noticeId, permission = "notices.read") {
  const row = one(
    db,
    `
      SELECT n.*, pr.code AS product_code, pr.owner_developer_id
      FROM notices n
      LEFT JOIN products pr ON pr.id = n.product_id
      WHERE n.id = ?
    `,
    noticeId
  );

  if (!row) {
    throw new AppError(404, "NOTICE_NOT_FOUND", "Notice does not exist.");
  }
  if (!row.product_id) {
    throw new AppError(403, "DEVELOPER_NOTICE_FORBIDDEN", "You can only manage notices under your own projects.");
  }
  ensureDeveloperCanAccessProduct(
    db,
    session,
    { id: row.product_id, owner_developer_id: row.owner_developer_id },
    permission,
    "DEVELOPER_NOTICE_FORBIDDEN",
    "You can only manage notices under your own projects."
  );

  return row;
}

function requireProductFeatureEnabled(db, product, featureKey, code, message, status = 403) {
  const featureConfig = loadProductFeatureConfig(db, product.id, product.updated_at ?? null);
  if (featureConfig[featureKey] !== false) {
    return featureConfig;
  }

  throw new AppError(status, code, message, {
    productCode: product.code,
    featureKey
  });
}

function buildDisabledVersionManifest(product, clientVersion, channel = "stable") {
  return {
    productCode: product.code,
    channel: normalizeChannel(channel),
    clientVersion: clientVersion ?? null,
    enabled: false,
    allowed: true,
    status: "disabled_by_product",
    message: "Version check is disabled for this product.",
    latestVersion: null,
    minimumAllowedVersion: null,
    latestDownloadUrl: null,
    notice: null,
    versions: []
  };
}

function buildDisabledNoticeManifest(product, channel = "stable") {
  return {
    productCode: product.code,
    channel: normalizeNoticeChannel(channel, "stable"),
    enabled: false,
    status: "disabled_by_product",
    message: "Client notices are disabled for this product.",
    notices: []
  };
}

function normalizeNonNegativeInteger(value, fieldName, defaultValue = 0, maxValue = 36500) {
  const resolved = value === undefined || value === null || String(value).trim() === ""
    ? defaultValue
    : Number(value);

  if (!Number.isInteger(resolved) || resolved < 0 || resolved > maxValue) {
    throw new AppError(
      400,
      "INVALID_INTEGER",
      `${fieldName} must be an integer between 0 and ${maxValue}.`
    );
  }

  return resolved;
}

function normalizeBindFieldValue(field, value) {
  if (field === "requestIp" || field === "publicIp" || field === "localIp") {
    return normalizeIpAddress(value);
  }

  return normalizeOptionalText(value, 256).toLowerCase();
}

function loadPolicyBindConfig(db, policyId, fallbackBindMode = "strict", fallbackUpdatedAt = null) {
  const row = one(db, "SELECT * FROM policy_bind_configs WHERE policy_id = ?", policyId);
  return parsePolicyBindConfigRow(row, fallbackBindMode, fallbackUpdatedAt);
}

function persistPolicyBindConfig(db, policyId, bindMode, bindFields, timestamp) {
  const existing = one(db, "SELECT policy_id FROM policy_bind_configs WHERE policy_id = ?", policyId);
  const bindFieldsJson = JSON.stringify(parseBindFieldsInput(bindFields, bindMode));

  if (existing) {
    run(
      db,
      `
        UPDATE policy_bind_configs
        SET bind_mode = ?, bind_fields_json = ?, updated_at = ?
        WHERE policy_id = ?
      `,
      bindMode,
      bindFieldsJson,
      timestamp,
      policyId
    );
    return;
  }

  run(
    db,
    `
      INSERT INTO policy_bind_configs (policy_id, bind_mode, bind_fields_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `,
    policyId,
    bindMode,
    bindFieldsJson,
    timestamp,
    timestamp
  );
}


function loadPolicyUnbindConfig(db, policyId, fallbackUpdatedAt = null) {
  const row = one(db, "SELECT * FROM policy_unbind_configs WHERE policy_id = ?", policyId);
  return parsePolicyUnbindConfigRow(row, fallbackUpdatedAt);
}

function persistPolicyUnbindConfig(db, policyId, body = {}, timestamp) {
  const allowClientUnbind = parseOptionalBoolean(body.allowClientUnbind, "allowClientUnbind");
  const config = {
    allowClientUnbind: allowClientUnbind === null ? false : allowClientUnbind,
    clientUnbindLimit: normalizeNonNegativeInteger(body.clientUnbindLimit, "clientUnbindLimit", 0, 1000),
    clientUnbindWindowDays: Math.max(
      1,
      normalizeNonNegativeInteger(body.clientUnbindWindowDays, "clientUnbindWindowDays", 30, 3650)
    ),
    clientUnbindDeductDays: normalizeNonNegativeInteger(
      body.clientUnbindDeductDays,
      "clientUnbindDeductDays",
      0,
      3650
    )
  };

  const existing = one(db, "SELECT policy_id FROM policy_unbind_configs WHERE policy_id = ?", policyId);
  if (existing) {
    run(
      db,
      `
        UPDATE policy_unbind_configs
        SET allow_client_unbind = ?, client_unbind_limit = ?, client_unbind_window_days = ?,
            client_unbind_deduct_days = ?, updated_at = ?
        WHERE policy_id = ?
      `,
      config.allowClientUnbind ? 1 : 0,
      config.clientUnbindLimit,
      config.clientUnbindWindowDays,
      config.clientUnbindDeductDays,
      timestamp,
      policyId
    );
  } else {
    run(
      db,
      `
        INSERT INTO policy_unbind_configs
        (policy_id, allow_client_unbind, client_unbind_limit, client_unbind_window_days,
         client_unbind_deduct_days, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      policyId,
      config.allowClientUnbind ? 1 : 0,
      config.clientUnbindLimit,
      config.clientUnbindWindowDays,
      config.clientUnbindDeductDays,
      timestamp,
      timestamp
    );
  }

  return {
    ...config,
    updatedAt: timestamp,
    createdAt: timestamp
  };
}

function loadPolicyGrantConfig(db, policyId, fallbackUpdatedAt = null) {
  const row = one(db, "SELECT * FROM policy_grant_configs WHERE policy_id = ?", policyId);
  return parsePolicyGrantConfigRow(row, fallbackUpdatedAt);
}

function persistPolicyGrantConfig(db, policyId, body = {}, timestamp) {
  const config = {
    grantType: normalizeGrantType(body.grantType ?? "duration"),
    grantPoints: normalizeNonNegativeInteger(body.grantPoints, "grantPoints", 0, 1000000)
  };

  if (config.grantType === "points" && config.grantPoints < 1) {
    throw new AppError(400, "INVALID_GRANT_POINTS", "grantPoints must be at least 1 for points policies.");
  }

  const existing = one(db, "SELECT policy_id FROM policy_grant_configs WHERE policy_id = ?", policyId);
  if (existing) {
    run(
      db,
      `
        UPDATE policy_grant_configs
        SET grant_type = ?, grant_points = ?, updated_at = ?
        WHERE policy_id = ?
      `,
      config.grantType,
      config.grantPoints,
      timestamp,
      policyId
    );
  } else {
    run(
      db,
      `
        INSERT INTO policy_grant_configs (policy_id, grant_type, grant_points, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      policyId,
      config.grantType,
      config.grantPoints,
      timestamp,
      timestamp
    );
  }

  return {
    ...config,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function extractClientDeviceProfile(body, meta = {}) {
  const rawProfile =
    body.deviceProfile && typeof body.deviceProfile === "object" && !Array.isArray(body.deviceProfile)
      ? body.deviceProfile
      : {};

  return {
    deviceFingerprint: normalizeOptionalText(body.deviceFingerprint || rawProfile.deviceFingerprint),
    deviceName: normalizeOptionalText(body.deviceName || rawProfile.deviceName || "Client Device"),
    machineCode: normalizeOptionalText(rawProfile.machineCode),
    machineGuid: normalizeOptionalText(rawProfile.machineGuid),
    cpuId: normalizeOptionalText(rawProfile.cpuId),
    diskSerial: normalizeOptionalText(rawProfile.diskSerial),
    boardSerial: normalizeOptionalText(rawProfile.boardSerial),
    biosSerial: normalizeOptionalText(rawProfile.biosSerial),
    macAddress: normalizeOptionalText(rawProfile.macAddress),
    installationId: normalizeOptionalText(rawProfile.installationId),
    requestIp: normalizeIpAddress(meta.ip),
    publicIp: normalizeIpAddress(rawProfile.publicIp),
    localIp: normalizeIpAddress(rawProfile.localIp)
  };
}

function compactDeviceProfile(profile = {}) {
  return Object.fromEntries(
    Object.entries(profile).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

function buildBindingIdentity(bindConfig, deviceProfile) {
  const fields = parseBindFieldsInput(bindConfig.bindFields, bindConfig.bindMode);
  const identity = {};
  const missingFields = [];

  for (const field of fields) {
    const normalizedValue = normalizeBindFieldValue(field, deviceProfile[field]);
    if (!normalizedValue) {
      missingFields.push(field);
      continue;
    }
    identity[field] = normalizedValue;
  }

  if (missingFields.length) {
    throw new AppError(
      400,
      "BIND_CONTEXT_INCOMPLETE",
      `Client is missing bind fields required by policy: ${missingFields.join(", ")}.`,
      {
        bindMode: bindConfig.bindMode,
        bindFields: fields,
        missingFields
      }
    );
  }

  const orderedIdentity = Object.fromEntries(
    Object.entries(identity).sort(([left], [right]) => left.localeCompare(right))
  );

  return {
    bindMode: bindConfig.bindMode,
    bindFields: fields,
    identity: orderedIdentity,
    identityHash: sha256Hex(JSON.stringify(orderedIdentity)),
    requestIp: deviceProfile.requestIp || null
  };
}

function maskToken(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= 8) {
    return `${normalized.slice(0, 2)}...${normalized.slice(-2)}`;
  }
  return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}

function buildCardsCsv(items = []) {
  const header = [
    "cardId",
    "productCode",
    "policyName",
    "batchCode",
    "cardKey",
    "usageStatus",
    "displayStatus",
    "controlStatus",
    "expiresAt",
    "issuedAt",
    "redeemedAt",
    "redeemedUsername",
    "entitlementStatus",
    "entitlementEndsAt",
    "resellerCode"
  ];
  const lines = [header.map(toCsvCell).join(",")];
  for (const item of items) {
    lines.push([
      item.id,
      item.productCode,
      item.policyName,
      item.batchCode,
      item.cardKey,
      item.usageStatus,
      item.displayStatus,
      item.controlStatus,
      item.expiresAt ?? "",
      item.issuedAt,
      item.redeemedAt ?? "",
      item.redeemedUsername ?? "",
      item.entitlementLifecycleStatus ?? "",
      item.entitlementEndsAt ?? "",
      item.resellerCode ?? ""
    ].map(toCsvCell).join(","));
  }
  return `\uFEFF${lines.join("\n")}`;
}

function upsertLicenseKeyControl(db, licenseKeyId, payload = {}, timestamp = nowIso()) {
  const status = normalizeCardControlStatus(payload.status ?? "active");
  const expiresAt = normalizeOptionalIsoDate(payload.expiresAt, "expiresAt");
  const notes = normalizeOptionalText(payload.notes, 1000) || null;
  const existing = one(db, "SELECT license_key_id FROM license_key_controls WHERE license_key_id = ?", licenseKeyId);

  if (existing) {
    run(
      db,
      `
        UPDATE license_key_controls
        SET status = ?, expires_at = ?, notes = ?, updated_at = ?
        WHERE license_key_id = ?
      `,
      status,
      expiresAt,
      notes,
      timestamp,
      licenseKeyId
    );
  } else {
    run(
      db,
      `
        INSERT INTO license_key_controls (license_key_id, status, expires_at, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      licenseKeyId,
      status,
      expiresAt,
      notes,
      timestamp,
      timestamp
    );
  }

  return describeLicenseKeyControl({ status, expires_at: expiresAt, notes }, timestamp);
}

function ensureCardControlAvailable(controlState) {
  if (controlState.available) {
    return;
  }

  if (controlState.effectiveStatus === "expired") {
    throw new AppError(403, "CARD_EXPIRED", "This card key has expired.");
  }
  if (controlState.status === "frozen") {
    throw new AppError(403, "CARD_FROZEN", "This card key has been frozen by the operator.");
  }
  if (controlState.status === "revoked") {
    throw new AppError(403, "CARD_REVOKED", "This card key has been revoked by the operator.");
  }
}

function defaultPointsEntitlementEndsAt(referenceTime = nowIso()) {
  return addDays(referenceTime, 36500);
}

function throwEntitlementUnavailable(snapshot, referenceTime = nowIso()) {
  if (!snapshot) {
    throw new AppError(403, "LICENSE_INACTIVE", "No active subscription window is available for this account.");
  }

  if (snapshot.ends_at <= referenceTime) {
    throw new AppError(403, "LICENSE_EXPIRED", "This authorization has already expired.");
  }

  if (snapshot.status === "frozen") {
    throw new AppError(403, "LICENSE_FROZEN", "This authorization has been frozen by the operator.", {
      entitlementId: snapshot.id,
      endsAt: snapshot.ends_at
    });
  }

  if ((snapshot.grant_type ?? "duration") === "points" && Number(snapshot.remaining_points ?? 0) <= 0) {
    throw new AppError(403, "LICENSE_POINTS_EXHAUSTED", "This authorization has no remaining points.", {
      entitlementId: snapshot.id,
      totalPoints: Number(snapshot.total_points ?? 0),
      remainingPoints: Number(snapshot.remaining_points ?? 0),
      consumedPoints: Number(snapshot.consumed_points ?? 0)
    });
  }

  const control = describeLicenseKeyControl({
    status: snapshot.card_control_status,
    expires_at: snapshot.card_expires_at
  }, referenceTime);
  ensureCardControlAvailable(control);

  throw new AppError(403, "LICENSE_INACTIVE", "No active subscription window is available for this account.");
}

function releaseBindingRecord(db, stateStore, binding, reason, timestamp = nowIso()) {
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

  return expireActiveSessions(
    db,
    stateStore,
    "entitlement_id = ? AND device_id = ?",
    [binding.entitlement_id, binding.device_id],
    reason
  );
}

function countRecentClientUnbinds(db, entitlementId, windowDays) {
  const since = addDays(nowIso(), -Math.max(1, windowDays));
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
}

function recordEntitlementUnbind(db, entitlementId, bindingId, actorType, actorId, reason, deductedDays, timestamp = nowIso()) {
  run(
    db,
    `
      INSERT INTO entitlement_unbind_logs
      (id, entitlement_id, binding_id, actor_type, actor_id, reason, deducted_days, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    generateId("unbind"),
    entitlementId,
    bindingId,
    actorType,
    actorId,
    reason,
    deductedDays,
    timestamp
  );
}

function queryBindingsForEntitlement(db, entitlementId) {
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
  ).map((row) => ({
    id: row.id,
    entitlementId: row.entitlement_id,
    deviceId: row.device_id,
    status: row.status,
    firstBoundAt: row.first_bound_at,
    lastBoundAt: row.last_bound_at,
    revokedAt: row.revoked_at ?? null,
    fingerprint: row.fingerprint,
    deviceName: row.device_name ?? null,
    lastSeenAt: row.last_seen_at ?? null,
    lastSeenIp: row.last_seen_ip ?? null,
    matchFields: row.match_fields_json ? JSON.parse(row.match_fields_json) : [],
    identity: row.identity_json ? JSON.parse(row.identity_json) : {},
    bindRequestIp: row.request_ip ?? null,
    activeSessionCount: Number(row.active_session_count ?? 0)
  }));
}

function resolveClientManagedAccount(db, product, body) {
  if (body.username !== undefined || body.password !== undefined) {
    requireField(body, "username");
    requireField(body, "password");
    const account = one(
      db,
      `
        SELECT *
        FROM customer_accounts
        WHERE product_id = ? AND username = ? AND status = 'active'
      `,
      product.id,
      String(body.username).trim()
    );

    if (!account || !verifyPassword(String(body.password), account.password_hash)) {
      throw new AppError(401, "ACCOUNT_LOGIN_FAILED", "Username or password is incorrect.");
    }

    const entitlement = getUsableEntitlement(db, account.id, product.id, nowIso());
    if (!entitlement) {
      throwEntitlementUnavailable(getLatestEntitlementSnapshot(db, account.id, product.id));
    }

    return {
      authMode: "account",
      account,
      entitlement,
      tokenSubject: account.username
    };
  }

  if (body.cardKey !== undefined) {
    const card = findClientCardByKey(db, product.id, body.cardKey);
    if (!card || !["fresh", "redeemed"].includes(card.status)) {
      throw new AppError(404, "CARD_NOT_AVAILABLE", "Card key is invalid, already redeemed, or revoked.");
    }

    ensureCardControlAvailable(describeLicenseKeyControl({
      status: card.control_status,
      expires_at: card.expires_at
    }));

    if (card.status === "redeemed" && !card.card_login_account_id) {
      throw new AppError(
        409,
        "CARD_BOUND_TO_ACCOUNT",
        "This card key has already been recharged to an account and cannot be used for direct card management.",
        {
          redeemedUsername: card.redeemed_username ?? null
        }
      );
    }

    let account = null;
    if (card.card_login_account_id) {
      account = one(db, "SELECT * FROM customer_accounts WHERE id = ?", card.card_login_account_id);
      if (!account || account.status !== "active") {
        throw new AppError(403, "CARD_LOGIN_DISABLED", "This card-login identity has been disabled.");
      }
    } else {
      account = createCardLoginAccount(db, product, card);
      activateFreshCardEntitlement(db, product, account, card, "card.direct_redeem", {
        authMode: "card"
      });
    }

    const entitlement = getUsableEntitlement(db, account.id, product.id, nowIso());
    if (!entitlement) {
      throwEntitlementUnavailable(getLatestEntitlementSnapshot(db, account.id, product.id));
    }

    return {
      authMode: "card",
      account,
      entitlement,
      card,
      tokenSubject: account.username
    };
  }

  throw new AppError(400, "CLIENT_AUTH_REQUIRED", "Provide username/password or cardKey for this action.");
}

function queryAccountRows(db, filters = {}, runtimeState = null) {
  expireStaleSessions(db, runtimeState);

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

  appendInCondition("pr.id", filters.productIds, conditions, params);

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
             pr.id AS product_id, pr.code AS product_code, pr.name AS product_name,
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
}

function queryDeviceBindingRows(db, filters = {}, runtimeState = null) {
  expireStaleSessions(db, runtimeState);

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

  appendInCondition("pr.id", filters.productIds, conditions, params);

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
    items: items.map((row) => ({
      ...row,
      matchFields: row.match_fields_json ? JSON.parse(row.match_fields_json) : [],
      identity: row.identity_json ? JSON.parse(row.identity_json) : {},
      bindRequestIp: row.bind_request_ip ?? null
    })),
    total: items.length,
    filters: normalizedFilters
  };
}

function queryDeviceBlockRows(db, filters = {}) {
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

  appendInCondition("pr.id", filters.productIds, conditions, params);

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
}

function querySessionRows(db, filters = {}, runtimeState = null) {
  expireStaleSessions(db, runtimeState);

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

  appendInCondition("pr.id", filters.productIds, conditions, params);

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
             pr.id AS product_id, pr.code AS product_code, pr.name AS product_name,
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
}

function queryAuditLogRows(db, filters = {}) {
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

  if (filters.developerId || (Array.isArray(filters.productCodes) && filters.productCodes.length)) {
    const scopedConditions = [];
    if (filters.developerId) {
      scopedConditions.push("metadata_json LIKE ?");
      params.push(`%\"developerId\":\"${String(filters.developerId).trim()}\"%`);
    }
    const productCodes = Array.isArray(filters.productCodes)
      ? Array.from(new Set(filters.productCodes.map((value) => String(value ?? "").trim().toUpperCase()).filter(Boolean)))
      : [];
    if (productCodes.length) {
      const productPredicates = productCodes.map(() => "metadata_json LIKE ?").join(" OR ");
      scopedConditions.push(`(${productPredicates})`);
      for (const productCode of productCodes) {
        params.push(`%\"productCode\":\"${productCode}\"%`);
      }
    }
    if (scopedConditions.length) {
      conditions.push(`(${scopedConditions.join(" OR ")})`);
    }
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
}

function queryNetworkRuleRows(db, filters = {}) {
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

  appendInCondition("pr.id", filters.productIds, conditions, params);

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
}

function normalizePointAdjustMode(value = "add") {
  const mode = String(value ?? "add").trim().toLowerCase();
  if (!["add", "subtract", "set"].includes(mode)) {
    throw new AppError(400, "INVALID_POINT_ADJUST_MODE", "mode must be add, subtract, or set.");
  }
  return mode;
}

function findClientCardByKey(db, productId, cardKey) {
  return one(
    db,
    `
      SELECT lk.*, p.duration_days, p.name AS policy_name,
             pgc.grant_type, pgc.grant_points,
             lkc.status AS control_status, lkc.expires_at, lkc.notes AS control_notes,
             cla.account_id AS card_login_account_id,
             cla.created_at AS card_login_created_at,
             card_account.username AS card_login_username,
             card_account.status AS card_login_account_status,
             redeemed_account.username AS redeemed_username
      FROM license_keys lk
      JOIN policies p ON p.id = lk.policy_id
      LEFT JOIN policy_grant_configs pgc ON pgc.policy_id = p.id
      LEFT JOIN license_key_controls lkc ON lkc.license_key_id = lk.id
      LEFT JOIN card_login_accounts cla ON cla.license_key_id = lk.id
      LEFT JOIN customer_accounts card_account ON card_account.id = cla.account_id
      LEFT JOIN customer_accounts redeemed_account ON redeemed_account.id = lk.redeemed_by_account_id
      WHERE lk.product_id = ? AND lk.card_key = ?
    `,
    productId,
    String(cardKey).trim().toUpperCase()
  );
}

function createCardLoginAccount(db, product, card, timestamp = nowIso()) {
  const accountId = generateId("acct");
  const productCode = String(product.code)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8) || "product";
  const cardTail = String(card.card_key ?? card.id)
    .trim()
    .replace(/[^A-Z0-9]/gi, "")
    .slice(-6)
    .toLowerCase() || accountId.slice(-6).toLowerCase();
  const username = `card_${productCode}_${cardTail}_${accountId.slice(-4).toLowerCase()}`;

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
    hashPassword(randomToken(32)),
    timestamp,
    timestamp
  );

  run(
    db,
    `
      INSERT INTO card_login_accounts (license_key_id, account_id, product_id, created_at)
      VALUES (?, ?, ?, ?)
    `,
    card.id,
    accountId,
    product.id,
    timestamp
  );

  audit(db, "license_key", card.id, "card.direct_account_create", "account", accountId, {
    productCode: product.code,
    username,
    cardKeyMasked: maskCardKey(card.card_key)
  });

  return one(db, "SELECT * FROM customer_accounts WHERE id = ?", accountId);
}

function upsertBindingProfile(db, binding, device, bindingIdentity) {
  const timestamp = nowIso();
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

function upsertDevice(db, productId, fingerprint, deviceName, meta, deviceProfile = {}) {
  const existing = one(
    db,
    "SELECT * FROM devices WHERE product_id = ? AND fingerprint = ?",
    productId,
    fingerprint
  );

  const timestamp = nowIso();
  const previousMetadata = existing ? safeParseJsonObject(existing.metadata_json) : {};
  const metadataJson = JSON.stringify({
    ...previousMetadata,
    userAgent: meta.userAgent,
    requestIp: normalizeIpAddress(meta.ip),
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
      meta.ip,
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
    meta.ip,
    metadataJson
  );
  return one(db, "SELECT * FROM devices WHERE id = ?", deviceId);
}

function bindDeviceToEntitlement(db, stateStore, entitlement, device, bindingIdentity) {
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
    const binding = one(db, "SELECT * FROM device_bindings WHERE id = ?", existing.id);
    upsertBindingProfile(db, binding, device, bindingIdentity);
    return {
      binding,
      mode: "exact_active",
      releasedSessions: 0
    };
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
    const binding = one(db, "SELECT * FROM device_bindings WHERE id = ?", existing.id);
    upsertBindingProfile(db, binding, device, bindingIdentity);
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
    const timestamp = nowIso();
    let releasedSessions = 0;

    if (profileMatch.status === "active" && profileMatch.device_id !== device.id) {
      releasedSessions = expireActiveSessions(
        db,
        stateStore,
        "entitlement_id = ? AND device_id = ?",
        [entitlement.id, profileMatch.device_id],
        "binding_rebound"
      );
    }

    run(
      db,
      `
        UPDATE device_bindings
        SET device_id = ?, status = 'active', revoked_at = NULL, last_bound_at = ?
        WHERE id = ?
      `,
      device.id,
      timestamp,
      profileMatch.id
    );

    const binding = one(db, "SELECT * FROM device_bindings WHERE id = ?", profileMatch.id);
    upsertBindingProfile(db, binding, device, bindingIdentity);
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

  if (activeCount.count >= entitlement.max_devices) {
    throw new AppError(
      409,
      "DEVICE_LIMIT_REACHED",
      `This license plan allows at most ${entitlement.max_devices} bound device(s).`,
      {
        bindMode: bindingIdentity.bindMode,
        bindFields: bindingIdentity.bindFields
      }
    );
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
  const binding = one(db, "SELECT * FROM device_bindings WHERE id = ?", bindingId);
  upsertBindingProfile(db, binding, device, bindingIdentity);
  return {
    binding,
    mode: "new_binding",
    releasedSessions: 0
  };
}

function expireStaleSessions(db, stateStore) {
  const rows = many(
    db,
    `
      SELECT s.id, s.session_token, s.expires_at, s.last_heartbeat_at, p.heartbeat_timeout_seconds
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
      const reason = expiresAt <= now ? "token_expired" : "heartbeat_timeout";
      run(db, "UPDATE sessions SET status = 'expired', revoked_reason = ? WHERE id = ?", reason, row.id);
      stateStore?.expireSession(row.session_token, reason, { sessionId: row.id });
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

function normalizeResellerUsername(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
}

function createResellerRelation(db, resellerId, parentResellerId = null, canViewDescendants = true, timestamp = nowIso()) {
  run(
    db,
    `
      INSERT INTO reseller_relations
      (reseller_id, parent_reseller_id, can_view_descendants, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `,
    resellerId,
    parentResellerId,
    canViewDescendants ? 1 : 0,
    timestamp,
    timestamp
  );
}

function createResellerUserRecord(db, resellerId, username, password, timestamp = nowIso()) {
  const normalizedUsername = normalizeResellerUsername(username);
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(normalizedUsername)) {
    throw new AppError(
      400,
      "INVALID_RESELLER_USERNAME",
      "Reseller username must be 3-32 chars and use letters, digits, dot, underscore, or dash."
    );
  }

  const rawPassword = String(password ?? "");
  if (rawPassword.length < 8) {
    throw new AppError(400, "INVALID_RESELLER_PASSWORD", "Reseller password must be at least 8 characters.");
  }

  if (one(db, "SELECT id FROM reseller_users WHERE username = ?", normalizedUsername)) {
    throw new AppError(409, "RESELLER_USER_EXISTS", "Reseller username already exists.");
  }

  const userId = generateId("ruser");
  run(
    db,
    `
      INSERT INTO reseller_users
      (id, reseller_id, username, password_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `,
    userId,
    resellerId,
    normalizedUsername,
    hashPassword(rawPassword),
    timestamp,
    timestamp
  );

  return {
    id: userId,
    resellerId,
    username: normalizedUsername,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function requireResellerSession(db, token) {
  if (!token) {
    throw new AppError(401, "RESELLER_AUTH_REQUIRED", "Missing reseller bearer token.");
  }

  const session = one(
    db,
    `
      SELECT rs.*, ru.username, ru.status AS user_status,
             r.code AS reseller_code, r.name AS reseller_name, r.status AS reseller_status,
             rr.parent_reseller_id, rr.can_view_descendants
      FROM reseller_sessions rs
      JOIN reseller_users ru ON ru.id = rs.reseller_user_id
      JOIN resellers r ON r.id = rs.reseller_id
      LEFT JOIN reseller_relations rr ON rr.reseller_id = r.id
      WHERE rs.token = ? AND rs.expires_at > ?
    `,
    token,
    nowIso()
  );

  if (!session || session.user_status !== "active" || session.reseller_status !== "active") {
    throw new AppError(401, "RESELLER_AUTH_INVALID", "Reseller session is invalid or expired.");
  }

  run(db, "UPDATE reseller_sessions SET last_seen_at = ? WHERE id = ?", nowIso(), session.id);
  return session;
}

function resellerDescendantMap(db) {
  const rows = many(
    db,
    `
      SELECT reseller_id, parent_reseller_id
      FROM reseller_relations
    `
  );

  const children = new Map();
  for (const row of rows) {
    const key = row.parent_reseller_id ?? "__root__";
    const bucket = children.get(key) ?? [];
    bucket.push(row.reseller_id);
    children.set(key, bucket);
  }

  return children;
}

function collectDescendantResellerIds(db, resellerId) {
  const children = resellerDescendantMap(db);
  const results = [];
  const queue = [...(children.get(resellerId) ?? [])];

  while (queue.length) {
    const current = queue.shift();
    results.push(current);
    for (const childId of children.get(current) ?? []) {
      queue.push(childId);
    }
  }

  return results;
}

function directChildResellerIds(db, resellerId) {
  return many(
    db,
    "SELECT reseller_id FROM reseller_relations WHERE parent_reseller_id = ? ORDER BY reseller_id ASC",
    resellerId
  ).map((row) => row.reseller_id);
}

function isDescendantReseller(db, ancestorResellerId, targetResellerId, allowSelf = false) {
  if (allowSelf && ancestorResellerId === targetResellerId) {
    return true;
  }
  return collectDescendantResellerIds(db, ancestorResellerId).includes(targetResellerId);
}

function scopedResellerIds(db, resellerId, includeDescendants = false) {
  return includeDescendants
    ? [resellerId, ...collectDescendantResellerIds(db, resellerId)]
    : [resellerId];
}

function formatResellerListRow(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    contactName: row.contact_name ?? null,
    contactEmail: row.contact_email ?? null,
    status: row.status,
    notes: row.notes ?? null,
    parentResellerId: row.parent_reseller_id ?? null,
    allowViewDescendants: Boolean(row.can_view_descendants ?? 1),
    totalAllocated: Number(row.total_allocated ?? 0),
    freshKeys: Number(row.fresh_keys ?? 0),
    redeemedKeys: Number(row.redeemed_keys ?? 0),
    userCount: Number(row.user_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
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

function upsertEntitlementMetering(db, entitlementId, grantType, totalPoints, remainingPoints, consumedPoints, timestamp = nowIso()) {
  const existing = one(db, "SELECT entitlement_id FROM entitlement_metering WHERE entitlement_id = ?", entitlementId);
  if (existing) {
    run(
      db,
      `
        UPDATE entitlement_metering
        SET grant_type = ?, total_points = ?, remaining_points = ?, consumed_points = ?, updated_at = ?
        WHERE entitlement_id = ?
      `,
      grantType,
      totalPoints,
      remainingPoints,
      consumedPoints,
      timestamp,
      entitlementId
    );
  } else {
    run(
      db,
      `
        INSERT INTO entitlement_metering
        (entitlement_id, grant_type, total_points, remaining_points, consumed_points, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      entitlementId,
      grantType,
      totalPoints,
      remainingPoints,
      consumedPoints,
      timestamp,
      timestamp
    );
  }
}

function activateFreshCardEntitlement(db, product, account, card, eventType = "card.redeem", metadata = {}) {
  const now = nowIso();
  const grantType = normalizeGrantType(card.grant_type ?? "duration");
  let startsAt = now;
  let endsAt = defaultPointsEntitlementEndsAt(now);
  let totalPoints = null;
  let remainingPoints = null;

  if (grantType === "duration") {
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
    startsAt = latest && latest.ends_at > now ? latest.ends_at : now;
    endsAt = addDays(startsAt, card.duration_days);
  } else {
    totalPoints = Number(card.grant_points ?? 0);
    remainingPoints = totalPoints;
    if (remainingPoints <= 0) {
      throw new AppError(400, "INVALID_GRANT_POINTS", "Point-based policy must grant at least 1 point.");
    }
  }

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

  if (grantType === "points") {
    upsertEntitlementMetering(db, entitlementId, "points", totalPoints, remainingPoints, 0, now);
  }

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

  audit(db, "account", account.id, eventType, "license_key", card.id, {
    cardKey: card.card_key,
    cardKeyMasked: maskCardKey(card.card_key),
    policyName: card.policy_name,
    grantType,
    grantPoints: totalPoints,
    resellerCode: resellerAllocation?.reseller_code ?? null,
    resellerName: resellerAllocation?.reseller_name ?? null,
    startsAt,
    endsAt,
    ...metadata
  });

  return {
    entitlementId,
    policyName: card.policy_name,
    grantType,
    totalPoints,
    remainingPoints,
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
}

function expireSessionsForEntitlement(db, stateStore, entitlementId, reason) {
  return expireActiveSessions(
    db,
    stateStore,
    "entitlement_id = ?",
    [entitlementId],
    reason
  );
}

function expireSessionsForLicenseKey(db, stateStore, licenseKeyId, reason) {
  const entitlement = one(
    db,
    "SELECT id FROM entitlements WHERE source_license_key_id = ?",
    licenseKeyId
  );

  if (!entitlement) {
    return 0;
  }

  return expireSessionsForEntitlement(db, stateStore, entitlement.id, reason);
}

function issueClientSession(
  db,
  config,
  stateStore,
  {
    product,
    account,
    entitlement,
    deviceProfile,
    meta,
    authMode = "account",
    tokenSubject,
    bindConfig = null
  }
) {
  const resolvedDeviceProfile = extractClientDeviceProfile(
    {
      deviceFingerprint: deviceProfile.deviceFingerprint,
      deviceName: deviceProfile.deviceName,
      deviceProfile
    },
    meta
  );
  const resolvedBindConfig = bindConfig ?? loadPolicyBindConfig(db, entitlement.policy_id, entitlement.bind_mode);
  const bindingIdentity = buildBindingIdentity(resolvedBindConfig, resolvedDeviceProfile);
  const device = upsertDevice(
    db,
    product.id,
    resolvedDeviceProfile.deviceFingerprint,
    resolvedDeviceProfile.deviceName,
    meta,
    resolvedDeviceProfile
  );
  const bindingResult = bindDeviceToEntitlement(db, stateStore, entitlement, device, bindingIdentity);

  if (!entitlement.allow_concurrent_sessions) {
    expireActiveSessions(
      db,
      stateStore,
      "account_id = ? AND product_id = ?",
      [account.id, product.id],
      "single_session_policy"
    );
  }

  let quota = null;
  if ((entitlement.grant_type ?? "duration") === "points") {
    const metering = one(
      db,
      "SELECT * FROM entitlement_metering WHERE entitlement_id = ?",
      entitlement.id
    );
    if (!metering || Number(metering.remaining_points ?? 0) <= 0) {
      throw new AppError(403, "LICENSE_POINTS_EXHAUSTED", "This authorization has no remaining points.", {
        entitlementId: entitlement.id,
        totalPoints: Number(metering?.total_points ?? 0),
        remainingPoints: Number(metering?.remaining_points ?? 0),
        consumedPoints: Number(metering?.consumed_points ?? 0)
      });
    }

    const nextRemaining = Number(metering.remaining_points) - 1;
    const nextConsumed = Number(metering.consumed_points ?? 0) + 1;
    upsertEntitlementMetering(
      db,
      entitlement.id,
      "points",
      Number(metering.total_points ?? 0),
      nextRemaining,
      nextConsumed,
      nowIso()
    );
    quota = {
      grantType: "points",
      totalPoints: Number(metering.total_points ?? 0),
      remainingPoints: nextRemaining,
      consumedPoints: nextConsumed,
      consumedThisLogin: 1
    };
  } else {
    quota = {
      grantType: "duration",
      totalPoints: null,
      remainingPoints: null,
      consumedPoints: null,
      consumedThisLogin: 0
    };
  }

  const issuedAt = nowIso();
  const expiresAt = addSeconds(issuedAt, entitlement.token_ttl_seconds);
  const sessionId = generateId("sess");
  const sessionToken = randomToken(32);
  const licenseToken = issueLicenseToken(config.licenseKeys, {
    sid: sessionId,
    pid: product.code,
    sub: tokenSubject ?? account.username,
    did: device.fingerprint,
    plan: entitlement.policy_name,
    am: authMode,
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
    deviceFingerprint: device.fingerprint,
    authMode,
    bindingMode: bindingResult.mode
  });

  return {
    sessionId,
    sessionToken,
    licenseToken,
    expiresAt,
    authMode,
    binding: {
      id: bindingResult.binding.id,
      mode: bindingResult.mode,
      matchFields: bindingIdentity.bindFields,
      releasedSessions: bindingResult.releasedSessions
    },
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
    },
    quota,
    account: {
      id: account.id,
      username: account.username
    },
    runtime: {
      session: {
        sessionId,
        sessionToken,
        productId: product.id,
        accountId: account.id,
        entitlementId: entitlement.id,
        deviceId: device.id,
        status: "active",
        issuedAt,
        expiresAt,
        lastHeartbeatAt: issuedAt,
        lastSeenIp: meta.ip,
        userAgent: meta.userAgent
      },
      claimSingleOwner: !entitlement.allow_concurrent_sessions
    }
  };
}

function normalizeResellerInventoryFilters(filters = {}) {
  return {
    resellerId: filters.resellerId ? String(filters.resellerId).trim() : null,
    productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
    currency: filters.currency ? normalizeCurrency(filters.currency) : null,
    cardStatus: filters.cardStatus ? String(filters.cardStatus).trim().toLowerCase() : null,
    search: filters.search ? String(filters.search).trim() : null
  };
}

function queryResellerInventoryRows(db, filters = {}, options = {}) {
  const normalizedFilters = normalizeResellerInventoryFilters(filters);
  const conditions = ["ri.status = 'active'"];
  const params = [];
  const scopeResellerIds = Array.isArray(options.scopeResellerIds) && options.scopeResellerIds.length
    ? [...new Set(options.scopeResellerIds.map((value) => String(value).trim()).filter(Boolean))]
    : null;

  if (scopeResellerIds?.length) {
    conditions.push(`r.id IN (${scopeResellerIds.map(() => "?").join(", ")})`);
    params.push(...scopeResellerIds);
  }

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

function parseMoneyToCents(value, fieldName) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new AppError(400, "INVALID_MONEY_AMOUNT", `${fieldName} must be a non-negative number.`);
  }
  return Math.round(amount * 100);
}

function centsToAmount(cents) {
  return Number((Number(cents ?? 0) / 100).toFixed(2));
}

function normalizeCurrency(value) {
  const currency = String(value ?? "CNY").trim().toUpperCase();
  if (!/^[A-Z]{3,8}$/.test(currency)) {
    throw new AppError(400, "INVALID_CURRENCY", "Currency must be 3-8 uppercase letters.");
  }
  return currency;
}

function formatResellerPriceRuleRow(row) {
  const unitPriceCents = Number(row.unit_price_cents ?? 0);
  const unitCostCents = Number(row.unit_cost_cents ?? 0);
  const unitCommissionCents = unitPriceCents - unitCostCents;

  return {
    id: row.id,
    resellerId: row.reseller_id,
    resellerCode: row.reseller_code,
    resellerName: row.reseller_name,
    productCode: row.product_code,
    productName: row.product_name,
    policyId: row.policy_id ?? null,
    policyName: row.policy_name ?? null,
    status: row.status,
    currency: row.currency,
    unitPriceCents,
    unitPrice: centsToAmount(unitPriceCents),
    unitCostCents,
    unitCost: centsToAmount(unitCostCents),
    unitCommissionCents,
    unitCommission: centsToAmount(unitCommissionCents),
    notes: row.notes ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeResellerPriceRuleFilters(filters = {}) {
  return {
    resellerId: filters.resellerId ? String(filters.resellerId).trim() : null,
    productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
    status: filters.status ? String(filters.status).trim().toLowerCase() : null,
    search: filters.search ? String(filters.search).trim() : null
  };
}

function resolveResellerPriceRule(db, resellerId, productId, policyId) {
  return one(
    db,
    `
      SELECT rpr.*, rs.code AS reseller_code, rs.name AS reseller_name,
             pr.code AS product_code, pr.name AS product_name,
             pol.name AS policy_name
      FROM reseller_price_rules rpr
      JOIN resellers rs ON rs.id = rpr.reseller_id
      JOIN products pr ON pr.id = rpr.product_id
      LEFT JOIN policies pol ON pol.id = rpr.policy_id
      WHERE rpr.reseller_id = ?
        AND rpr.product_id = ?
        AND rpr.status = 'active'
        AND (rpr.policy_id = ? OR rpr.policy_id IS NULL)
      ORDER BY CASE WHEN rpr.policy_id = ? THEN 0 ELSE 1 END, rpr.updated_at DESC
      LIMIT 1
    `,
    resellerId,
    productId,
    policyId,
    policyId
  );
}

function queryResellerPriceRuleRows(db, filters = {}) {
  const normalizedFilters = normalizeResellerPriceRuleFilters(filters);
  const conditions = [];
  const params = [];

  if (normalizedFilters.resellerId) {
    conditions.push("rpr.reseller_id = ?");
    params.push(normalizedFilters.resellerId);
  }

  if (normalizedFilters.productCode) {
    conditions.push("pr.code = ?");
    params.push(normalizedFilters.productCode);
  }

  if (normalizedFilters.status) {
    if (!["active", "archived"].includes(normalizedFilters.status)) {
      throw new AppError(400, "INVALID_PRICE_RULE_STATUS", "Price rule status must be active or archived.");
    }
    conditions.push("rpr.status = ?");
    params.push(normalizedFilters.status);
  }

  if (normalizedFilters.search) {
    const pattern = likeFilter(normalizedFilters.search);
    conditions.push(
      "(rs.code LIKE ? ESCAPE '\\' OR pr.code LIKE ? ESCAPE '\\' OR COALESCE(pol.name, '') LIKE ? ESCAPE '\\')"
    );
    params.push(pattern, pattern, pattern);
  }

  const items = many(
    db,
    `
      SELECT rpr.*, rs.code AS reseller_code, rs.name AS reseller_name,
             pr.code AS product_code, pr.name AS product_name,
             pol.name AS policy_name
      FROM reseller_price_rules rpr
      JOIN resellers rs ON rs.id = rpr.reseller_id
      JOIN products pr ON pr.id = rpr.product_id
      LEFT JOIN policies pol ON pol.id = rpr.policy_id
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY rpr.updated_at DESC, rpr.created_at DESC
      LIMIT 200
    `,
    ...params
  ).map(formatResellerPriceRuleRow);

  return {
    items,
    filters: normalizedFilters
  };
}

function queryResellerSettlementRows(db, filters = {}, options = {}) {
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

  if (normalizedFilters.currency) {
    conditions.push("rss.currency = ?");
    params.push(normalizedFilters.currency);
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
      SELECT ri.id AS reseller_inventory_id, ri.allocation_batch_code, ri.allocated_at, ri.notes,
             r.id AS reseller_id, r.code AS reseller_code, r.name AS reseller_name, r.status AS reseller_status,
             pr.code AS product_code, pr.name AS product_name,
             pol.id AS policy_id, pol.name AS policy_name,
             lk.id AS license_key_id, lk.card_key, lk.status AS card_status, lk.issued_at, lk.redeemed_at,
             a.username AS redeemed_username,
             rss.id AS settlement_snapshot_id, rss.price_rule_id, rss.currency, rss.unit_price_cents,
             rss.unit_cost_cents, rss.commission_amount_cents, rss.priced_at
      FROM reseller_inventory ri
      JOIN resellers r ON r.id = ri.reseller_id
      JOIN products pr ON pr.id = ri.product_id
      JOIN policies pol ON pol.id = ri.policy_id
      JOIN license_keys lk ON lk.id = ri.license_key_id
      LEFT JOIN customer_accounts a ON a.id = lk.redeemed_by_account_id
      LEFT JOIN reseller_settlement_snapshots rss ON rss.reseller_inventory_id = ri.id
      WHERE ${conditions.join(" AND ")}
      ORDER BY ri.allocated_at DESC, lk.issued_at DESC
      ${limit}
    `,
    ...params
  ).map((row) => {
    const unitPriceCents = row.unit_price_cents === null || row.unit_price_cents === undefined
      ? null
      : Number(row.unit_price_cents);
    const unitCostCents = row.unit_cost_cents === null || row.unit_cost_cents === undefined
      ? null
      : Number(row.unit_cost_cents);
    const commissionAmountCents = row.commission_amount_cents === null || row.commission_amount_cents === undefined
      ? null
      : Number(row.commission_amount_cents);

    return {
      resellerInventoryId: row.reseller_inventory_id,
      allocationBatchCode: row.allocation_batch_code,
      allocatedAt: row.allocated_at,
      notes: row.notes ?? null,
      resellerId: row.reseller_id,
      resellerCode: row.reseller_code,
      resellerName: row.reseller_name,
      resellerStatus: row.reseller_status,
      productCode: row.product_code,
      productName: row.product_name,
      policyId: row.policy_id,
      policyName: row.policy_name,
      licenseKeyId: row.license_key_id,
      cardKey: row.card_key,
      cardStatus: row.card_status,
      issuedAt: row.issued_at,
      redeemedAt: row.redeemed_at,
      redeemedUsername: row.redeemed_username ?? null,
      settlementSnapshotId: row.settlement_snapshot_id ?? null,
      priceRuleId: row.price_rule_id ?? null,
      currency: row.currency ?? null,
      priced: Boolean(row.settlement_snapshot_id),
      unitPriceCents,
      unitPrice: unitPriceCents === null ? null : centsToAmount(unitPriceCents),
      unitCostCents,
      unitCost: unitCostCents === null ? null : centsToAmount(unitCostCents),
      commissionAmountCents,
      commissionAmount: commissionAmountCents === null ? null : centsToAmount(commissionAmountCents),
      pricedAt: row.priced_at ?? null
    };
  });

  return {
    items,
    filters: normalizedFilters
  };
}

function createEmptySettlementSummary() {
  return {
    totalKeys: 0,
    pricedKeys: 0,
    unpricedKeys: 0,
    redeemedKeys: 0,
    pricedRedeemedKeys: 0,
    grossAllocatedCents: 0,
    costAllocatedCents: 0,
    commissionAllocatedCents: 0,
    grossRedeemedCents: 0,
    costRedeemedCents: 0,
    commissionRedeemedCents: 0
  };
}

function summarizeResellerSettlement(items) {
  const totals = createEmptySettlementSummary();
  const currencyBuckets = new Map();

  for (const item of items) {
    totals.totalKeys += 1;
    if (item.cardStatus === "redeemed") {
      totals.redeemedKeys += 1;
    }

    if (!item.priced) {
      totals.unpricedKeys += 1;
      continue;
    }

    totals.pricedKeys += 1;
    totals.grossAllocatedCents += item.unitPriceCents;
    totals.costAllocatedCents += item.unitCostCents;
    totals.commissionAllocatedCents += item.commissionAmountCents;

    const bucket = currencyBuckets.get(item.currency) ?? {
      currency: item.currency,
      ...createEmptySettlementSummary()
    };

    bucket.totalKeys += 1;
    bucket.pricedKeys += 1;
    bucket.grossAllocatedCents += item.unitPriceCents;
    bucket.costAllocatedCents += item.unitCostCents;
    bucket.commissionAllocatedCents += item.commissionAmountCents;
    if (item.cardStatus === "redeemed") {
      bucket.redeemedKeys += 1;
      bucket.pricedRedeemedKeys += 1;
      bucket.grossRedeemedCents += item.unitPriceCents;
      bucket.costRedeemedCents += item.unitCostCents;
      bucket.commissionRedeemedCents += item.commissionAmountCents;

      totals.pricedRedeemedKeys += 1;
      totals.grossRedeemedCents += item.unitPriceCents;
      totals.costRedeemedCents += item.unitCostCents;
      totals.commissionRedeemedCents += item.commissionAmountCents;
    }

    currencyBuckets.set(item.currency, bucket);
  }

  return {
    totals: {
      ...totals,
      grossAllocated: centsToAmount(totals.grossAllocatedCents),
      costAllocated: centsToAmount(totals.costAllocatedCents),
      commissionAllocated: centsToAmount(totals.commissionAllocatedCents),
      grossRedeemed: centsToAmount(totals.grossRedeemedCents),
      costRedeemed: centsToAmount(totals.costRedeemedCents),
      commissionRedeemed: centsToAmount(totals.commissionRedeemedCents)
    },
    byCurrency: Array.from(currencyBuckets.values()).map((bucket) => ({
      ...bucket,
      grossAllocated: centsToAmount(bucket.grossAllocatedCents),
      costAllocated: centsToAmount(bucket.costAllocatedCents),
      commissionAllocated: centsToAmount(bucket.commissionAllocatedCents),
      grossRedeemed: centsToAmount(bucket.grossRedeemedCents),
      costRedeemed: centsToAmount(bucket.costRedeemedCents),
      commissionRedeemed: centsToAmount(bucket.commissionRedeemedCents)
    }))
  };
}

function normalizeStatementStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  if (!["draft", "reviewed", "paid"].includes(status)) {
    throw new AppError(400, "INVALID_STATEMENT_STATUS", "Statement status must be draft, reviewed, or paid.");
  }
  return status;
}

function normalizeResellerStatementFilters(filters = {}) {
  return {
    resellerId: filters.resellerId ? String(filters.resellerId).trim() : null,
    currency: filters.currency ? normalizeCurrency(filters.currency) : null,
    productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
    status: filters.status ? normalizeStatementStatus(filters.status) : null,
    search: filters.search ? String(filters.search).trim() : null
  };
}

function formatResellerStatementRow(row) {
  return {
    id: row.id,
    resellerId: row.reseller_id,
    resellerCode: row.reseller_code,
    resellerName: row.reseller_name,
    currency: row.currency,
    statementCode: row.statement_code,
    status: row.status,
    productCode: row.product_code ?? null,
    productName: row.product_name ?? null,
    periodStart: row.period_start ?? null,
    periodEnd: row.period_end ?? null,
    itemCount: Number(row.item_count ?? 0),
    grossAmountCents: Number(row.gross_amount_cents ?? 0),
    grossAmount: centsToAmount(row.gross_amount_cents),
    costAmountCents: Number(row.cost_amount_cents ?? 0),
    costAmount: centsToAmount(row.cost_amount_cents),
    commissionAmountCents: Number(row.commission_amount_cents ?? 0),
    commissionAmount: centsToAmount(row.commission_amount_cents),
    notes: row.notes ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paidAt: row.paid_at ?? null
  };
}

function queryResellerStatementRows(db, filters = {}) {
  const normalizedFilters = normalizeResellerStatementFilters(filters);
  const conditions = [];
  const params = [];

  if (normalizedFilters.resellerId) {
    conditions.push("rs.reseller_id = ?");
    params.push(normalizedFilters.resellerId);
  }

  if (normalizedFilters.currency) {
    conditions.push("rs.currency = ?");
    params.push(normalizedFilters.currency);
  }

  if (normalizedFilters.productCode) {
    conditions.push("pr.code = ?");
    params.push(normalizedFilters.productCode);
  }

  if (normalizedFilters.status) {
    conditions.push("rs.status = ?");
    params.push(normalizedFilters.status);
  }

  if (normalizedFilters.search) {
    const pattern = likeFilter(normalizedFilters.search);
    conditions.push(
      "(rs.statement_code LIKE ? ESCAPE '\\' OR rr.code LIKE ? ESCAPE '\\' OR COALESCE(pr.code, '') LIKE ? ESCAPE '\\')"
    );
    params.push(pattern, pattern, pattern);
  }

  const items = many(
    db,
    `
      SELECT rs.*, rr.code AS reseller_code, rr.name AS reseller_name,
             pr.code AS product_code, pr.name AS product_name
      FROM reseller_statements rs
      JOIN resellers rr ON rr.id = rs.reseller_id
      LEFT JOIN products pr ON pr.id = rs.product_id
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY rs.created_at DESC
      LIMIT 200
    `,
    ...params
  ).map(formatResellerStatementRow);

  return {
    items,
    filters: normalizedFilters
  };
}

function queryResellerStatementItems(db, statementId) {
  return many(
    db,
    `
      SELECT rsi.*, rs.statement_code, rs.status AS statement_status, rs.currency,
             rr.code AS reseller_code, rr.name AS reseller_name,
             pr.code AS product_code, pr.name AS product_name,
             pol.id AS policy_id, pol.name AS policy_name,
             lk.card_key, lk.status AS card_status,
             a.username AS redeemed_username
      FROM reseller_statement_items rsi
      JOIN reseller_statements rs ON rs.id = rsi.statement_id
      JOIN reseller_settlement_snapshots rss ON rss.id = rsi.settlement_snapshot_id
      JOIN resellers rr ON rr.id = rs.reseller_id
      LEFT JOIN products pr ON pr.id = rs.product_id
      JOIN reseller_inventory ri ON ri.id = rsi.reseller_inventory_id
      JOIN policies pol ON pol.id = ri.policy_id
      JOIN license_keys lk ON lk.id = rsi.license_key_id
      LEFT JOIN customer_accounts a ON a.id = lk.redeemed_by_account_id
      WHERE rsi.statement_id = ?
      ORDER BY rsi.redeemed_at DESC, rsi.created_at DESC
    `,
    statementId
  ).map((row) => ({
    id: row.id,
    statementId: row.statement_id,
    statementCode: row.statement_code,
    statementStatus: row.statement_status,
    resellerInventoryId: row.reseller_inventory_id,
    settlementSnapshotId: row.settlement_snapshot_id,
    licenseKeyId: row.license_key_id,
    resellerCode: row.reseller_code,
    resellerName: row.reseller_name,
    productCode: row.product_code ?? null,
    productName: row.product_name ?? null,
    policyId: row.policy_id,
    policyName: row.policy_name,
    cardKey: row.card_key,
    cardStatus: row.card_status,
    redeemedUsername: row.redeemed_username ?? null,
    currency: row.currency,
    redeemedAt: row.redeemed_at,
    grossAmountCents: Number(row.gross_amount_cents ?? 0),
    grossAmount: centsToAmount(row.gross_amount_cents),
    costAmountCents: Number(row.cost_amount_cents ?? 0),
    costAmount: centsToAmount(row.cost_amount_cents),
    commissionAmountCents: Number(row.commission_amount_cents ?? 0),
    commissionAmount: centsToAmount(row.commission_amount_cents),
    createdAt: row.created_at
  }));
}

function listEligibleResellerStatementSnapshots(db, filters = {}) {
  const resellerId = filters.resellerId ? String(filters.resellerId).trim() : null;
  const currency = filters.currency ? normalizeCurrency(filters.currency) : null;
  const productCode = filters.productCode ? String(filters.productCode).trim().toUpperCase() : null;
  const conditions = [
    "rss.currency IS NOT NULL",
    "lk.status = 'redeemed'",
    "lk.redeemed_at IS NOT NULL",
    "rsi.id IS NULL"
  ];
  const params = [];

  if (resellerId) {
    conditions.push("rr.id = ?");
    params.push(resellerId);
  }

  if (currency) {
    conditions.push("rss.currency = ?");
    params.push(currency);
  }

  if (productCode) {
    conditions.push("pr.code = ?");
    params.push(productCode);
  }

  const rows = many(
    db,
    `
      SELECT rss.*, rr.code AS reseller_code, rr.name AS reseller_name,
             pr.code AS product_code, pr.name AS product_name,
             pol.id AS policy_id, pol.name AS policy_name,
             lk.card_key, lk.redeemed_at, lk.id AS license_key_id
      FROM reseller_settlement_snapshots rss
      JOIN reseller_inventory ri ON ri.id = rss.reseller_inventory_id
      JOIN resellers rr ON rr.id = rss.reseller_id
      JOIN products pr ON pr.id = rss.product_id
      JOIN policies pol ON pol.id = rss.policy_id
      JOIN license_keys lk ON lk.id = rss.license_key_id
      LEFT JOIN reseller_statement_items rsi ON rsi.settlement_snapshot_id = rss.id
      WHERE ${conditions.join(" AND ")}
      ORDER BY lk.redeemed_at ASC, rss.created_at ASC
    `,
    ...params
  );

  return rows.map((row) => ({
    settlementSnapshotId: row.id,
    resellerInventoryId: row.reseller_inventory_id,
    resellerId: row.reseller_id,
    resellerCode: row.reseller_code,
    resellerName: row.reseller_name,
    productId: row.product_id,
    productCode: row.product_code,
    productName: row.product_name,
    policyId: row.policy_id,
    policyName: row.policy_name,
    licenseKeyId: row.license_key_id,
    cardKey: row.card_key,
    currency: row.currency,
    redeemedAt: row.redeemed_at,
    unitPriceCents: Number(row.unit_price_cents),
    unitCostCents: Number(row.unit_cost_cents),
    commissionAmountCents: Number(row.commission_amount_cents)
  }));
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

function queryClientVersionRows(db, filters = {}) {
  const conditions = [];
  const params = [];
  const normalizedFilters = {
    productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
    channel: normalizeOptionalChannel(filters.channel),
    status: filters.status ? String(filters.status).trim().toLowerCase() : null,
    search: filters.search ? String(filters.search).trim() : null,
    ownerDeveloperId: filters.ownerDeveloperId ? String(filters.ownerDeveloperId).trim() : null
  };

  if (normalizedFilters.productCode) {
    conditions.push("pr.code = ?");
    params.push(normalizedFilters.productCode);
  }

  if (normalizedFilters.ownerDeveloperId) {
    conditions.push("pr.owner_developer_id = ?");
    params.push(normalizedFilters.ownerDeveloperId);
  }
  appendInCondition("pr.id", filters.productIds, conditions, params);

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
    filters: {
      productCode: normalizedFilters.productCode,
      channel: normalizedFilters.channel,
      status: normalizedFilters.status,
      search: normalizedFilters.search
    }
  };
}

function queryNoticeRows(db, filters = {}) {
  const conditions = [];
  const params = [];
  const normalizedFilters = {
    productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
    channel: normalizeOptionalChannel(filters.channel) ?? "all",
    kind: filters.kind ? String(filters.kind).trim().toLowerCase() : null,
    status: filters.status ? String(filters.status).trim().toLowerCase() : null,
    search: filters.search ? String(filters.search).trim() : null,
    ownerDeveloperId: filters.ownerDeveloperId ? String(filters.ownerDeveloperId).trim() : null
  };

  if (normalizedFilters.productCode) {
    conditions.push("pr.code = ?");
    params.push(normalizedFilters.productCode);
  }

  if (normalizedFilters.ownerDeveloperId) {
    conditions.push("pr.owner_developer_id = ?");
    params.push(normalizedFilters.ownerDeveloperId);
  }
  appendInCondition("n.product_id", filters.productIds, conditions, params);

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
    filters: {
      productCode: normalizedFilters.productCode,
      channel: normalizedFilters.channel,
      kind: normalizedFilters.kind,
      status: normalizedFilters.status,
      search: normalizedFilters.search
    }
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

async function requireSignedProduct(db, config, stateStore, reqLike, rawBody) {
  const appId = reqLike.headers["x-rs-app-id"];
  const timestamp = reqLike.headers["x-rs-timestamp"];
  const nonce = reqLike.headers["x-rs-nonce"];
  const signature = reqLike.headers["x-rs-signature"];

  if (!appId || !timestamp || !nonce || !signature) {
    throw new AppError(401, "SDK_SIGNATURE_REQUIRED", "Missing signed SDK headers.");
  }

  const product = getActiveProductRecordBySdkAppId(db, appId);
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
    await stateStore.registerNonceOrThrow(
      appId,
      nonce,
      addSeconds(nowIso(), config.requestSkewSeconds)
    );
  } catch (error) {
    if (error instanceof NonceReplayError) {
      throw new AppError(409, "SDK_NONCE_REPLAY", "Nonce has already been used.");
    }
    throw error;
  }

  return product;
}

export function createServices(db, config, runtimeState = null, mainStore = null) {
  const store = mainStore ?? createSqliteMainStore({ db });
  const stateStore = runtimeState ?? {
    registerNonceOrThrow(appId, nonce, expiresAt) {
      run(db, "DELETE FROM request_nonces WHERE expires_at <= ?", nowIso());
      try {
        run(
          db,
          `
            INSERT INTO request_nonces (app_id, nonce, expires_at)
            VALUES (?, ?, ?)
          `,
          appId,
          nonce,
          expiresAt
        );
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
      const row = one(
        db,
        `
          SELECT status, revoked_reason, expires_at, last_heartbeat_at
          FROM sessions
          WHERE session_token = ?
        `,
        sessionToken
      );
      if (!row) {
        return null;
      }
      return {
        status: row.status ?? null,
        revokedReason: row.revoked_reason ?? null,
        expiresAt: row.expires_at ?? null,
        lastHeartbeatAt: row.last_heartbeat_at ?? null
      };
    },
    async countActiveSessions() {
      return Number(one(db, "SELECT COUNT(*) AS count FROM sessions WHERE status = 'active'")?.count ?? 0);
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

  return {
    async health() {
      expireStaleSessions(db, stateStore);
      const mainStoreHealth = await Promise.resolve(
        typeof store.health === "function"
          ? store.health()
          : {
              driver: store.driver,
              repositories: store.repositories
            }
      );
      return {
        status: "ok",
        time: nowIso(),
        env: config.env,
        storage: {
          database: {
            driver: "sqlite",
            location: config.dbPath,
            postgresUrlConfigured: Boolean(config.postgresUrl)
          },
          mainStore: mainStoreHealth,
          runtimeState: await stateStore.health()
        }
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

    developerLogin(body = {}) {
      requireField(body, "username");
      requireField(body, "password");

      const username = normalizeDeveloperUsername(body.username);
      const developer = one(
        db,
        "SELECT * FROM developer_accounts WHERE username = ?",
        username
      );
      if (developer && verifyPassword(String(body.password), developer.password_hash)) {
        if (developer.status !== "active") {
          throw new AppError(403, "DEVELOPER_LOGIN_DISABLED", "This developer account has been disabled.");
        }

        const now = nowIso();
        const token = randomToken(32);
        const expiresAt = addSeconds(now, config.developerSessionHours * 3600);
        run(
          db,
          `
            INSERT INTO developer_sessions (id, developer_id, token, expires_at, created_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `,
          generateId("devsess"),
          developer.id,
          token,
          expiresAt,
          now,
          now
        );
        run(
          db,
          "UPDATE developer_accounts SET last_login_at = ?, updated_at = ? WHERE id = ?",
          now,
          now,
          developer.id
        );

        audit(db, "developer", developer.id, "developer.login", "developer", developer.id, {
          username: developer.username
        });

        const developerProfile = formatDeveloperRow({
          ...developer,
          last_login_at: now,
          updated_at: now
        });

        return {
          token,
          expiresAt,
          developer: developerProfile,
          actor: {
            type: "owner",
            id: developer.id,
            username: developer.username,
            displayName: developer.display_name ?? "",
            role: "owner",
            permissions: developerRolePermissions("owner")
          }
        };
      }

      const member = one(
        db,
        `
          SELECT dm.*, da.username AS developer_username, da.display_name AS developer_display_name, da.status AS developer_status
          FROM developer_members dm
          JOIN developer_accounts da ON da.id = dm.developer_id
          WHERE dm.username = ?
        `,
        username
      );
      if (!member || !verifyPassword(String(body.password), member.password_hash)) {
        throw new AppError(401, "DEVELOPER_LOGIN_FAILED", "Username or password is incorrect.");
      }
      if (member.status !== "active" || member.developer_status !== "active") {
        throw new AppError(403, "DEVELOPER_MEMBER_LOGIN_DISABLED", "This developer member account has been disabled.");
      }

      const now = nowIso();
      const token = randomToken(32);
      const expiresAt = addSeconds(now, config.developerSessionHours * 3600);
      run(
        db,
        `
          INSERT INTO developer_member_sessions
          (id, member_id, developer_id, token, expires_at, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        generateId("devmsess"),
        member.id,
        member.developer_id,
        token,
        expiresAt,
        now,
        now
      );
      run(
        db,
        "UPDATE developer_members SET last_login_at = ?, updated_at = ? WHERE id = ?",
        now,
        now,
        member.id
      );

      audit(db, "developer_member", member.id, "developer-member.login", "developer_member", member.id, {
        developerId: member.developer_id,
        username: member.username,
        role: member.role
      });

      return {
        token,
        expiresAt,
        developer: {
          id: member.developer_id,
          username: member.developer_username,
          displayName: member.developer_display_name ?? "",
          status: member.developer_status
        },
        actor: {
          type: "member",
          id: member.id,
          username: member.username,
          displayName: member.display_name ?? "",
          role: normalizeDeveloperMemberRole(member.role),
          permissions: developerRolePermissions(member.role)
        },
        member: formatDeveloperMemberRow({
          ...member,
          last_login_at: now,
          updated_at: now
        })
      };
    },

    developerMe(token) {
      const session = requireDeveloperSession(db, token);
      return {
        developer: {
          id: session.developer_id,
          username: session.developer_username ?? session.username,
          displayName: session.developer_display_name ?? session.display_name ?? "",
          status: session.developer_status
        },
        actor: buildDeveloperActor(session),
        session: {
          id: session.id,
          expiresAt: session.expires_at
        }
      };
    },

    developerLogout(token) {
      const session = requireDeveloperSession(db, token);
      if (session.actor_scope === "member") {
        revokeDeveloperMemberSessions(db, "id = ?", [session.id]);
        auditDeveloperSession(db, session, "developer-member.logout", "developer_member", session.actor_id, {
          username: session.username
        });
      } else {
        revokeDeveloperSessions(db, "id = ?", [session.id]);
        auditDeveloperSession(db, session, "developer.logout", "developer", session.developer_id, {
          username: session.username
        });
      }

      return {
        status: "logged_out"
      };
    },

    developerChangePassword(token, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireField(body, "currentPassword");
      requireField(body, "newPassword");

      const newPassword = String(body.newPassword ?? "");
      if (newPassword.length < 8) {
        throw new AppError(400, "INVALID_DEVELOPER_PASSWORD", "Developer password must be at least 8 characters.");
      }

      const timestamp = nowIso();
      let revokedSessions = 0;
      if (session.actor_scope === "member") {
        const member = one(
          db,
          "SELECT * FROM developer_members WHERE id = ?",
          session.member_id
        );
        if (!member || member.status !== "active") {
          throw new AppError(401, "DEVELOPER_AUTH_INVALID", "Developer session is invalid or expired.");
        }
        if (!verifyPassword(String(body.currentPassword), member.password_hash)) {
          throw new AppError(401, "DEVELOPER_PASSWORD_INVALID", "Current password is incorrect.");
        }

        run(
          db,
          "UPDATE developer_members SET password_hash = ?, updated_at = ? WHERE id = ?",
          hashPassword(newPassword),
          timestamp,
          member.id
        );
        revokedSessions = revokeDeveloperMemberSessions(db, "member_id = ?", [member.id]);

        auditDeveloperSession(
          db,
          session,
          "developer-member.password.change",
          "developer_member",
          member.id,
          {
            username: member.username,
            revokedSessions
          }
        );
      } else {
        const developerAccount = one(
          db,
          "SELECT * FROM developer_accounts WHERE id = ?",
          session.developer_id
        );
        if (!developerAccount || developerAccount.status !== "active") {
          throw new AppError(401, "DEVELOPER_AUTH_INVALID", "Developer session is invalid or expired.");
        }
        if (!verifyPassword(String(body.currentPassword), developerAccount.password_hash)) {
          throw new AppError(401, "DEVELOPER_PASSWORD_INVALID", "Current password is incorrect.");
        }

        run(
          db,
          "UPDATE developer_accounts SET password_hash = ?, updated_at = ? WHERE id = ?",
          hashPassword(newPassword),
          timestamp,
          developerAccount.id
        );
        revokedSessions = revokeDeveloperSessions(db, "developer_id = ?", [developerAccount.id]);

        auditDeveloperSession(db, session, "developer.password.change", "developer", developerAccount.id, {
          username: developerAccount.username,
          revokedSessions
        });
      }

      return {
        status: "password_changed",
        revokedSessions
      };
    },

    developerUpdateProfile(token, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "profile.write",
        "DEVELOPER_PROFILE_FORBIDDEN",
        "This developer session cannot update its profile."
      );

      const timestamp = nowIso();
      const displayName = String(body.displayName ?? "").trim();

      if (session.actor_scope === "member") {
        run(
          db,
          "UPDATE developer_members SET display_name = ?, updated_at = ? WHERE id = ?",
          displayName || null,
          timestamp,
          session.member_id
        );
        const member = one(
          db,
          "SELECT * FROM developer_members WHERE id = ?",
          session.member_id
        );
        auditDeveloperSession(db, session, "developer-member.profile.update", "developer_member", session.member_id, {
          displayName: member?.display_name ?? ""
        });
        return {
          status: "profile_updated",
          actor: {
            ...buildDeveloperActor(session),
            displayName: member?.display_name ?? ""
          }
        };
      }

      run(
        db,
        "UPDATE developer_accounts SET display_name = ?, updated_at = ? WHERE id = ?",
        displayName || null,
        timestamp,
        session.developer_id
      );
      const developerAccount = one(
        db,
        "SELECT * FROM developer_accounts WHERE id = ?",
        session.developer_id
      );
      auditDeveloperSession(db, session, "developer.profile.update", "developer", session.developer_id, {
        displayName: developerAccount?.display_name ?? ""
      });
      return {
        status: "profile_updated",
        actor: {
          ...buildDeveloperActor(session),
          displayName: developerAccount?.display_name ?? ""
        },
        developer: formatDeveloperRow(developerAccount)
      };
    },

    listDevelopers(token) {
      requireAdminSession(db, token);
      const items = many(
        db,
        `
          SELECT *
          FROM developer_accounts
          ORDER BY created_at DESC
        `
      ).map(formatDeveloperRow);

      return {
        items,
        total: items.length
      };
    },

    createDeveloper(token, body = {}) {
      const admin = requireAdminSession(db, token);
      requireField(body, "username");
      requireField(body, "password");

      const username = normalizeDeveloperUsername(body.username);
      if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
        throw new AppError(
          400,
          "INVALID_DEVELOPER_USERNAME",
          "Developer username must be 3-32 chars and use letters, digits, dot, underscore, or dash."
        );
      }

      const password = String(body.password ?? "");
      if (password.length < 8) {
        throw new AppError(400, "INVALID_DEVELOPER_PASSWORD", "Developer password must be at least 8 characters.");
      }

      assertDeveloperUsernameAvailable(db, username, "DEVELOPER_EXISTS");

      const now = nowIso();
      const developer = {
        id: generateId("dev"),
        username,
        displayName: String(body.displayName ?? body.name ?? "").trim(),
        status: "active",
        createdAt: now,
        updatedAt: now
      };

      run(
        db,
        `
          INSERT INTO developer_accounts
          (id, username, display_name, password_hash, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        developer.id,
        developer.username,
        developer.displayName || null,
        hashPassword(password),
        developer.status,
        developer.createdAt,
        developer.updatedAt
      );

      audit(db, "admin", admin.admin_id, "developer.create", "developer", developer.id, {
        username: developer.username
      });

      return formatDeveloperRow({
        id: developer.id,
        username: developer.username,
        display_name: developer.displayName || null,
        status: developer.status,
        created_at: developer.createdAt,
        updated_at: developer.updatedAt,
        last_login_at: null
      });
    },

    updateDeveloperStatus(token, developerId, body = {}) {
      const admin = requireAdminSession(db, token);
      const developer = one(
        db,
        "SELECT * FROM developer_accounts WHERE id = ?",
        developerId
      );
      if (!developer) {
        throw new AppError(404, "DEVELOPER_NOT_FOUND", "Developer account does not exist.");
      }

      const status = String(body.status ?? "").trim().toLowerCase();
      if (!["active", "disabled"].includes(status)) {
        throw new AppError(400, "INVALID_DEVELOPER_STATUS", "Developer status must be active or disabled.");
      }

      const timestamp = nowIso();
      run(
        db,
        "UPDATE developer_accounts SET status = ?, updated_at = ? WHERE id = ?",
        status,
        timestamp,
        developer.id
      );

      let revokedSessions = 0;
      if (status === "disabled") {
        revokedSessions = revokeDeveloperSessions(db, "developer_id = ?", [developer.id]);
        revokedSessions += revokeDeveloperMemberSessions(db, "developer_id = ?", [developer.id]);
      }

      audit(db, "admin", admin.admin_id, "developer.status", "developer", developer.id, {
        username: developer.username,
        status,
        revokedSessions
      });

      return formatDeveloperRow({
        ...developer,
        status,
        updated_at: timestamp
      });
    },

    developerListMembers(token) {
      const session = requireDeveloperOwnerSession(db, token);
      const items = queryDeveloperMemberRows(db, session.developer_id);
      return {
        items,
        total: items.length
      };
    },

    developerCreateMember(token, body = {}) {
      const session = requireDeveloperOwnerSession(db, token);
      requireField(body, "username");
      requireField(body, "password");

      const username = normalizeDeveloperUsername(body.username);
      if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
        throw new AppError(
          400,
          "INVALID_DEVELOPER_USERNAME",
          "Developer username must be 3-32 chars and use letters, digits, dot, underscore, or dash."
        );
      }

      const password = String(body.password ?? "");
      if (password.length < 8) {
        throw new AppError(400, "INVALID_DEVELOPER_PASSWORD", "Developer password must be at least 8 characters.");
      }

      assertDeveloperUsernameAvailable(db, username, "DEVELOPER_MEMBER_EXISTS");

      const role = normalizeDeveloperMemberRole(body.role ?? "viewer");
      const status = normalizeDeveloperMemberStatus(body.status ?? "active");
      const productIds = resolveDeveloperOwnedProductIdsInput(db, session.developer_id, body) ?? [];
      const timestamp = nowIso();
      const memberId = generateId("devm");

      run(
        db,
        `
          INSERT INTO developer_members
          (id, developer_id, username, display_name, password_hash, role, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        memberId,
        session.developer_id,
        username,
        String(body.displayName ?? "").trim() || null,
        hashPassword(password),
        role,
        status,
        timestamp,
        timestamp
      );
      syncDeveloperMemberProductAccess(db, session.developer_id, memberId, productIds, timestamp);

      const member = queryDeveloperMemberRows(db, session.developer_id).find((item) => item.id === memberId);
      auditDeveloperSession(db, session, "developer-member.create", "developer_member", memberId, {
        username,
        role,
        status,
        productCount: member?.productAccess.length ?? 0
      });

      return member;
    },

    developerUpdateMember(token, memberId, body = {}) {
      const session = requireDeveloperOwnerSession(db, token);
      const current = one(
        db,
        "SELECT * FROM developer_members WHERE id = ? AND developer_id = ?",
        memberId,
        session.developer_id
      );
      if (!current) {
        throw new AppError(404, "DEVELOPER_MEMBER_NOT_FOUND", "Developer member account does not exist.");
      }

      const displayName = body.displayName === undefined
        ? current.display_name ?? ""
        : String(body.displayName ?? "").trim();
      const role = body.role === undefined
        ? normalizeDeveloperMemberRole(current.role)
        : normalizeDeveloperMemberRole(body.role);
      const status = body.status === undefined
        ? normalizeDeveloperMemberStatus(current.status)
        : normalizeDeveloperMemberStatus(body.status);
      const nextProductIds = resolveDeveloperOwnedProductIdsInput(db, session.developer_id, body);
      const newPasswordProvided = body.newPassword !== undefined && String(body.newPassword).trim() !== "";

      if (newPasswordProvided && String(body.newPassword).length < 8) {
        throw new AppError(400, "INVALID_DEVELOPER_PASSWORD", "Developer password must be at least 8 characters.");
      }

      const timestamp = nowIso();
      run(
        db,
        `
          UPDATE developer_members
          SET display_name = ?, role = ?, status = ?, password_hash = ?, updated_at = ?
          WHERE id = ?
        `,
        displayName || null,
        role,
        status,
        newPasswordProvided ? hashPassword(String(body.newPassword)) : current.password_hash,
        timestamp,
        current.id
      );

      if (nextProductIds !== null) {
        syncDeveloperMemberProductAccess(db, session.developer_id, current.id, nextProductIds, timestamp);
      }

      let revokedSessions = 0;
      if (status !== "active" || newPasswordProvided) {
        revokedSessions = revokeDeveloperMemberSessions(db, "member_id = ?", [current.id]);
      }

      const member = queryDeveloperMemberRows(db, session.developer_id).find((item) => item.id === current.id);
      auditDeveloperSession(db, session, "developer-member.update", "developer_member", current.id, {
        username: current.username,
        role,
        status,
        revokedSessions,
        productCount: member?.productAccess.length ?? 0,
        passwordUpdated: newPasswordProvided
      });

      return {
        ...member,
        revokedSessions
      };
    },

    listProducts(token) {
      requireAdminSession(db, token);
      return store.products.queryProductRows(db);
    },

    createProduct(token, body) {
      const admin = requireAdminSession(db, token);
      const ownerDeveloperId = body.ownerDeveloperId === undefined
        ? null
        : resolveProductOwnerDeveloperId(db, body.ownerDeveloperId, true);
      const product = createProductRecord(db, body, ownerDeveloperId);

      audit(db, "admin", admin.admin_id, "product.create", "product", product.id, {
        code: product.code,
        sdkAppId: product.sdkAppId,
        ownerDeveloperId
      });
      return product;
    },

    updateProductFeatureConfig(token, productId, body = {}) {
      const admin = requireAdminSession(db, token);
      const timestamp = nowIso();
      const result = updateProductFeatureConfigRecord(db, productId, body, timestamp);

      audit(db, "admin", admin.admin_id, "product.feature-config", "product", result.product.id, {
        code: result.product.code,
        featureConfig: result.featureConfig
      });

      return {
        ...result.product,
        featureConfig: result.featureConfig
      };
    },

    rotateProductSdkCredentials(token, productId, body = {}) {
      const admin = requireAdminSession(db, token);
      const result = rotateProductSdkCredentialsRecord(db, productId, body, nowIso());

      audit(db, "admin", admin.admin_id, "product.sdk-credentials.rotate", "product", result.product.id, {
        code: result.product.code,
        rotateAppId: result.rotated.rotateAppId,
        previousSdkAppId: result.rotated.previousSdkAppId,
        sdkAppId: result.rotated.sdkAppId
      });

      return {
        ...result.product,
        rotation: result.rotated
      };
    },

    updateProductOwner(token, productId, body = {}) {
      const admin = requireAdminSession(db, token);
      const product = getProductRowById(db, productId);
      if (!product) {
        throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
      }

      const ownerDeveloperId = body.ownerDeveloperId === undefined
        ? product.ownerDeveloper?.id ?? null
        : resolveProductOwnerDeveloperId(db, body.ownerDeveloperId, true);
      const nextProduct = updateProductOwnerRecord(db, productId, ownerDeveloperId, nowIso());

      audit(db, "admin", admin.admin_id, "product.owner.update", "product", productId, {
        code: nextProduct.code,
        ownerDeveloperId
      });

      return nextProduct;
    },

    developerListProducts(token) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "products.read",
        "DEVELOPER_PRODUCT_FORBIDDEN",
        "You can only view projects assigned to your developer account."
      );
      if (session.actor_scope === "owner") {
        return store.products.queryProductRows(db, { ownerDeveloperId: session.developer_id });
      }
      return store.products.queryProductRows(db, { productIds: listDeveloperAccessibleProductIds(db, session) });
    },

    developerDashboard(token) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "products.read",
        "DEVELOPER_PRODUCT_FORBIDDEN",
        "You can only view projects assigned to your developer account."
      );
      return queryDeveloperDashboardPayload(db, session, stateStore);
    },

    developerIntegration(token) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "products.read",
        "DEVELOPER_PRODUCT_FORBIDDEN",
        "You can only view projects assigned to your developer account."
      );
      const products = listDeveloperAccessibleProductRows(db, session);
      return {
        developer: {
          id: session.developer_id,
          username: session.developer_username ?? session.username,
          displayName: session.developer_display_name ?? session.display_name ?? "",
          status: session.developer_status
        },
        actor: buildDeveloperActor(session),
        transport: {
          http: {
            protocol: "http",
            host: config.host,
            port: config.port,
            baseUrl: `http://127.0.0.1:${config.port}`
          },
          tcp: {
            enabled: Boolean(config.tcpEnabled),
            host: config.tcpHost,
            port: config.tcpPort
          }
        },
        signing: {
          requestAlgorithm: "HMAC-SHA256",
          requestSkewSeconds: config.requestSkewSeconds,
          tokenAlgorithm: config.licenseKeys.algorithm,
          tokenIssuer: config.tokenIssuer,
          activeKeyId: config.licenseKeys.keyId
        },
        tokenKeys: this.tokenKeys(),
        products,
        examples: {
          http: [
            { action: "register", path: "/api/client/register" },
            { action: "login", path: "/api/client/login" },
            { action: "card-login", path: "/api/client/card-login" },
            { action: "version-check", path: "/api/client/version-check" },
            { action: "notices", path: "/api/client/notices" },
            { action: "heartbeat", path: "/api/client/heartbeat" }
          ],
          tcp: [
            { action: "client.register" },
            { action: "client.login" },
            { action: "client.card-login" },
            { action: "client.heartbeat" }
          ]
        }
      };
    },

    developerCreateProduct(token, body = {}) {
      const session = requireDeveloperOwnerSession(db, token);
      const product = createProductRecord(db, body, session.developer_id);

      auditDeveloperSession(db, session, "product.create", "product", product.id, {
        code: product.code,
        sdkAppId: product.sdkAppId
      });

      return product;
    },

    developerUpdateProductFeatureConfig(token, productId, body = {}) {
      const session = requireDeveloperSession(db, token);
      const ownedProduct = requireDeveloperOwnedProduct(db, session, productId, "products.write");
      const result = updateProductFeatureConfigRecord(db, ownedProduct.id, body, nowIso());

      auditDeveloperSession(db, session, "product.feature-config", "product", ownedProduct.id, {
        code: result.product.code,
        featureConfig: result.featureConfig
      });

      return {
        ...result.product,
        featureConfig: result.featureConfig
      };
    },

    developerRotateProductSdkCredentials(token, productId, body = {}) {
      const session = requireDeveloperSession(db, token);
      const ownedProduct = requireDeveloperOwnedProduct(db, session, productId, "products.write");
      const result = rotateProductSdkCredentialsRecord(db, ownedProduct.id, body, nowIso());

      auditDeveloperSession(db, session, "product.sdk-credentials.rotate", "product", result.product.id, {
        code: result.product.code,
        rotateAppId: result.rotated.rotateAppId,
        previousSdkAppId: result.rotated.previousSdkAppId,
        sdkAppId: result.rotated.sdkAppId
      });

      return {
        ...result.product,
        rotation: result.rotated
      };
    },

    listPolicies(token, productCode = null) {
      requireAdminSession(db, token);
      return store.policies.queryPolicyRows(db, productCode ? { productCode } : {});
    },

    developerListPolicies(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "policies.read",
        "DEVELOPER_POLICY_FORBIDDEN",
        "You can only view policies under your assigned projects."
      );
      if (filters.productCode) {
        requireDeveloperOwnedProductByCode(
          db,
          session,
          String(filters.productCode).trim().toUpperCase(),
          "policies.read"
        );
      }
      return store.policies.queryPolicyRows(db, {
        productCode: filters.productCode ?? null,
        productIds: listDeveloperAccessibleProductIds(db, session)
      });
    },

    createPolicy(token, body) {
      const admin = requireAdminSession(db, token);
      requireField(body, "name");

      const product = requireProductByCode(db, readProductCodeInput(body));
      const now = nowIso();
      const grantType = normalizeGrantType(body.grantType ?? "duration");
      const grantPoints = normalizeNonNegativeInteger(body.grantPoints, "grantPoints", 0, 1000000);
      const policy = {
        id: generateId("pol"),
        productId: product.id,
        name: String(body.name).trim(),
        durationDays: Number(body.durationDays ?? (grantType === "duration" ? 30 : 0)),
        maxDevices: Number(body.maxDevices ?? 1),
        allowConcurrentSessions: parseOptionalBoolean(body.allowConcurrentSessions, "allowConcurrentSessions") === false ? 0 : 1,
        heartbeatIntervalSeconds: Number(body.heartbeatIntervalSeconds ?? 60),
        heartbeatTimeoutSeconds: Number(body.heartbeatTimeoutSeconds ?? 180),
        tokenTtlSeconds: Number(body.tokenTtlSeconds ?? 300),
        bindMode: normalizeBindMode(body.bindMode ?? "strict"),
        bindFields: parseBindFieldsInput(body.bindFields, normalizeBindMode(body.bindMode ?? "strict")),
        status: "active",
        createdAt: now,
        updatedAt: now
      };

      if (
        policy.maxDevices <= 0 ||
        policy.heartbeatIntervalSeconds <= 0 ||
        policy.heartbeatTimeoutSeconds <= 0 ||
        policy.tokenTtlSeconds <= 0
      ) {
        throw new AppError(400, "INVALID_POLICY", "Policy values must be positive numbers.");
      }
      if (grantType === "duration" && policy.durationDays <= 0) {
        throw new AppError(400, "INVALID_POLICY", "durationDays must be a positive number for duration policies.");
      }
      if (grantType === "points" && grantPoints <= 0) {
        throw new AppError(400, "INVALID_POLICY", "grantPoints must be a positive number for points policies.");
      }
      if (grantType === "points" && policy.durationDays < 0) {
        throw new AppError(400, "INVALID_POLICY", "durationDays cannot be negative.");
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

      persistPolicyBindConfig(db, policy.id, policy.bindMode, policy.bindFields, now);
      persistPolicyUnbindConfig(db, policy.id, body, now);
      persistPolicyGrantConfig(db, policy.id, { grantType, grantPoints }, now);

      audit(db, "admin", admin.admin_id, "policy.create", "policy", policy.id, {
        productCode: product.code,
        name: policy.name,
        allowConcurrentSessions: Boolean(policy.allowConcurrentSessions),
        bindMode: policy.bindMode,
        bindFields: policy.bindFields,
        grantType,
        grantPoints,
        allowClientUnbind: parseOptionalBoolean(body.allowClientUnbind, "allowClientUnbind") === true,
        clientUnbindLimit: normalizeNonNegativeInteger(body.clientUnbindLimit, "clientUnbindLimit", 0, 1000),
        clientUnbindWindowDays: Math.max(
          1,
          normalizeNonNegativeInteger(body.clientUnbindWindowDays, "clientUnbindWindowDays", 30, 3650)
        ),
        clientUnbindDeductDays: normalizeNonNegativeInteger(
          body.clientUnbindDeductDays,
          "clientUnbindDeductDays",
          0,
          3650
        )
      });
      return {
        ...policy,
        allowConcurrentSessions: Boolean(policy.allowConcurrentSessions),
        ...parsePolicyUnbindConfigRow({
          allow_client_unbind: parseOptionalBoolean(body.allowClientUnbind, "allowClientUnbind") === true ? 1 : 0,
          client_unbind_limit: normalizeNonNegativeInteger(body.clientUnbindLimit, "clientUnbindLimit", 0, 1000),
          client_unbind_window_days: Math.max(
            1,
            normalizeNonNegativeInteger(body.clientUnbindWindowDays, "clientUnbindWindowDays", 30, 3650)
          ),
          client_unbind_deduct_days: normalizeNonNegativeInteger(
            body.clientUnbindDeductDays,
            "clientUnbindDeductDays",
            0,
            3650
          ),
          created_at: now,
          updated_at: now
        }),
        ...parsePolicyGrantConfigRow({
          grant_type: grantType,
          grant_points: grantPoints,
          created_at: now,
          updated_at: now
        })
      };
    },

    developerCreatePolicy(token, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "policies.write",
        "DEVELOPER_POLICY_FORBIDDEN",
        "You can only manage policies under your assigned projects."
      );
      requireField(body, "name");

      const product = requireDeveloperOwnedProductByCode(db, session, readProductCodeInput(body), "policies.write");
      const now = nowIso();
      const grantType = normalizeGrantType(body.grantType ?? "duration");
      const grantPoints = normalizeNonNegativeInteger(body.grantPoints, "grantPoints", 0, 1000000);
      const policy = {
        id: generateId("pol"),
        productId: product.id,
        name: String(body.name).trim(),
        durationDays: Number(body.durationDays ?? (grantType === "duration" ? 30 : 0)),
        maxDevices: Number(body.maxDevices ?? 1),
        allowConcurrentSessions: parseOptionalBoolean(body.allowConcurrentSessions, "allowConcurrentSessions") === false ? 0 : 1,
        heartbeatIntervalSeconds: Number(body.heartbeatIntervalSeconds ?? 60),
        heartbeatTimeoutSeconds: Number(body.heartbeatTimeoutSeconds ?? 180),
        tokenTtlSeconds: Number(body.tokenTtlSeconds ?? 300),
        bindMode: normalizeBindMode(body.bindMode ?? "strict"),
        bindFields: parseBindFieldsInput(body.bindFields, normalizeBindMode(body.bindMode ?? "strict")),
        status: "active",
        createdAt: now,
        updatedAt: now
      };

      if (
        policy.maxDevices <= 0 ||
        policy.heartbeatIntervalSeconds <= 0 ||
        policy.heartbeatTimeoutSeconds <= 0 ||
        policy.tokenTtlSeconds <= 0
      ) {
        throw new AppError(400, "INVALID_POLICY", "Policy values must be positive numbers.");
      }
      if (grantType === "duration" && policy.durationDays <= 0) {
        throw new AppError(400, "INVALID_POLICY", "durationDays must be a positive number for duration policies.");
      }
      if (grantType === "points" && grantPoints <= 0) {
        throw new AppError(400, "INVALID_POLICY", "grantPoints must be a positive number for points policies.");
      }
      if (grantType === "points" && policy.durationDays < 0) {
        throw new AppError(400, "INVALID_POLICY", "durationDays cannot be negative.");
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

      persistPolicyBindConfig(db, policy.id, policy.bindMode, policy.bindFields, now);
      persistPolicyUnbindConfig(db, policy.id, body, now);
      persistPolicyGrantConfig(db, policy.id, { grantType, grantPoints }, now);

      auditDeveloperSession(db, session, "policy.create", "policy", policy.id, {
        productCode: product.code,
        name: policy.name,
        allowConcurrentSessions: Boolean(policy.allowConcurrentSessions),
        bindMode: policy.bindMode,
        bindFields: policy.bindFields,
        grantType,
        grantPoints,
        allowClientUnbind: parseOptionalBoolean(body.allowClientUnbind, "allowClientUnbind") === true,
        clientUnbindLimit: normalizeNonNegativeInteger(body.clientUnbindLimit, "clientUnbindLimit", 0, 1000),
        clientUnbindWindowDays: Math.max(
          1,
          normalizeNonNegativeInteger(body.clientUnbindWindowDays, "clientUnbindWindowDays", 30, 3650)
        ),
        clientUnbindDeductDays: normalizeNonNegativeInteger(
          body.clientUnbindDeductDays,
          "clientUnbindDeductDays",
          0,
          3650
        )
      });

      return {
        ...policy,
        productCode: product.code,
        productName: product.name,
        allowConcurrentSessions: Boolean(policy.allowConcurrentSessions),
        ...parsePolicyUnbindConfigRow({
          allow_client_unbind: parseOptionalBoolean(body.allowClientUnbind, "allowClientUnbind") === true ? 1 : 0,
          client_unbind_limit: normalizeNonNegativeInteger(body.clientUnbindLimit, "clientUnbindLimit", 0, 1000),
          client_unbind_window_days: Math.max(
            1,
            normalizeNonNegativeInteger(body.clientUnbindWindowDays, "clientUnbindWindowDays", 30, 3650)
          ),
          client_unbind_deduct_days: normalizeNonNegativeInteger(
            body.clientUnbindDeductDays,
            "clientUnbindDeductDays",
            0,
            3650
          ),
          created_at: now,
          updated_at: now
        }),
        ...parsePolicyGrantConfigRow({
          grant_type: grantType,
          grant_points: grantPoints,
          created_at: now,
          updated_at: now
        })
      };
    },

    updatePolicyRuntimeConfig(token, policyId, body = {}) {
      const admin = requireAdminSession(db, token);
      const policy = one(
        db,
        `
          SELECT p.*, pr.code AS product_code, pr.name AS product_name
          FROM policies p
          JOIN products pr ON pr.id = p.product_id
          WHERE p.id = ?
        `,
        policyId
      );

      if (!policy) {
        throw new AppError(404, "POLICY_NOT_FOUND", "Policy does not exist.");
      }

      const currentBindConfig = loadPolicyBindConfig(db, policy.id, policy.bind_mode, policy.updated_at);
      const nextBindMode = body.bindMode !== undefined
        ? normalizeBindMode(body.bindMode)
        : currentBindConfig.bindMode;
      const nextBindFields = body.bindFields !== undefined
        ? parseBindFieldsInput(body.bindFields, nextBindMode)
        : currentBindConfig.bindFields;
      const allowConcurrentSessions = parseOptionalBoolean(body.allowConcurrentSessions, "allowConcurrentSessions");
      const nextAllowConcurrentSessions = allowConcurrentSessions === null
        ? Number(policy.allow_concurrent_sessions)
        : allowConcurrentSessions ? 1 : 0;
      const timestamp = nowIso();

      run(
        db,
        `
          UPDATE policies
          SET allow_concurrent_sessions = ?, bind_mode = ?, updated_at = ?
          WHERE id = ?
        `,
        nextAllowConcurrentSessions,
        nextBindMode,
        timestamp,
        policy.id
      );

      persistPolicyBindConfig(db, policy.id, nextBindMode, nextBindFields, timestamp);

      audit(db, "admin", admin.admin_id, "policy.runtime.update", "policy", policy.id, {
        productCode: policy.product_code,
        allowConcurrentSessions: Boolean(nextAllowConcurrentSessions),
        bindMode: nextBindMode,
        bindFields: nextBindFields
      });

      return {
        id: policy.id,
        productId: policy.product_id,
        productCode: policy.product_code,
        productName: policy.product_name,
        name: policy.name,
        allowConcurrentSessions: Boolean(nextAllowConcurrentSessions),
        bindMode: nextBindMode,
        bindFields: nextBindFields,
        updatedAt: timestamp
      };
    },

    updatePolicyUnbindConfig(token, policyId, body = {}) {
      const admin = requireAdminSession(db, token);
      const policy = one(
        db,
        `
          SELECT p.*, pr.code AS product_code, pr.name AS product_name
          FROM policies p
          JOIN products pr ON pr.id = p.product_id
          WHERE p.id = ?
        `,
        policyId
      );

      if (!policy) {
        throw new AppError(404, "POLICY_NOT_FOUND", "Policy does not exist.");
      }

      const currentConfig = loadPolicyUnbindConfig(db, policy.id, policy.updated_at);
      const nextConfig = {
        allowClientUnbind: body.allowClientUnbind === undefined
          ? currentConfig.allowClientUnbind
          : parseOptionalBoolean(body.allowClientUnbind, "allowClientUnbind"),
        clientUnbindLimit: body.clientUnbindLimit === undefined
          ? currentConfig.clientUnbindLimit
          : normalizeNonNegativeInteger(body.clientUnbindLimit, "clientUnbindLimit", 0, 1000),
        clientUnbindWindowDays: body.clientUnbindWindowDays === undefined
          ? currentConfig.clientUnbindWindowDays
          : Math.max(
              1,
              normalizeNonNegativeInteger(body.clientUnbindWindowDays, "clientUnbindWindowDays", 30, 3650)
            ),
        clientUnbindDeductDays: body.clientUnbindDeductDays === undefined
          ? currentConfig.clientUnbindDeductDays
          : normalizeNonNegativeInteger(body.clientUnbindDeductDays, "clientUnbindDeductDays", 0, 3650)
      };
      const timestamp = nowIso();

      persistPolicyUnbindConfig(db, policy.id, nextConfig, timestamp);

      audit(db, "admin", admin.admin_id, "policy.unbind.update", "policy", policy.id, {
        productCode: policy.product_code,
        allowClientUnbind: nextConfig.allowClientUnbind,
        clientUnbindLimit: nextConfig.clientUnbindLimit,
        clientUnbindWindowDays: nextConfig.clientUnbindWindowDays,
        clientUnbindDeductDays: nextConfig.clientUnbindDeductDays
      });

      return {
        id: policy.id,
        productId: policy.product_id,
        productCode: policy.product_code,
        productName: policy.product_name,
        name: policy.name,
        ...nextConfig,
        updatedAt: timestamp
      };
    },

    developerUpdatePolicyRuntimeConfig(token, policyId, body = {}) {
      const session = requireDeveloperSession(db, token);
      const policy = requireDeveloperOwnedPolicy(db, session, policyId, "policies.write");
      const currentBindConfig = loadPolicyBindConfig(db, policy.id, policy.bind_mode, policy.updated_at);
      const nextBindMode = body.bindMode !== undefined
        ? normalizeBindMode(body.bindMode)
        : currentBindConfig.bindMode;
      const nextBindFields = body.bindFields !== undefined
        ? parseBindFieldsInput(body.bindFields, nextBindMode)
        : currentBindConfig.bindFields;
      const allowConcurrentSessions = parseOptionalBoolean(body.allowConcurrentSessions, "allowConcurrentSessions");
      const nextAllowConcurrentSessions = allowConcurrentSessions === null
        ? Number(policy.allow_concurrent_sessions)
        : allowConcurrentSessions ? 1 : 0;
      const timestamp = nowIso();

      run(
        db,
        `
          UPDATE policies
          SET allow_concurrent_sessions = ?, bind_mode = ?, updated_at = ?
          WHERE id = ?
        `,
        nextAllowConcurrentSessions,
        nextBindMode,
        timestamp,
        policy.id
      );

      persistPolicyBindConfig(db, policy.id, nextBindMode, nextBindFields, timestamp);

      auditDeveloperSession(db, session, "policy.runtime.update", "policy", policy.id, {
        productCode: policy.product_code,
        allowConcurrentSessions: Boolean(nextAllowConcurrentSessions),
        bindMode: nextBindMode,
        bindFields: nextBindFields
      });

      return {
        id: policy.id,
        productId: policy.product_id,
        productCode: policy.product_code,
        productName: policy.product_name,
        name: policy.name,
        allowConcurrentSessions: Boolean(nextAllowConcurrentSessions),
        bindMode: nextBindMode,
        bindFields: nextBindFields,
        updatedAt: timestamp
      };
    },

    developerUpdatePolicyUnbindConfig(token, policyId, body = {}) {
      const session = requireDeveloperSession(db, token);
      const policy = requireDeveloperOwnedPolicy(db, session, policyId, "policies.write");
      const currentConfig = loadPolicyUnbindConfig(db, policy.id, policy.updated_at);
      const nextConfig = {
        allowClientUnbind: body.allowClientUnbind === undefined
          ? currentConfig.allowClientUnbind
          : parseOptionalBoolean(body.allowClientUnbind, "allowClientUnbind"),
        clientUnbindLimit: body.clientUnbindLimit === undefined
          ? currentConfig.clientUnbindLimit
          : normalizeNonNegativeInteger(body.clientUnbindLimit, "clientUnbindLimit", 0, 1000),
        clientUnbindWindowDays: body.clientUnbindWindowDays === undefined
          ? currentConfig.clientUnbindWindowDays
          : Math.max(
              1,
              normalizeNonNegativeInteger(body.clientUnbindWindowDays, "clientUnbindWindowDays", 30, 3650)
            ),
        clientUnbindDeductDays: body.clientUnbindDeductDays === undefined
          ? currentConfig.clientUnbindDeductDays
          : normalizeNonNegativeInteger(body.clientUnbindDeductDays, "clientUnbindDeductDays", 0, 3650)
      };
      const timestamp = nowIso();

      persistPolicyUnbindConfig(db, policy.id, nextConfig, timestamp);

      auditDeveloperSession(db, session, "policy.unbind.update", "policy", policy.id, {
        productCode: policy.product_code,
        allowClientUnbind: nextConfig.allowClientUnbind,
        clientUnbindLimit: nextConfig.clientUnbindLimit,
        clientUnbindWindowDays: nextConfig.clientUnbindWindowDays,
        clientUnbindDeductDays: nextConfig.clientUnbindDeductDays
      });

      return {
        id: policy.id,
        productId: policy.product_id,
        productCode: policy.product_code,
        productName: policy.product_name,
        name: policy.name,
        ...nextConfig,
        updatedAt: timestamp
      };
    },

    listCards(token, filters = {}) {
      requireAdminSession(db, token);
      const { items, summary, filters: normalizedFilters } = store.cards.queryCardRows(db, filters);
      return {
        items,
        total: items.length,
        summary,
        filters: normalizedFilters
      };
    },

    exportCardsCsv(token, filters = {}) {
      requireAdminSession(db, token);
      const { items } = store.cards.queryCardRows(db, filters, { limit: 5000 });
      return buildCardsCsv(items);
    },

    developerListCards(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "cards.read",
        "DEVELOPER_CARD_FORBIDDEN",
        "You can only view cards under your assigned projects."
      );
      if (filters.productCode) {
        requireDeveloperOwnedProductByCode(
          db,
          session,
          String(filters.productCode).trim().toUpperCase(),
          "cards.read"
        );
      }
      const { items, summary, filters: normalizedFilters } = store.cards.queryCardRows(
        db,
        { ...filters, productIds: listDeveloperAccessibleProductIds(db, session) }
      );
      return {
        items,
        total: items.length,
        summary,
        filters: normalizedFilters
      };
    },

    developerExportCardsCsv(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "cards.read",
        "DEVELOPER_CARD_FORBIDDEN",
        "You can only view cards under your assigned projects."
      );
      if (filters.productCode) {
        requireDeveloperOwnedProductByCode(
          db,
          session,
          String(filters.productCode).trim().toUpperCase(),
          "cards.read"
        );
      }
      const { items } = store.cards.queryCardRows(
        db,
        { ...filters, productIds: listDeveloperAccessibleProductIds(db, session) },
        { limit: 5000 }
      );
      return buildCardsCsv(items);
    },

    updateCardStatus(token, cardId, body = {}) {
      const admin = requireAdminSession(db, token);
      const card = one(
        db,
        `
          SELECT lk.id, lk.card_key, lk.status, lk.product_id, lk.redeemed_by_account_id,
                 pr.code AS product_code, pol.name AS policy_name
          FROM license_keys lk
          JOIN products pr ON pr.id = lk.product_id
          JOIN policies pol ON pol.id = lk.policy_id
          WHERE lk.id = ?
        `,
        cardId
      );

      if (!card) {
        throw new AppError(404, "CARD_NOT_FOUND", "Card key does not exist.");
      }

      return withTransaction(db, () => {
        const timestamp = nowIso();
        const control = upsertLicenseKeyControl(db, card.id, {
          status: body.status ?? "active",
          expiresAt: body.expiresAt,
          notes: body.notes
        }, timestamp);

        let revokedSessions = 0;
        if (!control.available) {
          revokedSessions = expireSessionsForLicenseKey(
            db,
            stateStore,
            card.id,
            `card_${control.effectiveStatus}`
          );
        }

        audit(db, "admin", admin.admin_id, "card.status", "license_key", card.id, {
          productCode: card.product_code,
          cardKeyMasked: maskCardKey(card.card_key),
          status: control.status,
          effectiveStatus: control.effectiveStatus,
          expiresAt: control.expiresAt,
          revokedSessions
        });

        return {
          ...store.cards.getCardRowById(db, card.id),
          changed: true,
          revokedSessions
        };
      });
    },

    developerUpdateCardStatus(token, cardId, body = {}) {
      const session = requireDeveloperSession(db, token);
      const card = requireDeveloperOwnedCard(db, session, cardId, "cards.write");

      return withTransaction(db, () => {
        const timestamp = nowIso();
        const control = upsertLicenseKeyControl(db, card.id, {
          status: body.status ?? "active",
          expiresAt: body.expiresAt,
          notes: body.notes
        }, timestamp);

        let revokedSessions = 0;
        if (!control.available) {
          revokedSessions = expireSessionsForLicenseKey(
            db,
            stateStore,
            card.id,
            `card_${control.effectiveStatus}`
          );
        }

        auditDeveloperSession(db, session, "card.status", "license_key", card.id, {
          productCode: card.product_code,
          cardKeyMasked: maskCardKey(card.card_key),
          status: control.status,
          effectiveStatus: control.effectiveStatus,
          expiresAt: control.expiresAt,
          revokedSessions
        });

        return {
          ...store.cards.getCardRowById(db, card.id),
          changed: true,
          revokedSessions
        };
      });
    },

    createCardBatch(token, body) {
      const admin = requireAdminSession(db, token);
      requireField(body, "policyId");

      const product = requireProductByCode(db, readProductCodeInput(body));
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
      const expiresAt = normalizeOptionalIsoDate(body.expiresAt, "expiresAt");

      const keys = withTransaction(db, () => {
        const issued = issueLicenseKeys(db, {
          productId: product.id,
          policyId: policy.id,
          prefix,
          count,
          batchCode,
          notes: String(body.notes ?? ""),
          issuedAt
        });
        if (expiresAt) {
          for (const entry of issued) {
            upsertLicenseKeyControl(db, entry.licenseKeyId, {
              status: "active",
              expiresAt,
              notes: body.notes
            }, issuedAt);
          }
        }
        return issued;
      });

      audit(db, "admin", admin.admin_id, "card.batch.create", "policy", policy.id, {
        productCode: product.code,
        batchCode,
        count,
        expiresAt
      });

      return {
        batchCode,
        count,
        expiresAt,
        preview: keys.slice(0, 10).map((entry) => entry.cardKey),
        keys: keys.map((entry) => entry.cardKey)
      };
    },

    developerCreateCardBatch(token, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "cards.write",
        "DEVELOPER_CARD_FORBIDDEN",
        "You can only manage cards under your assigned projects."
      );
      requireField(body, "policyId");

      const product = requireDeveloperOwnedProductByCode(db, session, readProductCodeInput(body), "cards.write");
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
      const expiresAt = normalizeOptionalIsoDate(body.expiresAt, "expiresAt");

      const keys = withTransaction(db, () => {
        const issued = issueLicenseKeys(db, {
          productId: product.id,
          policyId: policy.id,
          prefix,
          count,
          batchCode,
          notes: String(body.notes ?? ""),
          issuedAt
        });
        if (expiresAt) {
          for (const entry of issued) {
            upsertLicenseKeyControl(db, entry.licenseKeyId, {
              status: "active",
              expiresAt,
              notes: body.notes
            }, issuedAt);
          }
        }
        return issued;
      });

      auditDeveloperSession(db, session, "card.batch.create", "policy", policy.id, {
        productCode: product.code,
        batchCode,
        count,
        expiresAt
      });

      return {
        batchCode,
        count,
        expiresAt,
        preview: keys.slice(0, 10).map((entry) => entry.cardKey),
        keys: keys.map((entry) => entry.cardKey)
      };
    },

    developerListAccounts(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.read",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only view customer accounts under your assigned projects."
      );
      if (filters.productCode) {
        requireDeveloperOwnedProductByCode(
          db,
          session,
          String(filters.productCode).trim().toUpperCase(),
          "ops.read"
        );
      }
      return queryAccountRows(
        db,
        { ...filters, productIds: listDeveloperAccessibleProductIds(db, session) },
        stateStore
      );
    },

    developerUpdateAccountStatus(token, accountId, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage customer accounts under your assigned projects."
      );

      const account = one(
        db,
        `
          SELECT a.id, a.username, a.status, a.product_id,
                 pr.code AS product_code, pr.owner_developer_id
          FROM customer_accounts a
          JOIN products pr ON pr.id = a.product_id
          WHERE a.id = ?
        `,
        accountId
      );

      if (!account) {
        throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account does not exist.");
      }

      ensureDeveloperCanAccessProduct(
        db,
        session,
        { id: account.product_id, owner_developer_id: account.owner_developer_id },
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage customer accounts under your assigned projects."
      );

      const nextStatus = String(body.status ?? "").trim().toLowerCase();
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
          revokedSessions = expireActiveSessions(
            db,
            stateStore,
            "account_id = ?",
            [account.id],
            "account_disabled"
          );
        }

        auditDeveloperSession(
          db,
          session,
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

    listEntitlements(token, filters = {}) {
      requireAdminSession(db, token);
      const { items, filters: normalizedFilters } = store.entitlements.queryEntitlementRows(db, filters);
      return {
        items,
        total: items.length,
        filters: normalizedFilters
      };
    },

    developerListEntitlements(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.read",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only view entitlements under your assigned projects."
      );
      if (filters.productCode) {
        requireDeveloperOwnedProductByCode(
          db,
          session,
          String(filters.productCode).trim().toUpperCase(),
          "ops.read"
        );
      }
      const { items, filters: normalizedFilters } = store.entitlements.queryEntitlementRows(db, {
        ...filters,
        productIds: listDeveloperAccessibleProductIds(db, session)
      });
      return {
        items,
        total: items.length,
        filters: normalizedFilters
      };
    },

    updateEntitlementStatus(token, entitlementId, body = {}) {
      const admin = requireAdminSession(db, token);
      const entitlement = one(
        db,
        `
          SELECT e.*, pr.code AS product_code, a.username, pol.name AS policy_name, lk.card_key
          FROM entitlements e
          JOIN products pr ON pr.id = e.product_id
          JOIN customer_accounts a ON a.id = e.account_id
          JOIN policies pol ON pol.id = e.policy_id
          JOIN license_keys lk ON lk.id = e.source_license_key_id
          WHERE e.id = ?
        `,
        entitlementId
      );

      if (!entitlement) {
        throw new AppError(404, "ENTITLEMENT_NOT_FOUND", "Entitlement does not exist.");
      }

      const nextStatus = normalizeEntitlementStatus(body.status ?? "active");
      if (nextStatus === entitlement.status) {
        return {
          id: entitlement.id,
          productCode: entitlement.product_code,
          username: entitlement.username,
          status: nextStatus,
          changed: false,
          revokedSessions: 0,
          endsAt: entitlement.ends_at
        };
      }

      return withTransaction(db, () => {
        const timestamp = nowIso();
        run(
          db,
          `
            UPDATE entitlements
            SET status = ?, updated_at = ?
            WHERE id = ?
          `,
          nextStatus,
          timestamp,
          entitlement.id
        );

        const revokedSessions = nextStatus === "frozen"
          ? expireSessionsForEntitlement(db, stateStore, entitlement.id, "entitlement_frozen")
          : 0;

        audit(
          db,
          "admin",
          admin.admin_id,
          "entitlement.status",
          "entitlement",
          entitlement.id,
          {
            productCode: entitlement.product_code,
            username: entitlement.username,
            status: nextStatus,
            revokedSessions,
            sourceCardKeyMasked: maskCardKey(entitlement.card_key)
          }
        );

        return {
          id: entitlement.id,
          productCode: entitlement.product_code,
          username: entitlement.username,
          status: nextStatus,
          changed: true,
          revokedSessions,
          endsAt: entitlement.ends_at,
          updatedAt: timestamp
        };
      });
    },

    developerUpdateEntitlementStatus(token, entitlementId, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage entitlements under your assigned projects."
      );
      const entitlement = one(
        db,
        `
          SELECT e.*, pr.code AS product_code, pr.owner_developer_id, a.username, pol.name AS policy_name, lk.card_key
          FROM entitlements e
          JOIN products pr ON pr.id = e.product_id
          JOIN customer_accounts a ON a.id = e.account_id
          JOIN policies pol ON pol.id = e.policy_id
          JOIN license_keys lk ON lk.id = e.source_license_key_id
          WHERE e.id = ?
        `,
        entitlementId
      );

      if (!entitlement) {
        throw new AppError(404, "ENTITLEMENT_NOT_FOUND", "Entitlement does not exist.");
      }

      ensureDeveloperCanAccessProduct(
        db,
        session,
        { id: entitlement.product_id, owner_developer_id: entitlement.owner_developer_id },
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage entitlements under your assigned projects."
      );

      const nextStatus = normalizeEntitlementStatus(body.status ?? "active");
      if (nextStatus === entitlement.status) {
        return {
          id: entitlement.id,
          productCode: entitlement.product_code,
          username: entitlement.username,
          status: nextStatus,
          changed: false,
          revokedSessions: 0,
          endsAt: entitlement.ends_at
        };
      }

      return withTransaction(db, () => {
        const timestamp = nowIso();
        run(
          db,
          `
            UPDATE entitlements
            SET status = ?, updated_at = ?
            WHERE id = ?
          `,
          nextStatus,
          timestamp,
          entitlement.id
        );

        const revokedSessions = nextStatus === "frozen"
          ? expireSessionsForEntitlement(db, stateStore, entitlement.id, "entitlement_frozen")
          : 0;

        auditDeveloperSession(db, session, "entitlement.status", "entitlement", entitlement.id, {
          productCode: entitlement.product_code,
          username: entitlement.username,
          status: nextStatus,
          revokedSessions,
          sourceCardKeyMasked: maskCardKey(entitlement.card_key)
        });

        return {
          id: entitlement.id,
          productCode: entitlement.product_code,
          username: entitlement.username,
          status: nextStatus,
          changed: true,
          revokedSessions,
          endsAt: entitlement.ends_at,
          updatedAt: timestamp
        };
      });
    },

    extendEntitlement(token, entitlementId, body = {}) {
      const admin = requireAdminSession(db, token);
      const entitlement = one(
        db,
        `
          SELECT e.*, pr.code AS product_code, a.username, pol.name AS policy_name, lk.card_key
          FROM entitlements e
          JOIN products pr ON pr.id = e.product_id
          JOIN customer_accounts a ON a.id = e.account_id
          JOIN policies pol ON pol.id = e.policy_id
          JOIN license_keys lk ON lk.id = e.source_license_key_id
          WHERE e.id = ?
        `,
        entitlementId
      );

      if (!entitlement) {
        throw new AppError(404, "ENTITLEMENT_NOT_FOUND", "Entitlement does not exist.");
      }

      const days = Number(body.days ?? body.extendDays ?? 0);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        throw new AppError(400, "INVALID_EXTENSION_DAYS", "days must be an integer between 1 and 3650.");
      }

      const timestamp = nowIso();
      const baseTime = entitlement.ends_at > timestamp ? entitlement.ends_at : timestamp;
      const endsAt = addDays(baseTime, days);

      run(
        db,
        `
          UPDATE entitlements
          SET ends_at = ?, updated_at = ?
          WHERE id = ?
        `,
        endsAt,
        timestamp,
        entitlement.id
      );

      audit(db, "admin", admin.admin_id, "entitlement.extend", "entitlement", entitlement.id, {
        productCode: entitlement.product_code,
        username: entitlement.username,
        days,
        sourceCardKeyMasked: maskCardKey(entitlement.card_key),
        endsAt
      });

      return {
        id: entitlement.id,
        productCode: entitlement.product_code,
        username: entitlement.username,
        status: entitlement.status,
        previousEndsAt: entitlement.ends_at,
        endsAt,
        addedDays: days,
        updatedAt: timestamp
      };
    },

    developerExtendEntitlement(token, entitlementId, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage entitlements under your assigned projects."
      );
      const entitlement = one(
        db,
        `
          SELECT e.*, pr.code AS product_code, pr.owner_developer_id, a.username, pol.name AS policy_name, lk.card_key
          FROM entitlements e
          JOIN products pr ON pr.id = e.product_id
          JOIN customer_accounts a ON a.id = e.account_id
          JOIN policies pol ON pol.id = e.policy_id
          JOIN license_keys lk ON lk.id = e.source_license_key_id
          WHERE e.id = ?
        `,
        entitlementId
      );

      if (!entitlement) {
        throw new AppError(404, "ENTITLEMENT_NOT_FOUND", "Entitlement does not exist.");
      }

      ensureDeveloperCanAccessProduct(
        db,
        session,
        { id: entitlement.product_id, owner_developer_id: entitlement.owner_developer_id },
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage entitlements under your assigned projects."
      );

      const days = Number(body.days ?? body.extendDays ?? 0);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        throw new AppError(400, "INVALID_EXTENSION_DAYS", "days must be an integer between 1 and 3650.");
      }

      const timestamp = nowIso();
      const baseTime = entitlement.ends_at > timestamp ? entitlement.ends_at : timestamp;
      const endsAt = addDays(baseTime, days);

      run(
        db,
        `
          UPDATE entitlements
          SET ends_at = ?, updated_at = ?
          WHERE id = ?
        `,
        endsAt,
        timestamp,
        entitlement.id
      );

      auditDeveloperSession(db, session, "entitlement.extend", "entitlement", entitlement.id, {
        productCode: entitlement.product_code,
        username: entitlement.username,
        days,
        sourceCardKeyMasked: maskCardKey(entitlement.card_key),
        endsAt
      });

      return {
        id: entitlement.id,
        productCode: entitlement.product_code,
        username: entitlement.username,
        status: entitlement.status,
        previousEndsAt: entitlement.ends_at,
        endsAt,
        addedDays: days,
        updatedAt: timestamp
      };
    },

    adjustEntitlementPoints(token, entitlementId, body = {}) {
      const admin = requireAdminSession(db, token);
      const entitlement = loadPointEntitlementForAdmin(db, entitlementId);
      if (!entitlement) {
        throw new AppError(404, "ENTITLEMENT_NOT_FOUND", "Entitlement does not exist.");
      }

      if (normalizeGrantType(entitlement.grant_type ?? "duration") !== "points") {
        throw new AppError(409, "ENTITLEMENT_NOT_POINTS", "This entitlement is not a point-based authorization.");
      }

      const mode = normalizePointAdjustMode(body.mode ?? "add");
      const points = normalizeNonNegativeInteger(body.points, "points", 0, 1000000);
      if (mode !== "set" && points < 1) {
        throw new AppError(400, "INVALID_POINT_ADJUSTMENT", "points must be at least 1 for add or subtract mode.");
      }

      const previous = {
        totalPoints: Number(entitlement.total_points ?? entitlement.grant_points ?? 0),
        remainingPoints: Number(entitlement.remaining_points ?? entitlement.grant_points ?? 0),
        consumedPoints: Number(entitlement.consumed_points ?? 0)
      };

      let nextRemainingPoints = previous.remainingPoints;
      if (mode === "add") {
        nextRemainingPoints = previous.remainingPoints + points;
      } else if (mode === "subtract") {
        nextRemainingPoints = Math.max(0, previous.remainingPoints - points);
      } else {
        nextRemainingPoints = points;
      }

      const nextTotalPoints = previous.consumedPoints + nextRemainingPoints;
      const timestamp = nowIso();
      upsertEntitlementMetering(
        db,
        entitlement.id,
        "points",
        nextTotalPoints,
        nextRemainingPoints,
        previous.consumedPoints,
        timestamp
      );

      audit(db, "admin", admin.admin_id, "entitlement.points.adjust", "entitlement", entitlement.id, {
        productCode: entitlement.product_code,
        username: entitlement.username,
        mode,
        points,
        previousTotalPoints: previous.totalPoints,
        previousRemainingPoints: previous.remainingPoints,
        previousConsumedPoints: previous.consumedPoints,
        totalPoints: nextTotalPoints,
        remainingPoints: nextRemainingPoints,
        consumedPoints: previous.consumedPoints
      });

      return {
        id: entitlement.id,
        productCode: entitlement.product_code,
        productName: entitlement.product_name,
        username: entitlement.username,
        policyName: entitlement.policy_name,
        grantType: "points",
        mode,
        points,
        totalPoints: nextTotalPoints,
        remainingPoints: nextRemainingPoints,
        consumedPoints: previous.consumedPoints,
        previousTotalPoints: previous.totalPoints,
        previousRemainingPoints: previous.remainingPoints,
        previousConsumedPoints: previous.consumedPoints,
        activeSessionCount: Number(entitlement.active_session_count ?? 0),
        updatedAt: timestamp
      };
    },

    listResellers(token, filters = {}) {
      requireAdminSession(db, token);

      const conditions = [];
      const params = [];
      const normalizedFilters = {
        status: filters.status ? String(filters.status).trim().toLowerCase() : null,
        parentResellerId: filters.parentResellerId ? String(filters.parentResellerId).trim() : null,
        search: filters.search ? String(filters.search).trim() : null
      };

      if (normalizedFilters.status) {
        if (!["active", "disabled"].includes(normalizedFilters.status)) {
          throw new AppError(400, "INVALID_RESELLER_STATUS", "Reseller status must be active or disabled.");
        }
        conditions.push("r.status = ?");
        params.push(normalizedFilters.status);
      }

      if (normalizedFilters.parentResellerId) {
        conditions.push("rr.parent_reseller_id = ?");
        params.push(normalizedFilters.parentResellerId);
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
                 rr.parent_reseller_id, rr.can_view_descendants,
                 COALESCE(inv.total_allocated, 0) AS total_allocated,
                 COALESCE(inv.fresh_keys, 0) AS fresh_keys,
                 COALESCE(inv.redeemed_keys, 0) AS redeemed_keys,
                 COALESCE(usr.user_count, 0) AS user_count
          FROM resellers r
          LEFT JOIN reseller_relations rr ON rr.reseller_id = r.id
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
          LEFT JOIN (
            SELECT reseller_id, COUNT(*) AS user_count
            FROM reseller_users
            GROUP BY reseller_id
          ) usr ON usr.reseller_id = r.id
          ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY r.created_at DESC
          LIMIT 100
        `,
        ...params
      ).map(formatResellerListRow);

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

      const parentResellerId = body.parentResellerId ? String(body.parentResellerId).trim() : null;
      const parentReseller = parentResellerId
        ? one(db, "SELECT id, code, status FROM resellers WHERE id = ?", parentResellerId)
        : null;
      if (parentResellerId && !parentReseller) {
        throw new AppError(404, "PARENT_RESELLER_NOT_FOUND", "Parent reseller does not exist.");
      }
      if (parentReseller && parentReseller.status !== "active") {
        throw new AppError(409, "PARENT_RESELLER_DISABLED", "Parent reseller is disabled.");
      }

      const allowViewDescendants = parseOptionalBoolean(body.allowViewDescendants, "allowViewDescendants");
      const now = nowIso();
      const reseller = withTransaction(db, () => {
        const created = {
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
          created.id,
          created.code,
          created.name,
          created.contactName,
          created.contactEmail,
          created.status,
          created.notes,
          created.createdAt,
          created.updatedAt
        );

        createResellerRelation(
          db,
          created.id,
          parentReseller?.id ?? null,
          allowViewDescendants === null ? true : allowViewDescendants,
          now
        );

        const loginUsername = body.loginUsername ?? body.username;
        const loginPassword = body.loginPassword ?? body.password;
        const user = loginUsername && loginPassword
          ? createResellerUserRecord(db, created.id, loginUsername, loginPassword, now)
          : null;

        return {
          ...created,
          parentResellerId: parentReseller?.id ?? null,
          allowViewDescendants: allowViewDescendants === null ? true : allowViewDescendants,
          loginUser: user
            ? {
                id: user.id,
                username: user.username,
                status: user.status
              }
            : null
        };
      });

      audit(db, "admin", admin.admin_id, "reseller.create", "reseller", reseller.id, {
        code: reseller.code,
        name: reseller.name,
        parentResellerId: reseller.parentResellerId,
        loginUsername: reseller.loginUser?.username ?? null
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
      return withTransaction(db, () => {
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

        let revokedSessions = 0;
        if (status === "disabled") {
          const result = run(
            db,
            "DELETE FROM reseller_sessions WHERE reseller_id = ?",
            reseller.id
          );
          revokedSessions = Number(result.changes ?? 0);
        }

        audit(db, "admin", admin.admin_id, "reseller.status", "reseller", reseller.id, {
          code: reseller.code,
          status,
          revokedSessions
        });

        return {
          id: reseller.id,
          code: reseller.code,
          status,
          changed: status !== reseller.status,
          revokedSessions,
          updatedAt: now
        };
      });
    },

    developerAdjustEntitlementPoints(token, entitlementId, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage point entitlements under your assigned projects."
      );
      const entitlement = one(
        db,
        `
          SELECT e.id, e.status, e.ends_at, e.account_id, e.product_id,
                 pr.code AS product_code, pr.name AS product_name, pr.owner_developer_id,
                 a.username,
                 pol.name AS policy_name,
                 COALESCE(pgc.grant_type, 'duration') AS grant_type,
                 COALESCE(pgc.grant_points, 0) AS grant_points,
                 em.total_points, em.remaining_points, em.consumed_points,
                 COALESCE(sess.active_session_count, 0) AS active_session_count
          FROM entitlements e
          JOIN products pr ON pr.id = e.product_id
          JOIN customer_accounts a ON a.id = e.account_id
          JOIN policies pol ON pol.id = e.policy_id
          LEFT JOIN policy_grant_configs pgc ON pgc.policy_id = e.policy_id
          LEFT JOIN entitlement_metering em ON em.entitlement_id = e.id
          LEFT JOIN (
            SELECT entitlement_id, COUNT(*) AS active_session_count
            FROM sessions
            WHERE status = 'active'
            GROUP BY entitlement_id
          ) sess ON sess.entitlement_id = e.id
          WHERE e.id = ?
        `,
        entitlementId
      );
      if (!entitlement) {
        throw new AppError(404, "ENTITLEMENT_NOT_FOUND", "Entitlement does not exist.");
      }

      ensureDeveloperCanAccessProduct(
        db,
        session,
        { id: entitlement.product_id, owner_developer_id: entitlement.owner_developer_id },
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage point entitlements under your assigned projects."
      );

      if (normalizeGrantType(entitlement.grant_type ?? "duration") !== "points") {
        throw new AppError(409, "ENTITLEMENT_NOT_POINTS", "This entitlement is not a point-based authorization.");
      }

      const mode = normalizePointAdjustMode(body.mode ?? "add");
      const points = normalizeNonNegativeInteger(body.points, "points", 0, 1000000);
      if (mode !== "set" && points < 1) {
        throw new AppError(400, "INVALID_POINT_ADJUSTMENT", "points must be at least 1 for add or subtract mode.");
      }

      const previous = {
        totalPoints: Number(entitlement.total_points ?? entitlement.grant_points ?? 0),
        remainingPoints: Number(entitlement.remaining_points ?? entitlement.grant_points ?? 0),
        consumedPoints: Number(entitlement.consumed_points ?? 0)
      };

      let nextRemainingPoints = previous.remainingPoints;
      if (mode === "add") {
        nextRemainingPoints = previous.remainingPoints + points;
      } else if (mode === "subtract") {
        nextRemainingPoints = Math.max(0, previous.remainingPoints - points);
      } else {
        nextRemainingPoints = points;
      }

      const nextConsumedPoints = Math.max(0, previous.totalPoints - nextRemainingPoints);
      const nextTotalPoints = Math.max(previous.totalPoints, nextRemainingPoints + nextConsumedPoints);
      const timestamp = nowIso();

      run(
        db,
        `
          INSERT INTO entitlement_metering
          (entitlement_id, grant_type, total_points, remaining_points, consumed_points, created_at, updated_at)
          VALUES (?, 'points', ?, ?, ?, ?, ?)
          ON CONFLICT(entitlement_id) DO UPDATE SET
            total_points = excluded.total_points,
            remaining_points = excluded.remaining_points,
            consumed_points = excluded.consumed_points,
            updated_at = excluded.updated_at
        `,
        entitlement.id,
        nextTotalPoints,
        nextRemainingPoints,
        nextConsumedPoints,
        timestamp,
        timestamp
      );

      auditDeveloperSession(db, session, "entitlement.points.adjust", "entitlement", entitlement.id, {
        productCode: entitlement.product_code,
        username: entitlement.username,
        mode,
        points,
        previous,
        next: {
          totalPoints: nextTotalPoints,
          remainingPoints: nextRemainingPoints,
          consumedPoints: nextConsumedPoints
        }
      });

      return {
        id: entitlement.id,
        productCode: entitlement.product_code,
        username: entitlement.username,
        status: entitlement.status,
        mode,
        points,
        previous,
        current: {
          totalPoints: nextTotalPoints,
          remainingPoints: nextRemainingPoints,
          consumedPoints: nextConsumedPoints
        },
        updatedAt: timestamp
      };
    },

    resellerLogin(body = {}) {
      requireField(body, "username");
      requireField(body, "password");

      const username = normalizeResellerUsername(body.username);
      const user = one(
        db,
        `
          SELECT ru.*, r.code AS reseller_code, r.name AS reseller_name, r.status AS reseller_status,
                 rr.parent_reseller_id, rr.can_view_descendants
          FROM reseller_users ru
          JOIN resellers r ON r.id = ru.reseller_id
          LEFT JOIN reseller_relations rr ON rr.reseller_id = r.id
          WHERE ru.username = ?
        `,
        username
      );

      if (!user || !verifyPassword(String(body.password), user.password_hash)) {
        throw new AppError(401, "RESELLER_LOGIN_FAILED", "Username or password is incorrect.");
      }
      if (user.status !== "active" || user.reseller_status !== "active") {
        throw new AppError(403, "RESELLER_LOGIN_DISABLED", "This reseller account has been disabled.");
      }

      const timestamp = nowIso();
      const token = randomToken(32);
      const expiresAt = addSeconds(timestamp, config.adminSessionHours * 3600);
      run(
        db,
        `
          INSERT INTO reseller_sessions
          (id, reseller_user_id, reseller_id, token, expires_at, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        generateId("rsess"),
        user.id,
        user.reseller_id,
        token,
        expiresAt,
        timestamp,
        timestamp
      );

      run(
        db,
        "UPDATE reseller_users SET last_login_at = ?, updated_at = ? WHERE id = ?",
        timestamp,
        timestamp,
        user.id
      );

      audit(db, "reseller", user.reseller_id, "reseller.login", "reseller_user", user.id, {
        username,
        resellerCode: user.reseller_code
      });

      return {
        token,
        expiresAt,
        reseller: {
          id: user.reseller_id,
          code: user.reseller_code,
          name: user.reseller_name,
          parentResellerId: user.parent_reseller_id ?? null,
          allowViewDescendants: Boolean(user.can_view_descendants ?? 1)
        },
        user: {
          id: user.id,
          username: user.username
        }
      };
    },

    resellerMe(token) {
      const session = requireResellerSession(db, token);
      return {
        reseller: {
          id: session.reseller_id,
          code: session.reseller_code,
          name: session.reseller_name,
          parentResellerId: session.parent_reseller_id ?? null,
          allowViewDescendants: Boolean(session.can_view_descendants ?? 1)
        },
        user: {
          id: session.reseller_user_id,
          username: session.username
        },
        session: {
          id: session.id,
          expiresAt: session.expires_at
        }
      };
    },

    listScopedResellers(token, filters = {}) {
      const session = requireResellerSession(db, token);
      const includeDescendants = parseOptionalBoolean(filters.includeDescendants, "includeDescendants") === true;
      const includeSelf = parseOptionalBoolean(filters.includeSelf, "includeSelf") !== false;
      if (includeDescendants && !Boolean(session.can_view_descendants ?? 1)) {
        throw new AppError(403, "RESELLER_SCOPE_FORBIDDEN", "This reseller cannot view descendant scope.");
      }

      const ids = includeDescendants
        ? scopedResellerIds(db, session.reseller_id, true)
        : [...directChildResellerIds(db, session.reseller_id)];
      if (includeSelf) {
        ids.unshift(session.reseller_id);
      }

      const uniqueIds = [...new Set(ids)];
      if (!uniqueIds.length) {
        return {
          items: [],
          total: 0,
          scope: {
            resellerId: session.reseller_id,
            includeDescendants,
            includeSelf
          }
        };
      }

      const conditions = [`r.id IN (${uniqueIds.map(() => "?").join(", ")})`];
      const params = [...uniqueIds];
      if (filters.search) {
        const pattern = likeFilter(filters.search);
        conditions.push("(r.code LIKE ? ESCAPE '\\' OR r.name LIKE ? ESCAPE '\\' OR COALESCE(ru.username, '') LIKE ? ESCAPE '\\')");
        params.push(pattern, pattern, pattern);
      }

      const items = many(
        db,
        `
          SELECT r.*, rr.parent_reseller_id, rr.can_view_descendants,
                 COALESCE(inv.total_allocated, 0) AS total_allocated,
                 COALESCE(inv.fresh_keys, 0) AS fresh_keys,
                 COALESCE(inv.redeemed_keys, 0) AS redeemed_keys,
                 COALESCE(usr.user_count, 0) AS user_count
          FROM resellers r
          LEFT JOIN reseller_relations rr ON rr.reseller_id = r.id
          LEFT JOIN (
            SELECT reseller_id,
                   COUNT(*) AS total_allocated,
                   SUM(CASE WHEN lk.status = 'fresh' THEN 1 ELSE 0 END) AS fresh_keys,
                   SUM(CASE WHEN lk.status = 'redeemed' THEN 1 ELSE 0 END) AS redeemed_keys
            FROM reseller_inventory ri
            JOIN license_keys lk ON lk.id = ri.license_key_id
            WHERE ri.status = 'active'
            GROUP BY reseller_id
          ) inv ON inv.reseller_id = r.id
          LEFT JOIN (
            SELECT reseller_id, COUNT(*) AS user_count, MIN(username) AS username
            FROM reseller_users
            GROUP BY reseller_id
          ) ru ON ru.reseller_id = r.id
          LEFT JOIN (
            SELECT reseller_id, COUNT(*) AS user_count
            FROM reseller_users
            GROUP BY reseller_id
          ) usr ON usr.reseller_id = r.id
          WHERE ${conditions.join(" AND ")}
          ORDER BY r.created_at DESC
        `,
        ...params
      ).map(formatResellerListRow);

      return {
        items,
        total: items.length,
        scope: {
          resellerId: session.reseller_id,
          includeDescendants,
          includeSelf
        }
      };
    },

    createResellerChild(token, body = {}) {
      const session = requireResellerSession(db, token);
      requireField(body, "code");
      requireField(body, "name");
      requireField(body, "username");
      requireField(body, "password");

      const parentResellerId = body.parentResellerId ? String(body.parentResellerId).trim() : session.reseller_id;
      if (!isDescendantReseller(db, session.reseller_id, parentResellerId, true)) {
        throw new AppError(403, "RESELLER_SCOPE_FORBIDDEN", "Target parent reseller is outside your scope.");
      }

      const parentReseller = one(db, "SELECT * FROM resellers WHERE id = ?", parentResellerId);
      if (!parentReseller) {
        throw new AppError(404, "PARENT_RESELLER_NOT_FOUND", "Parent reseller does not exist.");
      }
      if (parentReseller.status !== "active") {
        throw new AppError(409, "PARENT_RESELLER_DISABLED", "Parent reseller is disabled.");
      }

      const code = normalizeResellerCode(body.code);
      if (!/^[A-Z0-9_]{3,32}$/.test(code)) {
        throw new AppError(400, "INVALID_RESELLER_CODE", "Reseller code must be 3-32 chars: A-Z, 0-9 or underscore.");
      }
      if (one(db, "SELECT id FROM resellers WHERE code = ?", code)) {
        throw new AppError(409, "RESELLER_EXISTS", "Reseller code already exists.");
      }

      const allowViewDescendants = parseOptionalBoolean(body.allowViewDescendants, "allowViewDescendants");
      const timestamp = nowIso();
      const reseller = withTransaction(db, () => {
        const created = {
          id: generateId("reseller"),
          code,
          name: String(body.name).trim(),
          contactName: String(body.contactName ?? "").trim() || null,
          contactEmail: String(body.contactEmail ?? "").trim() || null,
          status: "active",
          notes: String(body.notes ?? "").trim() || null,
          createdAt: timestamp,
          updatedAt: timestamp
        };

        run(
          db,
          `
            INSERT INTO resellers
            (id, code, name, contact_name, contact_email, status, notes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          created.id,
          created.code,
          created.name,
          created.contactName,
          created.contactEmail,
          created.status,
          created.notes,
          created.createdAt,
          created.updatedAt
        );

        createResellerRelation(
          db,
          created.id,
          parentReseller.id,
          allowViewDescendants === null ? true : allowViewDescendants,
          timestamp
        );

        const user = createResellerUserRecord(db, created.id, body.username, body.password, timestamp);
        return {
          ...created,
          parentResellerId: parentReseller.id,
          allowViewDescendants: allowViewDescendants === null ? true : allowViewDescendants,
          loginUser: {
            id: user.id,
            username: user.username,
            status: user.status
          }
        };
      });

      audit(db, "reseller", session.reseller_id, "reseller.child.create", "reseller", reseller.id, {
        parentResellerId,
        resellerCode: reseller.code,
        username: reseller.loginUser.username
      });

      return reseller;
    },

    listScopedResellerInventory(token, filters = {}) {
      const session = requireResellerSession(db, token);
      const includeDescendants = parseOptionalBoolean(filters.includeDescendants, "includeDescendants") === true;
      if (includeDescendants && !Boolean(session.can_view_descendants ?? 1)) {
        throw new AppError(403, "RESELLER_SCOPE_FORBIDDEN", "This reseller cannot view descendant scope.");
      }

      if (filters.resellerId && !isDescendantReseller(db, session.reseller_id, String(filters.resellerId).trim(), true)) {
        throw new AppError(403, "RESELLER_SCOPE_FORBIDDEN", "Requested reseller inventory is outside your scope.");
      }

      const scopeIds = scopedResellerIds(db, session.reseller_id, includeDescendants);
      const { items, filters: normalizedFilters } = queryResellerInventoryRows(db, filters, {
        scopeResellerIds: scopeIds
      });

      return {
        items,
        total: items.length,
        summary: summarizeResellerInventory(items),
        filters: {
          ...normalizedFilters,
          includeDescendants
        },
        scope: {
          resellerId: session.reseller_id,
          resellerCode: session.reseller_code
        }
      };
    },

    exportScopedResellerInventoryCsv(token, filters = {}) {
      const session = requireResellerSession(db, token);
      const includeDescendants = parseOptionalBoolean(filters.includeDescendants, "includeDescendants") === true;
      if (includeDescendants && !Boolean(session.can_view_descendants ?? 1)) {
        throw new AppError(403, "RESELLER_SCOPE_FORBIDDEN", "This reseller cannot view descendant scope.");
      }

      if (filters.resellerId && !isDescendantReseller(db, session.reseller_id, String(filters.resellerId).trim(), true)) {
        throw new AppError(403, "RESELLER_SCOPE_FORBIDDEN", "Requested reseller inventory is outside your scope.");
      }

      const { items } = queryResellerInventoryRows(db, filters, {
        scopeResellerIds: scopedResellerIds(db, session.reseller_id, includeDescendants),
        limit: 5000
      });
      const header = [
        "resellerCode",
        "productCode",
        "policyName",
        "cardKey",
        "cardStatus",
        "allocatedAt",
        "redeemedAt",
        "redeemedUsername"
      ];
      const lines = [header.map(toCsvCell).join(",")];
      for (const item of items) {
        lines.push([
          item.resellerCode,
          item.productCode,
          item.policyName,
          item.cardKey,
          item.cardStatus,
          item.allocatedAt,
          item.redeemedAt ?? "",
          item.redeemedUsername ?? ""
        ].map(toCsvCell).join(","));
      }
      return `\uFEFF${lines.join("\n")}`;
    },

    transferResellerInventory(token, body = {}) {
      const session = requireResellerSession(db, token);
      requireField(body, "targetResellerId");
      requireField(body, "policyId");

      const targetResellerId = String(body.targetResellerId).trim();
      if (!isDescendantReseller(db, session.reseller_id, targetResellerId)) {
        throw new AppError(403, "RESELLER_SCOPE_FORBIDDEN", "Target reseller must be one of your descendants.");
      }

      const targetReseller = one(db, "SELECT * FROM resellers WHERE id = ?", targetResellerId);
      if (!targetReseller) {
        throw new AppError(404, "RESELLER_NOT_FOUND", "Target reseller does not exist.");
      }
      if (targetReseller.status !== "active") {
        throw new AppError(409, "RESELLER_DISABLED", "Target reseller is disabled.");
      }

      const product = requireProductByCode(db, readProductCodeInput(body));
      const policy = one(
        db,
        "SELECT * FROM policies WHERE id = ? AND product_id = ?",
        String(body.policyId).trim(),
        product.id
      );
      if (!policy) {
        throw new AppError(404, "POLICY_NOT_FOUND", "Policy does not exist for the product.");
      }

      const count = Number(body.count ?? 1);
      if (!Number.isInteger(count) || count < 1 || count > 5000) {
        throw new AppError(400, "INVALID_BATCH_SIZE", "Batch count must be between 1 and 5000.");
      }

      const transferBatchCode = `XFER-${Date.now()}`;
      const timestamp = nowIso();
      const transfer = withTransaction(db, () => {
        const rows = many(
          db,
          `
            SELECT ri.id, ri.license_key_id, ri.notes
            FROM reseller_inventory ri
            JOIN license_keys lk ON lk.id = ri.license_key_id
            WHERE ri.reseller_id = ?
              AND ri.product_id = ?
              AND ri.policy_id = ?
              AND ri.status = 'active'
              AND lk.status = 'fresh'
            ORDER BY ri.allocated_at ASC, ri.id ASC
            LIMIT ${count}
          `,
          session.reseller_id,
          product.id,
          policy.id
        );

        if (rows.length !== count) {
          throw new AppError(409, "RESELLER_INVENTORY_SHORTAGE", "Not enough fresh cards are available for transfer.");
        }

        const targetPriceRule = resolveResellerPriceRule(db, targetReseller.id, product.id, policy.id);
        for (const row of rows) {
          run(
            db,
            `
              UPDATE reseller_inventory
              SET reseller_id = ?, allocation_batch_code = ?, allocated_at = ?, notes = ?
              WHERE id = ?
            `,
            targetReseller.id,
            transferBatchCode,
            timestamp,
            String(body.notes ?? row.notes ?? "").trim() || null,
            row.id
          );

          const snapshot = one(
            db,
            "SELECT id FROM reseller_settlement_snapshots WHERE reseller_inventory_id = ?",
            row.id
          );
          if (snapshot && !targetPriceRule) {
            run(db, "DELETE FROM reseller_settlement_snapshots WHERE reseller_inventory_id = ?", row.id);
          } else if (snapshot && targetPriceRule) {
            run(
              db,
              `
                UPDATE reseller_settlement_snapshots
                SET reseller_id = ?, price_rule_id = ?, allocation_batch_code = ?, currency = ?,
                    unit_price_cents = ?, unit_cost_cents = ?, commission_amount_cents = ?, priced_at = ?
                WHERE reseller_inventory_id = ?
              `,
              targetReseller.id,
              targetPriceRule.id,
              transferBatchCode,
              targetPriceRule.currency,
              Number(targetPriceRule.unit_price_cents),
              Number(targetPriceRule.unit_cost_cents),
              Number(targetPriceRule.unit_price_cents) - Number(targetPriceRule.unit_cost_cents),
              timestamp,
              row.id
            );
          } else if (!snapshot && targetPriceRule) {
            run(
              db,
              `
                INSERT INTO reseller_settlement_snapshots
                (id, reseller_inventory_id, reseller_id, product_id, policy_id, license_key_id, price_rule_id,
                 allocation_batch_code, currency, unit_price_cents, unit_cost_cents, commission_amount_cents,
                 priced_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `,
              generateId("rset"),
              row.id,
              targetReseller.id,
              product.id,
              policy.id,
              row.license_key_id,
              targetPriceRule.id,
              transferBatchCode,
              targetPriceRule.currency,
              Number(targetPriceRule.unit_price_cents),
              Number(targetPriceRule.unit_cost_cents),
              Number(targetPriceRule.unit_price_cents) - Number(targetPriceRule.unit_cost_cents),
              timestamp,
              timestamp
            );
          }
        }

        return rows;
      });

      audit(db, "reseller", session.reseller_id, "reseller.inventory.transfer", "reseller", targetReseller.id, {
        sourceResellerCode: session.reseller_code,
        targetResellerCode: targetReseller.code,
        productCode: product.code,
        policyId: policy.id,
        count,
        transferBatchCode
      });

      return {
        sourceReseller: {
          id: session.reseller_id,
          code: session.reseller_code,
          name: session.reseller_name
        },
        targetReseller: {
          id: targetReseller.id,
          code: targetReseller.code,
          name: targetReseller.name
        },
        productCode: product.code,
        policyId: policy.id,
        transferBatchCode,
        count: transfer.length
      };
    },

    listResellerPriceRules(token, filters = {}) {
      requireAdminSession(db, token);
      const { items, filters: normalizedFilters } = queryResellerPriceRuleRows(db, filters);
      return {
        items,
        total: items.length,
        filters: normalizedFilters
      };
    },

    createResellerPriceRule(token, body = {}) {
      const admin = requireAdminSession(db, token);
      requireField(body, "resellerId");
      requireField(body, "unitPrice");

      const reseller = one(db, "SELECT * FROM resellers WHERE id = ?", String(body.resellerId).trim());
      if (!reseller) {
        throw new AppError(404, "RESELLER_NOT_FOUND", "Reseller does not exist.");
      }

      const product = requireProductByCode(db, readProductCodeInput(body));
      const policyId = body.policyId ? String(body.policyId).trim() : null;
      const policy = policyId
        ? one(db, "SELECT * FROM policies WHERE id = ? AND product_id = ?", policyId, product.id)
        : null;
      if (policyId && !policy) {
        throw new AppError(404, "POLICY_NOT_FOUND", "Policy does not exist for the product.");
      }

      const status = String(body.status ?? "active").trim().toLowerCase();
      if (!["active", "archived"].includes(status)) {
        throw new AppError(400, "INVALID_PRICE_RULE_STATUS", "Price rule status must be active or archived.");
      }

      const currency = normalizeCurrency(body.currency);
      const unitPriceCents = parseMoneyToCents(body.unitPrice, "unitPrice");
      const unitCostCents = parseMoneyToCents(body.unitCost ?? 0, "unitCost");
      if (unitCostCents > unitPriceCents) {
        throw new AppError(400, "INVALID_PRICE_RULE_COST", "unitCost cannot exceed unitPrice.");
      }

      const duplicateActive = one(
        db,
        `
          SELECT id
          FROM reseller_price_rules
          WHERE reseller_id = ?
            AND product_id = ?
            AND ((policy_id = ?) OR (policy_id IS NULL AND ? IS NULL))
            AND status = 'active'
        `,
        reseller.id,
        product.id,
        policyId,
        policyId
      );
      if (status === "active" && duplicateActive) {
        throw new AppError(409, "PRICE_RULE_EXISTS", "An active reseller price rule already exists for this scope.");
      }

      const timestamp = nowIso();
      const id = generateId("rprice");
      run(
        db,
        `
          INSERT INTO reseller_price_rules
          (id, reseller_id, product_id, policy_id, status, currency, unit_price_cents, unit_cost_cents, notes, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        id,
        reseller.id,
        product.id,
        policy?.id ?? null,
        status,
        currency,
        unitPriceCents,
        unitCostCents,
        String(body.notes ?? "").trim() || null,
        timestamp,
        timestamp
      );

      audit(db, "admin", admin.admin_id, "reseller-price-rule.create", "reseller_price_rule", id, {
        resellerCode: reseller.code,
        productCode: product.code,
        policyId: policy?.id ?? null,
        currency,
        unitPriceCents,
        unitCostCents,
        status
      });

      return formatResellerPriceRuleRow(one(
        db,
        `
          SELECT rpr.*, rs.code AS reseller_code, rs.name AS reseller_name,
                 pr.code AS product_code, pr.name AS product_name,
                 pol.name AS policy_name
          FROM reseller_price_rules rpr
          JOIN resellers rs ON rs.id = rpr.reseller_id
          JOIN products pr ON pr.id = rpr.product_id
          LEFT JOIN policies pol ON pol.id = rpr.policy_id
          WHERE rpr.id = ?
        `,
        id
      ));
    },

    updateResellerPriceRuleStatus(token, ruleId, body = {}) {
      const admin = requireAdminSession(db, token);
      const row = one(
        db,
        `
          SELECT rpr.*, rs.code AS reseller_code, rs.name AS reseller_name,
                 pr.code AS product_code, pr.name AS product_name,
                 pol.name AS policy_name
          FROM reseller_price_rules rpr
          JOIN resellers rs ON rs.id = rpr.reseller_id
          JOIN products pr ON pr.id = rpr.product_id
          LEFT JOIN policies pol ON pol.id = rpr.policy_id
          WHERE rpr.id = ?
        `,
        ruleId
      );
      if (!row) {
        throw new AppError(404, "PRICE_RULE_NOT_FOUND", "Reseller price rule does not exist.");
      }

      const status = String(body.status ?? "").trim().toLowerCase();
      if (!["active", "archived"].includes(status)) {
        throw new AppError(400, "INVALID_PRICE_RULE_STATUS", "Price rule status must be active or archived.");
      }

      if (status === "active") {
        const duplicateActive = one(
          db,
          `
            SELECT id
            FROM reseller_price_rules
            WHERE reseller_id = ?
              AND product_id = ?
              AND ((policy_id = ?) OR (policy_id IS NULL AND ? IS NULL))
              AND status = 'active'
              AND id <> ?
          `,
          row.reseller_id,
          row.product_id,
          row.policy_id,
          row.policy_id,
          row.id
        );
        if (duplicateActive) {
          throw new AppError(409, "PRICE_RULE_EXISTS", "Another active reseller price rule already exists for this scope.");
        }
      }

      const timestamp = nowIso();
      run(
        db,
        `
          UPDATE reseller_price_rules
          SET status = ?, updated_at = ?
          WHERE id = ?
        `,
        status,
        timestamp,
        row.id
      );

      audit(db, "admin", admin.admin_id, "reseller-price-rule.status", "reseller_price_rule", row.id, {
        resellerCode: row.reseller_code,
        productCode: row.product_code,
        policyId: row.policy_id ?? null,
        status
      });

      return formatResellerPriceRuleRow({
        ...row,
        status,
        updated_at: timestamp
      });
    },

    allocateResellerInventory(token, resellerId, body) {
      const admin = requireAdminSession(db, token);
      requireField(body, "policyId");

      const reseller = one(db, "SELECT * FROM resellers WHERE id = ?", resellerId);
      if (!reseller) {
        throw new AppError(404, "RESELLER_NOT_FOUND", "Reseller does not exist.");
      }
      if (reseller.status !== "active") {
        throw new AppError(409, "RESELLER_DISABLED", "Reseller is disabled and cannot receive inventory.");
      }

      const product = requireProductByCode(db, readProductCodeInput(body));
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

      const allocationResult = withTransaction(db, () => {
        const priceRule = resolveResellerPriceRule(db, reseller.id, product.id, policy.id);
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
          const inventoryId = generateId("rstock");
          run(
            db,
            `
              INSERT INTO reseller_inventory
              (id, reseller_id, product_id, policy_id, license_key_id, allocation_batch_code, notes, allocated_at, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
            `,
            inventoryId,
            reseller.id,
            product.id,
            policy.id,
            entry.licenseKeyId,
            allocationBatchCode,
            String(body.notes ?? "") || null,
            allocatedAt
          );

          if (priceRule) {
            run(
              db,
              `
                INSERT INTO reseller_settlement_snapshots
                (id, reseller_inventory_id, reseller_id, product_id, policy_id, license_key_id, price_rule_id,
                 allocation_batch_code, currency, unit_price_cents, unit_cost_cents, commission_amount_cents,
                 priced_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `,
              generateId("rset"),
              inventoryId,
              reseller.id,
              product.id,
              policy.id,
              entry.licenseKeyId,
              priceRule.id,
              allocationBatchCode,
              priceRule.currency,
              Number(priceRule.unit_price_cents),
              Number(priceRule.unit_cost_cents),
              Number(priceRule.unit_price_cents) - Number(priceRule.unit_cost_cents),
              allocatedAt,
              allocatedAt
            );
          }
        }

        return { issued, priceRule };
      });
      const keys = allocationResult.issued;
      const priceRule = allocationResult.priceRule;

      audit(db, "admin", admin.admin_id, "reseller.inventory.allocate", "reseller", reseller.id, {
        resellerCode: reseller.code,
        productCode: product.code,
        policyId: policy.id,
        count,
        allocationBatchCode,
        priceRuleId: priceRule?.id ?? null
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
        pricing: priceRule
          ? {
              ruleId: priceRule.id,
              currency: priceRule.currency,
              unitPriceCents: Number(priceRule.unit_price_cents),
              unitPrice: centsToAmount(priceRule.unit_price_cents),
              unitCostCents: Number(priceRule.unit_cost_cents),
              unitCost: centsToAmount(priceRule.unit_cost_cents),
              unitCommissionCents: Number(priceRule.unit_price_cents) - Number(priceRule.unit_cost_cents),
              unitCommission: centsToAmount(Number(priceRule.unit_price_cents) - Number(priceRule.unit_cost_cents)),
              grossAllocatedCents: Number(priceRule.unit_price_cents) * count,
              grossAllocated: centsToAmount(Number(priceRule.unit_price_cents) * count),
              costAllocatedCents: Number(priceRule.unit_cost_cents) * count,
              costAllocated: centsToAmount(Number(priceRule.unit_cost_cents) * count),
              commissionAllocatedCents: (Number(priceRule.unit_price_cents) - Number(priceRule.unit_cost_cents)) * count,
              commissionAllocated: centsToAmount((Number(priceRule.unit_price_cents) - Number(priceRule.unit_cost_cents)) * count)
            }
          : null,
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

    resellerSettlementReport(token, filters = {}) {
      requireAdminSession(db, token);
      const { items, filters: normalizedFilters } = queryResellerSettlementRows(db, filters);
      const summary = summarizeResellerSettlement(items);
      const resellerGroups = new Map();
      const productGroups = new Map();

      for (const item of items) {
        const resellerKey = `${item.resellerId}:${item.currency ?? "UNPRICED"}`;
        const resellerEntry = resellerGroups.get(resellerKey) ?? {
          resellerId: item.resellerId,
          resellerCode: item.resellerCode,
          resellerName: item.resellerName,
          resellerStatus: item.resellerStatus,
          currency: item.currency ?? "UNPRICED",
          ...createEmptySettlementSummary()
        };
        resellerEntry.totalKeys += 1;
        if (item.cardStatus === "redeemed") {
          resellerEntry.redeemedKeys += 1;
        }
        if (item.priced) {
          resellerEntry.pricedKeys += 1;
          resellerEntry.grossAllocatedCents += item.unitPriceCents;
          resellerEntry.costAllocatedCents += item.unitCostCents;
          resellerEntry.commissionAllocatedCents += item.commissionAmountCents;
          if (item.cardStatus === "redeemed") {
            resellerEntry.pricedRedeemedKeys += 1;
            resellerEntry.grossRedeemedCents += item.unitPriceCents;
            resellerEntry.costRedeemedCents += item.unitCostCents;
            resellerEntry.commissionRedeemedCents += item.commissionAmountCents;
          }
        } else {
          resellerEntry.unpricedKeys += 1;
        }
        resellerGroups.set(resellerKey, resellerEntry);

        const productKey = `${item.productCode}:${item.currency ?? "UNPRICED"}`;
        const productEntry = productGroups.get(productKey) ?? {
          productCode: item.productCode,
          productName: item.productName,
          currency: item.currency ?? "UNPRICED",
          ...createEmptySettlementSummary()
        };
        productEntry.totalKeys += 1;
        if (item.cardStatus === "redeemed") {
          productEntry.redeemedKeys += 1;
        }
        if (item.priced) {
          productEntry.pricedKeys += 1;
          productEntry.grossAllocatedCents += item.unitPriceCents;
          productEntry.costAllocatedCents += item.unitCostCents;
          productEntry.commissionAllocatedCents += item.commissionAmountCents;
          if (item.cardStatus === "redeemed") {
            productEntry.pricedRedeemedKeys += 1;
            productEntry.grossRedeemedCents += item.unitPriceCents;
            productEntry.costRedeemedCents += item.unitCostCents;
            productEntry.commissionRedeemedCents += item.commissionAmountCents;
          }
        } else {
          productEntry.unpricedKeys += 1;
        }
        productGroups.set(productKey, productEntry);
      }

      const finalizeGroup = (group) => ({
        ...group,
        grossAllocated: centsToAmount(group.grossAllocatedCents),
        costAllocated: centsToAmount(group.costAllocatedCents),
        commissionAllocated: centsToAmount(group.commissionAllocatedCents),
        grossRedeemed: centsToAmount(group.grossRedeemedCents),
        costRedeemed: centsToAmount(group.costRedeemedCents),
        commissionRedeemed: centsToAmount(group.commissionRedeemedCents)
      });

      return {
        totals: {
          ...summary.totals,
          resellerGroupCount: resellerGroups.size,
          productGroupCount: productGroups.size
        },
        byCurrency: summary.byCurrency.sort((left, right) => left.currency.localeCompare(right.currency)),
        byReseller: Array.from(resellerGroups.values())
          .map(finalizeGroup)
          .sort((left, right) => right.commissionRedeemedCents - left.commissionRedeemedCents),
        byProduct: Array.from(productGroups.values())
          .map(finalizeGroup)
          .sort((left, right) => right.grossRedeemedCents - left.grossRedeemedCents),
        filters: normalizedFilters
      };
    },

    exportResellerSettlementCsv(token, filters = {}) {
      requireAdminSession(db, token);
      const { items } = queryResellerSettlementRows(db, filters);

      const header = [
        "resellerId",
        "resellerCode",
        "resellerName",
        "productCode",
        "productName",
        "policyId",
        "policyName",
        "allocationBatchCode",
        "cardKey",
        "cardStatus",
        "redeemedUsername",
        "currency",
        "unitPrice",
        "unitCost",
        "unitCommission",
        "allocatedAt",
        "redeemedAt",
        "pricedAt"
      ];

      const lines = [
        header.map(toCsvCell).join(","),
        ...items.map((item) => ([
          item.resellerId,
          item.resellerCode,
          item.resellerName,
          item.productCode,
          item.productName,
          item.policyId,
          item.policyName,
          item.allocationBatchCode,
          item.cardKey,
          item.cardStatus,
          item.redeemedUsername ?? "",
          item.currency ?? "",
          item.unitPrice === null ? "" : item.unitPrice.toFixed(2),
          item.unitCost === null ? "" : item.unitCost.toFixed(2),
          item.commissionAmount === null ? "" : item.commissionAmount.toFixed(2),
          item.allocatedAt,
          item.redeemedAt ?? "",
          item.pricedAt ?? ""
        ].map(toCsvCell).join(",")))
      ];

      return lines.join("\r\n");
    },

    listResellerStatements(token, filters = {}) {
      requireAdminSession(db, token);
      const { items, filters: normalizedFilters } = queryResellerStatementRows(db, filters);
      return {
        items,
        total: items.length,
        filters: normalizedFilters
      };
    },

    createResellerStatement(token, body = {}) {
      const admin = requireAdminSession(db, token);
      requireField(body, "resellerId");
      requireField(body, "currency");

      const reseller = one(db, "SELECT * FROM resellers WHERE id = ?", String(body.resellerId).trim());
      if (!reseller) {
        throw new AppError(404, "RESELLER_NOT_FOUND", "Reseller does not exist.");
      }

      const currency = normalizeCurrency(body.currency);
      const productCode = readProductCodeInput(body, false);
      const product = productCode ? requireProductByCode(db, productCode) : null;
      const eligible = listEligibleResellerStatementSnapshots(db, {
        resellerId: reseller.id,
        currency,
        productCode: product?.code ?? null
      });

      if (!eligible.length) {
        throw new AppError(409, "NO_SETTLEMENT_ITEMS", "No redeemed settlement items are eligible for a new statement.");
      }

      const itemCount = eligible.length;
      const grossAmountCents = eligible.reduce((sum, item) => sum + item.unitPriceCents, 0);
      const costAmountCents = eligible.reduce((sum, item) => sum + item.unitCostCents, 0);
      const commissionAmountCents = eligible.reduce((sum, item) => sum + item.commissionAmountCents, 0);
      const periodStart = eligible.reduce((best, item) => !best || item.redeemedAt < best ? item.redeemedAt : best, null);
      const periodEnd = eligible.reduce((best, item) => !best || item.redeemedAt > best ? item.redeemedAt : best, null);
      const timestamp = nowIso();
      const statementId = generateId("rstmt");
      const statementCode = `SETTLE-${Date.now()}`;
      const notes = String(body.notes ?? "").trim() || null;

      withTransaction(db, () => {
        run(
          db,
          `
            INSERT INTO reseller_statements
            (id, reseller_id, currency, statement_code, status, product_id, period_start, period_end, item_count,
             gross_amount_cents, cost_amount_cents, commission_amount_cents, notes, created_at, updated_at, paid_at)
            VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
          `,
          statementId,
          reseller.id,
          currency,
          statementCode,
          product?.id ?? null,
          periodStart,
          periodEnd,
          itemCount,
          grossAmountCents,
          costAmountCents,
          commissionAmountCents,
          notes,
          timestamp,
          timestamp
        );

        for (const item of eligible) {
          run(
            db,
            `
              INSERT INTO reseller_statement_items
              (id, statement_id, settlement_snapshot_id, reseller_inventory_id, license_key_id, redeemed_at,
               gross_amount_cents, cost_amount_cents, commission_amount_cents, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            generateId("rstmti"),
            statementId,
            item.settlementSnapshotId,
            item.resellerInventoryId,
            item.licenseKeyId,
            item.redeemedAt,
            item.unitPriceCents,
            item.unitCostCents,
            item.commissionAmountCents,
            timestamp
          );
        }
      });

      audit(db, "admin", admin.admin_id, "reseller-statement.create", "reseller_statement", statementId, {
        resellerCode: reseller.code,
        currency,
        productCode: product?.code ?? null,
        itemCount,
        commissionAmountCents
      });

      return formatResellerStatementRow(one(
        db,
        `
          SELECT rs.*, rr.code AS reseller_code, rr.name AS reseller_name,
                 pr.code AS product_code, pr.name AS product_name
          FROM reseller_statements rs
          JOIN resellers rr ON rr.id = rs.reseller_id
          LEFT JOIN products pr ON pr.id = rs.product_id
          WHERE rs.id = ?
        `,
        statementId
      ));
    },

    listResellerStatementItems(token, statementId) {
      requireAdminSession(db, token);
      const statement = one(
        db,
        `
          SELECT rs.*, rr.code AS reseller_code, rr.name AS reseller_name,
                 pr.code AS product_code, pr.name AS product_name
          FROM reseller_statements rs
          JOIN resellers rr ON rr.id = rs.reseller_id
          LEFT JOIN products pr ON pr.id = rs.product_id
          WHERE rs.id = ?
        `,
        statementId
      );
      if (!statement) {
        throw new AppError(404, "STATEMENT_NOT_FOUND", "Reseller statement does not exist.");
      }

      const items = queryResellerStatementItems(db, statementId);
      return {
        statement: formatResellerStatementRow(statement),
        items,
        total: items.length
      };
    },

    updateResellerStatementStatus(token, statementId, body = {}) {
      const admin = requireAdminSession(db, token);
      const statement = one(
        db,
        `
          SELECT rs.*, rr.code AS reseller_code, rr.name AS reseller_name,
                 pr.code AS product_code, pr.name AS product_name
          FROM reseller_statements rs
          JOIN resellers rr ON rr.id = rs.reseller_id
          LEFT JOIN products pr ON pr.id = rs.product_id
          WHERE rs.id = ?
        `,
        statementId
      );
      if (!statement) {
        throw new AppError(404, "STATEMENT_NOT_FOUND", "Reseller statement does not exist.");
      }

      const nextStatus = normalizeStatementStatus(body.status);
      const order = { draft: 0, reviewed: 1, paid: 2 };
      if (order[nextStatus] < order[statement.status]) {
        throw new AppError(409, "INVALID_STATEMENT_TRANSITION", "Statement status cannot move backwards.");
      }

      if (nextStatus === statement.status) {
        return formatResellerStatementRow(statement);
      }

      const timestamp = nowIso();
      run(
        db,
        `
          UPDATE reseller_statements
          SET status = ?, updated_at = ?, paid_at = ?
          WHERE id = ?
        `,
        nextStatus,
        timestamp,
        nextStatus === "paid" ? timestamp : statement.paid_at,
        statement.id
      );

      audit(db, "admin", admin.admin_id, "reseller-statement.status", "reseller_statement", statement.id, {
        resellerCode: statement.reseller_code,
        statementCode: statement.statement_code,
        fromStatus: statement.status,
        status: nextStatus
      });

      return formatResellerStatementRow({
        ...statement,
        status: nextStatus,
        updated_at: timestamp,
        paid_at: nextStatus === "paid" ? timestamp : statement.paid_at
      });
    },

    exportResellerStatementCsv(token, statementId) {
      requireAdminSession(db, token);
      const statement = one(
        db,
        `
          SELECT rs.*, rr.code AS reseller_code, rr.name AS reseller_name,
                 pr.code AS product_code, pr.name AS product_name
          FROM reseller_statements rs
          JOIN resellers rr ON rr.id = rs.reseller_id
          LEFT JOIN products pr ON pr.id = rs.product_id
          WHERE rs.id = ?
        `,
        statementId
      );
      if (!statement) {
        throw new AppError(404, "STATEMENT_NOT_FOUND", "Reseller statement does not exist.");
      }

      const items = queryResellerStatementItems(db, statementId);
      const header = [
        "statementCode",
        "statementStatus",
        "resellerCode",
        "resellerName",
        "productCode",
        "policyName",
        "cardKey",
        "redeemedUsername",
        "currency",
        "grossAmount",
        "costAmount",
        "commissionAmount",
        "redeemedAt"
      ];

      const lines = [
        header.map(toCsvCell).join(","),
        ...items.map((item) => ([
          item.statementCode,
          item.statementStatus,
          item.resellerCode,
          item.resellerName,
          item.productCode ?? "",
          item.policyName,
          item.cardKey,
          item.redeemedUsername ?? "",
          item.currency,
          item.grossAmount.toFixed(2),
          item.costAmount.toFixed(2),
          item.commissionAmount.toFixed(2),
          item.redeemedAt
        ].map(toCsvCell).join(",")))
      ];

      return lines.join("\r\n");
    },

    async dashboard(token) {
      requireAdminSession(db, token);
      expireStaleSessions(db, stateStore);

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
        onlineSessions: await stateStore.countActiveSessions()
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
      return queryAccountRows(db, filters, stateStore);
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
          revokedSessions = expireActiveSessions(
            db,
            stateStore,
            "account_id = ?",
            [account.id],
            "account_disabled"
          );
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
      return queryDeviceBindingRows(db, filters, stateStore);
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
        const releasedSessions = releaseBindingRecord(db, stateStore, binding, reason, timestamp);

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

    developerListDeviceBindings(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.read",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only view device bindings under your assigned projects."
      );
      if (filters.productCode) {
        requireDeveloperOwnedProductByCode(
          db,
          session,
          String(filters.productCode).trim().toUpperCase(),
          "ops.read"
        );
      }
      return queryDeviceBindingRows(
        db,
        { ...filters, productIds: listDeveloperAccessibleProductIds(db, session) },
        stateStore
      );
    },

    developerReleaseDeviceBinding(token, bindingId, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage device bindings under your assigned projects."
      );
      const binding = one(
        db,
        `
          SELECT b.id, b.entitlement_id, b.device_id, b.status,
                 pr.id AS product_id, pr.code AS product_code, pr.owner_developer_id,
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

      ensureDeveloperCanAccessProduct(
        db,
        session,
        { id: binding.product_id, owner_developer_id: binding.owner_developer_id },
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage device bindings under your assigned projects."
      );

      if (binding.status !== "active") {
        return {
          ...binding,
          changed: false,
          releasedSessions: 0
        };
      }

      return withTransaction(db, () => {
        const timestamp = nowIso();
        const reason = normalizeReason(body.reason, "developer_binding_released");
        const releasedSessions = releaseBindingRecord(db, stateStore, binding, reason, timestamp);

        auditDeveloperSession(db, session, "device-binding.release", "device_binding", binding.id, {
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
      return queryDeviceBlockRows(db, filters);
    },

    developerListDeviceBlocks(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.read",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only view device blocks under your assigned projects."
      );
      if (filters.productCode) {
        requireDeveloperOwnedProductByCode(
          db,
          session,
          String(filters.productCode).trim().toUpperCase(),
          "ops.read"
        );
      }
      return queryDeviceBlockRows(db, {
        ...filters,
        productIds: listDeveloperAccessibleProductIds(db, session)
      });
    },

    blockDevice(token, body = {}) {
      const admin = requireAdminSession(db, token);
      requireField(body, "deviceFingerprint");

      const product = requireProductByCode(db, readProductCodeInput(body));
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
          affectedSessions = expireActiveSessions(
            db,
            stateStore,
            "product_id = ? AND device_id = ?",
            [product.id, device.id],
            "device_blocked"
          );

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

    developerBlockDevice(token, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage device blocks under your assigned projects."
      );
      requireField(body, "deviceFingerprint");

      const product = requireDeveloperOwnedProductByCode(db, session, readProductCodeInput(body), "ops.write");
      const fingerprint = String(body.deviceFingerprint).trim();
      if (fingerprint.length < 6) {
        throw new AppError(400, "INVALID_DEVICE_FINGERPRINT", "Device fingerprint must be at least 6 characters.");
      }

      const reason = normalizeReason(body.reason, "developer_blocked");
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
          affectedSessions = expireActiveSessions(
            db,
            stateStore,
            "product_id = ? AND device_id = ?",
            [product.id, device.id],
            "device_blocked"
          );

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
          auditDeveloperSession(db, session, "device-block.activate", "device_block", blockId, {
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

    developerUnblockDevice(token, blockId, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage device blocks under your assigned projects."
      );
      const block = one(
        db,
        `
          SELECT b.*, pr.code AS product_code, pr.owner_developer_id
          FROM device_blocks b
          JOIN products pr ON pr.id = b.product_id
          WHERE b.id = ?
        `,
        blockId
      );

      if (!block) {
        throw new AppError(404, "DEVICE_BLOCK_NOT_FOUND", "Device block does not exist.");
      }

      ensureDeveloperCanAccessProduct(
        db,
        session,
        { id: block.product_id, owner_developer_id: block.owner_developer_id },
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage device blocks under your assigned projects."
      );

      const releaseReason = normalizeReason(body.reason, "developer_unblocked");
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

      auditDeveloperSession(db, session, "device-block.release", "device_block", block.id, {
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
      return queryClientVersionRows(db, filters);
    },

    developerListClientVersions(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "versions.read",
        "DEVELOPER_CLIENT_VERSION_FORBIDDEN",
        "You can only view client versions under your assigned projects."
      );
      if (filters.productCode) {
        requireDeveloperOwnedProductByCode(
          db,
          session,
          String(filters.productCode).trim().toUpperCase(),
          "versions.read"
        );
      }
      return queryClientVersionRows(db, {
        ...filters,
        productIds: listDeveloperAccessibleProductIds(db, session)
      });
    },

    createClientVersion(token, body = {}) {
      const admin = requireAdminSession(db, token);
      requireField(body, "version");

      const product = requireProductByCode(db, readProductCodeInput(body));
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

    developerCreateClientVersion(token, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "versions.write",
        "DEVELOPER_CLIENT_VERSION_FORBIDDEN",
        "You can only manage client versions under your assigned projects."
      );
      requireField(body, "version");

      const product = requireDeveloperOwnedProductByCode(db, session, readProductCodeInput(body), "versions.write");
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

      auditDeveloperSession(db, session, "client-version.create", "client_version", id, {
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

    developerUpdateClientVersionStatus(token, versionId, body = {}) {
      const session = requireDeveloperSession(db, token);
      const row = requireDeveloperOwnedClientVersion(db, session, versionId, "versions.write");

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

      auditDeveloperSession(db, session, "client-version.status", "client_version", row.id, {
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
      return queryNoticeRows(db, filters);
    },

    developerListNotices(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "notices.read",
        "DEVELOPER_NOTICE_FORBIDDEN",
        "You can only view notices under your assigned projects."
      );
      if (filters.productCode) {
        requireDeveloperOwnedProductByCode(
          db,
          session,
          String(filters.productCode).trim().toUpperCase(),
          "notices.read"
        );
      }
      return queryNoticeRows(db, {
        ...filters,
        productIds: listDeveloperAccessibleProductIds(db, session)
      });
    },

    createNotice(token, body = {}) {
      const admin = requireAdminSession(db, token);
      requireField(body, "title");
      requireField(body, "body");

      const productCode = readProductCodeInput(body, false);
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

    developerCreateNotice(token, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "notices.write",
        "DEVELOPER_NOTICE_FORBIDDEN",
        "You can only manage notices under your assigned projects."
      );
      requireField(body, "title");
      requireField(body, "body");

      const product = requireDeveloperOwnedProductByCode(db, session, readProductCodeInput(body), "notices.write");
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
        product.id,
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

      auditDeveloperSession(db, session, "notice.create", "notice", id, {
        productCode: product.code,
        channel,
        kind,
        severity,
        status,
        blockLogin: Boolean(blockLogin)
      });

      return {
        id,
        productCode: product.code,
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

    developerUpdateNoticeStatus(token, noticeId, body = {}) {
      const session = requireDeveloperSession(db, token);
      const row = requireDeveloperOwnedNotice(db, session, noticeId, "notices.write");

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

      auditDeveloperSession(db, session, "notice.status", "notice", row.id, {
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

    async clientNotices(reqLike, body, rawBody) {
      const product = await requireSignedProduct(db, config, stateStore, reqLike, rawBody);
      requireSignedProductCodeMatch(product, body);

      const featureConfig = loadProductFeatureConfig(db, product.id, product.updated_at ?? null);
      if (!featureConfig.allowNotices) {
        return buildDisabledNoticeManifest(product, body.channel);
      }

      const notices = activeNoticesForProduct(db, product.id, body.channel).map(formatNotice);
      return {
        productCode: product.code,
        channel: normalizeNoticeChannel(body.channel, "stable"),
        enabled: true,
        notices
      };
    },

    listNetworkRules(token, filters = {}) {
      requireAdminSession(db, token);
      return queryNetworkRuleRows(db, filters);
    },

    developerListNetworkRules(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "products.read",
        "DEVELOPER_NETWORK_RULE_FORBIDDEN",
        "You can only view network rules under your assigned projects."
      );
      if (filters.productCode) {
        requireDeveloperOwnedProductByCode(
          db,
          session,
          String(filters.productCode).trim().toUpperCase(),
          "products.read"
        );
      }
      return queryNetworkRuleRows(db, {
        ...filters,
        productIds: listDeveloperAccessibleProductIds(db, session)
      });
    },

    createNetworkRule(token, body = {}) {
      const admin = requireAdminSession(db, token);
      requireField(body, "pattern");

      const productCode = readProductCodeInput(body, false);
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

    developerCreateNetworkRule(token, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "products.write",
        "DEVELOPER_NETWORK_RULE_FORBIDDEN",
        "You can only manage network rules under your assigned projects."
      );
      requireField(body, "pattern");

      const product = requireDeveloperOwnedProductByCode(
        db,
        session,
        readProductCodeInput(body),
        "products.write"
      );
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
        product.id,
        targetType,
        pattern,
        actionScope,
        decision,
        status,
        notes || null,
        timestamp,
        timestamp
      );

      auditDeveloperSession(db, session, "network-rule.create", "network_rule", id, {
        productCode: product.code,
        targetType,
        pattern,
        actionScope,
        status
      });

      return {
        id,
        productCode: product.code,
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

    developerUpdateNetworkRuleStatus(token, ruleId, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "products.write",
        "DEVELOPER_NETWORK_RULE_FORBIDDEN",
        "You can only manage network rules under your assigned projects."
      );
      const row = one(
        db,
        `
          SELECT nr.*, pr.code AS product_code, pr.owner_developer_id
          FROM network_rules nr
          LEFT JOIN products pr ON pr.id = nr.product_id
          WHERE nr.id = ?
        `,
        ruleId
      );

      if (!row) {
        throw new AppError(404, "NETWORK_RULE_NOT_FOUND", "Network rule does not exist.");
      }
      if (!row.product_id) {
        throw new AppError(403, "DEVELOPER_NETWORK_RULE_FORBIDDEN", "Developers cannot manage global network rules.");
      }

      ensureDeveloperCanAccessProduct(
        db,
        session,
        { id: row.product_id, owner_developer_id: row.owner_developer_id },
        "products.write",
        "DEVELOPER_NETWORK_RULE_FORBIDDEN",
        "You can only manage network rules under your assigned projects."
      );

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

      auditDeveloperSession(db, session, "network-rule.status", "network_rule", row.id, {
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
      return querySessionRows(db, filters, stateStore);
    },

    developerListSessions(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.read",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only view sessions under your assigned projects."
      );
      if (filters.productCode) {
        requireDeveloperOwnedProductByCode(
          db,
          session,
          String(filters.productCode).trim().toUpperCase(),
          "ops.read"
        );
      }
      return querySessionRows(
        db,
        { ...filters, productIds: listDeveloperAccessibleProductIds(db, session) },
        stateStore
      );
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

      expireSessionById(db, stateStore, session.id, reason);

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

    developerRevokeSession(token, sessionId, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage sessions under your assigned projects."
      );
      const targetSession = one(
        db,
        `
          SELECT s.id, s.status, s.revoked_reason, s.product_id,
                 pr.code AS product_code, pr.owner_developer_id,
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

      if (!targetSession) {
        throw new AppError(404, "SESSION_NOT_FOUND", "Session does not exist.");
      }

      ensureDeveloperCanAccessProduct(
        db,
        session,
        { id: targetSession.product_id, owner_developer_id: targetSession.owner_developer_id },
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage sessions under your assigned projects."
      );

      const reason = normalizeReason(body.reason, "developer_revoked");
      if (targetSession.status !== "active") {
        return {
          ...targetSession,
          changed: false,
          revokedReason: targetSession.revoked_reason ?? reason
        };
      }

      expireSessionById(db, stateStore, targetSession.id, reason);

      auditDeveloperSession(db, session, "session.revoke", "session", targetSession.id, {
        productCode: targetSession.product_code,
        username: targetSession.username,
        fingerprint: targetSession.fingerprint,
        reason
      });

      return {
        ...targetSession,
        status: "expired",
        changed: true,
        revokedReason: reason
      };
    },

    listAuditLogs(token, filters = {}) {
      requireAdminSession(db, token);
      return queryAuditLogRows(db, filters);
    },

    developerListAuditLogs(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.read",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only view audit logs for your assigned projects."
      );
      return queryAuditLogRows(db, {
        ...filters,
        developerId: session.developer_id,
        productCodes: listDeveloperAccessibleProductCodes(db, session)
      });
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

    async checkClientVersion(reqLike, body, rawBody) {
      const product = await requireSignedProduct(db, config, stateStore, reqLike, rawBody);
      requireField(body, "clientVersion");
      requireSignedProductCodeMatch(product, body);

      const featureConfig = loadProductFeatureConfig(db, product.id, product.updated_at ?? null);
      if (!featureConfig.allowVersionCheck) {
        return buildDisabledVersionManifest(product, String(body.clientVersion).trim(), body.channel);
      }

      return buildVersionManifest(
        db,
        product,
        String(body.clientVersion).trim(),
        body.channel
      );
    },

    async clientBindings(reqLike, body, rawBody, meta = {}) {
      const product = await requireSignedProduct(db, config, stateStore, reqLike, rawBody);
      requireSignedProductCodeMatch(product, body);

      const productFeatureConfig = loadProductFeatureConfig(db, product.id, product.updated_at ?? null);
      enforceNetworkRules(db, product, meta.ip, "login");

      return withTransaction(db, () => {
        const subject = resolveClientManagedAccount(db, product, body);
        const unbindConfig = loadPolicyUnbindConfig(db, subject.entitlement.policy_id, subject.entitlement.updated_at);
        const bindings = queryBindingsForEntitlement(db, subject.entitlement.id);
        const recentClientUnbinds = countRecentClientUnbinds(
          db,
          subject.entitlement.id,
          unbindConfig.clientUnbindWindowDays
        );
        const allowClientUnbind = productFeatureConfig.allowClientUnbind && unbindConfig.allowClientUnbind;

        return {
          authMode: subject.authMode,
          account: {
            id: subject.account.id,
            username: subject.account.username
          },
          entitlement: {
            id: subject.entitlement.id,
            policyName: subject.entitlement.policy_name,
            endsAt: subject.entitlement.ends_at,
            status: subject.entitlement.status
          },
          bindings,
          unbindPolicy: {
            allowClientUnbind,
            productFeatureEnabled: productFeatureConfig.allowClientUnbind,
            clientUnbindLimit: unbindConfig.clientUnbindLimit,
            clientUnbindWindowDays: unbindConfig.clientUnbindWindowDays,
            clientUnbindDeductDays: unbindConfig.clientUnbindDeductDays,
            recentClientUnbinds,
            remainingClientUnbinds: unbindConfig.clientUnbindLimit > 0
              ? Math.max(0, unbindConfig.clientUnbindLimit - recentClientUnbinds)
              : null
          }
        };
      });
    },

    async clientUnbind(reqLike, body, rawBody, meta = {}) {
      const product = await requireSignedProduct(db, config, stateStore, reqLike, rawBody);
      requireSignedProductCodeMatch(product, body);

      requireProductFeatureEnabled(
        db,
        product,
        "allowClientUnbind",
        "CLIENT_UNBIND_DISABLED_BY_PRODUCT",
        "Client self-unbind is disabled for this product."
      );

      enforceNetworkRules(db, product, meta.ip, "login");

      return withTransaction(db, () => {
        const subject = resolveClientManagedAccount(db, product, body);
        const unbindConfig = loadPolicyUnbindConfig(db, subject.entitlement.policy_id, subject.entitlement.updated_at);
        if (!unbindConfig.allowClientUnbind) {
          throw new AppError(403, "CLIENT_UNBIND_DISABLED", "Self-service unbind is disabled for this policy.");
        }

        const recentClientUnbinds = countRecentClientUnbinds(
          db,
          subject.entitlement.id,
          unbindConfig.clientUnbindWindowDays
        );
        if (unbindConfig.clientUnbindLimit > 0 && recentClientUnbinds >= unbindConfig.clientUnbindLimit) {
          throw new AppError(
            429,
            "CLIENT_UNBIND_LIMIT_REACHED",
            "The self-service unbind limit has been reached for the current policy window.",
            {
              clientUnbindLimit: unbindConfig.clientUnbindLimit,
              clientUnbindWindowDays: unbindConfig.clientUnbindWindowDays,
              recentClientUnbinds
            }
          );
        }

        const requestedBindingId = body.bindingId ? String(body.bindingId).trim() : "";
        const requestedFingerprint = body.deviceFingerprint ? String(body.deviceFingerprint).trim() : "";
        if (!requestedBindingId && !requestedFingerprint) {
          throw new AppError(400, "UNBIND_TARGET_REQUIRED", "Provide bindingId or deviceFingerprint to unbind.");
        }

        const bindings = queryBindingsForEntitlement(db, subject.entitlement.id);
        const binding = bindings.find((entry) =>
          (requestedBindingId && entry.id === requestedBindingId) ||
          (requestedFingerprint && entry.fingerprint === requestedFingerprint)
        );

        if (!binding) {
          throw new AppError(404, "BINDING_NOT_FOUND", "The target device binding does not exist for this authorization.");
        }
        if (binding.status !== "active") {
          return {
            binding,
            changed: false,
            releasedSessions: 0,
            entitlement: {
              id: subject.entitlement.id,
              endsAt: subject.entitlement.ends_at,
              status: subject.entitlement.status
            }
          };
        }

        const timestamp = nowIso();
        const reason = normalizeReason(body.reason, "client_unbind");
        let endsAt = subject.entitlement.ends_at;
        let releasedSessions = releaseBindingRecord(db, stateStore, {
          id: binding.id,
          entitlement_id: subject.entitlement.id,
          device_id: binding.deviceId
        }, reason, timestamp);

        if (unbindConfig.clientUnbindDeductDays > 0) {
          const deductedEndsAt = addDays(subject.entitlement.ends_at, -unbindConfig.clientUnbindDeductDays);
          endsAt = deductedEndsAt > timestamp ? deductedEndsAt : timestamp;
          run(
            db,
            `
              UPDATE entitlements
              SET ends_at = ?, updated_at = ?
              WHERE id = ?
            `,
            endsAt,
            timestamp,
            subject.entitlement.id
          );

          if (endsAt <= timestamp) {
            releasedSessions += expireSessionsForEntitlement(
              db,
              stateStore,
              subject.entitlement.id,
              "entitlement_expired_after_unbind"
            );
          }
        }

        recordEntitlementUnbind(
          db,
          subject.entitlement.id,
          binding.id,
          "client",
          subject.account.id,
          reason,
          unbindConfig.clientUnbindDeductDays,
          timestamp
        );

        audit(db, "account", subject.account.id, "device-binding.client-unbind", "device_binding", binding.id, {
          productCode: product.code,
          username: subject.account.username,
          authMode: subject.authMode,
          fingerprint: binding.fingerprint,
          releasedSessions,
          deductedDays: unbindConfig.clientUnbindDeductDays,
          endsAt
        });

        const updatedBindings = queryBindingsForEntitlement(db, subject.entitlement.id);
        const changedBinding = updatedBindings.find((entry) => entry.id === binding.id) ?? {
          ...binding,
          status: "revoked",
          revokedAt: timestamp,
          activeSessionCount: 0
        };
        const nextRecentClientUnbinds = recentClientUnbinds + 1;

        return {
          changed: true,
          releasedSessions,
          binding: changedBinding,
          entitlement: {
            id: subject.entitlement.id,
            endsAt,
            status: subject.entitlement.status
          },
          unbindPolicy: {
            allowClientUnbind: unbindConfig.allowClientUnbind,
            clientUnbindLimit: unbindConfig.clientUnbindLimit,
            clientUnbindWindowDays: unbindConfig.clientUnbindWindowDays,
            clientUnbindDeductDays: unbindConfig.clientUnbindDeductDays,
            recentClientUnbinds: nextRecentClientUnbinds,
            remainingClientUnbinds: unbindConfig.clientUnbindLimit > 0
              ? Math.max(0, unbindConfig.clientUnbindLimit - nextRecentClientUnbinds)
              : null
          }
        };
      });
    },

    async registerClient(reqLike, body, rawBody, meta = {}) {
      const product = await requireSignedProduct(db, config, stateStore, reqLike, rawBody);
      requireField(body, "username");
      requireField(body, "password");
      requireSignedProductCodeMatch(product, body);

      requireProductFeatureEnabled(
        db,
        product,
        "allowRegister",
        "ACCOUNT_REGISTER_DISABLED",
        "Account registration is disabled for this product."
      );

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

    async redeemCard(reqLike, body, rawBody, meta = {}) {
      const product = await requireSignedProduct(db, config, stateStore, reqLike, rawBody);
      requireField(body, "username");
      requireField(body, "password");
      requireField(body, "cardKey");
      requireSignedProductCodeMatch(product, body);

      requireProductFeatureEnabled(
        db,
        product,
        "allowCardRecharge",
        "CARD_RECHARGE_DISABLED",
        "Card recharge is disabled for this product."
      );

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

        const card = findClientCardByKey(db, product.id, body.cardKey);
        if (!card || card.status !== "fresh") {
          throw new AppError(404, "CARD_NOT_AVAILABLE", "Card key is invalid, already redeemed, or revoked.");
        }

        ensureCardControlAvailable(describeLicenseKeyControl({
          status: card.control_status,
          expires_at: card.expires_at
        }));

        return activateFreshCardEntitlement(db, product, account, card, "card.redeem");
      });
    },

    async cardLoginClient(reqLike, body, rawBody, meta = {}) {
      const product = await requireSignedProduct(db, config, stateStore, reqLike, rawBody);
      requireField(body, "cardKey");
      requireField(body, "deviceFingerprint");
      requireSignedProductCodeMatch(product, body);

      const featureConfig = requireProductFeatureEnabled(
        db,
        product,
        "allowCardLogin",
        "CARD_LOGIN_DISABLED_BY_PRODUCT",
        "Card direct login is disabled for this product."
      );

      enforceNetworkRules(db, product, meta.ip, "login");
      if (featureConfig.allowNotices) {
        requireNoBlockingNotices(db, product, body.channel);
      }
      if (featureConfig.allowVersionCheck) {
        requireClientVersionAllowed(
          db,
          product,
          body.clientVersion ? String(body.clientVersion).trim() : null,
          body.channel
        );
      }

      const sessionResult = withTransaction(db, () => {
        expireStaleSessions(db, stateStore);

        const card = findClientCardByKey(db, product.id, body.cardKey);
        if (!card || !["fresh", "redeemed"].includes(card.status)) {
          throw new AppError(404, "CARD_NOT_AVAILABLE", "Card key is invalid, already redeemed, or revoked.");
        }

        ensureCardControlAvailable(describeLicenseKeyControl({
          status: card.control_status,
          expires_at: card.expires_at
        }));

        if (card.status === "redeemed" && !card.card_login_account_id) {
          throw new AppError(
            409,
            "CARD_BOUND_TO_ACCOUNT",
            "This card key has already been recharged to an account and cannot be used for direct card login.",
            {
              redeemedUsername: card.redeemed_username ?? null
            }
          );
        }

        let account = null;
        if (card.card_login_account_id) {
          account = one(db, "SELECT * FROM customer_accounts WHERE id = ?", card.card_login_account_id);
          if (!account) {
            throw new AppError(409, "CARD_LOGIN_CORRUPTED", "Card-login mapping is missing its internal account.");
          }
          if (account.status !== "active") {
            throw new AppError(403, "CARD_LOGIN_DISABLED", "This card-login identity has been disabled.");
          }
        } else {
          account = createCardLoginAccount(db, product, card);
          activateFreshCardEntitlement(db, product, account, card, "card.direct_redeem", {
            authMode: "card"
          });
        }

        const now = nowIso();
        const deviceProfile = extractClientDeviceProfile(body, meta);
        const deviceFingerprint = deviceProfile.deviceFingerprint;
        requireDeviceNotBlocked(db, product.id, deviceFingerprint);
        const entitlement = getUsableEntitlement(db, account.id, product.id, now);
        if (!entitlement) {
          throwEntitlementUnavailable(getLatestEntitlementSnapshot(db, account.id, product.id), now);
        }

        const maskedKey = maskCardKey(card.card_key);
        const bindConfig = loadPolicyBindConfig(db, entitlement.policy_id, entitlement.bind_mode, entitlement.updated_at);
        return {
          ...issueClientSession(db, config, stateStore, {
            product,
            account,
            entitlement,
            deviceProfile,
            meta,
            authMode: "card",
            tokenSubject: account.username,
            bindConfig
          }),
          card: {
            maskedKey
          }
        };
      });
      return finalizeIssuedSessionRuntime(db, stateStore, sessionResult);
    },

    async loginClient(reqLike, body, rawBody, meta = {}) {
      const product = await requireSignedProduct(db, config, stateStore, reqLike, rawBody);
      requireField(body, "username");
      requireField(body, "password");
      requireField(body, "deviceFingerprint");
      requireSignedProductCodeMatch(product, body);

      const featureConfig = requireProductFeatureEnabled(
        db,
        product,
        "allowAccountLogin",
        "ACCOUNT_LOGIN_DISABLED_BY_PRODUCT",
        "Account login is disabled for this product."
      );

      enforceNetworkRules(db, product, meta.ip, "login");
      if (featureConfig.allowNotices) {
        requireNoBlockingNotices(db, product, body.channel);
      }
      if (featureConfig.allowVersionCheck) {
        requireClientVersionAllowed(
          db,
          product,
          body.clientVersion ? String(body.clientVersion).trim() : null,
          body.channel
        );
      }

      const sessionResult = withTransaction(db, () => {
        expireStaleSessions(db, stateStore);

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
        const deviceProfile = extractClientDeviceProfile(body, meta);
        const deviceFingerprint = deviceProfile.deviceFingerprint;
        requireDeviceNotBlocked(db, product.id, deviceFingerprint);
        const entitlement = getUsableEntitlement(db, account.id, product.id, now);
        if (!entitlement) {
          throwEntitlementUnavailable(getLatestEntitlementSnapshot(db, account.id, product.id), now);
        }

        const bindConfig = loadPolicyBindConfig(db, entitlement.policy_id, entitlement.bind_mode, entitlement.updated_at);
        return issueClientSession(db, config, stateStore, {
          product,
          account,
          entitlement,
          deviceProfile,
          meta,
          authMode: "account",
          tokenSubject: account.username,
          bindConfig
        });
      });
      return finalizeIssuedSessionRuntime(db, stateStore, sessionResult);
    },

    async heartbeatClient(reqLike, body, rawBody, meta) {
      const product = await requireSignedProduct(db, config, stateStore, reqLike, rawBody);
      requireField(body, "sessionToken");
      requireField(body, "deviceFingerprint");
      const sessionToken = String(body.sessionToken).trim();
      requireSignedProductCodeMatch(product, body);

      enforceNetworkRules(db, product, meta.ip, "heartbeat");
      const runtimeSession = await stateStore.getSessionState(sessionToken);
      if (runtimeSession?.status === "expired") {
        throw new AppError(401, "SESSION_INVALID", "Session token is invalid or expired.", {
          runtimeRevokedReason: runtimeSession.revokedReason ?? null
        });
      }

      return withTransaction(db, () => {
        expireStaleSessions(db, stateStore);
        const session = one(
          db,
          `
            SELECT s.*, d.fingerprint, a.username, e.status AS entitlement_status,
                   pol.heartbeat_interval_seconds, pol.heartbeat_timeout_seconds, pol.token_ttl_seconds,
                   lkc.status AS card_control_status, lkc.expires_at AS card_expires_at
            FROM sessions s
            JOIN devices d ON d.id = s.device_id
            JOIN customer_accounts a ON a.id = s.account_id
            JOIN entitlements e ON e.id = s.entitlement_id
            JOIN policies pol ON pol.id = e.policy_id
            JOIN license_keys lk ON lk.id = e.source_license_key_id
            LEFT JOIN license_key_controls lkc ON lkc.license_key_id = lk.id
            WHERE s.product_id = ? AND s.session_token = ? AND s.status = 'active'
          `,
          product.id,
          sessionToken
        );

        if (!session) {
          throw new AppError(401, "SESSION_INVALID", "Session token is invalid or expired.");
        }

        if (session.fingerprint !== String(body.deviceFingerprint).trim()) {
          expireSessionById(db, stateStore, session.id, "device_mismatch");
          throw new AppError(401, "DEVICE_MISMATCH", "Device fingerprint does not match this session.");
        }

        const block = activeDeviceBlock(db, product.id, session.fingerprint);
        if (block) {
          expireSessionById(db, stateStore, session.id, "device_blocked");
          throw new AppError(403, "DEVICE_BLOCKED", "This device fingerprint has been blocked by the operator.", {
            reason: block.reason,
            blockedAt: block.created_at
          });
        }

        if (session.entitlement_status !== "active") {
          expireSessionById(db, stateStore, session.id, "entitlement_frozen");
          throw new AppError(403, "LICENSE_FROZEN", "This authorization has been frozen by the operator.");
        }

        const cardControl = describeLicenseKeyControl({
          status: session.card_control_status,
          expires_at: session.card_expires_at
        });
        if (!cardControl.available) {
          expireSessionById(db, stateStore, session.id, `card_${cardControl.effectiveStatus}`);
          ensureCardControlAvailable(cardControl);
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
        stateStore.touchSession(session.session_token, {
          expiresAt,
          lastHeartbeatAt: now,
          lastSeenIp: meta.ip,
          userAgent: meta.userAgent
        });

        return {
          status: "active",
          account: session.username,
          expiresAt,
          nextHeartbeatInSeconds: session.heartbeat_interval_seconds
        };
      });
    },

    async logoutClient(reqLike, body, rawBody) {
      const product = await requireSignedProduct(db, config, stateStore, reqLike, rawBody);
      requireField(body, "sessionToken");
      requireSignedProductCodeMatch(product, body);

      const session = one(
        db,
        "SELECT * FROM sessions WHERE product_id = ? AND session_token = ?",
        product.id,
        String(body.sessionToken).trim()
      );
      if (!session) {
        throw new AppError(404, "SESSION_NOT_FOUND", "Session token does not exist.");
      }

      expireSessionById(db, stateStore, session.id, "client_logout");

      audit(db, "account", session.account_id, "session.logout", "session", session.id, {});
      return { status: "logged_out" };
    }
  };
}
