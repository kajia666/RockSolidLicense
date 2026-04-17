import { createHash } from "node:crypto";
import { AppError } from "./http.js";
import { buildZipArchive } from "./archive.js";
import { rotateLicenseKeyStore } from "./license-keys.js";
import { NonceReplayError } from "./runtime-state.js";
import {
  getActiveProductRecordByCode,
  getProductRowById,
  listAssignedDeveloperProductIds,
  listOwnedProductIds,
  normalizeProductStatus,
  parseProductFeatureConfigRow,
  queryProductRows
} from "./data/product-repository.js";
import {
  describeLicenseKeyControl,
  maskCardKey,
  normalizeCardControlStatus,
  queryCardRows
} from "./data/card-repository.js";
import {
  entitlementLifecycleStatus,
  formatEntitlementGrant,
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

const MANAGED_PRODUCT_FEATURE_KEYS = Object.freeze([
  "allowRegister",
  "allowAccountLogin",
  "allowCardLogin",
  "allowCardRecharge",
  "allowVersionCheck",
  "allowNotices",
  "allowClientUnbind"
]);

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

async function expireActiveSessions(db, store, stateStore, filters, reason) {
  const rows = store?.sessions?.expireActiveSessions
    ? await Promise.resolve(store.sessions.expireActiveSessions(filters, reason))
    : [];

  for (const row of rows) {
    stateStore?.expireSession(row.session_token, reason, { sessionId: row.id });
  }

  return rows.length;
}

function expireSessionById(db, store, stateStore, sessionId, reason) {
  return expireActiveSessions(db, store, stateStore, { sessionId }, reason);
}

function expireSessionByToken(db, store, stateStore, sessionToken, reason) {
  return expireActiveSessions(db, store, stateStore, { sessionToken }, reason);
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

async function finalizeIssuedSessionRuntime(db, store, stateStore, payload) {
  const resolvedPayload = await Promise.resolve(payload);
  if (!resolvedPayload?.runtime) {
    return resolvedPayload;
  }

  const runtime = resolvedPayload.runtime;
  if (stateStore?.commitSessionRuntime) {
    const result = await stateStore.commitSessionRuntime(runtime.session, {
      claimSingleOwner: runtime.claimSingleOwner
    });
    if (result?.previousSessionToken) {
      await expireSessionByToken(db, store, stateStore, result.previousSessionToken, "single_session_runtime");
    }
  } else if (stateStore?.recordSession) {
    stateStore.recordSession(runtime.session);
  }

  const { runtime: _runtime, ...publicPayload } = resolvedPayload;
  return publicPayload;
}

function withTransaction(db, action) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    if (result && typeof result.then === "function") {
      return result.then((value) => {
        db.exec("COMMIT");
        return value;
      }, (error) => {
        db.exec("ROLLBACK");
        throw error;
      });
    }
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

function buildDeveloperIdentityPayload(session) {
  return {
    id: session.developer_id,
    username: session.developer_username ?? session.username,
    displayName: session.developer_display_name ?? session.display_name ?? "",
    status: session.developer_status
  };
}

function buildOwnerDeveloperPayload(ownerDeveloper = null) {
  if (!ownerDeveloper) {
    return null;
  }
  return {
    id: ownerDeveloper.id,
    username: ownerDeveloper.username ?? null,
    displayName: ownerDeveloper.displayName ?? "",
    status: ownerDeveloper.status ?? null
  };
}

function buildAdminActorPayload(adminSession = {}) {
  return {
    type: "admin",
    id: adminSession.admin_id ?? null,
    username: adminSession.username ?? "admin",
    role: "admin",
    permissions: ["*"]
  };
}

function buildAdminIdentityPayload(adminSession = {}) {
  return {
    id: adminSession.admin_id ?? null,
    username: adminSession.username ?? "admin",
    role: "admin",
    permissions: ["*"]
  };
}

function buildIntegrationTransportSnapshot(config) {
  return {
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
  };
}

function buildIntegrationSigningSnapshot(config) {
  return {
    requestAlgorithm: "HMAC-SHA256",
    requestSkewSeconds: config.requestSkewSeconds,
    tokenAlgorithm: config.licenseKeys.algorithm,
    tokenIssuer: config.tokenIssuer,
    activeKeyId: config.licenseKeys.keyId
  };
}

function buildIntegrationExamples() {
  return {
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
  };
}

function escapeCppStringLiteral(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"");
}

function resolveIntegrationHttpEndpoint(transport = {}) {
  try {
    const parsed = new URL(transport.baseUrl);
    return {
      host: parsed.hostname || "127.0.0.1",
      port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
      secure: parsed.protocol === "https:"
    };
  } catch {
    return {
      host: "127.0.0.1",
      port: Number(transport.port || 3000),
      secure: false
    };
  }
}

function buildIntegrationEnvTemplate(manifest) {
  const http = manifest.transport?.http || {};
  const tcp = manifest.transport?.tcp || {};
  const signing = manifest.signing || {};
  const project = manifest.project || {};
  const credentials = manifest.credentials || {};

  return [
    `RS_PROJECT_CODE=${project.code || ""}`,
    `RS_PROJECT_NAME=${project.name || ""}`,
    `RS_SDK_APP_ID=${credentials.sdkAppId || ""}`,
    `RS_SDK_APP_SECRET=${credentials.sdkAppSecret || ""}`,
    `RS_APP_SALT=${credentials.deviceFingerprintSalt || project.code || ""}`,
    `RS_HTTP_BASE_URL=${http.baseUrl || ""}`,
    `RS_HTTP_HOST=${http.host || ""}`,
    `RS_HTTP_PORT=${http.port ?? ""}`,
    `RS_TCP_ENABLED=${tcp.enabled === true ? "true" : "false"}`,
    `RS_TCP_HOST=${tcp.host || ""}`,
    `RS_TCP_PORT=${tcp.port ?? ""}`,
    `RS_REQUEST_SKEW_SECONDS=${signing.requestSkewSeconds ?? ""}`,
    `RS_TOKEN_ISSUER=${signing.tokenIssuer || ""}`,
    `RS_ACTIVE_KEY_ID=${signing.activeKeyId || ""}`
  ].join("\n");
}

function buildIntegrationCppQuickstart(manifest) {
  const project = manifest.project || {};
  const credentials = manifest.credentials || {};
  const transport = manifest.transport || {};
  const http = resolveIntegrationHttpEndpoint(transport.http || {});
  const tcp = transport.tcp || {};

  return `#include "rocksolid_transport_win.hpp"

rocksolid::ClientIdentity identity{
  "${escapeCppStringLiteral(credentials.sdkAppId || "")}",
  "${escapeCppStringLiteral(credentials.sdkAppSecret || "")}",
  "${escapeCppStringLiteral(credentials.deviceFingerprintSalt || project.code || "")}"
};

rocksolid::HttpEndpoint http_endpoint;
http_endpoint.host = L"${escapeCppStringLiteral(http.host)}";
http_endpoint.port = ${Number(http.port || 0)};
http_endpoint.secure = ${http.secure ? "true" : "false"};

rocksolid::TcpEndpoint tcp_endpoint;
tcp_endpoint.host = "${escapeCppStringLiteral(tcp.host || "127.0.0.1")}";
tcp_endpoint.port = ${Number(tcp.port || 0)};  // tcp enabled=${tcp.enabled === true ? "true" : "false"}

rocksolid::LicenseClientWin client(identity, http_endpoint, tcp_endpoint);

const std::string product_code = "${escapeCppStringLiteral(project.code || "")}";
const std::string client_version = "1.0.0";
const std::string channel = "stable";

const rocksolid::ClientStartupBootstrapResponse startup =
  client.startup_bootstrap_http({ product_code, client_version, channel, true });

rocksolid::LoginRequest login_request{
  product_code,
  "demo_user",
  "demo_password",
  client.generate_device_fingerprint(),
  "Demo Workstation",
  client_version,
  channel
};

const rocksolid::LoginResponse login_result = client.login_http_parsed(login_request);`;
}

function buildDeveloperIntegrationPackagePayload({
  developer,
  actor,
  product,
  transport,
  signing,
  tokenKeys,
  examples,
  includeOwner = false,
  generatedAt = nowIso()
}) {
  const ownerDeveloper = includeOwner
    ? buildOwnerDeveloperPayload(product?.ownerDeveloper ?? null)
    : undefined;
  const manifest = {
    generatedAt,
    developer: developer ?? ownerDeveloper ?? null,
    actor: actor ?? null,
    ownerDeveloper,
    project: {
      id: product.id,
      code: product.code,
      projectCode: product.projectCode ?? product.code,
      softwareCode: product.softwareCode ?? product.code,
      name: product.name,
      description: product.description ?? "",
      status: product.status,
      updatedAt: product.updatedAt,
      featureConfig: product.featureConfig && typeof product.featureConfig === "object"
        ? product.featureConfig
        : {}
    },
    credentials: {
      sdkAppId: product.sdkAppId,
      sdkAppSecret: product.sdkAppSecret,
      deviceFingerprintSalt: product.code
    },
    transport,
    signing,
    tokenKeys,
    startupDefaults: {
      productCode: product.code,
      clientVersion: "1.0.0",
      channel: "stable",
      includeTokenKeys: true
    },
    examples,
    sdkDistribution: {
      languages: ["c", "cpp"],
      preferredPackage: "rocksolid-sdk-cpp",
      preferredLinkage: "static_lib",
      requiredDefine: "RS_SDK_STATIC"
    },
    notes: [
      "Replace the demo host values with your public service domain when you deploy behind a reverse proxy or TLS.",
      "Refresh this package immediately after rotating sdkAppId or sdkAppSecret, then redeploy the client configuration."
    ]
  };

  return {
    id: product.id,
    code: product.code,
    projectCode: product.projectCode ?? product.code,
    softwareCode: product.softwareCode ?? product.code,
    name: product.name,
    description: product.description ?? "",
    status: product.status,
    updatedAt: product.updatedAt,
    ownerDeveloper,
    fileName: `rocksolid-integration-${product.code}.json`,
    manifest,
    snippets: {
      envFileName: `${product.code}.env`,
      envTemplate: buildIntegrationEnvTemplate(manifest),
      cppFileName: `${product.code}.cpp`,
      cppQuickstart: buildIntegrationCppQuickstart(manifest)
    }
  };
}

function buildExportTimestampTag(value = nowIso()) {
  return String(value)
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replaceAll(".", "")
    .replace("T", "-")
    .replace("Z", "");
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  if (!/[",\r\n]/.test(text)) {
    return text;
  }
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function buildProductSdkCredentialExportItem(product, includeOwner = false) {
  const ownerDeveloper = includeOwner
    ? (
        product?.ownerDeveloper
          ? {
              id: product.ownerDeveloper.id,
              username: product.ownerDeveloper.username ?? null,
              displayName: product.ownerDeveloper.displayName ?? "",
              status: product.ownerDeveloper.status ?? null
            }
          : null
      )
    : undefined;

  return {
    id: product.id,
    code: product.code,
    projectCode: product.projectCode ?? product.code,
    softwareCode: product.softwareCode ?? product.code,
    name: product.name,
    description: product.description ?? "",
    status: product.status,
    sdkAppId: product.sdkAppId,
    sdkAppSecret: product.sdkAppSecret,
    updatedAt: product.updatedAt,
    ownerDeveloper
  };
}

function buildProductSdkCredentialCsv(items = [], includeOwner = false) {
  const headers = [
    "code",
    "projectCode",
    "softwareCode",
    "name",
    "status",
    "sdkAppId",
    "sdkAppSecret",
    "updatedAt"
  ];
  if (includeOwner) {
    headers.push("ownerUsername", "ownerDisplayName", "ownerStatus");
  }

  const rows = [headers.join(",")];
  for (const item of items) {
    const values = [
      item.code,
      item.projectCode,
      item.softwareCode,
      item.name,
      item.status,
      item.sdkAppId,
      item.sdkAppSecret,
      item.updatedAt
    ];
    if (includeOwner) {
      values.push(
        item.ownerDeveloper?.username ?? "",
        item.ownerDeveloper?.displayName ?? "",
        item.ownerDeveloper?.status ?? ""
      );
    }
    rows.push(values.map(escapeCsvCell).join(","));
  }

  return rows.join("\n");
}

function buildProductSdkCredentialEnvFiles(products = [], transport = {}, signing = {}) {
  return products.map((product) => {
    const manifest = {
      project: {
        code: product.code,
        name: product.name
      },
      credentials: {
        sdkAppId: product.sdkAppId,
        sdkAppSecret: product.sdkAppSecret,
        deviceFingerprintSalt: product.code
      },
      transport,
      signing
    };
    return {
      fileName: `${product.code}.env`,
      content: buildIntegrationEnvTemplate(manifest)
    };
  });
}

function buildProductSdkCredentialEnvBundleText(envFiles = []) {
  if (!envFiles.length) {
    return "";
  }

  return envFiles.map((entry) => `### ${entry.fileName}\n${entry.content}`).join("\n\n");
}

function buildNamedFileBundleText(files = []) {
  if (!files.length) {
    return "";
  }

  return files.map((entry) => `### ${entry.fileName}\n${entry.content}`).join("\n\n");
}

function buildProductSdkCredentialExportBundle(products = [], options = {}) {
  const generatedAt = nowIso();
  const timestampTag = buildExportTimestampTag(generatedAt);
  const includeOwner = options.includeOwner === true;
  const items = products.map((product) => buildProductSdkCredentialExportItem(product, includeOwner));
  const csvText = buildProductSdkCredentialCsv(items, includeOwner);
  const envFiles = buildProductSdkCredentialEnvFiles(products, options.transport || {}, options.signing || {});

  return {
    generatedAt,
    total: items.length,
    fileName: `rocksolid-sdk-credentials-${timestampTag}.json`,
    csvFileName: `rocksolid-sdk-credentials-${timestampTag}.csv`,
    envArchiveName: `rocksolid-sdk-credentials-${timestampTag}-env.txt`,
    items,
    csvText,
    envFiles,
    envBundleText: buildProductSdkCredentialEnvBundleText(envFiles)
  };
}

function buildIntegrationPackageManifestFiles(items = []) {
  return items.map((item) => ({
    fileName: item.fileName,
    content: JSON.stringify(item.manifest, null, 2)
  }));
}

function buildIntegrationPackageEnvFiles(items = []) {
  return items.map((item) => ({
    fileName: `${item.code}.env`,
    content: item.snippets?.envTemplate || ""
  }));
}

function buildIntegrationPackageCppFiles(items = []) {
  return items.map((item) => ({
    fileName: `${item.code}.cpp`,
    content: item.snippets?.cppQuickstart || ""
  }));
}

function buildProductIntegrationPackageExportBundle(items = [], options = {}) {
  const generatedAt = options.generatedAt ?? nowIso();
  const timestampTag = buildExportTimestampTag(generatedAt);
  const manifestFiles = buildIntegrationPackageManifestFiles(items);
  const envFiles = buildIntegrationPackageEnvFiles(items);
  const cppFiles = buildIntegrationPackageCppFiles(items);

  return {
    generatedAt,
    total: items.length,
    developer: options.developer,
    actor: options.actor,
    transport: options.transport,
    signing: options.signing,
    tokenKeys: options.tokenKeys,
    examples: options.examples,
    fileName: `rocksolid-integration-packages-${timestampTag}.json`,
    manifestArchiveName: `rocksolid-integration-packages-${timestampTag}-manifests.txt`,
    envArchiveName: `rocksolid-integration-packages-${timestampTag}-env.txt`,
    cppArchiveName: `rocksolid-integration-packages-${timestampTag}-cpp.txt`,
    items,
    manifestFiles,
    envFiles,
    cppFiles,
    manifestBundleText: buildNamedFileBundleText(manifestFiles),
    envBundleText: buildNamedFileBundleText(envFiles),
    cppBundleText: buildNamedFileBundleText(cppFiles)
  };
}

function buildReleasePackageSummaryText(manifest = {}) {
  const project = manifest.project || {};
  const release = manifest.release || {};
  const versionManifest = release.versionManifest || {};
  const activeNotices = release.activeNotices || {};
  const noticeItems = Array.isArray(activeNotices.items) ? activeNotices.items : [];
  const lines = [
    "RockSolid Release Delivery Package",
    `Generated At: ${manifest.generatedAt || ""}`,
    `Project Code: ${project.code || ""}`,
    `Project Name: ${project.name || ""}`,
    `Channel: ${release.channel || "stable"}`,
    `Latest Version: ${versionManifest.latestVersion || "-"}`,
    `Minimum Allowed Version: ${versionManifest.minimumAllowedVersion || "-"}`,
    `Latest Download URL: ${versionManifest.latestDownloadUrl || "-"}`,
    `Active Notices: ${activeNotices.total ?? 0}`,
    `Blocking Notices: ${activeNotices.blockingTotal ?? 0}`,
    ""
  ];

  if (noticeItems.length) {
    lines.push("Active Notice Titles:");
    for (const item of noticeItems) {
      lines.push(`- ${item.title || "(untitled)"} [${item.channel || "all"}]`);
    }
  } else {
    lines.push("Active Notice Titles:");
    lines.push("- none");
  }

  return lines.join("\n");
}

function buildReleasePackagePayload({
  generatedAt = nowIso(),
  developer,
  actor,
  product,
  channel = "stable",
  versionManifest,
  activeNoticeRows = [],
  integrationPackage
}) {
  const normalizedChannel = normalizeChannel(channel);
  const timestampTag = buildExportTimestampTag(generatedAt);
  const activeNotices = activeNoticeRows.map((row) => (
    row && typeof row === "object" && Object.hasOwn(row, "blockLogin")
      ? row
      : formatNotice(row)
  ));
  const blockingNotices = activeNotices.filter((item) => item.blockLogin);
  const envFileName = `${product.code}.env`;
  const cppFileName = `${product.code}.cpp`;
  const manifest = {
    generatedAt,
    developer: developer ?? null,
    actor: actor ?? null,
    project: {
      id: product.id,
      code: product.code,
      projectCode: product.projectCode ?? product.code,
      softwareCode: product.softwareCode ?? product.code,
      name: product.name,
      description: product.description ?? "",
      status: product.status,
      updatedAt: product.updatedAt,
      featureConfig: product.featureConfig && typeof product.featureConfig === "object"
        ? product.featureConfig
        : {}
    },
    release: {
      channel: normalizedChannel,
      versionManifest,
      activeNotices: {
        total: activeNotices.length,
        blockingTotal: blockingNotices.length,
        items: activeNotices
      }
    },
    integration: integrationPackage?.manifest ?? null,
    snippets: {
      envFileName,
      cppFileName
    },
    notes: [
      "Use this package as the handoff snapshot for software release coordination, client upgrade notices, and SDK configuration updates.",
      "Regenerate the package after rotating SDK credentials or changing active version and notice rules."
    ]
  };

  return {
    fileName: `rocksolid-release-package-${product.code}-${normalizedChannel}-${timestampTag}.json`,
    summaryFileName: `rocksolid-release-package-${product.code}-${normalizedChannel}-${timestampTag}.txt`,
    manifest,
    snippets: {
      envFileName,
      envTemplate: integrationPackage?.snippets?.envTemplate || "",
      cppFileName,
      cppQuickstart: integrationPackage?.snippets?.cppQuickstart || ""
    },
    summaryText: buildReleasePackageSummaryText(manifest)
  };
}

function normalizeDownloadFormat(value, supported = [], fallback = "json", code = "INVALID_EXPORT_FORMAT", label = "Export format") {
  const normalized = String(value ?? fallback).trim().toLowerCase() || fallback;
  if (!supported.includes(normalized)) {
    throw new AppError(400, code, `${label} must be ${supported.join(", ")}.`);
  }
  return normalized;
}

function buildArchiveRootName(fileName, fallback = "download") {
  const normalized = String(fileName || fallback).trim() || fallback;
  return normalized.replace(/\.[^.]+$/, "");
}

function normalizeChecksumBody(body) {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  return Buffer.from(String(body ?? ""), "utf8");
}

function sha256ChecksumHex(body) {
  return createHash("sha256").update(normalizeChecksumBody(body)).digest("hex");
}

function buildChecksumManifestText(files = []) {
  const lines = ["# SHA-256 checksums"];
  for (const file of files) {
    const filePath = String(file.path || file.fileName || "file").replace(/\\/g, "/");
    lines.push(`${sha256ChecksumHex(file.body)} *${filePath}`);
  }
  return lines.join("\n");
}

function buildChecksumFileName(fileName, fallback = "download") {
  return `${buildArchiveRootName(fileName, fallback)}-sha256.txt`;
}

function buildZipEntriesFromFiles(root, files = []) {
  const entries = files.map((file) => ({
    path: `${root}/${file.path}`,
    body: file.body
  }));
  entries.push({
    path: `${root}/SHA256SUMS.txt`,
    body: buildChecksumManifestText(files)
  });
  return entries;
}

function buildReleasePackageFiles(payload) {
  return [
    {
      path: payload.fileName || "release-package.json",
      body: JSON.stringify(payload, null, 2)
    },
    {
      path: payload.summaryFileName || "release-package.txt",
      body: payload.summaryText || ""
    },
    {
      path: `snippets/${payload.snippets?.envFileName || "project.env"}`,
      body: payload.snippets?.envTemplate || ""
    },
    {
      path: `snippets/${payload.snippets?.cppFileName || "project.cpp"}`,
      body: payload.snippets?.cppQuickstart || ""
    }
  ];
}

function buildReleasePackageZipEntries(payload) {
  const root = buildArchiveRootName(payload.fileName, "release-package");
  return buildZipEntriesFromFiles(root, buildReleasePackageFiles(payload));
}

function buildIntegrationPackageExportFiles(payload) {
  const files = [
    {
      path: payload.fileName || "integration-packages.json",
      body: JSON.stringify(payload, null, 2)
    }
  ];

  for (const file of payload.manifestFiles || []) {
    files.push({
      path: `manifests/${file.fileName}`,
      body: file.content || ""
    });
  }
  for (const file of payload.envFiles || []) {
    files.push({
      path: `env/${file.fileName}`,
      body: file.content || ""
    });
  }
  for (const file of payload.cppFiles || []) {
    files.push({
      path: `cpp/${file.fileName}`,
      body: file.content || ""
    });
  }

  return files;
}

function buildIntegrationPackageZipEntries(payload) {
  const root = buildArchiveRootName(payload.fileName, "integration-packages");
  return buildZipEntriesFromFiles(root, buildIntegrationPackageExportFiles(payload));
}

function buildSingleIntegrationPackageFiles(payload) {
  return [
    {
      path: payload.fileName || "integration-package.json",
      body: JSON.stringify(payload, null, 2)
    },
    {
      path: `env/${payload.snippets?.envFileName || "project.env"}`,
      body: payload.snippets?.envTemplate || ""
    },
    {
      path: `cpp/${payload.snippets?.cppFileName || "project.cpp"}`,
      body: payload.snippets?.cppQuickstart || ""
    }
  ];
}

function buildSingleIntegrationPackageZipEntries(payload) {
  const root = buildArchiveRootName(payload.fileName, "integration-package");
  return buildZipEntriesFromFiles(root, buildSingleIntegrationPackageFiles(payload));
}

function buildProductSdkCredentialFiles(payload) {
  const files = [
    {
      path: payload.fileName || "sdk-credentials.json",
      body: JSON.stringify(payload, null, 2)
    },
    {
      path: payload.csvFileName || "sdk-credentials.csv",
      body: payload.csvText || ""
    }
  ];

  for (const file of payload.envFiles || []) {
    files.push({
      path: `env/${file.fileName}`,
      body: file.content || ""
    });
  }

  return files;
}

function buildProductSdkCredentialZipEntries(payload) {
  const root = buildArchiveRootName(payload.fileName, "sdk-credentials");
  return buildZipEntriesFromFiles(root, buildProductSdkCredentialFiles(payload));
}

function buildProductSdkCredentialDownloadAsset(payload, format = "json") {
  const normalizedFormat = normalizeDownloadFormat(
    format,
    ["json", "csv", "env", "zip", "checksums"],
    "json",
    "INVALID_SDK_CREDENTIAL_EXPORT_FORMAT",
    "SDK credential export format"
  );

  if (normalizedFormat === "zip") {
    return {
      fileName: `${buildArchiveRootName(payload.fileName, "sdk-credentials")}.zip`,
      contentType: "application/zip",
      body: buildZipArchive(buildProductSdkCredentialZipEntries(payload))
    };
  }
  if (normalizedFormat === "checksums") {
    return {
      fileName: buildChecksumFileName(payload.fileName, "sdk-credentials"),
      contentType: "text/plain; charset=utf-8",
      body: buildChecksumManifestText(buildProductSdkCredentialFiles(payload))
    };
  }
  if (normalizedFormat === "csv") {
    return {
      fileName: payload.csvFileName || "sdk-credentials.csv",
      contentType: "text/csv; charset=utf-8",
      body: payload.csvText || ""
    };
  }
  if (normalizedFormat === "env") {
    return {
      fileName: payload.envArchiveName || "sdk-credentials-env.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.envBundleText || ""
    };
  }

  return {
    fileName: payload.fileName || "sdk-credentials.json",
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(payload, null, 2)
  };
}

function buildReleasePackageDownloadAsset(payload, format = "json") {
  const normalizedFormat = normalizeDownloadFormat(
    format,
    ["json", "summary", "env", "cpp", "zip", "checksums"],
    "json",
    "INVALID_RELEASE_PACKAGE_FORMAT",
    "Release package format"
  );

  if (normalizedFormat === "zip") {
    return {
      fileName: `${buildArchiveRootName(payload.fileName, "release-package")}.zip`,
      contentType: "application/zip",
      body: buildZipArchive(buildReleasePackageZipEntries(payload))
    };
  }
  if (normalizedFormat === "checksums") {
    return {
      fileName: buildChecksumFileName(payload.fileName, "release-package"),
      contentType: "text/plain; charset=utf-8",
      body: buildChecksumManifestText(buildReleasePackageFiles(payload))
    };
  }
  if (normalizedFormat === "summary") {
    return {
      fileName: payload.summaryFileName || "release-package.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.summaryText || ""
    };
  }
  if (normalizedFormat === "env") {
    return {
      fileName: payload.snippets?.envFileName || "project.env",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.envTemplate || ""
    };
  }
  if (normalizedFormat === "cpp") {
    return {
      fileName: payload.snippets?.cppFileName || "project.cpp",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.cppQuickstart || ""
    };
  }

  return {
    fileName: payload.fileName || "release-package.json",
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(payload, null, 2)
  };
}

function buildIntegrationPackageExportDownloadAsset(payload, format = "json") {
  const normalizedFormat = normalizeDownloadFormat(
    format,
    ["json", "manifests", "env", "cpp", "zip", "checksums"],
    "json",
    "INVALID_INTEGRATION_EXPORT_FORMAT",
    "Integration export format"
  );

  if (normalizedFormat === "zip") {
    return {
      fileName: `${buildArchiveRootName(payload.fileName, "integration-packages")}.zip`,
      contentType: "application/zip",
      body: buildZipArchive(buildIntegrationPackageZipEntries(payload))
    };
  }
  if (normalizedFormat === "checksums") {
    return {
      fileName: buildChecksumFileName(payload.fileName, "integration-packages"),
      contentType: "text/plain; charset=utf-8",
      body: buildChecksumManifestText(buildIntegrationPackageExportFiles(payload))
    };
  }
  if (normalizedFormat === "manifests") {
    return {
      fileName: payload.manifestArchiveName || "integration-manifests.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.manifestBundleText || ""
    };
  }
  if (normalizedFormat === "env") {
    return {
      fileName: payload.envArchiveName || "integration-env.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.envBundleText || ""
    };
  }
  if (normalizedFormat === "cpp") {
    return {
      fileName: payload.cppArchiveName || "integration-cpp.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.cppBundleText || ""
    };
  }

  return {
    fileName: payload.fileName || "integration-packages.json",
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(payload, null, 2)
  };
}

function buildIntegrationPackageDownloadAsset(payload, format = "json") {
  const normalizedFormat = normalizeDownloadFormat(
    format,
    ["json", "env", "cpp", "zip", "checksums"],
    "json",
    "INVALID_INTEGRATION_PACKAGE_FORMAT",
    "Integration package format"
  );

  if (normalizedFormat === "zip") {
    return {
      fileName: `${buildArchiveRootName(payload.fileName, "integration-package")}.zip`,
      contentType: "application/zip",
      body: buildZipArchive(buildSingleIntegrationPackageZipEntries(payload))
    };
  }
  if (normalizedFormat === "checksums") {
    return {
      fileName: buildChecksumFileName(payload.fileName, "integration-package"),
      contentType: "text/plain; charset=utf-8",
      body: buildChecksumManifestText(buildSingleIntegrationPackageFiles(payload))
    };
  }
  if (normalizedFormat === "env") {
    return {
      fileName: payload.snippets?.envFileName || "project.env",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.envTemplate || ""
    };
  }
  if (normalizedFormat === "cpp") {
    return {
      fileName: payload.snippets?.cppFileName || "project.cpp",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.cppQuickstart || ""
    };
  }

  return {
    fileName: payload.fileName || "integration-package.json",
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(payload, null, 2)
  };
}

function sanitizeExportNameSegment(value, fallback = "scope") {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function firstDefined(row, keys = [], fallback = null) {
  for (const key of keys) {
    if (row && row[key] !== undefined && row[key] !== null) {
      return row[key];
    }
  }
  return fallback;
}

function normalizeDeveloperOpsProjectItem(row = {}) {
  return {
    id: row.id,
    code: row.code ?? null,
    name: row.name ?? "",
    description: row.description ?? "",
    status: row.status ?? null,
    updatedAt: row.updatedAt ?? row.updated_at ?? null,
    featureConfig: row.featureConfig && typeof row.featureConfig === "object"
      ? row.featureConfig
      : {}
  };
}

function normalizeDeveloperOpsAccountItem(row = {}) {
  return {
    id: row.id,
    productId: firstDefined(row, ["productId", "product_id"]),
    productCode: firstDefined(row, ["productCode", "product_code"]),
    productName: firstDefined(row, ["productName", "product_name"], ""),
    ownerDeveloperId: firstDefined(row, ["ownerDeveloperId", "owner_developer_id"]),
    username: row.username ?? null,
    status: row.status ?? null,
    createdAt: firstDefined(row, ["createdAt", "created_at"]),
    updatedAt: firstDefined(row, ["updatedAt", "updated_at"]),
    lastLoginAt: firstDefined(row, ["lastLoginAt", "last_login_at"]),
    activeEntitlementCount: Number(firstDefined(row, ["activeEntitlementCount", "active_entitlement_count"], 0)),
    latestEntitlementEndsAt: firstDefined(row, ["latestEntitlementEndsAt", "latest_entitlement_ends_at"]),
    activeSessionCount: Number(firstDefined(row, ["activeSessionCount", "active_session_count"], 0))
  };
}

function normalizeDeveloperOpsEntitlementItem(row = {}) {
  return {
    id: row.id,
    productId: firstDefined(row, ["productId", "product_id"]),
    productCode: firstDefined(row, ["productCode", "product_code"]),
    productName: firstDefined(row, ["productName", "product_name"], ""),
    accountId: firstDefined(row, ["accountId", "account_id"]),
    username: row.username ?? null,
    policyId: firstDefined(row, ["policyId", "policy_id"]),
    policyName: firstDefined(row, ["policyName", "policy_name"], ""),
    sourceLicenseKeyId: firstDefined(row, ["sourceLicenseKeyId", "source_license_key_id"]),
    sourceCardKey: firstDefined(row, ["sourceCardKey", "source_card_key", "cardKey", "card_key"]),
    status: row.status ?? null,
    lifecycleStatus: firstDefined(row, ["lifecycleStatus", "lifecycle_status"], row.status ?? null),
    startsAt: firstDefined(row, ["startsAt", "starts_at"]),
    endsAt: firstDefined(row, ["endsAt", "ends_at"]),
    grantType: firstDefined(row, ["grantType", "grant_type"], "duration"),
    grantPoints: Number(firstDefined(row, ["grantPoints", "grant_points"], 0)),
    totalPoints: Number(firstDefined(row, ["totalPoints", "total_points"], 0)),
    remainingPoints: Number(firstDefined(row, ["remainingPoints", "remaining_points"], 0)),
    consumedPoints: Number(firstDefined(row, ["consumedPoints", "consumed_points"], 0)),
    activeSessionCount: Number(firstDefined(row, ["activeSessionCount", "active_session_count"], 0)),
    cardControlStatus: firstDefined(row, ["cardControlStatus", "card_control_status"]),
    cardEffectiveStatus: firstDefined(row, ["cardEffectiveStatus", "card_effective_status"]),
    cardExpiresAt: firstDefined(row, ["cardExpiresAt", "card_expires_at"]),
    createdAt: firstDefined(row, ["createdAt", "created_at"]),
    updatedAt: firstDefined(row, ["updatedAt", "updated_at"])
  };
}

function normalizeDeveloperOpsSessionItem(row = {}) {
  return {
    id: row.id,
    accountId: firstDefined(row, ["accountId", "account_id"]),
    entitlementId: firstDefined(row, ["entitlementId", "entitlement_id"]),
    deviceId: firstDefined(row, ["deviceId", "device_id"]),
    status: row.status ?? null,
    issuedAt: firstDefined(row, ["issuedAt", "issued_at"]),
    expiresAt: firstDefined(row, ["expiresAt", "expires_at"]),
    lastHeartbeatAt: firstDefined(row, ["lastHeartbeatAt", "last_heartbeat_at"]),
    lastSeenIp: firstDefined(row, ["lastSeenIp", "last_seen_ip"]),
    userAgent: firstDefined(row, ["userAgent", "user_agent"]),
    revokedReason: firstDefined(row, ["revokedReason", "revoked_reason"]),
    productId: firstDefined(row, ["productId", "product_id"]),
    productCode: firstDefined(row, ["productCode", "product_code"]),
    productName: firstDefined(row, ["productName", "product_name"], ""),
    username: row.username ?? null,
    fingerprint: row.fingerprint ?? null,
    deviceName: firstDefined(row, ["deviceName", "device_name"]),
    policyName: firstDefined(row, ["policyName", "policy_name"], "")
  };
}

function normalizeDeveloperOpsBindingItem(row = {}) {
  return {
    id: row.id,
    entitlementId: firstDefined(row, ["entitlementId", "entitlement_id"]),
    deviceId: firstDefined(row, ["deviceId", "device_id"]),
    status: row.status ?? null,
    firstBoundAt: firstDefined(row, ["firstBoundAt", "first_bound_at"]),
    lastBoundAt: firstDefined(row, ["lastBoundAt", "last_bound_at"]),
    revokedAt: firstDefined(row, ["revokedAt", "revoked_at"]),
    productId: firstDefined(row, ["productId", "product_id"]),
    productCode: firstDefined(row, ["productCode", "product_code"]),
    productName: firstDefined(row, ["productName", "product_name"], ""),
    accountId: firstDefined(row, ["accountId", "account_id"]),
    username: row.username ?? null,
    policyName: firstDefined(row, ["policyName", "policy_name"], ""),
    entitlementEndsAt: firstDefined(row, ["entitlementEndsAt", "entitlement_ends_at"]),
    fingerprint: row.fingerprint ?? null,
    deviceName: firstDefined(row, ["deviceName", "device_name"]),
    lastSeenAt: firstDefined(row, ["lastSeenAt", "last_seen_at"]),
    lastSeenIp: firstDefined(row, ["lastSeenIp", "last_seen_ip"]),
    identityHash: firstDefined(row, ["identityHash", "identity_hash"]),
    matchFields: firstDefined(row, ["matchFields", "match_fields", "match_fields_json"], {}),
    identity: firstDefined(row, ["identity", "identity_json"], {}),
    bindRequestIp: firstDefined(row, ["bindRequestIp", "bind_request_ip"]),
    activeSessionCount: Number(firstDefined(row, ["activeSessionCount", "active_session_count"], 0))
  };
}

function normalizeDeveloperOpsBlockItem(row = {}) {
  return {
    id: row.id,
    productId: firstDefined(row, ["productId", "product_id"]),
    productCode: firstDefined(row, ["productCode", "product_code"]),
    productName: firstDefined(row, ["productName", "product_name"], ""),
    fingerprint: row.fingerprint ?? null,
    status: row.status ?? null,
    reason: row.reason ?? null,
    notes: row.notes ?? null,
    createdAt: firstDefined(row, ["createdAt", "created_at"]),
    updatedAt: firstDefined(row, ["updatedAt", "updated_at"]),
    releasedAt: firstDefined(row, ["releasedAt", "released_at"]),
    deviceId: firstDefined(row, ["deviceId", "device_id"]),
    deviceName: firstDefined(row, ["deviceName", "device_name"]),
    lastSeenAt: firstDefined(row, ["lastSeenAt", "last_seen_at"]),
    lastSeenIp: firstDefined(row, ["lastSeenIp", "last_seen_ip"]),
    activeSessionCount: Number(firstDefined(row, ["activeSessionCount", "active_session_count"], 0))
  };
}

function normalizeDeveloperOpsAuditLogItem(row = {}) {
  return {
    id: row.id,
    actorType: firstDefined(row, ["actorType", "actor_type"]),
    actorId: firstDefined(row, ["actorId", "actor_id"]),
    eventType: firstDefined(row, ["eventType", "event_type"]),
    entityType: firstDefined(row, ["entityType", "entity_type"]),
    entityId: firstDefined(row, ["entityId", "entity_id"]),
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : null,
    createdAt: firstDefined(row, ["createdAt", "created_at"])
  };
}

function buildCsvDocument(headers = [], rows = []) {
  const lines = [headers.map((value) => toCsvCell(value)).join(",")];
  for (const row of rows) {
    lines.push(row.map((value) => toCsvCell(value)).join(","));
  }
  return lines.join("\n");
}

function buildDeveloperOpsProjectsCsv(items = []) {
  return buildCsvDocument(
    [
      "projectId",
      "projectCode",
      "projectName",
      "status",
      "allowRegister",
      "allowAccountLogin",
      "allowCardLogin",
      "allowCardRecharge",
      "allowVersionCheck",
      "allowNotices",
      "allowClientUnbind",
      "updatedAt"
    ],
    items.map((item) => [
      item.id,
      item.code,
      item.name,
      item.status,
      item.featureConfig?.allowRegister !== false,
      item.featureConfig?.allowAccountLogin !== false,
      item.featureConfig?.allowCardLogin !== false,
      item.featureConfig?.allowCardRecharge !== false,
      item.featureConfig?.allowVersionCheck !== false,
      item.featureConfig?.allowNotices !== false,
      item.featureConfig?.allowClientUnbind !== false,
      item.updatedAt
    ])
  );
}

function buildDeveloperOpsAccountsCsv(items = []) {
  return buildCsvDocument(
    [
      "accountId",
      "projectCode",
      "username",
      "status",
      "activeEntitlementCount",
      "activeSessionCount",
      "lastLoginAt",
      "latestEntitlementEndsAt",
      "createdAt",
      "updatedAt"
    ],
    items.map((item) => [
      item.id,
      item.productCode,
      item.username,
      item.status,
      item.activeEntitlementCount,
      item.activeSessionCount,
      item.lastLoginAt,
      item.latestEntitlementEndsAt,
      item.createdAt,
      item.updatedAt
    ])
  );
}

function buildDeveloperOpsEntitlementsCsv(items = []) {
  return buildCsvDocument(
    [
      "entitlementId",
      "projectCode",
      "username",
      "policyName",
      "status",
      "lifecycleStatus",
      "grantType",
      "totalPoints",
      "remainingPoints",
      "endsAt",
      "cardControlStatus",
      "activeSessionCount",
      "createdAt",
      "updatedAt"
    ],
    items.map((item) => [
      item.id,
      item.productCode,
      item.username,
      item.policyName,
      item.status,
      item.lifecycleStatus,
      item.grantType,
      item.totalPoints,
      item.remainingPoints,
      item.endsAt,
      item.cardControlStatus,
      item.activeSessionCount,
      item.createdAt,
      item.updatedAt
    ])
  );
}

function buildDeveloperOpsSessionsCsv(items = []) {
  return buildCsvDocument(
    [
      "sessionId",
      "projectCode",
      "username",
      "status",
      "fingerprint",
      "deviceName",
      "policyName",
      "issuedAt",
      "lastHeartbeatAt",
      "expiresAt",
      "lastSeenIp",
      "revokedReason"
    ],
    items.map((item) => [
      item.id,
      item.productCode,
      item.username,
      item.status,
      item.fingerprint,
      item.deviceName,
      item.policyName,
      item.issuedAt,
      item.lastHeartbeatAt,
      item.expiresAt,
      item.lastSeenIp,
      item.revokedReason
    ])
  );
}

function buildDeveloperOpsBindingsCsv(items = []) {
  return buildCsvDocument(
    [
      "bindingId",
      "projectCode",
      "username",
      "status",
      "fingerprint",
      "deviceName",
      "policyName",
      "identityHash",
      "bindRequestIp",
      "activeSessionCount",
      "firstBoundAt",
      "lastBoundAt",
      "revokedAt"
    ],
    items.map((item) => [
      item.id,
      item.productCode,
      item.username,
      item.status,
      item.fingerprint,
      item.deviceName,
      item.policyName,
      item.identityHash,
      item.bindRequestIp,
      item.activeSessionCount,
      item.firstBoundAt,
      item.lastBoundAt,
      item.revokedAt
    ])
  );
}

function buildDeveloperOpsBlocksCsv(items = []) {
  return buildCsvDocument(
    [
      "blockId",
      "projectCode",
      "status",
      "fingerprint",
      "deviceName",
      "reason",
      "notes",
      "activeSessionCount",
      "lastSeenIp",
      "createdAt",
      "updatedAt",
      "releasedAt"
    ],
    items.map((item) => [
      item.id,
      item.productCode,
      item.status,
      item.fingerprint,
      item.deviceName,
      item.reason,
      item.notes,
      item.activeSessionCount,
      item.lastSeenIp,
      item.createdAt,
      item.updatedAt,
      item.releasedAt
    ])
  );
}

function buildDeveloperOpsAuditLogsCsv(items = []) {
  return buildCsvDocument(
    [
      "auditLogId",
      "eventType",
      "actorType",
      "actorId",
      "entityType",
      "entityId",
      "productCode",
      "username",
      "reason",
      "createdAt",
      "metadataJson"
    ],
    items.map((item) => [
      item.id,
      item.eventType,
      item.actorType,
      item.actorId,
      item.entityType,
      item.entityId,
      item.metadata?.productCode ?? "",
      item.metadata?.username ?? "",
      item.metadata?.reason ?? "",
      item.createdAt,
      JSON.stringify(item.metadata ?? {})
    ])
  );
}

function normalizeSnapshotStatus(value) {
  return String(value ?? "").trim().toLowerCase();
}

function snapshotDateMs(value) {
  const ms = new Date(value || "").getTime();
  return Number.isNaN(ms) ? -1 : ms;
}

function countSnapshotItems(items = [], statuses = []) {
  const normalizedStatuses = new Set(statuses.map((value) => normalizeSnapshotStatus(value)));
  return items.reduce((count, item) => {
    return normalizedStatuses.has(normalizeSnapshotStatus(item?.status)) ? count + 1 : count;
  }, 0);
}

function latestSnapshotTimestamp(values = []) {
  let latest = null;
  let latestMs = -1;
  for (const value of values) {
    const ms = snapshotDateMs(value);
    if (ms <= latestMs) {
      continue;
    }
    latest = value;
    latestMs = ms;
  }
  return latest;
}

function buildSnapshotTopCounts(items = [], selector, limit = 5) {
  const counts = new Map();
  for (const item of items) {
    const rawValue = selector(item);
    if (Array.isArray(rawValue)) {
      for (const entry of rawValue) {
        const value = String(entry ?? "").trim();
        if (!value) {
          continue;
        }
        counts.set(value, (counts.get(value) || 0) + 1);
      }
      continue;
    }
    const value = String(rawValue ?? "").trim();
    if (!value) {
      continue;
    }
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0]);
    })
    .slice(0, limit);
}

function mapSnapshotTopCounts(items = [], selector, keyName, limit = 5) {
  return buildSnapshotTopCounts(items, selector, limit)
    .map(([value, count]) => ({ [keyName]: value, count }));
}

const SNAPSHOT_SEVERITY_RANKS = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1
};

function snapshotSeverityRank(value) {
  const key = String(value ?? "").trim().toLowerCase();
  return SNAPSHOT_SEVERITY_RANKS[key] || 0;
}

function snapshotArrayIncludes(values = [], expected) {
  return Array.isArray(values) && values.includes(expected);
}

function buildSnapshotFocusAccountSeverity(item = {}) {
  const signals = Array.isArray(item.signals) ? item.signals : [];
  if (snapshotArrayIncludes(signals, "account_disabled") && Number(item.activeSessionCount || 0) > 0) {
    return "critical";
  }
  if (
    snapshotArrayIncludes(signals, "entitlement_frozen")
    || (snapshotArrayIncludes(signals, "account_disabled") && Number(item.activeEntitlementCount || 0) > 0)
  ) {
    return "high";
  }
  if (
    snapshotArrayIncludes(signals, "points_exhausted")
    || snapshotArrayIncludes(signals, "entitlement_expired")
    || snapshotArrayIncludes(signals, "session_expired")
    || snapshotArrayIncludes(signals, "session_revoked")
    || snapshotArrayIncludes(signals, "account_disabled")
  ) {
    return "medium";
  }
  return "low";
}

function buildSnapshotFocusAccountActionHint(item = {}) {
  const signals = Array.isArray(item.signals) ? item.signals : [];
  const firstReason = Array.isArray(item.reasons) ? item.reasons.find((entry) => String(entry ?? "").trim()) : "";
  if (snapshotArrayIncludes(signals, "account_disabled") && Number(item.activeSessionCount || 0) > 0) {
    return "Review this disabled account first and confirm all lingering sessions are revoked before telling the customer to retry.";
  }
  if (snapshotArrayIncludes(signals, "entitlement_frozen")) {
    return "Check why the entitlement was frozen and resume or extend it only after support confirms access should return.";
  }
  if (snapshotArrayIncludes(signals, "points_exhausted")) {
    return "Recharge or adjust remaining points if this customer should keep logging in.";
  }
  if (snapshotArrayIncludes(signals, "entitlement_expired")) {
    return "Extend or renew the entitlement if this customer should regain access.";
  }
  if (snapshotArrayIncludes(signals, "account_disabled")) {
    return "Decide whether to re-enable this account or keep it blocked before the next login attempt.";
  }
  if (firstReason) {
    return `Inspect recent session revocations for this account, starting with "${firstReason}".`;
  }
  return "Inspect recent account, entitlement, and session changes before taking action on this customer.";
}

function buildSnapshotFocusSessionSeverity(item = {}) {
  const reason = String(item.reason ?? "").trim().toLowerCase();
  if (reason.includes("block") || reason.includes("ban") || reason.includes("forbid")) {
    return "critical";
  }
  if (reason) {
    return "high";
  }
  if (normalizeSnapshotStatus(item.status) === "expired") {
    return "medium";
  }
  return "low";
}

function buildSnapshotFocusSessionActionHint(item = {}) {
  const reason = String(item.reason ?? "").trim().toLowerCase();
  if (reason.includes("block") || reason.includes("ban") || reason.includes("forbid")) {
    return "Check whether this session was forced offline by a block rule before allowing another login.";
  }
  if (String(item.reason ?? "").trim()) {
    return "Review why this session was revoked and decide whether a fresh login or manual unblock is appropriate.";
  }
  if (normalizeSnapshotStatus(item.status) === "expired") {
    return "Check heartbeat timing and client connectivity before asking the customer to retry.";
  }
  return "Inspect this session before restoring access.";
}

function buildSnapshotFocusDeviceSeverity(item = {}) {
  const kind = normalizeSnapshotStatus(item.kind);
  const status = normalizeSnapshotStatus(item.status);
  if (kind === "block" && status === "active") {
    return "critical";
  }
  if (kind === "binding" && ["revoked", "released"].includes(status)) {
    return "high";
  }
  if (kind === "session" || Number(item.relatedSessionCount || 0) > 0) {
    return "medium";
  }
  return "low";
}

function buildSnapshotFocusDeviceActionHint(item = {}) {
  const kind = normalizeSnapshotStatus(item.kind);
  const status = normalizeSnapshotStatus(item.status);
  if (kind === "block" && status === "active") {
    return "Keep this fingerprint blocked until device review is complete, or unblock only after confirming it is safe.";
  }
  if (kind === "binding" && ["revoked", "released"].includes(status)) {
    return "Confirm whether this hardware change is legitimate before releasing another seat or rebinding.";
  }
  if (kind === "session") {
    return "Inspect recent login or heartbeat failures on this device before asking the customer to retry.";
  }
  if (kind === "block") {
    return "Verify whether this device can safely log in again before clearing related notes or filters.";
  }
  return "Inspect this device history before restoring access.";
}

function buildSnapshotFocusAccounts(accounts = [], entitlements = [], sessions = [], limit = 5) {
  const items = new Map();

  function ensureItem(username, productCode) {
    const normalizedUsername = String(username ?? "").trim();
    const normalizedProductCode = String(productCode ?? "").trim();
    if (!normalizedUsername || !normalizedProductCode) {
      return null;
    }
    const key = `${normalizedProductCode}::${normalizedUsername}`;
    if (!items.has(key)) {
      items.set(key, {
        username: normalizedUsername,
        productCode: normalizedProductCode,
        accountId: null,
        entitlementId: null,
        sessionId: null,
        accountStatus: null,
        issueCount: 0,
        signals: new Set(),
        reasons: new Set(),
        activeSessionCount: 0,
        activeEntitlementCount: 0,
        latestAt: null,
        latestMs: -1
      });
    }
    return items.get(key);
  }

  function touchItem(target, timestamp) {
    const ms = snapshotDateMs(timestamp);
    if (ms > target.latestMs) {
      target.latestMs = ms;
      target.latestAt = timestamp || null;
    }
  }

  for (const item of accounts) {
    if (normalizeSnapshotStatus(item?.status) !== "disabled") {
      continue;
    }
    const target = ensureItem(item?.username, item?.productCode);
    if (!target) {
      continue;
    }
    target.accountId = target.accountId || item?.id || null;
    target.accountStatus = item?.status || target.accountStatus;
    target.activeSessionCount = Math.max(target.activeSessionCount, Number(item?.activeSessionCount || 0));
    target.activeEntitlementCount = Math.max(target.activeEntitlementCount, Number(item?.activeEntitlementCount || 0));
    target.issueCount += 1;
    target.signals.add("account_disabled");
    touchItem(target, item?.updatedAt || item?.lastLoginAt || item?.createdAt);
  }

  for (const item of entitlements) {
    const lifecycleStatus = normalizeSnapshotStatus(item?.lifecycleStatus || item?.status);
    const pointExhausted = normalizeSnapshotStatus(item?.grantType || "duration") === "points"
      && Number(item?.remainingPoints || 0) <= 0;
    if (!["frozen", "expired"].includes(lifecycleStatus) && !pointExhausted) {
      continue;
    }
    const target = ensureItem(item?.username, item?.productCode);
    if (!target) {
      continue;
    }
    target.entitlementId = target.entitlementId || item?.id || null;
    target.issueCount += 1;
    if (lifecycleStatus === "frozen") {
      target.signals.add("entitlement_frozen");
    }
    if (lifecycleStatus === "expired") {
      target.signals.add("entitlement_expired");
    }
    if (pointExhausted) {
      target.signals.add("points_exhausted");
    }
    touchItem(target, item?.updatedAt || item?.endsAt || item?.createdAt);
  }

  for (const item of sessions) {
    const status = normalizeSnapshotStatus(item?.status);
    if (status === "active" && !item?.revokedReason) {
      continue;
    }
    const target = ensureItem(item?.username, item?.productCode);
    if (!target) {
      continue;
    }
    target.sessionId = target.sessionId || item?.id || null;
    target.issueCount += 1;
    target.signals.add(`session_${status || "issue"}`);
    if (item?.revokedReason) {
      target.reasons.add(String(item.revokedReason).trim());
    }
    touchItem(target, item?.lastHeartbeatAt || item?.expiresAt || item?.issuedAt);
  }

  return Array.from(items.values())
    .sort((left, right) => {
      if (right.issueCount !== left.issueCount) {
        return right.issueCount - left.issueCount;
      }
      if (right.latestMs !== left.latestMs) {
        return right.latestMs - left.latestMs;
      }
      if (left.productCode !== right.productCode) {
        return left.productCode.localeCompare(right.productCode);
      }
      return left.username.localeCompare(right.username);
    })
    .slice(0, limit)
    .map((item) => {
      const normalized = {
        username: item.username,
        productCode: item.productCode,
        accountId: item.accountId,
        entitlementId: item.entitlementId,
        sessionId: item.sessionId,
        accountStatus: item.accountStatus,
        issueCount: item.issueCount,
        signals: Array.from(item.signals),
        reasons: Array.from(item.reasons),
        activeSessionCount: item.activeSessionCount,
        activeEntitlementCount: item.activeEntitlementCount,
        latestAt: item.latestAt
      };
      return {
        ...normalized,
        severity: buildSnapshotFocusAccountSeverity(normalized),
        actionHint: buildSnapshotFocusAccountActionHint(normalized)
      };
    });
}

function buildSnapshotFocusSessions(sessions = [], limit = 5) {
  return sessions
    .filter((item) => normalizeSnapshotStatus(item?.status) !== "active" || item?.revokedReason)
    .sort((left, right) => {
      const leftMs = Math.max(snapshotDateMs(left?.lastHeartbeatAt), snapshotDateMs(left?.expiresAt), snapshotDateMs(left?.issuedAt));
      const rightMs = Math.max(snapshotDateMs(right?.lastHeartbeatAt), snapshotDateMs(right?.expiresAt), snapshotDateMs(right?.issuedAt));
      if (rightMs !== leftMs) {
        return rightMs - leftMs;
      }
      return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
    })
    .slice(0, limit)
    .map((item) => {
      const normalized = {
        sessionId: item?.id || null,
        accountId: item?.accountId || null,
        entitlementId: item?.entitlementId || null,
        username: item?.username || null,
        productCode: item?.productCode || null,
        status: item?.status || null,
        reason: item?.revokedReason || null,
        fingerprint: item?.fingerprint || null,
        deviceName: item?.deviceName || null,
        lastHeartbeatAt: item?.lastHeartbeatAt || null,
        expiresAt: item?.expiresAt || null,
        latestAt: item?.lastHeartbeatAt || item?.expiresAt || item?.issuedAt || null
      };
      return {
        ...normalized,
        severity: buildSnapshotFocusSessionSeverity(normalized),
        actionHint: buildSnapshotFocusSessionActionHint(normalized)
      };
    });
}

function buildSnapshotFocusDevices(bindings = [], blocks = [], sessions = [], limit = 5) {
  const items = new Map();

  function upsertDevice(entry) {
    const productCode = String(entry?.productCode ?? "").trim();
    const fingerprint = String(entry?.fingerprint ?? "").trim();
    if (!productCode || !fingerprint) {
      return;
    }
    const key = `${productCode}::${fingerprint}`;
    const latestMs = snapshotDateMs(entry?.latestAt);
    if (!items.has(key)) {
      items.set(key, {
        productCode,
        fingerprint,
        kind: entry?.kind || "device",
        status: entry?.status || null,
        reason: entry?.reason || null,
        username: entry?.username || null,
        deviceName: entry?.deviceName || null,
        bindingId: entry?.bindingId || null,
        blockId: entry?.blockId || null,
        sessionId: entry?.sessionId || null,
        latestAt: entry?.latestAt || null,
        latestMs,
        priority: Number(entry?.priority || 0),
        relatedSessionCount: Number(entry?.relatedSessionCount || 0)
      });
      return;
    }

    const current = items.get(key);
    if (Number(entry?.priority || 0) > current.priority) {
      current.kind = entry?.kind || current.kind;
      current.status = entry?.status || current.status;
      current.reason = entry?.reason || current.reason;
      current.priority = Number(entry?.priority || current.priority);
    }
    current.username = current.username || entry?.username || null;
    current.deviceName = current.deviceName || entry?.deviceName || null;
    current.bindingId = current.bindingId || entry?.bindingId || null;
    current.blockId = current.blockId || entry?.blockId || null;
    current.sessionId = current.sessionId || entry?.sessionId || null;
    current.relatedSessionCount = Math.max(current.relatedSessionCount, Number(entry?.relatedSessionCount || 0));
    if (latestMs > current.latestMs) {
      current.latestMs = latestMs;
      current.latestAt = entry?.latestAt || current.latestAt;
    }
  }

  for (const item of blocks) {
    upsertDevice({
      kind: "block",
      productCode: item?.productCode,
      fingerprint: item?.fingerprint,
      status: item?.status,
      reason: item?.reason,
      deviceName: item?.deviceName,
      blockId: item?.id,
      latestAt: item?.updatedAt || item?.releasedAt || item?.createdAt,
      priority: normalizeSnapshotStatus(item?.status) === "active" ? 3 : 1,
      relatedSessionCount: item?.activeSessionCount
    });
  }

  for (const item of bindings) {
    if (normalizeSnapshotStatus(item?.status) === "active") {
      continue;
    }
    upsertDevice({
      kind: "binding",
      productCode: item?.productCode,
      fingerprint: item?.fingerprint,
      status: item?.status,
      username: item?.username,
      deviceName: item?.deviceName,
      bindingId: item?.id,
      latestAt: item?.revokedAt || item?.lastBoundAt || item?.firstBoundAt,
      priority: 2,
      relatedSessionCount: item?.activeSessionCount
    });
  }

  for (const item of sessions) {
    if (normalizeSnapshotStatus(item?.status) === "active") {
      continue;
    }
    upsertDevice({
      kind: "session",
      productCode: item?.productCode,
      fingerprint: item?.fingerprint,
      status: item?.status,
      reason: item?.revokedReason,
      username: item?.username,
      deviceName: item?.deviceName,
      sessionId: item?.id,
      latestAt: item?.lastHeartbeatAt || item?.expiresAt || item?.issuedAt,
      priority: 2
    });
  }

  return Array.from(items.values())
    .sort((left, right) => {
      if (right.priority !== left.priority) {
        return right.priority - left.priority;
      }
      if (right.latestMs !== left.latestMs) {
        return right.latestMs - left.latestMs;
      }
      if (left.productCode !== right.productCode) {
        return left.productCode.localeCompare(right.productCode);
      }
      return left.fingerprint.localeCompare(right.fingerprint);
    })
    .slice(0, limit)
    .map((item) => {
      const normalized = {
        kind: item.kind,
        productCode: item.productCode,
        fingerprint: item.fingerprint,
        status: item.status,
        reason: item.reason,
        username: item.username,
        deviceName: item.deviceName,
        bindingId: item.bindingId,
        blockId: item.blockId,
        sessionId: item.sessionId,
        latestAt: item.latestAt,
        relatedSessionCount: item.relatedSessionCount
      };
      return {
        ...normalized,
        severity: buildSnapshotFocusDeviceSeverity(normalized),
        actionHint: buildSnapshotFocusDeviceActionHint(normalized)
      };
    });
}

function buildSnapshotOverview({
  generatedAt = nowIso(),
  projects = [],
  accounts = [],
  entitlements = [],
  sessions = [],
  bindings = [],
  blocks = [],
  auditLogs = []
} = {}) {
  const metrics = {
    activeProjects: projects.reduce((count, item) => count + (normalizeSnapshotStatus(item?.status || "active") === "active" ? 1 : 0), 0),
    inactiveProjects: projects.reduce((count, item) => count + (normalizeSnapshotStatus(item?.status || "active") !== "active" ? 1 : 0), 0),
    disabledAccounts: countSnapshotItems(accounts, ["disabled"]),
    frozenEntitlements: entitlements.reduce((count, item) => {
      return normalizeSnapshotStatus(item?.lifecycleStatus || item?.status) === "frozen" ? count + 1 : count;
    }, 0),
    expiredEntitlements: entitlements.reduce((count, item) => {
      return normalizeSnapshotStatus(item?.lifecycleStatus || item?.status) === "expired" ? count + 1 : count;
    }, 0),
    pointExhaustedEntitlements: entitlements.reduce((count, item) => {
      const grantType = normalizeSnapshotStatus(item?.grantType || "duration");
      if (grantType !== "points") {
        return count;
      }
      return Number(item?.remainingPoints || 0) <= 0 ? count + 1 : count;
    }, 0),
    activeSessions: countSnapshotItems(sessions, ["active"]),
    expiredSessions: countSnapshotItems(sessions, ["expired"]),
    activeBindings: countSnapshotItems(bindings, ["active"]),
    releasedBindings: countSnapshotItems(bindings, ["revoked", "released"]),
    activeBlocks: countSnapshotItems(blocks, ["active"]),
    releasedBlocks: countSnapshotItems(blocks, ["released"])
  };

  const topAuditEvents = buildSnapshotTopCounts(auditLogs, (item) => item?.eventType, 5)
    .map(([eventType, count]) => ({ eventType, count }));
  const topProducts = mapSnapshotTopCounts(
    [
      ...projects.map((item) => ({ productCode: item?.code })),
      ...accounts,
      ...entitlements,
      ...sessions,
      ...bindings,
      ...blocks,
      ...auditLogs.map((item) => ({
        productCode: item?.metadata?.productCode || item?.metadata?.code || item?.metadata?.projectCode || item?.metadata?.softwareCode || item?.metadata?.productCodes || item?.metadata?.projectCodes
      }))
    ],
    (item) => item?.productCode,
    "productCode",
    5
  );
  const topReasons = mapSnapshotTopCounts(
    [
      ...blocks.map((item) => ({ reason: item?.reason })),
      ...sessions.map((item) => ({ reason: item?.revokedReason })),
      ...auditLogs.map((item) => ({
        reason: [
          item?.metadata?.reason,
          item?.metadata?.revokedReason,
          item?.metadata?.releaseReason
        ]
      }))
    ],
    (item) => item?.reason,
    "reason",
    5
  );
  const focusUsernames = mapSnapshotTopCounts(
    [
      ...accounts
        .filter((item) => normalizeSnapshotStatus(item?.status) === "disabled")
        .map((item) => ({ username: item?.username })),
      ...entitlements
        .filter((item) => {
          const lifecycleStatus = normalizeSnapshotStatus(item?.lifecycleStatus || item?.status);
          return lifecycleStatus === "frozen"
            || lifecycleStatus === "expired"
            || (normalizeSnapshotStatus(item?.grantType || "duration") === "points" && Number(item?.remainingPoints || 0) <= 0);
        })
        .map((item) => ({ username: item?.username })),
      ...sessions
        .filter((item) => normalizeSnapshotStatus(item?.status) !== "active")
        .map((item) => ({ username: item?.username })),
      ...auditLogs.map((item) => ({
        username: [
          item?.metadata?.username,
          item?.metadata?.tokenSubject,
          item?.metadata?.redeemedUsername
        ]
      }))
    ],
    (item) => item?.username,
    "username",
    5
  );
  const focusFingerprints = mapSnapshotTopCounts(
    [
      ...blocks
        .filter((item) => normalizeSnapshotStatus(item?.status) === "active")
        .map((item) => ({ fingerprint: item?.fingerprint })),
      ...bindings
        .filter((item) => normalizeSnapshotStatus(item?.status) !== "active")
        .map((item) => ({ fingerprint: item?.fingerprint })),
      ...sessions
        .filter((item) => normalizeSnapshotStatus(item?.status) !== "active")
        .map((item) => ({ fingerprint: item?.fingerprint })),
      ...auditLogs.map((item) => ({
        fingerprint: [
          item?.metadata?.deviceFingerprint,
          item?.metadata?.fingerprint
        ]
      }))
    ],
    (item) => item?.fingerprint,
    "fingerprint",
    5
  );
  const focusAccounts = buildSnapshotFocusAccounts(accounts, entitlements, sessions, 5);
  const focusSessions = buildSnapshotFocusSessions(sessions, 5);
  const focusDevices = buildSnapshotFocusDevices(bindings, blocks, sessions, 5);

  const totalScopeItems = projects.length + accounts.length + entitlements.length + sessions.length + bindings.length + blocks.length + auditLogs.length;
  const attentionCount = metrics.inactiveProjects
    + metrics.disabledAccounts
    + metrics.frozenEntitlements
    + metrics.expiredEntitlements
    + metrics.pointExhaustedEntitlements
    + metrics.activeBlocks;

  let status = "ok";
  let headline = "Snapshot is ready for handoff and no obvious blockers were detected.";
  if (!totalScopeItems) {
    status = "empty";
    headline = "No scoped projects or authorization records were exported for this snapshot.";
  } else if (metrics.activeBlocks > 0) {
    status = "attention";
    headline = `${metrics.activeBlocks} active device blocks may explain current login failures.`;
  } else if (attentionCount > 0) {
    status = "attention";
    headline = `${attentionCount} scoped records need operational review.`;
  } else if (metrics.activeSessions > 0) {
    headline = `${metrics.activeSessions} active sessions are currently visible in this snapshot.`;
  }

  const highlights = [];
  if (metrics.inactiveProjects > 0) {
    highlights.push(`${metrics.inactiveProjects} projects are not active in the exported scope.`);
  }
  if (metrics.disabledAccounts > 0) {
    highlights.push(`${metrics.disabledAccounts} customer accounts are disabled.`);
  }
  if (metrics.frozenEntitlements > 0 || metrics.expiredEntitlements > 0) {
    highlights.push(`${metrics.frozenEntitlements} entitlements are frozen and ${metrics.expiredEntitlements} are expired.`);
  }
  if (metrics.pointExhaustedEntitlements > 0) {
    highlights.push(`${metrics.pointExhaustedEntitlements} point entitlements are fully consumed.`);
  }
  if (metrics.activeBlocks > 0) {
    highlights.push(`${metrics.activeBlocks} active device blocks may be causing repeated login or heartbeat failures.`);
  }
  if (metrics.expiredSessions > 0) {
    highlights.push(`${metrics.expiredSessions} sessions are already expired or revoked inside this scope.`);
  }
  if (topAuditEvents.length) {
    highlights.push(`Top audit events: ${topAuditEvents.slice(0, 3).map((item) => `${item.eventType} x${item.count}`).join(", ")}.`);
  }
  if (topReasons.length) {
    highlights.push(`Common reasons: ${topReasons.slice(0, 3).map((item) => `${item.reason} x${item.count}`).join(", ")}.`);
  }
  if (focusUsernames.length) {
    highlights.push(`Focus usernames: ${focusUsernames.slice(0, 3).map((item) => `${item.username} x${item.count}`).join(", ")}.`);
  }
  if (!highlights.length) {
    highlights.push("No obvious authorization anomalies were detected in the exported scope.");
  }

  return {
    status,
    headline,
    generatedAt,
    latestAuditAt: latestSnapshotTimestamp(auditLogs.map((item) => item?.createdAt)),
    totalScopeItems,
    metrics,
    highlights,
    topAuditEvents,
    topProducts,
    topReasons,
    focusUsernames,
    focusFingerprints,
    focusAccounts,
    focusSessions,
    focusDevices
  };
}

function buildDeveloperOpsSummaryText(payload = {}) {
  const scope = payload.scope || {};
  const summary = payload.summary || {};
  const overview = payload.overview || {};
  const lines = [
    "RockSolid Developer Ops Snapshot",
    `Generated At: ${payload.generatedAt || ""}`,
    `Developer: ${payload.developer?.username || "-"}`,
    `Actor: ${payload.actor?.username || "-"}`,
    `Actor Role: ${payload.actor?.role || "-"}`,
    `Accessible Projects: ${scope.accessibleProjectCount ?? 0}`,
    `Exported Projects: ${scope.exportedProjectCount ?? 0}`,
    `Project Filter: ${scope.productCode || "-"}`,
    `Username Filter: ${scope.username || "-"}`,
    `Search Filter: ${scope.search || "-"}`,
    `Audit Event Filter: ${scope.eventType || "-"}`,
    `Audit Actor Filter: ${scope.actorType || "-"}`,
    `Audit Entity Filter: ${scope.entityType || "-"}`,
    `Audit Limit: ${scope.auditLimit ?? 0}`,
    "",
    `Projects: ${summary.projects ?? 0}`,
    `Accounts: ${summary.accounts ?? 0}`,
    `Entitlements: ${summary.entitlements ?? 0}`,
    `Sessions: ${summary.sessions ?? 0}`,
    `Bindings: ${summary.bindings ?? 0}`,
    `Blocks: ${summary.blocks ?? 0}`,
    `Audit Logs: ${summary.auditLogs ?? 0}`
  ];

  if (overview && typeof overview === "object" && Object.keys(overview).length) {
    lines.push("");
    lines.push(`Overview Status: ${overview.status || "-"}`);
    lines.push(`Overview Headline: ${overview.headline || "-"}`);
    lines.push(`Latest Audit At: ${overview.latestAuditAt || "-"}`);
    if (Array.isArray(overview.highlights) && overview.highlights.length) {
      lines.push("Highlights:");
      for (const item of overview.highlights) {
        lines.push(`- ${item}`);
      }
    }
    if (Array.isArray(overview.topAuditEvents) && overview.topAuditEvents.length) {
      lines.push("Top Audit Events:");
      for (const item of overview.topAuditEvents) {
        lines.push(`- ${item.eventType || "-"} x${item.count ?? 0}`);
      }
    }
    if (Array.isArray(overview.topReasons) && overview.topReasons.length) {
      lines.push("Top Reasons:");
      for (const item of overview.topReasons) {
        lines.push(`- ${item.reason || "-"} x${item.count ?? 0}`);
      }
    }
    if (Array.isArray(overview.focusUsernames) && overview.focusUsernames.length) {
      lines.push("Focus Usernames:");
      for (const item of overview.focusUsernames) {
        lines.push(`- ${item.username || "-"} x${item.count ?? 0}`);
      }
    }
    if (Array.isArray(overview.focusFingerprints) && overview.focusFingerprints.length) {
      lines.push("Focus Fingerprints:");
      for (const item of overview.focusFingerprints) {
        lines.push(`- ${item.fingerprint || "-"} x${item.count ?? 0}`);
      }
    }
    if (Array.isArray(overview.focusAccounts) && overview.focusAccounts.length) {
      lines.push("Focus Account Details:");
      for (const item of overview.focusAccounts) {
        lines.push(`- ${item.username || "-"} @ ${item.productCode || "-"} | issues=${item.issueCount ?? 0} | severity=${item.severity || "-"} | account=${item.accountId || "-"} | next=${item.actionHint || "-"}`);
      }
    }
    if (Array.isArray(overview.focusSessions) && overview.focusSessions.length) {
      lines.push("Focus Sessions:");
      for (const item of overview.focusSessions) {
        lines.push(`- ${item.sessionId || "-"} | ${item.username || "-"} @ ${item.productCode || "-"} | ${item.status || "-"} | severity=${item.severity || "-"} | ${item.reason || "-"} | next=${item.actionHint || "-"}`);
      }
    }
    if (Array.isArray(overview.focusDevices) && overview.focusDevices.length) {
      lines.push("Focus Devices:");
      for (const item of overview.focusDevices) {
        lines.push(`- ${item.fingerprint || "-"} @ ${item.productCode || "-"} | ${item.kind || "-"} | ${item.status || "-"} | severity=${item.severity || "-"} | ${item.reason || "-"} | next=${item.actionHint || "-"}`);
      }
    }
  }

  if (Array.isArray(payload.projects) && payload.projects.length) {
    lines.push("");
    lines.push("Projects:");
    for (const item of payload.projects) {
      lines.push(`- ${item.code || "-"} (${item.name || ""}) [${item.status || "unknown"}]`);
    }
  }

  return lines.join("\n");
}

function buildDeveloperOpsSnapshotPayload({
  generatedAt = nowIso(),
  developer = null,
  actor = null,
  accessibleProjects = [],
  projects = [],
  filters = {},
  accounts = {},
  entitlements = {},
  sessions = {},
  bindings = {},
  blocks = {},
  auditLogs = {}
} = {}) {
  const normalizedProjects = projects.map((item) => normalizeDeveloperOpsProjectItem(item));
  const normalizedAccounts = (accounts.items || []).map((item) => normalizeDeveloperOpsAccountItem(item));
  const normalizedEntitlements = (entitlements.items || []).map((item) => normalizeDeveloperOpsEntitlementItem(item));
  const normalizedSessions = (sessions.items || []).map((item) => normalizeDeveloperOpsSessionItem(item));
  const normalizedBindings = (bindings.items || []).map((item) => normalizeDeveloperOpsBindingItem(item));
  const normalizedBlocks = (blocks.items || []).map((item) => normalizeDeveloperOpsBlockItem(item));
  const normalizedAuditLogs = (auditLogs.items || []).map((item) => normalizeDeveloperOpsAuditLogItem(item));
  const scopeTag = sanitizeExportNameSegment(filters.productCode || "all-projects", "developer-ops");
  const timestampTag = buildExportTimestampTag(generatedAt);

  const payload = {
    generatedAt,
    fileName: `rocksolid-developer-ops-${scopeTag}-${timestampTag}.json`,
    summaryFileName: `rocksolid-developer-ops-${scopeTag}-${timestampTag}-summary.txt`,
    developer,
    actor,
    scope: {
      accessibleProjectCount: accessibleProjects.length,
      exportedProjectCount: normalizedProjects.length,
      productCode: filters.productCode || null,
      username: filters.username || null,
      search: filters.search || null,
      eventType: filters.eventType || null,
      actorType: filters.actorType || null,
      entityType: filters.entityType || null,
      auditLimit: Number(filters.limit ?? auditLogs.filters?.limit ?? 0)
    },
    summary: {
      projects: normalizedProjects.length,
      accounts: normalizedAccounts.length,
      entitlements: normalizedEntitlements.length,
      sessions: normalizedSessions.length,
      bindings: normalizedBindings.length,
      blocks: normalizedBlocks.length,
      auditLogs: normalizedAuditLogs.length
    },
    overview: buildSnapshotOverview({
      generatedAt,
      projects: normalizedProjects,
      accounts: normalizedAccounts,
      entitlements: normalizedEntitlements,
      sessions: normalizedSessions,
      bindings: normalizedBindings,
      blocks: normalizedBlocks,
      auditLogs: normalizedAuditLogs
    }),
    projects: normalizedProjects,
    accounts: {
      total: Number(accounts.total ?? normalizedAccounts.length),
      filters: accounts.filters || {},
      items: normalizedAccounts
    },
    entitlements: {
      total: Number(entitlements.total ?? normalizedEntitlements.length),
      filters: entitlements.filters || {},
      items: normalizedEntitlements
    },
    sessions: {
      total: Number(sessions.total ?? normalizedSessions.length),
      filters: sessions.filters || {},
      items: normalizedSessions
    },
    bindings: {
      total: Number(bindings.total ?? normalizedBindings.length),
      filters: bindings.filters || {},
      items: normalizedBindings
    },
    blocks: {
      total: Number(blocks.total ?? normalizedBlocks.length),
      filters: blocks.filters || {},
      items: normalizedBlocks
    },
    auditLogs: {
      total: Number(auditLogs.total ?? normalizedAuditLogs.length),
      filters: auditLogs.filters || {},
      items: normalizedAuditLogs
    },
    csv: {
      projects: buildDeveloperOpsProjectsCsv(normalizedProjects),
      accounts: buildDeveloperOpsAccountsCsv(normalizedAccounts),
      entitlements: buildDeveloperOpsEntitlementsCsv(normalizedEntitlements),
      sessions: buildDeveloperOpsSessionsCsv(normalizedSessions),
      bindings: buildDeveloperOpsBindingsCsv(normalizedBindings),
      blocks: buildDeveloperOpsBlocksCsv(normalizedBlocks),
      auditLogs: buildDeveloperOpsAuditLogsCsv(normalizedAuditLogs)
    },
    notes: [
      "This export is scoped to the current developer actor and their assigned projects.",
      "Use the zip archive when you need a support handoff bundle with JSON, summary, and CSV snapshots.",
      "Audit logs are filtered separately from accounts, entitlements, sessions, bindings, and blocks."
    ]
  };

  payload.summaryText = buildDeveloperOpsSummaryText(payload);
  return payload;
}

function buildDeveloperOpsExportFiles(payload) {
  return [
    {
      path: payload.fileName || "developer-ops.json",
      body: JSON.stringify(payload, null, 2)
    },
    {
      path: payload.summaryFileName || "developer-ops-summary.txt",
      body: payload.summaryText || ""
    },
    {
      path: "csv/projects.csv",
      body: payload.csv?.projects || ""
    },
    {
      path: "csv/accounts.csv",
      body: payload.csv?.accounts || ""
    },
    {
      path: "csv/entitlements.csv",
      body: payload.csv?.entitlements || ""
    },
    {
      path: "csv/sessions.csv",
      body: payload.csv?.sessions || ""
    },
    {
      path: "csv/device-bindings.csv",
      body: payload.csv?.bindings || ""
    },
    {
      path: "csv/device-blocks.csv",
      body: payload.csv?.blocks || ""
    },
    {
      path: "csv/audit-logs.csv",
      body: payload.csv?.auditLogs || ""
    }
  ];
}

function buildDeveloperOpsExportZipEntries(payload) {
  const root = buildArchiveRootName(payload.fileName, "developer-ops");
  return buildZipEntriesFromFiles(root, buildDeveloperOpsExportFiles(payload));
}

function buildDeveloperOpsExportDownloadAsset(payload, format = "json") {
  const normalizedFormat = normalizeDownloadFormat(
    format,
    ["json", "summary", "zip", "checksums"],
    "json",
    "INVALID_DEVELOPER_OPS_EXPORT_FORMAT",
    "Developer ops export format"
  );

  if (normalizedFormat === "zip") {
    return {
      fileName: `${buildArchiveRootName(payload.fileName, "developer-ops")}.zip`,
      contentType: "application/zip",
      body: buildZipArchive(buildDeveloperOpsExportZipEntries(payload))
    };
  }

  if (normalizedFormat === "checksums") {
    return {
      fileName: buildChecksumFileName(payload.fileName, "developer-ops"),
      contentType: "text/plain; charset=utf-8",
      body: buildChecksumManifestText(buildDeveloperOpsExportFiles(payload))
    };
  }

  if (normalizedFormat === "summary") {
    return {
      fileName: payload.summaryFileName || "developer-ops-summary.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.summaryText || ""
    };
  }

  return {
    fileName: payload.fileName || "developer-ops.json",
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(payload, null, 2)
  };
}

function buildAdminOpsSummaryText(payload = {}) {
  const scope = payload.scope || {};
  const summary = payload.summary || {};
  const overview = payload.overview || {};
  const lines = [
    "RockSolid Admin Ops Snapshot",
    `Generated At: ${payload.generatedAt || ""}`,
    `Admin: ${payload.admin?.username || "-"}`,
    `Actor: ${payload.actor?.username || "-"}`,
    `Actor Role: ${payload.actor?.role || "-"}`,
    `Visible Projects: ${scope.accessibleProjectCount ?? 0}`,
    `Exported Projects: ${scope.exportedProjectCount ?? 0}`,
    `Project Filter: ${scope.productCode || "-"}`,
    `Username Filter: ${scope.username || "-"}`,
    `Search Filter: ${scope.search || "-"}`,
    `Audit Event Filter: ${scope.eventType || "-"}`,
    `Audit Actor Filter: ${scope.actorType || "-"}`,
    `Audit Entity Filter: ${scope.entityType || "-"}`,
    `Audit Limit: ${scope.auditLimit ?? 0}`,
    "",
    `Projects: ${summary.projects ?? 0}`,
    `Accounts: ${summary.accounts ?? 0}`,
    `Entitlements: ${summary.entitlements ?? 0}`,
    `Sessions: ${summary.sessions ?? 0}`,
    `Bindings: ${summary.bindings ?? 0}`,
    `Blocks: ${summary.blocks ?? 0}`,
    `Audit Logs: ${summary.auditLogs ?? 0}`
  ];

  if (overview && typeof overview === "object" && Object.keys(overview).length) {
    lines.push("");
    lines.push(`Overview Status: ${overview.status || "-"}`);
    lines.push(`Overview Headline: ${overview.headline || "-"}`);
    lines.push(`Latest Audit At: ${overview.latestAuditAt || "-"}`);
    if (Array.isArray(overview.highlights) && overview.highlights.length) {
      lines.push("Highlights:");
      for (const item of overview.highlights) {
        lines.push(`- ${item}`);
      }
    }
    if (Array.isArray(overview.topAuditEvents) && overview.topAuditEvents.length) {
      lines.push("Top Audit Events:");
      for (const item of overview.topAuditEvents) {
        lines.push(`- ${item.eventType || "-"} x${item.count ?? 0}`);
      }
    }
    if (Array.isArray(overview.topReasons) && overview.topReasons.length) {
      lines.push("Top Reasons:");
      for (const item of overview.topReasons) {
        lines.push(`- ${item.reason || "-"} x${item.count ?? 0}`);
      }
    }
    if (Array.isArray(overview.focusUsernames) && overview.focusUsernames.length) {
      lines.push("Focus Usernames:");
      for (const item of overview.focusUsernames) {
        lines.push(`- ${item.username || "-"} x${item.count ?? 0}`);
      }
    }
    if (Array.isArray(overview.focusFingerprints) && overview.focusFingerprints.length) {
      lines.push("Focus Fingerprints:");
      for (const item of overview.focusFingerprints) {
        lines.push(`- ${item.fingerprint || "-"} x${item.count ?? 0}`);
      }
    }
    if (Array.isArray(overview.focusAccounts) && overview.focusAccounts.length) {
      lines.push("Focus Account Details:");
      for (const item of overview.focusAccounts) {
        lines.push(`- ${item.username || "-"} @ ${item.productCode || "-"} | issues=${item.issueCount ?? 0} | severity=${item.severity || "-"} | account=${item.accountId || "-"} | next=${item.actionHint || "-"}`);
      }
    }
    if (Array.isArray(overview.focusSessions) && overview.focusSessions.length) {
      lines.push("Focus Sessions:");
      for (const item of overview.focusSessions) {
        lines.push(`- ${item.sessionId || "-"} | ${item.username || "-"} @ ${item.productCode || "-"} | ${item.status || "-"} | severity=${item.severity || "-"} | ${item.reason || "-"} | next=${item.actionHint || "-"}`);
      }
    }
    if (Array.isArray(overview.focusDevices) && overview.focusDevices.length) {
      lines.push("Focus Devices:");
      for (const item of overview.focusDevices) {
        lines.push(`- ${item.fingerprint || "-"} @ ${item.productCode || "-"} | ${item.kind || "-"} | ${item.status || "-"} | severity=${item.severity || "-"} | ${item.reason || "-"} | next=${item.actionHint || "-"}`);
      }
    }
  }

  if (Array.isArray(payload.projects) && payload.projects.length) {
    lines.push("");
    lines.push("Projects:");
    for (const item of payload.projects) {
      lines.push(`- ${item.code || "-"} (${item.name || ""}) [${item.status || "unknown"}]`);
    }
  }

  return lines.join("\n");
}

function buildAdminOpsSnapshotPayload({
  generatedAt = nowIso(),
  admin = null,
  actor = null,
  accessibleProjects = [],
  projects = [],
  filters = {},
  accounts = {},
  entitlements = {},
  sessions = {},
  bindings = {},
  blocks = {},
  auditLogs = {}
} = {}) {
  const normalizedProjects = projects.map((item) => normalizeDeveloperOpsProjectItem(item));
  const normalizedAccounts = (accounts.items || []).map((item) => normalizeDeveloperOpsAccountItem(item));
  const normalizedEntitlements = (entitlements.items || []).map((item) => normalizeDeveloperOpsEntitlementItem(item));
  const normalizedSessions = (sessions.items || []).map((item) => normalizeDeveloperOpsSessionItem(item));
  const normalizedBindings = (bindings.items || []).map((item) => normalizeDeveloperOpsBindingItem(item));
  const normalizedBlocks = (blocks.items || []).map((item) => normalizeDeveloperOpsBlockItem(item));
  const normalizedAuditLogs = (auditLogs.items || []).map((item) => normalizeDeveloperOpsAuditLogItem(item));
  const scopeTag = sanitizeExportNameSegment(filters.productCode || "all-projects", "admin-ops");
  const timestampTag = buildExportTimestampTag(generatedAt);

  const payload = {
    generatedAt,
    fileName: `rocksolid-admin-ops-${scopeTag}-${timestampTag}.json`,
    summaryFileName: `rocksolid-admin-ops-${scopeTag}-${timestampTag}-summary.txt`,
    admin,
    actor,
    scope: {
      accessibleProjectCount: accessibleProjects.length,
      exportedProjectCount: normalizedProjects.length,
      productCode: filters.productCode || null,
      username: filters.username || null,
      search: filters.search || null,
      eventType: filters.eventType || null,
      actorType: filters.actorType || null,
      entityType: filters.entityType || null,
      auditLimit: Number(filters.limit ?? auditLogs.filters?.limit ?? 0)
    },
    summary: {
      projects: normalizedProjects.length,
      accounts: normalizedAccounts.length,
      entitlements: normalizedEntitlements.length,
      sessions: normalizedSessions.length,
      bindings: normalizedBindings.length,
      blocks: normalizedBlocks.length,
      auditLogs: normalizedAuditLogs.length
    },
    overview: buildSnapshotOverview({
      generatedAt,
      projects: normalizedProjects,
      accounts: normalizedAccounts,
      entitlements: normalizedEntitlements,
      sessions: normalizedSessions,
      bindings: normalizedBindings,
      blocks: normalizedBlocks,
      auditLogs: normalizedAuditLogs
    }),
    projects: normalizedProjects,
    accounts: {
      total: Number(accounts.total ?? normalizedAccounts.length),
      filters: accounts.filters || {},
      items: normalizedAccounts
    },
    entitlements: {
      total: Number(entitlements.total ?? normalizedEntitlements.length),
      filters: entitlements.filters || {},
      items: normalizedEntitlements
    },
    sessions: {
      total: Number(sessions.total ?? normalizedSessions.length),
      filters: sessions.filters || {},
      items: normalizedSessions
    },
    bindings: {
      total: Number(bindings.total ?? normalizedBindings.length),
      filters: bindings.filters || {},
      items: normalizedBindings
    },
    blocks: {
      total: Number(blocks.total ?? normalizedBlocks.length),
      filters: blocks.filters || {},
      items: normalizedBlocks
    },
    auditLogs: {
      total: Number(auditLogs.total ?? normalizedAuditLogs.length),
      filters: auditLogs.filters || {},
      items: normalizedAuditLogs
    },
    csv: {
      projects: buildDeveloperOpsProjectsCsv(normalizedProjects),
      accounts: buildDeveloperOpsAccountsCsv(normalizedAccounts),
      entitlements: buildDeveloperOpsEntitlementsCsv(normalizedEntitlements),
      sessions: buildDeveloperOpsSessionsCsv(normalizedSessions),
      bindings: buildDeveloperOpsBindingsCsv(normalizedBindings),
      blocks: buildDeveloperOpsBlocksCsv(normalizedBlocks),
      auditLogs: buildDeveloperOpsAuditLogsCsv(normalizedAuditLogs)
    },
    notes: [
      "This export is generated from the admin console and can cover every project on the platform.",
      "Use the zip archive when you need a support handoff bundle with JSON, summary, and CSV snapshots.",
      "Audit logs stay platform-wide unless you apply a project filter to scope them to one product."
    ]
  };

  payload.summaryText = buildAdminOpsSummaryText(payload);
  return payload;
}

function buildAdminOpsExportFiles(payload) {
  return [
    {
      path: payload.fileName || "admin-ops.json",
      body: JSON.stringify(payload, null, 2)
    },
    {
      path: payload.summaryFileName || "admin-ops-summary.txt",
      body: payload.summaryText || ""
    },
    {
      path: "csv/projects.csv",
      body: payload.csv?.projects || ""
    },
    {
      path: "csv/accounts.csv",
      body: payload.csv?.accounts || ""
    },
    {
      path: "csv/entitlements.csv",
      body: payload.csv?.entitlements || ""
    },
    {
      path: "csv/sessions.csv",
      body: payload.csv?.sessions || ""
    },
    {
      path: "csv/device-bindings.csv",
      body: payload.csv?.bindings || ""
    },
    {
      path: "csv/device-blocks.csv",
      body: payload.csv?.blocks || ""
    },
    {
      path: "csv/audit-logs.csv",
      body: payload.csv?.auditLogs || ""
    }
  ];
}

function buildAdminOpsExportZipEntries(payload) {
  const root = buildArchiveRootName(payload.fileName, "admin-ops");
  return buildZipEntriesFromFiles(root, buildAdminOpsExportFiles(payload));
}

function buildAdminOpsExportDownloadAsset(payload, format = "json") {
  const normalizedFormat = normalizeDownloadFormat(
    format,
    ["json", "summary", "zip", "checksums"],
    "json",
    "INVALID_ADMIN_OPS_EXPORT_FORMAT",
    "Admin ops export format"
  );

  if (normalizedFormat === "zip") {
    return {
      fileName: `${buildArchiveRootName(payload.fileName, "admin-ops")}.zip`,
      contentType: "application/zip",
      body: buildZipArchive(buildAdminOpsExportZipEntries(payload))
    };
  }

  if (normalizedFormat === "checksums") {
    return {
      fileName: buildChecksumFileName(payload.fileName, "admin-ops"),
      contentType: "text/plain; charset=utf-8",
      body: buildChecksumManifestText(buildAdminOpsExportFiles(payload))
    };
  }

  if (normalizedFormat === "summary") {
    return {
      fileName: payload.summaryFileName || "admin-ops-summary.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.summaryText || ""
    };
  }

  return {
    fileName: payload.fileName || "admin-ops.json",
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(payload, null, 2)
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

async function listDeveloperAccessibleProductRows(db, store, session) {
  if (session.actor_scope === "owner") {
    return await Promise.resolve(store.products.queryProductRows(db, {
      ownerDeveloperId: session.developer_id
    }));
  }

  const productIds = listDeveloperAccessibleProductIds(db, session);
  return await Promise.resolve(store.products.queryProductRows(db, { productIds }));
}

async function listDeveloperAccessibleProductCodes(db, store, session) {
  const products = await listDeveloperAccessibleProductRows(db, store, session);
  return products.map((item) => item.code);
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

function sumMetricMap(map) {
  let total = 0;
  for (const value of map.values()) {
    total += numberCount(value);
  }
  return total;
}

async function queryProductOperationalMetricMaps(db, store, productIds = [], referenceTime = nowIso()) {
  const normalizedProductIds = Array.from(
    new Set(
      (Array.isArray(productIds) ? productIds : [])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    )
  );

  if (!normalizedProductIds.length) {
    return {
      activeSessionCounts: new Map(),
      activeBindingCounts: new Map(),
      releasedBindingCounts: new Map(),
      blockedDeviceCounts: new Map(),
      activeClientVersionCounts: new Map(),
      forceUpdateVersionCounts: new Map(),
      activeNoticeCounts: new Map(),
      blockingNoticeCounts: new Map(),
      activeNetworkRuleCounts: new Map()
    };
  }

  const [
    activeSessionRows,
    activeBindingRows,
    releasedBindingRows,
    blockedDeviceRows,
    activeClientVersionRows,
    forceUpdateVersionRows,
    activeNoticeRows,
    blockingNoticeRows,
    activeNetworkRuleRows
  ] = await Promise.all([
    Promise.resolve(store.sessions.countActiveSessionsByProductIds(db, normalizedProductIds)),
    Promise.resolve(store.devices.countActiveBindingsByProductIds(db, normalizedProductIds)),
    Promise.resolve(store.devices.countReleasedBindingsByProductIds(db, normalizedProductIds)),
    Promise.resolve(store.devices.countActiveBlocksByProductIds(db, normalizedProductIds)),
    Promise.resolve(store.versions.countActiveVersionsByProductIds(db, normalizedProductIds)),
    Promise.resolve(store.versions.countForceUpdateVersionsByProductIds(db, normalizedProductIds)),
    Promise.resolve(store.notices.countActiveNoticesByProductIds(db, normalizedProductIds, referenceTime)),
    Promise.resolve(store.notices.countBlockingNoticesByProductIds(db, normalizedProductIds, referenceTime)),
    Promise.resolve(store.networkRules.countActiveNetworkRulesByProductIds(db, normalizedProductIds))
  ]);

  return {
    activeSessionCounts: buildMetricMap(activeSessionRows),
    activeBindingCounts: buildMetricMap(activeBindingRows),
    releasedBindingCounts: buildMetricMap(releasedBindingRows),
    blockedDeviceCounts: buildMetricMap(blockedDeviceRows),
    activeClientVersionCounts: buildMetricMap(activeClientVersionRows),
    forceUpdateVersionCounts: buildMetricMap(forceUpdateVersionRows),
    activeNoticeCounts: buildMetricMap(activeNoticeRows),
    blockingNoticeCounts: buildMetricMap(blockingNoticeRows),
    activeNetworkRuleCounts: buildMetricMap(activeNetworkRuleRows)
  };
}

async function queryProductBusinessMetricMaps(db, store, productIds = [], referenceTime = nowIso()) {
  const normalizedProductIds = Array.from(
    new Set(
      (Array.isArray(productIds) ? productIds : [])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    )
  );

  if (!normalizedProductIds.length) {
    return {
      policyCounts: new Map(),
      freshCardCounts: new Map(),
      redeemedCardCounts: new Map(),
      accountCounts: new Map(),
      disabledAccountCounts: new Map(),
      activeEntitlementCounts: new Map()
    };
  }

  const [
    policyRows,
    freshCardRows,
    redeemedCardRows,
    accountRows,
    disabledAccountRows,
    activeEntitlementRows
  ] = await Promise.all([
    Promise.resolve(store.policies.countPoliciesByProductIds(db, normalizedProductIds)),
    Promise.resolve(store.cards.countCardsByProductIds(db, normalizedProductIds, "fresh")),
    Promise.resolve(store.cards.countCardsByProductIds(db, normalizedProductIds, "redeemed")),
    Promise.resolve(store.accounts.countAccountsByProductIds(db, normalizedProductIds)),
    Promise.resolve(store.accounts.countAccountsByProductIds(db, normalizedProductIds, "disabled")),
    Promise.resolve(store.entitlements.countActiveEntitlementsByProductIds(db, normalizedProductIds, referenceTime))
  ]);

  return {
    policyCounts: buildMetricMap(policyRows),
    freshCardCounts: buildMetricMap(freshCardRows),
    redeemedCardCounts: buildMetricMap(redeemedCardRows),
    accountCounts: buildMetricMap(accountRows),
    disabledAccountCounts: buildMetricMap(disabledAccountRows),
    activeEntitlementCounts: buildMetricMap(activeEntitlementRows)
  };
}

function countProductsWithEnabledFeature(products = [], featureKey) {
  return products.filter((item) => item.featureConfig?.[featureKey] !== false).length;
}

async function queryDeveloperDashboardPayload(db, store, session, runtimeState) {
  await expireStaleSessions(db, store, runtimeState);

  const products = await listDeveloperAccessibleProductRows(db, store, session);
  const summary = {
    projects: products.length,
    registerEnabledProjects: countProductsWithEnabledFeature(products, "allowRegister"),
    accountLoginEnabledProjects: countProductsWithEnabledFeature(products, "allowAccountLogin"),
    cardLoginEnabledProjects: countProductsWithEnabledFeature(products, "allowCardLogin"),
    cardRechargeEnabledProjects: countProductsWithEnabledFeature(products, "allowCardRecharge"),
    noticesEnabledProjects: countProductsWithEnabledFeature(products, "allowNotices"),
    versionCheckEnabledProjects: countProductsWithEnabledFeature(products, "allowVersionCheck"),
    clientUnbindEnabledProjects: countProductsWithEnabledFeature(products, "allowClientUnbind"),
    policies: 0,
    cardsFresh: 0,
    cardsRedeemed: 0,
    accounts: 0,
    disabledAccounts: 0,
    activeEntitlements: 0,
    activeSessions: 0,
    activeBindings: 0,
    releasedBindings: 0,
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
  const now = nowIso();
  const {
    policyCounts,
    freshCardCounts,
    redeemedCardCounts,
    accountCounts,
    disabledAccountCounts,
    activeEntitlementCounts
  } = await queryProductBusinessMetricMaps(db, store, productIds, now);
  const {
    activeSessionCounts,
    activeBindingCounts,
    releasedBindingCounts,
    blockedDeviceCounts,
    activeClientVersionCounts,
    forceUpdateVersionCounts,
    activeNoticeCounts,
    blockingNoticeCounts,
    activeNetworkRuleCounts
  } = await queryProductOperationalMetricMaps(db, store, productIds, now);

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
      releasedBindings: releasedBindingCounts.get(key) ?? 0,
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
    summary.releasedBindings += metrics.releasedBindings;
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

async function resolveDeveloperAccessibleProductByCode(db, store, session, productCode, permission, code, message) {
  const rows = await Promise.resolve(store.products.queryProductRows(db, {
    productCode,
    status: "active"
  }));
  const product = rows[0] ?? null;
  if (!product) {
    throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist or is inactive.");
  }
  return ensureDeveloperCanAccessProduct(db, session, product, permission, code, message);
}

async function resolveDeveloperAccessibleProductInput(db, store, session, selector = {}, permission, code, message) {
  const productId = String(selector.productId ?? "").trim();
  if (productId) {
    const rows = await Promise.resolve(store.products.queryProductRows(db, { productId }));
    const product = rows[0] ?? null;
    if (!product) {
      throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
    }
    return ensureDeveloperCanAccessProduct(db, session, product, permission, code, message);
  }

  const productCode = readProductCodeInput(selector, false);
  if (productCode) {
    const rows = await Promise.resolve(store.products.queryProductRows(db, { productCode }));
    const product = rows[0] ?? null;
    if (!product) {
      throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
    }
    return ensureDeveloperCanAccessProduct(db, session, product, permission, code, message);
  }

  throw new AppError(
    400,
    "VALIDATION_ERROR",
    "productId is required. productCode, projectCode, or softwareCode are also accepted."
  );
}

async function queryDeveloperMemberRows(db, store, developerId) {
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
      SELECT dmp.member_id, dmp.product_id, dmp.created_at
      FROM developer_member_products dmp
      JOIN developer_members dm ON dm.id = dmp.member_id
      WHERE dm.developer_id = ?
      ORDER BY dmp.created_at DESC
    `,
    developerId
  );

  const productRows = await Promise.resolve(store.products.queryProductRows(db, {
    productIds: accessRows.map((row) => row.product_id)
  }));
  const productMap = new Map(productRows.map((product) => [product.id, product]));
  const accessMap = new Map();
  for (const row of accessRows) {
    const items = accessMap.get(row.member_id) ?? [];
    const product = productMap.get(row.product_id);
    items.push({
      productId: row.product_id,
      productCode: product?.code ?? null,
      productName: product?.name ?? null,
      assignedAt: row.created_at
    });
    accessMap.set(row.member_id, items);
  }

  return members.map((row) => formatDeveloperMemberRow(row, accessMap.get(row.id) ?? []));
}

function ensureSqliteProductShadowRecords(db, products = []) {
  for (const product of products) {
    const existing = one(db, "SELECT id FROM products WHERE id = ?", product.id);
    const ownerDeveloperId = product.ownerDeveloperId ?? product.ownerDeveloper?.id ?? null;

    if (existing) {
      run(
        db,
        `
          UPDATE products
          SET code = ?, name = ?, description = ?, status = ?, owner_developer_id = ?,
              sdk_app_id = ?, sdk_app_secret = ?, created_at = ?, updated_at = ?
          WHERE id = ?
        `,
        product.code,
        product.name,
        product.description ?? "",
        product.status,
        ownerDeveloperId,
        product.sdkAppId,
        product.sdkAppSecret,
        product.createdAt,
        product.updatedAt,
        product.id
      );
      continue;
    }

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
      product.description ?? "",
      product.status,
      ownerDeveloperId,
      product.sdkAppId,
      product.sdkAppSecret,
      product.createdAt,
      product.updatedAt
    );
  }
}

function ensureSqlitePolicyShadowRecords(db, policies = []) {
  for (const policy of policies) {
    const existing = one(db, "SELECT id FROM policies WHERE id = ?", policy.id);
    const bindFieldsJson = JSON.stringify(
      Array.isArray(policy.bindFields) && policy.bindFields.length
        ? policy.bindFields
        : ["deviceFingerprint"]
    );

    if (existing) {
      run(
        db,
        `
          UPDATE policies
          SET product_id = ?, name = ?, duration_days = ?, max_devices = ?, allow_concurrent_sessions = ?,
              heartbeat_interval_seconds = ?, heartbeat_timeout_seconds = ?, token_ttl_seconds = ?,
              bind_mode = ?, status = ?, created_at = ?, updated_at = ?
          WHERE id = ?
        `,
        policy.productId,
        policy.name,
        Number(policy.durationDays ?? 0),
        Number(policy.maxDevices ?? 1),
        policy.allowConcurrentSessions ? 1 : 0,
        Number(policy.heartbeatIntervalSeconds ?? 60),
        Number(policy.heartbeatTimeoutSeconds ?? 180),
        Number(policy.tokenTtlSeconds ?? 300),
        policy.bindMode ?? "strict",
        policy.status ?? "active",
        policy.createdAt,
        policy.updatedAt,
        policy.id
      );
    } else {
      run(
        db,
        `
          INSERT INTO policies
          (id, product_id, name, duration_days, max_devices, allow_concurrent_sessions,
           heartbeat_interval_seconds, heartbeat_timeout_seconds, token_ttl_seconds,
           bind_mode, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        policy.id,
        policy.productId,
        policy.name,
        Number(policy.durationDays ?? 0),
        Number(policy.maxDevices ?? 1),
        policy.allowConcurrentSessions ? 1 : 0,
        Number(policy.heartbeatIntervalSeconds ?? 60),
        Number(policy.heartbeatTimeoutSeconds ?? 180),
        Number(policy.tokenTtlSeconds ?? 300),
        policy.bindMode ?? "strict",
        policy.status ?? "active",
        policy.createdAt,
        policy.updatedAt
      );
    }

    const bindConfig = one(db, "SELECT policy_id FROM policy_bind_configs WHERE policy_id = ?", policy.id);
    if (bindConfig) {
      run(
        db,
        `
          UPDATE policy_bind_configs
          SET bind_mode = ?, bind_fields_json = ?, updated_at = ?
          WHERE policy_id = ?
        `,
        policy.bindMode ?? "strict",
        bindFieldsJson,
        policy.updatedAt,
        policy.id
      );
    } else {
      run(
        db,
        `
          INSERT INTO policy_bind_configs (policy_id, bind_mode, bind_fields_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `,
        policy.id,
        policy.bindMode ?? "strict",
        bindFieldsJson,
        policy.createdAt,
        policy.updatedAt
      );
    }

    const unbindConfig = one(db, "SELECT policy_id FROM policy_unbind_configs WHERE policy_id = ?", policy.id);
    if (unbindConfig) {
      run(
        db,
        `
          UPDATE policy_unbind_configs
          SET allow_client_unbind = ?, client_unbind_limit = ?, client_unbind_window_days = ?,
              client_unbind_deduct_days = ?, updated_at = ?
          WHERE policy_id = ?
        `,
        policy.allowClientUnbind ? 1 : 0,
        Number(policy.clientUnbindLimit ?? 0),
        Number(policy.clientUnbindWindowDays ?? 30),
        Number(policy.clientUnbindDeductDays ?? 0),
        policy.updatedAt,
        policy.id
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
        policy.id,
        policy.allowClientUnbind ? 1 : 0,
        Number(policy.clientUnbindLimit ?? 0),
        Number(policy.clientUnbindWindowDays ?? 30),
        Number(policy.clientUnbindDeductDays ?? 0),
        policy.createdAt,
        policy.updatedAt
      );
    }

    const grantConfig = one(db, "SELECT policy_id FROM policy_grant_configs WHERE policy_id = ?", policy.id);
    if (grantConfig) {
      run(
        db,
        `
          UPDATE policy_grant_configs
          SET grant_type = ?, grant_points = ?, updated_at = ?
          WHERE policy_id = ?
        `,
        policy.grantType ?? "duration",
        Number(policy.grantPoints ?? 0),
        policy.updatedAt,
        policy.id
      );
    } else {
      run(
        db,
        `
          INSERT INTO policy_grant_configs (policy_id, grant_type, grant_points, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `,
        policy.id,
        policy.grantType ?? "duration",
        Number(policy.grantPoints ?? 0),
        policy.createdAt,
        policy.updatedAt
      );
    }
  }
}

function ensureSqliteLicenseKeyShadowRecords(db, cards = []) {
  for (const card of cards) {
    const licenseKeyId = card.id ?? card.licenseKeyId ?? null;
    if (!licenseKeyId) {
      continue;
    }

    const existing = one(db, "SELECT * FROM license_keys WHERE id = ?", licenseKeyId);
    const rawStatus = card.status ?? card.usageStatus ?? card.usage_status ?? existing?.status ?? "fresh";
    const status = ["redeemed", "used"].includes(String(rawStatus).trim().toLowerCase())
      ? "redeemed"
      : "fresh";
    const productId = card.productId ?? card.product_id ?? existing?.product_id ?? null;
    const policyId = card.policyId ?? card.policy_id ?? existing?.policy_id ?? null;
    const cardKey = String(card.cardKey ?? card.card_key ?? existing?.card_key ?? "")
      .trim()
      .toUpperCase();
    const batchCode = card.batchCode ?? card.batch_code ?? existing?.batch_code ?? null;
    const notes = card.notes ?? existing?.notes ?? null;
    const redeemedByAccountId = card.redeemedByAccountId ?? card.redeemed_by_account_id ?? existing?.redeemed_by_account_id ?? null;
    const issuedAt = card.issuedAt ?? card.issued_at ?? existing?.issued_at ?? nowIso();
    const redeemedAt = card.redeemedAt ?? card.redeemed_at ?? existing?.redeemed_at ?? null;

    if (!productId || !policyId || !cardKey) {
      continue;
    }

    if (existing) {
      run(
        db,
        `
          UPDATE license_keys
          SET product_id = ?, policy_id = ?, card_key = ?, batch_code = ?, status = ?, notes = ?,
              redeemed_by_account_id = ?, issued_at = ?, redeemed_at = ?
          WHERE id = ?
        `,
        productId,
        policyId,
        cardKey,
        batchCode,
        status,
        notes,
        redeemedByAccountId,
        issuedAt,
        redeemedAt,
        licenseKeyId
      );
    } else {
      run(
        db,
        `
          INSERT INTO license_keys
          (id, product_id, policy_id, card_key, batch_code, status, notes, redeemed_by_account_id, issued_at, redeemed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        licenseKeyId,
        productId,
        policyId,
        cardKey,
        batchCode,
        status,
        notes,
        redeemedByAccountId,
        issuedAt,
        redeemedAt
      );
    }
  }
}

function ensureSqliteLicenseKeyControlShadowRecords(db, controls = [], timestamp = nowIso()) {
  for (const control of controls) {
    const licenseKeyId = control.licenseKeyId ?? control.license_key_id ?? control.cardId ?? control.card_id ?? null;
    if (!licenseKeyId) {
      continue;
    }

    const status = normalizeCardControlStatus(control.status ?? "active");
    const expiresAt = control.expiresAt ?? control.expires_at ?? null;
    const notes = control.notes ?? null;
    const createdAt = control.createdAt ?? control.created_at ?? timestamp;
    const updatedAt = control.updatedAt ?? control.updated_at ?? timestamp;
    const existing = one(db, "SELECT license_key_id, created_at FROM license_key_controls WHERE license_key_id = ?", licenseKeyId);

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
        updatedAt,
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
        existing?.created_at ?? createdAt,
        updatedAt
      );
    }
  }
}

function ensureSqliteCustomerAccountShadowRecords(db, accounts = []) {
  for (const account of accounts) {
    const accountId = account.id ?? null;
    if (!accountId) {
      continue;
    }

    const existing = one(db, "SELECT * FROM customer_accounts WHERE id = ?", accountId);
    const productId = account.productId ?? account.product_id ?? existing?.product_id ?? null;
    const username = String(account.username ?? existing?.username ?? "").trim();
    const passwordHash = account.passwordHash ?? account.password_hash ?? existing?.password_hash ?? null;
    const status = account.status ?? existing?.status ?? "active";
    const createdAt = account.createdAt ?? account.created_at ?? existing?.created_at ?? nowIso();
    const updatedAt = account.updatedAt ?? account.updated_at ?? existing?.updated_at ?? createdAt;
    const lastLoginAt = account.lastLoginAt ?? account.last_login_at ?? existing?.last_login_at ?? null;

    if (!productId || !username || !passwordHash) {
      continue;
    }

    if (existing) {
      run(
        db,
        `
          UPDATE customer_accounts
          SET product_id = ?, username = ?, password_hash = ?, status = ?, created_at = ?, updated_at = ?, last_login_at = ?
          WHERE id = ?
        `,
        productId,
        username,
        passwordHash,
        status,
        createdAt,
        updatedAt,
        lastLoginAt,
        accountId
      );
    } else {
      run(
        db,
        `
          INSERT INTO customer_accounts
          (id, product_id, username, password_hash, status, created_at, updated_at, last_login_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        accountId,
        productId,
        username,
        passwordHash,
        status,
        createdAt,
        updatedAt,
        lastLoginAt
      );
    }
  }
}

function ensureSqliteCardLoginAccountShadowRecords(db, links = []) {
  for (const link of links) {
    const licenseKeyId = link.licenseKeyId ?? link.license_key_id ?? null;
    const accountId = link.accountId ?? link.account_id ?? null;
    const productId = link.productId ?? link.product_id ?? null;
    const createdAt = link.createdAt ?? link.created_at ?? nowIso();

    if (!licenseKeyId || !accountId || !productId) {
      continue;
    }

    const existing = one(db, "SELECT license_key_id FROM card_login_accounts WHERE license_key_id = ?", licenseKeyId);
    if (existing) {
      run(
        db,
        `
          UPDATE card_login_accounts
          SET account_id = ?, product_id = ?, created_at = ?
          WHERE license_key_id = ?
        `,
        accountId,
        productId,
        createdAt,
        licenseKeyId
      );
    } else {
      run(
        db,
        `
          INSERT INTO card_login_accounts (license_key_id, account_id, product_id, created_at)
          VALUES (?, ?, ?, ?)
        `,
        licenseKeyId,
        accountId,
        productId,
        createdAt
      );
    }
  }
}

async function syncDeveloperMemberProductAccess(db, store, developerId, memberId, productIds = [], timestamp = nowIso()) {
  const normalizedIds = Array.from(
    new Set(
      (Array.isArray(productIds) ? productIds : [])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    )
  );

  if (normalizedIds.length) {
    const rows = await Promise.resolve(store.products.queryProductRows(db, {
      ownerDeveloperId: developerId,
      productIds: normalizedIds
    }));
    if (rows.length !== normalizedIds.length) {
      throw new AppError(403, "DEVELOPER_PRODUCT_FORBIDDEN", "You can only assign member access to your own projects.");
    }
    ensureSqliteProductShadowRecords(db, rows);
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

async function resolveDeveloperOwnedProductIdsInput(db, store, developerId, body = {}) {
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
    const rows = await Promise.resolve(store.products.queryProductRows(db, { productCode }));
    const product = rows[0] ?? null;
    const ownerDeveloperId = product?.ownerDeveloperId ?? product?.ownerDeveloper?.id ?? null;
    if (!product || ownerDeveloperId !== developerId) {
      throw new AppError(403, "DEVELOPER_PRODUCT_FORBIDDEN", "You can only assign member access to your own projects.");
    }
    resolved.add(product.id);
  }

  return [...resolved];
}

function normalizeBatchProductSelector(body = {}) {
  const productIds = Array.isArray(body.productIds) ? body.productIds : [];
  const productCodes = Array.isArray(body.productCodes)
    ? body.productCodes
    : Array.isArray(body.projectCodes)
      ? body.projectCodes
      : Array.isArray(body.softwareCodes)
        ? body.softwareCodes
        : [];

  const provided = (
    body.productIds !== undefined
    || body.productCodes !== undefined
    || body.projectCodes !== undefined
    || body.softwareCodes !== undefined
  );

  const ids = Array.from(
    new Set(
      productIds
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    )
  );

  const codes = Array.from(
    new Set(
      productCodes
        .map((value) => String(value ?? "").trim().toUpperCase())
        .filter(Boolean)
    )
  );

  return {
    provided,
    ids,
    codes
  };
}

async function resolveAdminProductIdsInput(db, store, body = {}) {
  const selector = normalizeBatchProductSelector(body);
  if (!selector.provided) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "productIds, productCodes, projectCodes, or softwareCodes is required."
    );
  }

  const resolved = new Set(selector.ids);
  for (const productCode of selector.codes) {
    const rows = await Promise.resolve(store.products.queryProductRows(db, { productCode }));
    const product = rows[0] ?? null;
    if (!product) {
      throw new AppError(404, "PRODUCT_NOT_FOUND", `Product ${productCode} does not exist.`);
    }
    resolved.add(product.id);
  }

  if (!resolved.size) {
    throw new AppError(400, "VALIDATION_ERROR", "At least one product must be selected.");
  }

  return [...resolved];
}

async function resolveDeveloperProductIdsInput(
  db,
  store,
  session,
  body = {},
  permission = "products.write",
  message = "You can only manage products owned by your developer account."
) {
  const selector = normalizeBatchProductSelector(body);
  if (!selector.provided) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "productIds, productCodes, projectCodes, or softwareCodes is required."
    );
  }

  const resolved = new Set(selector.ids);
  for (const productCode of selector.codes) {
    const rows = await Promise.resolve(store.products.queryProductRows(db, { productCode }));
    const product = rows[0] ?? null;
    if (!product) {
      throw new AppError(404, "PRODUCT_NOT_FOUND", `Product ${productCode} does not exist.`);
    }
    ensureDeveloperCanAccessProduct(
      db,
      session,
      {
        id: product.id,
        owner_developer_id: product.ownerDeveloperId ?? product.ownerDeveloper?.id ?? null
      },
      permission,
      "DEVELOPER_PRODUCT_FORBIDDEN",
      message
    );
    resolved.add(product.id);
  }

  if (!resolved.size) {
    throw new AppError(400, "VALIDATION_ERROR", "At least one product must be selected.");
  }

  return [...resolved];
}

async function applyManagedProductStatusChange(db, store, stateStore, currentProduct, nextStatus, auditAction) {
  if (currentProduct.status === nextStatus) {
    return {
      ...currentProduct,
      status: nextStatus,
      changed: false,
      revokedSessions: 0
    };
  }

  return withTransaction(db, async () => {
    const updatedProduct = await Promise.resolve(
      store.products.updateProductStatus(currentProduct.id, nextStatus, nowIso())
    );
    const revokedSessions = nextStatus === "active"
      ? 0
      : await expireActiveSessions(db, store, stateStore, { productId: currentProduct.id }, `product_${nextStatus}`);

    auditAction(updatedProduct, revokedSessions);

    return {
      ...updatedProduct,
      changed: true,
      revokedSessions
    };
  });
}

function summarizeManagedProductStatusBatch(nextStatus, items) {
  const total = items.length;
  const changed = items.filter((item) => item.changed).length;
  const revokedSessions = items.reduce((sum, item) => sum + Number(item.revokedSessions || 0), 0);

  return {
    status: nextStatus,
    total,
    changed,
    unchanged: total - changed,
    revokedSessions,
    items
  };
}

function snapshotManagedProductFeatureConfig(featureConfig = {}) {
  return Object.fromEntries(
    MANAGED_PRODUCT_FEATURE_KEYS.map((key) => [key, featureConfig?.[key] !== false])
  );
}

function sameManagedProductFeatureConfig(left = {}, right = {}) {
  return MANAGED_PRODUCT_FEATURE_KEYS.every((key) => {
    const leftValue = left?.[key] !== false;
    const rightValue = right?.[key] !== false;
    return leftValue === rightValue;
  });
}

async function applyManagedProductFeatureConfigChange(db, store, currentProduct, body, auditAction) {
  const previousFeatureConfig = snapshotManagedProductFeatureConfig(resolveProductFeatureConfig(db, currentProduct));
  const result = await Promise.resolve(store.products.updateProductFeatureConfig(currentProduct.id, body, nowIso()));
  const nextFeatureConfig = snapshotManagedProductFeatureConfig(result.featureConfig);
  const changed = !sameManagedProductFeatureConfig(previousFeatureConfig, nextFeatureConfig);

  auditAction(result.product, result.featureConfig, previousFeatureConfig, changed);

  return {
    ...result.product,
    featureConfig: result.featureConfig,
    changed
  };
}

function summarizeManagedProductFeatureConfigBatch(items) {
  const total = items.length;
  const changed = items.filter((item) => item.changed).length;

  return {
    total,
    changed,
    unchanged: total - changed,
    items
  };
}

async function applyManagedProductSdkCredentialRotation(store, currentProduct, body, auditAction) {
  const result = await Promise.resolve(store.products.rotateProductSdkCredentials(currentProduct.id, body, nowIso()));
  auditAction(result.product, result.rotated);

  return {
    ...result.product,
    rotation: result.rotated
  };
}

function summarizeManagedProductSdkRotationBatch(rotateAppId, items) {
  return {
    rotateAppId: rotateAppId === true,
    total: items.length,
    items
  };
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

function loadProductFeatureConfig(db, productId, fallbackUpdatedAt = null) {
  const row = one(db, "SELECT * FROM product_feature_configs WHERE product_id = ?", productId);
  return parseProductFeatureConfigRow(row, fallbackUpdatedAt);
}

function resolveProductFeatureConfig(db, product) {
  if (product?.featureConfig && typeof product.featureConfig === "object") {
    return product.featureConfig;
  }
  return loadProductFeatureConfig(db, product.id, product.updated_at ?? product.updatedAt ?? null);
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

async function requireDeveloperOwnedProductByCode(db, store, session, productCode, permission = "products.read") {
  return resolveDeveloperAccessibleProductByCode(
    db,
    store,
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

function requireDeveloperOwnedEntitlement(db, session, entitlementId, permission = "ops.read") {
  const row = one(
    db,
    `
      SELECT e.*, pr.code AS product_code, pr.name AS product_name, pr.owner_developer_id,
             a.username, pol.name AS policy_name, lk.card_key
      FROM entitlements e
      JOIN products pr ON pr.id = e.product_id
      JOIN customer_accounts a ON a.id = e.account_id
      JOIN policies pol ON pol.id = e.policy_id
      JOIN license_keys lk ON lk.id = e.source_license_key_id
      WHERE e.id = ?
    `,
    entitlementId
  );

  if (!row) {
    throw new AppError(404, "ENTITLEMENT_NOT_FOUND", "Entitlement does not exist.");
  }
  ensureDeveloperCanAccessProduct(
    db,
    session,
    { id: row.product_id, owner_developer_id: row.owner_developer_id },
    permission,
    "DEVELOPER_OPS_FORBIDDEN",
    "You can only manage entitlements under your assigned projects."
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
  const featureConfig = resolveProductFeatureConfig(db, product);
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

async function loadPolicyBindConfig(db, store, policyId, fallbackBindMode = "strict", fallbackUpdatedAt = null) {
  const rows = await Promise.resolve(store.policies.queryPolicyRows(db, { policyId }));
  const policy = rows[0] ?? null;
  if (policy) {
    return {
      bindMode: policy.bindMode,
      bindFields: [...policy.bindFields],
      createdAt: policy.createdAt ?? fallbackUpdatedAt ?? null,
      updatedAt: policy.updatedAt ?? fallbackUpdatedAt ?? null
    };
  }
  return parsePolicyBindConfigRow(null, fallbackBindMode, fallbackUpdatedAt);
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


async function loadPolicyUnbindConfig(db, store, policyId, fallbackUpdatedAt = null) {
  const rows = await Promise.resolve(store.policies.queryPolicyRows(db, { policyId }));
  const policy = rows[0] ?? null;
  if (policy) {
    return {
      allowClientUnbind: policy.allowClientUnbind,
      clientUnbindLimit: policy.clientUnbindLimit,
      clientUnbindWindowDays: policy.clientUnbindWindowDays,
      clientUnbindDeductDays: policy.clientUnbindDeductDays,
      createdAt: policy.createdAt ?? fallbackUpdatedAt ?? null,
      updatedAt: policy.updatedAt ?? fallbackUpdatedAt ?? null
    };
  }
  return parsePolicyUnbindConfigRow(null, fallbackUpdatedAt);
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

async function releaseBindingRecord(db, store, stateStore, binding, reason, timestamp = nowIso()) {
  await Promise.resolve(store.devices.releaseBinding(binding.id, timestamp));
  return await expireActiveSessions(
    db,
    store,
    stateStore,
    {
      entitlementId: binding.entitlement_id,
      deviceId: binding.device_id
    },
    reason
  );
}

async function countRecentClientUnbinds(db, store, entitlementId, windowDays, referenceTime = nowIso()) {
  return Promise.resolve(store.devices.countRecentClientUnbinds(
    db,
    entitlementId,
    windowDays,
    referenceTime
  ));
}

async function recordEntitlementUnbind(store, entitlementId, bindingId, actorType, actorId, reason, deductedDays, timestamp = nowIso()) {
  return Promise.resolve(store.devices.recordEntitlementUnbind(
    entitlementId,
    bindingId,
    actorType,
    actorId,
    reason,
    deductedDays,
    timestamp
  ));
}

async function resolveClientManagedAccount(db, store, product, body) {
  if (body.username !== undefined || body.password !== undefined) {
    requireField(body, "username");
    requireField(body, "password");
    const account = await Promise.resolve(store.accounts.getAccountRecordByProductUsername(
      db,
      product.id,
      String(body.username).trim(),
      "active"
    ));

    if (!account || !verifyPassword(String(body.password), account.password_hash)) {
      throw new AppError(401, "ACCOUNT_LOGIN_FAILED", "Username or password is incorrect.");
    }

    const entitlement = await Promise.resolve(store.entitlements.getUsableEntitlement(
      db,
      account.id,
      product.id,
      nowIso()
    ));
    if (!entitlement) {
      throwEntitlementUnavailable(await Promise.resolve(store.entitlements.getLatestEntitlementSnapshot(
        db,
        account.id,
        product.id
      )));
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
      account = await Promise.resolve(store.accounts.getAccountRecordById(db, card.card_login_account_id));
      if (!account || account.status !== "active") {
        throw new AppError(403, "CARD_LOGIN_DISABLED", "This card-login identity has been disabled.");
      }
    } else {
      account = await Promise.resolve(store.accounts.createCardLoginAccount(product, card, nowIso()));
      audit(db, "license_key", card.id, "card.direct_account_create", "account", account.id, {
        productCode: product.code,
        username: account.username,
        cardKeyMasked: maskCardKey(card.card_key)
      });
      const activation = await Promise.resolve(store.entitlements.activateFreshCardEntitlement(
        product,
        account,
        card,
        nowIso()
      ));
      auditActivatedCardEntitlement(db, product, account, card, activation, "card.direct_redeem", {
        authMode: "card"
      });
    }

    const entitlement = await Promise.resolve(store.entitlements.getUsableEntitlement(
      db,
      account.id,
      product.id,
      nowIso()
    ));
    if (!entitlement) {
      throwEntitlementUnavailable(await Promise.resolve(store.entitlements.getLatestEntitlementSnapshot(
        db,
        account.id,
        product.id
      )));
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
async function queryDeviceBindingRows(db, store, filters = {}, runtimeState = null) {
  await expireStaleSessions(db, store, runtimeState);
  return Promise.resolve(store.devices.queryDeviceBindingRows(db, filters));
}

async function queryDeviceBlockRows(db, store, filters = {}) {
  return Promise.resolve(store.devices.queryDeviceBlockRows(db, filters));
}

async function querySessionRows(db, store, filters = {}, runtimeState = null) {
  await expireStaleSessions(db, store, runtimeState);
  return Promise.resolve(store.sessions.querySessionRows(db, filters));
}

function queryAuditLogRows(db, filters = {}) {
  const conditions = [];
  const params = [];
  const limit = Math.min(Math.max(Number(filters.limit ?? 50), 1), 200);
  const normalizedFilters = {
    eventType: filters.eventType ? String(filters.eventType).trim() : null,
    actorType: filters.actorType ? String(filters.actorType).trim() : null,
    entityType: filters.entityType ? String(filters.entityType).trim() : null,
    username: filters.username ? String(filters.username).trim() : null,
    search: filters.search ? String(filters.search).trim() : null,
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

  if (normalizedFilters.entityType) {
    conditions.push("entity_type = ?");
    params.push(normalizedFilters.entityType);
  }

  if (normalizedFilters.username) {
    conditions.push("metadata_json LIKE ?");
    params.push(`%\"username\":\"${normalizedFilters.username.replaceAll("\"", "\\\"")}\"%`);
  }

  if (normalizedFilters.search) {
    const pattern = likeFilter(normalizedFilters.search);
    conditions.push(
      "(COALESCE(actor_id, '') LIKE ? ESCAPE '\\' OR event_type LIKE ? ESCAPE '\\' OR entity_type LIKE ? ESCAPE '\\' OR COALESCE(entity_id, '') LIKE ? ESCAPE '\\' OR COALESCE(metadata_json, '') LIKE ? ESCAPE '\\')"
    );
    params.push(pattern, pattern, pattern, pattern, pattern);
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
      const productPredicates = productCodes.map(
        () => "(metadata_json LIKE ? OR metadata_json LIKE ? OR metadata_json LIKE ? OR metadata_json LIKE ? OR metadata_json LIKE ? OR metadata_json LIKE ?)"
      ).join(" OR ");
      scopedConditions.push(`(${productPredicates})`);
      for (const productCode of productCodes) {
        params.push(`%\"productCode\":\"${productCode}\"%`);
        params.push(`%\"code\":\"${productCode}\"%`);
        params.push(`%\"projectCode\":\"${productCode}\"%`);
        params.push(`%\"softwareCode\":\"${productCode}\"%`);
        params.push(`%\"productCodes\":%\"${productCode}\"%`);
        params.push(`%\"projectCodes\":%\"${productCode}\"%`);
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

async function queryNetworkRuleRows(db, store, filters = {}) {
  return Promise.resolve(store.networkRules.queryNetworkRuleRows(db, filters));
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

async function expireStaleSessions(db, store, stateStore) {
  const rows = store?.sessions?.listActiveSessionExpiryRows
    ? await Promise.resolve(store.sessions.listActiveSessionExpiryRows(db))
    : [];

  const now = Date.now();
  for (const row of rows) {
    const expiresAt = new Date(row.expires_at).getTime();
    const lastHeartbeat = new Date(row.last_heartbeat_at).getTime();
    const heartbeatDeadline = lastHeartbeat + row.heartbeat_timeout_seconds * 1000;

    if (expiresAt <= now || heartbeatDeadline <= now) {
      const reason = expiresAt <= now ? "token_expired" : "heartbeat_timeout";
      await expireSessionById(db, store, stateStore, row.id, reason);
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

function auditActivatedCardEntitlement(db, product, account, card, activation, eventType = "card.redeem", metadata = {}) {
  audit(db, "account", account.id, eventType, "license_key", card.id, {
    cardKey: activation.cardKey ?? card.card_key ?? card.cardKey ?? null,
    cardKeyMasked: maskCardKey(activation.cardKey ?? card.card_key ?? card.cardKey),
    policyName: activation.policyName ?? card.policy_name ?? card.policyName ?? null,
    grantType: activation.grantType,
    grantPoints: activation.totalPoints,
    resellerCode: activation.reseller?.code ?? null,
    resellerName: activation.reseller?.name ?? null,
    startsAt: activation.startsAt,
    endsAt: activation.endsAt,
    ...metadata
  });
}

async function expireSessionsForEntitlement(db, store, stateStore, entitlementId, reason) {
  return expireActiveSessions(
    db,
    store,
    stateStore,
    { entitlementId },
    reason
  );
}

async function expireSessionsForLicenseKey(db, store, stateStore, licenseKeyId, reason) {
  const entitlement = one(
    db,
    "SELECT id FROM entitlements WHERE source_license_key_id = ?",
    licenseKeyId
  );

  if (!entitlement) {
    return 0;
  }

  return expireSessionsForEntitlement(db, store, stateStore, entitlement.id, reason);
}

async function issueClientSession(
  db,
  store,
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
    bindConfig = null,
    syncAccountShadow = null
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
  const resolvedBindConfig = bindConfig ?? await loadPolicyBindConfig(
    db,
    store,
    entitlement.policy_id,
    entitlement.bind_mode,
    entitlement.updated_at
  );
  const bindingIdentity = buildBindingIdentity(resolvedBindConfig, resolvedDeviceProfile);
  const device = await Promise.resolve(store.devices.upsertDevice(
    product.id,
    resolvedDeviceProfile.deviceFingerprint,
    resolvedDeviceProfile.deviceName,
    meta,
    resolvedDeviceProfile
  ));
  const bindingResult = await Promise.resolve(store.devices.bindDeviceToEntitlement(
    entitlement,
    device,
    bindingIdentity,
    {
      releaseSessions: ({ entitlementId, deviceId, reason }) => expireActiveSessions(
        db,
        store,
        stateStore,
        {
          entitlementId,
          deviceId
        },
        reason ?? "binding_rebound"
      )
    }
  ));

  if (!entitlement.allow_concurrent_sessions) {
    await expireActiveSessions(
      db,
      store,
      stateStore,
      {
        accountId: account.id,
        productId: product.id
      },
      "single_session_policy"
    );
  }

  const quota = await Promise.resolve(store.entitlements.consumeEntitlementLoginQuota(entitlement, nowIso()));

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

  await Promise.resolve(store.sessions.createIssuedSession({
    id: sessionId,
    productId: product.id,
    accountId: account.id,
    entitlementId: entitlement.id,
    deviceId: device.id,
    sessionToken,
    licenseToken,
    issuedAt,
    expiresAt,
    lastHeartbeatAt: issuedAt,
    lastSeenIp: meta.ip,
    userAgent: meta.userAgent
  }));
  const touchedAccount = await Promise.resolve(store.accounts.touchAccountLastLogin(account.id, issuedAt));
  if (typeof syncAccountShadow === "function") {
    await syncAccountShadow(
      touchedAccount ?? {
        ...account,
        productId: account.productId ?? account.product_id ?? product.id,
        updatedAt: issuedAt,
        updated_at: issuedAt,
        lastLoginAt: issuedAt,
        last_login_at: issuedAt
      },
      product
    );
  }

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

async function requireDeviceNotBlocked(db, store, productId, fingerprint) {
  const block = await Promise.resolve(store.devices.getActiveDeviceBlock(db, productId, fingerprint));
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

async function listProductVersions(db, store, productId, channel) {
  return Promise.resolve(store.versions.listProductVersions(db, productId, channel));
}

async function buildVersionManifest(db, store, product, clientVersion, channel = "stable") {
  const normalizedChannel = normalizeChannel(channel);
  const rows = await listProductVersions(db, store, product.id, normalizedChannel);
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

async function requireClientVersionAllowed(db, store, product, clientVersion, channel = "stable") {
  if (!clientVersion) {
    return null;
  }

  const manifest = await buildVersionManifest(db, store, product, clientVersion, channel);
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

async function activeNoticesForProduct(db, store, productId, channel = "all") {
  return Promise.resolve(store.notices.listActiveNoticesForProduct(
    db,
    productId,
    channel,
    nowIso()
  ));
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

async function queryClientVersionRows(db, store, filters = {}) {
  return Promise.resolve(store.versions.queryClientVersionRows(db, filters));
}

async function queryNoticeRows(db, store, filters = {}) {
  return Promise.resolve(store.notices.queryNoticeRows(db, filters));
}

async function requireNoBlockingNotices(db, store, product, channel = "all") {
  const blocking = (await activeNoticesForProduct(db, store, product.id, channel))
    .filter((row) => row.blockLogin);
  if (!blocking.length) {
    return [];
  }

  throw new AppError(503, "LOGIN_BLOCKED_BY_NOTICE", blocking[0].title, {
    notices: blocking
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

async function enforceNetworkRules(db, store, product, ip, actionScope) {
  const normalizedIp = normalizeIpAddress(ip);
  if (!normalizedIp) {
    return;
  }

  const rules = await Promise.resolve(
    store.networkRules.listBlockingNetworkRulesForProduct(db, product.id, actionScope)
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

async function requireSignedProduct(db, store, config, stateStore, reqLike, rawBody) {
  const appId = reqLike.headers["x-rs-app-id"];
  const timestamp = reqLike.headers["x-rs-timestamp"];
  const nonce = reqLike.headers["x-rs-nonce"];
  const signature = reqLike.headers["x-rs-signature"];

  if (!appId || !timestamp || !nonce || !signature) {
    throw new AppError(401, "SDK_SIGNATURE_REQUIRED", "Missing signed SDK headers.");
  }

  const product = await Promise.resolve(store.products.getActiveProductRowBySdkAppId(db, appId));
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

  const expected = signClientRequest(product.sdkAppSecret ?? product.sdk_app_secret, {
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
      if (store?.sessions?.getSessionRecordByToken) {
        const row = await Promise.resolve(store.sessions.getSessionRecordByToken(db, sessionToken));
        const sessionState = formatDatabaseSessionState(row);
        if (sessionState) {
          return sessionState;
        }
      }

      const row = one(
        db,
        `
          SELECT status, revoked_reason, expires_at, last_heartbeat_at
          FROM sessions
          WHERE session_token = ?
        `,
        sessionToken
      );
      return formatDatabaseSessionState(row);
    },
    async countActiveSessions() {
      if (store?.sessions?.countActiveSessionsByProductIds) {
        const rows = await Promise.resolve(store.sessions.countActiveSessionsByProductIds(db, null));
        return rows.reduce((total, row) => total + Number(row.count ?? 0), 0);
      }

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

  async function getStoreProductById(productId) {
    const rows = await Promise.resolve(store.products.queryProductRows(db, { productId }));
    return rows[0] ?? null;
  }

  async function getStoreProductByCode(productCode) {
    const rows = await Promise.resolve(store.products.queryProductRows(db, { productCode }));
    return rows[0] ?? null;
  }

  async function getStoreActiveProductByCode(productCode) {
    const product = await getStoreProductByCode(productCode);
    if (!product || product.status !== "active") {
      throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist or is inactive.");
    }
    return product;
  }

  async function getStorePolicyById(policyId) {
    const rows = await Promise.resolve(store.policies.queryPolicyRows(db, { policyId }));
    return rows[0] ?? null;
  }

  async function getStoreCardById(cardId) {
    return Promise.resolve(store.cards.getCardRowById(db, cardId));
  }

  async function getStoreClientVersionById(versionId) {
    return Promise.resolve(store.versions.getClientVersionRowById(db, versionId));
  }

  async function getStoreNoticeById(noticeId) {
    return Promise.resolve(store.notices.getNoticeRowById(db, noticeId));
  }

  async function getStoreNetworkRuleById(ruleId) {
    return Promise.resolve(store.networkRules.getNetworkRuleRowById(db, ruleId));
  }

  async function getStoreEntitlementById(entitlementId) {
    const { items } = await Promise.resolve(store.entitlements.queryEntitlementRows(
      db,
      { entitlementId },
      { limit: 1 }
    ));
    return items[0] ?? null;
  }

  async function getStoreAccountById(accountId) {
    return Promise.resolve(store.accounts.getAccountManageRowById(db, accountId));
  }

  async function getStoreAccountRecordById(accountId) {
    return Promise.resolve(store.accounts.getAccountRecordById(db, accountId));
  }

  async function getStoreDeviceRecordByFingerprint(productId, fingerprint) {
    return Promise.resolve(store.devices.getDeviceRecordByFingerprint(db, productId, fingerprint));
  }

  async function getStoreDeviceBlockManageRowById(blockId) {
    return Promise.resolve(store.devices.getDeviceBlockManageRowById(db, blockId));
  }

  async function getStoreAccountRecordByProductUsername(productId, username, status = null) {
    return Promise.resolve(store.accounts.getAccountRecordByProductUsername(
      db,
      productId,
      username,
      status
    ));
  }

  async function getStoreBindingsForEntitlement(entitlementId) {
    return Promise.resolve(store.devices.queryBindingsForEntitlement(db, entitlementId));
  }

  async function getStoreUsableEntitlement(accountId, productId, referenceTime = nowIso()) {
    return Promise.resolve(store.entitlements.getUsableEntitlement(
      db,
      accountId,
      productId,
      referenceTime
    ));
  }

  async function getStoreLatestEntitlementSnapshot(accountId, productId) {
    return Promise.resolve(store.entitlements.getLatestEntitlementSnapshot(
      db,
      accountId,
      productId
    ));
  }

  async function getStoreSessionRecordByProductToken(productId, sessionToken) {
    return Promise.resolve(store.sessions.getSessionRecordByProductToken(db, productId, sessionToken));
  }

  async function getStoreActiveHeartbeatSession(productId, sessionToken) {
    return Promise.resolve(store.sessions.getActiveSessionHeartbeatRow(db, productId, sessionToken));
  }

  async function getStoreSessionManageRowById(sessionId) {
    return Promise.resolve(store.sessions.getSessionManageRowById(db, sessionId));
  }

  async function createShadowedCardBatch(product, policy, body = {}, timestamp = nowIso()) {
    const notes = normalizeOptionalText(body.notes, 1000) || null;
    const batch = await Promise.resolve(store.cards.createCardBatch(
      product,
      policy,
      {
        ...body,
        batchCode: body.batchCode,
        includeIssuedEntries: true
      },
      timestamp
    ));
    const issued = Array.isArray(batch?.issued) ? batch.issued : [];

    if (issued.length !== Number(batch?.count ?? 0)) {
      throw new AppError(500, "CARD_BATCH_INCOMPLETE", "Card batch creation did not return the full issued-card set.");
    }

    ensureSqliteProductShadowRecords(db, [product]);
    ensureSqlitePolicyShadowRecords(db, [policy]);
    ensureSqliteLicenseKeyShadowRecords(
      db,
      issued.map((entry) => ({
        id: entry.licenseKeyId,
        productId: product.id,
        policyId: policy.id,
        cardKey: entry.cardKey,
        batchCode: batch.batchCode,
        status: "fresh",
        notes,
        issuedAt: timestamp
      }))
    );

    if (batch.expiresAt) {
      ensureSqliteLicenseKeyControlShadowRecords(
        db,
        issued.map((entry) => ({
          licenseKeyId: entry.licenseKeyId,
          status: "active",
          expiresAt: batch.expiresAt,
          notes
        })),
        timestamp
      );
    }

    return batch;
  }

  function syncSqliteCardControlShadow(card, control, timestamp = nowIso()) {
    if (!card?.id || !control) {
      return;
    }

    ensureSqliteLicenseKeyShadowRecords(db, [{
      id: card.id,
      productId: card.productId,
      policyId: card.policyId,
      cardKey: card.cardKey,
      batchCode: card.batchCode,
      status: card.usageStatus,
      notes: card.notes ?? control.notes ?? null,
      issuedAt: card.issuedAt,
      redeemedAt: card.redeemedAt,
      redeemedByAccountId: card.redeemedByAccountId
    }]);
    ensureSqliteLicenseKeyControlShadowRecords(db, [{
      licenseKeyId: card.id,
      status: control.status,
      expiresAt: control.expiresAt,
      notes: control.notes ?? card.notes ?? null
    }], timestamp);
  }

  function getSqliteResellerAllocationByLicenseKey(licenseKeyId) {
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

  async function syncSqliteAccountRecordShadow(account, product = null) {
    if (!account?.id) {
      return;
    }

    const resolvedProduct = product ?? await getStoreProductById(account.productId ?? account.product_id);
    if (resolvedProduct) {
      ensureSqliteProductShadowRecords(db, [resolvedProduct]);
    }

    ensureSqliteCustomerAccountShadowRecords(db, [account]);
  }

  async function syncSqliteCardActivationShadow(
    product,
    account,
    card,
    timestamp = nowIso(),
    options = {}
  ) {
    const resolvedPolicyId = card?.policyId ?? card?.policy_id ?? null;
    if (resolvedPolicyId) {
      const policy = await getStorePolicyById(resolvedPolicyId);
      if (policy) {
        ensureSqlitePolicyShadowRecords(db, [policy]);
      }
    }

    await syncSqliteAccountRecordShadow(account, product);
    ensureSqliteLicenseKeyShadowRecords(db, [{
      id: card.id,
      productId: product.id,
      policyId: resolvedPolicyId,
      cardKey: card.cardKey ?? card.card_key,
      batchCode: card.batchCode ?? card.batch_code ?? null,
      status: "redeemed",
      notes: card.notes ?? card.control_notes ?? null,
      issuedAt: card.issuedAt ?? card.issued_at ?? null,
      redeemedAt: timestamp,
      redeemedByAccountId: account.id
    }]);

    if (options.linkCardLoginAccount) {
      ensureSqliteCardLoginAccountShadowRecords(db, [{
        licenseKeyId: card.id,
        accountId: account.id,
        productId: product.id,
        createdAt: timestamp
      }]);
    }
  }

  async function activateFreshCardEntitlementWithShadow(
    product,
    account,
    card,
    timestamp = nowIso(),
    options = {}
  ) {
    const activation = await Promise.resolve(store.entitlements.activateFreshCardEntitlement(
      product,
      account,
      card,
      timestamp
    ));
    await syncSqliteCardActivationShadow(product, account, card, timestamp, options);

    if (!activation.reseller) {
      const resellerAllocation = getSqliteResellerAllocationByLicenseKey(card.id);
      if (resellerAllocation) {
        activation.reseller = {
          id: resellerAllocation.reseller_id,
          code: resellerAllocation.reseller_code,
          name: resellerAllocation.reseller_name,
          allocationBatchCode: resellerAllocation.allocation_batch_code,
          allocatedAt: resellerAllocation.allocated_at
        };
      }
    }

    return activation;
  }

  return {
    async health() {
      await expireStaleSessions(db, store, stateStore);
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

    async developerListMembers(token) {
      const session = requireDeveloperOwnerSession(db, token);
      const items = await queryDeveloperMemberRows(db, store, session.developer_id);
      return {
        items,
        total: items.length
      };
    },

    async developerCreateMember(token, body = {}) {
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
      const productIds = await resolveDeveloperOwnedProductIdsInput(db, store, session.developer_id, body) ?? [];
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
      await syncDeveloperMemberProductAccess(db, store, session.developer_id, memberId, productIds, timestamp);

      const member = (await queryDeveloperMemberRows(db, store, session.developer_id))
        .find((item) => item.id === memberId);
      auditDeveloperSession(db, session, "developer-member.create", "developer_member", memberId, {
        username,
        role,
        status,
        productCount: member?.productAccess.length ?? 0
      });

      return member;
    },

    async developerUpdateMember(token, memberId, body = {}) {
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
      const nextProductIds = await resolveDeveloperOwnedProductIdsInput(db, store, session.developer_id, body);
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
        await syncDeveloperMemberProductAccess(db, store, session.developer_id, current.id, nextProductIds, timestamp);
      }

      let revokedSessions = 0;
      if (status !== "active" || newPasswordProvided) {
        revokedSessions = revokeDeveloperMemberSessions(db, "member_id = ?", [current.id]);
      }

      const member = (await queryDeveloperMemberRows(db, store, session.developer_id))
        .find((item) => item.id === current.id);
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

    async listProducts(token) {
      requireAdminSession(db, token);
      return await Promise.resolve(store.products.queryProductRows(db));
    },

    async createProduct(token, body) {
      const admin = requireAdminSession(db, token);
      const ownerDeveloperId = body.ownerDeveloperId === undefined
        ? null
        : resolveProductOwnerDeveloperId(db, body.ownerDeveloperId, true);
      const product = await Promise.resolve(store.products.createProduct(body, ownerDeveloperId));

      audit(db, "admin", admin.admin_id, "product.create", "product", product.id, {
        code: product.code,
        sdkAppId: product.sdkAppId,
        ownerDeveloperId
      });
      return product;
    },

    async updateProductProfile(token, productId, body = {}) {
      const admin = requireAdminSession(db, token);
      const currentProduct = await getStoreProductById(productId);
      if (!currentProduct) {
        throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
      }

      const nextProduct = await Promise.resolve(store.products.updateProductProfile(productId, body, nowIso()));
      audit(db, "admin", admin.admin_id, "product.profile.update", "product", productId, {
        previousCode: currentProduct.code,
        code: nextProduct.code,
        name: nextProduct.name,
        description: nextProduct.description
      });
      return nextProduct;
    },

    async updateProductStatus(token, productId, body = {}) {
      const admin = requireAdminSession(db, token);
      const currentProduct = await getStoreProductById(productId);
      if (!currentProduct) {
        throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
      }

      const nextStatus = normalizeProductStatus(body.status);
      return applyManagedProductStatusChange(db, store, stateStore, currentProduct, nextStatus, (updatedProduct, revokedSessions) => {
        audit(db, "admin", admin.admin_id, "product.status", "product", productId, {
          previousStatus: currentProduct.status,
          status: nextStatus,
          code: updatedProduct.code,
          revokedSessions
        });
      });
    },

    async updateProductStatusBatch(token, body = {}) {
      const admin = requireAdminSession(db, token);
      const productIds = await resolveAdminProductIdsInput(db, store, body);
      const nextStatus = normalizeProductStatus(body.status);
      const products = [];

      for (const productId of productIds) {
        const product = await getStoreProductById(productId);
        if (!product) {
          throw new AppError(404, "PRODUCT_NOT_FOUND", `Product ${productId} does not exist.`);
        }
        products.push(product);
      }

      const items = [];
      for (const product of products) {
        items.push(
          await applyManagedProductStatusChange(db, store, stateStore, product, nextStatus, (updatedProduct, revokedSessions) => {
            audit(db, "admin", admin.admin_id, "product.status", "product", product.id, {
              previousStatus: product.status,
              status: nextStatus,
              code: updatedProduct.code,
              revokedSessions,
              batch: true
            });
          })
        );
      }

      const summary = summarizeManagedProductStatusBatch(nextStatus, items);
      audit(db, "admin", admin.admin_id, "product.status.batch", "product", null, {
        status: nextStatus,
        total: summary.total,
        changed: summary.changed,
        unchanged: summary.unchanged,
        revokedSessions: summary.revokedSessions,
        productIds,
        productCodes: items.map((item) => item.code)
      });
      return summary;
    },

    async updateProductFeatureConfig(token, productId, body = {}) {
      const admin = requireAdminSession(db, token);
      const currentProduct = await getStoreProductById(productId);
      if (!currentProduct) {
        throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
      }

      return applyManagedProductFeatureConfigChange(db, store, currentProduct, body, (updatedProduct, featureConfig, previousFeatureConfig, changed) => {
        audit(db, "admin", admin.admin_id, "product.feature-config", "product", updatedProduct.id, {
          code: updatedProduct.code,
          featureConfig,
          previousFeatureConfig,
          changed
        });
      });
    },

    async updateProductFeatureConfigBatch(token, body = {}) {
      const admin = requireAdminSession(db, token);
      const productIds = await resolveAdminProductIdsInput(db, store, body);
      const products = [];

      for (const productId of productIds) {
        const product = await getStoreProductById(productId);
        if (!product) {
          throw new AppError(404, "PRODUCT_NOT_FOUND", `Product ${productId} does not exist.`);
        }
        products.push(product);
      }

      const items = [];
      for (const product of products) {
        items.push(
          await applyManagedProductFeatureConfigChange(
            db,
            store,
            product,
            body,
            (updatedProduct, featureConfig, previousFeatureConfig, changed) => {
              audit(db, "admin", admin.admin_id, "product.feature-config", "product", updatedProduct.id, {
                code: updatedProduct.code,
                featureConfig,
                previousFeatureConfig,
                changed,
                batch: true
              });
            }
          )
        );
      }

      const summary = summarizeManagedProductFeatureConfigBatch(items);
      audit(db, "admin", admin.admin_id, "product.feature-config.batch", "product", null, {
        total: summary.total,
        changed: summary.changed,
        unchanged: summary.unchanged,
        productIds,
        productCodes: items.map((item) => item.code)
      });
      return summary;
    },

    async rotateProductSdkCredentials(token, productId, body = {}) {
      const admin = requireAdminSession(db, token);
      const currentProduct = await getStoreProductById(productId);
      if (!currentProduct) {
        throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
      }

      return applyManagedProductSdkCredentialRotation(store, currentProduct, body, (updatedProduct, rotated) => {
        audit(db, "admin", admin.admin_id, "product.sdk-credentials.rotate", "product", updatedProduct.id, {
          code: updatedProduct.code,
          rotateAppId: rotated.rotateAppId,
          previousSdkAppId: rotated.previousSdkAppId,
          sdkAppId: rotated.sdkAppId
        });
      });
    },

    async rotateProductSdkCredentialsBatch(token, body = {}) {
      const admin = requireAdminSession(db, token);
      const productIds = await resolveAdminProductIdsInput(db, store, body);
      const rotateAppId = parseOptionalBoolean(body.rotateAppId, "rotateAppId") === true;
      const products = [];

      for (const productId of productIds) {
        const product = await getStoreProductById(productId);
        if (!product) {
          throw new AppError(404, "PRODUCT_NOT_FOUND", `Product ${productId} does not exist.`);
        }
        products.push(product);
      }

      const items = [];
      for (const product of products) {
        items.push(
          await applyManagedProductSdkCredentialRotation(store, product, body, (updatedProduct, rotated) => {
            audit(db, "admin", admin.admin_id, "product.sdk-credentials.rotate", "product", updatedProduct.id, {
              code: updatedProduct.code,
              rotateAppId: rotated.rotateAppId,
              previousSdkAppId: rotated.previousSdkAppId,
              sdkAppId: rotated.sdkAppId,
              batch: true
            });
          })
        );
      }

      const summary = summarizeManagedProductSdkRotationBatch(rotateAppId, items);
      audit(db, "admin", admin.admin_id, "product.sdk-credentials.rotate.batch", "product", null, {
        rotateAppId: summary.rotateAppId,
        total: summary.total,
        productIds,
        productCodes: items.map((item) => item.code),
        sdkAppIds: items.map((item) => item.sdkAppId)
      });
      return summary;
    },

    async exportProductSdkCredentials(token, body = {}, options = {}) {
      const admin = requireAdminSession(db, token);
      const productIds = await resolveAdminProductIdsInput(db, store, body);
      const products = [];

      for (const productId of productIds) {
        const product = await getStoreProductById(productId);
        if (!product) {
          throw new AppError(404, "PRODUCT_NOT_FOUND", `Product ${productId} does not exist.`);
        }
        products.push(product);
      }

      const transport = buildIntegrationTransportSnapshot(config);
      if (transport?.http && options.publicBaseUrl) {
        transport.http.baseUrl = options.publicBaseUrl;
      }
      if (transport?.http && options.publicHost) {
        transport.http.publicHost = options.publicHost;
      }
      if (transport?.http && options.publicPort) {
        transport.http.publicPort = options.publicPort;
      }
      const payload = buildProductSdkCredentialExportBundle(products, {
        includeOwner: true,
        transport,
        signing: buildIntegrationSigningSnapshot(config)
      });
      audit(db, "admin", admin.admin_id, "product.sdk-credentials.export.batch", "product", null, {
        total: payload.total,
        productIds,
        productCodes: products.map((item) => item.code),
        fileName: payload.fileName
      });
      return payload;
    },

    async exportProductIntegrationPackages(token, body = {}, options = {}) {
      const admin = requireAdminSession(db, token);
      const productIds = await resolveAdminProductIdsInput(db, store, body);
      const products = [];

      for (const productId of productIds) {
        const product = await getStoreProductById(productId);
        if (!product) {
          throw new AppError(404, "PRODUCT_NOT_FOUND", `Product ${productId} does not exist.`);
        }
        products.push(product);
      }

      const generatedAt = nowIso();
      const transport = buildIntegrationTransportSnapshot(config);
      if (transport?.http && options.publicBaseUrl) {
        transport.http.baseUrl = options.publicBaseUrl;
      }
      if (transport?.http && options.publicHost) {
        transport.http.publicHost = options.publicHost;
      }
      if (transport?.http && options.publicPort) {
        transport.http.publicPort = options.publicPort;
      }
      const signing = buildIntegrationSigningSnapshot(config);
      const tokenKeys = this.tokenKeys();
      const examples = buildIntegrationExamples();
      const items = products.map((product) => buildDeveloperIntegrationPackagePayload({
        actor: buildAdminActorPayload(admin),
        product,
        transport,
        signing,
        tokenKeys,
        examples,
        includeOwner: true,
        generatedAt
      }));
      const payload = buildProductIntegrationPackageExportBundle(items, {
        generatedAt,
        actor: buildAdminActorPayload(admin),
        transport,
        signing,
        tokenKeys,
        examples
      });
      audit(db, "admin", admin.admin_id, "product.integration-packages.export.batch", "product", null, {
        total: payload.total,
        productIds,
        productCodes: products.map((item) => item.code),
        fileName: payload.fileName
      });
      return payload;
    },

    async updateProductOwner(token, productId, body = {}) {
      const admin = requireAdminSession(db, token);
      const product = await getStoreProductById(productId);
      if (!product) {
        throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
      }

      const ownerDeveloperId = body.ownerDeveloperId === undefined
        ? product.ownerDeveloper?.id ?? null
        : resolveProductOwnerDeveloperId(db, body.ownerDeveloperId, true);
      const nextProduct = await Promise.resolve(store.products.updateProductOwner(productId, ownerDeveloperId, nowIso()));

      audit(db, "admin", admin.admin_id, "product.owner.update", "product", productId, {
        code: nextProduct.code,
        ownerDeveloperId
      });

      return nextProduct;
    },

    async developerListProducts(token) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "products.read",
        "DEVELOPER_PRODUCT_FORBIDDEN",
        "You can only view projects assigned to your developer account."
      );
      if (session.actor_scope === "owner") {
        return await Promise.resolve(
          store.products.queryProductRows(db, { ownerDeveloperId: session.developer_id })
        );
      }
      return await Promise.resolve(
        store.products.queryProductRows(db, { productIds: listDeveloperAccessibleProductIds(db, session) })
      );
    },

    async developerDashboard(token) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "products.read",
        "DEVELOPER_PRODUCT_FORBIDDEN",
        "You can only view projects assigned to your developer account."
      );
      return queryDeveloperDashboardPayload(db, store, session, stateStore);
    },

    async developerIntegration(token) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "products.read",
        "DEVELOPER_PRODUCT_FORBIDDEN",
        "You can only view projects assigned to your developer account."
      );
      const products = await listDeveloperAccessibleProductRows(db, store, session);
      const transport = buildIntegrationTransportSnapshot(config);
      const signing = buildIntegrationSigningSnapshot(config);
      const examples = buildIntegrationExamples();
      return {
        developer: buildDeveloperIdentityPayload(session),
        actor: buildDeveloperActor(session),
        transport,
        signing,
        tokenKeys: this.tokenKeys(),
        products,
        examples
      };
    },

    async developerIntegrationPackage(token, selector = {}, options = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "products.read",
        "DEVELOPER_PRODUCT_FORBIDDEN",
        "You can only view projects assigned to your developer account."
      );
      const product = await resolveDeveloperAccessibleProductInput(
        db,
        store,
        session,
        selector,
        "products.read",
        "DEVELOPER_PRODUCT_FORBIDDEN",
        "You can only view projects assigned to your developer account."
      );
      const transport = buildIntegrationTransportSnapshot(config);
      if (transport?.http && options.publicBaseUrl) {
        transport.http.baseUrl = options.publicBaseUrl;
      }
      if (transport?.http && options.publicHost) {
        transport.http.publicHost = options.publicHost;
      }
      if (transport?.http && options.publicPort) {
        transport.http.publicPort = options.publicPort;
      }
      const signing = buildIntegrationSigningSnapshot(config);
      const tokenKeys = this.tokenKeys();
      return buildDeveloperIntegrationPackagePayload({
        developer: buildDeveloperIdentityPayload(session),
        actor: buildDeveloperActor(session),
        product,
        transport,
        signing,
        tokenKeys,
        examples: buildIntegrationExamples()
      });
    },

    async developerReleasePackage(token, selector = {}, options = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "products.read",
        "DEVELOPER_PRODUCT_FORBIDDEN",
        "You can only view projects assigned to your developer account."
      );
      requireDeveloperPermission(
        session,
        "versions.read",
        "DEVELOPER_CLIENT_VERSION_FORBIDDEN",
        "You can only view client versions under your assigned projects."
      );
      requireDeveloperPermission(
        session,
        "notices.read",
        "DEVELOPER_NOTICE_FORBIDDEN",
        "You can only view notices under your assigned projects."
      );
      const product = await resolveDeveloperAccessibleProductInput(
        db,
        store,
        session,
        selector,
        "products.read",
        "DEVELOPER_PRODUCT_FORBIDDEN",
        "You can only view projects assigned to your developer account."
      );
      const channel = normalizeChannel(selector.channel, "stable");
      const generatedAt = nowIso();
      const developer = buildDeveloperIdentityPayload(session);
      const actor = buildDeveloperActor(session);
      const transport = buildIntegrationTransportSnapshot(config);
      if (transport?.http && options.publicBaseUrl) {
        transport.http.baseUrl = options.publicBaseUrl;
      }
      if (transport?.http && options.publicHost) {
        transport.http.publicHost = options.publicHost;
      }
      if (transport?.http && options.publicPort) {
        transport.http.publicPort = options.publicPort;
      }
      const signing = buildIntegrationSigningSnapshot(config);
      const tokenKeys = this.tokenKeys();
      const examples = buildIntegrationExamples();
      const integrationPackage = buildDeveloperIntegrationPackagePayload({
        developer,
        actor,
        product,
        transport,
        signing,
        tokenKeys,
        examples,
        generatedAt
      });
      const versionManifest = await buildVersionManifest(db, store, product, null, channel);
      const activeNoticeRows = await activeNoticesForProduct(db, store, product.id, channel);
      const payload = buildReleasePackagePayload({
        generatedAt,
        developer,
        actor,
        product,
        channel,
        versionManifest,
        activeNoticeRows,
        integrationPackage
      });
      auditDeveloperSession(db, session, "product.release-package.export", "product", product.id, {
        code: product.code,
        channel,
        fileName: payload.fileName
      });
      return payload;
    },

    releasePackageDownloadAsset(payload, format = "json") {
      return buildReleasePackageDownloadAsset(payload, format);
    },

    integrationPackageExportDownloadAsset(payload, format = "json") {
      return buildIntegrationPackageExportDownloadAsset(payload, format);
    },

    integrationPackageDownloadAsset(payload, format = "json") {
      return buildIntegrationPackageDownloadAsset(payload, format);
    },

    sdkCredentialExportDownloadAsset(payload, format = "json") {
      return buildProductSdkCredentialDownloadAsset(payload, format);
    },

    async developerCreateProduct(token, body = {}) {
      const session = requireDeveloperOwnerSession(db, token);
      const product = await Promise.resolve(store.products.createProduct(body, session.developer_id));

      auditDeveloperSession(db, session, "product.create", "product", product.id, {
        code: product.code,
        sdkAppId: product.sdkAppId
      });

      return product;
    },

    async developerUpdateProductProfile(token, productId, body = {}) {
      const session = requireDeveloperSession(db, token);
      const ownedProduct = await getStoreProductById(productId);
      if (!ownedProduct) {
        throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
      }
      ensureDeveloperCanAccessProduct(
        db,
        session,
        { id: ownedProduct.id, owner_developer_id: ownedProduct.ownerDeveloperId ?? ownedProduct.ownerDeveloper?.id ?? null },
        "products.write",
        "DEVELOPER_PRODUCT_FORBIDDEN",
        "You can only manage products owned by your developer account."
      );

      const nextProduct = await Promise.resolve(store.products.updateProductProfile(ownedProduct.id, body, nowIso()));
      auditDeveloperSession(db, session, "product.profile.update", "product", ownedProduct.id, {
        previousCode: ownedProduct.code,
        code: nextProduct.code,
        name: nextProduct.name,
        description: nextProduct.description
      });
      return nextProduct;
    },

    async developerUpdateProductStatus(token, productId, body = {}) {
      const session = requireDeveloperSession(db, token);
      const ownedProduct = await getStoreProductById(productId);
      if (!ownedProduct) {
        throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
      }
      ensureDeveloperCanAccessProduct(
        db,
        session,
        { id: ownedProduct.id, owner_developer_id: ownedProduct.ownerDeveloperId ?? ownedProduct.ownerDeveloper?.id ?? null },
        "products.write",
        "DEVELOPER_PRODUCT_FORBIDDEN",
        "You can only manage products owned by your developer account."
      );

      const nextStatus = normalizeProductStatus(body.status);
      return applyManagedProductStatusChange(db, store, stateStore, ownedProduct, nextStatus, (updatedProduct, revokedSessions) => {
        auditDeveloperSession(db, session, "product.status", "product", ownedProduct.id, {
          previousStatus: ownedProduct.status,
          status: nextStatus,
          code: updatedProduct.code,
          revokedSessions
        });
      });
    },

    async developerUpdateProductStatusBatch(token, body = {}) {
      const session = requireDeveloperSession(db, token);
      const productIds = await resolveDeveloperProductIdsInput(db, store, session, body);
      const nextStatus = normalizeProductStatus(body.status);
      const products = [];

      for (const productId of productIds) {
        const product = await getStoreProductById(productId);
        if (!product) {
          throw new AppError(404, "PRODUCT_NOT_FOUND", `Product ${productId} does not exist.`);
        }
        ensureDeveloperCanAccessProduct(
          db,
          session,
          {
            id: product.id,
            owner_developer_id: product.ownerDeveloperId ?? product.ownerDeveloper?.id ?? null
          },
          "products.write",
          "DEVELOPER_PRODUCT_FORBIDDEN",
          "You can only manage products owned by your developer account."
        );
        products.push(product);
      }

      const items = [];
      for (const product of products) {
        items.push(
          await applyManagedProductStatusChange(db, store, stateStore, product, nextStatus, (updatedProduct, revokedSessions) => {
            auditDeveloperSession(db, session, "product.status", "product", product.id, {
              previousStatus: product.status,
              status: nextStatus,
              code: updatedProduct.code,
              revokedSessions,
              batch: true
            });
          })
        );
      }

      const summary = summarizeManagedProductStatusBatch(nextStatus, items);
      auditDeveloperSession(db, session, "product.status.batch", "product", null, {
        status: nextStatus,
        total: summary.total,
        changed: summary.changed,
        unchanged: summary.unchanged,
        revokedSessions: summary.revokedSessions,
        productIds,
        productCodes: items.map((item) => item.code)
      });
      return summary;
    },

    async developerUpdateProductFeatureConfig(token, productId, body = {}) {
      const session = requireDeveloperSession(db, token);
      const ownedProduct = await getStoreProductById(productId);
      if (!ownedProduct) {
        throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
      }
      ensureDeveloperCanAccessProduct(
        db,
        session,
        { id: ownedProduct.id, owner_developer_id: ownedProduct.ownerDeveloperId ?? ownedProduct.ownerDeveloper?.id ?? null },
        "products.write",
        "DEVELOPER_PRODUCT_FORBIDDEN",
        "You can only manage products owned by your developer account."
      );
      return applyManagedProductFeatureConfigChange(db, store, ownedProduct, body, (updatedProduct, featureConfig, previousFeatureConfig, changed) => {
        auditDeveloperSession(db, session, "product.feature-config", "product", updatedProduct.id, {
          code: updatedProduct.code,
          featureConfig,
          previousFeatureConfig,
          changed
        });
      });
    },

    async developerUpdateProductFeatureConfigBatch(token, body = {}) {
      const session = requireDeveloperSession(db, token);
      const productIds = await resolveDeveloperProductIdsInput(db, store, session, body);
      const products = [];

      for (const productId of productIds) {
        const product = await getStoreProductById(productId);
        if (!product) {
          throw new AppError(404, "PRODUCT_NOT_FOUND", `Product ${productId} does not exist.`);
        }
        ensureDeveloperCanAccessProduct(
          db,
          session,
          {
            id: product.id,
            owner_developer_id: product.ownerDeveloperId ?? product.ownerDeveloper?.id ?? null
          },
          "products.write",
          "DEVELOPER_PRODUCT_FORBIDDEN",
          "You can only manage products owned by your developer account."
        );
        products.push(product);
      }

      const items = [];
      for (const product of products) {
        items.push(
          await applyManagedProductFeatureConfigChange(
            db,
            store,
            product,
            body,
            (updatedProduct, featureConfig, previousFeatureConfig, changed) => {
              auditDeveloperSession(db, session, "product.feature-config", "product", updatedProduct.id, {
                code: updatedProduct.code,
                featureConfig,
                previousFeatureConfig,
                changed,
                batch: true
              });
            }
          )
        );
      }

      const summary = summarizeManagedProductFeatureConfigBatch(items);
      auditDeveloperSession(db, session, "product.feature-config.batch", "product", null, {
        total: summary.total,
        changed: summary.changed,
        unchanged: summary.unchanged,
        productIds,
        productCodes: items.map((item) => item.code)
      });
      return summary;
    },

    async developerRotateProductSdkCredentials(token, productId, body = {}) {
      const session = requireDeveloperSession(db, token);
      const ownedProduct = await getStoreProductById(productId);
      if (!ownedProduct) {
        throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
      }
      ensureDeveloperCanAccessProduct(
        db,
        session,
        { id: ownedProduct.id, owner_developer_id: ownedProduct.ownerDeveloperId ?? ownedProduct.ownerDeveloper?.id ?? null },
        "products.write",
        "DEVELOPER_PRODUCT_FORBIDDEN",
        "You can only manage products owned by your developer account."
      );
      return applyManagedProductSdkCredentialRotation(store, ownedProduct, body, (updatedProduct, rotated) => {
        auditDeveloperSession(db, session, "product.sdk-credentials.rotate", "product", updatedProduct.id, {
          code: updatedProduct.code,
          rotateAppId: rotated.rotateAppId,
          previousSdkAppId: rotated.previousSdkAppId,
          sdkAppId: rotated.sdkAppId
        });
      });
    },

    async developerRotateProductSdkCredentialsBatch(token, body = {}) {
      const session = requireDeveloperSession(db, token);
      const productIds = await resolveDeveloperProductIdsInput(db, store, session, body);
      const rotateAppId = parseOptionalBoolean(body.rotateAppId, "rotateAppId") === true;
      const products = [];

      for (const productId of productIds) {
        const product = await getStoreProductById(productId);
        if (!product) {
          throw new AppError(404, "PRODUCT_NOT_FOUND", `Product ${productId} does not exist.`);
        }
        ensureDeveloperCanAccessProduct(
          db,
          session,
          {
            id: product.id,
            owner_developer_id: product.ownerDeveloperId ?? product.ownerDeveloper?.id ?? null
          },
          "products.write",
          "DEVELOPER_PRODUCT_FORBIDDEN",
          "You can only manage products owned by your developer account."
        );
        products.push(product);
      }

      const items = [];
      for (const product of products) {
        items.push(
          await applyManagedProductSdkCredentialRotation(store, product, body, (updatedProduct, rotated) => {
            auditDeveloperSession(db, session, "product.sdk-credentials.rotate", "product", updatedProduct.id, {
              code: updatedProduct.code,
              rotateAppId: rotated.rotateAppId,
              previousSdkAppId: rotated.previousSdkAppId,
              sdkAppId: rotated.sdkAppId,
              batch: true
            });
          })
        );
      }

      const summary = summarizeManagedProductSdkRotationBatch(rotateAppId, items);
      auditDeveloperSession(db, session, "product.sdk-credentials.rotate.batch", "product", null, {
        rotateAppId: summary.rotateAppId,
        total: summary.total,
        productIds,
        productCodes: items.map((item) => item.code),
        sdkAppIds: items.map((item) => item.sdkAppId)
      });
      return summary;
    },

    async developerExportProductSdkCredentials(token, body = {}, options = {}) {
      const session = requireDeveloperSession(db, token);
      const productIds = await resolveDeveloperProductIdsInput(
        db,
        store,
        session,
        body,
        "products.read",
        "You can only view projects assigned to your developer account."
      );
      const products = [];

      for (const productId of productIds) {
        const product = await getStoreProductById(productId);
        if (!product) {
          throw new AppError(404, "PRODUCT_NOT_FOUND", `Product ${productId} does not exist.`);
        }
        ensureDeveloperCanAccessProduct(
          db,
          session,
          {
            id: product.id,
            owner_developer_id: product.ownerDeveloperId ?? product.ownerDeveloper?.id ?? null
          },
          "products.read",
          "DEVELOPER_PRODUCT_FORBIDDEN",
          "You can only view projects assigned to your developer account."
        );
        products.push(product);
      }

      const transport = buildIntegrationTransportSnapshot(config);
      if (transport?.http && options.publicBaseUrl) {
        transport.http.baseUrl = options.publicBaseUrl;
      }
      if (transport?.http && options.publicHost) {
        transport.http.publicHost = options.publicHost;
      }
      if (transport?.http && options.publicPort) {
        transport.http.publicPort = options.publicPort;
      }
      const payload = buildProductSdkCredentialExportBundle(products, {
        includeOwner: false,
        transport,
        signing: buildIntegrationSigningSnapshot(config)
      });
      auditDeveloperSession(db, session, "product.sdk-credentials.export.batch", "product", null, {
        total: payload.total,
        productIds,
        productCodes: products.map((item) => item.code),
        fileName: payload.fileName
      });
      return payload;
    },

    async developerExportProductIntegrationPackages(token, body = {}, options = {}) {
      const session = requireDeveloperSession(db, token);
      const productIds = await resolveDeveloperProductIdsInput(
        db,
        store,
        session,
        body,
        "products.read",
        "You can only view projects assigned to your developer account."
      );
      const products = [];

      for (const productId of productIds) {
        const product = await getStoreProductById(productId);
        if (!product) {
          throw new AppError(404, "PRODUCT_NOT_FOUND", `Product ${productId} does not exist.`);
        }
        ensureDeveloperCanAccessProduct(
          db,
          session,
          {
            id: product.id,
            owner_developer_id: product.ownerDeveloperId ?? product.ownerDeveloper?.id ?? null
          },
          "products.read",
          "DEVELOPER_PRODUCT_FORBIDDEN",
          "You can only view projects assigned to your developer account."
        );
        products.push(product);
      }

      const generatedAt = nowIso();
      const developer = buildDeveloperIdentityPayload(session);
      const actor = buildDeveloperActor(session);
      const transport = buildIntegrationTransportSnapshot(config);
      if (transport?.http && options.publicBaseUrl) {
        transport.http.baseUrl = options.publicBaseUrl;
      }
      if (transport?.http && options.publicHost) {
        transport.http.publicHost = options.publicHost;
      }
      if (transport?.http && options.publicPort) {
        transport.http.publicPort = options.publicPort;
      }
      const signing = buildIntegrationSigningSnapshot(config);
      const tokenKeys = this.tokenKeys();
      const examples = buildIntegrationExamples();
      const items = products.map((product) => buildDeveloperIntegrationPackagePayload({
        developer,
        actor,
        product,
        transport,
        signing,
        tokenKeys,
        examples,
        generatedAt
      }));
      const payload = buildProductIntegrationPackageExportBundle(items, {
        generatedAt,
        developer,
        actor,
        transport,
        signing,
        tokenKeys,
        examples
      });
      auditDeveloperSession(db, session, "product.integration-packages.export.batch", "product", null, {
        total: payload.total,
        productIds,
        productCodes: products.map((item) => item.code),
        fileName: payload.fileName
      });
      return payload;
    },

    async listPolicies(token, productCode = null) {
      requireAdminSession(db, token);
      const filters = productCode && typeof productCode === "object"
        ? productCode
        : (productCode ? { productCode } : {});
      return await Promise.resolve(store.policies.queryPolicyRows(db, filters));
    },

    async developerListPolicies(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "policies.read",
        "DEVELOPER_POLICY_FORBIDDEN",
        "You can only view policies under your assigned projects."
      );
      if (filters.productCode) {
        await requireDeveloperOwnedProductByCode(
          db,
          store,
          session,
          String(filters.productCode).trim().toUpperCase(),
          "policies.read"
        );
      }
      return await Promise.resolve(store.policies.queryPolicyRows(db, {
        productCode: filters.productCode ?? null,
        productIds: listDeveloperAccessibleProductIds(db, session)
      }));
    },

    async createPolicy(token, body) {
      const admin = requireAdminSession(db, token);
      requireField(body, "name");

      const product = await getStoreActiveProductByCode(readProductCodeInput(body));
      const policy = await Promise.resolve(store.policies.createPolicy(product, body, nowIso()));

      audit(db, "admin", admin.admin_id, "policy.create", "policy", policy.id, {
        productCode: product.code,
        name: policy.name,
        allowConcurrentSessions: policy.allowConcurrentSessions,
        bindMode: policy.bindMode,
        bindFields: policy.bindFields,
        grantType: policy.grantType,
        grantPoints: policy.grantPoints,
        allowClientUnbind: policy.allowClientUnbind,
        clientUnbindLimit: policy.clientUnbindLimit,
        clientUnbindWindowDays: policy.clientUnbindWindowDays,
        clientUnbindDeductDays: policy.clientUnbindDeductDays
      });
      return policy;
    },

    async developerCreatePolicy(token, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "policies.write",
        "DEVELOPER_POLICY_FORBIDDEN",
        "You can only manage policies under your assigned projects."
      );
      requireField(body, "name");

      const product = await getStoreActiveProductByCode(readProductCodeInput(body));
      ensureDeveloperCanAccessProduct(
        db,
        session,
        { id: product.id, owner_developer_id: product.ownerDeveloperId ?? product.ownerDeveloper?.id ?? null },
        "policies.write",
        "DEVELOPER_POLICY_FORBIDDEN",
        "You can only manage policies under your assigned projects."
      );
      const policy = await Promise.resolve(store.policies.createPolicy(product, body, nowIso()));

      auditDeveloperSession(db, session, "policy.create", "policy", policy.id, {
        productCode: product.code,
        name: policy.name,
        allowConcurrentSessions: policy.allowConcurrentSessions,
        bindMode: policy.bindMode,
        bindFields: policy.bindFields,
        grantType: policy.grantType,
        grantPoints: policy.grantPoints,
        allowClientUnbind: policy.allowClientUnbind,
        clientUnbindLimit: policy.clientUnbindLimit,
        clientUnbindWindowDays: policy.clientUnbindWindowDays,
        clientUnbindDeductDays: policy.clientUnbindDeductDays
      });

      return policy;
    },

    async updatePolicyRuntimeConfig(token, policyId, body = {}) {
      const admin = requireAdminSession(db, token);
      const policy = await getStorePolicyById(policyId);

      if (!policy) {
        throw new AppError(404, "POLICY_NOT_FOUND", "Policy does not exist.");
      }

      const result = await Promise.resolve(store.policies.updatePolicyRuntimeConfig(policy, body, nowIso()));

      audit(db, "admin", admin.admin_id, "policy.runtime.update", "policy", policy.id, {
        productCode: policy.productCode,
        allowConcurrentSessions: result.allowConcurrentSessions,
        bindMode: result.bindMode,
        bindFields: result.bindFields
      });

      return result;
    },

    async updatePolicyUnbindConfig(token, policyId, body = {}) {
      const admin = requireAdminSession(db, token);
      const policy = await getStorePolicyById(policyId);

      if (!policy) {
        throw new AppError(404, "POLICY_NOT_FOUND", "Policy does not exist.");
      }

      const result = await Promise.resolve(store.policies.updatePolicyUnbindConfig(policy, body, nowIso()));

      audit(db, "admin", admin.admin_id, "policy.unbind.update", "policy", policy.id, {
        productCode: policy.productCode,
        allowClientUnbind: result.allowClientUnbind,
        clientUnbindLimit: result.clientUnbindLimit,
        clientUnbindWindowDays: result.clientUnbindWindowDays,
        clientUnbindDeductDays: result.clientUnbindDeductDays
      });

      return result;
    },

    async developerUpdatePolicyRuntimeConfig(token, policyId, body = {}) {
      const session = requireDeveloperSession(db, token);
      const policy = await getStorePolicyById(policyId);
      if (!policy) {
        throw new AppError(404, "POLICY_NOT_FOUND", "Policy does not exist.");
      }
      ensureDeveloperCanAccessProduct(
        db,
        session,
        { id: policy.productId, owner_developer_id: policy.ownerDeveloperId ?? null },
        "policies.write",
        "DEVELOPER_POLICY_FORBIDDEN",
        "You can only manage policies under your assigned projects."
      );
      const result = await Promise.resolve(store.policies.updatePolicyRuntimeConfig(policy, body, nowIso()));

      auditDeveloperSession(db, session, "policy.runtime.update", "policy", policy.id, {
        productCode: policy.productCode,
        allowConcurrentSessions: result.allowConcurrentSessions,
        bindMode: result.bindMode,
        bindFields: result.bindFields
      });

      return result;
    },

    async developerUpdatePolicyUnbindConfig(token, policyId, body = {}) {
      const session = requireDeveloperSession(db, token);
      const policy = await getStorePolicyById(policyId);
      if (!policy) {
        throw new AppError(404, "POLICY_NOT_FOUND", "Policy does not exist.");
      }
      ensureDeveloperCanAccessProduct(
        db,
        session,
        { id: policy.productId, owner_developer_id: policy.ownerDeveloperId ?? null },
        "policies.write",
        "DEVELOPER_POLICY_FORBIDDEN",
        "You can only manage policies under your assigned projects."
      );
      const result = await Promise.resolve(store.policies.updatePolicyUnbindConfig(policy, body, nowIso()));

      auditDeveloperSession(db, session, "policy.unbind.update", "policy", policy.id, {
        productCode: policy.productCode,
        allowClientUnbind: result.allowClientUnbind,
        clientUnbindLimit: result.clientUnbindLimit,
        clientUnbindWindowDays: result.clientUnbindWindowDays,
        clientUnbindDeductDays: result.clientUnbindDeductDays
      });

      return result;
    },

    async listCards(token, filters = {}) {
      requireAdminSession(db, token);
      const { items, summary, filters: normalizedFilters } = await Promise.resolve(
        store.cards.queryCardRows(db, filters)
      );
      return {
        items,
        total: items.length,
        summary,
        filters: normalizedFilters
      };
    },

    async exportCardsCsv(token, filters = {}) {
      requireAdminSession(db, token);
      const { items } = await Promise.resolve(store.cards.queryCardRows(db, filters, { limit: 5000 }));
      return buildCardsCsv(items);
    },

    async developerListCards(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "cards.read",
        "DEVELOPER_CARD_FORBIDDEN",
        "You can only view cards under your assigned projects."
      );
      if (filters.productCode) {
        await requireDeveloperOwnedProductByCode(
          db,
          store,
          session,
          String(filters.productCode).trim().toUpperCase(),
          "cards.read"
        );
      }
      const { items, summary, filters: normalizedFilters } = await Promise.resolve(store.cards.queryCardRows(
        db,
        { ...filters, productIds: listDeveloperAccessibleProductIds(db, session) }
      ));
      return {
        items,
        total: items.length,
        summary,
        filters: normalizedFilters
      };
    },

    async developerExportCardsCsv(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "cards.read",
        "DEVELOPER_CARD_FORBIDDEN",
        "You can only view cards under your assigned projects."
      );
      if (filters.productCode) {
        await requireDeveloperOwnedProductByCode(
          db,
          store,
          session,
          String(filters.productCode).trim().toUpperCase(),
          "cards.read"
        );
      }
      const { items } = await Promise.resolve(store.cards.queryCardRows(
        db,
        { ...filters, productIds: listDeveloperAccessibleProductIds(db, session) },
        { limit: 5000 }
      ));
      return buildCardsCsv(items);
    },

    async updateCardStatus(token, cardId, body = {}) {
      const admin = requireAdminSession(db, token);
      const card = await getStoreCardById(cardId);

      if (!card) {
        throw new AppError(404, "CARD_NOT_FOUND", "Card key does not exist.");
      }

      return withTransaction(db, async () => {
        const timestamp = nowIso();
        const result = await Promise.resolve(store.cards.updateCardStatus(card.id, body, timestamp));
        syncSqliteCardControlShadow(result.card, result.control, timestamp);

        let revokedSessions = 0;
        if (!result.control.available) {
          revokedSessions = await expireSessionsForLicenseKey(
            db,
            store,
            stateStore,
            card.id,
            `card_${result.control.effectiveStatus}`
          );
        }

        audit(db, "admin", admin.admin_id, "card.status", "license_key", card.id, {
          productCode: card.productCode,
          cardKeyMasked: maskCardKey(card.cardKey),
          status: result.control.status,
          effectiveStatus: result.control.effectiveStatus,
          expiresAt: result.control.expiresAt,
          revokedSessions
        });

        return {
          ...result.card,
          changed: true,
          revokedSessions
        };
      });
    },

    async developerUpdateCardStatus(token, cardId, body = {}) {
      const session = requireDeveloperSession(db, token);
      const card = await getStoreCardById(cardId);
      if (!card) {
        throw new AppError(404, "CARD_NOT_FOUND", "Card key does not exist.");
      }
      const product = await getStoreProductById(card.productId);
      ensureDeveloperCanAccessProduct(
        db,
        session,
        {
          id: product?.id ?? null,
          owner_developer_id: product?.ownerDeveloperId ?? product?.ownerDeveloper?.id ?? null
        },
        "cards.write",
        "DEVELOPER_CARD_FORBIDDEN",
        "You can only manage card keys under your own projects."
      );

      return withTransaction(db, async () => {
        const timestamp = nowIso();
        const result = await Promise.resolve(store.cards.updateCardStatus(card.id, body, timestamp));
        syncSqliteCardControlShadow(result.card, result.control, timestamp);

        let revokedSessions = 0;
        if (!result.control.available) {
          revokedSessions = await expireSessionsForLicenseKey(
            db,
            store,
            stateStore,
            card.id,
            `card_${result.control.effectiveStatus}`
          );
        }

        auditDeveloperSession(db, session, "card.status", "license_key", card.id, {
          productCode: card.productCode,
          cardKeyMasked: maskCardKey(card.cardKey),
          status: result.control.status,
          effectiveStatus: result.control.effectiveStatus,
          expiresAt: result.control.expiresAt,
          revokedSessions
        });

        return {
          ...result.card,
          changed: true,
          revokedSessions
        };
      });
    },

    async createCardBatch(token, body) {
      const admin = requireAdminSession(db, token);
      requireField(body, "policyId");

      const product = await getStoreActiveProductByCode(readProductCodeInput(body));
      const policy = await getStorePolicyById(body.policyId);

      if (!policy || policy.productId !== product.id || policy.status !== "active") {
        throw new AppError(404, "POLICY_NOT_FOUND", "Policy does not exist for the product.");
      }

      const batch = await withTransaction(db, () => createShadowedCardBatch(product, policy, body, nowIso()));
      const { issued: _issued, ...publicBatch } = batch;

      audit(db, "admin", admin.admin_id, "card.batch.create", "policy", policy.id, {
        productCode: product.code,
        batchCode: publicBatch.batchCode,
        count: publicBatch.count,
        expiresAt: publicBatch.expiresAt
      });

      return publicBatch;
    },

    async developerCreateCardBatch(token, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "cards.write",
        "DEVELOPER_CARD_FORBIDDEN",
        "You can only manage cards under your assigned projects."
      );
      requireField(body, "policyId");

      const product = await getStoreActiveProductByCode(readProductCodeInput(body));
      ensureDeveloperCanAccessProduct(
        db,
        session,
        {
          id: product.id,
          owner_developer_id: product.ownerDeveloperId ?? product.ownerDeveloper?.id ?? null
        },
        "cards.write",
        "DEVELOPER_PRODUCT_FORBIDDEN",
        "You can only manage products owned by your developer account."
      );
      const policy = await getStorePolicyById(body.policyId);

      if (!policy || policy.productId !== product.id || policy.status !== "active") {
        throw new AppError(404, "POLICY_NOT_FOUND", "Policy does not exist for the product.");
      }

      const batch = await withTransaction(db, () => createShadowedCardBatch(product, policy, body, nowIso()));
      const { issued: _issued, ...publicBatch } = batch;

      auditDeveloperSession(db, session, "card.batch.create", "policy", policy.id, {
        productCode: product.code,
        batchCode: publicBatch.batchCode,
        count: publicBatch.count,
        expiresAt: publicBatch.expiresAt
      });

      return publicBatch;
    },

    async developerListAccounts(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.read",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only view customer accounts under your assigned projects."
      );
      if (filters.productCode) {
        await requireDeveloperOwnedProductByCode(
          db,
          store,
          session,
          String(filters.productCode).trim().toUpperCase(),
          "ops.read"
        );
      }
      await expireStaleSessions(db, store, stateStore);
      return Promise.resolve(store.accounts.queryAccountRows(
        db,
        { ...filters, productIds: listDeveloperAccessibleProductIds(db, session) },
        stateStore
      ));
    },

    async developerUpdateAccountStatus(token, accountId, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage customer accounts under your assigned projects."
      );

      const account = await getStoreAccountById(accountId);

      if (!account) {
        throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account does not exist.");
      }

      ensureDeveloperCanAccessProduct(
        db,
        session,
        { id: account.productId, owner_developer_id: account.ownerDeveloperId },
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

      return withTransaction(db, async () => {
        const timestamp = nowIso();
        await Promise.resolve(store.accounts.updateAccountStatus(account.id, nextStatus, timestamp));
        const updatedAccountRecord = await getStoreAccountRecordById(account.id);
        await syncSqliteAccountRecordShadow(updatedAccountRecord, await getStoreProductById(account.productId));

        let revokedSessions = 0;
        if (nextStatus === "disabled") {
          revokedSessions = await expireActiveSessions(
            db,
            store,
            stateStore,
            { accountId: account.id },
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
            productCode: account.productCode,
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

    async listEntitlements(token, filters = {}) {
      requireAdminSession(db, token);
      const { items, filters: normalizedFilters } = await Promise.resolve(
        store.entitlements.queryEntitlementRows(db, filters)
      );
      return {
        items,
        total: items.length,
        filters: normalizedFilters
      };
    },

    async developerListEntitlements(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.read",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only view entitlements under your assigned projects."
      );
      if (filters.productCode) {
        await requireDeveloperOwnedProductByCode(
          db,
          store,
          session,
          String(filters.productCode).trim().toUpperCase(),
          "ops.read"
        );
      }
      const { items, filters: normalizedFilters } = await Promise.resolve(store.entitlements.queryEntitlementRows(db, {
        ...filters,
        productIds: listDeveloperAccessibleProductIds(db, session)
      }));
      return {
        items,
        total: items.length,
        filters: normalizedFilters
      };
    },

    async updateEntitlementStatus(token, entitlementId, body = {}) {
      const admin = requireAdminSession(db, token);
      const entitlement = await getStoreEntitlementById(entitlementId);

      if (!entitlement) {
        throw new AppError(404, "ENTITLEMENT_NOT_FOUND", "Entitlement does not exist.");
      }

      return withTransaction(db, async () => {
        const result = await Promise.resolve(store.entitlements.updateEntitlementStatus(entitlement.id, body, nowIso()));
        const revokedSessions = result.changed && result.status === "frozen"
          ? await expireSessionsForEntitlement(db, store, stateStore, entitlement.id, "entitlement_frozen")
          : 0;

        audit(
          db,
          "admin",
          admin.admin_id,
          "entitlement.status",
          "entitlement",
          entitlement.id,
          {
            productCode: entitlement.productCode,
            username: entitlement.username,
            status: result.status,
            revokedSessions,
            sourceCardKeyMasked: maskCardKey(entitlement.sourceCardKey)
          }
        );

        return {
          ...result,
          revokedSessions
        };
      });
    },

    async developerUpdateEntitlementStatus(token, entitlementId, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage entitlements under your assigned projects."
      );
      const entitlement = await getStoreEntitlementById(entitlementId);
      if (!entitlement) {
        throw new AppError(404, "ENTITLEMENT_NOT_FOUND", "Entitlement does not exist.");
      }
      const product = await getStoreProductById(entitlement.productId);
      ensureDeveloperCanAccessProduct(
        db,
        session,
        {
          id: product?.id ?? null,
          owner_developer_id: product?.ownerDeveloperId ?? product?.ownerDeveloper?.id ?? null
        },
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage entitlements under your assigned projects."
      );

      return withTransaction(db, async () => {
        const result = await Promise.resolve(store.entitlements.updateEntitlementStatus(entitlement.id, body, nowIso()));
        const revokedSessions = result.changed && result.status === "frozen"
          ? await expireSessionsForEntitlement(db, store, stateStore, entitlement.id, "entitlement_frozen")
          : 0;

        auditDeveloperSession(db, session, "entitlement.status", "entitlement", entitlement.id, {
          productCode: entitlement.productCode,
          username: entitlement.username,
          status: result.status,
          revokedSessions,
          sourceCardKeyMasked: maskCardKey(entitlement.sourceCardKey)
        });

        return {
          ...result,
          revokedSessions
        };
      });
    },

    async extendEntitlement(token, entitlementId, body = {}) {
      const admin = requireAdminSession(db, token);
      const entitlement = await getStoreEntitlementById(entitlementId);

      if (!entitlement) {
        throw new AppError(404, "ENTITLEMENT_NOT_FOUND", "Entitlement does not exist.");
      }

      const result = await Promise.resolve(store.entitlements.extendEntitlement(entitlement.id, body, nowIso()));

      audit(db, "admin", admin.admin_id, "entitlement.extend", "entitlement", entitlement.id, {
        productCode: entitlement.productCode,
        username: entitlement.username,
        days: result.addedDays,
        sourceCardKeyMasked: maskCardKey(entitlement.sourceCardKey),
        endsAt: result.endsAt
      });

      return result;
    },

    async developerExtendEntitlement(token, entitlementId, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage entitlements under your assigned projects."
      );
      const entitlement = await getStoreEntitlementById(entitlementId);
      if (!entitlement) {
        throw new AppError(404, "ENTITLEMENT_NOT_FOUND", "Entitlement does not exist.");
      }
      const product = await getStoreProductById(entitlement.productId);
      ensureDeveloperCanAccessProduct(
        db,
        session,
        {
          id: product?.id ?? null,
          owner_developer_id: product?.ownerDeveloperId ?? product?.ownerDeveloper?.id ?? null
        },
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage entitlements under your assigned projects."
      );
      const result = await Promise.resolve(store.entitlements.extendEntitlement(entitlement.id, body, nowIso()));

      auditDeveloperSession(db, session, "entitlement.extend", "entitlement", entitlement.id, {
        productCode: entitlement.productCode,
        username: entitlement.username,
        days: result.addedDays,
        sourceCardKeyMasked: maskCardKey(entitlement.sourceCardKey),
        endsAt: result.endsAt
      });

      return result;
    },

    async adjustEntitlementPoints(token, entitlementId, body = {}) {
      const admin = requireAdminSession(db, token);
      const result = await Promise.resolve(store.entitlements.adjustEntitlementPoints(
        entitlementId,
        body,
        nowIso(),
        { totalStrategy: "preserve_consumed" }
      ));

      audit(db, "admin", admin.admin_id, "entitlement.points.adjust", "entitlement", result.id, {
        productCode: result.productCode,
        username: result.username,
        mode: result.mode,
        points: result.points,
        previousTotalPoints: result.previous.totalPoints,
        previousRemainingPoints: result.previous.remainingPoints,
        previousConsumedPoints: result.previous.consumedPoints,
        totalPoints: result.current.totalPoints,
        remainingPoints: result.current.remainingPoints,
        consumedPoints: result.current.consumedPoints
      });

      return {
        id: result.id,
        productCode: result.productCode,
        productName: result.productName,
        username: result.username,
        policyName: result.policyName,
        grantType: "points",
        mode: result.mode,
        points: result.points,
        totalPoints: result.current.totalPoints,
        remainingPoints: result.current.remainingPoints,
        consumedPoints: result.current.consumedPoints,
        previousTotalPoints: result.previous.totalPoints,
        previousRemainingPoints: result.previous.remainingPoints,
        previousConsumedPoints: result.previous.consumedPoints,
        activeSessionCount: result.activeSessionCount,
        updatedAt: result.updatedAt
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

    async developerAdjustEntitlementPoints(token, entitlementId, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage point entitlements under your assigned projects."
      );
      const entitlement = await getStoreEntitlementById(entitlementId);
      if (!entitlement) {
        throw new AppError(404, "ENTITLEMENT_NOT_FOUND", "Entitlement does not exist.");
      }
      const product = await getStoreProductById(entitlement.productId);
      ensureDeveloperCanAccessProduct(
        db,
        session,
        {
          id: product?.id ?? null,
          owner_developer_id: product?.ownerDeveloperId ?? product?.ownerDeveloper?.id ?? null
        },
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage point entitlements under your assigned projects."
      );
      const result = await Promise.resolve(store.entitlements.adjustEntitlementPoints(
        entitlement.id,
        body,
        nowIso(),
        { totalStrategy: "preserve_total" }
      ));

      auditDeveloperSession(db, session, "entitlement.points.adjust", "entitlement", result.id, {
        productCode: result.productCode,
        username: result.username,
        mode: result.mode,
        points: result.points,
        previous: result.previous,
        next: result.current
      });

      return {
        id: result.id,
        productCode: result.productCode,
        username: result.username,
        status: result.status,
        mode: result.mode,
        points: result.points,
        previous: result.previous,
        current: result.current,
        updatedAt: result.updatedAt
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

    async createResellerPriceRule(token, body = {}) {
      const admin = requireAdminSession(db, token);
      requireField(body, "resellerId");
      requireField(body, "unitPrice");

      const reseller = one(db, "SELECT * FROM resellers WHERE id = ?", String(body.resellerId).trim());
      if (!reseller) {
        throw new AppError(404, "RESELLER_NOT_FOUND", "Reseller does not exist.");
      }

      const product = await getStoreActiveProductByCode(readProductCodeInput(body));
      const policyId = body.policyId ? String(body.policyId).trim() : null;
      const policy = policyId
        ? await getStorePolicyById(policyId)
        : null;
      if (policyId && (!policy || policy.productId !== product.id)) {
        throw new AppError(404, "POLICY_NOT_FOUND", "Policy does not exist for the product.");
      }
      if (policy && policy.status !== "active") {
        throw new AppError(409, "POLICY_INACTIVE", "Only active policies can be used for reseller pricing.");
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
      ensureSqliteProductShadowRecords(db, [product]);
      if (policy) {
        ensureSqlitePolicyShadowRecords(db, [policy]);
      }
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

    async allocateResellerInventory(token, resellerId, body) {
      const admin = requireAdminSession(db, token);
      requireField(body, "policyId");

      const reseller = one(db, "SELECT * FROM resellers WHERE id = ?", resellerId);
      if (!reseller) {
        throw new AppError(404, "RESELLER_NOT_FOUND", "Reseller does not exist.");
      }
      if (reseller.status !== "active") {
        throw new AppError(409, "RESELLER_DISABLED", "Reseller is disabled and cannot receive inventory.");
      }

      const product = await getStoreActiveProductByCode(readProductCodeInput(body));
      const policy = await getStorePolicyById(body.policyId);
      if (!policy || policy.productId !== product.id || policy.status !== "active") {
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

      const notes = normalizeOptionalText(body.notes, 1000) || null;
      const allocationResult = await withTransaction(db, async () => {
        ensureSqliteProductShadowRecords(db, [product]);
        ensureSqlitePolicyShadowRecords(db, [policy]);
        const priceRule = resolveResellerPriceRule(db, reseller.id, product.id, policy.id);
        const batch = await createShadowedCardBatch(product, policy, {
          prefix,
          count,
          batchCode: allocationBatchCode,
          notes
        }, allocatedAt);
        const issued = Array.isArray(batch.issued) ? batch.issued : [];

        if (issued.length !== count) {
          throw new AppError(500, "CARD_BATCH_INCOMPLETE", "Reseller allocation did not issue the expected number of cards.");
        }

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
            notes,
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
      await expireStaleSessions(db, store, stateStore);
      const products = await Promise.resolve(store.products.queryProductRows(db, {}));
      const now = nowIso();
      const {
        policyCounts,
        freshCardCounts,
        redeemedCardCounts,
        accountCounts,
        disabledAccountCounts,
        activeEntitlementCounts
      } = await queryProductBusinessMetricMaps(
        db,
        store,
        products.map((item) => item.id),
        now
      );
      const {
        activeBindingCounts,
        releasedBindingCounts,
        blockedDeviceCounts,
        activeClientVersionCounts,
        forceUpdateVersionCounts,
        activeNoticeCounts,
        blockingNoticeCounts,
        activeNetworkRuleCounts
      } = await queryProductOperationalMetricMaps(
        db,
        store,
        products.map((item) => item.id),
        now
      );

      const summary = {
        products: products.length,
        policies: sumMetricMap(policyCounts),
        cardsFresh: sumMetricMap(freshCardCounts),
        cardsRedeemed: sumMetricMap(redeemedCardCounts),
        accounts: sumMetricMap(accountCounts),
        disabledAccounts: sumMetricMap(disabledAccountCounts),
        activeEntitlements: sumMetricMap(activeEntitlementCounts),
        activeBindings: sumMetricMap(activeBindingCounts),
        releasedBindings: sumMetricMap(releasedBindingCounts),
        blockedDevices: sumMetricMap(blockedDeviceCounts),
        activeClientVersions: sumMetricMap(activeClientVersionCounts),
        forceUpdateVersions: sumMetricMap(forceUpdateVersionCounts),
        activeNotices: sumMetricMap(activeNoticeCounts),
        blockingNotices: sumMetricMap(blockingNoticeCounts),
        activeNetworkRules: sumMetricMap(activeNetworkRuleCounts),
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

      const sessions = await Promise.resolve(store.sessions.querySessionRows(db, {
        limit: 25,
        sortBy: "issuedAtDesc"
      }));

      return { summary, sessions: sessions.items };
    },

    async listAccounts(token, filters = {}) {
      requireAdminSession(db, token);
      await expireStaleSessions(db, store, stateStore);
      return Promise.resolve(store.accounts.queryAccountRows(db, filters, stateStore));
    },

    async updateAccountStatus(token, accountId, body = {}) {
      const admin = requireAdminSession(db, token);
      const account = await getStoreAccountById(accountId);

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

      return withTransaction(db, async () => {
        const timestamp = nowIso();
        await Promise.resolve(store.accounts.updateAccountStatus(account.id, nextStatus, timestamp));
        const updatedAccountRecord = await getStoreAccountRecordById(account.id);
        await syncSqliteAccountRecordShadow(updatedAccountRecord, await getStoreProductById(account.productId));

        let revokedSessions = 0;
        if (nextStatus === "disabled") {
          revokedSessions = await expireActiveSessions(
            db,
            store,
            stateStore,
            { accountId: account.id },
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
            productCode: account.productCode,
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

    async listDeviceBindings(token, filters = {}) {
      requireAdminSession(db, token);
      return queryDeviceBindingRows(db, store, filters, stateStore);
    },

    async releaseDeviceBinding(token, bindingId, body = {}) {
      const admin = requireAdminSession(db, token);
      const binding = await Promise.resolve(store.devices.getBindingManageRowById(db, bindingId));

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

      return withTransaction(db, async () => {
        const timestamp = nowIso();
        const reason = normalizeReason(body.reason, "device_binding_released");
        const releasedSessions = await releaseBindingRecord(db, store, stateStore, binding, reason, timestamp);

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

    async developerListDeviceBindings(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.read",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only view device bindings under your assigned projects."
      );
      if (filters.productCode) {
        await requireDeveloperOwnedProductByCode(
          db,
          store,
          session,
          String(filters.productCode).trim().toUpperCase(),
          "ops.read"
        );
      }
      return queryDeviceBindingRows(
        db,
        store,
        { ...filters, productIds: listDeveloperAccessibleProductIds(db, session) },
        stateStore
      );
    },

    async developerReleaseDeviceBinding(token, bindingId, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage device bindings under your assigned projects."
      );
      const binding = await Promise.resolve(store.devices.getBindingManageRowById(db, bindingId));

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

      return withTransaction(db, async () => {
        const timestamp = nowIso();
        const reason = normalizeReason(body.reason, "developer_binding_released");
        const releasedSessions = await releaseBindingRecord(db, store, stateStore, binding, reason, timestamp);

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
      return queryDeviceBlockRows(db, store, filters);
    },

    async developerListDeviceBlocks(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.read",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only view device blocks under your assigned projects."
      );
      if (filters.productCode) {
        await requireDeveloperOwnedProductByCode(
          db,
          store,
          session,
          String(filters.productCode).trim().toUpperCase(),
          "ops.read"
        );
      }
      return queryDeviceBlockRows(db, store, {
        ...filters,
        productIds: listDeveloperAccessibleProductIds(db, session)
      });
    },

    async blockDevice(token, body = {}) {
      const admin = requireAdminSession(db, token);
      requireField(body, "deviceFingerprint");

      const product = await getStoreProductByCode(readProductCodeInput(body));
      if (!product) {
        throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
      }
      const fingerprint = String(body.deviceFingerprint).trim();
      if (fingerprint.length < 6) {
        throw new AppError(400, "INVALID_DEVICE_FINGERPRINT", "Device fingerprint must be at least 6 characters.");
      }

      const reason = normalizeReason(body.reason, "operator_blocked");
      const notes = String(body.notes ?? "").trim();
      const timestamp = nowIso();
      const block = await Promise.resolve(
        store.devices.activateDeviceBlock(product.id, fingerprint, reason, notes, timestamp)
      );
      const device = await getStoreDeviceRecordByFingerprint(product.id, fingerprint);

      let affectedSessions = 0;
      let affectedBindings = 0;
      if (device) {
        affectedSessions = await expireActiveSessions(
          db,
          store,
          stateStore,
          {
            productId: product.id,
            deviceId: device.id
          },
          "device_blocked"
        );
        affectedBindings = Number(
          await Promise.resolve(store.devices.revokeActiveBindingsByDevice(device.id, timestamp)) ?? 0
        );
      }

      if (block.changed || affectedSessions > 0 || affectedBindings > 0) {
        audit(db, "admin", admin.admin_id, "device-block.activate", "device_block", block.id, {
          productCode: product.code,
          fingerprint,
          reason,
          notes,
          affectedSessions,
          affectedBindings
        });
      }

      return {
        id: block.id,
        productCode: product.code,
        fingerprint,
        status: "active",
        reason,
        notes,
        changed: Boolean(block.changed),
        affectedSessions,
        affectedBindings
      };
    },

    async developerBlockDevice(token, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage device blocks under your assigned projects."
      );
      requireField(body, "deviceFingerprint");

      const product = await getStoreProductByCode(readProductCodeInput(body));
      if (!product) {
        throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
      }
      ensureDeveloperCanAccessProduct(
        db,
        session,
        product,
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage device blocks under your assigned projects."
      );
      const fingerprint = String(body.deviceFingerprint).trim();
      if (fingerprint.length < 6) {
        throw new AppError(400, "INVALID_DEVICE_FINGERPRINT", "Device fingerprint must be at least 6 characters.");
      }

      const reason = normalizeReason(body.reason, "developer_blocked");
      const notes = String(body.notes ?? "").trim();
      const timestamp = nowIso();
      const block = await Promise.resolve(
        store.devices.activateDeviceBlock(product.id, fingerprint, reason, notes, timestamp)
      );
      const device = await getStoreDeviceRecordByFingerprint(product.id, fingerprint);

      let affectedSessions = 0;
      let affectedBindings = 0;
      if (device) {
        affectedSessions = await expireActiveSessions(
          db,
          store,
          stateStore,
          {
            productId: product.id,
            deviceId: device.id
          },
          "device_blocked"
        );
        affectedBindings = Number(
          await Promise.resolve(store.devices.revokeActiveBindingsByDevice(device.id, timestamp)) ?? 0
        );
      }

      if (block.changed || affectedSessions > 0 || affectedBindings > 0) {
        auditDeveloperSession(db, session, "device-block.activate", "device_block", block.id, {
          productCode: product.code,
          fingerprint,
          reason,
          notes,
          affectedSessions,
          affectedBindings
        });
      }

      return {
        id: block.id,
        productCode: product.code,
        fingerprint,
        status: "active",
        reason,
        notes,
        changed: Boolean(block.changed),
        affectedSessions,
        affectedBindings
      };
    },

    async unblockDevice(token, blockId, body = {}) {
      const admin = requireAdminSession(db, token);
      const block = await getStoreDeviceBlockManageRowById(blockId);

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
      await Promise.resolve(store.devices.releaseDeviceBlock(block.id, timestamp));

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

    async developerUnblockDevice(token, blockId, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage device blocks under your assigned projects."
      );
      const block = await getStoreDeviceBlockManageRowById(blockId);

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
      await Promise.resolve(store.devices.releaseDeviceBlock(block.id, timestamp));

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

    async listClientVersions(token, filters = {}) {
      requireAdminSession(db, token);
      return queryClientVersionRows(db, store, filters);
    },

    async developerListClientVersions(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "versions.read",
        "DEVELOPER_CLIENT_VERSION_FORBIDDEN",
        "You can only view client versions under your assigned projects."
      );
      if (filters.productCode) {
        const product = await getStoreProductByCode(String(filters.productCode).trim().toUpperCase());
        ensureDeveloperCanAccessProduct(
          db,
          session,
          product,
          "versions.read",
          "DEVELOPER_CLIENT_VERSION_FORBIDDEN",
          "You can only view client versions under your assigned projects."
        );
      }
      return queryClientVersionRows(db, store, {
        ...filters,
        productIds: listDeveloperAccessibleProductIds(db, session)
      });
    },

    async createClientVersion(token, body = {}) {
      const admin = requireAdminSession(db, token);
      requireField(body, "version");

      const product = await getStoreProductByCode(readProductCodeInput(body));
      if (!product) {
        throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
      }

      const result = typeof store.versions.createClientVersion === "function"
        ? await Promise.resolve(store.versions.createClientVersion(product, body, nowIso()))
        : (() => {
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
          })();

      audit(db, "admin", admin.admin_id, "client-version.create", "client_version", result.id, {
        productCode: result.productCode,
        channel: result.channel,
        version: result.version,
        status: result.status,
        forceUpdate: result.forceUpdate
      });

      return result;
    },

    async developerCreateClientVersion(token, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "versions.write",
        "DEVELOPER_CLIENT_VERSION_FORBIDDEN",
        "You can only manage client versions under your assigned projects."
      );
      requireField(body, "version");

      const product = await getStoreProductByCode(readProductCodeInput(body));
      if (!product) {
        throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
      }
      ensureDeveloperCanAccessProduct(
        db,
        session,
        product,
        "versions.write",
        "DEVELOPER_CLIENT_VERSION_FORBIDDEN",
        "You can only manage client versions under your assigned projects."
      );

      const result = typeof store.versions.createClientVersion === "function"
        ? await Promise.resolve(store.versions.createClientVersion(product, body, nowIso()))
        : (() => {
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
          })();

      auditDeveloperSession(db, session, "client-version.create", "client_version", result.id, {
        productCode: result.productCode,
        channel: result.channel,
        version: result.version,
        status: result.status,
        forceUpdate: result.forceUpdate
      });

      return result;
    },

    async updateClientVersionStatus(token, versionId, body = {}) {
      const admin = requireAdminSession(db, token);
      const row = await getStoreClientVersionById(versionId);
      if (!row) {
        throw new AppError(404, "CLIENT_VERSION_NOT_FOUND", "Client version does not exist.");
      }

      const result = typeof store.versions.updateClientVersionStatus === "function"
        ? await Promise.resolve(store.versions.updateClientVersionStatus(versionId, body, nowIso()))
        : (() => {
            const nextStatus = String(body.status ?? "").trim().toLowerCase();
            if (!["active", "disabled"].includes(nextStatus)) {
              throw new AppError(400, "INVALID_CLIENT_VERSION_STATUS", "Version status must be active or disabled.");
            }

            const forceUpdate = body.forceUpdate === undefined
              ? (row.forceUpdate ? 1 : 0)
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

            return {
              id: row.id,
              productCode: row.productCode,
              channel: row.channel,
              version: row.version,
              status: nextStatus,
              forceUpdate: Boolean(forceUpdate),
              changed: nextStatus !== row.status || forceUpdate !== (row.forceUpdate ? 1 : 0),
              updatedAt: timestamp
            };
          })();

      audit(db, "admin", admin.admin_id, "client-version.status", "client_version", result.id, {
        productCode: result.productCode,
        version: result.version,
        channel: result.channel,
        status: result.status,
        forceUpdate: result.forceUpdate
      });

      return result;
    },

    async developerUpdateClientVersionStatus(token, versionId, body = {}) {
      const session = requireDeveloperSession(db, token);
      const row = await getStoreClientVersionById(versionId);
      if (!row) {
        throw new AppError(404, "CLIENT_VERSION_NOT_FOUND", "Client version does not exist.");
      }
      ensureDeveloperCanAccessProduct(
        db,
        session,
        { id: row.productId, owner_developer_id: row.ownerDeveloperId },
        "versions.write",
        "DEVELOPER_CLIENT_VERSION_FORBIDDEN",
        "You can only manage client versions under your assigned projects."
      );

      const result = typeof store.versions.updateClientVersionStatus === "function"
        ? await Promise.resolve(store.versions.updateClientVersionStatus(versionId, body, nowIso()))
        : (() => {
            const nextStatus = String(body.status ?? "").trim().toLowerCase();
            if (!["active", "disabled"].includes(nextStatus)) {
              throw new AppError(400, "INVALID_CLIENT_VERSION_STATUS", "Version status must be active or disabled.");
            }

            const forceUpdate = body.forceUpdate === undefined
              ? (row.forceUpdate ? 1 : 0)
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

            return {
              id: row.id,
              productCode: row.productCode,
              channel: row.channel,
              version: row.version,
              status: nextStatus,
              forceUpdate: Boolean(forceUpdate),
              changed: nextStatus !== row.status || forceUpdate !== (row.forceUpdate ? 1 : 0),
              updatedAt: timestamp
            };
          })();

      auditDeveloperSession(db, session, "client-version.status", "client_version", result.id, {
        productCode: result.productCode,
        version: result.version,
        channel: result.channel,
        status: result.status,
        forceUpdate: result.forceUpdate
      });

      return result;
    },

    async listNotices(token, filters = {}) {
      requireAdminSession(db, token);
      return queryNoticeRows(db, store, filters);
    },

    async developerListNotices(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "notices.read",
        "DEVELOPER_NOTICE_FORBIDDEN",
        "You can only view notices under your assigned projects."
      );
      if (filters.productCode) {
        const product = await getStoreProductByCode(String(filters.productCode).trim().toUpperCase());
        ensureDeveloperCanAccessProduct(
          db,
          session,
          product,
          "notices.read",
          "DEVELOPER_NOTICE_FORBIDDEN",
          "You can only view notices under your assigned projects."
        );
      }
      return queryNoticeRows(db, store, {
        ...filters,
        productIds: listDeveloperAccessibleProductIds(db, session)
      });
    },

    async createNotice(token, body = {}) {
      const admin = requireAdminSession(db, token);
      requireField(body, "title");
      requireField(body, "body");

      const productCode = readProductCodeInput(body, false);
      const product = productCode ? await getStoreProductByCode(productCode) : null;
      if (productCode && !product) {
        throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
      }

      const result = typeof store.notices.createNotice === "function"
        ? await Promise.resolve(store.notices.createNotice(product, body, nowIso()))
        : (() => {
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
          })();

      audit(db, "admin", admin.admin_id, "notice.create", "notice", result.id, {
        productCode: result.productCode,
        channel: result.channel,
        kind: result.kind,
        severity: result.severity,
        status: result.status,
        blockLogin: result.blockLogin
      });

      return result;
    },

    async developerCreateNotice(token, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "notices.write",
        "DEVELOPER_NOTICE_FORBIDDEN",
        "You can only manage notices under your assigned projects."
      );
      requireField(body, "title");
      requireField(body, "body");

      const product = await getStoreProductByCode(readProductCodeInput(body));
      if (!product) {
        throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
      }
      ensureDeveloperCanAccessProduct(
        db,
        session,
        product,
        "notices.write",
        "DEVELOPER_NOTICE_FORBIDDEN",
        "You can only manage notices under your assigned projects."
      );

      const result = typeof store.notices.createNotice === "function"
        ? await Promise.resolve(store.notices.createNotice(product, body, nowIso()))
        : (() => {
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
          })();

      auditDeveloperSession(db, session, "notice.create", "notice", result.id, {
        productCode: result.productCode,
        channel: result.channel,
        kind: result.kind,
        severity: result.severity,
        status: result.status,
        blockLogin: result.blockLogin
      });

      return result;
    },

    async updateNoticeStatus(token, noticeId, body = {}) {
      const admin = requireAdminSession(db, token);
      const row = await getStoreNoticeById(noticeId);
      if (!row) {
        throw new AppError(404, "NOTICE_NOT_FOUND", "Notice does not exist.");
      }

      const result = typeof store.notices.updateNoticeStatus === "function"
        ? await Promise.resolve(store.notices.updateNoticeStatus(noticeId, body, nowIso()))
        : (() => {
            const status = String(body.status ?? "").trim().toLowerCase();
            if (!["active", "archived"].includes(status)) {
              throw new AppError(400, "INVALID_NOTICE_STATUS", "Notice status must be active or archived.");
            }

            const blockLogin = body.blockLogin === undefined
              ? (row.blockLogin ? 1 : 0)
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

            return {
              id: row.id,
              productCode: row.productCode,
              channel: row.channel,
              status,
              blockLogin: Boolean(blockLogin),
              changed: status !== row.status || blockLogin !== (row.blockLogin ? 1 : 0),
              updatedAt: timestamp
            };
          })();

      audit(db, "admin", admin.admin_id, "notice.status", "notice", result.id, {
        productCode: result.productCode,
        channel: result.channel,
        status: result.status,
        blockLogin: result.blockLogin
      });

      return result;
    },

    async developerUpdateNoticeStatus(token, noticeId, body = {}) {
      const session = requireDeveloperSession(db, token);
      const row = await getStoreNoticeById(noticeId);
      if (!row) {
        throw new AppError(404, "NOTICE_NOT_FOUND", "Notice does not exist.");
      }
      ensureDeveloperCanAccessProduct(
        db,
        session,
        { id: row.productId, owner_developer_id: row.ownerDeveloperId },
        "notices.write",
        "DEVELOPER_NOTICE_FORBIDDEN",
        "You can only manage notices under your assigned projects."
      );

      const result = typeof store.notices.updateNoticeStatus === "function"
        ? await Promise.resolve(store.notices.updateNoticeStatus(noticeId, body, nowIso()))
        : (() => {
            const status = String(body.status ?? "").trim().toLowerCase();
            if (!["active", "archived"].includes(status)) {
              throw new AppError(400, "INVALID_NOTICE_STATUS", "Notice status must be active or archived.");
            }

            const blockLogin = body.blockLogin === undefined
              ? (row.blockLogin ? 1 : 0)
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

            return {
              id: row.id,
              productCode: row.productCode,
              channel: row.channel,
              status,
              blockLogin: Boolean(blockLogin),
              changed: status !== row.status || blockLogin !== (row.blockLogin ? 1 : 0),
              updatedAt: timestamp
            };
          })();

      auditDeveloperSession(db, session, "notice.status", "notice", result.id, {
        productCode: result.productCode,
        channel: result.channel,
        status: result.status,
        blockLogin: result.blockLogin
      });

      return result;
    },

    async clientNotices(reqLike, body, rawBody) {
      const product = await requireSignedProduct(db, store, config, stateStore, reqLike, rawBody);
      requireSignedProductCodeMatch(product, body);

      const featureConfig = resolveProductFeatureConfig(db, product);
      if (!featureConfig.allowNotices) {
        return buildDisabledNoticeManifest(product, body.channel);
      }

      const notices = await activeNoticesForProduct(db, store, product.id, body.channel);
      return {
        productCode: product.code,
        channel: normalizeNoticeChannel(body.channel, "stable"),
        enabled: true,
        notices
      };
    },

    async listNetworkRules(token, filters = {}) {
      requireAdminSession(db, token);
      return queryNetworkRuleRows(db, store, filters);
    },

    async developerListNetworkRules(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "products.read",
        "DEVELOPER_NETWORK_RULE_FORBIDDEN",
        "You can only view network rules under your assigned projects."
      );
      if (filters.productCode) {
        const product = await getStoreProductByCode(String(filters.productCode).trim().toUpperCase());
        ensureDeveloperCanAccessProduct(
          db,
          session,
          product,
          "products.read",
          "DEVELOPER_NETWORK_RULE_FORBIDDEN",
          "You can only view network rules under your assigned projects."
        );
      }
      return queryNetworkRuleRows(db, store, {
        ...filters,
        productIds: listDeveloperAccessibleProductIds(db, session)
      });
    },

    async createNetworkRule(token, body = {}) {
      const admin = requireAdminSession(db, token);
      requireField(body, "pattern");

      const productCode = readProductCodeInput(body, false);
      const product = productCode ? await getStoreProductByCode(productCode) : null;
      if (productCode && !product) {
        throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
      }

      const result = typeof store.networkRules.createNetworkRule === "function"
        ? await Promise.resolve(store.networkRules.createNetworkRule(product, body, nowIso()))
        : (() => {
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
          })();

      audit(db, "admin", admin.admin_id, "network-rule.create", "network_rule", result.id, {
        productCode: result.productCode,
        targetType: result.targetType,
        pattern: result.pattern,
        actionScope: result.actionScope,
        status: result.status
      });

      return result;
    },

    async developerCreateNetworkRule(token, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "products.write",
        "DEVELOPER_NETWORK_RULE_FORBIDDEN",
        "You can only manage network rules under your assigned projects."
      );
      requireField(body, "pattern");

      const product = await getStoreProductByCode(readProductCodeInput(body));
      if (!product) {
        throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
      }
      ensureDeveloperCanAccessProduct(
        db,
        session,
        product,
        "products.write",
        "DEVELOPER_NETWORK_RULE_FORBIDDEN",
        "You can only manage network rules under your assigned projects."
      );

      const result = typeof store.networkRules.createNetworkRule === "function"
        ? await Promise.resolve(store.networkRules.createNetworkRule(product, body, nowIso()))
        : (() => {
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
          })();

      auditDeveloperSession(db, session, "network-rule.create", "network_rule", result.id, {
        productCode: result.productCode,
        targetType: result.targetType,
        pattern: result.pattern,
        actionScope: result.actionScope,
        status: result.status
      });

      return result;
    },

    async updateNetworkRuleStatus(token, ruleId, body = {}) {
      const admin = requireAdminSession(db, token);
      const row = await getStoreNetworkRuleById(ruleId);
      if (!row) {
        throw new AppError(404, "NETWORK_RULE_NOT_FOUND", "Network rule does not exist.");
      }

      const result = typeof store.networkRules.updateNetworkRuleStatus === "function"
        ? await Promise.resolve(store.networkRules.updateNetworkRuleStatus(ruleId, body, nowIso()))
        : (() => {
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

            return {
              id: row.id,
              productCode: row.productCode,
              pattern: row.pattern,
              actionScope: row.actionScope,
              status,
              changed: status !== row.status,
              updatedAt: timestamp
            };
          })();

      audit(db, "admin", admin.admin_id, "network-rule.status", "network_rule", result.id, {
        productCode: result.productCode,
        pattern: result.pattern,
        actionScope: result.actionScope,
        status: result.status
      });

      return result;
    },

    async developerUpdateNetworkRuleStatus(token, ruleId, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "products.write",
        "DEVELOPER_NETWORK_RULE_FORBIDDEN",
        "You can only manage network rules under your assigned projects."
      );
      const row = await getStoreNetworkRuleById(ruleId);
      if (!row) {
        throw new AppError(404, "NETWORK_RULE_NOT_FOUND", "Network rule does not exist.");
      }
      if (!row.productId) {
        throw new AppError(403, "DEVELOPER_NETWORK_RULE_FORBIDDEN", "Developers cannot manage global network rules.");
      }

      ensureDeveloperCanAccessProduct(
        db,
        session,
        { id: row.productId, owner_developer_id: row.ownerDeveloperId },
        "products.write",
        "DEVELOPER_NETWORK_RULE_FORBIDDEN",
        "You can only manage network rules under your assigned projects."
      );

      const result = typeof store.networkRules.updateNetworkRuleStatus === "function"
        ? await Promise.resolve(store.networkRules.updateNetworkRuleStatus(ruleId, body, nowIso()))
        : (() => {
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

            return {
              id: row.id,
              productCode: row.productCode,
              pattern: row.pattern,
              actionScope: row.actionScope,
              status,
              changed: status !== row.status,
              updatedAt: timestamp
            };
          })();

      auditDeveloperSession(db, session, "network-rule.status", "network_rule", result.id, {
        productCode: result.productCode,
        pattern: result.pattern,
        actionScope: result.actionScope,
        status: result.status
      });

      return result;
    },

    async listSessions(token, filters = {}) {
      requireAdminSession(db, token);
      return querySessionRows(db, store, filters, stateStore);
    },

    async developerListSessions(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.read",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only view sessions under your assigned projects."
      );
      if (filters.productCode) {
        await requireDeveloperOwnedProductByCode(
          db,
          store,
          session,
          String(filters.productCode).trim().toUpperCase(),
          "ops.read"
        );
      }
      return querySessionRows(
        db,
        store,
        { ...filters, productIds: listDeveloperAccessibleProductIds(db, session) },
        stateStore
      );
    },

    async revokeSession(token, sessionId, body = {}) {
      const admin = requireAdminSession(db, token);
      const session = await getStoreSessionManageRowById(sessionId);

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

      await expireSessionById(db, store, stateStore, session.id, reason);

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

    async developerRevokeSession(token, sessionId, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage sessions under your assigned projects."
      );
      const targetSession = await getStoreSessionManageRowById(sessionId);

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

      await expireSessionById(db, store, stateStore, targetSession.id, reason);

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
      return queryAuditLogRows(db, {
        ...filters,
        productCodes: filters.productCode
          ? [String(filters.productCode).trim().toUpperCase()]
          : filters.productCodes
      });
    },

    async exportAdminOpsSnapshot(token, filters = {}) {
      const admin = requireAdminSession(db, token);
      const normalizedFilters = {
        productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
        username: filters.username ? String(filters.username).trim() : null,
        search: filters.search ? String(filters.search).trim() : null,
        eventType: filters.eventType ? String(filters.eventType).trim() : null,
        actorType: filters.actorType ? String(filters.actorType).trim() : null,
        entityType: filters.entityType ? String(filters.entityType).trim() : null,
        limit: Math.min(Math.max(Number(filters.limit ?? 60), 1), 200)
      };

      const accessibleProjects = await Promise.resolve(store.products.queryProductRows(db, {}));
      const scopedProjects = normalizedFilters.productCode
        ? accessibleProjects.filter((item) => item.code === normalizedFilters.productCode)
        : accessibleProjects;

      const emptyPayload = buildAdminOpsSnapshotPayload({
        admin: buildAdminIdentityPayload(admin),
        actor: buildAdminActorPayload(admin),
        accessibleProjects,
        projects: scopedProjects,
        filters: normalizedFilters,
        accounts: { items: [], total: 0, filters: {} },
        entitlements: { items: [], total: 0, filters: {} },
        sessions: { items: [], total: 0, filters: {} },
        bindings: { items: [], total: 0, filters: {} },
        blocks: { items: [], total: 0, filters: {} },
        auditLogs: { items: [], total: 0, filters: { limit: normalizedFilters.limit } }
      });

      if (!scopedProjects.length) {
        return emptyPayload;
      }

      const scopedProductIds = scopedProjects.map((item) => item.id);
      const scopedProductCodes = scopedProjects.map((item) => item.code).filter(Boolean);

      await expireStaleSessions(db, store, stateStore);

      const [accounts, entitlements, sessions, bindings, blocks, auditLogs] = await Promise.all([
        Promise.resolve(store.accounts.queryAccountRows(
          db,
          {
            productIds: scopedProductIds,
            productCode: normalizedFilters.productCode,
            search: normalizedFilters.search
          },
          stateStore
        )),
        Promise.resolve(store.entitlements.queryEntitlementRows(db, {
          productIds: scopedProductIds,
          productCode: normalizedFilters.productCode,
          username: normalizedFilters.username,
          search: normalizedFilters.search
        })),
        Promise.resolve(store.sessions.querySessionRows(db, {
          productIds: scopedProductIds,
          productCode: normalizedFilters.productCode,
          username: normalizedFilters.username,
          search: normalizedFilters.search
        })),
        Promise.resolve(store.devices.queryDeviceBindingRows(db, {
          productIds: scopedProductIds,
          productCode: normalizedFilters.productCode,
          username: normalizedFilters.username,
          search: normalizedFilters.search
        })),
        Promise.resolve(store.devices.queryDeviceBlockRows(db, {
          productIds: scopedProductIds,
          productCode: normalizedFilters.productCode,
          search: normalizedFilters.search
        })),
        Promise.resolve(queryAuditLogRows(db, {
          actorType: normalizedFilters.actorType,
          eventType: normalizedFilters.eventType,
          entityType: normalizedFilters.entityType,
          username: normalizedFilters.username,
          search: normalizedFilters.search,
          limit: normalizedFilters.limit,
          productCodes: normalizedFilters.productCode ? scopedProductCodes : null
        }))
      ]);

      return buildAdminOpsSnapshotPayload({
        admin: buildAdminIdentityPayload(admin),
        actor: buildAdminActorPayload(admin),
        accessibleProjects,
        projects: scopedProjects,
        filters: normalizedFilters,
        accounts,
        entitlements: {
          ...entitlements,
          total: entitlements.items?.length ?? 0
        },
        sessions,
        bindings,
        blocks,
        auditLogs
      });
    },

    adminOpsExportDownloadAsset(payload, format = "json") {
      return buildAdminOpsExportDownloadAsset(payload, format);
    },

    async developerListAuditLogs(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.read",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only view audit logs for your assigned projects."
      );
      const normalizedFilters = {
        productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
        username: filters.username ? String(filters.username).trim() : null,
        search: filters.search ? String(filters.search).trim() : null,
        eventType: filters.eventType ? String(filters.eventType).trim() : null,
        actorType: filters.actorType ? String(filters.actorType).trim() : null,
        entityType: filters.entityType ? String(filters.entityType).trim() : null,
        limit: Math.min(Math.max(Number(filters.limit ?? 50), 1), 200)
      };
      if (normalizedFilters.productCode) {
        await requireDeveloperOwnedProductByCode(
          db,
          store,
          session,
          normalizedFilters.productCode,
          "ops.read"
        );
      }
      const scopedProductCodes = normalizedFilters.productCode
        ? [normalizedFilters.productCode]
        : await listDeveloperAccessibleProductCodes(db, store, session);
      return queryAuditLogRows(db, {
        ...normalizedFilters,
        developerId: null,
        productCodes: scopedProductCodes
      });
    },

    async developerExportOpsSnapshot(token, filters = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.read",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only export authorization operations for your assigned projects."
      );

      const normalizedFilters = {
        productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
        username: filters.username ? String(filters.username).trim() : null,
        search: filters.search ? String(filters.search).trim() : null,
        eventType: filters.eventType ? String(filters.eventType).trim() : null,
        actorType: filters.actorType ? String(filters.actorType).trim() : null,
        entityType: filters.entityType ? String(filters.entityType).trim() : null,
        limit: Math.min(Math.max(Number(filters.limit ?? 60), 1), 200)
      };

      if (normalizedFilters.productCode) {
        await requireDeveloperOwnedProductByCode(
          db,
          store,
          session,
          normalizedFilters.productCode,
          "ops.read"
        );
      }

      const accessibleProjects = await listDeveloperAccessibleProductRows(db, store, session);
      const scopedProjects = normalizedFilters.productCode
        ? accessibleProjects.filter((item) => item.code === normalizedFilters.productCode)
        : accessibleProjects;

      const emptyPayload = buildDeveloperOpsSnapshotPayload({
        developer: buildDeveloperIdentityPayload(session),
        actor: buildDeveloperActor(session),
        accessibleProjects,
        projects: scopedProjects,
        filters: normalizedFilters,
        accounts: { items: [], total: 0, filters: {} },
        entitlements: { items: [], total: 0, filters: {} },
        sessions: { items: [], total: 0, filters: {} },
        bindings: { items: [], total: 0, filters: {} },
        blocks: { items: [], total: 0, filters: {} },
        auditLogs: { items: [], total: 0, filters: { limit: normalizedFilters.limit } }
      });

      if (!scopedProjects.length) {
        return emptyPayload;
      }

      const scopedProductIds = scopedProjects.map((item) => item.id);
      const scopedProductCodes = scopedProjects.map((item) => item.code).filter(Boolean);

      await expireStaleSessions(db, store, stateStore);

      const [accounts, entitlements, sessions, bindings, blocks, auditLogs] = await Promise.all([
        Promise.resolve(store.accounts.queryAccountRows(
          db,
          {
            productIds: scopedProductIds,
            productCode: normalizedFilters.productCode,
            search: normalizedFilters.search
          },
          stateStore
        )),
        Promise.resolve(store.entitlements.queryEntitlementRows(db, {
          productIds: scopedProductIds,
          productCode: normalizedFilters.productCode,
          username: normalizedFilters.username,
          search: normalizedFilters.search
        })),
        Promise.resolve(store.sessions.querySessionRows(db, {
          productIds: scopedProductIds,
          productCode: normalizedFilters.productCode,
          username: normalizedFilters.username,
          search: normalizedFilters.search
        })),
        Promise.resolve(store.devices.queryDeviceBindingRows(db, {
          productIds: scopedProductIds,
          productCode: normalizedFilters.productCode,
          username: normalizedFilters.username,
          search: normalizedFilters.search
        })),
        Promise.resolve(store.devices.queryDeviceBlockRows(db, {
          productIds: scopedProductIds,
          productCode: normalizedFilters.productCode,
          search: normalizedFilters.search
        })),
        Promise.resolve(queryAuditLogRows(db, {
          actorType: normalizedFilters.actorType,
          eventType: normalizedFilters.eventType,
          entityType: normalizedFilters.entityType,
          username: normalizedFilters.username,
          search: normalizedFilters.search,
          limit: normalizedFilters.limit,
          developerId: null,
          productCodes: scopedProductCodes
        }))
      ]);

      return buildDeveloperOpsSnapshotPayload({
        developer: buildDeveloperIdentityPayload(session),
        actor: buildDeveloperActor(session),
        accessibleProjects,
        projects: scopedProjects,
        filters: normalizedFilters,
        accounts,
        entitlements: {
          ...entitlements,
          total: entitlements.items?.length ?? 0
        },
        sessions,
        bindings,
        blocks,
        auditLogs
      });
    },

    developerOpsExportDownloadAsset(payload, format = "json") {
      return buildDeveloperOpsExportDownloadAsset(payload, format);
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
      const product = await requireSignedProduct(db, store, config, stateStore, reqLike, rawBody);
      requireField(body, "clientVersion");
      requireSignedProductCodeMatch(product, body);

      const featureConfig = resolveProductFeatureConfig(db, product);
      if (!featureConfig.allowVersionCheck) {
        return buildDisabledVersionManifest(product, String(body.clientVersion).trim(), body.channel);
      }

      return await buildVersionManifest(
        db,
        store,
        product,
        String(body.clientVersion).trim(),
        body.channel
      );
    },

    async clientBindings(reqLike, body, rawBody, meta = {}) {
      const product = await requireSignedProduct(db, store, config, stateStore, reqLike, rawBody);
      requireSignedProductCodeMatch(product, body);

      const productFeatureConfig = resolveProductFeatureConfig(db, product);
      await enforceNetworkRules(db, store, product, meta.ip, "login");

      return withTransaction(db, async () => {
        const subject = await resolveClientManagedAccount(db, store, product, body);
        const unbindConfig = await loadPolicyUnbindConfig(
          db,
          store,
          subject.entitlement.policy_id,
          subject.entitlement.updated_at
        );
        const bindings = await getStoreBindingsForEntitlement(subject.entitlement.id);
        const recentClientUnbinds = await countRecentClientUnbinds(
          db,
          store,
          subject.entitlement.id,
          unbindConfig.clientUnbindWindowDays,
          nowIso()
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
      const product = await requireSignedProduct(db, store, config, stateStore, reqLike, rawBody);
      requireSignedProductCodeMatch(product, body);

      requireProductFeatureEnabled(
        db,
        product,
        "allowClientUnbind",
        "CLIENT_UNBIND_DISABLED_BY_PRODUCT",
        "Client self-unbind is disabled for this product."
      );

      await enforceNetworkRules(db, store, product, meta.ip, "login");

      return withTransaction(db, async () => {
        const subject = await resolveClientManagedAccount(db, store, product, body);
        const unbindConfig = await loadPolicyUnbindConfig(
          db,
          store,
          subject.entitlement.policy_id,
          subject.entitlement.updated_at
        );
        if (!unbindConfig.allowClientUnbind) {
          throw new AppError(403, "CLIENT_UNBIND_DISABLED", "Self-service unbind is disabled for this policy.");
        }

        const recentClientUnbinds = await countRecentClientUnbinds(
          db,
          store,
          subject.entitlement.id,
          unbindConfig.clientUnbindWindowDays,
          nowIso()
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

        const bindings = await getStoreBindingsForEntitlement(subject.entitlement.id);
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
        let releasedSessions = await releaseBindingRecord(db, store, stateStore, {
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
            releasedSessions += await expireSessionsForEntitlement(
              db,
              store,
              stateStore,
              subject.entitlement.id,
              "entitlement_expired_after_unbind"
            );
          }
        }

        await recordEntitlementUnbind(
          store,
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

        const updatedBindings = await getStoreBindingsForEntitlement(subject.entitlement.id);
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
      const product = await requireSignedProduct(db, store, config, stateStore, reqLike, rawBody);
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

      await enforceNetworkRules(db, store, product, meta.ip, "register");

      const username = String(body.username).trim();
      const password = String(body.password);
      if (username.length < 3 || password.length < 8) {
        throw new AppError(400, "INVALID_ACCOUNT", "Username must be 3+ chars and password 8+ chars.");
      }

      const now = nowIso();
      const account = await Promise.resolve(store.accounts.createAccount(product, {
        username,
        passwordHash: hashPassword(password)
      }, now));
      await syncSqliteAccountRecordShadow(account, product);

      audit(db, "account", account.id, "account.register", "account", account.id, {
        productCode: product.code,
        username
      });

      return {
        accountId: account.id,
        productCode: product.code,
        username
      };
    },

    async redeemCard(reqLike, body, rawBody, meta = {}) {
      const product = await requireSignedProduct(db, store, config, stateStore, reqLike, rawBody);
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

      await enforceNetworkRules(db, store, product, meta.ip, "recharge");

      return withTransaction(db, async () => {
        const account = await getStoreAccountRecordByProductUsername(
          product.id,
          String(body.username).trim(),
          "active"
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

        const activation = await activateFreshCardEntitlementWithShadow(product, account, card, nowIso());
        auditActivatedCardEntitlement(db, product, account, card, activation, "card.redeem");
        return activation;
      });
    },

    async cardLoginClient(reqLike, body, rawBody, meta = {}) {
      const product = await requireSignedProduct(db, store, config, stateStore, reqLike, rawBody);
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

      await enforceNetworkRules(db, store, product, meta.ip, "login");
      if (featureConfig.allowNotices) {
        await requireNoBlockingNotices(db, store, product, body.channel);
      }
      if (featureConfig.allowVersionCheck) {
        await requireClientVersionAllowed(
          db,
          store,
          product,
          body.clientVersion ? String(body.clientVersion).trim() : null,
          body.channel
        );
      }

      const sessionResult = withTransaction(db, async () => {
        await expireStaleSessions(db, store, stateStore);

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
          account = await getStoreAccountRecordById(card.card_login_account_id);
          if (!account) {
            throw new AppError(409, "CARD_LOGIN_CORRUPTED", "Card-login mapping is missing its internal account.");
          }
          if (account.status !== "active") {
            throw new AppError(403, "CARD_LOGIN_DISABLED", "This card-login identity has been disabled.");
          }
        } else {
          account = await Promise.resolve(store.accounts.createCardLoginAccount(product, card, nowIso()));
          audit(db, "license_key", card.id, "card.direct_account_create", "account", account.id, {
            productCode: product.code,
            username: account.username,
            cardKeyMasked: maskCardKey(card.card_key)
          });
          const activation = await activateFreshCardEntitlementWithShadow(
            product,
            account,
            card,
            nowIso(),
            { linkCardLoginAccount: true }
          );
          auditActivatedCardEntitlement(db, product, account, card, activation, "card.direct_redeem", {
            authMode: "card"
          });
        }

        const now = nowIso();
        const deviceProfile = extractClientDeviceProfile(body, meta);
        const deviceFingerprint = deviceProfile.deviceFingerprint;
        await requireDeviceNotBlocked(db, store, product.id, deviceFingerprint);
        const entitlement = await getStoreUsableEntitlement(account.id, product.id, now);
        if (!entitlement) {
          throwEntitlementUnavailable(await getStoreLatestEntitlementSnapshot(account.id, product.id), now);
        }

        const maskedKey = maskCardKey(card.card_key);
        const bindConfig = await loadPolicyBindConfig(
          db,
          store,
          entitlement.policy_id,
          entitlement.bind_mode,
          entitlement.updated_at
        );
        return {
          ...(await issueClientSession(db, store, config, stateStore, {
            product,
            account,
            entitlement,
            deviceProfile,
            meta,
            authMode: "card",
            tokenSubject: account.username,
            bindConfig,
            syncAccountShadow: syncSqliteAccountRecordShadow
          })),
          card: {
            maskedKey
          }
        };
      });
      return finalizeIssuedSessionRuntime(db, store, stateStore, sessionResult);
    },

    async loginClient(reqLike, body, rawBody, meta = {}) {
      const product = await requireSignedProduct(db, store, config, stateStore, reqLike, rawBody);
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

      await enforceNetworkRules(db, store, product, meta.ip, "login");
      if (featureConfig.allowNotices) {
        await requireNoBlockingNotices(db, store, product, body.channel);
      }
      if (featureConfig.allowVersionCheck) {
        await requireClientVersionAllowed(
          db,
          store,
          product,
          body.clientVersion ? String(body.clientVersion).trim() : null,
          body.channel
        );
      }

      const sessionResult = withTransaction(db, async () => {
        await expireStaleSessions(db, store, stateStore);

        const account = await getStoreAccountRecordByProductUsername(
          product.id,
          String(body.username).trim(),
          "active"
        );

        if (!account || !verifyPassword(String(body.password), account.password_hash)) {
          throw new AppError(401, "ACCOUNT_LOGIN_FAILED", "Username or password is incorrect.");
        }

        const now = nowIso();
        const deviceProfile = extractClientDeviceProfile(body, meta);
        const deviceFingerprint = deviceProfile.deviceFingerprint;
        await requireDeviceNotBlocked(db, store, product.id, deviceFingerprint);
        const entitlement = await getStoreUsableEntitlement(account.id, product.id, now);
        if (!entitlement) {
          throwEntitlementUnavailable(await getStoreLatestEntitlementSnapshot(account.id, product.id), now);
        }

        const bindConfig = await loadPolicyBindConfig(
          db,
          store,
          entitlement.policy_id,
          entitlement.bind_mode,
          entitlement.updated_at
        );
        return issueClientSession(db, store, config, stateStore, {
          product,
          account,
          entitlement,
          deviceProfile,
          meta,
          authMode: "account",
          tokenSubject: account.username,
          bindConfig,
          syncAccountShadow: syncSqliteAccountRecordShadow
        });
      });
      return finalizeIssuedSessionRuntime(db, store, stateStore, sessionResult);
    },

    async heartbeatClient(reqLike, body, rawBody, meta) {
      const product = await requireSignedProduct(db, store, config, stateStore, reqLike, rawBody);
      requireField(body, "sessionToken");
      requireField(body, "deviceFingerprint");
      const sessionToken = String(body.sessionToken).trim();
      requireSignedProductCodeMatch(product, body);

      await enforceNetworkRules(db, store, product, meta.ip, "heartbeat");
      const runtimeSession = await stateStore.getSessionState(sessionToken);
      if (runtimeSession?.status === "expired") {
        throw new AppError(401, "SESSION_INVALID", "Session token is invalid or expired.", {
          runtimeRevokedReason: runtimeSession.revokedReason ?? null
        });
      }

      return withTransaction(db, async () => {
        await expireStaleSessions(db, store, stateStore);
        const session = await getStoreActiveHeartbeatSession(product.id, sessionToken);

        if (!session) {
          throw new AppError(401, "SESSION_INVALID", "Session token is invalid or expired.");
        }

        if (session.fingerprint !== String(body.deviceFingerprint).trim()) {
          await expireSessionById(db, store, stateStore, session.id, "device_mismatch");
          throw new AppError(401, "DEVICE_MISMATCH", "Device fingerprint does not match this session.");
        }

        const block = await Promise.resolve(store.devices.getActiveDeviceBlock(
          db,
          product.id,
          session.fingerprint
        ));
        if (block) {
          await expireSessionById(db, store, stateStore, session.id, "device_blocked");
          throw new AppError(403, "DEVICE_BLOCKED", "This device fingerprint has been blocked by the operator.", {
            reason: block.reason,
            blockedAt: block.created_at
          });
        }

        if (session.entitlement_status !== "active") {
          await expireSessionById(db, store, stateStore, session.id, "entitlement_frozen");
          throw new AppError(403, "LICENSE_FROZEN", "This authorization has been frozen by the operator.");
        }

        const cardControl = describeLicenseKeyControl({
          status: session.card_control_status,
          expires_at: session.card_expires_at
        });
        if (!cardControl.available) {
          await expireSessionById(db, store, stateStore, session.id, `card_${cardControl.effectiveStatus}`);
          ensureCardControlAvailable(cardControl);
        }

        await requireClientVersionAllowed(
          db,
          store,
          product,
          body.clientVersion ? String(body.clientVersion).trim() : null,
          body.channel
        );

        const now = nowIso();
        const expiresAt = addSeconds(now, session.token_ttl_seconds);
        await Promise.resolve(store.sessions.touchSessionHeartbeat(session.id, {
          lastHeartbeatAt: now,
          expiresAt,
          lastSeenIp: meta.ip,
          userAgent: meta.userAgent
        }));
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
      const product = await requireSignedProduct(db, store, config, stateStore, reqLike, rawBody);
      requireField(body, "sessionToken");
      requireSignedProductCodeMatch(product, body);

      const session = await getStoreSessionRecordByProductToken(
        product.id,
        String(body.sessionToken).trim()
      );
      if (!session) {
        throw new AppError(404, "SESSION_NOT_FOUND", "Session token does not exist.");
      }

      await expireSessionById(db, store, stateStore, session.id, "client_logout");

      audit(db, "account", session.account_id, "session.logout", "session", session.id, {});
      return { status: "logged_out" };
    }
  };
}
