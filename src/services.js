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
  "allowClientUnbind",
  "requireStartupBootstrap",
  "requireLocalTokenValidation",
  "requireHeartbeatGate"
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

function buildClientHardeningProfile(featureConfig = {}) {
  const startupBootstrapRequired = featureConfig.requireStartupBootstrap !== false;
  const localTokenValidationRequired = featureConfig.requireLocalTokenValidation !== false;
  const heartbeatGateRequired = featureConfig.requireHeartbeatGate !== false;
  const controls = [
    {
      key: "requireStartupBootstrap",
      label: "Startup bootstrap",
      required: startupBootstrapRequired,
      requiredSummary: "Call startup-bootstrap before showing login or recharge UI.",
      relaxedSummary: "Startup bootstrap is recommended, but this project does not force it as a client-side gate."
    },
    {
      key: "requireLocalTokenValidation",
      label: "Local token validation",
      required: localTokenValidationRequired,
      requiredSummary: "Cache public token keys and verify licenseToken signatures locally before unlocking protected features.",
      relaxedSummary: "Local licenseToken validation is optional here, so the client can rely more heavily on server-side checks."
    },
    {
      key: "requireHeartbeatGate",
      label: "Heartbeat gate",
      required: heartbeatGateRequired,
      requiredSummary: "Keep protected features behind a healthy heartbeat and react quickly to revoked or expired sessions.",
      relaxedSummary: "Heartbeat is still recommended for online status, but local feature gating after heartbeat loss is relaxed."
    }
  ];
  const requiredCount = controls.filter((item) => item.required).length;
  let profile = "strict";
  let title = "Strict client hardening";
  let summary = "Startup bootstrap, local token validation, and heartbeat gating are all expected in the client.";
  let nextAction = "Keep the SDK integrated with startup bootstrap, local token checks, and heartbeat-driven feature gating.";

  if (requiredCount === 2) {
    profile = "balanced";
    title = "Balanced client hardening";
    summary = "Most client-side hardening controls stay enabled, but one anti-crack gate is intentionally relaxed for this project.";
    nextAction = "Confirm the relaxed control matches this project's threat model before shipping the client.";
  } else if (requiredCount <= 1) {
    profile = "relaxed";
    title = "Relaxed client hardening";
    summary = "This project leans more on server-side authorization and keeps fewer client-side anti-crack gates enabled.";
    nextAction = "Only use the relaxed profile when the software author intentionally accepts a lower client hardening bar.";
  }

  return {
    profile,
    title,
    summary,
    nextAction,
    requiredCount,
    totalControls: controls.length,
    startupBootstrapRequired,
    localTokenValidationRequired,
    heartbeatGateRequired,
    controls: controls.map((item) => ({
      key: item.key,
      label: item.label,
      required: item.required,
      summary: item.required ? item.requiredSummary : item.relaxedSummary
    })),
    coreProtocolNotes: [
      "HMAC request signing, timestamp/nonce replay protection, and server-side token verification stay mandatory.",
      "Project hardening toggles change client-side guidance, not the core runtime trust chain."
    ]
  };
}

function buildClientHardeningGuideText({
  projectCode = "",
  channel = "stable",
  clientHardening = {}
} = {}) {
  const resolved = clientHardening && typeof clientHardening === "object" && clientHardening.profile
    ? clientHardening
    : buildClientHardeningProfile(clientHardening);
  const lines = [
    "RockSolid Client Hardening Guide",
    `Project Code: ${projectCode || "-"}`,
    `Channel: ${channel || "stable"}`,
    `Profile: ${String(resolved.profile || "unknown").toUpperCase()}`,
    `Summary: ${resolved.summary || "-"}`,
    ""
  ];

  const coreProtocolNotes = Array.isArray(resolved.coreProtocolNotes) ? resolved.coreProtocolNotes : [];
  if (coreProtocolNotes.length) {
    lines.push("Core Protocol Security (always on):");
    for (const item of coreProtocolNotes) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  const controls = Array.isArray(resolved.controls) ? resolved.controls : [];
  if (controls.length) {
    lines.push("Project-level Controls:");
    for (const item of controls) {
      lines.push(`- [${item.required ? "REQUIRED" : "OPTIONAL"}] ${item.label}: ${item.summary}`);
    }
    lines.push("");
  }

  lines.push("Recommended Integration Order:");
  lines.push("1. Create one LicenseClientWin instance at app startup and cache a stable device fingerprint.");
  lines.push(resolved.startupBootstrapRequired
    ? "2. Call startup_bootstrap_http(...) before showing login or recharge UI, then enforce evaluate_startup_decision(...)."
    : "2. Call startup_bootstrap_http(...) during app launch as a recommended pre-login check, even though this project does not hard-require it.");
  lines.push(resolved.localTokenValidationRequired
    ? "3. Persist the bootstrap payload or returned key set so the host app can verify licenseToken locally after login."
    : "3. Local licenseToken validation is optional here, but keeping the returned key set still raises the reverse-engineering cost.");
  lines.push("4. Run parsed login helpers and keep the returned binding, quota, and session metadata available to the host application.");
  lines.push(resolved.heartbeatGateRequired
    ? "5. Keep protected features behind a healthy heartbeat and react immediately when the session is revoked, expired, or no longer renewed."
    : "5. Heartbeat is still recommended for online state, but this project uses a softer local feature gate after heartbeat loss.");
  lines.push("");
  lines.push(`Shipping Note: ${resolved.nextAction || "-"}`);

  return lines.join("\n");
}

function buildIntegrationExamples() {
  return {
    http: [
      { action: "startup-bootstrap", path: "/api/client/startup-bootstrap" },
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
  const startupDefaults = manifest.startupDefaults || {};
  const clientHardening = manifest.clientHardening || buildClientHardeningProfile(project.featureConfig || {});

  return [
    `RS_PROJECT_CODE=${project.code || ""}`,
    `RS_PROJECT_NAME=${project.name || ""}`,
    `RS_SDK_APP_ID=${credentials.sdkAppId || ""}`,
    `RS_SDK_APP_SECRET=${credentials.sdkAppSecret || ""}`,
    `RS_APP_SALT=${credentials.deviceFingerprintSalt || project.code || ""}`,
    `RS_HTTP_BASE_URL=${http.baseUrl || ""}`,
    `RS_HTTP_HOST=${http.host || ""}`,
    `RS_HTTP_PORT=${http.port ?? ""}`,
    `RS_HTTP_SECURE=${http.secure === true ? "true" : "false"}`,
    `RS_TCP_ENABLED=${tcp.enabled === true ? "true" : "false"}`,
    `RS_TCP_HOST=${tcp.host || ""}`,
    `RS_TCP_PORT=${tcp.port ?? ""}`,
    `RS_REQUEST_SKEW_SECONDS=${signing.requestSkewSeconds ?? ""}`,
    `RS_TOKEN_ISSUER=${signing.tokenIssuer || ""}`,
    `RS_ACTIVE_KEY_ID=${signing.activeKeyId || ""}`,
    `RS_CLIENT_VERSION=${String(startupDefaults.clientVersion ?? "1.0.0").trim() || "1.0.0"}`,
    `RS_CHANNEL=${String(startupDefaults.channel ?? "stable").trim() || "stable"}`,
    `RS_INCLUDE_TOKEN_KEYS=${startupDefaults.includeTokenKeys !== false ? "true" : "false"}`,
    `RS_REQUIRE_STARTUP_BOOTSTRAP=${clientHardening.startupBootstrapRequired ? "true" : "false"}`,
    `RS_REQUIRE_LOCAL_TOKEN_VALIDATION=${clientHardening.localTokenValidationRequired ? "true" : "false"}`,
    `RS_REQUIRE_HEARTBEAT_GATE=${clientHardening.heartbeatGateRequired ? "true" : "false"}`,
    `RS_RUN_NETWORK_DEMO=false`,
    `RS_DEMO_USERNAME=demo_user`,
    `RS_DEMO_PASSWORD=demo_password`,
    `RS_DEMO_DEVICE_NAME=Demo Workstation`
  ].join("\n");
}

function buildIntegrationHostConfigTemplate(manifest) {
  return [
    "# Copy this file to sdk/examples/cmake_cpp_host_consumer/rocksolid_host_config.env",
    "# or place it next to the packaged CMake host consumer example before running the network demo.",
    "# Add real demo credentials, then flip RS_RUN_NETWORK_DEMO=true when you want the example to log in.",
    "",
    buildIntegrationEnvTemplate(manifest)
  ].join("\n");
}

function buildIntegrationConsumerProjectBaseName(manifest) {
  const project = manifest.project || {};
  const seed = String(project.code || "rocksolid_host_consumer")
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^[0-9]/, "_$&")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return seed || "rocksolid_host_consumer";
}

function buildDeterministicProjectGuid(seed) {
  const digest = sha256Hex(String(seed || "rocksolid"));
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32)
  ].join("-").toUpperCase();
}

function buildIntegrationCMakeConsumerTemplate(manifest) {
  const project = manifest.project || {};
  const startupDefaults = manifest.startupDefaults || {};
  const targetBase = buildIntegrationConsumerProjectBaseName(manifest);
  const targetName = `${targetBase.toLowerCase()}_host_consumer`;
  const channel = String(startupDefaults.channel ?? "stable").trim() || "stable";

  return `cmake_minimum_required(VERSION 3.20)

project(${targetName} LANGUAGES CXX)

set(ROCKSOLID_SDK_CMAKE_DIR "" CACHE PATH "Path to the extracted RockSolid SDK package cmake folder")

if(NOT ROCKSOLID_SDK_CMAKE_DIR)
  message(FATAL_ERROR "Set ROCKSOLID_SDK_CMAKE_DIR to the packaged RockSolid SDK cmake directory before configuring this consumer project.")
endif()

find_package(RockSolidSDK CONFIG REQUIRED PATHS "\${ROCKSOLID_SDK_CMAKE_DIR}" NO_DEFAULT_PATH)

add_executable(${targetName} main.cpp)
target_compile_features(${targetName} PRIVATE cxx_std_17)
target_link_libraries(${targetName} PRIVATE RockSolidSDK::cpp_static)

message(STATUS "Configured ${targetName} for ${escapeCppStringLiteral(project.code || "")} (${escapeCppStringLiteral(channel)})")
message(STATUS "Keep rocksolid_host_config.env next to the built executable or working directory before enabling RS_RUN_NETWORK_DEMO=true.")
`;
}

function buildIntegrationVs2022ProjectTemplate(manifest) {
  const project = manifest.project || {};
  const startupDefaults = manifest.startupDefaults || {};
  const projectBase = buildIntegrationConsumerProjectBaseName(manifest);
  const projectName = `${projectBase}_host_consumer`;
  const guideFileName = `${projectBase}_vs2022_quickstart.md`;
  const channel = String(startupDefaults.channel ?? "stable").trim() || "stable";
  const projectGuid = buildDeterministicProjectGuid(`${project.code || projectName}:vs2022`);

  return `<?xml version="1.0" encoding="utf-8"?>
<Project DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <ItemGroup Label="ProjectConfigurations">
    <ProjectConfiguration Include="Debug|x64">
      <Configuration>Debug</Configuration>
      <Platform>x64</Platform>
    </ProjectConfiguration>
    <ProjectConfiguration Include="Release|x64">
      <Configuration>Release</Configuration>
      <Platform>x64</Platform>
    </ProjectConfiguration>
  </ItemGroup>
  <PropertyGroup Label="Globals">
    <VCProjectVersion>17.0</VCProjectVersion>
    <ProjectGuid>{${projectGuid}}</ProjectGuid>
    <Keyword>Win32Proj</Keyword>
    <ProjectName>${projectName}</ProjectName>
    <WindowsTargetPlatformVersion>10.0</WindowsTargetPlatformVersion>
  </PropertyGroup>
  <Import Project="$(VCTargetsPath)\\Microsoft.Cpp.Default.props" />
  <PropertyGroup Condition="'$(Configuration)|$(Platform)'=='Debug|x64'" Label="Configuration">
    <ConfigurationType>Application</ConfigurationType>
    <UseDebugLibraries>false</UseDebugLibraries>
    <PlatformToolset>v143</PlatformToolset>
    <CharacterSet>Unicode</CharacterSet>
  </PropertyGroup>
  <PropertyGroup Condition="'$(Configuration)|$(Platform)'=='Release|x64'" Label="Configuration">
    <ConfigurationType>Application</ConfigurationType>
    <UseDebugLibraries>false</UseDebugLibraries>
    <PlatformToolset>v143</PlatformToolset>
    <WholeProgramOptimization>true</WholeProgramOptimization>
    <CharacterSet>Unicode</CharacterSet>
  </PropertyGroup>
  <Import Project="$(VCTargetsPath)\\Microsoft.Cpp.props" />
  <ImportGroup Label="ExtensionSettings" />
  <ImportGroup Label="Shared" />
  <ImportGroup Label="PropertySheets" Condition="'$(Configuration)|$(Platform)'=='Debug|x64'">
    <Import Project="$(UserRootDir)\\Microsoft.Cpp.$(Platform).user.props" Condition="exists('$(UserRootDir)\\Microsoft.Cpp.$(Platform).user.props')" Label="LocalAppDataPlatform" />
    <Import Project="RockSolidSDK.props" Condition="exists('RockSolidSDK.props')" />
    <Import Project="RockSolidSDK.local.props" Condition="exists('RockSolidSDK.local.props')" />
  </ImportGroup>
  <ImportGroup Label="PropertySheets" Condition="'$(Configuration)|$(Platform)'=='Release|x64'">
    <Import Project="$(UserRootDir)\\Microsoft.Cpp.$(Platform).user.props" Condition="exists('$(UserRootDir)\\Microsoft.Cpp.$(Platform).user.props')" Label="LocalAppDataPlatform" />
    <Import Project="RockSolidSDK.props" Condition="exists('RockSolidSDK.props')" />
    <Import Project="RockSolidSDK.local.props" Condition="exists('RockSolidSDK.local.props')" />
  </ImportGroup>
  <PropertyGroup Label="UserMacros" />
  <ItemGroup>
    <ClCompile Include="main.cpp" />
    <None Include="RockSolidSDK.props" />
    <None Include="RockSolidSDK.local.props" />
    <None Include="rocksolid_host_config.env" />
    <None Include="${guideFileName}" />
  </ItemGroup>
  <Import Project="$(VCTargetsPath)\\Microsoft.Cpp.targets" />
  <ImportGroup Label="ExtensionTargets" />
</Project>
<!-- Project: ${project.code || "-"} | Channel: ${channel} | Set ROCKSOLID_SDK_ROOT to the extracted rocksolid-sdk-cpp package root before building in VS2022. -->
`;
}

function buildIntegrationVs2022FiltersTemplate(manifest) {
  const project = manifest.project || {};
  const projectBase = buildIntegrationConsumerProjectBaseName(manifest);
  const guideFileName = `${projectBase}_vs2022_quickstart.md`;
  const sourceFilterGuid = buildDeterministicProjectGuid(`${project.code || projectBase}:vs2022-filters:source`);
  const configFilterGuid = buildDeterministicProjectGuid(`${project.code || projectBase}:vs2022-filters:config`);
  const docsFilterGuid = buildDeterministicProjectGuid(`${project.code || projectBase}:vs2022-filters:docs`);

  return `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="4.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <ItemGroup>
    <Filter Include="Source Files">
      <UniqueIdentifier>{${sourceFilterGuid}}</UniqueIdentifier>
    </Filter>
    <Filter Include="Config">
      <UniqueIdentifier>{${configFilterGuid}}</UniqueIdentifier>
    </Filter>
    <Filter Include="Docs">
      <UniqueIdentifier>{${docsFilterGuid}}</UniqueIdentifier>
    </Filter>
  </ItemGroup>
  <ItemGroup>
    <ClCompile Include="main.cpp">
      <Filter>Source Files</Filter>
    </ClCompile>
    <None Include="RockSolidSDK.props">
      <Filter>Config</Filter>
    </None>
    <None Include="RockSolidSDK.local.props">
      <Filter>Config</Filter>
    </None>
    <None Include="rocksolid_host_config.env">
      <Filter>Config</Filter>
    </None>
    <None Include="${guideFileName}">
      <Filter>Docs</Filter>
    </None>
  </ItemGroup>
</Project>
`;
}

function buildIntegrationVs2022LocalPropsTemplate(manifest) {
  const project = manifest.project || {};
  const projectBase = buildIntegrationConsumerProjectBaseName(manifest);
  const projectName = `${projectBase}_host_consumer`;
  const startupDefaults = manifest.startupDefaults || {};
  const channel = String(startupDefaults.channel ?? "stable").trim() || "stable";

  return `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="4.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup Label="RockSolidLocalOverrides">
    <!-- Optional machine-local overrides. Edit this file instead of RockSolidSDK.props when you need a different SDK path or local debugger working directory. -->
    <ROCKSOLID_SDK_ROOT_OVERRIDE></ROCKSOLID_SDK_ROOT_OVERRIDE>
    <ROCKSOLID_TARGET_NAME_OVERRIDE></ROCKSOLID_TARGET_NAME_OVERRIDE>
    <ROCKSOLID_WORKDIR_OVERRIDE></ROCKSOLID_WORKDIR_OVERRIDE>
  </PropertyGroup>
  <PropertyGroup>
    <ROCKSOLID_SDK_ROOT Condition="'$(ROCKSOLID_SDK_ROOT_OVERRIDE)'!=''">$(ROCKSOLID_SDK_ROOT_OVERRIDE)</ROCKSOLID_SDK_ROOT>
    <ROCKSOLID_TARGET_NAME Condition="'$(ROCKSOLID_TARGET_NAME_OVERRIDE)'!=''">$(ROCKSOLID_TARGET_NAME_OVERRIDE)</ROCKSOLID_TARGET_NAME>
    <LocalDebuggerWorkingDirectory Condition="'$(ROCKSOLID_WORKDIR_OVERRIDE)'!=''">$(ROCKSOLID_WORKDIR_OVERRIDE)</LocalDebuggerWorkingDirectory>
  </PropertyGroup>
</Project>
<!-- Project: ${project.code || "-"} | Channel: ${channel} | Keep this file machine-local so teammates can share the same base handoff without changing RockSolidSDK.props. -->
`;
}

function buildIntegrationVs2022SolutionTemplate(manifest) {
  const project = manifest.project || {};
  const projectBase = buildIntegrationConsumerProjectBaseName(manifest);
  const projectName = `${projectBase}_host_consumer`;
  const projectGuid = buildDeterministicProjectGuid(`${project.code || projectName}:vs2022`);
  const projectFileName = `${projectName}.vcxproj`;

  return `Microsoft Visual Studio Solution File, Format Version 12.00
# Visual Studio Version 17
VisualStudioVersion = 17.0.31903.59
MinimumVisualStudioVersion = 10.0.40219.1
Project("{BC8A1FFA-BEE3-4634-8014-F334798102B3}") = "${projectName}", "${projectFileName}", "{${projectGuid}}"
EndProject
Global
\tGlobalSection(SolutionConfigurationPlatforms) = preSolution
\t\tDebug|x64 = Debug|x64
\t\tRelease|x64 = Release|x64
\tEndGlobalSection
\tGlobalSection(ProjectConfigurationPlatforms) = postSolution
\t\t{${projectGuid}}.Debug|x64.ActiveCfg = Debug|x64
\t\t{${projectGuid}}.Debug|x64.Build.0 = Debug|x64
\t\t{${projectGuid}}.Release|x64.ActiveCfg = Release|x64
\t\t{${projectGuid}}.Release|x64.Build.0 = Release|x64
\tEndGlobalSection
\tGlobalSection(SolutionProperties) = preSolution
\t\tHideSolutionNode = FALSE
\tEndGlobalSection
EndGlobal
`;
}

function buildIntegrationVs2022PropsTemplate(manifest) {
  const project = manifest.project || {};
  const startupDefaults = manifest.startupDefaults || {};
  const projectBase = buildIntegrationConsumerProjectBaseName(manifest);
  const projectName = `${projectBase}_host_consumer`;
  const channel = String(startupDefaults.channel ?? "stable").trim() || "stable";

  return `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="4.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup Label="UserMacros">
    <ROCKSOLID_SDK_ROOT Condition="'$(ROCKSOLID_SDK_ROOT)'==''">$(MSBuildThisFileDirectory)..\\..\\rocksolid-sdk-cpp</ROCKSOLID_SDK_ROOT>
    <ROCKSOLID_TARGET_NAME Condition="'$(ROCKSOLID_TARGET_NAME)'==''">${projectName}</ROCKSOLID_TARGET_NAME>
  </PropertyGroup>
  <PropertyGroup>
    <OutDir>$(MSBuildThisFileDirectory)build\\$(Configuration)\\</OutDir>
    <IntDir>$(MSBuildThisFileDirectory)build\\obj\\$(Configuration)\\</IntDir>
    <TargetName>$(ROCKSOLID_TARGET_NAME)</TargetName>
    <LocalDebuggerWorkingDirectory>$(MSBuildThisFileDirectory)</LocalDebuggerWorkingDirectory>
  </PropertyGroup>
  <ItemDefinitionGroup Condition="'$(Configuration)|$(Platform)'=='Debug|x64'">
    <ClCompile>
      <WarningLevel>Level3</WarningLevel>
      <SDLCheck>true</SDLCheck>
      <PreprocessorDefinitions>RS_SDK_STATIC;NDEBUG;%(PreprocessorDefinitions)</PreprocessorDefinitions>
      <ConformanceMode>true</ConformanceMode>
      <LanguageStandard>stdcpp17</LanguageStandard>
      <RuntimeLibrary>MultiThreaded</RuntimeLibrary>
      <AdditionalIncludeDirectories>$(ROCKSOLID_SDK_ROOT)\\include;%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories>
    </ClCompile>
    <Link>
      <SubSystem>Console</SubSystem>
      <AdditionalDependencies>rocksolid_sdk_static.lib;bcrypt.lib;winhttp.lib;ws2_32.lib;crypt32.lib;%(AdditionalDependencies)</AdditionalDependencies>
      <AdditionalLibraryDirectories>$(ROCKSOLID_SDK_ROOT)\\lib;%(AdditionalLibraryDirectories)</AdditionalLibraryDirectories>
    </Link>
  </ItemDefinitionGroup>
  <ItemDefinitionGroup Condition="'$(Configuration)|$(Platform)'=='Release|x64'">
    <ClCompile>
      <WarningLevel>Level3</WarningLevel>
      <FunctionLevelLinking>true</FunctionLevelLinking>
      <IntrinsicFunctions>true</IntrinsicFunctions>
      <SDLCheck>true</SDLCheck>
      <PreprocessorDefinitions>RS_SDK_STATIC;NDEBUG;%(PreprocessorDefinitions)</PreprocessorDefinitions>
      <ConformanceMode>true</ConformanceMode>
      <LanguageStandard>stdcpp17</LanguageStandard>
      <RuntimeLibrary>MultiThreaded</RuntimeLibrary>
      <AdditionalIncludeDirectories>$(ROCKSOLID_SDK_ROOT)\\include;%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories>
    </ClCompile>
    <Link>
      <SubSystem>Console</SubSystem>
      <EnableCOMDATFolding>true</EnableCOMDATFolding>
      <OptimizeReferences>true</OptimizeReferences>
      <AdditionalDependencies>rocksolid_sdk_static.lib;bcrypt.lib;winhttp.lib;ws2_32.lib;crypt32.lib;%(AdditionalDependencies)</AdditionalDependencies>
      <AdditionalLibraryDirectories>$(ROCKSOLID_SDK_ROOT)\\lib;%(AdditionalLibraryDirectories)</AdditionalLibraryDirectories>
    </Link>
  </ItemDefinitionGroup>
</Project>
<!-- Project: ${project.code || "-"} | Channel: ${channel} | Set ROCKSOLID_SDK_ROOT to the extracted rocksolid-sdk-cpp package root before building in VS2022. -->
`;
}

function buildIntegrationVs2022QuickstartTemplate(manifest) {
  const project = manifest.project || {};
  const startupDefaults = manifest.startupDefaults || {};
  const clientHardening = manifest.clientHardening || {};
  const projectBase = buildIntegrationConsumerProjectBaseName(manifest);
  const solutionName = `${projectBase}_host_consumer.sln`;
  const projectName = `${projectBase}_host_consumer.vcxproj`;
  const channel = String(startupDefaults.channel ?? "stable").trim() || "stable";
  const clientVersion = String(startupDefaults.clientVersion ?? "1.0.0").trim() || "1.0.0";

  const requirementLine = (enabled, requiredLabel, optionalLabel) => (
    enabled ? `REQUIRED: ${requiredLabel}` : `OPTIONAL: ${optionalLabel}`
  );

  return [
    `# VS2022 Quickstart for ${project.code || "ROCKSOLID_APP"}`,
    "",
    "This handoff is meant for software authors who want to open a ready-made native Visual Studio 2022 solution instead of wiring a project by hand.",
    "",
    "Files inside vs2022-consumer/:",
    `- ${solutionName}: open this solution in VS2022 first.`,
    `- ${projectName}: the generated host project referenced by the solution.`,
    `- ${projectName}.filters: keeps Source Files, Config, and Docs grouped inside Solution Explorer.`,
    "- RockSolidSDK.props: include/lib/runtime settings. Change ROCKSOLID_SDK_ROOT here if the SDK package lives elsewhere.",
    "- RockSolidSDK.local.props: machine-local override sheet. Prefer editing this file when only your workstation needs a different SDK path, target name, or debugger working directory.",
    "- main.cpp: the generated project-aware host skeleton. Replace or adapt this with your real protected app entry flow.",
    "- rocksolid_host_config.env: runtime settings the host skeleton reads for startup bootstrap, login, token verification, and heartbeat behavior.",
    "",
    `Project: ${project.code || "-"} (${project.name || "Unnamed Project"})`,
    `Default startup channel: ${channel}`,
    `Default client version: ${clientVersion}`,
    clientHardening.profile
      ? `Client hardening profile: ${clientHardening.profile}`
      : "Client hardening profile: balanced",
    clientHardening.summary
      ? `Client hardening summary: ${clientHardening.summary}`
      : "Client hardening summary: Review the package JSON for the full runtime expectations.",
    `- startup-bootstrap: ${requirementLine(clientHardening.startupBootstrapRequired, "Run startup_bootstrap_http(...) before allowing protected features.", "You can phase this in later, but startup bootstrap is still the recommended default.")}`,
    `- local token validation: ${requirementLine(clientHardening.localTokenValidationRequired, "Verify the returned licenseToken locally before trusting entitlement data.", "You can start with service-side trust first, then turn on local validation when the host flow is ready.")}`,
    `- heartbeat gate: ${requirementLine(clientHardening.heartbeatGateRequired, "Use heartbeat results to keep protected features gated while the session stays healthy.", "You can start by observing heartbeats, then make them gate protected features once the host flow is stable.")}`,
    "",
    "First-run checklist:",
    "1. Extract the rocksolid-sdk-cpp package next to the handoff folder. Keep RockSolidSDK.props as the shared default sheet, and only edit RockSolidSDK.local.props if your workstation needs a different SDK root.",
    `2. Keep ${solutionName}, ${projectName}, ${projectName}.filters, RockSolidSDK.props, RockSolidSDK.local.props, main.cpp, and rocksolid_host_config.env together inside the same vs2022-consumer/ folder.`,
    `3. Review rocksolid_host_config.env and confirm RS_PROJECT_CODE=${project.code || ""}, RS_CHANNEL=${channel}, RS_CLIENT_VERSION=${clientVersion}, RS_APP_ID, RS_APP_SECRET, RS_API_BASE_URL, and RS_HTTP_HOST match the target environment.`,
    "4. For a smoke test, set RS_RUN_NETWORK_DEMO=true and fill RS_DEMO_USERNAME plus RS_DEMO_PASSWORD with a real test account or card-login flow.",
    "5. Open the solution in VS2022, choose x64 Debug or x64 Release, then build the solution.",
    "6. Run the built executable with the working directory still pointing at the vs2022-consumer/ folder so rocksolid_host_config.env can be found.",
    "",
    "Before shipping:",
    "- Replace demo credentials, and set RS_RUN_NETWORK_DEMO=false once the host app has taken over the real login/startup flow.",
    "- Replace local/testing API hosts with the public TLS domain or reverse-proxy endpoint that production clients should call.",
    "- Re-download this handoff package after rotating sdkAppId, sdkAppSecret, token keys, or project hardening settings so the VS2022 assets stay aligned."
  ].join("\n");
}

function buildIntegrationCppQuickstart(manifest) {
  const project = manifest.project || {};
  const credentials = manifest.credentials || {};
  const transport = manifest.transport || {};
  const http = resolveIntegrationHttpEndpoint(transport.http || {});
  const tcp = transport.tcp || {};
  const clientHardening = manifest.clientHardening || buildClientHardeningProfile(project.featureConfig || {});
  const startupComment = clientHardening.startupBootstrapRequired
    ? "Call startup bootstrap before login or recharge UI and enforce the returned decision."
    : "Startup bootstrap is still recommended before login, but this project does not force it as a local UI gate.";
  const tokenComment = clientHardening.localTokenValidationRequired
    ? "Cache the returned public keys and verify licenseToken signatures locally before unlocking protected features."
    : "Local licenseToken validation is optional here, but keeping it enabled still raises the patching cost.";
  const heartbeatComment = clientHardening.heartbeatGateRequired
    ? "Keep protected features behind a healthy heartbeat and react immediately to revoked or expired sessions."
    : "Heartbeat is still recommended for online state, but this project uses a softer local feature gate after heartbeat loss.";

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

// ${escapeCppStringLiteral(startupComment)}
const rocksolid::ClientStartupBootstrapResponse startup =
  client.startup_bootstrap_http({ product_code, client_version, channel, ${clientHardening.localTokenValidationRequired ? "true" : "false"} });
const rocksolid::ClientStartupDecision startup_decision =
  rocksolid::LicenseClientWin::evaluate_startup_decision(startup);

if (!startup_decision.allow_login) {
  // Show startup_decision.primary_title / primary_message and skip login here.
} else {
  // ${escapeCppStringLiteral(tokenComment)}
  rocksolid::LoginRequest login_request{
    product_code,
    "demo_user",
    "demo_password",
    client.generate_device_fingerprint(),
    "Demo Workstation",
    client_version,
    channel
  };

  const rocksolid::LoginResponse login_result = client.login_http_parsed(login_request);
  // ${escapeCppStringLiteral(heartbeatComment)}
}`;
}

function buildIntegrationCppHostSkeleton(manifest) {
  const project = manifest.project || {};
  const credentials = manifest.credentials || {};
  const transport = manifest.transport || {};
  const http = resolveIntegrationHttpEndpoint(transport.http || {});
  const tcp = transport.tcp || {};
  const startupDefaults = manifest.startupDefaults || {};
  const clientHardening = manifest.clientHardening || buildClientHardeningProfile(project.featureConfig || {});
  const productCode = project.code || "";
  const clientVersion = String(startupDefaults.clientVersion ?? "1.0.0").trim() || "1.0.0";
  const channel = String(startupDefaults.channel ?? "stable").trim() || "stable";
  const includeTokenKeys = startupDefaults.includeTokenKeys !== false;
  const loginMethod = tcp.enabled === true ? "login_tcp_parsed" : "login_http_parsed";
  const heartbeatMethod = tcp.enabled === true ? "heartbeat_tcp_parsed" : "heartbeat_http_parsed";
  const startupLine = clientHardening.startupBootstrapRequired
    ? "// This project requires startup bootstrap before login or recharge UI is shown."
    : "// Startup bootstrap is still recommended here, even though the project does not hard-block the local UI.";
  const tokenValidationBlock = clientHardening.localTokenValidationRequired
    ? `  const rocksolid::TokenValidationResult validation =
    rocksolid::LicenseClientWin::validate_license_token_with_bootstrap(
      login.license_token,
      runtime.startup_cache.bootstrap
    );
  if (!validation.valid) {
    host_app::set_feature_gate(gate, false, "local_token_validation_failed");
    throw std::runtime_error("licenseToken failed local signature validation.");
  }
  std::cout << "[token] local validation passed with key " << validation.key_id << std::endl;`
    : `  if (include_token_keys) {
    const rocksolid::TokenValidationResult validation =
      rocksolid::LicenseClientWin::validate_license_token_with_bootstrap(
        login.license_token,
        runtime.startup_cache.bootstrap
      );
    std::cout << "[token] optional local validation="
              << (validation.valid ? "true" : "false")
              << " key=" << validation.key_id << std::endl;
  }`;
  const heartbeatBlock = clientHardening.heartbeatGateRequired
    ? `  host_app::set_feature_gate(gate, true, "session_active");

  // Move this heartbeat loop into a background worker in the real host app.
  while (runtime.logged_in) {
    const rocksolid::HeartbeatResponse heartbeat =
      client.${heartbeatMethod}({
        product_code,
        runtime.login.session_token,
        device_fingerprint,
        client_version,
        channel_name
      });

    if (heartbeat.status != "active") {
      host_app::set_feature_gate(gate, false, "heartbeat_not_active");
      runtime.logged_in = false;
      std::cout << "[heartbeat] session is no longer active." << std::endl;
      break;
    }

    std::cout << "[heartbeat] next in "
              << heartbeat.next_heartbeat_in_seconds
              << "s" << std::endl;
    std::this_thread::sleep_for(std::chrono::seconds(
      heartbeat.next_heartbeat_in_seconds > 0 ? heartbeat.next_heartbeat_in_seconds : 15
    ));
  }`
    : `  host_app::set_feature_gate(gate, true, "login_succeeded");

  const rocksolid::HeartbeatResponse heartbeat =
    client.${heartbeatMethod}({
      product_code,
      runtime.login.session_token,
      device_fingerprint,
      client_version,
      channel_name
    });
  std::cout << "[heartbeat] optional status=" << heartbeat.status
            << " next=" << heartbeat.next_heartbeat_in_seconds << "s" << std::endl;
  // This project keeps a softer local gate after heartbeat loss, but the host app
  // should still retry, log, and degrade online-only features when heartbeat stops.`;

  return `#include "rocksolid_transport_win.hpp"

#include <chrono>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>

namespace host_app {

struct FeatureGate {
  bool protected_features_enabled = false;
  std::string reason = "startup_pending";
};

struct RuntimeSession {
  rocksolid::ClientStartupBootstrapCache startup_cache;
  rocksolid::LoginResponse login;
  bool logged_in = false;
};

void set_feature_gate(FeatureGate& gate, bool enabled, const std::string& reason) {
  gate.protected_features_enabled = enabled;
  gate.reason = reason;
  std::cout << "[gate] protected="
            << (enabled ? "true" : "false")
            << " reason=" << reason << std::endl;
}

}  // namespace host_app

int main() {
  try {
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
    tcp_endpoint.port = ${Number(tcp.port || 0)};

    rocksolid::LicenseClientWin client(identity, http_endpoint, tcp_endpoint);

    const std::string product_code = "${escapeCppStringLiteral(productCode)}";
    const std::string client_version = "${escapeCppStringLiteral(clientVersion)}";
    const std::string channel_name = "${escapeCppStringLiteral(channel)}";
    const bool include_token_keys = ${includeTokenKeys ? "true" : "false"};
    const std::string device_fingerprint = client.generate_device_fingerprint();

    host_app::FeatureGate gate;
    host_app::RuntimeSession runtime;
    host_app::set_feature_gate(gate, false, "startup_bootstrap_pending");

${startupLine}
    const rocksolid::ClientStartupBootstrapResponse startup =
      client.startup_bootstrap_http({
        product_code,
        client_version,
        channel_name,
        include_token_keys
      });
    const rocksolid::ClientStartupDecision startup_decision =
      rocksolid::LicenseClientWin::evaluate_startup_decision(startup);

    if (!startup_decision.allow_login) {
      std::cout << "[startup] blocked code=" << startup_decision.primary_code
                << " message=" << startup_decision.primary_message << std::endl;
      return 0;
    }

    runtime.startup_cache = {
      1,
      rocksolid::iso8601_now_utc(),
      startup
    };
    rocksolid::LicenseClientWin::write_startup_bootstrap_cache_file(
      "rocksolid-startup-cache.json",
      runtime.startup_cache
    );

    rocksolid::LoginRequest login_request{
      product_code,
      "demo_user",
      "demo_password",
      device_fingerprint,
      "Demo Workstation",
      client_version,
      channel_name
    };

    const rocksolid::LoginResponse login = client.${loginMethod}(login_request);
    runtime.login = login;
    runtime.logged_in = true;

${tokenValidationBlock}

${heartbeatBlock}
    return 0;
  } catch (const rocksolid::ApiException& error) {
    std::cerr << "RockSolid API failed: code=" << error.code()
              << " status=" << error.status()
              << " transportStatus=" << error.transport_status()
              << " message=" << error.what() << std::endl;
    return 1;
  } catch (const std::exception& error) {
    std::cerr << "Host skeleton failed: " << error.what() << std::endl;
    return 1;
  }
}`;
}

function buildIntegrationStartupWorkflow({
  projectActive,
  featureConfig,
  versionManifest,
  activeNoticeRows = [],
  blockingNoticeRows = [],
  includeTokenKeys = true
}) {
  const clientHardening = buildClientHardeningProfile(featureConfig);
  const workflow = [
    clientHardening.startupBootstrapRequired
      ? "Call POST /api/client/startup-bootstrap before showing login or recharge UI."
      : "Call POST /api/client/startup-bootstrap during app launch as a recommended pre-login step."
  ];

  if (!projectActive) {
    workflow.push("Re-enable the project first, because inactive projects reject startup requests.");
  } else if (featureConfig.allowVersionCheck !== false) {
    if (versionManifest?.allowed === false) {
      workflow.push("Block local login when versionManifest.allowed is false or a force update is required.");
    } else if (versionManifest?.status === "upgrade_recommended") {
      workflow.push("Show a non-blocking upgrade prompt when startup reports upgrade_recommended.");
    } else {
      workflow.push("Continue to login when versionManifest.allowed stays true.");
    }
  } else {
    workflow.push("Version gating is currently disabled for this project, so startup will not block by version.");
  }

  if (featureConfig.allowNotices !== false) {
    if (blockingNoticeRows.length) {
      workflow.push("Display the blocking maintenance notice immediately and keep login disabled until it is cleared.");
    } else if (activeNoticeRows.length) {
      workflow.push("Render the returned startup notices before login so users see current announcements.");
    } else {
      workflow.push("No active startup notices are configured for the default channel right now.");
    }
  } else {
    workflow.push("Startup notices are currently disabled for this project.");
  }

  if (clientHardening.localTokenValidationRequired && includeTokenKeys) {
    workflow.push("Cache the returned public token keys so the client can verify licenseToken signatures locally.");
  } else if (clientHardening.localTokenValidationRequired) {
    workflow.push("Request token keys during startup if the client also needs local licenseToken verification.");
  } else if (includeTokenKeys) {
    workflow.push("Token keys are still included, so the client can optionally verify licenseToken signatures for extra hardening.");
  } else {
    workflow.push("Local licenseToken verification is optional for this project, but enabling token key retrieval still raises the reverse-engineering bar.");
  }

  if (clientHardening.heartbeatGateRequired) {
    workflow.push("Stop protected features locally when heartbeat renewals fail or the runtime session becomes invalid.");
  } else {
    workflow.push("Heartbeat is still recommended for online status, but local feature gating after heartbeat loss is relaxed for this project.");
  }

  return workflow;
}

async function buildIntegrationStartupPreviewPayload(
  db,
  store,
  product,
  tokenKeys,
  startupRequest = {}
) {
  const featureConfig = snapshotManagedProductFeatureConfig(resolveProductFeatureConfig(db, product));
  const clientHardening = buildClientHardeningProfile(featureConfig);
  const request = {
    productCode: product.code,
    clientVersion: String(startupRequest.clientVersion ?? "1.0.0").trim() || "1.0.0",
    channel: normalizeChannel(startupRequest.channel, "stable"),
    includeTokenKeys: startupRequest.includeTokenKeys !== undefined
      ? startupRequest.includeTokenKeys !== false
      : clientHardening.localTokenValidationRequired
  };
  const projectActive = (product.status ?? "active") === "active";
  const versionManifest = featureConfig.allowVersionCheck !== false
    ? await buildVersionManifest(db, store, product, request.clientVersion, request.channel)
    : buildDisabledVersionManifest(product, request.clientVersion, request.channel);
  const activeNoticeRows = featureConfig.allowNotices !== false
    ? await activeNoticesForProduct(db, store, product.id, request.channel)
    : [];
  const notices = featureConfig.allowNotices !== false
    ? {
        productCode: product.code,
        channel: normalizeNoticeChannel(request.channel, "stable"),
        enabled: true,
        status: "enabled",
        message: activeNoticeRows.length
          ? "Active notices loaded."
          : "No active notices for the default startup channel.",
        notices: activeNoticeRows
      }
    : buildDisabledNoticeManifest(product, request.channel);
  const blockingNoticeRows = activeNoticeRows.filter((item) => item.blockLogin);
  const totalPublicKeys = Array.isArray(tokenKeys?.keys) ? tokenKeys.keys.length : 0;
  const hasTokenKeys = request.includeTokenKeys && totalPublicKeys > 0;
  const activeTokenKey = Array.isArray(tokenKeys?.keys)
    ? (
        tokenKeys.keys.find((entry) => entry.keyId === tokenKeys.activeKeyId)
        || tokenKeys.keys.find((entry) => entry.status === "active")
        || tokenKeys.keys[0]
        || null
      )
    : null;

  let status = "ready";
  let ready = true;
  let message = "Startup bootstrap is ready to continue into login for the default request.";
  let recommendedAction = "Call startup-bootstrap during app launch and enforce the returned result before local login.";

  if (!projectActive) {
    status = "project_inactive";
    ready = false;
    message = "This project is not active, so startup-bootstrap requests are rejected until the project is re-enabled.";
    recommendedAction = "Switch the project back to active before shipping or testing the client startup flow.";
  } else if (featureConfig.allowVersionCheck !== false && versionManifest?.allowed === false) {
    status = versionManifest.status || "version_blocked";
    ready = false;
    message = versionManifest.message || "The default startup version would be rejected by the current version policy.";
    recommendedAction = versionManifest.latestDownloadUrl
      ? `Ship a compatible client build and direct users to ${versionManifest.latestDownloadUrl}.`
      : "Ship a compatible client build or relax the force-update floor before opening login.";
  } else if (featureConfig.allowNotices !== false && blockingNoticeRows.length) {
    status = "blocking_notice";
    ready = false;
    message = `${blockingNoticeRows.length} blocking notice(s) are active for the default startup channel.`;
    recommendedAction = "Archive or downgrade the blocking maintenance notice before letting users log in again.";
  } else if (versionManifest?.status === "upgrade_recommended") {
    status = "upgrade_recommended";
    message = `Startup allows login, but the current preview version should recommend upgrading to ${versionManifest.latestVersion || "the latest build"}.`;
    recommendedAction = "Show a non-blocking upgrade prompt and keep the latest download URL visible in the client shell.";
  } else if (featureConfig.allowVersionCheck === false && featureConfig.allowNotices === false) {
    status = "checks_disabled";
    message = "Version rules and startup notices are both disabled for this project, so startup bootstrap will return informational disabled manifests only.";
    recommendedAction = "Enable version rules or notices when you are ready to enforce upgrade guidance or maintenance messaging.";
  } else if (featureConfig.allowVersionCheck === false) {
    status = "version_check_disabled";
    message = "Version rules are disabled for this project, so startup bootstrap will not block outdated clients right now.";
    recommendedAction = "Enable version rules before rollout if this project should enforce minimum client versions.";
  } else if (featureConfig.allowNotices === false) {
    status = "notices_disabled";
    message = "Startup notices are disabled for this project, so users will not receive announcements or maintenance windows during launch.";
    recommendedAction = "Enable notices before rollout if this project needs startup announcements or maintenance blocking.";
  } else if (activeNoticeRows.length) {
    status = "ready_with_notices";
    message = `${activeNoticeRows.length} active notice(s) will be returned during startup for the default channel.`;
    recommendedAction = "Render the returned notices before login so users see the latest release notes or maintenance guidance.";
  }

  const expectedResponse = projectActive
    ? buildClientStartupBootstrapPayload({
        product,
        clientVersion: request.clientVersion,
        channel: request.channel,
        versionManifest,
        notices,
        activeTokenKey,
        tokenKeys: hasTokenKeys ? tokenKeys : null,
        hasTokenKeys
      })
    : null;

  return {
    request,
    featureConfig,
    clientHardening,
    runtimeChecks: {
      projectStatus: product.status,
      projectActive,
      versionCheckEnabled: featureConfig.allowVersionCheck !== false,
      noticesEnabled: featureConfig.allowNotices !== false,
      includeTokenKeys: request.includeTokenKeys,
      startupBootstrapRequired: clientHardening.startupBootstrapRequired,
      localTokenValidationRequired: clientHardening.localTokenValidationRequired,
      heartbeatGateRequired: clientHardening.heartbeatGateRequired
    },
    noticeSummary: {
      total: activeNoticeRows.length,
      blockingTotal: blockingNoticeRows.length
    },
    tokenKeySummary: {
      hasTokenKeys,
      activeKeyId: activeTokenKey?.keyId ?? tokenKeys?.activeKeyId ?? null,
      totalKeys: totalPublicKeys
    },
    decision: {
      ready,
      status,
      message,
      recommendedAction
    },
    workflow: buildIntegrationStartupWorkflow({
      projectActive,
      featureConfig,
      versionManifest,
      activeNoticeRows,
      blockingNoticeRows,
      includeTokenKeys: request.includeTokenKeys
    }),
    expectedResponse,
    expectedError: projectActive
      ? null
      : {
          status: 404,
          code: "PRODUCT_NOT_FOUND",
          message: "Product does not exist or is inactive."
        }
  };
}

async function buildDeveloperIntegrationPackagePayloadAsync({
  db,
  store,
  developer,
  actor,
  product,
  transport,
  signing,
  tokenKeys,
  examples,
  includeOwner = false,
  generatedAt = nowIso(),
  startupRequest = {}
}) {
  const startupPreview = await buildIntegrationStartupPreviewPayload(
    db,
    store,
    product,
    tokenKeys,
    startupRequest
  );
  return buildDeveloperIntegrationPackagePayload({
    developer,
    actor,
    product,
    transport,
    signing,
    tokenKeys,
    examples,
    includeOwner,
    generatedAt,
    startupPreview
  });
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
  generatedAt = nowIso(),
  startupPreview = null
}) {
  const ownerDeveloper = includeOwner
    ? buildOwnerDeveloperPayload(product?.ownerDeveloper ?? null)
    : undefined;
  const startupDefaults = startupPreview?.request || {
    productCode: product.code,
    clientVersion: "1.0.0",
    channel: "stable",
    includeTokenKeys: true
  };
  const clientHardening = startupPreview?.clientHardening
    || buildClientHardeningProfile(
      product?.featureConfig && typeof product.featureConfig === "object"
        ? product.featureConfig
        : {}
    );
  const hardeningFileName = `${product.code}-hardening-guide.txt`;
  const hardeningGuide = buildClientHardeningGuideText({
    projectCode: product.code,
    channel: startupDefaults.channel || "stable",
    clientHardening
  });
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
    clientHardening,
    startupDefaults,
    startupPreview,
    examples,
    sdkDistribution: {
      languages: ["c", "cpp"],
      preferredPackage: "rocksolid-sdk-cpp",
      preferredLinkage: "static_lib",
      requiredDefine: "RS_SDK_STATIC"
    },
    notes: [
      "Replace the demo host values with your public service domain when you deploy behind a reverse proxy or TLS.",
      "Refresh this package immediately after rotating sdkAppId or sdkAppSecret, then redeploy the client configuration.",
      `${clientHardening.title}: ${clientHardening.summary}`
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
      hostConfigFileName: "rocksolid_host_config.env",
      hostConfigEnv: buildIntegrationHostConfigTemplate(manifest),
      cmakeFileName: "CMakeLists.txt",
      cmakeConsumerTemplate: buildIntegrationCMakeConsumerTemplate(manifest),
      vs2022SolutionFileName: `${buildIntegrationConsumerProjectBaseName(manifest)}_host_consumer.sln`,
      vs2022SolutionTemplate: buildIntegrationVs2022SolutionTemplate(manifest),
      vs2022ProjectFileName: `${buildIntegrationConsumerProjectBaseName(manifest)}_host_consumer.vcxproj`,
      vs2022ProjectTemplate: buildIntegrationVs2022ProjectTemplate(manifest),
      vs2022FiltersFileName: `${buildIntegrationConsumerProjectBaseName(manifest)}_host_consumer.vcxproj.filters`,
      vs2022FiltersTemplate: buildIntegrationVs2022FiltersTemplate(manifest),
      vs2022PropsFileName: "RockSolidSDK.props",
      vs2022PropsTemplate: buildIntegrationVs2022PropsTemplate(manifest),
      vs2022LocalPropsFileName: "RockSolidSDK.local.props",
      vs2022LocalPropsTemplate: buildIntegrationVs2022LocalPropsTemplate(manifest),
      vs2022GuideFileName: `${buildIntegrationConsumerProjectBaseName(manifest)}_vs2022_quickstart.md`,
      vs2022GuideText: buildIntegrationVs2022QuickstartTemplate(manifest),
      cppFileName: `${product.code}.cpp`,
      cppQuickstart: buildIntegrationCppQuickstart(manifest),
      hostSkeletonFileName: `${product.code}-host-skeleton.cpp`,
      hostSkeletonCpp: buildIntegrationCppHostSkeleton(manifest),
      hardeningFileName,
      hardeningGuide
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

function buildIntegrationPackageHostConfigFiles(items = []) {
  return items.map((item) => ({
    fileName: `${item.code}-rocksolid_host_config.env`,
    content: item.snippets?.hostConfigEnv || ""
  }));
}

function buildIntegrationPackageCMakeFiles(items = []) {
  return items.map((item) => ({
    fileName: `${item.code}/CMakeLists.txt`,
    content: item.snippets?.cmakeConsumerTemplate || ""
  }));
}

function buildIntegrationPackageVs2022SolutionFiles(items = []) {
  return items.map((item) => ({
    fileName: `${item.code}/${item.snippets?.vs2022SolutionFileName || "rocksolid_host_consumer.sln"}`,
    content: item.snippets?.vs2022SolutionTemplate || ""
  }));
}

function buildIntegrationPackageVs2022Files(items = []) {
  return items.map((item) => ({
    fileName: `${item.code}/${item.snippets?.vs2022ProjectFileName || "rocksolid_host_consumer.vcxproj"}`,
    content: item.snippets?.vs2022ProjectTemplate || ""
  }));
}

function buildIntegrationPackageVs2022FiltersFiles(items = []) {
  return items.map((item) => ({
    fileName: `${item.code}/${item.snippets?.vs2022FiltersFileName || "rocksolid_host_consumer.vcxproj.filters"}`,
    content: item.snippets?.vs2022FiltersTemplate || ""
  }));
}

function buildIntegrationPackageVs2022PropsFiles(items = []) {
  return items.map((item) => ({
    fileName: `${item.code}/${item.snippets?.vs2022PropsFileName || "RockSolidSDK.props"}`,
    content: item.snippets?.vs2022PropsTemplate || ""
  }));
}

function buildIntegrationPackageVs2022LocalPropsFiles(items = []) {
  return items.map((item) => ({
    fileName: `${item.code}/${item.snippets?.vs2022LocalPropsFileName || "RockSolidSDK.local.props"}`,
    content: item.snippets?.vs2022LocalPropsTemplate || ""
  }));
}

function buildIntegrationPackageVs2022GuideFiles(items = []) {
  return items.map((item) => ({
    fileName: `${item.code}/${item.snippets?.vs2022GuideFileName || "rocksolid_vs2022_quickstart.md"}`,
    content: item.snippets?.vs2022GuideText || ""
  }));
}

function buildIntegrationPackageCppFiles(items = []) {
  return items.map((item) => ({
    fileName: `${item.code}.cpp`,
    content: item.snippets?.cppQuickstart || ""
  }));
}

function buildIntegrationPackageHostSkeletonFiles(items = []) {
  return items.map((item) => ({
    fileName: item.snippets?.hostSkeletonFileName || `${item.code}-host-skeleton.cpp`,
    content: item.snippets?.hostSkeletonCpp || ""
  }));
}

function buildIntegrationPackageHardeningFiles(items = []) {
  return items.map((item) => ({
    fileName: item.snippets?.hardeningFileName || `${item.code}-hardening-guide.txt`,
    content: item.snippets?.hardeningGuide || ""
  }));
}

function buildProductIntegrationPackageExportBundle(items = [], options = {}) {
  const generatedAt = options.generatedAt ?? nowIso();
  const timestampTag = buildExportTimestampTag(generatedAt);
  const manifestFiles = buildIntegrationPackageManifestFiles(items);
  const envFiles = buildIntegrationPackageEnvFiles(items);
  const hostConfigFiles = buildIntegrationPackageHostConfigFiles(items);
  const cmakeFiles = buildIntegrationPackageCMakeFiles(items);
  const vs2022SolutionFiles = buildIntegrationPackageVs2022SolutionFiles(items);
  const vs2022Files = buildIntegrationPackageVs2022Files(items);
  const vs2022FiltersFiles = buildIntegrationPackageVs2022FiltersFiles(items);
  const vs2022PropsFiles = buildIntegrationPackageVs2022PropsFiles(items);
  const vs2022LocalPropsFiles = buildIntegrationPackageVs2022LocalPropsFiles(items);
  const vs2022GuideFiles = buildIntegrationPackageVs2022GuideFiles(items);
  const cppFiles = buildIntegrationPackageCppFiles(items);
  const hostSkeletonFiles = buildIntegrationPackageHostSkeletonFiles(items);
  const hardeningFiles = buildIntegrationPackageHardeningFiles(items);

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
    hostConfigArchiveName: `rocksolid-integration-packages-${timestampTag}-host-config.txt`,
    cmakeArchiveName: `rocksolid-integration-packages-${timestampTag}-cmake.txt`,
    vs2022SolutionArchiveName: `rocksolid-integration-packages-${timestampTag}-vs2022-sln.txt`,
    vs2022ArchiveName: `rocksolid-integration-packages-${timestampTag}-vs2022.txt`,
    vs2022FiltersArchiveName: `rocksolid-integration-packages-${timestampTag}-vs2022-filters.txt`,
    vs2022PropsArchiveName: `rocksolid-integration-packages-${timestampTag}-vs2022-props.txt`,
    vs2022LocalPropsArchiveName: `rocksolid-integration-packages-${timestampTag}-vs2022-local-props.txt`,
    vs2022GuideArchiveName: `rocksolid-integration-packages-${timestampTag}-vs2022-guide.txt`,
    cppArchiveName: `rocksolid-integration-packages-${timestampTag}-cpp.txt`,
    hostSkeletonArchiveName: `rocksolid-integration-packages-${timestampTag}-host-skeleton.txt`,
    hardeningArchiveName: `rocksolid-integration-packages-${timestampTag}-hardening.txt`,
    items,
    manifestFiles,
    envFiles,
    hostConfigFiles,
    cmakeFiles,
    vs2022SolutionFiles,
    vs2022Files,
    vs2022FiltersFiles,
    vs2022PropsFiles,
    vs2022LocalPropsFiles,
    vs2022GuideFiles,
    cppFiles,
    hostSkeletonFiles,
    hardeningFiles,
    manifestBundleText: buildNamedFileBundleText(manifestFiles),
    envBundleText: buildNamedFileBundleText(envFiles),
    hostConfigBundleText: buildNamedFileBundleText(hostConfigFiles),
    cmakeBundleText: buildNamedFileBundleText(cmakeFiles),
    vs2022SolutionBundleText: buildNamedFileBundleText(vs2022SolutionFiles),
    vs2022BundleText: buildNamedFileBundleText(vs2022Files),
    vs2022FiltersBundleText: buildNamedFileBundleText(vs2022FiltersFiles),
    vs2022PropsBundleText: buildNamedFileBundleText(vs2022PropsFiles),
    vs2022LocalPropsBundleText: buildNamedFileBundleText(vs2022LocalPropsFiles),
    vs2022GuideBundleText: buildNamedFileBundleText(vs2022GuideFiles),
    cppBundleText: buildNamedFileBundleText(cppFiles),
    hostSkeletonBundleText: buildNamedFileBundleText(hostSkeletonFiles),
    hardeningBundleText: buildNamedFileBundleText(hardeningFiles)
  };
}

function buildReleasePackageSummaryText(manifest = {}) {
  const project = manifest.project || {};
  const release = manifest.release || {};
  const deliverySummary = release.deliverySummary || {};
  const deliveryChecklist = release.deliveryChecklist || {};
  const mainlineFollowUp = release.mainlineFollowUp || {};
  const versionManifest = release.versionManifest || {};
  const activeNotices = release.activeNotices || {};
  const readiness = release.readiness || {};
  const clientHardening = release.startupPreview?.clientHardening || manifest.integration?.clientHardening || {};
  const noticeItems = Array.isArray(activeNotices.items) ? activeNotices.items : [];
  const formatWorkspaceActionParams = (params = null) => {
    const entries = params && typeof params === "object"
      ? Object.entries(params).filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "")
      : [];
    return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(",") : "";
  };
  const formatWorkspaceActionText = (action = null) => {
    if (!action || typeof action !== "object") {
      return "-";
    }
    const paramsText = formatWorkspaceActionParams(action.params);
    return `${action.label || action.key || "workspace"} | focus=${action.autofocus || "-"}${paramsText ? ` | filters=${paramsText}` : ""}`;
  };
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
    `Client Hardening: ${String(clientHardening.profile || "-").toUpperCase()}`,
    `Release Readiness: ${String(readiness.status || "unknown").toUpperCase()}`,
    `Release Message: ${readiness.message || "-"}`,
    ""
  ];

  lines.push("Delivery Summary:");
  lines.push(`- Headline: ${deliverySummary.headline || "-"}`);
  lines.push(`- Candidate Version: ${deliverySummary.candidateVersion || "-"}`);
  lines.push(`- Startup Status: ${deliverySummary.startupStatus || "-"}`);
  lines.push(`- Active Key ID: ${deliverySummary.activeKeyId || "-"}`);
  lines.push(`- Client Hardening: ${String(deliverySummary.clientHardeningProfile || clientHardening.profile || "-").toUpperCase()}`);
  lines.push(`- Blocking Notices: ${deliverySummary.blockingNotices ?? 0}`);
  lines.push(`- Summary: ${deliverySummary.summary || "-"}`);
  if (deliverySummary.clientHardeningSummary) {
    lines.push(`- Hardening Summary: ${deliverySummary.clientHardeningSummary}`);
  }
  if (deliverySummary.artifacts) {
    lines.push(`- Artifacts: json=${deliverySummary.artifacts.packageJson || "-"} | summary=${deliverySummary.artifacts.packageSummary || "-"} | env=${deliverySummary.artifacts.envTemplate || "-"} | hostConfig=${deliverySummary.artifacts.hostConfig || "-"} | cmake=${deliverySummary.artifacts.cmakeConsumer || "-"} | vs2022Guide=${deliverySummary.artifacts.vs2022Guide || "-"} | vs2022Sln=${deliverySummary.artifacts.vs2022Solution || "-"} | vs2022=${deliverySummary.artifacts.vs2022Consumer || "-"} | vs2022Filters=${deliverySummary.artifacts.vs2022Filters || "-"} | vs2022Props=${deliverySummary.artifacts.vs2022Props || "-"} | vs2022LocalProps=${deliverySummary.artifacts.vs2022LocalProps || "-"} | cpp=${deliverySummary.artifacts.cppQuickstart || "-"} | hostSkeleton=${deliverySummary.artifacts.hostSkeleton || "-"}`);
  }
  lines.push("");

  const checklistItems = Array.isArray(deliveryChecklist.items) ? deliveryChecklist.items : [];
  if (checklistItems.length) {
    lines.push("Delivery Checklist:");
    lines.push(`- Status: ${String(deliveryChecklist.status || "unknown").toUpperCase()} | pass=${deliveryChecklist.passItems ?? 0} | review=${deliveryChecklist.reviewItems ?? 0} | block=${deliveryChecklist.blockItems ?? 0}`);
    for (const item of checklistItems) {
      lines.push(`- [${String(item.status || "unknown").toUpperCase()}] ${item.label || item.key || "item"} | ${item.summary || "-"} | artifact=${item.artifact || "-"} | next=${item.nextAction || "-"}`);
    }
    lines.push("");
  }

  const readinessChecks = Array.isArray(readiness.checks) ? readiness.checks : [];
  if (readinessChecks.length) {
    lines.push("Release Checks:");
    for (const item of readinessChecks) {
      lines.push(
        `- [${String(item.level || "info").toUpperCase()}] ${item.label || item.key || "check"}: ${item.summary || "-"}`
      );
    }
    lines.push("");
  }

  const nextActions = Array.isArray(readiness.nextActions) ? readiness.nextActions : [];
  if (nextActions.length) {
    lines.push("Recommended Next Actions:");
    for (const item of nextActions) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  if (mainlineFollowUp.title || mainlineFollowUp.message) {
    lines.push("Release Mainline Follow-up:");
    lines.push(`- Status: ${String(mainlineFollowUp.status || "unknown").toUpperCase()}`);
    lines.push(`- Title: ${mainlineFollowUp.title || "-"}`);
    lines.push(`- Message: ${mainlineFollowUp.message || "-"}`);
    if (mainlineFollowUp.recommendedWorkspace) {
      lines.push(`- Recommended Workspace: ${formatWorkspaceActionText(mainlineFollowUp.recommendedWorkspace)}`);
    }
    if (Array.isArray(mainlineFollowUp.workspaceActions) && mainlineFollowUp.workspaceActions.length) {
      lines.push("- Workspace Path:");
      for (const item of mainlineFollowUp.workspaceActions) {
        lines.push(`  - ${formatWorkspaceActionText(item)}`);
      }
    }
    if (Array.isArray(mainlineFollowUp.actionPlan) && mainlineFollowUp.actionPlan.length) {
      lines.push("- Action Plan:");
      for (const item of mainlineFollowUp.actionPlan) {
        lines.push(
          `  - ${item.title || item.key || "step"} | ${String(item.priority || "secondary").toUpperCase()} | ${String(item.status || "review").toUpperCase()} | ${item.summary || "-"}`
          + `${item.workspaceAction ? ` | workspace=${formatWorkspaceActionText(item.workspaceAction)}` : ""}`
          + `${item.recommendedDownload ? ` | download=${item.recommendedDownload.fileName || item.recommendedDownload.label || "-"}` : ""}`
          + `${item.bootstrapAction ? ` | bootstrap=${item.bootstrapAction.label || item.bootstrapAction.key || "-"}` : ""}`
          + `${item.setupAction ? ` | setup=${item.setupAction.label || item.setupAction.key || "-"}@${item.setupAction.mode || "recommended"}:${item.setupAction.operation || "first_batch_setup"}` : ""}`
        );
      }
    }
    if (Array.isArray(mainlineFollowUp.recommendedDownloads) && mainlineFollowUp.recommendedDownloads.length) {
      lines.push("- Recommended Downloads:");
      for (const item of mainlineFollowUp.recommendedDownloads) {
        lines.push(`  - ${item.label || item.key || "download"} | ${item.fileName || "-"}`);
      }
    }
    lines.push("");
  }

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

function buildReleasePackageChecklistText(payload = {}) {
  const manifest = payload.manifest || {};
  const project = manifest.project || {};
  const release = manifest.release || {};
  const readiness = release.readiness || {};
  const deliverySummary = payload.deliverySummary || release.deliverySummary || {};
  const deliveryChecklist = payload.deliveryChecklist || release.deliveryChecklist || {};
  const checklistItems = Array.isArray(deliveryChecklist.items) ? deliveryChecklist.items : [];
  const lines = [
    "RockSolid Release Delivery Checklist",
    `Generated At: ${manifest.generatedAt || ""}`,
    `Project Code: ${project.code || ""}`,
    `Project Name: ${project.name || ""}`,
    `Channel: ${release.channel || "stable"}`,
    `Status: ${String(deliveryChecklist.status || "unknown").toUpperCase()} | pass=${deliveryChecklist.passItems ?? 0} | review=${deliveryChecklist.reviewItems ?? 0} | block=${deliveryChecklist.blockItems ?? 0}`,
    `Readiness: ${String(readiness.status || "unknown").toUpperCase()} | ${readiness.message || "-"}`,
    `Delivery Summary: ${deliverySummary.summary || "-"}`,
    ""
  ];
  lines.push("Checklist Items:");
  if (checklistItems.length) {
    for (const item of checklistItems) {
      lines.push(
        `- [${String(item.status || "unknown").toUpperCase()}] ${item.label || item.key || "item"} | ${item.summary || "-"}`
        + `${item.artifact ? ` | artifact=${item.artifact}` : ""}`
        + `${item.nextAction ? ` | next=${item.nextAction}` : ""}`
      );
    }
  } else {
    lines.push("- No delivery checklist items are available yet.");
  }
  return lines.join("\n");
}

function buildReleaseDeliveryChecklistPayload({
  product,
  channel = "stable",
  versionManifest,
  activeNotices = [],
  readiness = {},
  deliverySummary = {},
  releaseStartupPreview = null
}) {
  const activeKeyId = deliverySummary.activeKeyId || null;
  const activeItems = Array.isArray(activeNotices) ? activeNotices : [];
  const blockingNotices = activeItems.filter((item) => item.blockLogin);
  const startupDecision = releaseStartupPreview?.decision || {};
  const tokenKeySummary = releaseStartupPreview?.tokenKeySummary || {};
  const clientHardening = releaseStartupPreview?.clientHardening
    || buildClientHardeningProfile(
      product?.featureConfig && typeof product.featureConfig === "object"
        ? product.featureConfig
        : {}
    );
  const items = [];

  items.push({
    key: "project_status",
    label: "Project active",
    status: (product?.status ?? "active") === "active" ? "pass" : "block",
    summary: (product?.status ?? "active") === "active"
      ? "Project runtime status is active."
      : `Project is ${product?.status || "inactive"} and runtime traffic would be rejected.`,
    artifact: null,
    nextAction: (product?.status ?? "active") === "active"
      ? null
      : "Switch the project back to active before handing this build to users."
  });

  items.push({
    key: "startup_bootstrap",
    label: "Startup bootstrap",
    status: startupDecision.ready === false
      ? "block"
      : startupDecision.status === "upgrade_recommended"
        ? "review"
        : "pass",
    summary: startupDecision.message || "Startup bootstrap preview is available for the current channel.",
    artifact: "POST /api/client/startup-bootstrap",
    nextAction: startupDecision.recommendedAction || null
  });

  items.push({
    key: "version_manifest",
    label: "Version manifest",
    status: versionManifest?.latestVersion ? "pass" : "review",
    summary: versionManifest?.latestVersion
      ? `Latest published version is ${versionManifest.latestVersion}.`
      : "No active version rule is published for this release channel.",
    artifact: "manifest.release.versionManifest",
    nextAction: versionManifest?.latestVersion
      ? null
      : "Publish or activate a version rule so this release names a concrete client build."
  });

  items.push({
    key: "download_url",
    label: "Download URL",
    status: !versionManifest?.latestVersion || versionManifest?.latestDownloadUrl ? "pass" : "review",
    summary: !versionManifest?.latestVersion
      ? "No active version rule means no download URL is required yet."
      : versionManifest?.latestDownloadUrl
        ? `Latest version points to ${versionManifest.latestDownloadUrl}.`
        : "Latest active version has no download URL.",
    artifact: "manifest.release.versionManifest.latestDownloadUrl",
    nextAction: !versionManifest?.latestVersion || versionManifest?.latestDownloadUrl
      ? null
      : "Attach a download URL to the active client version before rollout."
  });

  items.push({
    key: "notices",
    label: "Runtime notices",
    status: blockingNotices.length ? "block" : activeItems.length ? "review" : "pass",
    summary: blockingNotices.length
      ? `${blockingNotices.length} blocking notice(s) would stop login during rollout.`
      : activeItems.length
        ? `${activeItems.length} active notice(s) will be shown at startup.`
        : "No active startup notices are configured for this channel.",
    artifact: "manifest.release.activeNotices",
    nextAction: blockingNotices.length
      ? "Archive or downgrade the blocking maintenance notice before release."
      : activeItems.length
        ? "Confirm the active announcement text and schedule before handoff."
        : null
  });

  items.push({
    key: "token_keys",
    label: "Token verification keys",
    status: (tokenKeySummary.totalKeys ?? 0) > 0 && activeKeyId ? "pass" : "review",
    summary: (tokenKeySummary.totalKeys ?? 0) > 0 && activeKeyId
      ? `${tokenKeySummary.totalKeys} public key(s) are available and active key ${activeKeyId} is selected.`
      : "Startup preview did not resolve a usable active public key.",
    artifact: activeKeyId || "manifest.integration.tokenKeys",
    nextAction: (tokenKeySummary.totalKeys ?? 0) > 0 && activeKeyId
      ? null
      : "Make sure the client requests token keys during startup if it validates license tokens locally."
  });

  items.push({
    key: "client_hardening",
    label: "Client hardening profile",
    status: clientHardening.profile === "strict" ? "pass" : "review",
    summary: clientHardening.summary,
    artifact: "manifest.integration.clientHardening",
    nextAction: clientHardening.profile === "strict" ? null : clientHardening.nextAction
  });

  items.push({
    key: "handoff_artifacts",
    label: "Handoff artifacts",
    status: "pass",
    summary: "JSON package, summary text, env template, host config, CMake consumer template, VS2022 quickstart, VS2022 solution, VS2022 project template, VS2022 filters, VS2022 props sheet, VS2022 local props sheet, C++ quickstart, and host skeleton are bundled for handoff.",
    artifact: `${deliverySummary.artifacts?.packageJson || "-"} | ${deliverySummary.artifacts?.packageSummary || "-"} | ${deliverySummary.artifacts?.envTemplate || "-"} | ${deliverySummary.artifacts?.hostConfig || "-"} | ${deliverySummary.artifacts?.cmakeConsumer || "-"} | ${deliverySummary.artifacts?.vs2022Guide || "-"} | ${deliverySummary.artifacts?.vs2022Solution || "-"} | ${deliverySummary.artifacts?.vs2022Consumer || "-"} | ${deliverySummary.artifacts?.vs2022Filters || "-"} | ${deliverySummary.artifacts?.vs2022Props || "-"} | ${deliverySummary.artifacts?.vs2022LocalProps || "-"} | ${deliverySummary.artifacts?.cppQuickstart || "-"} | ${deliverySummary.artifacts?.hostSkeleton || "-"}`,
    nextAction: "Send the matching JSON, summary, env, host config, CMake template, VS2022 quickstart, VS2022 solution, VS2022 project template, VS2022 filters, VS2022 props sheet, VS2022 local props sheet, quickstart, and host skeleton snippets together so integration stays aligned."
  });

  const blockItems = items.filter((item) => item.status === "block").length;
  const reviewItems = items.filter((item) => item.status === "review").length;
  const passItems = items.filter((item) => item.status === "pass").length;

  return {
    status: blockItems ? "hold" : reviewItems ? "attention" : "ready",
    passItems,
    reviewItems,
    blockItems,
    total: items.length,
    items
  };
}

function buildReleaseDeliverySummaryPayload({
  product,
  channel = "stable",
  versionManifest,
  activeNotices = [],
  readiness = {},
  integrationPackage = null,
  releaseStartupPreview = null,
  fileName,
  summaryFileName,
  envFileName,
  hostConfigFileName,
  cmakeFileName,
  vs2022GuideFileName,
  vs2022SolutionFileName,
  vs2022ProjectFileName,
  vs2022FiltersFileName,
  vs2022PropsFileName,
  vs2022LocalPropsFileName,
  cppFileName,
  hostSkeletonFileName
}) {
  const latestVersion = versionManifest?.latestVersion || null;
  const candidateVersion = readiness?.candidateVersion || latestVersion || null;
  const activeKeyId = integrationPackage?.manifest?.signing?.activeKeyId
    || releaseStartupPreview?.tokenKeySummary?.activeKeyId
    || null;
  const clientHardening = releaseStartupPreview?.clientHardening
    || integrationPackage?.manifest?.clientHardening
    || buildClientHardeningProfile(
      product?.featureConfig && typeof product.featureConfig === "object"
        ? product.featureConfig
        : {}
    );
  const blockingNotices = activeNotices.filter((item) => item.blockLogin);
  const startupStatus = releaseStartupPreview?.decision?.status || "unknown";
  const startupMessage = releaseStartupPreview?.decision?.message || null;
  let headline = `${product.code} ${channel} release summary`;
  let summary = `Candidate version ${candidateVersion || "-"} is packaged for the ${channel} channel.`;

  if (readiness?.status === "hold") {
    headline = `${product.code} ${channel} should stay on hold`;
    summary = `${blockingNotices.length || readiness.blockingChecks || 0} blocking item(s) should be resolved before rollout.`;
  } else if (readiness?.status === "attention") {
    headline = `${product.code} ${channel} can ship with attention`;
    summary = `${readiness.attentionChecks || 0} non-blocking item(s) still deserve review before handoff.`;
  } else if (readiness?.status === "ready") {
    headline = `${product.code} ${channel} looks ready to ship`;
    summary = `The release package looks ready for handoff with candidate version ${candidateVersion || "-"}.`;
  }

  return {
    headline,
    status: readiness?.status || "unknown",
    summary,
    projectCode: product.code,
    channel,
    candidateVersion,
    latestVersion,
    minimumAllowedVersion: versionManifest?.minimumAllowedVersion || null,
    latestDownloadUrl: versionManifest?.latestDownloadUrl || null,
    startupStatus,
    startupMessage,
    activeKeyId,
    clientHardeningProfile: clientHardening.profile,
    clientHardeningSummary: clientHardening.summary,
    activeNotices: activeNotices.length,
    blockingNotices: blockingNotices.length,
    artifacts: {
      packageJson: fileName || "release-package.json",
      packageSummary: summaryFileName || "release-package.txt",
      envTemplate: `snippets/${envFileName || "project.env"}`,
      hostConfig: `host-config/${hostConfigFileName || "rocksolid_host_config.env"}`,
      cmakeConsumer: `cmake-consumer/${cmakeFileName || "CMakeLists.txt"}`,
      vs2022Guide: `vs2022-consumer/${vs2022GuideFileName || "rocksolid_vs2022_quickstart.md"}`,
      vs2022Solution: `vs2022-consumer/${vs2022SolutionFileName || "rocksolid_host_consumer.sln"}`,
      vs2022Consumer: `vs2022-consumer/${vs2022ProjectFileName || "rocksolid_host_consumer.vcxproj"}`,
      vs2022Filters: `vs2022-consumer/${vs2022FiltersFileName || "rocksolid_host_consumer.vcxproj.filters"}`,
      vs2022Props: `vs2022-consumer/${vs2022PropsFileName || "RockSolidSDK.props"}`,
      vs2022LocalProps: `vs2022-consumer/${vs2022LocalPropsFileName || "RockSolidSDK.local.props"}`,
      cppQuickstart: `snippets/${cppFileName || "project.cpp"}`,
      hostSkeleton: `snippets/${hostSkeletonFileName || "project-host-skeleton.cpp"}`
    },
    handoffChecks: Array.isArray(readiness?.checks)
      ? readiness.checks.map((item) => ({
          key: item.key,
          label: item.label,
          level: item.level,
          summary: item.summary
        }))
      : [],
    nextActions: Array.isArray(readiness?.nextActions) ? readiness.nextActions : []
  };
}

function buildReleaseReadinessPayload({
  product,
  versionManifest,
  activeNotices = [],
  releaseStartupPreview = null
}) {
  const featureConfig = snapshotManagedProductFeatureConfig(
    product?.featureConfig && typeof product.featureConfig === "object"
      ? product.featureConfig
      : {}
  );
  const clientHardening = releaseStartupPreview?.clientHardening || buildClientHardeningProfile(featureConfig);
  const latestVersion = versionManifest?.latestVersion || null;
  const latestDownloadUrl = versionManifest?.latestDownloadUrl || null;
  const blockingNotices = activeNotices.filter((item) => item.blockLogin);
  const startupDecision = releaseStartupPreview?.decision || {};
  const tokenKeySummary = releaseStartupPreview?.tokenKeySummary || {};
  const checks = [];

  checks.push({
    key: "project_status",
    label: "Project status",
    level: (product?.status ?? "active") === "active" ? "ok" : "blocking",
    blocking: (product?.status ?? "active") !== "active",
    summary: (product?.status ?? "active") === "active"
      ? "Project is active and can serve runtime traffic."
      : `Project is ${product?.status || "inactive"} and will reject runtime validation requests.`,
    nextAction: (product?.status ?? "active") === "active"
      ? null
      : "Switch the project back to active before shipping this release."
  });

  checks.push({
    key: "version_rule",
    label: "Version rule",
    level: latestVersion ? "ok" : "attention",
    blocking: false,
    summary: latestVersion
      ? `Latest published client version is ${latestVersion}.`
      : "No active version rule is published for the selected channel.",
    nextAction: latestVersion
      ? null
      : "Publish or activate a client version rule so the release package names an expected build."
  });

  checks.push({
    key: "download_url",
    label: "Download URL",
    level: !latestVersion || latestDownloadUrl ? "ok" : "attention",
    blocking: false,
    summary: !latestVersion
      ? "No download URL requirement because no active version rule is published yet."
      : latestDownloadUrl
        ? `Latest build points to ${latestDownloadUrl}.`
        : "The latest active version does not expose a download URL.",
    nextAction: !latestVersion || latestDownloadUrl
      ? null
      : "Attach a download URL to the active client version so upgrade prompts can route users correctly."
  });

  checks.push({
    key: "startup_gate",
    label: "Startup gate",
    level: startupDecision.ready === false ? "blocking" : "ok",
    blocking: startupDecision.ready === false,
    summary: startupDecision.message
      || (
        startupDecision.ready === false
          ? "The release candidate would still be blocked during startup."
          : "The release candidate can complete startup checks."
      ),
    nextAction: startupDecision.ready === false
      ? (startupDecision.recommendedAction || "Resolve the blocking startup condition before release handoff.")
      : null
  });

  checks.push({
    key: "notices",
    label: "Runtime notices",
    level: blockingNotices.length ? "blocking" : activeNotices.length ? "attention" : "ok",
    blocking: blockingNotices.length > 0,
    summary: blockingNotices.length
      ? `${blockingNotices.length} active blocking notice(s) would stop login for the selected channel.`
      : activeNotices.length
        ? `${activeNotices.length} active notice(s) will be shown at startup for the selected channel.`
        : "No active startup notices are configured for the selected channel.",
    nextAction: blockingNotices.length
      ? "Archive or downgrade the blocking maintenance notice before opening the release to users."
      : activeNotices.length
        ? "Double-check the notice copy and timing so the startup message matches the rollout plan."
        : null
  });

  checks.push({
    key: "runtime_coverage",
    label: "Runtime safeguards",
    level: featureConfig.allowVersionCheck === false || featureConfig.allowNotices === false
      ? "attention"
      : "ok",
    blocking: false,
    summary: featureConfig.allowVersionCheck === false && featureConfig.allowNotices === false
      ? "Version checks and startup notices are both disabled for this project."
      : featureConfig.allowVersionCheck === false
        ? "Version checks are disabled for this project."
        : featureConfig.allowNotices === false
          ? "Startup notices are disabled for this project."
          : "Version checks and startup notices are both enabled for this project.",
    nextAction: featureConfig.allowVersionCheck === false || featureConfig.allowNotices === false
      ? "Review project feature toggles if this release should enforce upgrade guidance or show startup notices."
      : null
  });

  checks.push({
    key: "client_hardening",
    label: "Client hardening",
    level: clientHardening.profile === "strict" ? "ok" : "attention",
    blocking: false,
    summary: clientHardening.summary,
    nextAction: clientHardening.profile === "strict" ? null : clientHardening.nextAction
  });

  checks.push({
    key: "token_keys",
    label: "Token verification keys",
    level: (tokenKeySummary.totalKeys ?? 0) > 0 ? "ok" : "attention",
    blocking: false,
    summary: (tokenKeySummary.totalKeys ?? 0) > 0
      ? `${tokenKeySummary.totalKeys} public token key(s) are available for local licenseToken verification.`
      : "No public token keys were included in the startup preview.",
    nextAction: (tokenKeySummary.totalKeys ?? 0) > 0
      ? null
      : "Make sure the client requests token keys during startup if it also verifies license tokens locally."
  });

  const blockingChecks = checks.filter((item) => item.blocking);
  const attentionChecks = checks.filter((item) => item.level === "attention");
  let status = "ready";
  let ready = true;
  let title = "Ready to ship";
  let message = "The selected project looks ready for release handoff and runtime rollout.";

  if (blockingChecks.length) {
    status = "hold";
    ready = false;
    title = "Hold release";
    message = `${blockingChecks.length} blocking check(s) should be resolved before this release goes live.`;
  } else if (attentionChecks.length) {
    status = "attention";
    title = "Ship with attention";
    message = `${attentionChecks.length} non-blocking check(s) still deserve review before final handoff.`;
  }

  const nextActions = checks
    .map((item) => item.nextAction)
    .filter((item, index, list) => item && list.indexOf(item) === index);

  return {
    ready,
    status,
    title,
    message,
    blockingChecks: blockingChecks.length,
    attentionChecks: attentionChecks.length,
    candidateVersion: releaseStartupPreview?.request?.clientVersion || latestVersion || null,
    checks,
    nextActions
  };
}

function buildReleaseMainlineFollowUpPayload({
  product,
  channel = "stable",
  readiness = {},
  deliverySummary = {},
  deliveryChecklist = {},
  authReadiness = {},
  releaseStartupPreview = null,
  fileName = "release-package.json",
  summaryFileName = "release-package.txt",
  checklistFileName = "release-package-checklist.txt"
}) {
  const params = {
    productCode: product?.code || null,
    channel
  };
  const checks = Array.isArray(readiness.checks) ? readiness.checks : [];
  const findCheck = (key) => checks.find((item) => item?.key === key) || null;
  const projectStatusCheck = findCheck("project_status");
  const versionRuleCheck = findCheck("version_rule");
  const downloadUrlCheck = findCheck("download_url");
  const startupGateCheck = findCheck("startup_gate");
  const noticeCheck = findCheck("notices");
  const runtimeCoverageCheck = findCheck("runtime_coverage");
  const clientHardeningCheck = findCheck("client_hardening");
  const tokenKeysCheck = findCheck("token_keys");
  const startupDecision = releaseStartupPreview?.decision || {};
  const releaseAutofocus = pickLaunchWorkflowReleaseAutofocus(readiness);
  const releaseSummaryDownload = createReleasePackageDownloadShortcut({
    key: "release_summary",
    fileName: summaryFileName,
    label: "Release package summary",
    format: "summary",
    params
  });
  const releaseChecklistDownload = createReleasePackageDownloadShortcut({
    key: "release_checklist",
    fileName: checklistFileName,
    label: "Release delivery checklist",
    format: "checklist",
    params
  });
  const releaseZipDownload = createReleasePackageDownloadShortcut({
    key: "release_zip",
    fileName: `${buildArchiveRootName(fileName, "release-package")}.zip`,
    label: "Release package zip",
    format: "zip",
    params
  });
  const launchSummaryDownload = createLaunchWorkflowDownloadShortcut(
    "launch_summary",
    "launch-workflow.txt",
    "Launch workflow summary",
    {
      source: "developer-launch-workflow",
      format: "summary",
      params: { ...params }
    }
  );
  const launchReviewDownload = createLaunchWorkflowReviewDownloadShortcut(
    "Launch review summary",
    "launch-review.txt",
    "summary",
    params
  );
  const launchSmokeKitDownload = createLaunchWorkflowSmokeKitDownloadShortcut(
    "Launch smoke kit summary",
    "launch-smoke-kit.txt",
    "summary",
    params
  );
  const workspaceActions = [];
  const seenWorkspaceActions = new Set();
  const pushWorkspaceAction = (action, reason = "") => {
    if (!action || typeof action !== "object") {
      return;
    }
    const dedupeKey = `${action.key || "workspace"}|${action.autofocus || ""}|${JSON.stringify(action.params || {})}`;
    if (seenWorkspaceActions.has(dedupeKey)) {
      return;
    }
    seenWorkspaceActions.add(dedupeKey);
    workspaceActions.push({
      ...action,
      reason: action.reason || reason || ""
    });
  };
  const actionPlan = [];
  const pushActionPlan = ({
    key = "",
    title = "",
    summary = "",
    status = "review",
    priority = "secondary",
    workspaceAction = null,
    recommendedDownload = null,
    bootstrapAction = null,
    setupAction = null
  } = {}) => {
    if (!key) {
      return;
    }
    actionPlan.push({
      key,
      title,
      summary,
      status,
      priority,
      workspaceAction,
      recommendedDownload,
      bootstrapAction,
      setupAction
    });
  };

  const projectBlocked = projectStatusCheck?.blocking === true;
  const startupBlocked = startupDecision.ready === false || startupGateCheck?.blocking === true;
  const blockingNotice = noticeCheck?.blocking === true;
  const versionNeedsAttention = ["attention", "blocking"].includes(String(versionRuleCheck?.level || "").toLowerCase());
  const downloadNeedsAttention = ["attention", "blocking"].includes(String(downloadUrlCheck?.level || "").toLowerCase());
  const noticeNeedsAttention = String(noticeCheck?.level || "").toLowerCase() === "attention";
  const releaseNeedsAttention = versionNeedsAttention || downloadNeedsAttention || noticeNeedsAttention;
  const integrationNeedsAttention = startupBlocked
    || String(runtimeCoverageCheck?.level || "").toLowerCase() === "attention"
    || String(clientHardeningCheck?.level || "").toLowerCase() === "attention"
    || String(tokenKeysCheck?.level || "").toLowerCase() === "attention";
  const authorizationNeedsAttention = authReadiness.status === "block" || authReadiness.status === "review";
  const normalizedStatus = String(readiness.status || deliveryChecklist.status || "unknown").toLowerCase() || "unknown";
  const authorizationWorkspaceAction = authorizationNeedsAttention
    ? createLaunchWorkflowWorkspaceShortcut(
        authReadiness.workspaceKey || "licenses",
        authReadiness.workspaceAutofocus || "policy-control",
        authReadiness.workspaceLabel
          || ((authReadiness.workspaceKey || "licenses") === "project" ? "Open Project Workspace" : "Open License Workspace")
      )
    : null;

  let recommendedWorkspace = null;
  if (projectBlocked) {
    recommendedWorkspace = createLaunchWorkflowWorkspaceShortcut(
      "project",
      "detail",
      "Open Project Workspace"
    );
  } else if (startupBlocked) {
    recommendedWorkspace = createLaunchWorkflowWorkspaceShortcut(
      "integration",
      "startup",
      "Open Integration Workspace"
    );
  } else if (blockingNotice || normalizedStatus === "hold") {
    recommendedWorkspace = createLaunchWorkflowWorkspaceShortcut(
      "release",
      releaseAutofocus,
      "Open Release Workspace"
    );
  } else if (integrationNeedsAttention) {
    recommendedWorkspace = createLaunchWorkflowWorkspaceShortcut(
      "integration",
      "startup",
      "Open Integration Workspace"
    );
  } else if (releaseNeedsAttention) {
    recommendedWorkspace = createLaunchWorkflowWorkspaceShortcut(
      "release",
      releaseAutofocus,
      "Open Release Workspace"
    );
  } else if (String(readiness.status || "").toLowerCase() === "attention") {
    recommendedWorkspace = createLaunchWorkflowWorkspaceShortcut(
      "launch",
      "handoff",
      "Open Launch Workflow"
    );
  } else {
    recommendedWorkspace = createLaunchWorkflowWorkspaceShortcut(
      "launch-review",
      "summary",
      "Open Launch Review"
    );
  }

  pushWorkspaceAction(
    recommendedWorkspace,
    readiness.message || deliverySummary.summary || "Continue the release mainline from the recommended workspace."
  );
  pushWorkspaceAction(
    createLaunchWorkflowWorkspaceShortcut("release", releaseAutofocus, "Open Release Workspace"),
    "Keep release rules, notices, and packaged artifacts aligned while you work through this lane."
  );
  pushWorkspaceAction(
    createLaunchWorkflowWorkspaceShortcut("launch", "handoff", "Open Launch Workflow"),
    "Use Launch Workflow as the combined handoff view once the release lane is staged."
  );
  if (!projectBlocked) {
    pushWorkspaceAction(
      createLaunchWorkflowWorkspaceShortcut("launch-review", "summary", "Open Launch Review"),
      "Use Launch Review to recheck launch readiness against first-wave runtime signals."
    );
  }
  if (integrationNeedsAttention || startupBlocked || String(readiness.status || "").toLowerCase() !== "ready") {
    pushWorkspaceAction(
      createLaunchWorkflowWorkspaceShortcut("integration", "startup", "Open Integration Workspace"),
      "Use Integration when startup, hardening, or token verification settings still need work."
    );
  }
  if (authorizationWorkspaceAction) {
    pushWorkspaceAction(
      authorizationWorkspaceAction,
      authReadiness.message || "Use the license workspace to finish starter policies, accounts, and launch inventory."
    );
  }

  let title = "Release lane needs one more pass";
  let message = readiness.message || deliverySummary.summary || "Use the release workspace to keep this lane aligned before handoff.";
  if (normalizedStatus === "hold") {
    title = "Release lane still has blockers";
    message = readiness.message || "Resolve the blocking release checks before handing this lane to QA, launch duty, or operators.";
  } else if (normalizedStatus === "ready") {
    title = "Release lane is ready to move into launch validation";
    message = "Release readiness looks aligned. Move into Launch Workflow, Launch Review, and smoke validation before the wider rollout.";
  }

  if (normalizedStatus === "hold") {
    pushActionPlan({
      key: "clear_release_blockers",
      title: projectBlocked
        ? "Re-activate the project before handoff"
        : startupBlocked || integrationNeedsAttention
          ? "Fix startup and integration blockers first"
          : "Clear blocking release rules in this workspace",
      summary: message,
      status: "block",
      priority: "primary",
      workspaceAction: recommendedWorkspace,
      recommendedDownload: releaseChecklistDownload
    });
    pushActionPlan({
      key: "refresh_release_package",
      title: "Regenerate the release package after fixes",
      summary: "Refresh the release package so the handoff summary and packaged assets reflect the latest rules, notices, and startup state.",
      status: "review",
      priority: "secondary",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("release", releaseAutofocus, "Open Release Workspace"),
      recommendedDownload: releaseSummaryDownload
    });
    pushActionPlan({
      key: "launch_recheck",
      title: "Recheck the combined launch lane after the release fix",
      summary: "Once release blockers clear, reopen Launch Workflow before moving into first-wave validation.",
      status: "review",
      priority: "secondary",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("launch", "handoff", "Open Launch Workflow"),
      recommendedDownload: launchSummaryDownload
    });
    if (authorizationNeedsAttention) {
      pushActionPlan({
        key: "authorization_follow_up",
        title: "Finish launch authorization staging",
        summary: authReadiness.bootstrapSummary
          || authReadiness.firstBatchSetupSummary
          || (Array.isArray(authReadiness.nextActions) && authReadiness.nextActions[0])
          || authReadiness.message
          || "Stage starter policies, accounts, and launch inventory before rollout.",
        status: authReadiness.status || "review",
        priority: "secondary",
        workspaceAction: authorizationWorkspaceAction,
        bootstrapAction: authReadiness.bootstrapAction || null,
        setupAction: authReadiness.firstBatchSetupAction || null
      });
    }
  } else {
    if (normalizedStatus === "attention") {
      pushActionPlan({
        key: "review_release_attention",
        title: releaseNeedsAttention
          ? "Review remaining release attention items"
          : integrationNeedsAttention
            ? "Review remaining integration attention items"
            : "Review the remaining lane attention items",
        summary: message,
        status: "review",
        priority: "primary",
        workspaceAction: recommendedWorkspace,
        recommendedDownload: releaseChecklistDownload
      });
    }
    if (authorizationNeedsAttention) {
      pushActionPlan({
        key: "authorization_follow_up",
        title: "Finish launch authorization staging",
        summary: authReadiness.bootstrapSummary
          || authReadiness.firstBatchSetupSummary
          || (Array.isArray(authReadiness.nextActions) && authReadiness.nextActions[0])
          || authReadiness.message
          || "Stage starter policies, accounts, and launch inventory before rollout.",
        status: authReadiness.status || "review",
        priority: normalizedStatus === "ready" ? "primary" : "secondary",
        workspaceAction: authorizationWorkspaceAction,
        bootstrapAction: authReadiness.bootstrapAction || null,
        setupAction: authReadiness.firstBatchSetupAction || null
      });
    }
    pushActionPlan({
      key: "launch_handoff",
      title: "Confirm the combined launch lane before rollout",
      summary: "Use Launch Workflow to keep release, startup, authorization, and handoff context aligned for this channel.",
      status: normalizedStatus === "ready" ? "pass" : "review",
      priority: normalizedStatus === "ready" ? "primary" : "secondary",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("launch", "handoff", "Open Launch Workflow"),
      recommendedDownload: launchSummaryDownload
    });
    pushActionPlan({
      key: "launch_review",
      title: "Run Launch Review for first-wave validation",
      summary: "Launch Review combines launch readiness with the first scoped ops slice so release duty can recheck the lane before it goes wider.",
      status: "review",
      priority: normalizedStatus === "ready" ? "primary" : "secondary",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("launch-review", "summary", "Open Launch Review"),
      recommendedDownload: launchReviewDownload
    });
    pushActionPlan({
      key: "launch_smoke_kit",
      title: "Download the smoke kit for internal QA and launch duty",
      summary: "Hand the startup request, candidate internal credentials, and smoke-test path to the team running first-wave validation.",
      status: "review",
      priority: "secondary",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("launch-smoke", "summary", "Open Launch Smoke"),
      recommendedDownload: launchSmokeKitDownload
    });
  }

  const recommendedDownloads = [
    releaseSummaryDownload,
    releaseChecklistDownload,
    releaseZipDownload
  ];
  if (normalizedStatus !== "hold") {
    recommendedDownloads.push(launchSummaryDownload, launchReviewDownload, launchSmokeKitDownload);
  }

  return {
    status: normalizedStatus,
    title,
    message,
    recommendedWorkspace,
    workspaceActions,
    actionPlan,
    recommendedDownloads
  };
}

function buildReleasePackagePayload({
  generatedAt = nowIso(),
  developer,
  actor,
  product,
  channel = "stable",
  versionManifest,
  activeNoticeRows = [],
  integrationPackage,
  authReadiness = {},
  releaseStartupPreview = null
}) {
  const normalizedChannel = normalizeChannel(channel);
  const timestampTag = buildExportTimestampTag(generatedAt);
  const activeNotices = activeNoticeRows.map((row) => (
    row && typeof row === "object" && Object.hasOwn(row, "blockLogin")
      ? row
      : formatNotice(row)
  ));
  const blockingNotices = activeNotices.filter((item) => item.blockLogin);
  const readiness = buildReleaseReadinessPayload({
    product,
    versionManifest,
    activeNotices,
    releaseStartupPreview
  });
  const envFileName = `${product.code}.env`;
  const hostConfigFileName = "rocksolid_host_config.env";
  const cmakeFileName = "CMakeLists.txt";
  const vs2022GuideFileName = `${buildIntegrationConsumerProjectBaseName(integrationPackage?.manifest || { project: product })}_vs2022_quickstart.md`;
  const vs2022SolutionFileName = `${buildIntegrationConsumerProjectBaseName(integrationPackage?.manifest || { project: product })}_host_consumer.sln`;
  const vs2022ProjectFileName = `${buildIntegrationConsumerProjectBaseName(integrationPackage?.manifest || { project: product })}_host_consumer.vcxproj`;
  const vs2022FiltersFileName = `${buildIntegrationConsumerProjectBaseName(integrationPackage?.manifest || { project: product })}_host_consumer.vcxproj.filters`;
  const vs2022PropsFileName = "RockSolidSDK.props";
  const vs2022LocalPropsFileName = "RockSolidSDK.local.props";
  const cppFileName = `${product.code}.cpp`;
  const hostSkeletonFileName = `${product.code}-host-skeleton.cpp`;
  const hardeningFileName = `${product.code}-hardening-guide.txt`;
  const fileName = `rocksolid-release-package-${product.code}-${normalizedChannel}-${timestampTag}.json`;
  const summaryFileName = `rocksolid-release-package-${product.code}-${normalizedChannel}-${timestampTag}.txt`;
  const checklistFileName = `rocksolid-release-package-${product.code}-${normalizedChannel}-${timestampTag}-checklist.txt`;
  const deliverySummary = buildReleaseDeliverySummaryPayload({
    product,
    channel: normalizedChannel,
    versionManifest,
    activeNotices,
    readiness,
    integrationPackage,
    releaseStartupPreview,
    fileName,
    summaryFileName,
    envFileName,
    hostConfigFileName,
    cmakeFileName,
    vs2022GuideFileName,
    vs2022SolutionFileName,
    vs2022ProjectFileName,
    vs2022FiltersFileName,
    vs2022PropsFileName,
    vs2022LocalPropsFileName,
    cppFileName,
    hostSkeletonFileName
  });
  const deliveryChecklist = buildReleaseDeliveryChecklistPayload({
    product,
    channel: normalizedChannel,
    versionManifest,
    activeNotices,
    readiness,
    deliverySummary,
    releaseStartupPreview
  });
  const mainlineFollowUp = buildReleaseMainlineFollowUpPayload({
    product,
    channel: normalizedChannel,
    readiness,
    deliverySummary,
    deliveryChecklist,
    authReadiness,
    releaseStartupPreview,
    fileName,
    summaryFileName,
    checklistFileName
  });
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
      startupPreview: releaseStartupPreview,
      readiness,
      deliverySummary,
      deliveryChecklist,
      authorizationReadiness: authReadiness,
      mainlineFollowUp,
      activeNotices: {
        total: activeNotices.length,
        blockingTotal: blockingNotices.length,
        items: activeNotices
      }
    },
    integration: integrationPackage?.manifest ?? null,
    authorizationReadiness: authReadiness,
    snippets: {
      envFileName,
      hostConfigFileName,
      cmakeFileName,
      vs2022GuideFileName,
      vs2022SolutionFileName,
      vs2022ProjectFileName,
      vs2022FiltersFileName,
      vs2022PropsFileName,
      vs2022LocalPropsFileName,
      cppFileName,
      hostSkeletonFileName
    },
    notes: [
      "Use this package as the handoff snapshot for software release coordination, client upgrade notices, and SDK configuration updates.",
      "Regenerate the package after rotating SDK credentials or changing active version and notice rules."
    ]
  };

  const payload = {
    fileName,
    summaryFileName,
    checklistFileName,
    manifest,
    deliverySummary,
    deliveryChecklist,
    mainlineFollowUp,
    snippets: {
      envFileName,
      envTemplate: integrationPackage?.snippets?.envTemplate || "",
      hostConfigFileName,
      hostConfigEnv: integrationPackage?.snippets?.hostConfigEnv || "",
      cmakeFileName,
      cmakeConsumerTemplate: integrationPackage?.snippets?.cmakeConsumerTemplate || "",
      vs2022GuideFileName,
      vs2022GuideText: integrationPackage?.snippets?.vs2022GuideText || "",
      vs2022SolutionFileName,
      vs2022SolutionTemplate: integrationPackage?.snippets?.vs2022SolutionTemplate || "",
      vs2022ProjectFileName,
      vs2022ProjectTemplate: integrationPackage?.snippets?.vs2022ProjectTemplate || "",
      vs2022FiltersFileName,
      vs2022FiltersTemplate: integrationPackage?.snippets?.vs2022FiltersTemplate || "",
      vs2022PropsFileName,
      vs2022PropsTemplate: integrationPackage?.snippets?.vs2022PropsTemplate || "",
      vs2022LocalPropsFileName,
      vs2022LocalPropsTemplate: integrationPackage?.snippets?.vs2022LocalPropsTemplate || "",
      cppFileName,
      cppQuickstart: integrationPackage?.snippets?.cppQuickstart || "",
      hostSkeletonFileName,
      hostSkeletonCpp: integrationPackage?.snippets?.hostSkeletonCpp || "",
      hardeningFileName,
      hardeningGuide: buildClientHardeningGuideText({
        projectCode: product.code,
        channel: normalizedChannel,
        clientHardening: releaseStartupPreview?.clientHardening || integrationPackage?.manifest?.clientHardening || {}
      })
    },
    checklistText: "",
    summaryText: ""
  };
  payload.checklistText = buildReleasePackageChecklistText(payload);
  payload.summaryText = buildReleasePackageSummaryText(payload.manifest);
  return payload;
}

function normalizeLaunchWorkflowChecklistStatus(status = "unknown") {
  const normalized = String(status || "unknown").trim().toLowerCase() || "unknown";
  if (normalized === "ready" || normalized === "pass") {
    return "pass";
  }
  if (normalized === "hold" || normalized === "block" || normalized === "blocking") {
    return "block";
  }
  return "review";
}

function pickLaunchWorkflowReleaseAutofocus(readiness = {}) {
  const readinessChecks = Array.isArray(readiness?.checks) ? readiness.checks : [];
  const findReadinessCheck = (key) => readinessChecks.find((item) => item?.key === key) || null;
  const noticeCheck = findReadinessCheck("notices");
  const versionRuleCheck = findReadinessCheck("version_rule");
  const downloadUrlCheck = findReadinessCheck("download_url");
  if (
    noticeCheck
    && (noticeCheck.blocking === true || String(noticeCheck.level || "").toLowerCase() === "attention")
  ) {
    return "notices";
  }
  if (
    (versionRuleCheck && String(versionRuleCheck.level || "").toLowerCase() === "attention")
    || (downloadUrlCheck && String(downloadUrlCheck.level || "").toLowerCase() === "attention")
  ) {
    return "versions";
  }
  return "package";
}

function createLaunchWorkflowWorkspaceShortcut(key, autofocus = "", label = "", params = null) {
  if (!key) {
    return null;
  }
  const extras = params && typeof params === "object"
    ? { params: { ...params } }
    : {};
  if (key === "project") {
    return {
      key,
      label: label || "Open Project Workspace",
      autofocus: autofocus || "detail",
      ...extras
    };
  }
  if (key === "integration") {
    return {
      key,
      label: label || "Open Integration Workspace",
      autofocus: autofocus || "package",
      ...extras
    };
  }
  if (key === "release") {
    return {
      key,
      label: label || "Open Release Workspace",
      autofocus: autofocus || "package",
      ...extras
    };
  }
  if (key === "licenses") {
    return {
      key,
      label: label || "Open License Workspace",
      autofocus: autofocus || "policy-control",
      ...extras
    };
  }
  if (key === "ops") {
    return {
      key,
      label: label || "Open Ops Workspace",
      autofocus: autofocus || "snapshot",
      ...extras
    };
  }
  if (key === "launch-review") {
    return {
      key,
      label: label || "Open Launch Review",
      autofocus: autofocus || "summary",
      ...extras
    };
  }
  if (key === "launch-smoke") {
    return {
      key,
      label: label || "Open Launch Smoke",
      autofocus: autofocus || "summary",
      ...extras
    };
  }
  return {
    key: "launch",
    label: label || "Stay in Launch Workflow",
    autofocus: autofocus || "handoff",
    ...extras
  };
}

function createLaunchWorkflowDownloadShortcut(key, fileName = "", label = "", extra = null) {
  if (!key) {
    return null;
  }
  return {
    key,
    fileName: fileName || "",
    label: label || key,
    ...(extra && typeof extra === "object" ? extra : {})
  };
}

function createLaunchWorkflowOpsDownloadShortcut(action, {
  key = "",
  label = "",
  fileName = "developer-ops-summary.txt",
  format = "summary"
} = {}) {
  if (!action?.workspaceAction || action.workspaceAction.key !== "ops") {
    return null;
  }
  return createLaunchWorkflowDownloadShortcut(
    key || `ops_${action.key || "snapshot"}_${format}`,
    fileName,
    label || "Ops snapshot summary",
    {
      source: "developer-ops",
      format,
      params: action.workspaceAction.params && typeof action.workspaceAction.params === "object"
        ? { ...action.workspaceAction.params }
        : {}
    }
  );
}

function createLaunchWorkflowPrimaryOpsDownloadShortcut(workspaceAction, {
  key = "ops_primary_summary",
  label = "Primary match summary",
  fileName = "developer-ops-primary-summary.txt",
  format = "route-review-primary"
} = {}) {
  if (!workspaceAction || workspaceAction.key !== "ops") {
    return null;
  }
  const rawParams = workspaceAction.params && typeof workspaceAction.params === "object"
    ? workspaceAction.params
    : {};
  const focusKind = String(rawParams.focusKind || "").trim().toLowerCase();
  if (!focusKind) {
    return null;
  }
  const descriptor = buildPrimaryOpsDownloadDescriptor(focusKind);
  const resolvedKey = key === "ops_primary_summary" ? descriptor.key : key;
  const resolvedLabel = label === "Primary match summary" ? descriptor.label : label;
  const resolvedFileName = fileName === "developer-ops-primary-summary.txt" ? descriptor.fileName : fileName;
  const params = {
    reviewMode: rawParams.reviewMode || "matched",
    productCode: rawParams.focusProductCode || rawParams.productCode || "",
    username: rawParams.focusUsername || rawParams.username || "",
    search: rawParams.search || "",
    eventType: rawParams.eventType || "",
    actorType: rawParams.actorType || "",
    entityType: rawParams.entityType || "",
    limit: rawParams.limit || 60
  };
  if (focusKind === "account") {
    params.search = "";
  } else if (focusKind === "entitlement") {
    params.entityType = "entitlement";
    params.search = "";
  } else if (focusKind === "session") {
    params.entityType = params.entityType || "session";
    params.search = params.search || rawParams.focusSessionId || "";
  } else if (focusKind === "device") {
    params.entityType = params.entityType
      || (rawParams.focusBlockId ? "device_block" : (rawParams.focusBindingId ? "device_binding" : ""));
    params.search = params.search || rawParams.focusFingerprint || "";
  }
  for (const field of ["productCode", "username", "search", "eventType", "actorType", "entityType"]) {
    if (!params[field]) {
      delete params[field];
    }
  }
  return createLaunchWorkflowDownloadShortcut(
    resolvedKey,
    resolvedFileName,
    resolvedLabel,
    {
      source: "developer-ops",
      format,
      params
    }
  );
}

function createLaunchWorkflowRemainingOpsDownloadShortcut(workspaceAction, {
  key = "ops_remaining_summary",
  label = "Remaining matches summary",
  fileName = "developer-ops-remaining-summary.txt",
  format = "route-review-remaining"
} = {}) {
  if (!workspaceAction || workspaceAction.key !== "ops") {
    return null;
  }
  const rawParams = workspaceAction.params && typeof workspaceAction.params === "object"
    ? workspaceAction.params
    : {};
  const params = {
    reviewMode: rawParams.reviewMode || "matched",
    productCode: rawParams.focusProductCode || rawParams.productCode || "",
    username: rawParams.focusUsername || rawParams.username || "",
    search: rawParams.search || "",
    eventType: rawParams.eventType || "",
    actorType: rawParams.actorType || "",
    entityType: rawParams.entityType || "",
    limit: rawParams.limit || 60
  };
  for (const field of ["productCode", "username", "search", "eventType", "actorType", "entityType"]) {
    if (!params[field]) {
      delete params[field];
    }
  }
  return createLaunchWorkflowDownloadShortcut(
    key,
    fileName,
    label,
    {
      source: "developer-ops",
      format,
      params
    }
  );
}

function createLaunchWorkflowReviewDownloadShortcut(label = "Launch review summary", fileName = "launch-review.txt", format = "summary", params = null) {
  return createLaunchWorkflowDownloadShortcut(
    "launch_review_summary",
    fileName,
    label,
    {
      source: "developer-launch-review",
      format,
      params: params && typeof params === "object"
        ? { ...params }
      : {}
    }
  );
}

function createLaunchWorkflowSmokeKitDownloadShortcut(label = "Launch smoke kit summary", fileName = "launch-smoke-kit.txt", format = "summary", params = null) {
  return createLaunchWorkflowDownloadShortcut(
    "launch_smoke_kit_summary",
    fileName,
    label,
    {
      source: "developer-launch-smoke-kit",
      format,
      params: params && typeof params === "object"
        ? { ...params }
      : {}
    }
  );
}

function buildFocusKindControlLabel(focusKind = "", suffix = "") {
  const normalized = String(focusKind || "").trim().toLowerCase();
  if (normalized === "account") {
    return `Open Account Control${suffix}`;
  }
  if (normalized === "entitlement") {
    return `Open Entitlement Control${suffix}`;
  }
  if (normalized === "session") {
    return `Open Session Control${suffix}`;
  }
  if (normalized === "device") {
    return `Open Device Control${suffix}`;
  }
  return `Open Primary Control${suffix}`;
}

function buildFocusKindControlRouteAction(focusKind = "") {
  const normalized = String(focusKind || "").trim().toLowerCase();
  if (normalized === "account") {
    return "control-account";
  }
  if (normalized === "entitlement") {
    return "control-entitlement";
  }
  if (normalized === "session") {
    return "control-session";
  }
  if (normalized === "device") {
    return "control-device";
  }
  return "control-primary";
}

function buildPrimaryControlActionTitle(focusKind = "") {
  const normalized = String(focusKind || "").trim().toLowerCase();
  if (normalized === "account") {
    return "Open the primary account control";
  }
  if (normalized === "entitlement") {
    return "Open the primary entitlement control";
  }
  if (normalized === "session") {
    return "Open the primary session control";
  }
  if (normalized === "device") {
    return "Open the primary device control";
  }
  return "Open the primary routed control";
}

function buildPrimaryReviewStepTitle(workspaceAction = null, recommendedControl = null) {
  const recommendedLabel = String(recommendedControl?.label || "").trim();
  if (recommendedLabel) {
    return recommendedLabel;
  }
  return buildPrimaryControlActionTitle(workspaceAction?.params?.focusKind);
}

function buildReviewTargetActionPlanTitle(item = {}) {
  const recommendedLabel = String(item?.recommendedControl?.label || "").trim();
  if (recommendedLabel) {
    return recommendedLabel;
  }
  return item?.label || item?.key || "Review routed ops scope";
}

function buildPrimaryOpsDownloadDescriptor(focusKind = "") {
  const normalized = String(focusKind || "").trim().toLowerCase();
  if (normalized === "account") {
    return {
      key: "ops_primary_account_summary",
      label: "Primary account summary",
      fileName: "developer-ops-primary-account-summary.txt"
    };
  }
  if (normalized === "entitlement") {
    return {
      key: "ops_primary_entitlement_summary",
      label: "Primary entitlement summary",
      fileName: "developer-ops-primary-entitlement-summary.txt"
    };
  }
  if (normalized === "session") {
    return {
      key: "ops_primary_session_summary",
      label: "Primary session summary",
      fileName: "developer-ops-primary-session-summary.txt"
    };
  }
  if (normalized === "device") {
    return {
      key: "ops_primary_device_summary",
      label: "Primary device summary",
      fileName: "developer-ops-primary-device-summary.txt"
    };
  }
  return {
    key: "ops_primary_summary",
    label: "Primary match summary",
    fileName: "developer-ops-primary-summary.txt"
  };
}

function createReleasePackageDownloadShortcut({
  key = "release_summary",
  fileName = "release-package.txt",
  label = "Release package summary",
  format = "summary",
  params = null
} = {}) {
  return createLaunchWorkflowDownloadShortcut(
    key,
    fileName,
    label,
    {
      source: "developer-release-package",
      format,
      params: params && typeof params === "object"
        ? { ...params }
        : {}
    }
  );
}

function createLaunchWorkflowBootstrapAction({
  key = "launch_bootstrap",
  label = "Run Launch Bootstrap",
  summary = "",
  plan = []
} = {}) {
  if (!key) {
    return null;
  }
  return {
    key,
    label: label || "Run Launch Bootstrap",
    summary: summary || "",
    plan: Array.isArray(plan) ? plan.filter(Boolean) : []
  };
}

function createLaunchWorkflowSetupAction({
  key = "launch_first_batch_setup",
  label = "Run First Batch Setup",
  summary = "",
  mode = "recommended",
  operation = "first_batch_setup"
} = {}) {
  if (!key) {
    return null;
  }
  return {
    key,
    label: label || "Run First Batch Setup",
    summary: summary || "",
    mode: mode || "recommended",
    operation: operation || "first_batch_setup"
  };
}

function createLaunchWorkflowActionPlanStep({
  key,
  title = "",
  summary = "",
  status = "review",
  priority = "secondary",
  workspaceAction = null,
  recommendedDownload = null,
  bootstrapAction = null,
  setupAction = null
} = {}) {
  if (!key) {
    return null;
  }
  return {
    key,
    title: title || key,
    summary: summary || "-",
    status: status || "review",
    priority: priority || "secondary",
    workspaceAction: workspaceAction || null,
    recommendedDownload: recommendedDownload || null,
    bootstrapAction: bootstrapAction || null,
    setupAction: setupAction || null
  };
}

function mergeLaunchWorkflowReviewStatus(current = "pass", next = "pass") {
  const severity = {
    pass: 0,
    review: 1,
    block: 2
  };
  return (severity[next] ?? 0) > (severity[current] ?? 0) ? next : current;
}

function buildLaunchWorkflowAuthorizationReadiness({
  product = {},
  metrics = {},
  policies = []
} = {}) {
  const featureConfig = product?.featureConfig && typeof product.featureConfig === "object"
    ? product.featureConfig
    : {};
  const policyCount = Number(metrics.policies ?? 0);
  const freshCardCount = Number(metrics.cardsFresh ?? 0);
  const redeemedCardCount = Number(metrics.cardsRedeemed ?? 0);
  const accountCount = Number(metrics.accounts ?? 0);
  const activeEntitlementCount = Number(metrics.activeEntitlements ?? 0);
  const accountLoginEnabled = featureConfig.allowAccountLogin !== false;
  const registerEnabled = featureConfig.allowRegister !== false;
  const cardLoginEnabled = featureConfig.allowCardLogin !== false;
  const cardRechargeEnabled = featureConfig.allowCardRecharge !== false;
  const accountPathReady = accountLoginEnabled && (registerEnabled || accountCount > 0);
  const cardPathReady = cardLoginEnabled && freshCardCount > 0;
  const loginModeSummary = [
    accountLoginEnabled ? (registerEnabled ? "account+register" : "account-only") : null,
    cardLoginEnabled ? "direct-card" : null
  ].filter(Boolean).join(" + ") || "no-login-path";
  const launchRecommendations = buildLaunchAuthorizationOperationalPlan({
    product,
    metrics: {
      policies: policyCount,
      cardsFresh: freshCardCount,
      accounts: accountCount,
      activeEntitlements: activeEntitlementCount,
      cards: Array.isArray(metrics.cards) ? metrics.cards : []
    },
    policies
  });
  const cardInventoryStates = Array.isArray(launchRecommendations.cardInventoryStates)
    ? launchRecommendations.cardInventoryStates
    : [];
  const missingCardInventoryStates = cardInventoryStates.filter((item) => item.inventoryStatus === "missing");
  const lowCardInventoryStates = cardInventoryStates.filter((item) => item.inventoryStatus === "low");
  const issues = [];
  const nextActions = [];
  const bootstrapPlan = [];
  let status = "pass";
  let workspaceKey = "licenses";
  let workspaceAutofocus = "quickstart";
  let workspaceLabel = "Open License Workspace";
  let workspaceSeverity = -1;
  const severity = {
    pass: 0,
    review: 1,
    block: 2
  };

  const pushIssue = (level, message, nextAction, workspace = null) => {
    status = mergeLaunchWorkflowReviewStatus(status, level);
    if (message && !issues.includes(message)) {
      issues.push(message);
    }
    if (nextAction && !nextActions.includes(nextAction)) {
      nextActions.push(nextAction);
    }
    const nextSeverity = severity[level] ?? 0;
    if (workspace?.key && nextSeverity > workspaceSeverity) {
      workspaceKey = workspace.key;
      workspaceAutofocus = workspace.autofocus || workspaceAutofocus;
      workspaceLabel = workspace.label || workspaceLabel;
      workspaceSeverity = nextSeverity;
    }
  };

  if (!accountLoginEnabled && !cardLoginEnabled) {
    pushIssue(
      "block",
      "Both account login and direct-card login are disabled, so end users currently have no runtime sign-in path.",
      "Enable account login or direct-card login in the project feature config before launch.",
      {
        key: "project",
        autofocus: "auth-preset",
        label: "Open Project Workspace"
      }
    );
  }

  if (policyCount <= 0) {
    bootstrapPlan.push("starter policy");
    pushIssue(
      "block",
      "No entitlement policies exist for this project yet, so there is nothing to issue, recharge, or renew.",
      "Create at least one duration or points policy in Developer Licenses before opening sales.",
      {
        key: "licenses",
        autofocus: "policy-create",
        label: "Open License Workspace"
      }
    );
  }

  const missingDirectCardInventory = cardLoginEnabled && (
    cardInventoryStates.length
      ? missingCardInventoryStates.some((item) => item.mode === "direct_card")
      : freshCardCount <= 0
  );
  const missingRechargeInventory = cardRechargeEnabled && (
    cardInventoryStates.length
      ? missingCardInventoryStates.some((item) => item.mode === "recharge")
      : freshCardCount <= 0
  );

  if (missingDirectCardInventory) {
    if (!bootstrapPlan.includes("starter card batch")) {
      bootstrapPlan.push("starter card batch");
    }
    pushIssue(
      accountPathReady ? "review" : "block",
      "Direct-card login is enabled, but there are no fresh cards available for sale or activation.",
      "Issue a new card batch for a launch policy before opening direct-card login.",
      {
        key: "licenses",
        autofocus: "cards",
        label: "Open License Workspace"
      }
    );
  }

  if (missingRechargeInventory) {
    if (!bootstrapPlan.includes("starter card batch")) {
      bootstrapPlan.push("starter card batch");
    }
    pushIssue(
      accountPathReady || cardPathReady ? "review" : "block",
      "Card recharge is enabled, but there are no fresh cards ready for top-up or renewal workflows.",
      "Issue a recharge-ready card batch before opening account recharge or renewal.",
      {
        key: "licenses",
        autofocus: "cards",
        label: "Open License Workspace"
      }
    );
  }

  if (lowCardInventoryStates.length > 0) {
    pushIssue(
      "review",
      `Starter inventory is already live, but the launch buffer is low for ${lowCardInventoryStates.map((item) => item.label).join(" + ")}.`,
      "Run Inventory Refill to top the launch buffer back up before the first sales wave consumes the remaining fresh cards.",
      {
        key: "licenses",
        autofocus: "cards",
        label: "Open License Workspace"
      }
    );
  }

  if (accountLoginEnabled && !registerEnabled && accountCount <= 0) {
    bootstrapPlan.push("starter account");
    pushIssue(
      cardPathReady ? "review" : "block",
      "Account login is enabled, but registration is disabled and no starter accounts exist in this project.",
      "Either enable registration, seed starter accounts, or rely on direct-card login for first launch.",
      {
        key: "licenses",
        autofocus: "starter-account",
        label: "Open License Workspace"
      }
    );
  }

  if (!issues.length && activeEntitlementCount <= 0 && freshCardCount <= 0) {
    pushIssue(
      "review",
      "The project has no active entitlements and no fresh card inventory yet, so first-sale operations have not been staged.",
      "Stage at least one starter policy and one initial card batch before rollout."
    );
  }

  const bootstrapEligible = bootstrapPlan.length > 0 && (accountLoginEnabled || cardLoginEnabled);
  const bootstrapSummary = bootstrapEligible
    ? `Run Launch Bootstrap to create ${bootstrapPlan.join(", ")} automatically before launch.`
    : null;
  const bootstrapAction = bootstrapEligible
    ? createLaunchWorkflowBootstrapAction({
        summary: bootstrapSummary,
        plan: bootstrapPlan
      })
    : null;
  const firstBatchSetupEligible = policyCount > 0
    && (cardInventoryStates.length
      ? missingCardInventoryStates.length > 0
      : freshCardCount <= 0)
    && (cardLoginEnabled || cardRechargeEnabled);
  const inventoryRefillEligible = policyCount > 0
    && !firstBatchSetupEligible
    && lowCardInventoryStates.length > 0;
  const firstBatchSetupSummary = firstBatchSetupEligible
    ? "Run First Batch Setup to create the recommended launch card inventory automatically before rollout."
    : inventoryRefillEligible
      ? `Run Inventory Refill to top the launch buffer back up for ${lowCardInventoryStates.map((item) => item.label).join(" + ")}.`
      : null;
  const firstBatchSetupAction = firstBatchSetupEligible
    ? createLaunchWorkflowSetupAction({
        summary: firstBatchSetupSummary,
        mode: "recommended",
        operation: "first_batch_setup"
      })
    : inventoryRefillEligible
      ? createLaunchWorkflowSetupAction({
          key: "launch_inventory_refill",
          label: "Run Inventory Refill",
          summary: firstBatchSetupSummary,
          mode: "recommended",
          operation: "restock"
        })
      : null;

  if (bootstrapEligible) {
    workspaceKey = "licenses";
    workspaceAutofocus = "quickstart";
    workspaceLabel = "Open License Workspace";
    if (bootstrapSummary && !nextActions.includes(bootstrapSummary)) {
      nextActions.unshift(bootstrapSummary);
    }
  }
  if (firstBatchSetupSummary && !nextActions.includes(firstBatchSetupSummary)) {
    nextActions.unshift(firstBatchSetupSummary);
  }

  if (!nextActions.length) {
    nextActions.push("Authorization paths, policies, and starter inventory look aligned for initial rollout.");
  }

  const summary = [
    `modes=${loginModeSummary}`,
    `policies=${policyCount}`,
    `freshCards=${freshCardCount}`,
    `accounts=${accountCount}`,
    `activeEntitlements=${activeEntitlementCount}`
  ].join(" | ");

  return {
    status,
    summary,
    message: issues[0] || "Authorization paths and starter inventory look aligned for this lane.",
    issues,
    nextActions,
    loginModeSummary,
    inventory: {
      policies: policyCount,
      freshCards: freshCardCount,
      redeemedCards: redeemedCardCount,
      accounts: accountCount,
      activeEntitlements: activeEntitlementCount
    },
    accountPathReady,
    cardPathReady,
    workspaceKey,
    workspaceAutofocus,
    workspaceLabel,
    bootstrapEligible,
    bootstrapSummary,
    bootstrapPlan,
    bootstrapAction,
    firstBatchSetupEligible,
    inventoryRefillEligible,
    firstBatchSetupSummary,
    firstBatchSetupAction,
    launchRecommendations
  };
}

function buildLaunchAuthorizationModeSummary(featureConfig = {}) {
  const accountLoginEnabled = featureConfig.allowAccountLogin !== false;
  const registerEnabled = featureConfig.allowRegister !== false;
  const cardLoginEnabled = featureConfig.allowCardLogin !== false;
  return [
    accountLoginEnabled ? (registerEnabled ? "account+register" : "account-only") : null,
    cardLoginEnabled ? "direct-card" : null
  ].filter(Boolean).join(" + ") || "no-login-path";
}

function recommendLaunchStarterGrantType(featureConfig = {}, policies = []) {
  if (policies.some((item) => item?.grantType === "duration")) {
    return "duration";
  }
  if (policies.some((item) => item?.grantType === "points")) {
    return "points";
  }
  return featureConfig.allowCardLogin !== false || featureConfig.allowCardRecharge !== false
    ? "duration"
    : "duration";
}

function buildLaunchStarterBatchPrefix(productCode = "") {
  return String(productCode || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 10) || "ROCKSOLID";
}

function buildLaunchStarterAccountUsername(productCode = "", count = 0) {
  const base = String(productCode || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 16) || "starter";
  return `${base}_seed_${String(Math.max(1, count + 1)).padStart(2, "0")}`;
}

function buildLaunchStarterAccountPassword(productCode = "") {
  const prefix = String(productCode || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 8) || "starter";
  return `${prefix}@${randomToken(4)}`;
}

function buildLaunchStarterPolicyDraft(product = {}, policies = []) {
  const featureConfig = product?.featureConfig && typeof product.featureConfig === "object"
    ? product.featureConfig
    : {};
  const grantType = recommendLaunchStarterGrantType(featureConfig, policies);
  const productLabel = String(product?.name || product?.code || "Launch").trim() || "Launch";

  return {
    name: grantType === "points"
      ? `${productLabel} Launch 100 Points`
      : `${productLabel} Launch 30 Days`,
    grantType,
    durationDays: grantType === "points" ? 0 : 30,
    grantPoints: grantType === "points" ? 100 : 0,
    maxDevices: 1,
    allowConcurrentSessions: false,
    heartbeatIntervalSeconds: 60,
    heartbeatTimeoutSeconds: 180,
    tokenTtlSeconds: 300,
    bindMode: "strict",
    bindFields: "",
    allowClientUnbind: false,
    clientUnbindLimit: 0,
    clientUnbindWindowDays: 30,
    clientUnbindDeductDays: 0
  };
}

function buildLaunchStarterCardBatchDraft(product = {}, policies = []) {
  const featureConfig = product?.featureConfig && typeof product.featureConfig === "object"
    ? product.featureConfig
    : {};
  const activePolicies = policies.filter((item) => normalizeProductStatus(item?.status || "active") === "active");
  const preferredGrantType = recommendLaunchStarterGrantType(featureConfig, activePolicies);
  const preferredPolicy = activePolicies.find((item) => item?.grantType === preferredGrantType)
    || activePolicies[0]
    || null;

  return {
    policyId: preferredPolicy?.policyId ?? preferredPolicy?.id ?? "",
    count: 50,
    prefix: buildLaunchStarterBatchPrefix(product?.code || ""),
    notes: `Launch starter batch | modes=${buildLaunchAuthorizationModeSummary(featureConfig)}`
  };
}

function selectLaunchStarterPolicyByGrantType(policies = [], grantType = "duration") {
  const activePolicies = Array.isArray(policies)
    ? policies.filter((item) => normalizeProductStatus(item?.status || "active") === "active")
    : [];
  return activePolicies.find((item) => item?.grantType === grantType)
    || activePolicies[0]
    || null;
}

function buildLaunchRecommendedCardBatchDrafts(product = {}, policies = []) {
  const featureConfig = product?.featureConfig && typeof product.featureConfig === "object"
    ? product.featureConfig
    : {};
  const activePolicies = Array.isArray(policies)
    ? policies.filter((item) => normalizeProductStatus(item?.status || "active") === "active")
    : [];
  const preferredGrantType = recommendLaunchStarterGrantType(featureConfig, activePolicies);
  const batchPrefix = buildLaunchStarterBatchPrefix(product?.code || "");
  const drafts = [];

  if (featureConfig.allowCardLogin !== false) {
    const policy = selectLaunchStarterPolicyByGrantType(activePolicies, preferredGrantType);
    drafts.push({
      key: "direct_card_batch",
      mode: "direct_card",
      label: "Direct-card launch batch",
      grantType: preferredGrantType,
      count: 50,
      prefix: `${batchPrefix}DL`,
      purpose: "First-sale activations and QA smoke tests",
      nextAction: "Issue one fresh batch and reserve a few keys for QA before opening public sales.",
      policyId: policy?.policyId ?? policy?.id ?? "",
      notes: `Direct-card launch batch | modes=${buildLaunchAuthorizationModeSummary(featureConfig)}`
    });
  }

  if (featureConfig.allowCardRecharge !== false) {
    const rechargeGrantType = preferredGrantType === "points" ? "points" : preferredGrantType;
    const policy = selectLaunchStarterPolicyByGrantType(activePolicies, rechargeGrantType);
    drafts.push({
      key: "recharge_batch",
      mode: "recharge",
      label: "Recharge starter batch",
      grantType: rechargeGrantType,
      count: featureConfig.allowCardLogin !== false ? 100 : 50,
      prefix: `${batchPrefix}RC`,
      purpose: "Renewal, recharge, and early support top-ups",
      nextAction: featureConfig.allowCardLogin !== false
        ? "Keep recharge stock separate from direct-login stock so renewals do not consume the initial sales batch."
        : "Issue one recharge-ready batch before the first renewal or top-up request arrives.",
      policyId: policy?.policyId ?? policy?.id ?? "",
      notes: `Recharge starter batch | modes=${buildLaunchAuthorizationModeSummary(featureConfig)}`
    });
  }

  return drafts;
}

function countFreshCardsMatchingLaunchDraft(cards = [], draft = {}) {
  const prefix = String(draft?.prefix || "").trim().toUpperCase();
  if (!prefix) {
    return 0;
  }
  const cardItems = Array.isArray(cards) ? cards : [];
  return cardItems.filter((item) => {
    if (normalizeCardControlStatus(item?.status || "active") !== "active") {
      return false;
    }
    if (!isFreshCardInventoryStatus(item?.usageStatus ?? item?.displayStatus)) {
      return false;
    }
    const batchCode = String(item?.batchCode || "").trim().toUpperCase();
    const cardKey = String(item?.cardKey || item?.maskedKey || "").trim().toUpperCase();
    return batchCode.startsWith(prefix) || cardKey.startsWith(prefix);
  }).length;
}

function collectFreshCardsMatchingLaunchDraft(cards = [], draft = {}, limit = 0) {
  const prefix = String(draft?.prefix || "").trim().toUpperCase();
  if (!prefix) {
    return [];
  }
  const cardItems = Array.isArray(cards) ? cards : [];
  const matches = cardItems.filter((item) => {
    if (normalizeCardControlStatus(item?.status || "active") !== "active") {
      return false;
    }
    if (!isFreshCardInventoryStatus(item?.usageStatus ?? item?.displayStatus)) {
      return false;
    }
    const batchCode = String(item?.batchCode || "").trim().toUpperCase();
    const cardKey = String(item?.cardKey || item?.maskedKey || "").trim().toUpperCase();
    return batchCode.startsWith(prefix) || cardKey.startsWith(prefix);
  });
  if (Number(limit || 0) > 0) {
    return matches.slice(0, Number(limit));
  }
  return matches;
}

function buildLaunchRecommendedCardInventoryStates(product = {}, policies = [], cards = []) {
  return buildLaunchRecommendedCardBatchDrafts(product, policies).map((draft) => {
    const targetCount = Math.max(1, Number(draft?.count ?? 0) || 0);
    const freshCount = countFreshCardsMatchingLaunchDraft(cards, draft);
    const refillThreshold = Math.max(5, Math.ceil(targetCount * 0.4));
    const inventoryStatus = freshCount <= 0
      ? "missing"
      : freshCount < refillThreshold
        ? "low"
        : "ready";
    return {
      ...draft,
      targetCount,
      freshCount,
      refillThreshold,
      inventoryStatus,
      refillCount: inventoryStatus === "low"
        ? Math.max(1, targetCount - freshCount)
        : 0
    };
  });
}

function isFreshCardInventoryStatus(value = "") {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "fresh" || normalized === "unused";
}

function buildLaunchInternalSeedCardBatchDraft(product = {}, policies = []) {
  const featureConfig = product?.featureConfig && typeof product.featureConfig === "object"
    ? product.featureConfig
    : {};
  const starterDraft = buildLaunchStarterCardBatchDraft(product, policies);
  const basePrefix = buildLaunchStarterBatchPrefix(product?.code || "").slice(0, 8) || "ROCKSOLID";

  return {
    ...starterDraft,
    count: 1,
    prefix: `${basePrefix}INT`,
    notes: `Launch internal entitlement seed | modes=${buildLaunchAuthorizationModeSummary(featureConfig)}`
  };
}

function buildLaunchStarterAccountDraft(product = {}, accountCount = 0) {
  return {
    username: buildLaunchStarterAccountUsername(product?.code || "", accountCount),
    password: buildLaunchStarterAccountPassword(product?.code || "")
  };
}

function buildLaunchAuthorizationOperationalPlan({
  product = {},
  metrics = {},
  policies = []
} = {}) {
  const featureConfig = product?.featureConfig && typeof product.featureConfig === "object"
    ? product.featureConfig
    : {};
  const policyCount = Number(metrics.policies ?? 0);
  const freshCardCount = Number(metrics.cardsFresh ?? 0);
  const accountCount = Number(metrics.accounts ?? 0);
  const activeEntitlementCount = Number(metrics.activeEntitlements ?? 0);
  const accountLoginEnabled = featureConfig.allowAccountLogin !== false;
  const registerEnabled = featureConfig.allowRegister !== false;
  const cardLoginEnabled = featureConfig.allowCardLogin !== false;
  const cardRechargeEnabled = featureConfig.allowCardRecharge !== false;
  const preferredGrantType = recommendLaunchStarterGrantType(featureConfig, Array.isArray(policies) ? policies : []);
  const cardInventoryStates = Array.isArray(metrics.cards)
    ? buildLaunchRecommendedCardInventoryStates(product, policies, metrics.cards)
    : [];
  const missingCardInventoryStates = cardInventoryStates.filter((item) => item.inventoryStatus === "missing");
  const lowCardInventoryStates = cardInventoryStates.filter((item) => item.inventoryStatus === "low");
  const inventoryRecommendations = [];
  const firstBatchCardRecommendations = [];
  const firstOpsActions = [];

  const pushInventoryRecommendation = (item) => {
    if (!item?.key) {
      return;
    }
    inventoryRecommendations.push(item);
  };

  if (!accountLoginEnabled && !cardLoginEnabled) {
    pushInventoryRecommendation({
      key: "login_path",
      label: "Launch login path",
      priority: "required",
      status: "missing",
      target: "Enable account login or direct-card login",
      current: "No runtime login path",
      summary: "End users still have no runtime sign-in path for this project.",
      nextAction: "Adjust the project authorization preset before launch so at least one login path is available.",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("project", "auth-preset", "Open Project Workspace")
    });
  }

  pushInventoryRecommendation({
    key: "starter_policy",
    label: preferredGrantType === "points" ? "Starter points policy" : "Starter duration policy",
    priority: "required",
    status: policyCount > 0 ? "ready" : "missing",
    target: "At least 1 active starter policy",
    current: `${policyCount} active`,
    summary: preferredGrantType === "points"
      ? "Keep one active points policy ready for recharge or usage-based launch flows."
      : "Keep one active duration policy ready for first-sale activation and renewals.",
    nextAction: policyCount > 0
      ? "Keep one starter policy active for the launch lane."
      : "Create one active starter policy before issuing cards or opening first-user access.",
    workspaceAction: createLaunchWorkflowWorkspaceShortcut("licenses", "policy-create", "Open License Workspace"),
    bootstrapAction: policyCount > 0
      ? null
      : createLaunchWorkflowBootstrapAction({
          summary: "Create a starter policy automatically for this launch lane.",
          plan: ["starter policy"]
        })
  });

  if (cardLoginEnabled || cardRechargeEnabled) {
    const targetCount = cardLoginEnabled && cardRechargeEnabled
      ? "50-100 fresh cards"
      : cardLoginEnabled
        ? "50 fresh cards"
        : "100 fresh cards";
    const starterInventoryStatus = missingCardInventoryStates.length
      ? "missing"
      : lowCardInventoryStates.length
        ? "low"
        : freshCardCount > 0
          ? "ready"
          : "missing";
    const starterInventoryCurrent = cardInventoryStates.length
      ? `${freshCardCount} fresh | ${cardInventoryStates.map((item) => `${item.mode}:${item.freshCount}/${item.targetCount}`).join(" | ")}`
      : `${freshCardCount} fresh`;
    const starterInventorySummary = missingCardInventoryStates.length
      ? (cardInventoryStates.length > 1
          ? `At least one recommended launch batch is still missing fresh inventory (${missingCardInventoryStates.map((item) => item.label).join(" + ")}).`
          : "The recommended launch card batch is still missing fresh inventory.")
      : lowCardInventoryStates.length
        ? `Starter card inventory exists, but the launch buffer is running low for ${lowCardInventoryStates.map((item) => item.label).join(" + ")}.`
        : cardLoginEnabled && cardRechargeEnabled
          ? "This lane has fresh cards staged for both first-sale activation and recharge top-ups."
          : cardLoginEnabled
            ? "Direct-card login has sellable fresh cards staged for the first launch window."
            : "Recharge flows have fresh cards staged before the first renewal or top-up request arrives.";
    const starterInventoryNextAction = missingCardInventoryStates.length
      ? "Issue at least one starter card batch for each missing launch mode before opening login or recharge."
      : lowCardInventoryStates.length
        ? "Run inventory refill before the current launch buffer runs dry."
        : "Keep a starter card buffer available for the first launch window.";
    pushInventoryRecommendation({
      key: "starter_card_inventory",
      label: cardLoginEnabled && cardRechargeEnabled
        ? "Starter card inventory"
        : cardLoginEnabled
          ? "Direct-card starter inventory"
          : "Recharge starter inventory",
      priority: "required",
      status: starterInventoryStatus,
      target: targetCount,
      current: starterInventoryCurrent,
      summary: starterInventorySummary,
      nextAction: starterInventoryNextAction,
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("licenses", "cards", "Open License Workspace"),
      bootstrapAction: freshCardCount > 0
        ? null
        : createLaunchWorkflowBootstrapAction({
            summary: "Issue starter launch cards automatically for this lane.",
            plan: ["starter card batch"]
          }),
      setupAction: policyCount > 0 && (missingCardInventoryStates.length || lowCardInventoryStates.length)
        ? createLaunchWorkflowSetupAction({
            key: missingCardInventoryStates.length ? "launch_first_batch_setup" : "launch_inventory_refill",
            label: missingCardInventoryStates.length ? "Run First Batch Setup" : "Run Inventory Refill",
            summary: starterInventoryNextAction,
            mode: "recommended",
            operation: missingCardInventoryStates.length ? "first_batch_setup" : "restock"
          })
        : null
    });
  }

  if (accountLoginEnabled) {
    const closedRegistration = !registerEnabled;
    const starterTarget = closedRegistration ? "1-3 starter accounts" : "1 internal QA/support account";
    const status = closedRegistration
      ? (accountCount > 0 ? "ready" : "missing")
      : (accountCount > 0 ? "ready" : "recommended");
    pushInventoryRecommendation({
      key: "starter_accounts",
      label: closedRegistration ? "Starter accounts" : "Internal starter accounts",
      priority: closedRegistration ? "required" : "recommended",
      status,
      target: starterTarget,
      current: `${accountCount} visible`,
      summary: closedRegistration
        ? "Closed registration lanes still need at least one seed account for internal QA, support, or launch smoke tests."
        : "Open registration is enough for customers, but keeping one internal starter account still helps QA and support.",
      nextAction: accountCount > 0
        ? "Keep at least one starter account reserved for internal smoke tests and support."
        : closedRegistration
          ? "Seed one or more starter accounts before launch, or reopen registration."
          : "Optionally seed one internal QA/support account before launch.",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut(
        closedRegistration ? "licenses" : "project",
        closedRegistration ? "starter-account" : "auth-preset",
        closedRegistration ? "Open License Workspace" : "Open Project Workspace"
      ),
      bootstrapAction: accountCount > 0
        ? null
        : createLaunchWorkflowBootstrapAction({
            summary: "Seed a starter account automatically for the current lane.",
            plan: ["starter account"]
          })
    });
  }

  if (accountLoginEnabled && !cardLoginEnabled && !cardRechargeEnabled && activeEntitlementCount <= 0) {
    pushInventoryRecommendation({
      key: "starter_entitlements",
      label: "Internal starter entitlements",
      priority: "recommended",
      status: "recommended",
      target: "At least 1 internal active entitlement",
      current: `${activeEntitlementCount} active`,
      summary: "Account-only lanes benefit from one internal entitlement so QA can exercise runtime gating before the first customer arrives.",
      nextAction: "Prepare one internal entitlement or a private demo account for smoke testing before launch.",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("licenses", "quickstart", "Open License Workspace")
    });
  }

  for (const item of (cardInventoryStates.length ? cardInventoryStates : buildLaunchRecommendedCardInventoryStates(product, policies, []))) {
    firstBatchCardRecommendations.push({
      key: item.key,
      mode: item.mode,
      label: item.label,
      grantType: item.grantType,
      count: item.count,
      prefix: item.prefix,
      inventoryStatus: item.inventoryStatus || "ready",
      currentFresh: item.freshCount ?? 0,
      targetCount: item.targetCount ?? item.count ?? 0,
      refillCount: item.refillCount ?? 0,
      purpose: item.purpose,
      nextAction: item.inventoryStatus === "low"
        ? `Keep ${item.label.toLowerCase()} near ${item.targetCount} fresh cards; refill ${item.refillCount} more now.`
        : item.nextAction,
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("licenses", "cards", "Open License Workspace"),
      setupAction: item.policyId && item.inventoryStatus !== "ready"
        ? createLaunchWorkflowSetupAction({
            key: item.inventoryStatus === "low"
              ? `launch_inventory_refill_${item.mode}`
              : `launch_first_batch_setup_${item.mode}`,
            label: item.inventoryStatus === "low"
              ? (item.mode === "direct_card" ? "Refill Direct-Card Batch" : "Refill Recharge Batch")
              : (item.mode === "direct_card" ? "Create Direct-Card Batch" : "Create Recharge Batch"),
            summary: item.inventoryStatus === "low"
              ? `Top ${item.label.toLowerCase()} back up by ${item.refillCount} fresh cards before the current launch buffer runs dry.`
              : item.nextAction,
            mode: item.mode,
            operation: item.inventoryStatus === "low" ? "restock" : "first_batch_setup"
          })
        : null
    });
  }

  if (accountLoginEnabled && !registerEnabled) {
    firstOpsActions.push({
      key: "starter_account_handoff",
      label: "Rotate and hand off starter credentials",
      timing: "Before launch and at T+0",
      summary: "Securely hand off seed account credentials to QA or support, then replace temporary passwords once the first sign-in succeeds.",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("licenses", "starter-account", "Open License Workspace")
    });
  }

  const runtimeSmokeAction = {
    key: "runtime_smoke",
    label: "Verify first real sign-ins",
    timing: "T+0 to T+30m",
    summary: "Confirm startup bootstrap, login success, local token validation, and first heartbeat on at least one internal machine.",
    workspaceAction: createLaunchWorkflowWorkspaceShortcut("ops", "snapshot", "Open Ops Workspace", {
      reviewMode: "matched",
      routeAction: "review-sessions",
      eventType: "session.login",
      actorType: "account"
    })
  };
  runtimeSmokeAction.recommendedDownload = createLaunchWorkflowOpsDownloadShortcut(runtimeSmokeAction, {
    label: "Runtime smoke summary"
  });
  firstOpsActions.push(runtimeSmokeAction);

  if (cardLoginEnabled || cardRechargeEnabled) {
    const cardRedemptionWatchAction = {
      key: "card_redemption_watch",
      label: "Watch first card redemptions",
      timing: "T+0 to T+2h",
      summary: "Monitor fresh-card consumption, failed redemptions, and whether the first batch needs refill, freeze, or support follow-up.",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("ops", "audit", "Open Ops Workspace", {
        reviewMode: "matched",
        routeAction: "review-audit",
        entityType: "license_key"
      })
    };
    cardRedemptionWatchAction.recommendedDownload = createLaunchWorkflowOpsDownloadShortcut(cardRedemptionWatchAction, {
      label: "Card redemption summary"
    });
    firstOpsActions.push(cardRedemptionWatchAction);
  }

  if (featureConfig.allowVersionCheck !== false || featureConfig.allowNotices !== false) {
    firstOpsActions.push({
      key: "startup_rule_watch",
      label: "Watch notices and version gates",
      timing: "T+0 to T+2h",
      summary: "Confirm launch-day notices, maintenance copy, and version rules are not blocking healthy clients by mistake.",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("release", "versions", "Open Release Workspace")
    });
  }

  const sessionReviewAction = {
    key: "session_review",
    label: "Review early sessions and device state",
    timing: "T+0 to T+4h",
    summary: "Check online sessions, heartbeat churn, device binds, and early blocks so false positives do not hurt the first wave of users.",
    workspaceAction: createLaunchWorkflowWorkspaceShortcut("ops", "sessions", "Open Ops Workspace", {
      reviewMode: "matched",
      routeAction: "review-sessions",
      eventType: "session.login",
      actorType: "account"
    })
  };
  sessionReviewAction.recommendedDownload = createLaunchWorkflowOpsDownloadShortcut(sessionReviewAction, {
    label: "Early session summary"
  });
  firstOpsActions.push(sessionReviewAction);

  return {
    inventoryRecommendations,
    firstBatchCardRecommendations,
    firstOpsActions,
    cardInventoryStates
  };
}

function buildLaunchQuickstartFollowUpPlan({
  product = {},
  policies = [],
  metrics = {},
  launchRecommendations = null,
  operation = "bootstrap"
} = {}) {
  const featureConfig = product?.featureConfig && typeof product.featureConfig === "object"
    ? product.featureConfig
    : {};
  const normalizedOperation = String(operation || "bootstrap").trim().toLowerCase() || "bootstrap";
  const resolvedRecommendations = launchRecommendations && typeof launchRecommendations === "object"
    ? launchRecommendations
    : buildLaunchAuthorizationOperationalPlan({
        product,
        metrics,
        policies
      });
  const firstBatchCardRecommendations = Array.isArray(resolvedRecommendations?.firstBatchCardRecommendations)
    ? resolvedRecommendations.firstBatchCardRecommendations.filter((item) => item?.key || item?.mode)
    : [];
  const firstOpsActions = Array.isArray(resolvedRecommendations?.firstOpsActions)
    ? resolvedRecommendations.firstOpsActions.filter((item) => item?.key)
    : [];
  const actionMap = new Map(firstOpsActions.map((item) => [item.key, item]));
  const hasCardInventoryFlow = firstBatchCardRecommendations.length > 0
    || featureConfig.allowCardLogin !== false
    || featureConfig.allowCardRecharge !== false;
  const preludeActions = [];
  const pushPreludeAction = (action) => {
    if (!action?.key || preludeActions.some((item) => item.key === action.key)) {
      return;
    }
    preludeActions.push(action);
    actionMap.set(action.key, action);
  };
  const createLaunchSummaryDownload = (label = "Launch workflow summary", fileName = "launch-workflow.txt", format = "summary") =>
    createLaunchWorkflowDownloadShortcut("launch_summary", fileName, label, {
      source: "developer-launch-workflow",
      format
    });
  const createLaunchChecklistDownload = (label = "Launch workflow checklist", fileName = "launch-workflow-checklist.txt", format = "checklist") =>
    createLaunchWorkflowDownloadShortcut("launch_checklist", fileName, label, {
      source: "developer-launch-workflow",
      format
    });
  const createLaunchSmokeKitDownload = (label = "Launch smoke kit summary", fileName = "launch-smoke-kit.txt", format = "summary") =>
    createLaunchWorkflowSmokeKitDownloadShortcut(label, fileName, format, {
      productCode: product?.code || null
    });
  const pushLaunchRecheckAction = (summary) => {
    pushPreludeAction({
      key: "launch_recheck",
      label: "Review launch workflow recheck",
      timing: "Immediately after setup",
      summary,
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("launch", "handoff", "Open Launch Workflow"),
      recommendedDownload: createLaunchSummaryDownload()
    });
  };
  const pushInventoryRecheckAction = ({ label, summary, autofocus = "cards", download = "checklist" } = {}) => {
    pushPreludeAction({
      key: "inventory_recheck",
      label: label || "Review starter inventory",
      timing: "Immediately after setup",
      summary: summary || "Confirm starter card inventory is visible and fresh before handing the lane to launch-day QA, sales, or support.",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("licenses", autofocus, "Open License Workspace"),
      recommendedDownload: download === "summary"
        ? createLaunchSummaryDownload()
        : createLaunchChecklistDownload()
    });
  };
  const pushSmokeKitAction = (summary) => {
    pushPreludeAction({
      key: "launch_smoke_kit",
      label: "Download launch smoke kit",
      timing: "Before internal QA",
      summary: summary || "Download the startup request, candidate internal accounts, fresh launch keys, and smoke-test steps for the current lane.",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("launch-smoke", "summary", "Open Launch Smoke"),
      recommendedDownload: createLaunchSmokeKitDownload()
    });
  };
  const preferredKeys = [];

  const pushPreferredKey = (key) => {
    if (!key || preferredKeys.includes(key) || !actionMap.has(key)) {
      return;
    }
    preferredKeys.push(key);
  };

  if (normalizedOperation === "bootstrap") {
    pushLaunchRecheckAction(
      "Confirm authorization readiness, startup gates, and the combined launch checklist moved to the expected state after bootstrap."
    );
    pushSmokeKitAction(
      "Download the current startup request and starter validation material before the first internal smoke run."
    );
    if (hasCardInventoryFlow) {
      pushInventoryRecheckAction({
        label: "Review starter inventory",
        summary: "Confirm the starter card batches are visible with fresh inventory before handing the lane to QA, sales, or support."
      });
    }
    for (const item of preludeActions) {
      pushPreferredKey(item.key);
    }
    if (featureConfig.allowAccountLogin !== false && featureConfig.allowRegister === false) {
      pushPreferredKey("starter_account_handoff");
    }
    pushPreferredKey("runtime_smoke");
    pushPreferredKey("card_redemption_watch");
    pushPreferredKey("startup_rule_watch");
    pushPreferredKey("session_review");
  } else if (normalizedOperation === "first_batch_setup" || normalizedOperation === "restock") {
    pushInventoryRecheckAction({
      label: normalizedOperation === "restock" ? "Review refilled launch inventory" : "Review starter inventory",
      summary: normalizedOperation === "restock"
        ? "Confirm the refilled launch batches are visible and back inside the recommended fresh-card buffer before the next sales or QA wave."
        : "Confirm the starter launch batches are visible and ready before the first rollout handoff."
    });
    pushLaunchRecheckAction(
      normalizedOperation === "restock"
        ? "Confirm launch workflow now shows the lane back inside the recommended inventory buffer."
        : "Confirm launch workflow now shows starter inventory ready for rollout."
    );
    pushSmokeKitAction(
      normalizedOperation === "restock"
        ? "Download the refreshed startup request and launch validation material before the next sales or QA wave."
        : "Download the startup request and the newly staged launch validation material before the first smoke run."
    );
    for (const item of preludeActions) {
      pushPreferredKey(item.key);
    }
    pushPreferredKey("card_redemption_watch");
    pushPreferredKey("runtime_smoke");
    pushPreferredKey("session_review");
    pushPreferredKey("startup_rule_watch");
  } else {
    pushLaunchRecheckAction("Recheck the combined launch workflow after this setup step.");
    pushSmokeKitAction();
    if (hasCardInventoryFlow) {
      pushInventoryRecheckAction({
        summary: "Confirm launch-day starter inventory still matches the selected lane before moving into runtime follow-up."
      });
    }
    for (const item of preludeActions) {
      pushPreferredKey(item.key);
    }
    pushPreferredKey("runtime_smoke");
    pushPreferredKey("session_review");
    pushPreferredKey("card_redemption_watch");
    pushPreferredKey("startup_rule_watch");
  }

  for (const item of firstOpsActions) {
    pushPreferredKey(item.key);
  }

  const preferredOpsAction = firstOpsActions.find((item) => item?.workspaceAction?.key === "ops") || null;
  const launchReviewDownload = createLaunchWorkflowReviewDownloadShortcut(
    normalizedOperation === "restock"
      ? "Launch refill review summary"
      : normalizedOperation === "first_batch_setup"
        ? "Launch inventory review summary"
        : "Launch review summary",
    normalizedOperation === "restock"
      ? "launch-review-restock.txt"
      : normalizedOperation === "first_batch_setup"
        ? "launch-review-inventory.txt"
        : "launch-review.txt",
    "summary",
    preferredOpsAction?.workspaceAction?.params
  );
  const actions = preferredKeys
    .map((key, index) => {
      const item = actionMap.get(key);
      if (!item) {
        return null;
      }
        const nextItem = {
          ...item,
          priority: index === 0 ? "primary" : "secondary"
        };
        if (key === "launch_recheck") {
          nextItem.workspaceAction = createLaunchWorkflowWorkspaceShortcut(
            "launch-review",
            "summary",
            "Open Launch Review",
            preferredOpsAction?.workspaceAction?.params
          );
          nextItem.recommendedDownload = launchReviewDownload;
        }
        return nextItem;
      })
    .filter(Boolean);

  const recommendedDownloads = [];
  const seenDownloadKeys = new Set();
  for (const item of actions) {
    const download = item?.recommendedDownload;
    if (!download?.key || seenDownloadKeys.has(download.key)) {
      continue;
    }
    seenDownloadKeys.add(download.key);
    recommendedDownloads.push({ ...download });
  }

  const primaryAction = actions[0] || null;
  const summaryLead = normalizedOperation === "restock"
    ? "Launch inventory is back at the recommended buffer."
    : normalizedOperation === "first_batch_setup"
      ? "Starter launch inventory is now staged."
      : "Launch quickstart assets are now staged.";
  const nextLabels = actions
    .slice(0, 3)
    .map((item) => item.label || item.key || "follow-up")
    .filter(Boolean);

  return {
    operation: normalizedOperation,
    operationLabel: normalizedOperation === "restock"
      ? "Inventory refill"
      : normalizedOperation === "first_batch_setup"
        ? "First-batch setup"
        : "Launch bootstrap",
    summary: nextLabels.length
      ? `${summaryLead} Next: ${nextLabels.join(" -> ")}.`
      : summaryLead,
    primaryAction,
    actions,
    recommendedDownloads
  };
}

function buildLaunchWorkflowChecklistPayload({
  releasePackage,
  integrationPackage,
  authReadiness = {},
  summaryFileName = "launch-workflow.txt",
  checklistFileName = "launch-workflow-checklist.txt",
  zipFileName = "launch-workflow.zip",
  handoffZipFileName = "launch-workflow-handoff.zip",
  handoffChecksumsFileName = "launch-workflow-handoff-sha256.txt"
}) {
  const readiness = releasePackage?.manifest?.release?.readiness || {};
  const deliverySummary = releasePackage?.deliverySummary || {};
  const deliveryChecklist = releasePackage?.deliveryChecklist || {};
  const startupPreview = integrationPackage?.manifest?.startupPreview || releasePackage?.manifest?.release?.startupPreview || {};
  const startupDecision = startupPreview.decision || {};
  const tokenKeySummary = startupPreview.tokenKeySummary || {};
  const clientHardening = startupPreview.clientHardening || integrationPackage?.manifest?.clientHardening || {};
  const tokenKeyTotal = tokenKeySummary.totalKeys ?? integrationPackage?.manifest?.tokenKeys?.length ?? 0;
  const releaseAutofocus = pickLaunchWorkflowReleaseAutofocus(readiness);
  const items = [
    {
      key: "release_readiness",
      label: "Release readiness",
      status: normalizeLaunchWorkflowChecklistStatus(readiness.status || "unknown"),
      summary: readiness.message || deliverySummary.summary || "Review the release lane before rollout.",
      artifact: releasePackage?.summaryFileName || "release-package.txt",
      nextAction: Array.isArray(readiness.nextActions) && readiness.nextActions[0]
        ? readiness.nextActions[0]
        : "Regenerate the release package after fixing blocking or review items.",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("release", releaseAutofocus),
      recommendedDownload: createLaunchWorkflowDownloadShortcut(
        "release_summary",
        releasePackage?.summaryFileName || "release-package.txt",
        "Release summary"
      )
    },
    {
      key: "release_delivery_checklist",
      label: "Release delivery checklist",
      status: normalizeLaunchWorkflowChecklistStatus(deliveryChecklist.status || "unknown"),
      summary: `pass ${deliveryChecklist.passItems ?? 0} | review ${deliveryChecklist.reviewItems ?? 0} | block ${deliveryChecklist.blockItems ?? 0}`,
      artifact: `${summaryFileName} | ${checklistFileName}`,
      nextAction: deliveryChecklist.blockItems > 0
        ? "Resolve block items from the release delivery checklist before shipping."
        : deliveryChecklist.reviewItems > 0
          ? "Review the remaining checklist items before handing the lane to release operations."
          : "The release delivery checklist looks aligned for this lane.",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("launch", "handoff"),
      recommendedDownload: createLaunchWorkflowDownloadShortcut(
        "launch_checklist",
        checklistFileName,
        "Launch workflow checklist"
      )
    },
    {
      key: "authorization_readiness",
      label: "Authorization readiness",
      status: authReadiness.status || "review",
      summary: authReadiness.summary || "Review login paths, starter policies, and sellable card inventory before launch.",
      artifact: `modes=${authReadiness.loginModeSummary || "-"} | policies=${authReadiness.inventory?.policies ?? 0} | freshCards=${authReadiness.inventory?.freshCards ?? 0} | accounts=${authReadiness.inventory?.accounts ?? 0}`,
      nextAction: authReadiness.bootstrapSummary || (
        Array.isArray(authReadiness.nextActions) && authReadiness.nextActions[0]
        ? authReadiness.nextActions[0]
        : "Review authorization paths, policies, and card inventory before rollout."
      ),
      workspaceAction: createLaunchWorkflowWorkspaceShortcut(
        authReadiness.workspaceKey || "licenses",
        authReadiness.workspaceAutofocus || "policy-control",
        authReadiness.workspaceLabel || "Open License Workspace"
      ),
      recommendedDownload: null,
      bootstrapAction: authReadiness.bootstrapAction || null,
      setupAction: authReadiness.firstBatchSetupAction || null
    },
    {
      key: "startup_bootstrap",
      label: "Startup bootstrap decision",
      status: startupDecision.ready === false ? "block" : startupDecision.status === "ready" ? "pass" : "review",
      summary: startupDecision.message || `Startup decision is ${startupDecision.status || "unknown"}.`,
      artifact: integrationPackage?.fileName || "integration-package.json",
      nextAction: startupDecision.ready === false
        ? "Fix the startup blockers, then regenerate the launch workflow for the same channel."
        : "Keep the startup bootstrap defaults aligned with the selected channel.",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("integration", "startup"),
      recommendedDownload: createLaunchWorkflowDownloadShortcut(
        "integration_env",
        integrationPackage?.snippets?.envFileName || "project.env",
        "Integration env"
      )
    },
    {
      key: "client_hardening",
      label: "Client hardening profile",
      status: clientHardening.profile === "strict" ? "pass" : "review",
      summary: clientHardening.summary || `Profile ${String(clientHardening.profile || "unknown").toUpperCase()}`,
      artifact: integrationPackage?.snippets?.hardeningFileName || "project-hardening-guide.txt",
      nextAction: clientHardening.nextAction || "Confirm whether this lane should stay strict, balanced, or relaxed before handoff.",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("integration", "hardening"),
      recommendedDownload: createLaunchWorkflowDownloadShortcut(
        "integration_host_skeleton",
        integrationPackage?.snippets?.hostSkeletonFileName || "project-host-skeleton.cpp",
        "Host skeleton"
      )
    },
    {
      key: "token_keys",
      label: "Token key coverage",
      status: tokenKeyTotal > 0 ? "pass" : "review",
      summary: tokenKeyTotal > 0
        ? `${tokenKeyTotal} public key(s) available${tokenKeySummary.activeKeyId ? `, active ${tokenKeySummary.activeKeyId}` : ""}.`
        : "No embedded token public keys were included in this startup preview.",
      artifact: integrationPackage?.snippets?.hostConfigFileName || "rocksolid_host_config.env",
      nextAction: tokenKeyTotal > 0
        ? "Keep the embedded key list in sync with active token verification keys."
        : "Decide whether local token verification should ship with embedded public keys for this lane.",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("integration", "startup"),
      recommendedDownload: createLaunchWorkflowDownloadShortcut(
        "integration_host_config",
        integrationPackage?.snippets?.hostConfigFileName || "rocksolid_host_config.env",
        "Integration host config"
      )
    },
    {
      key: "launch_handoff_package",
      label: "Launch handoff package",
      status: "pass",
      summary: "A curated recommended handoff zip and the full launch workflow archive are both available for release, QA, and integration handoff.",
      artifact: `${handoffZipFileName} | ${handoffChecksumsFileName} | ${zipFileName} | ${summaryFileName} | ${checklistFileName}`,
      nextAction: "Send the recommended handoff zip to release, QA, and integration teammates, and keep the full workflow zip for archive or deep review.",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("launch", "handoff"),
      recommendedDownload: createLaunchWorkflowDownloadShortcut(
        "launch_handoff_zip",
        handoffZipFileName,
        "Recommended handoff zip"
      )
    }
  ];

  const passItems = items.filter((item) => item.status === "pass").length;
  const reviewItems = items.filter((item) => item.status === "review").length;
  const blockItems = items.filter((item) => item.status === "block").length;
  const status = blockItems > 0 ? "hold" : reviewItems > 0 ? "attention" : "ready";

  return {
    status,
    ready: status === "ready",
    passItems,
    reviewItems,
    blockItems,
    items
  };
}

function buildLaunchWorkflowSummaryPayload({
  product,
  channel = "stable",
  releasePackage,
  integrationPackage,
  authReadiness = {},
  workflowChecklist = {},
  fileName = "launch-workflow.json",
  summaryFileName = "launch-workflow.txt",
  checklistFileName = "launch-workflow-checklist.txt",
  zipFileName = "launch-workflow.zip",
  handoffZipFileName = "launch-workflow-handoff.zip",
  handoffChecksumsFileName = "launch-workflow-handoff-sha256.txt"
}) {
  const readiness = releasePackage?.manifest?.release?.readiness || {};
  const deliverySummary = releasePackage?.deliverySummary || {};
  const startupPreview = integrationPackage?.manifest?.startupPreview || releasePackage?.manifest?.release?.startupPreview || {};
  const startupDecision = startupPreview.decision || {};
  const startupRequest = startupPreview.request || integrationPackage?.manifest?.startupDefaults || {};
  const tokenKeySummary = startupPreview.tokenKeySummary || {};
  const clientHardening = startupPreview.clientHardening || integrationPackage?.manifest?.clientHardening || {};
  const tokenKeyTotal = tokenKeySummary.totalKeys ?? integrationPackage?.manifest?.tokenKeys?.length ?? 0;
  const workflowStatus = workflowChecklist.status || (
    readiness.status === "hold" || startupDecision.ready === false
      ? "hold"
      : readiness.status === "attention" || clientHardening.profile !== "strict"
        ? "attention"
        : "ready"
  );
  const workflowTitle = workflowStatus === "hold"
    ? "Hold before launch"
    : workflowStatus === "attention"
      ? "Review before launch"
      : "Launch lane looks aligned";
  const recommendedDownloads = [
    {
      key: "launch_handoff_zip",
      label: "Recommended handoff zip",
      fileName: handoffZipFileName
    },
    {
      key: "launch_handoff_checksums",
      label: "Recommended handoff checksums",
      fileName: handoffChecksumsFileName
    },
    {
      key: "launch_workflow_zip",
      label: "Combined launch workflow zip",
      fileName: zipFileName
    },
    {
      key: "launch_summary",
      label: "Launch workflow summary",
      fileName: summaryFileName
    },
    {
      key: "launch_checklist",
      label: "Launch workflow checklist",
      fileName: checklistFileName
    },
    {
      key: "release_summary",
      label: "Release summary",
      fileName: releasePackage?.summaryFileName || "release-package.txt"
    },
    {
      key: "integration_env",
      label: "Integration env",
      fileName: integrationPackage?.snippets?.envFileName || "project.env"
    },
    {
      key: "integration_host_config",
      label: "Integration host config",
      fileName: integrationPackage?.snippets?.hostConfigFileName || "rocksolid_host_config.env"
    },
    {
      key: "integration_host_skeleton",
      label: "Host skeleton",
      fileName: integrationPackage?.snippets?.hostSkeletonFileName || "project-host-skeleton.cpp"
    }
  ];
  const nextActions = [];
  for (const item of Array.isArray(readiness.nextActions) ? readiness.nextActions.slice(0, 2) : []) {
    nextActions.push(item);
  }
  if (clientHardening.nextAction) {
    nextActions.push(clientHardening.nextAction);
  }
  for (const item of Array.isArray(authReadiness.nextActions) ? authReadiness.nextActions.slice(0, 2) : []) {
    if (!nextActions.includes(item)) {
      nextActions.push(item);
    }
  }
  if (!nextActions.length) {
    nextActions.push("Download the recommended handoff zip and review the launch checklist before rollout.");
  } else if (workflowStatus === "ready") {
    nextActions.push("Download the recommended handoff zip for release, QA, and integration handoff, and keep the full workflow zip for archive.");
  }

  const blockers = [];
  for (const item of Array.isArray(readiness.checks) ? readiness.checks : []) {
    if (String(item.level || "").toLowerCase() === "blocking") {
      blockers.push(`${item.label || item.key || "release"}: ${item.summary || "-"}`);
    }
  }
  if (startupDecision.ready === false && startupDecision.message) {
    blockers.push(`startup: ${startupDecision.message}`);
  }
  if (authReadiness.status === "block") {
    for (const item of Array.isArray(authReadiness.issues) ? authReadiness.issues.slice(0, 3) : []) {
      blockers.push(`authorization: ${item}`);
    }
  }

  const featureConfig = product?.featureConfig && typeof product.featureConfig === "object"
    ? product.featureConfig
    : {};
  const readinessChecks = Array.isArray(readiness.checks) ? readiness.checks : [];
  const findReadinessCheck = (key) => readinessChecks.find((item) => item?.key === key) || null;
  const noticeCheck = findReadinessCheck("notices");
  const versionRuleCheck = findReadinessCheck("version_rule");
  const downloadUrlCheck = findReadinessCheck("download_url");
  const runtimeCoverageCheck = findReadinessCheck("runtime_coverage");
  const workspaceActions = [];
  const pushWorkspaceAction = (action) => {
    if (!action || !action.key) {
      return;
    }
    if (workspaceActions.some((item) => item.key === action.key)) {
      return;
    }
    workspaceActions.push(action);
  };

  if ((product?.status ?? "active") !== "active") {
    pushWorkspaceAction({
      key: "project",
      label: "Open Project Workspace",
      priority: "primary",
      reason: `Project status is ${product?.status || "inactive"} and should be switched back to active before rollout.`,
      autofocus: "detail"
    });
  }
  if (featureConfig.allowVersionCheck === false || featureConfig.allowNotices === false) {
    pushWorkspaceAction({
      key: "project",
      label: "Open Project Workspace",
      priority: workspaceActions.length ? "secondary" : "primary",
      reason: runtimeCoverageCheck?.summary || "Project feature toggles should be reviewed before launch.",
      autofocus: "features"
    });
  }
  if (startupDecision.ready === false || tokenKeyTotal === 0) {
    pushWorkspaceAction({
      key: "integration",
      label: "Open Integration Workspace",
      priority: workspaceActions.length ? "secondary" : "primary",
      reason: startupDecision.ready === false
        ? (startupDecision.recommendedAction || startupDecision.message || "Startup bootstrap still needs integration-side fixes.")
        : "Token key coverage should be reviewed in the integration package before rollout.",
      autofocus: "startup"
    });
  }
  if (
    readiness.status === "hold"
    || readiness.status === "attention"
  ) {
    const releaseAutofocus = pickLaunchWorkflowReleaseAutofocus(readiness);
    pushWorkspaceAction({
      key: "release",
      label: "Open Release Workspace",
      priority: workspaceActions.length ? "secondary" : "primary",
      reason: readiness.status === "hold"
        ? (readiness.message || "Release blockers should be cleared before launch.")
        : readiness.status === "attention"
          ? (readiness.message || "Release readiness still needs a final pass.")
          : "Release rules and notices should be reviewed before handoff.",
      autofocus: releaseAutofocus
    });
  }
  if (clientHardening.profile !== "strict") {
    pushWorkspaceAction({
      key: "integration",
      label: "Open Integration Workspace",
      priority: workspaceActions.length ? "secondary" : "primary",
      reason: "Client hardening settings still need confirmation for this lane.",
      autofocus: "hardening"
    });
  }
  if (authReadiness.status === "block" || authReadiness.status === "review") {
    pushWorkspaceAction({
      key: authReadiness.workspaceKey || "licenses",
      label: authReadiness.workspaceLabel
        || ((authReadiness.workspaceKey || "licenses") === "project" ? "Open Project Workspace" : "Open License Workspace"),
      priority: workspaceActions.length ? "secondary" : "primary",
      reason: authReadiness.message || "Review authorization paths and starter inventory before launch.",
      autofocus: authReadiness.workspaceAutofocus || "policy-control"
    });
  }
  const opsWorkspaceAction = Array.isArray(authReadiness.launchRecommendations?.firstOpsActions)
    ? authReadiness.launchRecommendations.firstOpsActions.find((item) => item?.workspaceAction?.key === "ops")?.workspaceAction
    : null;
  if (opsWorkspaceAction) {
    pushWorkspaceAction({
      key: "ops",
      label: opsWorkspaceAction.label || "Open Ops Workspace",
      priority: workspaceActions.length ? "secondary" : "primary",
      reason: "Use Developer Ops to watch first sign-ins, early sessions, device state, and scoped audit signals after rollout.",
      autofocus: opsWorkspaceAction.autofocus || "snapshot",
      params: opsWorkspaceAction.params && typeof opsWorkspaceAction.params === "object"
        ? { ...opsWorkspaceAction.params }
        : {}
    });
  }
  pushWorkspaceAction({
    key: "launch",
    label: "Stay in Launch Workflow",
    priority: workspaceActions.length ? "secondary" : "primary",
    reason: workflowStatus === "ready"
      ? "This lane looks aligned. Download the recommended handoff zip and keep the full workflow zip for archive."
      : "Use the launch workflow workspace to keep release, startup, and handoff context together while you finish review.",
    autofocus: "handoff"
  });
  pushWorkspaceAction({
    key: "project",
    label: "Open Project Workspace",
    priority: workspaceActions.length ? "secondary" : "primary",
    reason: "Use the project workspace when you need to adjust project status, feature toggles, or download handoff assets inline.",
    autofocus: "detail"
  });

  const recommendedWorkspace = workspaceActions[0] || {
    key: "launch",
    label: "Stay in Launch Workflow",
    priority: "primary",
    reason: "Use the launch workflow workspace to review this lane end-to-end.",
    autofocus: "handoff"
  };
  const checklistItems = Array.isArray(workflowChecklist.items) ? workflowChecklist.items : [];
  const actionPlan = [];
  const pushActionPlan = (step) => {
    if (!step || !step.key) {
      return;
    }
    if (actionPlan.some((item) => item.key === step.key)) {
      return;
    }
    actionPlan.push(step);
  };
  const actionableChecklistItems = checklistItems.filter((item) => item && (item.status === "block" || item.status === "review"));
  for (const [index, item] of actionableChecklistItems.slice(0, 3).entries()) {
    pushActionPlan(createLaunchWorkflowActionPlanStep({
      key: item.key,
      title: item.label || item.key || "Launch step",
      summary: item.nextAction || item.summary || "-",
      status: item.status || "review",
      priority: index === 0 ? "primary" : "secondary",
      workspaceAction: item.workspaceAction || null,
      recommendedDownload: item.recommendedDownload || null,
      bootstrapAction: item.bootstrapAction || null,
      setupAction: item.setupAction || null
    }));
  }
  if (
    (startupDecision.ready === false || tokenKeyTotal === 0 || clientHardening.profile !== "strict")
    && !actionPlan.some((item) => item.workspaceAction?.key === "integration")
  ) {
    pushActionPlan(createLaunchWorkflowActionPlanStep({
      key: "integration_follow_up",
      title: "Clear integration-side launch blockers",
      summary: startupDecision.recommendedAction
        || startupDecision.message
        || clientHardening.nextAction
        || "Review startup bootstrap, token key coverage, and host-side hardening before launch.",
      status: startupDecision.ready === false ? "block" : "review",
      priority: actionPlan.length ? "secondary" : "primary",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("integration", startupDecision.ready === false ? "startup" : "hardening"),
      recommendedDownload: createLaunchWorkflowDownloadShortcut(
        startupDecision.ready === false ? "integration_env" : "integration_host_skeleton",
        startupDecision.ready === false
          ? (integrationPackage?.snippets?.envFileName || "project.env")
          : (integrationPackage?.snippets?.hostSkeletonFileName || "project-host-skeleton.cpp"),
        startupDecision.ready === false ? "Integration env" : "Host skeleton"
      )
    }));
  }
  if (
    (authReadiness.status === "block" || authReadiness.status === "review")
    && !actionPlan.some((item) => item.workspaceAction?.key === (authReadiness.workspaceKey || "licenses"))
  ) {
    pushActionPlan(createLaunchWorkflowActionPlanStep({
      key: "authorization_follow_up",
      title: "Finish authorization staging",
      summary: Array.isArray(authReadiness.nextActions) && authReadiness.nextActions[0]
        ? authReadiness.nextActions[0]
        : (authReadiness.message || "Review starter policies, accounts, and card inventory before launch."),
      status: authReadiness.status || "review",
      priority: actionPlan.length ? "secondary" : "primary",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut(
        authReadiness.workspaceKey || "licenses",
        authReadiness.workspaceAutofocus || "policy-control",
        authReadiness.workspaceLabel || "Open License Workspace"
      ),
      setupAction: authReadiness.firstBatchSetupAction || null
    }));
  }
  if (authReadiness.firstBatchSetupAction && !actionPlan.some((item) => item.setupAction?.key === authReadiness.firstBatchSetupAction.key)) {
    const inventorySetupAction = authReadiness.firstBatchSetupAction;
    const inventorySetupIsRestock = inventorySetupAction?.operation === "restock";
    pushActionPlan(createLaunchWorkflowActionPlanStep({
      key: "first_batch_setup",
      title: inventorySetupIsRestock ? "Refill launch card inventory" : "Create recommended launch card inventory",
      summary: authReadiness.firstBatchSetupSummary
        || (inventorySetupIsRestock
          ? "Top the current launch buffer back up before early sales consume the remaining fresh cards."
          : "Create the recommended direct-card and recharge starter batches before rollout."),
      status: (authReadiness.firstBatchSetupEligible || authReadiness.inventoryRefillEligible) ? "review" : "pass",
      priority: actionPlan.length ? "secondary" : "primary",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("licenses", "cards", "Open License Workspace"),
      setupAction: inventorySetupAction
    }));
  }
  const firstOpsActions = Array.isArray(authReadiness.launchRecommendations?.firstOpsActions)
    ? authReadiness.launchRecommendations.firstOpsActions
    : [];
  const primaryOpsAction = firstOpsActions[0] || null;
  if (primaryOpsAction && !actionPlan.some((item) => item.workspaceAction?.key === "ops")) {
    pushActionPlan(createLaunchWorkflowActionPlanStep({
      key: "launch_day_ops_watch",
      title: "Start launch-day operations watch",
      summary: `${primaryOpsAction.timing || "Post-launch"} | ${primaryOpsAction.summary || "Review first-wave runtime signals in Developer Ops."}`,
      status: workflowStatus === "ready" ? "pass" : "review",
      priority: !actionPlan.length && workflowStatus === "ready" ? "primary" : "secondary",
      workspaceAction: primaryOpsAction.workspaceAction || null,
      recommendedDownload: primaryOpsAction.recommendedDownload || null
    }));
  }
  if (!actionPlan.length || (workflowStatus === "ready" && !actionPlan.some((item) => item.key === "launch_handoff_zip"))) {
    pushActionPlan(createLaunchWorkflowActionPlanStep({
      key: "launch_handoff_zip",
      title: "Send the recommended handoff zip",
      summary: "Share the curated handoff package with release, QA, and integration teammates.",
      status: workflowStatus === "ready" ? "pass" : "review",
      priority: actionPlan.length ? "secondary" : "primary",
      recommendedDownload: createLaunchWorkflowDownloadShortcut("launch_handoff_zip", handoffZipFileName, "Recommended handoff zip")
    }));
    pushActionPlan(createLaunchWorkflowActionPlanStep({
      key: "launch_checklist",
      title: "Keep the launch checklist nearby",
      summary: "Use the checklist while doing the final rollout review for this lane.",
      status: workflowStatus === "ready" ? "pass" : "review",
      priority: "secondary",
      recommendedDownload: createLaunchWorkflowDownloadShortcut("launch_checklist", checklistFileName, "Launch workflow checklist")
    }));
  }
  pushActionPlan(createLaunchWorkflowActionPlanStep({
    key: "launch_workspace",
    title: workflowStatus === "ready" ? "Keep the lane in launch workflow for final review" : "Use launch workflow as the control tower",
    summary: workflowStatus === "ready"
      ? "Keep the combined launch workflow view handy while release, QA, and integration handoff happens."
      : "Use the combined launch workflow view to keep release, startup, and handoff context together while you clear review items.",
    status: workflowStatus === "ready" ? "pass" : workflowStatus === "hold" ? "block" : "review",
    priority: actionPlan.length ? "secondary" : "primary",
    workspaceAction: createLaunchWorkflowWorkspaceShortcut("launch", "handoff")
  }));

  return {
    status: workflowStatus,
    title: workflowTitle,
    message: readiness.message || deliverySummary.summary || startupDecision.message || clientHardening.summary || "No launch workflow summary available.",
    channel,
    candidateVersion: readiness.candidateVersion || deliverySummary.candidateVersion || startupRequest.clientVersion || null,
    releaseStatus: readiness.status || "unknown",
    startupStatus: startupDecision.status || "unknown",
    startupReady: startupDecision.ready !== false,
    clientHardeningProfile: clientHardening.profile || "unknown",
    clientHardeningTitle: clientHardening.title || null,
    authorizationStatus: authReadiness.status || "unknown",
    authorizationSummary: authReadiness.summary || null,
    authorizationMessage: authReadiness.message || null,
    authorizationModeSummary: authReadiness.loginModeSummary || null,
    authorizationInventory: authReadiness.inventory || {},
    authorizationLaunchRecommendations: authReadiness.launchRecommendations || {
      inventoryRecommendations: [],
      firstBatchCardRecommendations: [],
      firstOpsActions: []
    },
    checklistStatus: workflowChecklist.status || "unknown",
    checklistCounts: {
      pass: workflowChecklist.passItems ?? 0,
      review: workflowChecklist.reviewItems ?? 0,
      block: workflowChecklist.blockItems ?? 0
    },
    tokenKeyTotal,
      activeKeyId: tokenKeySummary.activeKeyId || null,
      launchBootstrapAction: authReadiness.bootstrapAction || null,
      launchBootstrapSummary: authReadiness.bootstrapSummary || null,
      launchFirstBatchSetupAction: authReadiness.firstBatchSetupAction || null,
      launchFirstBatchSetupSummary: authReadiness.firstBatchSetupSummary || null,
      recommendedDownloads,
      downloadSummary: recommendedDownloads.map((item) => item.label).join(" + "),
      recommendedWorkspace,
      workspaceActions,
      actionPlan,
    actionPlanSummary: actionPlan.map((item) => item.title || item.key || "step").join(" -> "),
    nextActions,
    blockers,
    projectCode: product?.code || null
  };
}

function buildLaunchWorkflowPackageSummaryText(payload = {}) {
  const manifest = payload.manifest || {};
  const project = manifest.project || {};
  const workflowSummary = payload.workflowSummary || manifest.workflowSummary || {};
  const workflowChecklist = payload.workflowChecklist || manifest.workflowChecklist || {};
  const releasePackage = payload.releasePackage || {};
  const integrationPackage = payload.integrationPackage || {};
  const formatWorkspaceActionParams = (params = null) => {
    const entries = params && typeof params === "object"
      ? Object.entries(params).filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "")
      : [];
    return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(",") : "";
  };
  const formatWorkspaceActionText = (action = null) => {
    if (!action) {
      return "-";
    }
    const paramsText = formatWorkspaceActionParams(action.params);
    return `${action.label || action.key || "-"}@${action.autofocus || "-"}${paramsText ? `?${paramsText}` : ""}`;
  };
  const lines = [
    "RockSolid Launch Workflow Package",
    `Generated At: ${manifest.generatedAt || ""}`,
    `Project Code: ${project.code || ""}`,
    `Project Name: ${project.name || ""}`,
    `Channel: ${workflowSummary.channel || manifest.channel || "stable"}`,
    `Workflow Status: ${String(workflowSummary.status || "unknown").toUpperCase()}`,
    `Workflow Title: ${workflowSummary.title || "-"}`,
    `Candidate Version: ${workflowSummary.candidateVersion || "-"}`,
    `Release Status: ${String(workflowSummary.releaseStatus || "unknown").toUpperCase()}`,
    `Startup Status: ${String(workflowSummary.startupStatus || "unknown").toUpperCase()}`,
    `Authorization Status: ${String(workflowSummary.authorizationStatus || "unknown").toUpperCase()}`,
    `Authorization Summary: ${workflowSummary.authorizationSummary || "-"}`,
    `Client Hardening: ${String(workflowSummary.clientHardeningProfile || "unknown").toUpperCase()}`,
    `Token Keys: ${workflowSummary.tokenKeyTotal ?? 0}${workflowSummary.activeKeyId ? ` | active=${workflowSummary.activeKeyId}` : ""}`,
    `Checklist: ${String(workflowChecklist.status || "unknown").toUpperCase()} | pass=${workflowChecklist.passItems ?? 0} | review=${workflowChecklist.reviewItems ?? 0} | block=${workflowChecklist.blockItems ?? 0}`,
    `Message: ${workflowSummary.message || "-"}`,
    ""
  ];

  const recommendedDownloads = Array.isArray(workflowSummary.recommendedDownloads) ? workflowSummary.recommendedDownloads : [];
  const recommendedWorkspace = workflowSummary.recommendedWorkspace || {};
  if (recommendedDownloads.length) {
    lines.push("Recommended Downloads:");
    for (const item of recommendedDownloads) {
      lines.push(`- ${item.label || item.key || "download"} | ${item.fileName || "-"}`);
    }
    lines.push("");
  }

  if (recommendedWorkspace.label || recommendedWorkspace.key) {
    lines.push("Recommended Workspace:");
    lines.push(`- ${recommendedWorkspace.label || recommendedWorkspace.key || "-"}`);
    lines.push(`- reason: ${recommendedWorkspace.reason || "-"}`);
    lines.push("");
  }

  if (workflowSummary.launchBootstrapAction?.label) {
    lines.push("Launch Bootstrap:");
    lines.push(`- ${workflowSummary.launchBootstrapAction.label}`);
    lines.push(`- summary: ${workflowSummary.launchBootstrapSummary || workflowSummary.launchBootstrapAction.summary || "-"}`);
    if (Array.isArray(workflowSummary.launchBootstrapAction.plan) && workflowSummary.launchBootstrapAction.plan.length) {
      lines.push(`- plan: ${workflowSummary.launchBootstrapAction.plan.join(" -> ")}`);
    }
    lines.push("");
  }

  if (workflowSummary.launchFirstBatchSetupAction?.label) {
    lines.push("Card Inventory Setup:");
    lines.push(`- ${workflowSummary.launchFirstBatchSetupAction.label}`);
    lines.push(`- summary: ${workflowSummary.launchFirstBatchSetupSummary || workflowSummary.launchFirstBatchSetupAction.summary || "-"}`);
    lines.push(`- mode: ${workflowSummary.launchFirstBatchSetupAction.mode || "recommended"}`);
    lines.push(`- operation: ${workflowSummary.launchFirstBatchSetupAction.operation || "first_batch_setup"}`);
    lines.push("");
  }

  const authorizationRecommendations = workflowSummary.authorizationLaunchRecommendations || {};
  const inventoryRecommendations = Array.isArray(authorizationRecommendations.inventoryRecommendations)
    ? authorizationRecommendations.inventoryRecommendations
    : [];
  if (inventoryRecommendations.length) {
    lines.push("Initial Inventory Recommendations:");
    for (const item of inventoryRecommendations) {
      lines.push(`- [${String(item.priority || "recommended").toUpperCase()}][${String(item.status || "unknown").toUpperCase()}] ${item.label || item.key || "inventory"} | target=${item.target || "-"} | current=${item.current || "-"} | ${item.nextAction || item.summary || "-"}`);
    }
    lines.push("");
  }

  const firstBatchCardRecommendations = Array.isArray(authorizationRecommendations.firstBatchCardRecommendations)
    ? authorizationRecommendations.firstBatchCardRecommendations
    : [];
  if (firstBatchCardRecommendations.length) {
    lines.push("First Batch Card Suggestions:");
    for (const item of firstBatchCardRecommendations) {
        lines.push(`- ${item.label || item.key || "batch"} | count=${item.count ?? 0} | current=${item.currentFresh ?? 0} | target=${item.targetCount ?? item.count ?? 0} | status=${String(item.inventoryStatus || "ready").toUpperCase()} | grant=${item.grantType || "-"} | prefix=${item.prefix || "-"} | purpose=${item.purpose || "-"} | next=${item.nextAction || "-"}${item.setupAction ? ` | setup=${item.setupAction.label || item.setupAction.key || "-"}@${item.setupAction.mode || "recommended"}:${item.setupAction.operation || "first_batch_setup"}` : ""}`);
      }
      lines.push("");
  }

  const firstOpsActions = Array.isArray(authorizationRecommendations.firstOpsActions)
    ? authorizationRecommendations.firstOpsActions
    : [];
  if (firstOpsActions.length) {
    lines.push("First Ops Actions:");
    for (const item of firstOpsActions) {
      lines.push(`- ${item.label || item.key || "ops"} | timing=${item.timing || "-"} | ${item.summary || "-"}${item.workspaceAction ? ` | workspace=${formatWorkspaceActionText(item.workspaceAction)}` : ""}${item.recommendedDownload ? ` | download=${item.recommendedDownload.label || item.recommendedDownload.key || "-"}:${item.recommendedDownload.fileName || "-"}` : ""}`);
    }
    lines.push("");
  }

  const actionPlan = Array.isArray(workflowSummary.actionPlan) ? workflowSummary.actionPlan : [];
  if (actionPlan.length) {
    lines.push("Action Plan:");
    for (const item of actionPlan) {
      lines.push(
          `- ${item.title || item.key || "step"} | ${String(item.priority || "secondary").toUpperCase()} | ${item.summary || "-"}${item.workspaceAction ? ` | workspace=${formatWorkspaceActionText(item.workspaceAction)}` : ""}${item.recommendedDownload ? ` | download=${item.recommendedDownload.label || item.recommendedDownload.key || "-"}:${item.recommendedDownload.fileName || "-"}` : ""}${item.bootstrapAction ? ` | bootstrap=${item.bootstrapAction.label || item.bootstrapAction.key || "-"}` : ""}${item.setupAction ? ` | setup=${item.setupAction.label || item.setupAction.key || "-"}@${item.setupAction.mode || "recommended"}:${item.setupAction.operation || "first_batch_setup"}` : ""}`
      );
    }
    lines.push("");
  }

  const workspaceActions = Array.isArray(workflowSummary.workspaceActions) ? workflowSummary.workspaceActions : [];
  if (workspaceActions.length) {
    lines.push("Workspace Path:");
    for (const item of workspaceActions) {
      lines.push(
        `- ${item.label || item.key || "workspace"} | ${String(item.priority || "secondary").toUpperCase()} | focus=${item.autofocus || "-"}${formatWorkspaceActionParams(item.params) ? ` | filters=${formatWorkspaceActionParams(item.params)}` : ""} | reason=${item.reason || "-"}`
      );
    }
    lines.push("");
  }

  const blockers = Array.isArray(workflowSummary.blockers) ? workflowSummary.blockers : [];
  lines.push("Workflow Blockers:");
  if (blockers.length) {
    for (const item of blockers) {
      lines.push(`- ${item}`);
    }
  } else {
    lines.push("- none");
  }
  lines.push("");

  const nextActions = Array.isArray(workflowSummary.nextActions) ? workflowSummary.nextActions : [];
  if (nextActions.length) {
    lines.push("Recommended Next Actions:");
    for (const item of nextActions) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  const checklistItems = Array.isArray(workflowChecklist.items) ? workflowChecklist.items : [];
  if (checklistItems.length) {
    lines.push("Workflow Checklist:");
    for (const item of checklistItems) {
      lines.push(`- [${String(item.status || "unknown").toUpperCase()}] ${item.label || item.key || "item"} | ${item.summary || "-"} | artifact=${item.artifact || "-"} | next=${item.nextAction || "-"}${item.workspaceAction ? ` | workspace=${formatWorkspaceActionText(item.workspaceAction)}` : ""}${item.recommendedDownload ? ` | download=${item.recommendedDownload.label || item.recommendedDownload.key || "-"}:${item.recommendedDownload.fileName || "-"}` : ""}${item.bootstrapAction ? ` | bootstrap=${item.bootstrapAction.label || item.bootstrapAction.key || "-"}` : ""}`);
    }
    lines.push("");
  }

  lines.push("Linked Packages:");
  lines.push(`- release=${releasePackage.fileName || "-"}`);
  lines.push(`- releaseSummary=${releasePackage.summaryFileName || "-"}`);
  lines.push(`- integration=${integrationPackage.fileName || "-"}`);
  lines.push(`- integrationEnv=${integrationPackage.snippets?.envFileName || "-"}`);
  lines.push(`- hostConfig=${integrationPackage.snippets?.hostConfigFileName || "-"}`);
  lines.push(`- hostSkeleton=${integrationPackage.snippets?.hostSkeletonFileName || "-"}`);

  return lines.join("\n");
}

function buildLaunchWorkflowChecklistText(payload = {}) {
  const workflowSummary = payload.workflowSummary || payload.manifest?.workflowSummary || {};
  const workflowChecklist = payload.workflowChecklist || payload.manifest?.workflowChecklist || {};
  const authorizationRecommendations = workflowSummary.authorizationLaunchRecommendations || {};
  const formatWorkspaceActionParams = (params = null) => {
    const entries = params && typeof params === "object"
      ? Object.entries(params).filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "")
      : [];
    return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(",") : "";
  };
  const lines = [
    "RockSolid Launch Workflow Checklist",
    `Status: ${String(workflowChecklist.status || "unknown").toUpperCase()} | pass=${workflowChecklist.passItems ?? 0} | review=${workflowChecklist.reviewItems ?? 0} | block=${workflowChecklist.blockItems ?? 0}`,
    `Workflow Title: ${workflowSummary.title || "-"}`,
    `Message: ${workflowSummary.message || "-"}`,
    ""
  ];

  for (const item of Array.isArray(workflowChecklist.items) ? workflowChecklist.items : []) {
    lines.push(`[${String(item.status || "unknown").toUpperCase()}] ${item.label || item.key || "item"}`);
    lines.push(`summary: ${item.summary || "-"}`);
    lines.push(`artifact: ${item.artifact || "-"}`);
    lines.push(`next: ${item.nextAction || "-"}`);
    if (item.workspaceAction) {
      lines.push(`workspace: ${item.workspaceAction.label || item.workspaceAction.key || "-"} | focus=${item.workspaceAction.autofocus || "-"}${formatWorkspaceActionParams(item.workspaceAction.params) ? ` | filters=${formatWorkspaceActionParams(item.workspaceAction.params)}` : ""}`);
    }
    if (item.recommendedDownload) {
      lines.push(`download: ${item.recommendedDownload.label || item.recommendedDownload.key || "-"} | ${item.recommendedDownload.fileName || "-"}`);
    }
    if (item.bootstrapAction) {
      lines.push(`bootstrap: ${item.bootstrapAction.label || item.bootstrapAction.key || "-"}`);
    }
    if (item.setupAction) {
      lines.push(`setup: ${item.setupAction.label || item.setupAction.key || "-"} | mode=${item.setupAction.mode || "recommended"} | operation=${item.setupAction.operation || "first_batch_setup"}`);
    }
    lines.push("");
  }

  const inventoryRecommendations = Array.isArray(authorizationRecommendations.inventoryRecommendations)
    ? authorizationRecommendations.inventoryRecommendations
    : [];
  if (inventoryRecommendations.length) {
    lines.push("Initial Inventory Recommendations:");
    for (const item of inventoryRecommendations) {
      lines.push(`- [${String(item.priority || "recommended").toUpperCase()}][${String(item.status || "unknown").toUpperCase()}] ${item.label || item.key || "inventory"} | target=${item.target || "-"} | current=${item.current || "-"} | next=${item.nextAction || "-"}`);
    }
    lines.push("");
  }

  const firstBatchCardRecommendations = Array.isArray(authorizationRecommendations.firstBatchCardRecommendations)
    ? authorizationRecommendations.firstBatchCardRecommendations
    : [];
  if (firstBatchCardRecommendations.length) {
    lines.push("First Batch Card Suggestions:");
    for (const item of firstBatchCardRecommendations) {
      lines.push(`- ${item.label || item.key || "batch"} | count=${item.count ?? 0} | current=${item.currentFresh ?? 0} | target=${item.targetCount ?? item.count ?? 0} | status=${String(item.inventoryStatus || "ready").toUpperCase()} | grant=${item.grantType || "-"} | prefix=${item.prefix || "-"} | purpose=${item.purpose || "-"} | next=${item.nextAction || "-"}${item.setupAction ? ` | setup=${item.setupAction.label || item.setupAction.key || "-"}@${item.setupAction.mode || "recommended"}:${item.setupAction.operation || "first_batch_setup"}` : ""}`);
    }
    lines.push("");
  }

  const firstOpsActions = Array.isArray(authorizationRecommendations.firstOpsActions)
    ? authorizationRecommendations.firstOpsActions
    : [];
  if (firstOpsActions.length) {
    lines.push("First Ops Actions:");
    for (const item of firstOpsActions) {
      lines.push(`- ${item.label || item.key || "ops"} | timing=${item.timing || "-"} | ${item.summary || "-"}${item.workspaceAction ? ` | workspace=${item.workspaceAction.label || item.workspaceAction.key || "-"}@${item.workspaceAction.autofocus || "-"}${formatWorkspaceActionParams(item.workspaceAction.params) ? `?${formatWorkspaceActionParams(item.workspaceAction.params)}` : ""}` : ""}${item.recommendedDownload ? ` | download=${item.recommendedDownload.label || item.recommendedDownload.key || "-"}:${item.recommendedDownload.fileName || "-"}` : ""}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function buildLaunchWorkflowPackagePayload({
  generatedAt = nowIso(),
  developer,
  actor,
  product,
  channel = "stable",
  releasePackage,
  integrationPackage,
  authReadiness = {}
}) {
  const normalizedChannel = normalizeChannel(channel);
  const timestampTag = buildExportTimestampTag(generatedAt);
  const fileName = `rocksolid-launch-workflow-${product.code}-${normalizedChannel}-${timestampTag}.json`;
  const summaryFileName = `rocksolid-launch-workflow-${product.code}-${normalizedChannel}-${timestampTag}.txt`;
  const checklistFileName = `rocksolid-launch-workflow-${product.code}-${normalizedChannel}-${timestampTag}-checklist.txt`;
  const zipFileName = `${buildArchiveRootName(fileName, "launch-workflow")}.zip`;
  const handoffZipFileName = `${buildArchiveRootName(fileName, "launch-workflow")}-handoff.zip`;
  const handoffChecksumsFileName = buildChecksumFileName(handoffZipFileName, "launch-workflow-handoff");
  const workflowChecklist = buildLaunchWorkflowChecklistPayload({
    releasePackage,
    integrationPackage,
    authReadiness,
    summaryFileName,
    checklistFileName,
    zipFileName,
    handoffZipFileName,
    handoffChecksumsFileName
  });
  const workflowSummary = buildLaunchWorkflowSummaryPayload({
    product,
    channel: normalizedChannel,
    releasePackage,
    integrationPackage,
    authReadiness,
    workflowChecklist,
    fileName,
    summaryFileName,
    checklistFileName,
    zipFileName,
    handoffZipFileName,
    handoffChecksumsFileName
  });
  const manifest = {
    generatedAt,
    developer: developer ?? null,
    actor: actor ?? null,
    channel: normalizedChannel,
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
    authorizationReadiness: authReadiness,
    workflowSummary,
    workflowChecklist,
    snippets: {
      summaryFileName,
      checklistFileName,
      handoffZipFileName,
      handoffChecksumsFileName,
      recommendedDownloadFileNames: workflowSummary.recommendedDownloads.map((item) => item.fileName).filter(Boolean),
      releaseSummaryFileName: releasePackage?.summaryFileName || null,
      integrationEnvFileName: integrationPackage?.snippets?.envFileName || null,
      integrationHostConfigFileName: integrationPackage?.snippets?.hostConfigFileName || null,
      integrationHostSkeletonFileName: integrationPackage?.snippets?.hostSkeletonFileName || null
    },
    notes: [
      "This package combines the current release readiness lane and integration snapshot for a single project/channel handoff.",
      "Regenerate it whenever the target channel changes, or after updating version rules, notices, SDK credentials, or startup hardening."
    ]
  };

  const payload = {
    fileName,
    summaryFileName,
    checklistFileName,
    handoffZipFileName,
    handoffChecksumsFileName,
    manifest,
    authorizationReadiness: authReadiness,
    workflowSummary,
    workflowChecklist,
    releasePackage,
    integrationPackage,
    snippets: manifest.snippets,
    summaryText: "",
    checklistText: ""
  };

  payload.summaryText = buildLaunchWorkflowPackageSummaryText(payload);
  payload.checklistText = buildLaunchWorkflowChecklistText(payload);
  return payload;
}

function buildLaunchWorkflowPackageFiles(payload) {
  const files = [
    {
      path: payload.fileName || "launch-workflow.json",
      body: JSON.stringify(payload, null, 2)
    },
    {
      path: payload.summaryFileName || "launch-workflow.txt",
      body: payload.summaryText || ""
    },
    {
      path: payload.checklistFileName || "launch-workflow-checklist.txt",
      body: payload.checklistText || ""
    }
  ];

  if (payload.releasePackage) {
    for (const file of buildReleasePackageFiles(payload.releasePackage)) {
      files.push({
        path: `release/${file.path}`,
        body: file.body
      });
    }
  }

  if (payload.integrationPackage) {
    for (const file of buildSingleIntegrationPackageFiles(payload.integrationPackage)) {
      files.push({
        path: `integration/${file.path}`,
        body: file.body
      });
    }
  }

  return files;
}

function appendLaunchWorkflowFileIfPresent(files, path, body) {
  if (!path) {
    return;
  }
  if (body === undefined || body === null || body === "") {
    return;
  }
  files.push({
    path,
    body
  });
}

function buildLaunchWorkflowRecommendedHandoffFiles(payload) {
  const files = [];
  const releasePackage = payload.releasePackage || {};
  const integrationPackage = payload.integrationPackage || {};
  const snippets = integrationPackage.snippets || {};

  appendLaunchWorkflowFileIfPresent(
    files,
    `launch/${payload.summaryFileName || "launch-workflow.txt"}`,
    payload.summaryText || ""
  );
  appendLaunchWorkflowFileIfPresent(
    files,
    `launch/${payload.checklistFileName || "launch-workflow-checklist.txt"}`,
    payload.checklistText || ""
  );
  appendLaunchWorkflowFileIfPresent(
    files,
    `release/${releasePackage.summaryFileName || "release-package.txt"}`,
    releasePackage.summaryText || ""
  );
  appendLaunchWorkflowFileIfPresent(
    files,
    `integration/snippets/${snippets.envFileName || "project.env"}`,
    snippets.envTemplate || ""
  );
  appendLaunchWorkflowFileIfPresent(
    files,
    `integration/host-config/${snippets.hostConfigFileName || "rocksolid_host_config.env"}`,
    snippets.hostConfigEnv || ""
  );
  appendLaunchWorkflowFileIfPresent(
    files,
    `integration/cmake-consumer/${snippets.cmakeFileName || "CMakeLists.txt"}`,
    snippets.cmakeConsumerTemplate || ""
  );
  appendLaunchWorkflowFileIfPresent(
    files,
    `integration/vs2022-consumer/${snippets.vs2022GuideFileName || "rocksolid_vs2022_quickstart.md"}`,
    snippets.vs2022GuideText || ""
  );
  appendLaunchWorkflowFileIfPresent(
    files,
    `integration/vs2022-consumer/${snippets.vs2022SolutionFileName || "rocksolid_host_consumer.sln"}`,
    snippets.vs2022SolutionTemplate || ""
  );
  appendLaunchWorkflowFileIfPresent(
    files,
    `integration/vs2022-consumer/${snippets.vs2022ProjectFileName || "rocksolid_host_consumer.vcxproj"}`,
    snippets.vs2022ProjectTemplate || ""
  );
  appendLaunchWorkflowFileIfPresent(
    files,
    `integration/vs2022-consumer/${snippets.vs2022FiltersFileName || "rocksolid_host_consumer.vcxproj.filters"}`,
    snippets.vs2022FiltersTemplate || ""
  );
  appendLaunchWorkflowFileIfPresent(
    files,
    `integration/vs2022-consumer/${snippets.vs2022PropsFileName || "RockSolidSDK.props"}`,
    snippets.vs2022PropsTemplate || ""
  );
  appendLaunchWorkflowFileIfPresent(
    files,
    `integration/vs2022-consumer/${snippets.vs2022LocalPropsFileName || "RockSolidSDK.local.props"}`,
    snippets.vs2022LocalPropsTemplate || ""
  );
  appendLaunchWorkflowFileIfPresent(
    files,
    `integration/snippets/${snippets.cppFileName || "project.cpp"}`,
    snippets.cppQuickstart || ""
  );
  appendLaunchWorkflowFileIfPresent(
    files,
    `integration/snippets/${snippets.hostSkeletonFileName || "project-host-skeleton.cpp"}`,
    snippets.hostSkeletonCpp || ""
  );
  appendLaunchWorkflowFileIfPresent(
    files,
    `integration/snippets/${snippets.hardeningFileName || "project-hardening-guide.txt"}`,
    snippets.hardeningGuide || ""
  );

  return files;
}

function buildLaunchWorkflowPackageZipEntries(payload) {
  const root = buildArchiveRootName(payload.fileName, "launch-workflow");
  return buildZipEntriesFromFiles(root, buildLaunchWorkflowPackageFiles(payload));
}

function buildLaunchWorkflowRecommendedHandoffZipEntries(payload) {
  const root = buildArchiveRootName(payload.handoffZipFileName, "launch-workflow-handoff");
  return buildZipEntriesFromFiles(root, buildLaunchWorkflowRecommendedHandoffFiles(payload));
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
      path: payload.checklistFileName || "release-package-checklist.txt",
      body: payload.checklistText || ""
    },
    {
      path: `snippets/${payload.snippets?.envFileName || "project.env"}`,
      body: payload.snippets?.envTemplate || ""
    },
    {
      path: `host-config/${payload.snippets?.hostConfigFileName || "rocksolid_host_config.env"}`,
      body: payload.snippets?.hostConfigEnv || ""
    },
    {
      path: `cmake-consumer/${payload.snippets?.cmakeFileName || "CMakeLists.txt"}`,
      body: payload.snippets?.cmakeConsumerTemplate || ""
    },
    {
      path: `vs2022-consumer/${payload.snippets?.vs2022GuideFileName || "rocksolid_vs2022_quickstart.md"}`,
      body: payload.snippets?.vs2022GuideText || ""
    },
    {
      path: `vs2022-consumer/${payload.snippets?.vs2022SolutionFileName || "rocksolid_host_consumer.sln"}`,
      body: payload.snippets?.vs2022SolutionTemplate || ""
    },
    {
      path: "cmake-consumer/main.cpp",
      body: payload.snippets?.hostSkeletonCpp || ""
    },
    {
      path: "cmake-consumer/rocksolid_host_config.env",
      body: payload.snippets?.hostConfigEnv || ""
    },
    {
      path: `vs2022-consumer/${payload.snippets?.vs2022ProjectFileName || "rocksolid_host_consumer.vcxproj"}`,
      body: payload.snippets?.vs2022ProjectTemplate || ""
    },
    {
      path: `vs2022-consumer/${payload.snippets?.vs2022FiltersFileName || "rocksolid_host_consumer.vcxproj.filters"}`,
      body: payload.snippets?.vs2022FiltersTemplate || ""
    },
    {
      path: `vs2022-consumer/${payload.snippets?.vs2022PropsFileName || "RockSolidSDK.props"}`,
      body: payload.snippets?.vs2022PropsTemplate || ""
    },
    {
      path: `vs2022-consumer/${payload.snippets?.vs2022LocalPropsFileName || "RockSolidSDK.local.props"}`,
      body: payload.snippets?.vs2022LocalPropsTemplate || ""
    },
    {
      path: "vs2022-consumer/main.cpp",
      body: payload.snippets?.hostSkeletonCpp || ""
    },
    {
      path: "vs2022-consumer/rocksolid_host_config.env",
      body: payload.snippets?.hostConfigEnv || ""
    },
    {
      path: `snippets/${payload.snippets?.cppFileName || "project.cpp"}`,
      body: payload.snippets?.cppQuickstart || ""
    },
    {
      path: `snippets/${payload.snippets?.hostSkeletonFileName || "project-host-skeleton.cpp"}`,
      body: payload.snippets?.hostSkeletonCpp || ""
    },
    {
      path: `snippets/${payload.snippets?.hardeningFileName || "project-hardening-guide.txt"}`,
      body: payload.snippets?.hardeningGuide || ""
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
  for (const file of payload.hostConfigFiles || []) {
    files.push({
      path: `host-config/${file.fileName}`,
      body: file.content || ""
    });
  }
  for (const file of payload.cmakeFiles || []) {
    const projectCode = String(file.fileName || "").split("/")[0] || "project";
    files.push({
      path: `cmake-consumer/${file.fileName}`,
      body: file.content || ""
    });
    files.push({
      path: `cmake-consumer/${projectCode}/main.cpp`,
      body: payload.items?.find((item) => item.code === projectCode)?.snippets?.hostSkeletonCpp || ""
    });
    files.push({
      path: `cmake-consumer/${projectCode}/rocksolid_host_config.env`,
      body: payload.items?.find((item) => item.code === projectCode)?.snippets?.hostConfigEnv || ""
    });
  }
  for (const file of payload.vs2022SolutionFiles || []) {
    files.push({
      path: `vs2022-consumer/${file.fileName}`,
      body: file.content || ""
    });
  }
  for (const file of payload.vs2022Files || []) {
    const projectCode = String(file.fileName || "").split("/")[0] || "project";
    files.push({
      path: `vs2022-consumer/${file.fileName}`,
      body: file.content || ""
    });
    files.push({
      path: `vs2022-consumer/${projectCode}/main.cpp`,
      body: payload.items?.find((item) => item.code === projectCode)?.snippets?.hostSkeletonCpp || ""
    });
    files.push({
      path: `vs2022-consumer/${projectCode}/rocksolid_host_config.env`,
      body: payload.items?.find((item) => item.code === projectCode)?.snippets?.hostConfigEnv || ""
    });
  }
  for (const file of payload.vs2022FiltersFiles || []) {
    files.push({
      path: `vs2022-consumer/${file.fileName}`,
      body: file.content || ""
    });
  }
  for (const file of payload.vs2022PropsFiles || []) {
    files.push({
      path: `vs2022-consumer/${file.fileName}`,
      body: file.content || ""
    });
  }
  for (const file of payload.vs2022LocalPropsFiles || []) {
    files.push({
      path: `vs2022-consumer/${file.fileName}`,
      body: file.content || ""
    });
  }
  for (const file of payload.vs2022GuideFiles || []) {
    files.push({
      path: `vs2022-consumer/${file.fileName}`,
      body: file.content || ""
    });
  }
  for (const file of payload.cppFiles || []) {
    files.push({
      path: `cpp/${file.fileName}`,
      body: file.content || ""
    });
  }
  for (const file of payload.hostSkeletonFiles || []) {
    files.push({
      path: `host-skeleton/${file.fileName}`,
      body: file.content || ""
    });
  }
  for (const file of payload.hardeningFiles || []) {
    files.push({
      path: `hardening/${file.fileName}`,
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
      path: `host-config/${payload.snippets?.hostConfigFileName || "rocksolid_host_config.env"}`,
      body: payload.snippets?.hostConfigEnv || ""
    },
    {
      path: `cmake-consumer/${payload.snippets?.cmakeFileName || "CMakeLists.txt"}`,
      body: payload.snippets?.cmakeConsumerTemplate || ""
    },
    {
      path: `vs2022-consumer/${payload.snippets?.vs2022GuideFileName || "rocksolid_vs2022_quickstart.md"}`,
      body: payload.snippets?.vs2022GuideText || ""
    },
    {
      path: `vs2022-consumer/${payload.snippets?.vs2022SolutionFileName || "rocksolid_host_consumer.sln"}`,
      body: payload.snippets?.vs2022SolutionTemplate || ""
    },
    {
      path: "cmake-consumer/main.cpp",
      body: payload.snippets?.hostSkeletonCpp || ""
    },
    {
      path: "cmake-consumer/rocksolid_host_config.env",
      body: payload.snippets?.hostConfigEnv || ""
    },
    {
      path: `vs2022-consumer/${payload.snippets?.vs2022ProjectFileName || "rocksolid_host_consumer.vcxproj"}`,
      body: payload.snippets?.vs2022ProjectTemplate || ""
    },
    {
      path: `vs2022-consumer/${payload.snippets?.vs2022FiltersFileName || "rocksolid_host_consumer.vcxproj.filters"}`,
      body: payload.snippets?.vs2022FiltersTemplate || ""
    },
    {
      path: `vs2022-consumer/${payload.snippets?.vs2022PropsFileName || "RockSolidSDK.props"}`,
      body: payload.snippets?.vs2022PropsTemplate || ""
    },
    {
      path: `vs2022-consumer/${payload.snippets?.vs2022LocalPropsFileName || "RockSolidSDK.local.props"}`,
      body: payload.snippets?.vs2022LocalPropsTemplate || ""
    },
    {
      path: "vs2022-consumer/main.cpp",
      body: payload.snippets?.hostSkeletonCpp || ""
    },
    {
      path: "vs2022-consumer/rocksolid_host_config.env",
      body: payload.snippets?.hostConfigEnv || ""
    },
    {
      path: `cpp/${payload.snippets?.cppFileName || "project.cpp"}`,
      body: payload.snippets?.cppQuickstart || ""
    },
    {
      path: `host-skeleton/${payload.snippets?.hostSkeletonFileName || "project-host-skeleton.cpp"}`,
      body: payload.snippets?.hostSkeletonCpp || ""
    },
    {
      path: `hardening/${payload.snippets?.hardeningFileName || "project-hardening-guide.txt"}`,
      body: payload.snippets?.hardeningGuide || ""
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
    ["json", "summary", "checklist", "env", "host-config", "cmake", "vs2022-guide", "vs2022-sln", "vs2022", "vs2022-filters", "vs2022-props", "vs2022-local-props", "cpp", "host-skeleton", "zip", "checksums"],
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
  if (normalizedFormat === "checklist") {
    return {
      fileName: payload.checklistFileName || "release-package-checklist.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.checklistText || ""
    };
  }
  if (normalizedFormat === "env") {
    return {
      fileName: payload.snippets?.envFileName || "project.env",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.envTemplate || ""
    };
  }
  if (normalizedFormat === "host-config") {
    return {
      fileName: payload.snippets?.hostConfigFileName || "rocksolid_host_config.env",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.hostConfigEnv || ""
    };
  }
  if (normalizedFormat === "cmake") {
    return {
      fileName: payload.snippets?.cmakeFileName || "CMakeLists.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.cmakeConsumerTemplate || ""
    };
  }
  if (normalizedFormat === "vs2022-guide") {
    return {
      fileName: payload.snippets?.vs2022GuideFileName || "rocksolid_vs2022_quickstart.md",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.vs2022GuideText || ""
    };
  }
  if (normalizedFormat === "vs2022-sln") {
    return {
      fileName: payload.snippets?.vs2022SolutionFileName || "rocksolid_host_consumer.sln",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.vs2022SolutionTemplate || ""
    };
  }
  if (normalizedFormat === "vs2022") {
    return {
      fileName: payload.snippets?.vs2022ProjectFileName || "rocksolid_host_consumer.vcxproj",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.vs2022ProjectTemplate || ""
    };
  }
  if (normalizedFormat === "vs2022-filters") {
    return {
      fileName: payload.snippets?.vs2022FiltersFileName || "rocksolid_host_consumer.vcxproj.filters",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.vs2022FiltersTemplate || ""
    };
  }
  if (normalizedFormat === "vs2022-props") {
    return {
      fileName: payload.snippets?.vs2022PropsFileName || "RockSolidSDK.props",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.vs2022PropsTemplate || ""
    };
  }
  if (normalizedFormat === "vs2022-local-props") {
    return {
      fileName: payload.snippets?.vs2022LocalPropsFileName || "RockSolidSDK.local.props",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.vs2022LocalPropsTemplate || ""
    };
  }
  if (normalizedFormat === "cpp") {
    return {
      fileName: payload.snippets?.cppFileName || "project.cpp",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.cppQuickstart || ""
    };
  }
  if (normalizedFormat === "host-skeleton") {
    return {
      fileName: payload.snippets?.hostSkeletonFileName || "project-host-skeleton.cpp",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.hostSkeletonCpp || ""
    };
  }

  return {
    fileName: payload.fileName || "release-package.json",
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(payload, null, 2)
  };
}

function buildLaunchWorkflowPackageDownloadAsset(payload, format = "json") {
  const normalizedFormat = normalizeDownloadFormat(
    format,
    [
      "json",
      "summary",
      "checklist",
      "handoff-zip",
      "handoff-checksums",
      "zip",
      "checksums",
      "release-json",
      "release-summary",
      "release-checksums",
      "integration-json",
      "integration-env",
      "integration-host-config",
      "integration-cmake",
      "integration-vs2022-guide",
      "integration-vs2022-sln",
      "integration-vs2022",
      "integration-vs2022-filters",
      "integration-vs2022-props",
      "integration-vs2022-local-props",
      "integration-cpp",
      "integration-host-skeleton",
      "integration-checksums"
    ],
    "json",
    "INVALID_LAUNCH_WORKFLOW_PACKAGE_FORMAT",
    "Launch workflow package format"
  );

  if (normalizedFormat === "handoff-zip") {
    return {
      fileName: payload.handoffZipFileName || `${buildArchiveRootName(payload.fileName, "launch-workflow")}-handoff.zip`,
      contentType: "application/zip",
      body: buildZipArchive(buildLaunchWorkflowRecommendedHandoffZipEntries(payload))
    };
  }
  if (normalizedFormat === "handoff-checksums") {
    return {
      fileName: payload.handoffChecksumsFileName || buildChecksumFileName(payload.handoffZipFileName, "launch-workflow-handoff"),
      contentType: "text/plain; charset=utf-8",
      body: buildChecksumManifestText(buildLaunchWorkflowRecommendedHandoffFiles(payload))
    };
  }
  if (normalizedFormat === "zip") {
    return {
      fileName: `${buildArchiveRootName(payload.fileName, "launch-workflow")}.zip`,
      contentType: "application/zip",
      body: buildZipArchive(buildLaunchWorkflowPackageZipEntries(payload))
    };
  }
  if (normalizedFormat === "checksums") {
    return {
      fileName: buildChecksumFileName(payload.fileName, "launch-workflow"),
      contentType: "text/plain; charset=utf-8",
      body: buildChecksumManifestText(buildLaunchWorkflowPackageFiles(payload))
    };
  }
  if (normalizedFormat === "summary") {
    return {
      fileName: payload.summaryFileName || "launch-workflow.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.summaryText || ""
    };
  }
  if (normalizedFormat === "checklist") {
    return {
      fileName: payload.checklistFileName || "launch-workflow-checklist.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.checklistText || ""
    };
  }
  if (normalizedFormat === "release-json") {
    return buildReleasePackageDownloadAsset(payload.releasePackage || {}, "json");
  }
  if (normalizedFormat === "release-summary") {
    return buildReleasePackageDownloadAsset(payload.releasePackage || {}, "summary");
  }
  if (normalizedFormat === "release-checksums") {
    return buildReleasePackageDownloadAsset(payload.releasePackage || {}, "checksums");
  }
  if (normalizedFormat === "integration-json") {
    return buildIntegrationPackageDownloadAsset(payload.integrationPackage || {}, "json");
  }
  if (normalizedFormat === "integration-env") {
    return buildIntegrationPackageDownloadAsset(payload.integrationPackage || {}, "env");
  }
  if (normalizedFormat === "integration-host-config") {
    return buildIntegrationPackageDownloadAsset(payload.integrationPackage || {}, "host-config");
  }
  if (normalizedFormat === "integration-cmake") {
    return buildIntegrationPackageDownloadAsset(payload.integrationPackage || {}, "cmake");
  }
  if (normalizedFormat === "integration-vs2022-guide") {
    return buildIntegrationPackageDownloadAsset(payload.integrationPackage || {}, "vs2022-guide");
  }
  if (normalizedFormat === "integration-vs2022-sln") {
    return buildIntegrationPackageDownloadAsset(payload.integrationPackage || {}, "vs2022-sln");
  }
  if (normalizedFormat === "integration-vs2022") {
    return buildIntegrationPackageDownloadAsset(payload.integrationPackage || {}, "vs2022");
  }
  if (normalizedFormat === "integration-vs2022-filters") {
    return buildIntegrationPackageDownloadAsset(payload.integrationPackage || {}, "vs2022-filters");
  }
  if (normalizedFormat === "integration-vs2022-props") {
    return buildIntegrationPackageDownloadAsset(payload.integrationPackage || {}, "vs2022-props");
  }
  if (normalizedFormat === "integration-vs2022-local-props") {
    return buildIntegrationPackageDownloadAsset(payload.integrationPackage || {}, "vs2022-local-props");
  }
  if (normalizedFormat === "integration-cpp") {
    return buildIntegrationPackageDownloadAsset(payload.integrationPackage || {}, "cpp");
  }
  if (normalizedFormat === "integration-host-skeleton") {
    return buildIntegrationPackageDownloadAsset(payload.integrationPackage || {}, "host-skeleton");
  }
  if (normalizedFormat === "integration-checksums") {
    return buildIntegrationPackageDownloadAsset(payload.integrationPackage || {}, "checksums");
  }

  return {
    fileName: payload.fileName || "launch-workflow.json",
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(payload, null, 2)
  };
}

function buildDeveloperLaunchReviewSummaryText(payload = {}) {
  const reviewSummary = payload.reviewSummary || {};
  const manifest = payload.manifest || {};
  const project = manifest.project || {};
  const filters = payload.filters || {};
  const launchWorkflow = payload.launchWorkflow || {};
  const workflowSummary = launchWorkflow.workflowSummary || {};
  const workflowChecklist = launchWorkflow.workflowChecklist || {};
  const opsSnapshot = payload.opsSnapshot || {};
  const opsOverview = opsSnapshot.overview || {};
  const lines = [
    "RockSolid Developer Launch Review",
    `Generated At: ${payload.generatedAt || ""}`,
    `Project Code: ${project.code || filters.productCode || "-"}`,
      `Project Name: ${project.name || "-"}`,
      `Channel: ${manifest.channel || filters.channel || "-"}`,
      `Review Mode: ${filters.reviewMode || "-"}`,
      `Ops Event Filter: ${filters.eventType || "-"}`,
      `Ops Actor Filter: ${filters.actorType || "-"}`,
      `Ops Entity Filter: ${filters.entityType || "-"}`,
      "",
      `Review Status: ${String(reviewSummary.status || "unknown").toUpperCase()}`,
      `Review Title: ${reviewSummary.title || "-"}`,
      `Review Message: ${reviewSummary.message || "-"}`,
      "",
      `Launch Workflow Status: ${String(workflowSummary.status || "unknown").toUpperCase()}`,
      `Launch Workflow Title: ${workflowSummary.title || "-"}`,
      `Launch Workflow Message: ${workflowSummary.message || "-"}`,
      `Launch Checklist: ${String(workflowChecklist.status || "unknown").toUpperCase()} | pass=${workflowChecklist.passItems ?? 0} | review=${workflowChecklist.reviewItems ?? 0} | block=${workflowChecklist.blockItems ?? 0}`,
    "",
    `Ops Snapshot Status: ${String(opsOverview.status || "unknown").toUpperCase()}`,
    `Ops Snapshot Headline: ${opsOverview.headline || "-"}`,
    `Ops Snapshot Projects: ${opsSnapshot.summary?.projects ?? 0}`,
      `Ops Snapshot Accounts: ${opsSnapshot.summary?.accounts ?? 0}`,
      `Ops Snapshot Entitlements: ${opsSnapshot.summary?.entitlements ?? 0}`,
      `Ops Snapshot Sessions: ${opsSnapshot.summary?.sessions ?? 0}`,
      `Ops Snapshot Audit Logs: ${opsSnapshot.summary?.auditLogs ?? 0}`
    ];

  const formatWorkspaceActionParams = (params = null) => {
    const entries = params && typeof params === "object"
      ? Object.entries(params).filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "")
      : [];
    return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(",") : "";
  };
  const formatWorkspaceActionText = (action = null) => {
    if (!action) {
      return "-";
    }
    const paramsText = formatWorkspaceActionParams(action.params);
    return `${action.label || action.key || "-"}@${action.autofocus || "-"}${paramsText ? `?${paramsText}` : ""}`;
  };

  if (reviewSummary.recommendedWorkspace?.label || reviewSummary.recommendedWorkspace?.key) {
    lines.push("");
    lines.push("Recommended Workspace:");
    lines.push(`- ${reviewSummary.recommendedWorkspace.label || reviewSummary.recommendedWorkspace.key || "-"}`);
    lines.push(`- reason: ${reviewSummary.recommendedWorkspace.reason || reviewSummary.message || "-"}`);
  }
  if (Array.isArray(reviewSummary.actionPlan) && reviewSummary.actionPlan.length) {
    lines.push("");
    lines.push("Launch Review Action Plan:");
    for (const item of reviewSummary.actionPlan) {
      lines.push(
        `- ${item.title || item.key || "step"} | ${String(item.priority || "secondary").toUpperCase()} | ${item.summary || "-"}`
        + `${item.workspaceAction ? ` | workspace=${formatWorkspaceActionText(item.workspaceAction)}` : ""}`
        + `${item.recommendedDownload ? ` | download=${item.recommendedDownload.label || item.recommendedDownload.key || "-"}` : ""}`
      );
    }
  }
  if (reviewSummary.primaryReviewTarget) {
    const item = reviewSummary.primaryReviewTarget;
    lines.push("");
    lines.push("Launch Review Primary Review Target:");
    lines.push(
      `- ${item.label || item.key || "target"} | count=${item.count ?? 0} | ${String(item.status || "review").toUpperCase()} | ${item.summary || "-"}`
      + `${item.routeActionLabel ? ` | action=${item.routeActionLabel}` : ""}`
      + `${item.recommendedControl?.label ? ` | control=${item.recommendedControl.label}` : ""}`
      + `${item.workspaceAction ? ` | workspace=${formatWorkspaceActionText(item.workspaceAction)}` : ""}`
      + `${item.recommendedDownload ? ` | download=${item.recommendedDownload.label || item.recommendedDownload.key || "-"}` : ""}`
    );
  }
  if (Array.isArray(reviewSummary.reviewTargets) && reviewSummary.reviewTargets.length) {
    lines.push("");
    lines.push("Launch Review Focus Targets:");
    for (const item of reviewSummary.reviewTargets) {
      lines.push(
        `- ${item.label || item.key || "target"} | count=${item.count ?? 0} | ${String(item.status || "review").toUpperCase()} | ${item.summary || "-"}`
        + `${item.routeActionLabel ? ` | action=${item.routeActionLabel}` : ""}`
        + `${item.recommendedControl?.label ? ` | control=${item.recommendedControl.label}` : ""}`
        + `${item.workspaceAction ? ` | workspace=${formatWorkspaceActionText(item.workspaceAction)}` : ""}`
        + `${item.recommendedDownload ? ` | download=${item.recommendedDownload.label || item.recommendedDownload.key || "-"}` : ""}`
      );
    }
  }
  if (Array.isArray(reviewSummary.workspaceActions) && reviewSummary.workspaceActions.length) {
    lines.push("");
    lines.push("Launch Review Workspace Path:");
    for (const item of reviewSummary.workspaceActions) {
      lines.push(
        `- ${item.label || item.key || "workspace"} | ${String(item.priority || "secondary").toUpperCase()} | focus=${item.autofocus || "-"}`
        + `${formatWorkspaceActionParams(item.params) ? ` | filters=${formatWorkspaceActionParams(item.params)}` : ""}`
        + ` | reason=${item.reason || "-"}`
      );
    }
  }
  if (Array.isArray(reviewSummary.recommendedDownloads) && reviewSummary.recommendedDownloads.length) {
    lines.push("");
    lines.push("Launch Review Recommended Downloads:");
    for (const item of reviewSummary.recommendedDownloads) {
      lines.push(`- ${item.label || item.key || "download"} | ${item.fileName || "-"}`);
    }
  }

  if (launchWorkflow.summaryText) {
    lines.push("");
    lines.push("Launch Workflow Summary:");
    lines.push(launchWorkflow.summaryText);
  }

  if (opsSnapshot.summaryText) {
    lines.push("");
    lines.push("Ops Snapshot Summary:");
    lines.push(opsSnapshot.summaryText);
  }

  return lines.join("\n").trimEnd();
}

function buildDeveloperLaunchReviewSummaryPayload({
  launchWorkflow = null,
  opsSnapshot = null,
  filters = {}
} = {}) {
  const compactFocusParams = (params = {}) => Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "")
  );
  const buildAuditFocusParams = (item = {}) => {
    const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
    const productCode = metadata.productCode || metadata.code || metadata.projectCode || metadata.softwareCode || null;
    const username = metadata.username || metadata.accountUsername || metadata.redeemedUsername || null;
    const reason = metadata.reason || metadata.revokedReason || metadata.releaseReason || null;
    const fingerprint = metadata.deviceFingerprint || metadata.fingerprint || null;
    if (item.entityType === "account" || metadata.accountId) {
      return compactFocusParams({
        focusKind: "account",
        focusAccountId: item.entityType === "account" ? (item.entityId || metadata.accountId || null) : (metadata.accountId || null),
        focusUsername: username,
        focusReason: reason,
        focusFingerprint: fingerprint,
        focusProductCode: productCode
      });
    }
    if (item.entityType === "entitlement" || metadata.entitlementId) {
      return compactFocusParams({
        focusKind: "entitlement",
        focusEntitlementId: item.entityType === "entitlement" ? (item.entityId || metadata.entitlementId || null) : (metadata.entitlementId || null),
        focusUsername: username,
        focusReason: reason,
        focusProductCode: productCode
      });
    }
    if (item.entityType === "session" || metadata.sessionId) {
      return compactFocusParams({
        focusKind: "session",
        focusSessionId: item.entityType === "session" ? (item.entityId || metadata.sessionId || null) : (metadata.sessionId || null),
        focusUsername: username,
        focusReason: reason,
        focusFingerprint: fingerprint,
        focusProductCode: productCode
      });
    }
    if (item.entityType === "device_binding" || metadata.bindingId) {
      return compactFocusParams({
        focusKind: "device",
        focusBindingId: item.entityType === "device_binding" ? (item.entityId || metadata.bindingId || null) : (metadata.bindingId || null),
        focusFingerprint: fingerprint,
        focusUsername: username,
        focusReason: reason,
        focusProductCode: productCode
      });
    }
    if (item.entityType === "device_block" || metadata.blockId) {
      return compactFocusParams({
        focusKind: "device",
        focusBlockId: item.entityType === "device_block" ? (item.entityId || metadata.blockId || null) : (metadata.blockId || null),
        focusFingerprint: fingerprint,
        focusUsername: username,
        focusReason: reason,
        focusProductCode: productCode
      });
    }
    return compactFocusParams({
      focusKind: "audit",
      focusUsername: username,
      focusReason: reason,
      focusFingerprint: fingerprint,
      focusProductCode: productCode
    });
  };
  const buildReviewTargetFocusParams = (kind, item = {}) => {
    if (!item || typeof item !== "object") {
      return {};
    }
    const productCode = item.productCode || item.projectCode || null;
    const username = item.username || null;
    const reason = item.reason || item.revokedReason || null;
    const fingerprint = item.fingerprint || null;
    if (kind === "account") {
      return compactFocusParams({
        focusKind: "account",
        focusAccountId: item.accountId || item.id || null,
        focusUsername: username,
        focusReason: reason,
        focusFingerprint: fingerprint,
        focusProductCode: productCode
      });
    }
    if (kind === "entitlement") {
      return compactFocusParams({
        focusKind: "entitlement",
        focusEntitlementId: item.entitlementId || item.id || null,
        focusUsername: username,
        focusReason: reason,
        focusProductCode: productCode
      });
    }
    if (kind === "session") {
      return compactFocusParams({
        focusKind: "session",
        focusSessionId: item.sessionId || item.id || null,
        focusUsername: username,
        focusReason: reason,
        focusFingerprint: fingerprint,
        focusProductCode: productCode
      });
    }
    if (kind === "device") {
      return compactFocusParams({
        focusKind: "device",
        focusBindingId: item.bindingId || (item.kind === "binding" ? item.id || null : null),
        focusBlockId: item.blockId || (item.kind === "block" ? item.id || null : null),
        focusFingerprint: fingerprint,
        focusUsername: username,
        focusReason: reason,
        focusProductCode: productCode
      });
    }
    if (kind === "audit") {
      return buildAuditFocusParams(item);
    }
    return {};
  };
  const workflowSummary = launchWorkflow?.workflowSummary || {};
  const workflowChecklist = launchWorkflow?.workflowChecklist || {};
  const opsOverview = opsSnapshot?.overview || {};
  const reviewMode = String(filters.reviewMode || "matched").trim().toLowerCase() || "matched";
  const scopedOpsParams = {
    reviewMode,
    ...(filters.username ? { username: filters.username } : {}),
    ...(filters.search ? { search: filters.search } : {}),
    ...(filters.eventType ? { eventType: filters.eventType } : {}),
    ...(filters.actorType ? { actorType: filters.actorType } : {}),
    ...(filters.entityType ? { entityType: filters.entityType } : {})
  };
  const stayAction = createLaunchWorkflowWorkspaceShortcut(
    "launch-review",
    "summary",
    "Stay in Launch Review",
    scopedOpsParams
  );
  const opsWorkspaceAction = createLaunchWorkflowWorkspaceShortcut(
    "ops",
    "snapshot",
    "Open Ops Workspace",
    scopedOpsParams
  );
  const reviewDownload = createLaunchWorkflowReviewDownloadShortcut(
    "Launch review summary",
    "launch-review.txt",
    "summary",
    scopedOpsParams
  );
  const workflowSummaryDownload = createLaunchWorkflowDownloadShortcut(
    "launch_summary",
    launchWorkflow?.summaryFileName || "launch-workflow.txt",
    "Launch workflow summary",
    {
      source: "developer-launch-workflow",
      format: "summary"
    }
  );
  const workflowChecklistDownload = createLaunchWorkflowDownloadShortcut(
    "launch_checklist",
    launchWorkflow?.checklistFileName || "launch-workflow-checklist.txt",
    "Launch workflow checklist",
    {
      source: "developer-launch-workflow",
      format: "checklist"
    }
  );
  const opsSummaryDownload = createLaunchWorkflowDownloadShortcut(
    "launch_review_ops_summary",
    opsSnapshot?.summaryFileName || "developer-ops-summary.txt",
    "Routed ops summary",
    {
      source: "developer-ops",
      format: "summary",
      params: { ...scopedOpsParams }
    }
  );
  const matchedOpsParams = {
    ...scopedOpsParams,
    reviewMode: "matched"
  };
  const createReviewTargetDownload = (key, label, fileName) => createLaunchWorkflowDownloadShortcut(
    key,
    fileName,
    label,
    {
      source: "developer-ops",
      format: "summary",
      params: { ...matchedOpsParams }
    }
  );
  const buildReviewTargetRouteAction = (autofocus = "") => {
    const normalized = String(autofocus || "").trim().toLowerCase();
    if (normalized === "accounts") {
      return "review-accounts";
    }
    if (normalized === "entitlements") {
      return "review-entitlements";
    }
    if (normalized === "sessions") {
      return "review-sessions";
    }
    if (normalized === "devices" || normalized === "bindings" || normalized === "blocks") {
      return "review-devices";
    }
    if (normalized === "audit") {
      return "review-audit";
    }
    return "prepare-primary";
  };
  const buildReviewTargetRouteActionLabel = (routeAction = "", focusKind = "") => {
    const normalized = String(routeAction || "").trim().toLowerCase();
    if (normalized === "control-primary"
      || normalized === "control-account"
      || normalized === "control-entitlement"
      || normalized === "control-session"
      || normalized === "control-device") {
      return buildFocusKindControlLabel(focusKind);
    }
    if (normalized === "review-accounts") {
      return "Review Accounts";
    }
    if (normalized === "review-entitlements") {
      return "Review Entitlements";
    }
    if (normalized === "review-sessions") {
      return "Review Sessions";
    }
    if (normalized === "review-devices") {
      return "Review Devices";
    }
    if (normalized === "review-audit") {
      return "Review Audit";
    }
    if (normalized === "prepare-primary") {
      return "Prepare Primary Match";
    }
    return "";
  };
  const createReviewTarget = ({
    key,
    autofocus,
    label,
    summary,
    count = 0,
    status = "review",
    fileName = "developer-ops-summary.txt",
    focusParams = null,
    routeAction = "",
    recommendedControl = null
  } = {}) => {
    if (!key || !autofocus) {
      return null;
    }
    const resolvedRouteAction = routeAction || (focusParams?.focusKind ? buildFocusKindControlRouteAction(focusParams.focusKind) : buildReviewTargetRouteAction(autofocus));
    const controlLabel = buildFocusKindControlLabel(focusParams?.focusKind, " in Ops");
    const resolvedRecommendedControl = recommendedControl
      || buildDeveloperOpsReviewGenericControlFromFocusParams(focusParams);
    return {
      key,
      autofocus,
      label: label || key,
      count: Number(count || 0),
      status: status || "review",
      summary: summary || "-",
      routeAction: resolvedRouteAction,
      routeActionLabel: buildReviewTargetRouteActionLabel(resolvedRouteAction, focusParams?.focusKind),
      recommendedControl: resolvedRecommendedControl || null,
      workspaceAction: createLaunchWorkflowWorkspaceShortcut(
        "ops",
        autofocus,
        /^control-/.test(String(resolvedRouteAction || "").trim().toLowerCase()) ? controlLabel : (label || "Open Ops Workspace"),
        {
          ...matchedOpsParams,
          ...(focusParams && typeof focusParams === "object" ? focusParams : {}),
          ...(resolvedRouteAction ? { routeAction: resolvedRouteAction } : {})
        }
      ),
      recommendedDownload: createReviewTargetDownload(
        `${key}_summary`,
        `${label || key} summary`,
        fileName
      )
    };
  };

  const workspaceActions = [];
  const workspaceActionIds = new Set();
  const pushWorkspaceAction = (action, reasonOverride = "") => {
    if (!action?.key) {
      return;
    }
    const normalizedAction = {
      ...action,
      params: action.params && typeof action.params === "object"
        ? { ...action.params }
        : undefined
    };
    const identity = [
      normalizedAction.key,
      normalizedAction.autofocus || "",
      JSON.stringify(normalizedAction.params || {})
    ].join("|");
    if (workspaceActionIds.has(identity)) {
      return;
    }
    workspaceActionIds.add(identity);
    workspaceActions.push({
      ...normalizedAction,
      reason: reasonOverride || normalizedAction.reason || ""
    });
  };

  pushWorkspaceAction(stayAction, "Use Launch Review as the combined recheck screen for launch readiness and first-wave runtime signals.");
  if (workflowSummary.recommendedWorkspace?.key) {
    pushWorkspaceAction(workflowSummary.recommendedWorkspace, workflowSummary.recommendedWorkspace.reason || workflowSummary.message || "");
  }
  for (const item of Array.isArray(workflowSummary.workspaceActions) ? workflowSummary.workspaceActions : []) {
    pushWorkspaceAction(item, item.reason || "");
  }
  pushWorkspaceAction(opsWorkspaceAction, "Open Developer Ops with the same routed review filters when you need deeper runtime follow-up.");

  const actionPlan = [];
  const actionPlanKeys = new Set();
  const pushActionPlan = (step) => {
    if (!step?.key || actionPlanKeys.has(step.key)) {
      return;
    }
    actionPlanKeys.add(step.key);
    actionPlan.push(step);
  };

  const workflowBlocked = String(workflowSummary.status || "").trim().toLowerCase() === "hold"
    || Number(workflowChecklist.blockItems || 0) > 0;
  const workflowNeedsReview = workflowBlocked
    || String(workflowSummary.status || "").trim().toLowerCase() === "review"
    || Number(workflowChecklist.reviewItems || 0) > 0;
  const queueHasUrgent = Number(opsOverview?.queueSummary?.critical || 0) > 0
    || Number(opsOverview?.queueSummary?.high || 0) > 0;
  const reviewTargetCounts = {
    accounts: Array.isArray(opsSnapshot?.accounts) ? opsSnapshot.accounts.length : 0,
    entitlements: Array.isArray(opsSnapshot?.entitlements) ? opsSnapshot.entitlements.length : 0,
    sessions: Array.isArray(opsSnapshot?.sessions) ? opsSnapshot.sessions.length : 0,
    devices: (Array.isArray(opsSnapshot?.bindings) ? opsSnapshot.bindings.length : 0) + (Array.isArray(opsSnapshot?.blocks) ? opsSnapshot.blocks.length : 0),
    audit: Array.isArray(opsSnapshot?.auditLogs) ? opsSnapshot.auditLogs.length : 0
  };
  const preferredTargetOrder = [];
  const pushPreferredTargetKey = (key) => {
    if (!key || preferredTargetOrder.includes(key)) {
      return;
    }
    preferredTargetOrder.push(key);
  };
  if (String(filters.username || "").trim()) {
    pushPreferredTargetKey("accounts");
    pushPreferredTargetKey("entitlements");
    pushPreferredTargetKey("sessions");
  }
  if (String(filters.eventType || "").trim().toLowerCase().startsWith("session.")) {
    pushPreferredTargetKey("sessions");
    pushPreferredTargetKey("audit");
  }
  const entityType = String(filters.entityType || "").trim().toLowerCase();
  if (entityType === "entitlement") {
    pushPreferredTargetKey("entitlements");
    pushPreferredTargetKey("accounts");
  }
  if (entityType === "session") {
    pushPreferredTargetKey("sessions");
    pushPreferredTargetKey("audit");
  }
  if (entityType === "device_binding" || entityType === "device_block") {
    pushPreferredTargetKey("devices");
    pushPreferredTargetKey("audit");
  }
  if (entityType === "license_key") {
    pushPreferredTargetKey("audit");
    pushPreferredTargetKey("entitlements");
  }
  if (String(filters.actorType || "").trim().toLowerCase() === "account") {
    pushPreferredTargetKey("accounts");
    pushPreferredTargetKey("sessions");
  }
  ["accounts", "entitlements", "sessions", "devices", "audit"].forEach(pushPreferredTargetKey);

  const reviewTargetBuilders = {
    accounts: () => createReviewTarget({
      key: "ops_accounts_review",
      autofocus: "accounts",
      label: "Review matched accounts",
      summary: "Inspect routed starter accounts and related entitlement state before widening launch access.",
      count: reviewTargetCounts.accounts,
      fileName: "developer-ops-accounts-summary.txt",
      recommendedControl: buildDeveloperOpsReviewRecommendedControl(
        "account",
        Array.isArray(opsSnapshot?.accounts) && opsSnapshot.accounts.length
          ? opsSnapshot.accounts[0]
          : null
      ),
      focusParams: buildReviewTargetFocusParams(
        "account",
        Array.isArray(opsSnapshot?.accounts) && opsSnapshot.accounts.length
          ? opsSnapshot.accounts[0]
          : { productCode: filters.productCode || null }
      )
    }),
    entitlements: () => createReviewTarget({
      key: "ops_entitlements_review",
      autofocus: "entitlements",
      label: "Review matched entitlements",
      summary: "Confirm starter entitlements, lifecycle state, and grant windows for the routed launch lane.",
      count: reviewTargetCounts.entitlements,
      fileName: "developer-ops-entitlements-summary.txt",
      recommendedControl: buildDeveloperOpsReviewRecommendedControl(
        "entitlement",
        Array.isArray(opsSnapshot?.entitlements) && opsSnapshot.entitlements.length
          ? opsSnapshot.entitlements[0]
          : null
      ),
      focusParams: buildReviewTargetFocusParams(
        "entitlement",
        Array.isArray(opsSnapshot?.entitlements) && opsSnapshot.entitlements.length
          ? opsSnapshot.entitlements[0]
          : { productCode: filters.productCode || null }
      )
    }),
    sessions: () => createReviewTarget({
      key: "ops_sessions_review",
      autofocus: "sessions",
      label: "Review matched sessions",
      summary: "Check first sign-ins, heartbeat churn, and routed session health before the next launch wave.",
      count: reviewTargetCounts.sessions,
      status: queueHasUrgent ? "review" : "pass",
      fileName: "developer-ops-sessions-summary.txt",
      recommendedControl: buildDeveloperOpsReviewRecommendedControl(
        "session",
        Array.isArray(opsSnapshot?.sessions) && opsSnapshot.sessions.length
          ? opsSnapshot.sessions[0]
          : null
      ),
      focusParams: buildReviewTargetFocusParams(
        "session",
        Array.isArray(opsSnapshot?.sessions) && opsSnapshot.sessions.length
          ? opsSnapshot.sessions[0]
          : { productCode: filters.productCode || null }
      )
    }),
    devices: () => createReviewTarget({
      key: "ops_devices_review",
      autofocus: "devices",
      label: "Review matched devices",
      summary: "Inspect routed bindings and device blocks so first-wave users are not accidentally locked out.",
      count: reviewTargetCounts.devices,
      fileName: "developer-ops-devices-summary.txt",
      recommendedControl: buildDeveloperOpsReviewRecommendedControl(
        "device",
        Array.isArray(opsSnapshot?.blocks) && opsSnapshot.blocks.length
          ? { ...opsSnapshot.blocks[0], kind: "block", blockId: opsSnapshot.blocks[0]?.id || null }
          : Array.isArray(opsSnapshot?.bindings) && opsSnapshot.bindings.length
            ? { ...opsSnapshot.bindings[0], kind: "binding", bindingId: opsSnapshot.bindings[0]?.id || null }
            : null
      ),
      focusParams: buildReviewTargetFocusParams(
        "device",
        Array.isArray(opsSnapshot?.blocks) && opsSnapshot.blocks.length
          ? { ...opsSnapshot.blocks[0], kind: "block", blockId: opsSnapshot.blocks[0]?.id || null }
          : Array.isArray(opsSnapshot?.bindings) && opsSnapshot.bindings.length
            ? { ...opsSnapshot.bindings[0], kind: "binding", bindingId: opsSnapshot.bindings[0]?.id || null }
            : { productCode: filters.productCode || null }
      )
    }),
    audit: () => createReviewTarget({
      key: "ops_audit_review",
      autofocus: "audit",
      label: "Review matched audit logs",
      summary: "Review routed audit events for launch-day redemptions, revocations, and other early warning signals.",
      count: reviewTargetCounts.audit,
      status: queueHasUrgent ? "review" : "pass",
      fileName: "developer-ops-audit-summary.txt",
      focusParams: buildReviewTargetFocusParams(
        "audit",
        Array.isArray(opsSnapshot?.auditLogs) && opsSnapshot.auditLogs.length
          ? opsSnapshot.auditLogs[0]
          : { productCode: filters.productCode || null }
      )
    })
  };
  const reviewTargets = preferredTargetOrder
    .map((key) => reviewTargetBuilders[key]?.())
    .filter(Boolean);
  const visibleReviewTargets = reviewTargets.some((item) => Number(item.count || 0) > 0)
    ? reviewTargets.filter((item) => Number(item.count || 0) > 0)
    : reviewTargets.slice(0, 2);
  const rawPrimaryReviewTarget = visibleReviewTargets.find((item) => recommendedControlPriority(item?.recommendedControl) >= 2 && item?.workspaceAction)
    || visibleReviewTargets.find((item) => recommendedControlPriority(item?.recommendedControl) >= 1 && item?.workspaceAction)
    || visibleReviewTargets.find((item) => item?.workspaceAction)
    || visibleReviewTargets[0]
    || null;
  const primaryReviewWorkspaceAction = rawPrimaryReviewTarget?.workspaceAction
    ? {
        ...rawPrimaryReviewTarget.workspaceAction,
        label: buildFocusKindControlLabel(rawPrimaryReviewTarget.workspaceAction?.params?.focusKind, " in Ops"),
        params: {
          ...(rawPrimaryReviewTarget.workspaceAction.params && typeof rawPrimaryReviewTarget.workspaceAction.params === "object"
            ? rawPrimaryReviewTarget.workspaceAction.params
            : {}),
          routeAction: buildFocusKindControlRouteAction(rawPrimaryReviewTarget.workspaceAction?.params?.focusKind)
        }
      }
    : null;
  const primaryReviewTarget = primaryReviewWorkspaceAction
    ? {
        ...rawPrimaryReviewTarget,
      routeActionLabel: buildFocusKindControlLabel(rawPrimaryReviewTarget.workspaceAction?.params?.focusKind),
        workspaceAction: primaryReviewWorkspaceAction,
        recommendedDownload: createLaunchWorkflowPrimaryOpsDownloadShortcut(primaryReviewWorkspaceAction)
          || rawPrimaryReviewTarget.recommendedDownload
          || null
      }
    : rawPrimaryReviewTarget;
  if (primaryReviewTarget?.workspaceAction) {
    pushWorkspaceAction(primaryReviewTarget.workspaceAction, primaryReviewTarget.summary || "");
  }
  for (const item of visibleReviewTargets) {
    pushWorkspaceAction(item.workspaceAction, item.summary || "");
  }

  pushActionPlan(createLaunchWorkflowActionPlanStep({
    key: "launch_review_summary",
    title: workflowNeedsReview
      ? "Review combined launch blockers with routed runtime scope"
      : "Review combined launch and runtime state",
    summary: workflowNeedsReview
      ? (workflowSummary.message || "Check launch blockers together with the first-wave runtime scope before rollout continues.")
      : (opsOverview.headline || "Launch lane looks staged. Recheck the routed runtime scope before handing the lane off."),
    status: workflowBlocked ? "block" : workflowNeedsReview ? "review" : "pass",
    priority: "primary",
    workspaceAction: workflowNeedsReview
      ? (workflowSummary.recommendedWorkspace || stayAction)
      : stayAction,
    recommendedDownload: reviewDownload
  }));

  for (const item of (Array.isArray(workflowSummary.actionPlan) ? workflowSummary.actionPlan : []).slice(0, 3)) {
    pushActionPlan(createLaunchWorkflowActionPlanStep({
      key: `workflow_${item.key || "step"}`,
      title: item.title || item.key || "Workflow step",
      summary: item.summary || "-",
      status: item.status || "review",
      priority: actionPlan.length ? "secondary" : "primary",
      workspaceAction: item.workspaceAction || null,
      recommendedDownload: item.recommendedDownload || null,
      bootstrapAction: item.bootstrapAction || null,
      setupAction: item.setupAction || null
    }));
  }

  if (primaryReviewTarget?.workspaceAction) {
    const primaryControlTitle = buildPrimaryReviewStepTitle(
      primaryReviewTarget.workspaceAction,
      primaryReviewTarget.recommendedControl
    );
    pushActionPlan(createLaunchWorkflowActionPlanStep({
      key: "launch_review_primary_target",
      title: primaryControlTitle,
      summary: primaryReviewTarget.summary || `${primaryControlTitle} before scanning the rest of the matched runtime scope.`,
      status: primaryReviewTarget.status || "review",
      priority: actionPlan.length ? "secondary" : "primary",
      workspaceAction: primaryReviewTarget.workspaceAction,
      recommendedDownload: primaryReviewTarget.recommendedDownload || null
    }));
  }

  const remainingReviewDownload = primaryReviewTarget?.workspaceAction?.key === "ops"
    ? createLaunchWorkflowRemainingOpsDownloadShortcut(primaryReviewTarget.workspaceAction)
    : null;
  if (remainingReviewDownload) {
    pushActionPlan(createLaunchWorkflowActionPlanStep({
      key: "launch_review_remaining_queue",
      title: "Hand off the remaining routed review queue",
      summary: "After the primary routed control is ready, pass the remaining matched runtime queue forward so review can continue without rebuilding filters.",
      status: "review",
      priority: actionPlan.length ? "secondary" : "primary",
      workspaceAction: primaryReviewTarget?.workspaceAction || null,
      recommendedDownload: remainingReviewDownload
    }));
  }

  for (const item of visibleReviewTargets.slice(0, 3)) {
    pushActionPlan(createLaunchWorkflowActionPlanStep({
      key: item.key,
      title: buildReviewTargetActionPlanTitle(item),
      summary: item.summary || "-",
      status: item.status || "review",
      priority: actionPlan.length ? "secondary" : "primary",
      workspaceAction: item.workspaceAction || null,
      recommendedDownload: item.recommendedDownload || null
    }));
  }

  if (queueHasUrgent || (Array.isArray(opsOverview.recommendedQueue) && opsOverview.recommendedQueue.length)) {
    pushActionPlan(createLaunchWorkflowActionPlanStep({
      key: "launch_review_ops_queue",
      title: queueHasUrgent ? "Review urgent routed ops signals" : "Review routed ops queue",
      summary: queueHasUrgent
        ? "Critical or high-severity routed runtime signals are present. Review the scoped ops queue before wider rollout."
        : (opsOverview.headline || "Use the routed ops queue to review first-wave login, redemption, session, or device signals."),
      status: queueHasUrgent ? "review" : "pass",
      priority: actionPlan.length ? "secondary" : "primary",
      workspaceAction: opsWorkspaceAction,
      recommendedDownload: opsSummaryDownload
    }));
  }

  const handoffDownload = (Array.isArray(workflowSummary.recommendedDownloads) ? workflowSummary.recommendedDownloads : [])
    .find((item) => item?.key === "launch_handoff_zip") || null;
  if (handoffDownload && String(workflowSummary.status || "").trim().toLowerCase() === "ready") {
    pushActionPlan(createLaunchWorkflowActionPlanStep({
      key: "launch_review_handoff",
      title: "Share the recommended launch handoff",
      summary: "Use the launch handoff zip once the lane and first-wave runtime review both look stable.",
      status: "pass",
      priority: actionPlan.length ? "secondary" : "primary",
      recommendedDownload: handoffDownload
    }));
  }

  const recommendedDownloads = [];
  const recommendedDownloadKeys = new Set();
  const pushRecommendedDownload = (item) => {
    if (!item?.key || recommendedDownloadKeys.has(item.key)) {
      return;
    }
    recommendedDownloadKeys.add(item.key);
    recommendedDownloads.push({
      ...item,
      params: item.params && typeof item.params === "object"
        ? { ...item.params }
        : item.params
    });
  };
  pushRecommendedDownload(reviewDownload);
  if (primaryReviewTarget?.recommendedDownload) {
    pushRecommendedDownload(primaryReviewTarget.recommendedDownload);
  }
  if (primaryReviewTarget?.workspaceAction?.key === "ops") {
    pushRecommendedDownload(createLaunchWorkflowRemainingOpsDownloadShortcut(primaryReviewTarget.workspaceAction));
  }
  pushRecommendedDownload(workflowSummaryDownload);
  pushRecommendedDownload(workflowChecklistDownload);
  pushRecommendedDownload(opsSummaryDownload);
  if (handoffDownload) {
    pushRecommendedDownload(handoffDownload);
  }
  for (const item of Array.isArray(workflowSummary.recommendedDownloads) ? workflowSummary.recommendedDownloads.slice(0, 3) : []) {
    pushRecommendedDownload(item);
  }

  const preferredReviewTarget = visibleReviewTargets[0] || null;
  const recommendedWorkspace = (actionPlan.find((item) => item.priority === "primary" && item.workspaceAction)?.workspaceAction)
    || (!workflowNeedsReview && preferredReviewTarget?.workspaceAction ? preferredReviewTarget.workspaceAction : null)
    || workflowSummary.recommendedWorkspace
    || opsWorkspaceAction
    || stayAction;
  const reviewStatus = workflowBlocked
    ? "block"
    : workflowNeedsReview || queueHasUrgent
      ? "review"
      : "pass";

  return {
    status: reviewStatus,
    title: reviewStatus === "block"
      ? "Launch review still has blockers"
      : reviewStatus === "review"
        ? "Launch review still needs attention"
        : "Launch review is ready for handoff",
      message: workflowNeedsReview
      ? (workflowSummary.message || "Clear launch blockers and recheck the scoped runtime slice before rollout.")
      : queueHasUrgent
        ? "Launch lane looks staged, but routed runtime signals still need another look."
        : (opsOverview.headline || "Launch lane and routed runtime scope both look ready for handoff."),
    recommendedWorkspace,
    workspaceActions,
    primaryReviewTarget,
    reviewTargets: visibleReviewTargets,
    actionPlan,
    recommendedDownloads,
    nextActions: actionPlan.map((item) => item.title || item.key || "step").slice(0, 4)
  };
}

function buildDeveloperLaunchReviewPayload({
  generatedAt = nowIso(),
  launchWorkflow = null,
  opsSnapshot = null,
  filters = {}
} = {}) {
  const manifest = launchWorkflow?.manifest || {};
  const project = manifest.project || {};
  const channel = manifest.channel || filters.channel || "stable";
  const timestampTag = buildExportTimestampTag(generatedAt);
  const scopeTag = sanitizeExportNameSegment(project.code || filters.productCode || "launch-review", "launch-review");
  const fileName = `rocksolid-developer-launch-review-${scopeTag}-${channel}-${timestampTag}.json`;
  const summaryFileName = `rocksolid-developer-launch-review-${scopeTag}-${channel}-${timestampTag}-summary.txt`;
  const payload = {
    generatedAt,
    fileName,
    summaryFileName,
    manifest: {
      generatedAt,
      channel,
      project: {
        id: project.id || null,
        code: project.code || filters.productCode || null,
        name: project.name || ""
      }
    },
    filters: {
      productCode: project.code || filters.productCode || null,
      channel,
      username: filters.username || null,
      search: filters.search || null,
      eventType: filters.eventType || null,
      actorType: filters.actorType || null,
      entityType: filters.entityType || null,
      reviewMode: filters.reviewMode || null
    },
    launchWorkflow,
    opsSnapshot,
    notes: [
      "This review package combines the current launch workflow lane with the scoped developer ops follow-up snapshot.",
      "Use it right after launch bootstrap, first-batch setup, or inventory refill when you need one file to recheck launch readiness and first-wave runtime signals."
      ]
    };
    payload.reviewSummary = buildDeveloperLaunchReviewSummaryPayload({
      launchWorkflow,
      opsSnapshot,
      filters: payload.filters
    });
    payload.summaryText = buildDeveloperLaunchReviewSummaryText(payload);
    return payload;
  }

function buildDeveloperLaunchReviewFiles(payload = {}) {
  const files = [
    {
      path: payload.fileName || "developer-launch-review.json",
      body: JSON.stringify(payload, null, 2)
    },
    {
      path: payload.summaryFileName || "developer-launch-review-summary.txt",
      body: payload.summaryText || ""
    }
  ];
  appendLaunchWorkflowFileIfPresent(
    files,
    `launch/${payload.launchWorkflow?.summaryFileName || "launch-workflow.txt"}`,
    payload.launchWorkflow?.summaryText || ""
  );
  appendLaunchWorkflowFileIfPresent(
    files,
    `launch/${payload.launchWorkflow?.checklistFileName || "launch-workflow-checklist.txt"}`,
    payload.launchWorkflow?.checklistText || ""
  );
  appendLaunchWorkflowFileIfPresent(
    files,
    `ops/${payload.opsSnapshot?.summaryFileName || "developer-ops-summary.txt"}`,
    payload.opsSnapshot?.summaryText || ""
  );
  appendLaunchWorkflowFileIfPresent(
    files,
    `ops/${payload.opsSnapshot?.fileName || "developer-ops.json"}`,
    payload.opsSnapshot ? JSON.stringify(payload.opsSnapshot, null, 2) : ""
  );
  return files;
}

function buildDeveloperLaunchReviewZipEntries(payload = {}) {
  const root = buildArchiveRootName(payload.fileName, "developer-launch-review");
  return buildZipEntriesFromFiles(root, buildDeveloperLaunchReviewFiles(payload));
}

function buildDeveloperLaunchReviewDownloadAsset(payload, format = "json") {
  const normalizedFormat = normalizeDownloadFormat(
    format,
    ["json", "summary", "checksums", "zip"],
    "json",
    "INVALID_DEVELOPER_LAUNCH_REVIEW_FORMAT",
    "Developer launch review format"
  );

  if (normalizedFormat === "zip") {
    return {
      fileName: `${buildArchiveRootName(payload.fileName, "developer-launch-review")}.zip`,
      contentType: "application/zip",
      body: buildZipArchive(buildDeveloperLaunchReviewZipEntries(payload))
    };
  }
  if (normalizedFormat === "checksums") {
    return {
      fileName: buildChecksumFileName(payload.fileName, "developer-launch-review"),
      contentType: "text/plain; charset=utf-8",
      body: buildChecksumManifestText(buildDeveloperLaunchReviewFiles(payload))
    };
  }
  if (normalizedFormat === "summary") {
    return {
      fileName: payload.summaryFileName || "developer-launch-review-summary.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.summaryText || ""
    };
  }

  return {
    fileName: payload.fileName || "developer-launch-review.json",
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(payload, null, 2)
  };
}

function buildLaunchSmokeAccountCandidates(accounts = [], limit = 3) {
  const items = Array.isArray(accounts) ? accounts : [];
  const scoreAccount = (item = {}) => {
    const username = String(item?.username || "").trim().toLowerCase();
    let score = 0;
    if (username.includes("seed") || username.includes("starter")) {
      score += 50;
    }
    if (username.includes("qa") || username.includes("test")) {
      score += 30;
    }
    if (username.includes("support") || username.includes("ops") || username.includes("demo")) {
      score += 20;
    }
    score += Math.min(20, Number(item?.activeEntitlementCount || 0) * 10);
    score += Math.min(10, Number(item?.activeSessionCount || 0) * 2);
    return score;
  };
  return items
    .filter((item) => String(item?.status || "active").trim().toLowerCase() === "active")
    .sort((left, right) => {
      const scoreDelta = scoreAccount(right) - scoreAccount(left);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return String(left?.username || "").localeCompare(String(right?.username || ""));
    })
    .slice(0, Math.max(1, Number(limit || 0) || 3))
    .map((item) => ({
      accountId: item.id,
      username: item.username,
      status: item.status,
      activeEntitlementCount: Number(item.activeEntitlementCount || 0),
      activeSessionCount: Number(item.activeSessionCount || 0),
      latestEntitlementEndsAt: item.latestEntitlementEndsAt || null,
      suggestedUse: scoreAccount(item) >= 50
        ? "Starter / internal smoke account"
        : Number(item.activeEntitlementCount || 0) > 0
          ? "Account-login smoke path"
          : "Reusable internal account"
    }));
}

function buildLaunchSmokeEntitlementCandidates(entitlements = [], accountCandidates = [], limit = 3) {
  const accountUsernames = new Set(
    (Array.isArray(accountCandidates) ? accountCandidates : [])
      .map((item) => String(item?.username || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const items = Array.isArray(entitlements) ? entitlements : [];
  return items
    .filter((item) => String(item?.lifecycleStatus || item?.status || "").trim().toLowerCase() === "active")
    .sort((left, right) => {
      const leftMatch = accountUsernames.has(String(left?.username || "").trim().toLowerCase()) ? 1 : 0;
      const rightMatch = accountUsernames.has(String(right?.username || "").trim().toLowerCase()) ? 1 : 0;
      if (leftMatch !== rightMatch) {
        return rightMatch - leftMatch;
      }
      return String(left?.username || "").localeCompare(String(right?.username || ""));
    })
    .slice(0, Math.max(1, Number(limit || 0) || 3))
    .map((item) => ({
      entitlementId: item.id,
      username: item.username,
      policyName: item.policyName,
      grantType: item.grantType,
      endsAt: item.endsAt || null,
      remainingPoints: Number(item.remainingPoints || 0),
      sourceCardKeyMasked: item.sourceCardKeyMasked || (item.sourceCardKey ? maskCardKey(item.sourceCardKey) : null)
    }));
}

function buildLaunchSmokeCardCandidates(cards = [], cardInventoryStates = [], mode = "", limit = 3) {
  const states = (Array.isArray(cardInventoryStates) ? cardInventoryStates : [])
    .filter((item) => String(item?.mode || "").trim().toLowerCase() === String(mode || "").trim().toLowerCase());
  const seenKeys = new Set();
  const candidates = [];
  for (const state of states) {
    for (const item of collectFreshCardsMatchingLaunchDraft(cards, state, Math.max(3, Number(limit || 0) * 2 || 6))) {
      const cardKey = String(item?.cardKey || "").trim();
      if (!cardKey || seenKeys.has(cardKey)) {
        continue;
      }
      seenKeys.add(cardKey);
      candidates.push({
        cardKey,
        cardKeyMasked: maskCardKey(cardKey),
        batchCode: item.batchCode || "",
        policyName: item.policyName || "",
        grantType: item.grantType || state.grantType || "",
        usageStatus: item.usageStatus || item.displayStatus || "",
        displayStatus: item.displayStatus || item.usageStatus || "",
        expiresAt: item.expiresAt || null,
        mode: state.mode,
        label: state.label || state.mode || mode,
        prefix: state.prefix || "",
        purpose: state.purpose || "",
        suggestedUse: state.mode === "direct_card"
          ? "Direct-card smoke login"
          : "Recharge / renewal smoke flow"
      });
      if (candidates.length >= Math.max(1, Number(limit || 0) || 3)) {
        return candidates;
      }
    }
  }
  return candidates;
}

function buildDeveloperLaunchSmokeKitSummaryPayload({
  launchWorkflow = null,
  accounts = [],
  entitlements = [],
  cards = [],
  filters = {}
} = {}) {
  const manifest = launchWorkflow?.manifest || {};
  const project = manifest.project || {};
  const featureConfig = project?.featureConfig && typeof project.featureConfig === "object"
    ? project.featureConfig
    : {};
  const authReadiness = launchWorkflow?.authorizationReadiness || manifest.authorizationReadiness || {};
  const launchRecommendations = authReadiness.launchRecommendations && typeof authReadiness.launchRecommendations === "object"
    ? authReadiness.launchRecommendations
    : {};
  const cardInventoryStates = Array.isArray(launchRecommendations.cardInventoryStates)
    ? launchRecommendations.cardInventoryStates
    : [];
  const integrationPackage = launchWorkflow?.integrationPackage || {};
  const startupPreview = integrationPackage?.manifest?.startupPreview || {};
  const startupDecision = startupPreview.decision || {};
  const startupRequest = startupPreview.request || integrationPackage?.manifest?.startupDefaults || {
    productCode: project.code || filters.productCode || null,
    clientVersion: "1.0.0",
    channel: manifest.channel || filters.channel || "stable",
    includeTokenKeys: true
  };
  const tokenKeySummary = startupPreview.tokenKeySummary || {};
  const clientHardening = startupPreview.clientHardening || integrationPackage?.manifest?.clientHardening || {};

  const accountCandidates = buildLaunchSmokeAccountCandidates(accounts, 3);
  const entitlementCandidates = buildLaunchSmokeEntitlementCandidates(entitlements, accountCandidates, 3);
  const directCardCandidates = buildLaunchSmokeCardCandidates(cards, cardInventoryStates, "direct_card", 3);
  const rechargeCardCandidates = buildLaunchSmokeCardCandidates(cards, cardInventoryStates, "recharge", 3);

  const accountLoginEnabled = featureConfig.allowAccountLogin !== false;
  const registerEnabled = featureConfig.allowRegister !== false;
  const cardLoginEnabled = featureConfig.allowCardLogin !== false;
  const cardRechargeEnabled = featureConfig.allowCardRecharge !== false;
  const startupBlocked = String(startupDecision.status || "").trim().toLowerCase() === "hold";

  const accountLoginReady = accountLoginEnabled && (registerEnabled || accountCandidates.length > 0);
  const directCardReady = cardLoginEnabled && directCardCandidates.length > 0;
  const rechargeReady = cardRechargeEnabled && (registerEnabled || accountCandidates.length > 0) && rechargeCardCandidates.length > 0;

  const verificationPaths = [
    {
      key: "startup_bootstrap",
      label: "Startup bootstrap",
      ready: !startupBlocked,
      status: startupBlocked ? "block" : String(startupDecision.status || "").trim().toLowerCase() === "ready" ? "pass" : "review",
      summary: startupDecision.message || "Use the current startup request before login or recharge UI is shown."
    },
    accountLoginEnabled ? {
      key: "account_login",
      label: "Account login smoke",
      ready: accountLoginReady,
      status: accountLoginReady ? "pass" : registerEnabled ? "review" : "block",
      summary: accountLoginReady
        ? "At least one internal account path is available for smoke testing."
        : registerEnabled
          ? "Account login is enabled, but you still need a registered internal account before smoke testing."
          : "Account login is enabled, but closed registration still needs at least one starter account."
    } : null,
    cardLoginEnabled ? {
      key: "direct_card_login",
      label: "Direct-card login smoke",
      ready: directCardReady,
      status: directCardReady ? "pass" : "block",
      summary: directCardReady
        ? "Fresh direct-card inventory is available for first-login smoke tests."
        : "Direct-card login is enabled, but no fresh direct-card keys are staged yet."
    } : null,
    cardRechargeEnabled ? {
      key: "recharge_flow",
      label: "Recharge flow smoke",
      ready: rechargeReady,
      status: rechargeReady ? "pass" : accountLoginEnabled && !registerEnabled ? "block" : "review",
      summary: rechargeReady
        ? "Recharge inventory and an internal account path are both ready for top-up / renewal smoke tests."
        : "Recharge flow still needs both fresh recharge keys and an internal account path."
    } : null,
    {
      key: "heartbeat_follow_up",
      label: "Heartbeat follow-up",
      ready: !startupBlocked,
      status: startupBlocked ? "review" : "pass",
      summary: "After any login or recharge smoke test, confirm a heartbeat succeeds and the session appears in Launch Review / Developer Ops."
    }
  ].filter(Boolean);

  const blockingPaths = verificationPaths.filter((item) => item.status === "block");
  const readyPaths = verificationPaths.filter((item) => item.ready && item.status !== "block");
  const reviewPaths = verificationPaths.filter((item) => item.status === "review");

  const recommendedWorkspace = blockingPaths.length
    ? createLaunchWorkflowWorkspaceShortcut("licenses", "quickstart", "Open License Workspace")
    : createLaunchWorkflowWorkspaceShortcut("launch-smoke", "summary", "Open Launch Smoke");
  const workspaceActions = [];
  const seenWorkspaceActions = new Set();
  const pushWorkspaceAction = (action) => {
    if (!action?.key) {
      return;
    }
    const dedupeKey = `${action.key}|${action.autofocus || ""}|${JSON.stringify(action.params || {})}`;
    if (seenWorkspaceActions.has(dedupeKey)) {
      return;
    }
    seenWorkspaceActions.add(dedupeKey);
    workspaceActions.push(action);
  };
  pushWorkspaceAction(recommendedWorkspace);
  pushWorkspaceAction(createLaunchWorkflowWorkspaceShortcut("launch", "handoff", "Open Launch Workflow"));
  pushWorkspaceAction(createLaunchWorkflowWorkspaceShortcut("launch-review", "summary", "Open Launch Review"));
  pushWorkspaceAction(createLaunchWorkflowWorkspaceShortcut("ops", "snapshot", "Open Ops Workspace", { reviewMode: "matched" }));
  const recommendedDownloads = [
    createLaunchWorkflowSmokeKitDownloadShortcut(
      "Launch smoke kit summary",
      "launch-smoke-kit.txt",
      "summary",
      { reviewMode: "matched" }
    )
  ];
  const bootstrapAction = authReadiness.bootstrapAction || null;
  const setupAction = authReadiness.firstBatchSetupAction || null;
  const compactSmokeFocusParams = (params = {}) => Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "")
  );
  const buildSmokeReviewFocusParams = (kind, item = {}) => {
    if (!item || typeof item !== "object") {
      return {};
    }
    const productCode = item.productCode || item.projectCode || project.code || filters.productCode || null;
    const username = item.username || null;
    const reason = item.reason || item.revokedReason || item.suggestedUse || null;
    const fingerprint = item.fingerprint || null;
    if (kind === "account") {
      return compactSmokeFocusParams({
        focusKind: "account",
        focusAccountId: item.accountId || item.id || null,
        focusUsername: username,
        focusReason: reason,
        focusFingerprint: fingerprint,
        focusProductCode: productCode
      });
    }
    if (kind === "entitlement") {
      return compactSmokeFocusParams({
        focusKind: "entitlement",
        focusEntitlementId: item.entitlementId || item.id || null,
        focusUsername: username,
        focusReason: reason,
        focusProductCode: productCode
      });
    }
    if (kind === "session") {
      return compactSmokeFocusParams({
        focusKind: "session",
        focusSessionId: item.sessionId || item.id || null,
        focusUsername: username,
        focusReason: reason,
        focusFingerprint: fingerprint,
        focusProductCode: productCode
      });
    }
    if (kind === "device") {
      return compactSmokeFocusParams({
        focusKind: "device",
        focusBindingId: item.bindingId || (item.kind === "binding" ? item.id || null : null),
        focusBlockId: item.blockId || (item.kind === "block" ? item.id || null : null),
        focusFingerprint: fingerprint,
        focusUsername: username,
        focusReason: reason,
        focusProductCode: productCode
      });
    }
    return compactSmokeFocusParams({
      focusProductCode: productCode,
      focusUsername: username,
      focusReason: reason,
      focusFingerprint: fingerprint
    });
  };
  const createSmokeReviewTarget = ({
    key,
    label,
    summary,
    count = 0,
    status = "review",
    routeActionLabel = "",
    workspaceAction = null,
    recommendedDownload = null,
    recommendedControl = null
  } = {}) => {
    if (!key) {
      return null;
    }
    return {
      key,
      label: label || key,
      summary: summary || "-",
      count: Number.isFinite(Number(count)) ? Number(count) : 0,
      status: status || "review",
      routeActionLabel: routeActionLabel || "",
      recommendedControl: recommendedControl || null,
      workspaceAction: workspaceAction || null,
      recommendedDownload: recommendedDownload || null
    };
  };
  const reviewTargets = [
    accountLoginEnabled ? createSmokeReviewTarget({
      key: "launch_smoke_accounts_review",
      label: "Review smoke accounts",
      summary: accountLoginReady
        ? "Confirm the internal smoke account path is still reserved for launch-day validation before opening wider access."
        : registerEnabled
          ? "Register or confirm one internal smoke account before the first validation pass."
          : "Seed a starter account before account-login smoke validation can continue.",
      count: accountCandidates.length,
      status: accountLoginReady ? "pass" : registerEnabled ? "review" : "block",
      routeActionLabel: buildFocusKindControlLabel("account"),
      recommendedControl: buildDeveloperOpsReviewRecommendedControl("account", accountCandidates[0] || null),
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("ops", "accounts", buildFocusKindControlLabel("account", " in Ops"), {
        reviewMode: "matched",
        routeAction: buildFocusKindControlRouteAction("account"),
        actorType: "account",
        username: accountCandidates[0]?.username || "",
        ...buildSmokeReviewFocusParams("account", accountCandidates[0] || {
          productCode: project.code || filters.productCode || null
        })
      }),
      recommendedDownload: createLaunchWorkflowDownloadShortcut(
        "launch_smoke_accounts_summary",
        "developer-ops-accounts-summary.txt",
        "Accounts summary",
        {
          source: "developer-ops",
          format: "summary",
          params: {
            reviewMode: "matched",
            actorType: "account",
            username: accountCandidates[0]?.username || "",
            productCode: project.code || filters.productCode || "",
            limit: 60
          }
        }
      )
    }) : null,
    (entitlementCandidates.length || (accountLoginEnabled && !cardLoginEnabled && !cardRechargeEnabled)) ? createSmokeReviewTarget({
      key: "launch_smoke_entitlements_review",
      label: "Review smoke entitlements",
      summary: entitlementCandidates.length
        ? "Confirm the smoke entitlement window, grant type, and lifecycle state before handing the lane to QA or support."
        : "Account-only smoke lanes should still confirm an internal starter entitlement before first validation.",
      count: entitlementCandidates.length,
      status: entitlementCandidates.length ? "pass" : "review",
      routeActionLabel: buildFocusKindControlLabel("entitlement"),
      recommendedControl: buildDeveloperOpsReviewRecommendedControl("entitlement", entitlementCandidates[0] || null),
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("ops", "entitlements", buildFocusKindControlLabel("entitlement", " in Ops"), {
        reviewMode: "matched",
        routeAction: buildFocusKindControlRouteAction("entitlement"),
        username: entitlementCandidates[0]?.username || accountCandidates[0]?.username || "",
        ...buildSmokeReviewFocusParams("entitlement", entitlementCandidates[0] || {
          productCode: project.code || filters.productCode || null,
          username: accountCandidates[0]?.username || null
        })
      }),
      recommendedDownload: createLaunchWorkflowDownloadShortcut(
        "launch_smoke_entitlements_summary",
        "developer-ops-entitlements-summary.txt",
        "Entitlements summary",
        {
          source: "developer-ops",
          format: "summary",
          params: {
            reviewMode: "matched",
            username: entitlementCandidates[0]?.username || accountCandidates[0]?.username || "",
            productCode: project.code || filters.productCode || "",
            limit: 60
          }
        }
      )
    }) : null,
    (cardLoginEnabled || cardRechargeEnabled) ? createSmokeReviewTarget({
      key: "launch_smoke_card_inventory_review",
      label: "Review launch card inventory",
      summary: (directCardCandidates.length || rechargeCardCandidates.length)
        ? "Confirm the fresh direct-card or recharge inventory that will be consumed during the first internal smoke pass."
        : "Review launch-card inventory before smoke validation so direct-card or recharge paths have real fresh keys staged.",
      count: directCardCandidates.length + rechargeCardCandidates.length,
      status: (cardLoginEnabled && !directCardReady) || (cardRechargeEnabled && !rechargeReady) ? "review" : "pass",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("licenses", "cards", "Open License Workspace"),
      recommendedDownload: createLaunchWorkflowSmokeKitDownloadShortcut(
        "Launch smoke kit summary",
        "launch-smoke-kit.txt",
        "summary",
        { reviewMode: "matched" }
      )
    }) : null,
    readyPaths.length ? createSmokeReviewTarget({
      key: "launch_smoke_sessions_review",
      label: "Review smoke sessions",
      summary: "After the first smoke login or recharge succeeds, confirm the resulting session and heartbeat state before wider rollout.",
      count: readyPaths.length,
      status: startupBlocked ? "review" : "pass",
      routeActionLabel: buildFocusKindControlLabel("session"),
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("ops", "sessions", buildFocusKindControlLabel("session", " in Ops"), {
        reviewMode: "matched",
        routeAction: buildFocusKindControlRouteAction("session"),
        eventType: "session.login",
        actorType: "account",
        username: accountCandidates[0]?.username || "",
        ...buildSmokeReviewFocusParams("session", {
          productCode: project.code || filters.productCode || null,
          username: accountCandidates[0]?.username || null,
          suggestedUse: "Launch smoke session review"
        })
      }),
      recommendedDownload: createLaunchWorkflowDownloadShortcut(
        "launch_smoke_sessions_summary",
        "developer-ops-sessions-summary.txt",
        "Sessions summary",
        {
          source: "developer-ops",
          format: "summary",
          params: {
            reviewMode: "matched",
            eventType: "session.login",
            actorType: "account",
            username: accountCandidates[0]?.username || "",
            productCode: project.code || filters.productCode || "",
            limit: 60
          }
        }
      )
    }) : null,
    (cardRechargeEnabled || directCardCandidates.length || rechargeCardCandidates.length) ? createSmokeReviewTarget({
      key: "launch_smoke_audit_review",
      label: "Review smoke audit trail",
      summary: "Check the earliest login, redemption, and launch-day audit events so the first smoke pass leaves a clean signal trail.",
      count: (directCardCandidates.length + rechargeCardCandidates.length) || readyPaths.length,
      status: blockingPaths.length ? "review" : "pass",
      routeActionLabel: "Review Audit",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("ops", "audit", "Open Ops Workspace", {
        reviewMode: "matched",
        routeAction: "review-audit",
        entityType: (directCardCandidates.length || rechargeCardCandidates.length) ? "license_key" : "",
        eventType: readyPaths.length ? "session.login" : "",
        username: accountCandidates[0]?.username || ""
      }),
      recommendedDownload: createLaunchWorkflowDownloadShortcut(
        "launch_smoke_audit_summary",
        "developer-ops-audit-summary.txt",
        "Audit summary",
        {
          source: "developer-ops",
          format: "summary",
          params: {
            reviewMode: "matched",
            entityType: (directCardCandidates.length || rechargeCardCandidates.length) ? "license_key" : "",
            eventType: readyPaths.length ? "session.login" : "",
            username: accountCandidates[0]?.username || "",
            productCode: project.code || filters.productCode || "",
            limit: 60
          }
        }
      )
    }) : null
  ].filter(Boolean);
  const visibleReviewTargets = reviewTargets.some((item) => Number(item.count || 0) > 0)
    ? reviewTargets.filter((item) => Number(item.count || 0) > 0)
    : reviewTargets.slice(0, 2);
  const rawPrimaryReviewTarget = visibleReviewTargets.find((item) => recommendedControlPriority(item?.recommendedControl) >= 2 && item?.workspaceAction)
    || visibleReviewTargets.find((item) => recommendedControlPriority(item?.recommendedControl) >= 1 && item?.workspaceAction)
    || visibleReviewTargets.find((item) => item?.workspaceAction)
    || visibleReviewTargets[0]
    || null;
  const primaryReviewTarget = rawPrimaryReviewTarget?.workspaceAction?.key === "ops"
    ? {
        ...rawPrimaryReviewTarget,
        routeActionLabel: buildFocusKindControlLabel(rawPrimaryReviewTarget.workspaceAction?.params?.focusKind),
        workspaceAction: {
          ...rawPrimaryReviewTarget.workspaceAction,
          label: buildFocusKindControlLabel(rawPrimaryReviewTarget.workspaceAction?.params?.focusKind, " in Ops"),
          params: {
            ...(rawPrimaryReviewTarget.workspaceAction.params && typeof rawPrimaryReviewTarget.workspaceAction.params === "object"
              ? rawPrimaryReviewTarget.workspaceAction.params
              : {}),
            routeAction: buildFocusKindControlRouteAction(rawPrimaryReviewTarget.workspaceAction?.params?.focusKind)
          }
        },
        recommendedDownload: createLaunchWorkflowPrimaryOpsDownloadShortcut(rawPrimaryReviewTarget.workspaceAction)
          || rawPrimaryReviewTarget.recommendedDownload
          || null
      }
    : rawPrimaryReviewTarget;
  if (primaryReviewTarget?.workspaceAction) {
    pushWorkspaceAction(primaryReviewTarget.workspaceAction);
  }
  if (primaryReviewTarget?.recommendedDownload?.key) {
    recommendedDownloads.push({
      ...primaryReviewTarget.recommendedDownload,
      params: primaryReviewTarget.recommendedDownload.params && typeof primaryReviewTarget.recommendedDownload.params === "object"
        ? { ...primaryReviewTarget.recommendedDownload.params }
        : primaryReviewTarget.recommendedDownload.params
    });
  }
  const remainingReviewDownload = primaryReviewTarget?.workspaceAction?.key === "ops"
    ? createLaunchWorkflowRemainingOpsDownloadShortcut(primaryReviewTarget.workspaceAction)
    : null;
  if (remainingReviewDownload?.key) {
    recommendedDownloads.push({
      ...remainingReviewDownload,
      params: remainingReviewDownload.params && typeof remainingReviewDownload.params === "object"
        ? { ...remainingReviewDownload.params }
        : remainingReviewDownload.params
    });
  }
  for (const item of visibleReviewTargets) {
    pushWorkspaceAction(item.workspaceAction);
  }
  const actionPlan = [
    {
      key: "startup_bootstrap_recheck",
      title: "Verify the startup bootstrap request",
      priority: "primary",
      status: verificationPaths.find((item) => item.key === "startup_bootstrap")?.status || "review",
      summary: startupDecision.message || "Use the staged startup request, then confirm the lane is not blocked by version rules or notices.",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("launch-smoke", "summary", "Open Launch Smoke"),
      recommendedDownload: createLaunchWorkflowSmokeKitDownloadShortcut("Launch smoke kit summary", "launch-smoke-kit.txt", "summary", { reviewMode: "matched" })
    },
    bootstrapAction ? {
      key: "launch_smoke_bootstrap",
      title: "Seed the missing launch smoke prerequisites",
      priority: readyPaths.length ? "secondary" : "primary",
      status: "review",
      summary: authReadiness.bootstrapSummary || "Run Launch Bootstrap so the smoke lane has the starter policy, account, or internal entitlement it still needs.",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("licenses", "quickstart", "Open License Workspace"),
      bootstrapAction
    } : null,
    setupAction ? {
      key: setupAction.operation === "restock" ? "launch_smoke_inventory_refill" : "launch_smoke_first_batch_setup",
      title: setupAction.operation === "restock" ? "Refill launch smoke inventory" : "Create launch smoke inventory",
      priority: readyPaths.length || bootstrapAction ? "secondary" : "primary",
      status: "review",
      summary: authReadiness.firstBatchSetupSummary
        || (setupAction.operation === "restock"
          ? "Top the current launch card buffer back up before running internal smoke tests."
          : "Create the recommended launch card inventory before running internal smoke tests."),
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("licenses", "cards", "Open License Workspace"),
      setupAction
    } : null,
    readyPaths.length ? {
      key: "launch_smoke_execution",
      title: "Run the first internal smoke path",
      priority: "primary",
      status: "review",
      summary: `Use one of the ready smoke paths first: ${readyPaths.map((item) => item.label).join(" / ")}.`,
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("launch-smoke", "summary", "Open Launch Smoke"),
      recommendedDownload: createLaunchWorkflowSmokeKitDownloadShortcut("Launch smoke kit summary", "launch-smoke-kit.txt", "summary", { reviewMode: "matched" })
    } : null,
    primaryReviewTarget?.workspaceAction ? {
      key: "launch_smoke_primary_review",
      title: buildPrimaryReviewStepTitle(
        primaryReviewTarget.workspaceAction,
        primaryReviewTarget.recommendedControl
      ),
      priority: "secondary",
      status: primaryReviewTarget.status || "review",
      summary: primaryReviewTarget.summary || `${buildPrimaryReviewStepTitle(
        primaryReviewTarget.workspaceAction,
        primaryReviewTarget.recommendedControl
      )} after setup so first-wave follow-up starts with the most important match.`,
      workspaceAction: primaryReviewTarget.workspaceAction,
      recommendedDownload: primaryReviewTarget.recommendedDownload || null
    } : null,
    remainingReviewDownload ? {
      key: "launch_smoke_remaining_queue",
      title: "Hand off the remaining routed review queue",
      priority: "secondary",
      status: "review",
      summary: "After the primary smoke follow-up is ready, pass the remaining matched runtime queue forward so review can continue without rebuilding filters.",
      workspaceAction: primaryReviewTarget?.workspaceAction || null,
      recommendedDownload: remainingReviewDownload
    } : null,
    ...visibleReviewTargets.slice(0, 3).map((item) => createLaunchWorkflowActionPlanStep({
      key: item.key,
      title: buildReviewTargetActionPlanTitle(item),
      priority: "secondary",
      status: item.status || "review",
      summary: item.summary || "-",
      workspaceAction: item.workspaceAction || null,
      recommendedDownload: item.recommendedDownload || null
    })),
    {
      key: "ops_follow_up",
      title: "Recheck sessions and audit after smoke login",
      priority: "secondary",
      status: "review",
      summary: "After a successful smoke login or recharge, confirm the resulting session and audit signal inside Developer Ops.",
      workspaceAction: createLaunchWorkflowWorkspaceShortcut("ops", "sessions", "Open Ops Workspace", {
        reviewMode: "matched",
        routeAction: "review-sessions",
        eventType: "session.login",
        actorType: "account"
      })
    }
  ].filter(Boolean);

  const status = startupBlocked || !readyPaths.length
    ? "block"
    : blockingPaths.length || reviewPaths.length
      ? "review"
      : "ready";

  return {
    status,
    title: status === "block"
      ? "Launch smoke kit still has blockers"
      : status === "review"
        ? "Launch smoke kit needs one more setup pass"
        : "Launch smoke kit is ready",
    message: status === "block"
      ? "Clear the remaining launch blockers before handing this lane to QA, support, or launch-duty smoke testing."
      : status === "review"
        ? "The lane is close, but one or more smoke paths still need review before first-wave validation."
        : "The lane has a usable startup request and at least one internal smoke path ready for first-wave validation.",
    startupRequest,
    startupDecision,
    tokenKeySummary,
    clientHardening,
    verificationPaths,
    accountCandidates,
    entitlementCandidates,
    directCardCandidates,
    rechargeCardCandidates,
    recommendedWorkspace,
    workspaceActions,
    primaryReviewTarget,
    reviewTargets: visibleReviewTargets,
    actionPlan,
    recommendedDownloads
  };
}

function buildDeveloperLaunchSmokeKitSummaryText(payload = {}) {
  const manifest = payload.manifest || {};
  const project = manifest.project || {};
  const smokeSummary = payload.smokeSummary || {};
  const formatWorkspaceActionText = (action = null) => {
    if (!action || typeof action !== "object") {
      return "-";
    }
    return `${action.label || action.key || "workspace"}${action.autofocus ? `@${action.autofocus}` : ""}`;
  };
  const lines = [
    "RockSolid Developer Launch Smoke Kit",
    `Generated At: ${payload.generatedAt || ""}`,
    `Project Code: ${project.code || "-"}`,
    `Project Name: ${project.name || "-"}`,
    `Channel: ${manifest.channel || "-"}`,
    "",
    `Smoke Status: ${String(smokeSummary.status || "unknown").toUpperCase()}`,
    `Smoke Title: ${smokeSummary.title || "-"}`,
    `Smoke Message: ${smokeSummary.message || "-"}`,
    "",
    "Startup Request:",
    `- productCode: ${smokeSummary.startupRequest?.productCode || project.code || "-"}`,
    `- clientVersion: ${smokeSummary.startupRequest?.clientVersion || "-"}`,
    `- channel: ${smokeSummary.startupRequest?.channel || manifest.channel || "-"}`,
    `- includeTokenKeys: ${smokeSummary.startupRequest?.includeTokenKeys === false ? "false" : "true"}`,
    `- startupDecision: ${String(smokeSummary.startupDecision?.status || "unknown").toUpperCase()} | ${smokeSummary.startupDecision?.message || "-"}`,
    `- tokenKeys: active=${smokeSummary.tokenKeySummary?.activeKeyId || "-"} | total=${smokeSummary.tokenKeySummary?.totalKeys ?? 0}`,
    `- hardening: profile=${smokeSummary.clientHardening?.profile || "-"} | startup=${smokeSummary.clientHardening?.startupBootstrapRequired ? "required" : "recommended"} | localToken=${smokeSummary.clientHardening?.localTokenValidationRequired ? "required" : "optional"} | heartbeat=${smokeSummary.clientHardening?.heartbeatGateRequired ? "required" : "optional"}`
  ];

  if (Array.isArray(smokeSummary.verificationPaths) && smokeSummary.verificationPaths.length) {
    lines.push("");
    lines.push("Launch Smoke Paths:");
    for (const item of smokeSummary.verificationPaths) {
      lines.push(`- [${String(item.status || "review").toUpperCase()}] ${item.label || item.key || "path"} | ready=${item.ready ? "yes" : "no"} | ${item.summary || "-"}`);
    }
  }

  if (Array.isArray(smokeSummary.accountCandidates) && smokeSummary.accountCandidates.length) {
    lines.push("");
    lines.push("Account Candidates:");
    for (const item of smokeSummary.accountCandidates) {
      lines.push(`- ${item.username || "-"} | entitlements=${item.activeEntitlementCount ?? 0} | sessions=${item.activeSessionCount ?? 0} | suggestedUse=${item.suggestedUse || "-"} | ends=${item.latestEntitlementEndsAt || "-"}`);
    }
  }

  if (Array.isArray(smokeSummary.entitlementCandidates) && smokeSummary.entitlementCandidates.length) {
    lines.push("");
    lines.push("Entitlement Candidates:");
    for (const item of smokeSummary.entitlementCandidates) {
      lines.push(`- ${item.username || "-"} | policy=${item.policyName || "-"} | grant=${item.grantType || "-"} | ends=${item.endsAt || "-"} | source=${item.sourceCardKeyMasked || "-"}`);
    }
  }

  if (Array.isArray(smokeSummary.directCardCandidates) && smokeSummary.directCardCandidates.length) {
    lines.push("");
    lines.push("Direct-Card Candidates:");
    for (const item of smokeSummary.directCardCandidates) {
      lines.push(`- ${item.cardKey || "-"} | batch=${item.batchCode || "-"} | policy=${item.policyName || "-"} | purpose=${item.purpose || "-"} | suggestedUse=${item.suggestedUse || "-"}`);
    }
  }

  if (Array.isArray(smokeSummary.rechargeCardCandidates) && smokeSummary.rechargeCardCandidates.length) {
    lines.push("");
    lines.push("Recharge Candidates:");
    for (const item of smokeSummary.rechargeCardCandidates) {
      lines.push(`- ${item.cardKey || "-"} | batch=${item.batchCode || "-"} | policy=${item.policyName || "-"} | purpose=${item.purpose || "-"} | suggestedUse=${item.suggestedUse || "-"}`);
    }
  }

  if (Array.isArray(smokeSummary.actionPlan) && smokeSummary.actionPlan.length) {
    lines.push("");
    lines.push("Launch Smoke Action Plan:");
    for (const item of smokeSummary.actionPlan) {
      lines.push(
        `- ${item.title || item.key || "step"} | ${String(item.priority || "secondary").toUpperCase()} | ${item.summary || "-"}${item.workspaceAction ? ` | workspace=${formatWorkspaceActionText(item.workspaceAction)}` : ""}${item.recommendedDownload ? ` | download=${item.recommendedDownload.label || item.recommendedDownload.key || "-"}:${item.recommendedDownload.fileName || "-"}` : ""}${item.bootstrapAction ? ` | bootstrap=${item.bootstrapAction.label || item.bootstrapAction.key || "-"}` : ""}${item.setupAction ? ` | setup=${item.setupAction.label || item.setupAction.key || "-"}@${item.setupAction.mode || "recommended"}:${item.setupAction.operation || "first_batch_setup"}` : ""}`
      );
    }
  }

  if (smokeSummary.primaryReviewTarget) {
    const item = smokeSummary.primaryReviewTarget;
    lines.push("");
    lines.push("Launch Smoke Primary Review Target:");
    lines.push(
      `- ${item.label || item.key || "target"} | count=${item.count ?? 0} | ${String(item.status || "review").toUpperCase()} | ${item.summary || "-"}`
      + `${item.routeActionLabel ? ` | action=${item.routeActionLabel}` : ""}`
      + `${item.recommendedControl?.label ? ` | control=${item.recommendedControl.label}` : ""}`
      + `${item.workspaceAction ? ` | workspace=${formatWorkspaceActionText(item.workspaceAction)}` : ""}`
      + `${item.recommendedDownload ? ` | download=${item.recommendedDownload.label || item.recommendedDownload.key || "-"}` : ""}`
    );
  }

  if (Array.isArray(smokeSummary.reviewTargets) && smokeSummary.reviewTargets.length) {
    lines.push("");
    lines.push("Launch Smoke Review Targets:");
    for (const item of smokeSummary.reviewTargets) {
      lines.push(
        `- ${item.label || item.key || "target"} | count=${item.count ?? 0} | ${String(item.status || "review").toUpperCase()} | ${item.summary || "-"}${item.routeActionLabel ? ` | action=${item.routeActionLabel}` : ""}${item.recommendedControl?.label ? ` | control=${item.recommendedControl.label}` : ""}${item.workspaceAction ? ` | workspace=${formatWorkspaceActionText(item.workspaceAction)}` : ""}${item.recommendedDownload ? ` | download=${item.recommendedDownload.label || item.recommendedDownload.key || "-"}` : ""}`
      );
    }
  }

  return lines.join("\n").trimEnd();
}

function buildDeveloperLaunchSmokeKitPayload({
  generatedAt = nowIso(),
  launchWorkflow = null,
  accounts = [],
  entitlements = [],
  cards = [],
  filters = {}
} = {}) {
  const manifest = launchWorkflow?.manifest || {};
  const project = manifest.project || {};
  const channel = manifest.channel || filters.channel || "stable";
  const timestampTag = buildExportTimestampTag(generatedAt);
  const scopeTag = sanitizeExportNameSegment(project.code || filters.productCode || "launch-smoke-kit", "launch-smoke-kit");
  const fileName = `rocksolid-developer-launch-smoke-kit-${scopeTag}-${channel}-${timestampTag}.json`;
  const summaryFileName = `rocksolid-developer-launch-smoke-kit-${scopeTag}-${channel}-${timestampTag}-summary.txt`;
  const payload = {
    generatedAt,
    fileName,
    summaryFileName,
    manifest: {
      generatedAt,
      channel,
      project: {
        id: project.id || null,
        code: project.code || filters.productCode || null,
        name: project.name || ""
      }
    },
    filters: {
      productCode: project.code || filters.productCode || null,
      channel
    },
    launchWorkflow,
    smokeSummary: buildDeveloperLaunchSmokeKitSummaryPayload({
      launchWorkflow,
      accounts,
      entitlements,
      cards,
      filters
    }),
    notes: [
      "This smoke kit is meant for internal QA, support, or launch-duty validation after launch bootstrap, first-batch setup, or inventory refill.",
      "Treat any account credentials or fresh card keys in this package as internal validation material and rotate or consume them according to your launch process."
    ]
  };
  payload.summaryText = buildDeveloperLaunchSmokeKitSummaryText(payload);
  return payload;
}

function buildDeveloperLaunchSmokeKitFiles(payload = {}) {
  const files = [
    {
      path: payload.fileName || "developer-launch-smoke-kit.json",
      body: JSON.stringify(payload, null, 2)
    },
    {
      path: payload.summaryFileName || "developer-launch-smoke-kit-summary.txt",
      body: payload.summaryText || ""
    }
  ];
  appendLaunchWorkflowFileIfPresent(
    files,
    `launch/${payload.launchWorkflow?.summaryFileName || "launch-workflow.txt"}`,
    payload.launchWorkflow?.summaryText || ""
  );
  appendLaunchWorkflowFileIfPresent(
    files,
    `launch/${payload.launchWorkflow?.checklistFileName || "launch-workflow-checklist.txt"}`,
    payload.launchWorkflow?.checklistText || ""
  );
  appendLaunchWorkflowFileIfPresent(
    files,
    `integration/${payload.launchWorkflow?.integrationPackage?.snippets?.hostConfigFileName || "rocksolid_host_config.env"}`,
    payload.launchWorkflow?.integrationPackage?.snippets?.hostConfigEnv || ""
  );
  return files;
}

function buildDeveloperLaunchSmokeKitZipEntries(payload = {}) {
  const root = buildArchiveRootName(payload.fileName, "developer-launch-smoke-kit");
  return buildZipEntriesFromFiles(root, buildDeveloperLaunchSmokeKitFiles(payload));
}

function buildDeveloperLaunchSmokeKitDownloadAsset(payload, format = "json") {
  const normalizedFormat = normalizeDownloadFormat(
    format,
    ["json", "summary", "checksums", "zip"],
    "json",
    "INVALID_DEVELOPER_LAUNCH_SMOKE_KIT_FORMAT",
    "Developer launch smoke kit format"
  );

  if (normalizedFormat === "zip") {
    return {
      fileName: `${buildArchiveRootName(payload.fileName, "developer-launch-smoke-kit")}.zip`,
      contentType: "application/zip",
      body: buildZipArchive(buildDeveloperLaunchSmokeKitZipEntries(payload))
    };
  }
  if (normalizedFormat === "checksums") {
    return {
      fileName: buildChecksumFileName(payload.fileName, "developer-launch-smoke-kit"),
      contentType: "text/plain; charset=utf-8",
      body: buildChecksumManifestText(buildDeveloperLaunchSmokeKitFiles(payload))
    };
  }
  if (normalizedFormat === "summary") {
    return {
      fileName: payload.summaryFileName || "developer-launch-smoke-kit-summary.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.summaryText || ""
    };
  }

  return {
    fileName: payload.fileName || "developer-launch-smoke-kit.json",
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(payload, null, 2)
  };
}

function buildIntegrationPackageExportDownloadAsset(payload, format = "json") {
  const normalizedFormat = normalizeDownloadFormat(
    format,
    ["json", "manifests", "env", "host-config", "cmake", "vs2022-guide", "vs2022-sln", "vs2022", "vs2022-filters", "vs2022-props", "vs2022-local-props", "cpp", "host-skeleton", "zip", "checksums"],
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
  if (normalizedFormat === "host-config") {
    return {
      fileName: payload.hostConfigArchiveName || "integration-host-config.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.hostConfigBundleText || ""
    };
  }
  if (normalizedFormat === "cmake") {
    return {
      fileName: payload.cmakeArchiveName || "integration-cmake.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.cmakeBundleText || ""
    };
  }
  if (normalizedFormat === "vs2022-guide") {
    return {
      fileName: payload.vs2022GuideArchiveName || "integration-vs2022-guide.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.vs2022GuideBundleText || ""
    };
  }
  if (normalizedFormat === "vs2022-sln") {
    return {
      fileName: payload.vs2022SolutionArchiveName || "integration-vs2022-sln.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.vs2022SolutionBundleText || ""
    };
  }
  if (normalizedFormat === "vs2022") {
    return {
      fileName: payload.vs2022ArchiveName || "integration-vs2022.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.vs2022BundleText || ""
    };
  }
  if (normalizedFormat === "vs2022-filters") {
    return {
      fileName: payload.vs2022FiltersArchiveName || "integration-vs2022-filters.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.vs2022FiltersBundleText || ""
    };
  }
  if (normalizedFormat === "vs2022-props") {
    return {
      fileName: payload.vs2022PropsArchiveName || "integration-vs2022-props.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.vs2022PropsBundleText || ""
    };
  }
  if (normalizedFormat === "vs2022-local-props") {
    return {
      fileName: payload.vs2022LocalPropsArchiveName || "integration-vs2022-local-props.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.vs2022LocalPropsBundleText || ""
    };
  }
  if (normalizedFormat === "cpp") {
    return {
      fileName: payload.cppArchiveName || "integration-cpp.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.cppBundleText || ""
    };
  }
  if (normalizedFormat === "host-skeleton") {
    return {
      fileName: payload.hostSkeletonArchiveName || "integration-host-skeleton.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.hostSkeletonBundleText || ""
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
    ["json", "env", "host-config", "cmake", "vs2022-guide", "vs2022-sln", "vs2022", "vs2022-filters", "vs2022-props", "vs2022-local-props", "cpp", "host-skeleton", "zip", "checksums"],
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
  if (normalizedFormat === "host-config") {
    return {
      fileName: payload.snippets?.hostConfigFileName || "rocksolid_host_config.env",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.hostConfigEnv || ""
    };
  }
  if (normalizedFormat === "cmake") {
    return {
      fileName: payload.snippets?.cmakeFileName || "CMakeLists.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.cmakeConsumerTemplate || ""
    };
  }
  if (normalizedFormat === "vs2022-guide") {
    return {
      fileName: payload.snippets?.vs2022GuideFileName || "rocksolid_vs2022_quickstart.md",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.vs2022GuideText || ""
    };
  }
  if (normalizedFormat === "vs2022-sln") {
    return {
      fileName: payload.snippets?.vs2022SolutionFileName || "rocksolid_host_consumer.sln",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.vs2022SolutionTemplate || ""
    };
  }
  if (normalizedFormat === "vs2022") {
    return {
      fileName: payload.snippets?.vs2022ProjectFileName || "rocksolid_host_consumer.vcxproj",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.vs2022ProjectTemplate || ""
    };
  }
  if (normalizedFormat === "vs2022-filters") {
    return {
      fileName: payload.snippets?.vs2022FiltersFileName || "rocksolid_host_consumer.vcxproj.filters",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.vs2022FiltersTemplate || ""
    };
  }
  if (normalizedFormat === "vs2022-props") {
    return {
      fileName: payload.snippets?.vs2022PropsFileName || "RockSolidSDK.props",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.vs2022PropsTemplate || ""
    };
  }
  if (normalizedFormat === "vs2022-local-props") {
    return {
      fileName: payload.snippets?.vs2022LocalPropsFileName || "RockSolidSDK.local.props",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.vs2022LocalPropsTemplate || ""
    };
  }
  if (normalizedFormat === "cpp") {
    return {
      fileName: payload.snippets?.cppFileName || "project.cpp",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.cppQuickstart || ""
    };
  }
  if (normalizedFormat === "host-skeleton") {
    return {
      fileName: payload.snippets?.hostSkeletonFileName || "project-host-skeleton.cpp",
      contentType: "text/plain; charset=utf-8",
      body: payload.snippets?.hostSkeletonCpp || ""
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

function snapshotFirstText(values = []) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function buildSnapshotControl(type, label, extras = {}) {
  if (!type || !label) {
    return null;
  }
  return {
    type,
    label,
    ...extras
  };
}

function snapshotReasonSuggestsBlock(value) {
  const reason = String(value ?? "").trim().toLowerCase();
  return reason.includes("tamper")
    || reason.includes("replay")
    || reason.includes("fraud")
    || reason.includes("risk")
    || reason.includes("multi")
    || reason.includes("forbid")
    || reason.includes("ban");
}

function snapshotReasonSuggestsUnblock(value) {
  const reason = String(value ?? "").trim().toLowerCase();
  return reason.includes("block")
    || reason.includes("ban")
    || reason.includes("forbid");
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

function buildSnapshotFocusAccountRecommendedControl(item = {}) {
  const signals = Array.isArray(item.signals) ? item.signals : [];
  const firstReason = snapshotFirstText(item.reasons || []);
  if (snapshotArrayIncludes(signals, "account_disabled") && item.accountId) {
    return buildSnapshotControl("account_status", "Prepare account re-enable", {
      accountId: item.accountId,
      targetStatus: "active"
    });
  }
  if (snapshotArrayIncludes(signals, "entitlement_frozen") && item.entitlementId) {
    return buildSnapshotControl("entitlement_status", "Prepare entitlement resume", {
      entitlementId: item.entitlementId,
      targetStatus: "active"
    });
  }
  if (snapshotArrayIncludes(signals, "entitlement_expired") && item.entitlementId) {
    return buildSnapshotControl("extend_entitlement", "Prepare 7-day extension", {
      entitlementId: item.entitlementId,
      days: 7
    });
  }
  if (snapshotArrayIncludes(signals, "points_exhausted") && item.entitlementId) {
    return buildSnapshotControl("adjust_points", "Prepare point top-up", {
      entitlementId: item.entitlementId,
      mode: "add",
      points: 1
    });
  }
  if (item.sessionId) {
    return buildSnapshotControl("revoke_session", "Prepare session review", {
      sessionId: item.sessionId,
      reason: firstReason || "snapshot_review"
    });
  }
  return null;
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

function buildSnapshotFocusSessionRecommendedControl(item = {}) {
  if (snapshotReasonSuggestsUnblock(item.reason) && (item.blockId || item.fingerprint)) {
    return buildSnapshotControl("unblock_device", "Prepare device unblock review", {
      blockId: item.blockId || null,
      productCode: item.productCode || null,
      fingerprint: item.fingerprint || null,
      reason: "snapshot_unblocked"
    });
  }
  if (snapshotReasonSuggestsBlock(item.reason) && item.fingerprint) {
    return buildSnapshotControl("block_device", "Prepare device block", {
      productCode: item.productCode || null,
      fingerprint: item.fingerprint || null,
      reason: item.reason || "snapshot_block_review"
    });
  }
  return null;
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

function buildSnapshotFocusDeviceRecommendedControl(item = {}) {
  const kind = normalizeSnapshotStatus(item.kind);
  const status = normalizeSnapshotStatus(item.status);
  if (kind === "block" && status === "active") {
    return buildSnapshotControl("unblock_device", "Prepare device unblock review", {
      blockId: item.blockId || null,
      productCode: item.productCode || null,
      fingerprint: item.fingerprint || null,
      reason: "snapshot_unblocked"
    });
  }
  if (kind === "session" && item.fingerprint && snapshotReasonSuggestsBlock(item.reason)) {
    return buildSnapshotControl("block_device", "Prepare device block", {
      productCode: item.productCode || null,
      fingerprint: item.fingerprint || null,
      reason: item.reason || "snapshot_block_review"
    });
  }
  return null;
}

function buildDeveloperOpsReviewAccountRecommendedControl(item = {}) {
  const accountId = item.accountId || item.id || null;
  const status = String(item.accountStatus || item.status || "").trim().toLowerCase();
  if (accountId && status === "disabled") {
    return buildSnapshotControl("account_status", "Prepare account re-enable", {
      accountId,
      targetStatus: "active"
    });
  }
  return null;
}

function buildDeveloperOpsReviewGenericControl(focusKind = "", item = {}) {
  const normalizedFocusKind = String(focusKind || "").trim().toLowerCase();
  if (normalizedFocusKind === "account" && (item.accountId || item.id)) {
    return buildSnapshotControl("focus_account", "Prepare account control", {
      accountId: item.accountId || item.id || null,
      productCode: item.productCode || item.projectCode || null,
      username: item.username || null
    });
  }
  if (normalizedFocusKind === "entitlement" && (item.entitlementId || item.id)) {
    return buildSnapshotControl("focus_entitlement", "Prepare entitlement control", {
      entitlementId: item.entitlementId || item.id || null,
      productCode: item.productCode || item.projectCode || null,
      username: item.username || null
    });
  }
  if (normalizedFocusKind === "session" && (item.sessionId || item.id)) {
    return buildSnapshotControl("focus_session", "Prepare session control", {
      sessionId: item.sessionId || item.id || null,
      productCode: item.productCode || item.projectCode || null,
      username: item.username || null,
      fingerprint: item.fingerprint || null,
      reason: item.reason || item.revokedReason || null
    });
  }
  if (normalizedFocusKind === "device" && (item.bindingId || item.blockId || item.id || item.fingerprint)) {
    return buildSnapshotControl("focus_device", "Prepare device control", {
      bindingId: item.bindingId || (String(item.kind || "").trim().toLowerCase() === "binding" ? item.id || null : null),
      blockId: item.blockId || (String(item.kind || "").trim().toLowerCase() === "block" ? item.id || null : null),
      fingerprint: item.fingerprint || item.deviceFingerprint || null,
      productCode: item.productCode || item.projectCode || null,
      username: item.username || null,
      reason: item.reason || null
    });
  }
  return null;
}

function buildDeveloperOpsReviewGenericControlFromFocusParams(focusParams = {}) {
  const focusKind = String(focusParams?.focusKind || "").trim().toLowerCase();
  if (focusKind === "account") {
    return buildSnapshotControl("focus_account", "Prepare account control", {
      accountId: focusParams.focusAccountId || null,
      productCode: focusParams.focusProductCode || null,
      username: focusParams.focusUsername || null
    });
  }
  if (focusKind === "entitlement") {
    return buildSnapshotControl("focus_entitlement", "Prepare entitlement control", {
      entitlementId: focusParams.focusEntitlementId || null,
      productCode: focusParams.focusProductCode || null,
      username: focusParams.focusUsername || null
    });
  }
  if (focusKind === "session") {
    return buildSnapshotControl("focus_session", "Prepare session control", {
      sessionId: focusParams.focusSessionId || null,
      productCode: focusParams.focusProductCode || null,
      username: focusParams.focusUsername || null,
      fingerprint: focusParams.focusFingerprint || null,
      reason: focusParams.focusReason || null
    });
  }
  if (focusKind === "device") {
    return buildSnapshotControl("focus_device", "Prepare device control", {
      bindingId: focusParams.focusBindingId || null,
      blockId: focusParams.focusBlockId || null,
      fingerprint: focusParams.focusFingerprint || null,
      productCode: focusParams.focusProductCode || null,
      username: focusParams.focusUsername || null,
      reason: focusParams.focusReason || null
    });
  }
  return null;
}

function recommendedControlPriority(control = null) {
  if (!control || typeof control !== "object" || !String(control.type || "").trim()) {
    return 0;
  }
  const normalizedType = String(control.type || "").trim().toLowerCase();
  if (normalizedType.startsWith("focus_")) {
    return 1;
  }
  return 2;
}

function buildDeveloperOpsReviewEntitlementRecommendedControl(item = {}) {
  const entitlementId = item.entitlementId || item.id || null;
  const lifecycleStatus = String(item.lifecycleStatus || item.status || "").trim().toLowerCase();
  if (entitlementId && lifecycleStatus === "frozen") {
    return buildSnapshotControl("entitlement_status", "Prepare entitlement resume", {
      entitlementId,
      targetStatus: "active"
    });
  }
  if (entitlementId && lifecycleStatus === "expired") {
    return buildSnapshotControl("extend_entitlement", "Prepare 7-day extension", {
      entitlementId,
      days: 7
    });
  }
  if (entitlementId && Number(item.totalPoints || 0) > 0 && Number(item.remainingPoints || 0) <= 0) {
    return buildSnapshotControl("adjust_points", "Prepare point top-up", {
      entitlementId,
      mode: "add",
      points: 1
    });
  }
  return null;
}

function buildDeveloperOpsReviewSessionRecommendedControl(item = {}) {
  const sessionId = item.sessionId || item.id || null;
  const status = String(item.status || "").trim().toLowerCase();
  if (sessionId && status === "active") {
    return buildSnapshotControl("revoke_session", "Prepare session review", {
      sessionId,
      reason: item.reason || item.revokedReason || "launch_review_follow_up"
    });
  }
  return null;
}

function buildDeveloperOpsReviewDeviceRecommendedControl(item = {}) {
  const status = String(item.status || "").trim().toLowerCase();
  const kind = String(item.kind || "").trim().toLowerCase();
  if ((item.blockId || item.id) && kind === "block" && status === "active") {
    return buildSnapshotControl("unblock_device", "Prepare device unblock review", {
      blockId: item.blockId || item.id || null,
      productCode: item.productCode || item.projectCode || null,
      fingerprint: item.fingerprint || item.deviceFingerprint || null,
      reason: item.reason || "launch_review_unblock"
    });
  }
  return null;
}

function buildDeveloperOpsReviewRecommendedControl(focusKind = "", item = {}) {
  if (!item || typeof item !== "object") {
    return null;
  }
  if (item.recommendedControl && typeof item.recommendedControl === "object") {
    return { ...item.recommendedControl };
  }
  const normalizedFocusKind = String(focusKind || "").trim().toLowerCase();
  if (normalizedFocusKind === "account") {
    return buildDeveloperOpsReviewAccountRecommendedControl(item)
      || buildDeveloperOpsReviewGenericControl(normalizedFocusKind, item);
  }
  if (normalizedFocusKind === "entitlement") {
    return buildDeveloperOpsReviewEntitlementRecommendedControl(item)
      || buildDeveloperOpsReviewGenericControl(normalizedFocusKind, item);
  }
  if (normalizedFocusKind === "session") {
    return buildDeveloperOpsReviewSessionRecommendedControl(item)
      || buildDeveloperOpsReviewGenericControl(normalizedFocusKind, item);
  }
  if (normalizedFocusKind === "device") {
    return buildDeveloperOpsReviewDeviceRecommendedControl(item)
      || buildDeveloperOpsReviewGenericControl(normalizedFocusKind, item);
  }
  return buildDeveloperOpsReviewGenericControl(normalizedFocusKind, item);
}

function hasDeveloperOpsRouteReview(filters = {}) {
  const reviewMode = String(filters.reviewMode || "").trim().toLowerCase();
  return reviewMode === "matched"
    || Boolean(
      String(filters.productCode || "").trim()
      || String(filters.username || "").trim()
      || String(filters.search || "").trim()
      || String(filters.eventType || "").trim()
      || String(filters.actorType || "").trim()
      || String(filters.entityType || "").trim()
    );
}

function deriveDeveloperOpsRouteReviewFocus(filters = {}) {
  const entityType = String(filters.entityType || "").trim().toLowerCase();
  if (entityType === "entitlement") {
    return "entitlements";
  }
  if (entityType === "session") {
    return "sessions";
  }
  if (entityType === "device_binding" || entityType === "device_block") {
    return "devices";
  }
  const eventType = String(filters.eventType || "").trim().toLowerCase();
  if (eventType.startsWith("session.")) {
    return "sessions";
  }
  if (eventType) {
    return "audit";
  }
  if (String(filters.actorType || "").trim().toLowerCase() === "account" || String(filters.username || "").trim()) {
    return "accounts";
  }
  if (String(filters.search || "").trim()) {
    return entityType.startsWith("device") ? "devices" : "sessions";
  }
  return "snapshot";
}

function buildDeveloperOpsRouteReviewSectionOrder(preferredSection = "") {
  const normalized = String(preferredSection || "").trim().toLowerCase();
  if (normalized === "accounts") {
    return ["accounts", "entitlements", "sessions", "devices", "audit"];
  }
  if (normalized === "entitlements") {
    return ["entitlements", "accounts", "sessions", "devices", "audit"];
  }
  if (normalized === "sessions") {
    return ["sessions", "audit", "accounts", "devices", "entitlements"];
  }
  if (normalized === "devices" || normalized === "bindings" || normalized === "blocks") {
    return ["devices", "sessions", "audit", "accounts", "entitlements"];
  }
  if (normalized === "audit") {
    return ["audit", "sessions", "accounts", "devices", "entitlements"];
  }
  return ["accounts", "sessions", "audit", "devices", "entitlements"];
}

function normalizeDeveloperOpsRouteReviewText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function developerOpsRouteReviewIncludes(values = [], needle = "") {
  const normalizedNeedle = normalizeDeveloperOpsRouteReviewText(needle);
  if (!normalizedNeedle) {
    return true;
  }
  return values.some((value) => normalizeDeveloperOpsRouteReviewText(value).includes(normalizedNeedle));
}

function matchesDeveloperOpsRouteReviewAccount(item = {}, filters = {}) {
  if (filters.productCode && String(item.productCode || "").trim().toUpperCase() !== String(filters.productCode || "").trim().toUpperCase()) {
    return false;
  }
  if (filters.username && normalizeDeveloperOpsRouteReviewText(item.username) !== normalizeDeveloperOpsRouteReviewText(filters.username)) {
    return false;
  }
  return developerOpsRouteReviewIncludes(
    [item.id, item.username, item.productCode, item.status],
    filters.search
  );
}

function matchesDeveloperOpsRouteReviewEntitlement(item = {}, filters = {}) {
  if (filters.productCode && String(item.productCode || "").trim().toUpperCase() !== String(filters.productCode || "").trim().toUpperCase()) {
    return false;
  }
  if (filters.username && normalizeDeveloperOpsRouteReviewText(item.username) !== normalizeDeveloperOpsRouteReviewText(filters.username)) {
    return false;
  }
  return developerOpsRouteReviewIncludes(
    [item.id, item.username, item.productCode, item.policyName, item.status, item.lifecycleStatus],
    filters.search
  );
}

function matchesDeveloperOpsRouteReviewSession(item = {}, filters = {}) {
  if (filters.productCode && String(item.productCode || "").trim().toUpperCase() !== String(filters.productCode || "").trim().toUpperCase()) {
    return false;
  }
  if (filters.username && normalizeDeveloperOpsRouteReviewText(item.username) !== normalizeDeveloperOpsRouteReviewText(filters.username)) {
    return false;
  }
  return developerOpsRouteReviewIncludes(
    [item.id, item.username, item.productCode, item.fingerprint, item.status],
    filters.search
  );
}

function matchesDeveloperOpsRouteReviewDevice(item = {}, filters = {}) {
  if (filters.productCode && String(item.productCode || item.projectCode || "").trim().toUpperCase() !== String(filters.productCode || "").trim().toUpperCase()) {
    return false;
  }
  return developerOpsRouteReviewIncludes(
    [item.id, item.projectCode, item.productCode, item.identity, item.fingerprint, item.status, item.kind],
    filters.search
  );
}

function matchesDeveloperOpsRouteReviewAudit(item = {}, filters = {}) {
  if (filters.productCode) {
    const productCodes = [
      item.productCode,
      item.metadata?.productCode,
      ...(Array.isArray(item.metadata?.productCodes) ? item.metadata.productCodes : []),
      item.metadata?.code
    ].filter(Boolean).map((value) => String(value).trim().toUpperCase());
    if (!productCodes.includes(String(filters.productCode || "").trim().toUpperCase())) {
      return false;
    }
  }
  if (filters.username) {
    const usernames = [
      item.username,
      item.metadata?.username,
      item.metadata?.accountUsername,
      item.metadata?.cardKey
    ];
    if (!developerOpsRouteReviewIncludes(usernames, filters.username)) {
      return false;
    }
  }
  if (filters.eventType && normalizeDeveloperOpsRouteReviewText(item.eventType) !== normalizeDeveloperOpsRouteReviewText(filters.eventType)) {
    return false;
  }
  if (filters.actorType && normalizeDeveloperOpsRouteReviewText(item.actorType) !== normalizeDeveloperOpsRouteReviewText(filters.actorType)) {
    return false;
  }
  if (filters.entityType && normalizeDeveloperOpsRouteReviewText(item.entityType) !== normalizeDeveloperOpsRouteReviewText(filters.entityType)) {
    return false;
  }
  return developerOpsRouteReviewIncludes(
    [
      item.id,
      item.eventType,
      item.actorType,
      item.actorId,
      item.entityType,
      item.entityId,
      item.username,
      item.metadata?.username,
      item.metadata?.reason,
      item.metadata?.fingerprint,
      item.metadata?.deviceFingerprint,
      item.metadata?.sessionId,
      item.metadata?.accountId,
      item.metadata?.entitlementId,
      item.metadata?.cardKey,
      item.metadata?.productCode,
      item.metadata?.code,
      JSON.stringify(item.metadata || {})
    ],
    filters.search
  );
}

function buildDeveloperOpsRouteReviewAccountItem(item = {}) {
  const next = {
    ...item,
    accountId: item.accountId || item.id || "",
    accountStatus: item.accountStatus || item.status || "active"
  };
  if (!next.recommendedControl) {
    next.recommendedControl = buildDeveloperOpsReviewRecommendedControl("account", next);
  }
  return next;
}

function buildDeveloperOpsRouteReviewEntitlementItem(item = {}) {
  const next = {
    ...item,
    entitlementId: item.entitlementId || item.id || ""
  };
  if (!next.recommendedControl) {
    next.recommendedControl = buildDeveloperOpsReviewRecommendedControl("entitlement", next);
  }
  return next;
}

function buildDeveloperOpsRouteReviewSessionItem(item = {}) {
  const next = {
    ...item,
    reason: item.reason || item.revokedReason || "",
    sessionId: item.sessionId || item.id || ""
  };
  if (!next.recommendedControl) {
    next.recommendedControl = buildDeveloperOpsReviewRecommendedControl("session", next);
  }
  return next;
}

function buildDeveloperOpsRouteReviewDeviceItem(item = {}) {
  const next = {
    ...item,
    kind: item.kind || (item.blockId ? "block" : "binding"),
    bindingId: item.bindingId || (String(item.kind || "").trim().toLowerCase() === "binding" ? item.id || "" : ""),
    blockId: item.blockId || (String(item.kind || "").trim().toLowerCase() === "block" ? item.id || "" : "")
  };
  if (!next.recommendedControl) {
    next.recommendedControl = buildDeveloperOpsReviewRecommendedControl("device", next);
  }
  return next;
}

function buildDeveloperOpsRouteReviewAuditItem(item = {}) {
  return {
    ...item,
    metadata: item.metadata && typeof item.metadata === "object" ? item.metadata : {}
  };
}

function buildDeveloperOpsRouteReviewEntryTitle(kind = "", item = {}) {
  const normalizedKind = String(kind || "").trim().toLowerCase();
  if (normalizedKind === "account") {
    return `${item.username || "-"} @ ${item.productCode || "-"}`;
  }
  if (normalizedKind === "entitlement") {
    return `${item.username || "-"} | ${item.policyName || item.productCode || "-"}`;
  }
  if (normalizedKind === "session") {
    return `${item.sessionId || item.id || "-"} | ${item.username || "-"}`;
  }
  if (normalizedKind === "device") {
    return `${item.fingerprint || "-"} @ ${item.productCode || "-"}`;
  }
  return `${item.eventType || "-"} | ${item.entityType || "-"}`;
}

function buildDeveloperOpsRouteReviewEntrySummary(kind = "", item = {}) {
  const normalizedKind = String(kind || "").trim().toLowerCase();
  if (normalizedKind === "account") {
    return `${item.productCode || "-"} | status=${item.accountStatus || item.status || "-"} | entitlements=${item.activeEntitlementCount ?? 0} | sessions=${item.activeSessionCount ?? 0}`;
  }
  if (normalizedKind === "entitlement") {
    return `${item.productCode || "-"} | ${item.lifecycleStatus || item.status || "-"} | policy=${item.policyName || "-"} | points=${item.remainingPoints ?? item.totalPoints ?? 0}`;
  }
  if (normalizedKind === "session") {
    return `${item.productCode || "-"} | ${item.status || "-"} | reason=${item.reason || "-"} | device=${item.deviceName || item.fingerprint || "-"}`;
  }
  if (normalizedKind === "device") {
    return `${item.kind || "-"} | ${item.status || "-"} | reason=${item.reason || "-"} | user=${item.username || "-"} | device=${item.deviceName || "-"}`;
  }
  return `${item.eventType || "-"} | actor=${item.actorType || "-"} | entity=${item.entityType || "-"} | id=${item.entityId || "-"}`;
}

function buildDeveloperOpsRouteReviewEntry(kind = "", section = "", item = {}) {
  const normalizedKind = String(kind || "").trim().toLowerCase();
  if (!normalizedKind) {
    return null;
  }
  let normalizedItem = null;
  if (normalizedKind === "account") {
    normalizedItem = buildDeveloperOpsRouteReviewAccountItem(item);
  } else if (normalizedKind === "entitlement") {
    normalizedItem = buildDeveloperOpsRouteReviewEntitlementItem(item);
  } else if (normalizedKind === "session") {
    normalizedItem = buildDeveloperOpsRouteReviewSessionItem(item);
  } else if (normalizedKind === "device") {
    normalizedItem = buildDeveloperOpsRouteReviewDeviceItem(item);
  } else if (normalizedKind === "audit") {
    normalizedItem = buildDeveloperOpsRouteReviewAuditItem(item);
  } else {
    return null;
  }
  const routeAction = normalizedKind === "audit"
    ? "review-audit"
    : buildFocusKindControlRouteAction(normalizedKind);
  const routeActionLabel = normalizedKind === "audit"
    ? "Review Audit"
    : buildFocusKindControlLabel(normalizedKind);
  return {
    kind: normalizedKind,
    section: String(section || "").trim().toLowerCase() || normalizedKind,
    title: buildDeveloperOpsRouteReviewEntryTitle(normalizedKind, normalizedItem),
    summary: buildDeveloperOpsRouteReviewEntrySummary(normalizedKind, normalizedItem),
    routeAction,
    routeActionLabel,
    recommendedControl: normalizedItem.recommendedControl || null,
    item: normalizedItem
  };
}

function buildDeveloperOpsRouteReviewMatchId(kind = "", item = {}) {
  const normalizedKind = String(kind || "").trim().toLowerCase();
  if (normalizedKind === "account") {
    return String(item.accountId || item.id || item.username || "").trim();
  }
  if (normalizedKind === "entitlement") {
    return String(item.entitlementId || item.id || "").trim();
  }
  if (normalizedKind === "session") {
    return String(item.sessionId || item.id || "").trim();
  }
  if (normalizedKind === "device") {
    return String(item.bindingId || item.blockId || item.id || item.fingerprint || "").trim();
  }
  if (normalizedKind === "audit") {
    return String(item.id || item.entityId || "").trim();
  }
  return "";
}

function buildDeveloperOpsRouteReviewMatchedIds({
  accounts = [],
  entitlements = [],
  sessions = [],
  devices = [],
  auditLogs = []
} = {}) {
  return {
    accounts: accounts.map((item) => buildDeveloperOpsRouteReviewMatchId("account", item)).filter(Boolean),
    entitlements: entitlements.map((item) => buildDeveloperOpsRouteReviewMatchId("entitlement", item)).filter(Boolean),
    sessions: sessions.map((item) => buildDeveloperOpsRouteReviewMatchId("session", item)).filter(Boolean),
    devices: devices.map((item) => buildDeveloperOpsRouteReviewMatchId("device", item)).filter(Boolean),
    audit: auditLogs.map((item) => buildDeveloperOpsRouteReviewMatchId("audit", item)).filter(Boolean)
  };
}

function buildDeveloperOpsRouteReviewPayload({
  filters = {},
  accounts = [],
  entitlements = [],
  sessions = [],
  bindings = [],
  blocks = [],
  auditLogs = []
} = {}) {
  if (!hasDeveloperOpsRouteReview(filters)) {
    return {
      active: false,
      focus: deriveDeveloperOpsRouteReviewFocus(filters),
      matchedCounts: {
        accounts: 0,
        entitlements: 0,
        sessions: 0,
        devices: 0,
        audit: 0
      },
      highlightedEvents: [],
      primaryMatch: null,
      nextMatch: null,
      remainingMatches: [],
      totalMatches: 0,
      queue: []
    };
  }

  const focus = deriveDeveloperOpsRouteReviewFocus(filters);
  const deviceItems = [
    ...blocks.map((item) => ({ ...item, kind: "block", blockId: item.blockId || item.id || "" })),
    ...bindings.map((item) => ({ ...item, kind: "binding", bindingId: item.bindingId || item.id || "" }))
  ];
  const matchedAccounts = accounts.filter((item) => matchesDeveloperOpsRouteReviewAccount(item, filters));
  const matchedEntitlements = entitlements.filter((item) => matchesDeveloperOpsRouteReviewEntitlement(item, filters));
  const matchedSessions = sessions.filter((item) => matchesDeveloperOpsRouteReviewSession(item, filters));
  const matchedDevices = deviceItems.filter((item) => matchesDeveloperOpsRouteReviewDevice(item, filters));
  const matchedAuditLogs = auditLogs.filter((item) => matchesDeveloperOpsRouteReviewAudit(item, filters));
  const matchedIds = buildDeveloperOpsRouteReviewMatchedIds({
    accounts: matchedAccounts,
    entitlements: matchedEntitlements,
    sessions: matchedSessions,
    devices: matchedDevices,
    auditLogs: matchedAuditLogs
  });
  const highlightedEvents = [...new Set(matchedAuditLogs.map((item) => item?.eventType).filter(Boolean))].slice(0, 3);
  const queue = [];
  for (const section of buildDeveloperOpsRouteReviewSectionOrder(focus)) {
    if (section === "accounts") {
      matchedAccounts.forEach((item) => {
        const entry = buildDeveloperOpsRouteReviewEntry("account", section, item);
        if (entry) {
          queue.push(entry);
        }
      });
      continue;
    }
    if (section === "entitlements") {
      matchedEntitlements.forEach((item) => {
        const entry = buildDeveloperOpsRouteReviewEntry("entitlement", section, item);
        if (entry) {
          queue.push(entry);
        }
      });
      continue;
    }
    if (section === "sessions") {
      matchedSessions.forEach((item) => {
        const entry = buildDeveloperOpsRouteReviewEntry("session", section, item);
        if (entry) {
          queue.push(entry);
        }
      });
      continue;
    }
    if (section === "devices") {
      matchedDevices.forEach((item) => {
        const entry = buildDeveloperOpsRouteReviewEntry("device", section, item);
        if (entry) {
          queue.push(entry);
        }
      });
      continue;
    }
    if (section === "audit") {
      matchedAuditLogs.forEach((item) => {
        const entry = buildDeveloperOpsRouteReviewEntry("audit", section, item);
        if (entry) {
          queue.push(entry);
        }
      });
    }
  }

  return {
    active: true,
    focus,
    matchedCounts: {
      accounts: matchedAccounts.length,
      entitlements: matchedEntitlements.length,
      sessions: matchedSessions.length,
      devices: matchedDevices.length,
      audit: matchedAuditLogs.length
    },
    matchedIds,
    highlightedEvents,
    primaryMatch: queue[0] || null,
    nextMatch: queue[1] || null,
    remainingMatches: queue.slice(1, 12),
    totalMatches: queue.length,
    queue: queue.slice(0, 12)
  };
}

function buildSnapshotActionQueueItem(sourceType, item = {}) {
  const normalizedSourceType = String(sourceType ?? "").trim().toLowerCase();
  const severity = String(item.severity ?? "low").trim().toLowerCase() || "low";
  const latestAt = item.latestAt || item.lastHeartbeatAt || item.expiresAt || null;
  let title = "";
  let summary = "";

  if (normalizedSourceType === "account") {
    title = `${item.username || "-"} @ ${item.productCode || "-"}`;
    summary = `issues=${item.issueCount ?? 0} | signals=${(item.signals || []).slice(0, 3).join(", ") || "-"} | reasons=${(item.reasons || []).slice(0, 2).join(", ") || "-"}`;
  } else if (normalizedSourceType === "session") {
    title = `${item.sessionId || "-"} | ${item.username || "-"}`;
    summary = `${item.productCode || "-"} | ${item.status || "-"} | reason=${item.reason || "-"} | device=${item.deviceName || item.fingerprint || "-"}`;
  } else {
    title = `${item.fingerprint || "-"} @ ${item.productCode || "-"}`;
    summary = `${item.kind || "-"} | ${item.status || "-"} | reason=${item.reason || "-"} | user=${item.username || "-"} | device=${item.deviceName || "-"}`;
  }

  return {
    sourceType: normalizedSourceType,
    severity,
    severityRank: snapshotSeverityRank(severity),
    title,
    summary,
    nextAction: item.actionHint || null,
    actionHint: item.actionHint || null,
    recommendedControl: item.recommendedControl || null,
    productCode: item.productCode || null,
    username: item.username || null,
    accountId: item.accountId || null,
    entitlementId: item.entitlementId || null,
    sessionId: item.sessionId || null,
    issueCount: Number(item.issueCount || 0),
    activeSessionCount: Number(item.activeSessionCount || 0),
    activeEntitlementCount: Number(item.activeEntitlementCount || 0),
    relatedSessionCount: Number(item.relatedSessionCount || 0),
    status: item.status || null,
    kind: item.kind || null,
    deviceName: item.deviceName || null,
    bindingId: item.bindingId || null,
    blockId: item.blockId || null,
    fingerprint: item.fingerprint || null,
    reason: item.reason || (Array.isArray(item.reasons) ? item.reasons[0] || null : null),
    latestAt,
    latestMs: snapshotDateMs(latestAt),
    item
  };
}

function buildSnapshotActionQueue(focusAccounts = [], focusSessions = [], focusDevices = [], limit = 8) {
  const items = [
    ...focusAccounts.map((item) => buildSnapshotActionQueueItem("account", item)),
    ...focusSessions.map((item) => buildSnapshotActionQueueItem("session", item)),
    ...focusDevices.map((item) => buildSnapshotActionQueueItem("device", item))
  ];

  const sourceRanks = {
    device: 3,
    account: 2,
    session: 1
  };

  return items
    .sort((left, right) => {
      if (right.severityRank !== left.severityRank) {
        return right.severityRank - left.severityRank;
      }
      if (right.latestMs !== left.latestMs) {
        return right.latestMs - left.latestMs;
      }
      if ((sourceRanks[right.sourceType] || 0) !== (sourceRanks[left.sourceType] || 0)) {
        return (sourceRanks[right.sourceType] || 0) - (sourceRanks[left.sourceType] || 0);
      }
      return left.title.localeCompare(right.title);
    })
    .slice(0, limit)
    .map(({ severityRank, latestMs, item, ...rest }) => ({
      ...rest
    }));
}

function buildSnapshotQueueSummary(items = []) {
  const summary = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    total: Array.isArray(items) ? items.length : 0
  };
  if (!Array.isArray(items)) {
    return summary;
  }
  for (const item of items) {
    const severity = String(item?.severity ?? "").trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(summary, severity)) {
      summary[severity] += 1;
    }
  }
  return summary;
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
        actionHint: buildSnapshotFocusAccountActionHint(normalized),
        recommendedControl: buildSnapshotFocusAccountRecommendedControl(normalized)
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
        actionHint: buildSnapshotFocusSessionActionHint(normalized),
        recommendedControl: buildSnapshotFocusSessionRecommendedControl(normalized)
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
        actionHint: buildSnapshotFocusDeviceActionHint(normalized),
        recommendedControl: buildSnapshotFocusDeviceRecommendedControl(normalized)
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
  const recommendedQueue = buildSnapshotActionQueue(focusAccounts, focusSessions, focusDevices, 8);
  const queueSummary = buildSnapshotQueueSummary(recommendedQueue);

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
  if (recommendedQueue.length) {
    const queuePreview = recommendedQueue
      .slice(0, 3)
      .map((item) => `[${String(item.severity || "-").toUpperCase()}] ${item.title}`)
      .join(", ");
    highlights.push(`Recommended queue: ${queuePreview}.`);
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
    queueSummary,
    recommendedQueue,
    focusAccounts,
    focusSessions,
    focusDevices
  };
}

function appendSnapshotQueueSummaryLines(lines = [], overview = {}) {
  if (overview && typeof overview === "object" && overview.queueSummary && typeof overview.queueSummary === "object") {
    lines.push(`Recommended Queue Counts: critical=${overview.queueSummary.critical ?? 0} | high=${overview.queueSummary.high ?? 0} | medium=${overview.queueSummary.medium ?? 0} | low=${overview.queueSummary.low ?? 0} | total=${overview.queueSummary.total ?? 0}`);
  }
  if (Array.isArray(overview.recommendedQueue) && overview.recommendedQueue.length) {
    lines.push("Recommended Queue:");
    for (const item of overview.recommendedQueue) {
      lines.push(`- [${String(item.severity || "-").toUpperCase()}][${item.sourceType || "-"}] ${item.title || "-"} | ${item.summary || "-"} | control=${item.recommendedControl?.label || "-"} | next=${item.nextAction || "-"}`);
    }
  }
}

function buildSnapshotQueueImpactBits(item = {}) {
  const bits = [];
  const sourceType = String(item?.sourceType ?? "").trim().toLowerCase();
  if (sourceType === "account") {
    bits.push(`issues=${Number(item?.issueCount || 0)}`);
    if (Number(item?.activeSessionCount || 0) > 0) {
      bits.push(`sessions=${Number(item.activeSessionCount)}`);
    }
    if (Number(item?.activeEntitlementCount || 0) > 0) {
      bits.push(`entitlements=${Number(item.activeEntitlementCount)}`);
    }
    return bits;
  }
  if (sourceType === "session") {
    if (item?.status) {
      bits.push(`status=${item.status}`);
    }
    if (item?.deviceName || item?.fingerprint) {
      bits.push(`device=${item.deviceName || item.fingerprint}`);
    }
    return bits;
  }
  if (sourceType === "device") {
    if (item?.kind) {
      bits.push(`kind=${item.kind}`);
    }
    if (item?.status) {
      bits.push(`status=${item.status}`);
    }
    if (Number(item?.relatedSessionCount || 0) > 0) {
      bits.push(`sessions=${Number(item.relatedSessionCount)}`);
    }
  }
  return bits;
}

function appendSnapshotEscalationSummaryLines(lines = [], overview = {}) {
  const queueItems = Array.isArray(overview?.recommendedQueue) ? overview.recommendedQueue : [];
  if (!queueItems.length) {
    return;
  }
  const urgentEntries = queueItems
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) => {
      const severity = String(item?.severity ?? "").trim().toLowerCase();
      return severity === "critical" || severity === "high" || (index === 0 && severity === "medium");
    })
    .slice(0, 3);
  if (!urgentEntries.length) {
    return;
  }
  lines.push("Escalate First:");
  for (const { item, index } of urgentEntries) {
    lines.push(`- [${String(item?.severity || "-").toUpperCase()}][${item?.sourceType || "-"}][#${index + 1}] ${item?.title || "-"} | impacts=${buildSnapshotQueueImpactBits(item).join(", ") || "-"} | reason=${item?.reason || "-"} | control=${item?.recommendedControl?.label || "-"} | next=${item?.nextAction || "-"}`);
  }
}

function buildDeveloperOpsSummaryText(payload = {}) {
  const scope = payload.scope || {};
  const summary = payload.summary || {};
  const overview = payload.overview || {};
  const routeReview = payload.routeReview || {};
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
        lines.push(`- ${item.username || "-"} @ ${item.productCode || "-"} | issues=${item.issueCount ?? 0} | severity=${item.severity || "-"} | account=${item.accountId || "-"} | control=${item.recommendedControl?.label || "-"} | next=${item.actionHint || "-"}`);
      }
    }
    if (Array.isArray(overview.focusSessions) && overview.focusSessions.length) {
      lines.push("Focus Sessions:");
      for (const item of overview.focusSessions) {
        lines.push(`- ${item.sessionId || "-"} | ${item.username || "-"} @ ${item.productCode || "-"} | ${item.status || "-"} | severity=${item.severity || "-"} | control=${item.recommendedControl?.label || "-"} | ${item.reason || "-"} | next=${item.actionHint || "-"}`);
      }
    }
    if (Array.isArray(overview.focusDevices) && overview.focusDevices.length) {
      lines.push("Focus Devices:");
      for (const item of overview.focusDevices) {
        lines.push(`- ${item.fingerprint || "-"} @ ${item.productCode || "-"} | ${item.kind || "-"} | ${item.status || "-"} | severity=${item.severity || "-"} | control=${item.recommendedControl?.label || "-"} | ${item.reason || "-"} | next=${item.actionHint || "-"}`);
      }
    }
    if (routeReview.active) {
      lines.push(`Route Review Focus: ${routeReview.focus || "-"}`);
      lines.push(`Route Review Counts: accounts:${routeReview.matchedCounts?.accounts ?? 0} | entitlements:${routeReview.matchedCounts?.entitlements ?? 0} | sessions:${routeReview.matchedCounts?.sessions ?? 0} | devices:${routeReview.matchedCounts?.devices ?? 0} | audit:${routeReview.matchedCounts?.audit ?? 0}`);
      if (Array.isArray(routeReview.highlightedEvents) && routeReview.highlightedEvents.length) {
        lines.push(`Route Review Events: ${routeReview.highlightedEvents.join(", ")}`);
      }
      if (routeReview.primaryMatch) {
        lines.push("Route Review Primary Match:");
        lines.push(`- ${routeReview.primaryMatch.title || "-"} | ${routeReview.primaryMatch.summary || "-"} | action=${routeReview.primaryMatch.routeActionLabel || routeReview.primaryMatch.routeAction || "-"} | control=${routeReview.primaryMatch.recommendedControl?.label || "-"}`);
      }
      if (routeReview.nextMatch) {
        lines.push("Route Review Next Match:");
        lines.push(`- ${routeReview.nextMatch.title || "-"} | ${routeReview.nextMatch.summary || "-"} | action=${routeReview.nextMatch.routeActionLabel || routeReview.nextMatch.routeAction || "-"} | control=${routeReview.nextMatch.recommendedControl?.label || "-"}`);
      }
      if (Array.isArray(routeReview.remainingMatches) && routeReview.remainingMatches.length) {
        lines.push("Route Review Remaining Matches:");
        routeReview.remainingMatches.slice(0, 5).forEach((item) => {
          lines.push(`- ${item.title || "-"} | ${item.summary || "-"} | action=${item.routeActionLabel || item.routeAction || "-"} | control=${item.recommendedControl?.label || "-"}`);
        });
      }
    }
    appendSnapshotEscalationSummaryLines(lines, overview);
    appendSnapshotQueueSummaryLines(lines, overview);
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
  const scope = {
    accessibleProjectCount: accessibleProjects.length,
    exportedProjectCount: normalizedProjects.length,
    productCode: filters.productCode || null,
    username: filters.username || null,
    search: filters.search || null,
    eventType: filters.eventType || null,
    actorType: filters.actorType || null,
    entityType: filters.entityType || null,
    auditLimit: Number(filters.limit ?? auditLogs.filters?.limit ?? 0)
  };
  const routeReview = buildDeveloperOpsRouteReviewPayload({
    filters,
    accounts: normalizedAccounts,
    entitlements: normalizedEntitlements,
    sessions: normalizedSessions,
    bindings: normalizedBindings,
    blocks: normalizedBlocks,
    auditLogs: normalizedAuditLogs
  });
  routeReview.downloads = buildDeveloperOpsRouteReviewDownloads(scope, routeReview);
  routeReview.continuation = buildDeveloperOpsRouteReviewContinuation(routeReview);

  const payload = {
    generatedAt,
    fileName: `rocksolid-developer-ops-${scopeTag}-${timestampTag}.json`,
    summaryFileName: `rocksolid-developer-ops-${scopeTag}-${timestampTag}-summary.txt`,
    developer,
    actor,
    scope,
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
    routeReview,
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

function buildDeveloperOpsRouteReviewMatchDescriptor(payload = {}, target = "primary") {
  const normalizedTarget = String(target || "primary").trim().toLowerCase() === "next" ? "next" : "primary";
  const routeReview = payload.routeReview && typeof payload.routeReview === "object" ? payload.routeReview : {};
  const match = normalizedTarget === "next" ? routeReview.nextMatch : routeReview.primaryMatch;
  if (!match || typeof match !== "object") {
    return {
      target: normalizedTarget,
      title: normalizedTarget === "next" ? "Route Review Next Match" : "Route Review Primary Match",
      label: normalizedTarget === "next" ? "Next route review summary" : "Primary route review summary",
      fileName: normalizedTarget === "next"
        ? "developer-ops-next-summary.txt"
        : "developer-ops-primary-summary.txt",
      match: null
    };
  }
  const kind = String(match.kind || "match").trim().toLowerCase() || "match";
  return {
    target: normalizedTarget,
    title: normalizedTarget === "next" ? "Route Review Next Match" : "Route Review Primary Match",
    label: normalizedTarget === "next" ? "Next route review summary" : "Primary route review summary",
    fileName: `developer-ops-${normalizedTarget}-${kind}-summary.txt`,
    match
  };
}

function buildDeveloperOpsRouteReviewMatchSummaryText(payload = {}, target = "primary") {
  const descriptor = buildDeveloperOpsRouteReviewMatchDescriptor(payload, target);
  const scope = payload.scope || {};
  const routeReview = payload.routeReview || {};
  const match = descriptor.match;
  const lines = [
    "RockSolid Developer Ops Route Review Summary",
    `Generated At: ${payload.generatedAt || ""}`,
    `Developer: ${payload.developer?.username || "-"}`,
    `Actor: ${payload.actor?.username || "-"}`,
    `Actor Role: ${payload.actor?.role || "-"}`,
    `Project Filter: ${scope.productCode || "-"}`,
    `Username Filter: ${scope.username || "-"}`,
    `Search Filter: ${scope.search || "-"}`,
    `Audit Event Filter: ${scope.eventType || "-"}`,
    `Audit Actor Filter: ${scope.actorType || "-"}`,
    `Audit Entity Filter: ${scope.entityType || "-"}`,
    `Audit Limit: ${scope.auditLimit ?? 0}`,
    `Route Review Focus: ${routeReview.focus || "-"}`,
    `Route Review Counts: accounts:${routeReview.matchedCounts?.accounts ?? 0} | entitlements:${routeReview.matchedCounts?.entitlements ?? 0} | sessions:${routeReview.matchedCounts?.sessions ?? 0} | devices:${routeReview.matchedCounts?.devices ?? 0} | audit:${routeReview.matchedCounts?.audit ?? 0}`
  ];
  if (Array.isArray(routeReview.highlightedEvents) && routeReview.highlightedEvents.length) {
    lines.push(`Route Review Events: ${routeReview.highlightedEvents.join(", ")}`);
  }
  lines.push("");
  lines.push(`${descriptor.title}:`);
  if (!match) {
    lines.push("- none");
    return lines.join("\n");
  }
  lines.push(`- ${match.title || "-"}`);
  lines.push(`- kind=${match.kind || "-"}`);
  lines.push(`- section=${match.section || "-"}`);
  lines.push(`- summary=${match.summary || "-"}`);
  lines.push(`- action=${match.routeActionLabel || match.routeAction || "-"}`);
  lines.push(`- control=${match.recommendedControl?.label || "-"}`);
  return lines.join("\n");
}

function buildDeveloperOpsRouteReviewRemainingSummaryText(payload = {}) {
  const scope = payload.scope || {};
  const routeReview = payload.routeReview || {};
  const remainingMatches = Array.isArray(routeReview.remainingMatches) ? routeReview.remainingMatches : [];
  const lines = [
    "RockSolid Developer Ops Route Review Summary",
    `Generated At: ${payload.generatedAt || ""}`,
    `Developer: ${payload.developer?.username || "-"}`,
    `Actor: ${payload.actor?.username || "-"}`,
    `Actor Role: ${payload.actor?.role || "-"}`,
    `Project Filter: ${scope.productCode || "-"}`,
    `Username Filter: ${scope.username || "-"}`,
    `Search Filter: ${scope.search || "-"}`,
    `Audit Event Filter: ${scope.eventType || "-"}`,
    `Audit Actor Filter: ${scope.actorType || "-"}`,
    `Audit Entity Filter: ${scope.entityType || "-"}`,
    `Audit Limit: ${scope.auditLimit ?? 0}`,
    `Route Review Focus: ${routeReview.focus || "-"}`,
    `Route Review Counts: accounts:${routeReview.matchedCounts?.accounts ?? 0} | entitlements:${routeReview.matchedCounts?.entitlements ?? 0} | sessions:${routeReview.matchedCounts?.sessions ?? 0} | devices:${routeReview.matchedCounts?.devices ?? 0} | audit:${routeReview.matchedCounts?.audit ?? 0}`,
    `Route Review Total Matches: ${routeReview.totalMatches ?? 0}`
  ];
  if (Array.isArray(routeReview.highlightedEvents) && routeReview.highlightedEvents.length) {
    lines.push(`Route Review Events: ${routeReview.highlightedEvents.join(", ")}`);
  }
  lines.push("");
  lines.push("Route Review Remaining Matches:");
  if (!remainingMatches.length) {
    lines.push("- none");
    return lines.join("\n");
  }
  remainingMatches.forEach((match) => {
    lines.push(`- ${match.title || "-"}`);
    lines.push(`  kind=${match.kind || "-"}`);
    lines.push(`  section=${match.section || "-"}`);
    lines.push(`  summary=${match.summary || "-"}`);
    lines.push(`  action=${match.routeActionLabel || match.routeAction || "-"}`);
    lines.push(`  control=${match.recommendedControl?.label || "-"}`);
  });
  return lines.join("\n");
}

function buildDeveloperOpsRouteReviewBaseDownloadParams(scope = {}) {
  const params = {
    productCode: scope.productCode || "",
    username: scope.username || "",
    search: scope.search || "",
    eventType: scope.eventType || "",
    actorType: scope.actorType || "",
    entityType: scope.entityType || "",
    limit: Number(scope.auditLimit || 0) || 60
  };
  for (const field of ["productCode", "username", "search", "eventType", "actorType", "entityType"]) {
    if (!params[field]) {
      delete params[field];
    }
  }
  return params;
}

function buildDeveloperOpsRouteReviewMatchDownloadDescriptor(scope = {}, routeReview = {}, target = "primary") {
  const descriptor = buildDeveloperOpsRouteReviewMatchDescriptor({ routeReview }, target);
  const match = descriptor.match;
  const params = buildDeveloperOpsRouteReviewBaseDownloadParams(scope);
  const item = match?.item && typeof match.item === "object" ? match.item : {};
  if (item.productCode || item.projectCode) {
    params.productCode = item.productCode || item.projectCode;
  }
  if (item.username) {
    params.username = item.username;
  }
  if (match?.kind === "account") {
    delete params.search;
  } else if (match?.kind === "entitlement") {
    params.entityType = "entitlement";
    delete params.search;
  } else if (match?.kind === "session") {
    params.entityType = params.entityType || "session";
    params.search = item.sessionId || item.id || params.search || "";
  } else if (match?.kind === "device") {
    params.entityType = params.entityType || (item.blockId ? "device_block" : (item.bindingId ? "device_binding" : ""));
    params.search = item.fingerprint || params.search || "";
  }
  for (const field of ["productCode", "username", "search", "eventType", "actorType", "entityType"]) {
    if (!params[field]) {
      delete params[field];
    }
  }
  return {
    key: `route_review_${target}`,
    label: descriptor.label,
    fileName: descriptor.fileName,
    format: target === "next" ? "route-review-next" : "route-review-primary",
    params
  };
}

function buildDeveloperOpsRouteReviewRemainingDownloadDescriptor(scope = {}) {
  return {
    key: "route_review_remaining",
    label: "Remaining routed review summary",
    fileName: "developer-ops-remaining-summary.txt",
    format: "route-review-remaining",
    params: buildDeveloperOpsRouteReviewBaseDownloadParams(scope)
  };
}

function buildDeveloperOpsRouteReviewDownloads(scope = {}, routeReview = {}) {
  return {
    primary: buildDeveloperOpsRouteReviewMatchDownloadDescriptor(scope, routeReview, "primary"),
    next: buildDeveloperOpsRouteReviewMatchDownloadDescriptor(scope, routeReview, "next"),
    remaining: buildDeveloperOpsRouteReviewRemainingDownloadDescriptor(scope)
  };
}

function buildDeveloperOpsRouteReviewContinuation(routeReview = {}) {
  const nextMatch = routeReview.nextMatch && typeof routeReview.nextMatch === "object" ? routeReview.nextMatch : null;
  const queuedRemainingCount = Array.isArray(routeReview.remainingMatches)
    ? routeReview.remainingMatches.length
    : Math.max(Number(routeReview.totalMatches || 0) - 1, 0);
  const remainingCount = nextMatch ? 1 : 0;
  const nextControlLabel = nextMatch?.recommendedControl?.label || "";
  if (nextMatch) {
    return {
      remainingCount,
      queuedRemainingCount,
      nextTitle: nextMatch.title || "",
      nextControlLabel,
      primaryAction: "review_next",
      primaryLabel: "Continue Routed Review",
      secondaryAction: nextControlLabel ? "control_next" : "download_next",
      secondaryLabel: nextControlLabel ? "Open Next Control" : "Download Next Match Summary",
      nextDownload: routeReview.downloads?.next || null,
      remainingDownload: routeReview.downloads?.remaining || null
    };
  }
  return {
    remainingCount: 0,
    queuedRemainingCount,
    nextTitle: "",
    nextControlLabel: "",
    primaryAction: "complete_route_review",
    primaryLabel: "Complete Routed Review",
    secondaryAction: "download_route_review",
    secondaryLabel: "Download Routed Summary",
    nextDownload: null,
    remainingDownload: routeReview.downloads?.remaining || null
  };
}

function buildDeveloperOpsExportDownloadAsset(payload, format = "json") {
  const normalizedFormat = normalizeDownloadFormat(
    format,
    ["json", "summary", "zip", "checksums", "route-review-primary", "route-review-next", "route-review-remaining"],
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

  if (normalizedFormat === "route-review-primary" || normalizedFormat === "route-review-next") {
    const target = normalizedFormat === "route-review-next" ? "next" : "primary";
    const descriptor = buildDeveloperOpsRouteReviewMatchDescriptor(payload, target);
    return {
      fileName: descriptor.fileName,
      contentType: "text/plain; charset=utf-8",
      body: buildDeveloperOpsRouteReviewMatchSummaryText(payload, target)
    };
  }

  if (normalizedFormat === "route-review-remaining") {
    return {
      fileName: "developer-ops-remaining-summary.txt",
      contentType: "text/plain; charset=utf-8",
      body: buildDeveloperOpsRouteReviewRemainingSummaryText(payload)
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
        lines.push(`- ${item.username || "-"} @ ${item.productCode || "-"} | issues=${item.issueCount ?? 0} | severity=${item.severity || "-"} | account=${item.accountId || "-"} | control=${item.recommendedControl?.label || "-"} | next=${item.actionHint || "-"}`);
      }
    }
    if (Array.isArray(overview.focusSessions) && overview.focusSessions.length) {
      lines.push("Focus Sessions:");
      for (const item of overview.focusSessions) {
        lines.push(`- ${item.sessionId || "-"} | ${item.username || "-"} @ ${item.productCode || "-"} | ${item.status || "-"} | severity=${item.severity || "-"} | control=${item.recommendedControl?.label || "-"} | ${item.reason || "-"} | next=${item.actionHint || "-"}`);
      }
    }
    if (Array.isArray(overview.focusDevices) && overview.focusDevices.length) {
      lines.push("Focus Devices:");
      for (const item of overview.focusDevices) {
        lines.push(`- ${item.fingerprint || "-"} @ ${item.productCode || "-"} | ${item.kind || "-"} | ${item.status || "-"} | severity=${item.severity || "-"} | control=${item.recommendedControl?.label || "-"} | ${item.reason || "-"} | next=${item.actionHint || "-"}`);
      }
    }
    appendSnapshotEscalationSummaryLines(lines, overview);
    appendSnapshotQueueSummaryLines(lines, overview);
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

function buildClientStartupBootstrapPayload({
  product,
  clientVersion = null,
  channel = "stable",
  versionManifest,
  notices,
  activeTokenKey,
  tokenKeys = null,
  hasTokenKeys = false,
  generatedAt = nowIso()
} = {}) {
  return {
    generatedAt,
    productCode: product.code,
    clientVersion,
    channel: normalizeChannel(channel),
    versionManifest,
    notices,
    activeTokenKey,
    ...(hasTokenKeys && tokenKeys ? { tokenKeys } : {}),
    hasTokenKeys
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

function buildDeveloperCardExportProjectItem(row = {}) {
  return {
    id: row.id,
    code: row.code ?? row.productCode ?? null,
    name: row.name ?? row.productName ?? "",
    status: row.status ?? null
  };
}

function buildDeveloperCardBatchSummary(items = []) {
  const buckets = new Map();
  for (const item of items) {
    const key = String(item.batchCode || "").trim() || "(unbatched)";
    const entry = buckets.get(key) || {
      batchCode: key === "(unbatched)" ? null : key,
      label: key,
      total: 0,
      unused: 0,
      used: 0,
      frozen: 0,
      revoked: 0,
      expired: 0
    };
    entry.total += 1;
    if (entry[item.displayStatus] !== undefined) {
      entry[item.displayStatus] += 1;
    }
    buckets.set(key, entry);
  }

  return Array.from(buckets.values()).sort((left, right) =>
    right.total - left.total || String(left.label).localeCompare(String(right.label))
  );
}

function buildDeveloperCardExportSummaryText(payload = {}) {
  const scope = payload.scope || {};
  const summary = payload.summary || {};
  const lines = [
    "RockSolid Developer Card Export",
    `Generated At: ${payload.generatedAt || ""}`,
    `Developer: ${payload.developer?.username || "-"}`,
    `Actor: ${payload.actor?.username || "-"}`,
    `Actor Role: ${payload.actor?.role || "-"}`,
    `Accessible Projects: ${scope.accessibleProjectCount ?? 0}`,
    `Scope Projects: ${scope.exportedProjectCount ?? 0}`,
    `Visible Projects: ${scope.visibleProjectCount ?? 0}`,
    `Project Filter: ${scope.productCode || "-"}`,
    `Policy Filter: ${scope.policyId || "-"}`,
    `Batch Filter: ${scope.batchCode || "-"}`,
    `Usage Filter: ${scope.usageStatus || "-"}`,
    `Status Filter: ${scope.status || "-"}`,
    `Search Filter: ${scope.search || "-"}`,
    "",
    `Cards Total: ${summary.total ?? 0}`,
    `Unused: ${summary.unused ?? 0}`,
    `Used: ${summary.used ?? 0}`,
    `Frozen: ${summary.frozen ?? 0}`,
    `Revoked: ${summary.revoked ?? 0}`,
    `Expired: ${summary.expired ?? 0}`,
    `Policies: ${summary.policies ?? 0}`,
    `Batches: ${summary.batches ?? 0}`
  ];

  if (Array.isArray(payload.projects) && payload.projects.length) {
    lines.push("");
    lines.push("Projects:");
    for (const item of payload.projects) {
      lines.push(`- ${item.code || "-"} (${item.name || ""}) [${item.status || "unknown"}]`);
    }
  }

  if (Array.isArray(payload.batches) && payload.batches.length) {
    const visibleBatches = payload.batches.slice(0, 12);
    lines.push("");
    lines.push("Batch Summary:");
    for (const item of visibleBatches) {
      lines.push(`- ${item.label || "-"} | total=${item.total ?? 0} | unused=${item.unused ?? 0} | used=${item.used ?? 0} | frozen=${item.frozen ?? 0} | revoked=${item.revoked ?? 0} | expired=${item.expired ?? 0}`);
    }
    if (payload.batches.length > visibleBatches.length) {
      lines.push(`- +${payload.batches.length - visibleBatches.length} more batches`);
    }
  }

  return lines.join("\n");
}

function buildDeveloperCardExportPayload({
  generatedAt = nowIso(),
  developer = null,
  actor = null,
  accessibleProjects = [],
  projects = [],
  filters = {},
  cards = {}
} = {}) {
  const normalizedProjects = projects.map((item) => buildDeveloperCardExportProjectItem(item));
  const items = Array.isArray(cards.items) ? cards.items.map((item) => ({ ...item })) : [];
  const timestampTag = buildExportTimestampTag(generatedAt);
  const scopeTag = sanitizeExportNameSegment(
    filters.productCode || filters.batchCode || filters.policyId || "all-projects",
    "developer-cards"
  );
  const summary = {
    total: Number(cards.summary?.total ?? items.length),
    unused: Number(cards.summary?.unused ?? 0),
    used: Number(cards.summary?.used ?? 0),
    frozen: Number(cards.summary?.frozen ?? 0),
    revoked: Number(cards.summary?.revoked ?? 0),
    expired: Number(cards.summary?.expired ?? 0),
    policies: new Set(items.map((item) => item.policyId).filter(Boolean)).size,
    batches: new Set(items.map((item) => item.batchCode).filter(Boolean)).size
  };
  const productCodes = Array.from(new Set(items.map((item) => item.productCode).filter(Boolean))).sort();
  const payload = {
    generatedAt,
    fileName: `rocksolid-developer-cards-${scopeTag}-${timestampTag}.json`,
    summaryFileName: `rocksolid-developer-cards-${scopeTag}-${timestampTag}-summary.txt`,
    csvFileName: `rocksolid-developer-cards-${scopeTag}-${timestampTag}.csv`,
    developer,
    actor,
    scope: {
      accessibleProjectCount: accessibleProjects.length,
      exportedProjectCount: normalizedProjects.length,
      visibleProjectCount: productCodes.length,
      productCode: filters.productCode || null,
      policyId: filters.policyId || null,
      batchCode: filters.batchCode || null,
      usageStatus: filters.usageStatus || null,
      status: filters.status || null,
      search: filters.search || null
    },
    summary,
    productCodes,
    projects: normalizedProjects,
    batches: buildDeveloperCardBatchSummary(items),
    items,
    csvText: buildCardsCsv(items),
    notes: [
      "This export is scoped to the current developer actor and their assigned projects.",
      "Use the zip archive when you need a handoff bundle with JSON, summary, CSV, and checksum manifest.",
      "The legacy /api/developer/cards/export route still returns CSV for backward compatibility."
    ]
  };

  payload.summaryText = buildDeveloperCardExportSummaryText(payload);
  return payload;
}

function buildDeveloperCardExportFiles(payload = {}) {
  return [
    {
      path: payload.fileName || "developer-cards.json",
      body: JSON.stringify(payload, null, 2)
    },
    {
      path: payload.summaryFileName || "developer-cards-summary.txt",
      body: payload.summaryText || ""
    },
    {
      path: payload.csvFileName || "developer-cards.csv",
      body: payload.csvText || ""
    }
  ];
}

function buildDeveloperCardExportZipEntries(payload = {}) {
  return buildZipEntriesFromFiles(
    buildArchiveRootName(payload.fileName, "developer-cards"),
    buildDeveloperCardExportFiles(payload)
  );
}

function buildDeveloperCardExportDownloadAsset(payload, format = "json") {
  const normalizedFormat = normalizeDownloadFormat(
    format,
    ["json", "csv", "summary", "checksums", "zip"],
    "json",
    "INVALID_DEVELOPER_CARD_EXPORT_FORMAT",
    "Developer card export format"
  );

  if (normalizedFormat === "zip") {
    return {
      fileName: `${buildArchiveRootName(payload.fileName, "developer-cards")}.zip`,
      contentType: "application/zip",
      body: buildZipArchive(buildDeveloperCardExportZipEntries(payload))
    };
  }

  if (normalizedFormat === "checksums") {
    return {
      fileName: buildChecksumFileName(payload.fileName, "developer-cards"),
      contentType: "text/plain; charset=utf-8",
      body: buildChecksumManifestText(buildDeveloperCardExportFiles(payload))
    };
  }

  if (normalizedFormat === "summary") {
    return {
      fileName: payload.summaryFileName || "developer-cards-summary.txt",
      contentType: "text/plain; charset=utf-8",
      body: payload.summaryText || ""
    };
  }

  if (normalizedFormat === "csv") {
    return {
      fileName: payload.csvFileName || "developer-cards.csv",
      contentType: "text/csv; charset=utf-8",
      body: payload.csvText || ""
    };
  }

  return {
    fileName: payload.fileName || "developer-cards.json",
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(payload, null, 2)
  };
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
      const items = await Promise.all(products.map((product) => buildDeveloperIntegrationPackagePayloadAsync({
        db,
        store,
        actor: buildAdminActorPayload(admin),
        product,
        transport,
        signing,
        tokenKeys,
        examples,
        includeOwner: true,
        generatedAt
      })));
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
      return await buildDeveloperIntegrationPackagePayloadAsync({
        db,
        store,
        developer: buildDeveloperIdentityPayload(session),
        actor: buildDeveloperActor(session),
        product,
        transport,
        signing,
        tokenKeys,
        examples: buildIntegrationExamples(),
        startupRequest: {
          channel: selector.channel
        }
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
      const integrationPackage = await buildDeveloperIntegrationPackagePayloadAsync({
        db,
        store,
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
      const releaseStartupPreview = await buildIntegrationStartupPreviewPayload(
        db,
        store,
        product,
        tokenKeys,
        {
          clientVersion: versionManifest.latestVersion || integrationPackage?.manifest?.startupDefaults?.clientVersion || "1.0.0",
          channel,
          includeTokenKeys: true
        }
      );
      const businessMetrics = product?.id
        ? await queryProductBusinessMetricMaps(db, store, [product.id], generatedAt)
        : null;
      const productMetricKey = String(product?.id ?? "");
      const scopedPoliciesPayload = product?.code
        ? await this.developerListPolicies(token, { productCode: product.code })
        : [];
      const scopedCardsPayload = product?.code
        ? await this.developerListCards(token, { productCode: product.code })
        : { items: [] };
      const activePolicies = Array.isArray(scopedPoliciesPayload)
        ? scopedPoliciesPayload.filter((item) => normalizeProductStatus(item?.status || "active") === "active")
        : [];
      const scopedCards = Array.isArray(scopedCardsPayload?.items) ? scopedCardsPayload.items : [];
      const authReadiness = buildLaunchWorkflowAuthorizationReadiness({
        product: {
          id: product.id,
          code: product.code,
          name: product.name,
          status: product.status,
          featureConfig: product.featureConfig && typeof product.featureConfig === "object"
            ? product.featureConfig
            : {}
        },
        metrics: {
          policies: businessMetrics?.policyCounts?.get(productMetricKey) ?? 0,
          cardsFresh: businessMetrics?.freshCardCounts?.get(productMetricKey) ?? 0,
          cardsRedeemed: businessMetrics?.redeemedCardCounts?.get(productMetricKey) ?? 0,
          accounts: businessMetrics?.accountCounts?.get(productMetricKey) ?? 0,
          activeEntitlements: businessMetrics?.activeEntitlementCounts?.get(productMetricKey) ?? 0,
          cards: scopedCards
        },
        policies: activePolicies
      });
      const payload = buildReleasePackagePayload({
        generatedAt,
        developer,
        actor,
        product,
        channel,
        versionManifest,
        activeNoticeRows,
        integrationPackage,
        authReadiness,
        releaseStartupPreview
      });
      auditDeveloperSession(db, session, "product.release-package.export", "product", product.id, {
        code: product.code,
        channel,
        fileName: payload.fileName
      });
      return payload;
    },

    async developerLaunchWorkflowPackage(token, selector = {}, options = {}) {
      const [releasePackage, integrationPackage] = await Promise.all([
        this.developerReleasePackage(token, selector, options),
        this.developerIntegrationPackage(token, selector, options)
      ]);
      const project = releasePackage?.manifest?.project || integrationPackage?.manifest?.project || {};
      const businessMetrics = project?.id
        ? await queryProductBusinessMetricMaps(
            db,
            store,
            [project.id],
            releasePackage?.manifest?.generatedAt || integrationPackage?.manifest?.generatedAt || nowIso()
          )
        : null;
      const projectMetricKey = String(project?.id ?? "");
      const scopedPoliciesPayload = project?.code
        ? await this.developerListPolicies(token, { productCode: project.code })
        : [];
      const scopedCardsPayload = project?.code
        ? await this.developerListCards(token, { productCode: project.code })
        : { items: [] };
      const activePolicies = Array.isArray(scopedPoliciesPayload)
        ? scopedPoliciesPayload.filter((item) => normalizeProductStatus(item?.status || "active") === "active")
        : [];
      const scopedCards = Array.isArray(scopedCardsPayload?.items) ? scopedCardsPayload.items : [];
      const authReadiness = buildLaunchWorkflowAuthorizationReadiness({
        product: {
          id: project.id,
          code: project.code,
          name: project.name,
          status: project.status,
          featureConfig: project.featureConfig && typeof project.featureConfig === "object"
            ? project.featureConfig
            : {}
        },
        metrics: {
          policies: businessMetrics?.policyCounts?.get(projectMetricKey) ?? 0,
          cardsFresh: businessMetrics?.freshCardCounts?.get(projectMetricKey) ?? 0,
          cardsRedeemed: businessMetrics?.redeemedCardCounts?.get(projectMetricKey) ?? 0,
          accounts: businessMetrics?.accountCounts?.get(projectMetricKey) ?? 0,
          activeEntitlements: businessMetrics?.activeEntitlementCounts?.get(projectMetricKey) ?? 0,
          cards: scopedCards
        },
        policies: activePolicies
      });
      const payload = buildLaunchWorkflowPackagePayload({
        generatedAt: releasePackage?.manifest?.generatedAt || integrationPackage?.manifest?.generatedAt || nowIso(),
        developer: releasePackage?.manifest?.developer || integrationPackage?.manifest?.developer || null,
        actor: releasePackage?.manifest?.actor || integrationPackage?.manifest?.actor || null,
        product: {
          id: project.id,
          code: project.code,
          projectCode: project.projectCode ?? project.code,
          softwareCode: project.softwareCode ?? project.code,
          name: project.name,
          description: project.description,
          status: project.status,
          updatedAt: project.updatedAt,
          featureConfig: project.featureConfig && typeof project.featureConfig === "object"
            ? project.featureConfig
            : {}
        },
        channel: releasePackage?.manifest?.release?.channel || selector.channel || "stable",
        releasePackage,
        integrationPackage,
        authReadiness
      });
      const session = requireDeveloperSession(db, token);
      auditDeveloperSession(db, session, "product.launch-workflow.export", "product", project.id, {
        code: project.code,
        channel: payload.manifest.channel,
        fileName: payload.fileName
      });
      return payload;
    },

    async developerLaunchReviewPackage(token, selector = {}, options = {}) {
      const launchWorkflow = await this.developerLaunchWorkflowPackage(token, selector, options);
      const project = launchWorkflow?.manifest?.project || {};
      const channel = launchWorkflow?.manifest?.channel || normalizeChannel(selector.channel, "stable");
      const opsSnapshot = await this.developerExportOpsSnapshot(token, {
        productCode: project.code || selector.productCode || selector.projectCode || selector.softwareCode || null,
        username: selector.username,
        search: selector.search,
        eventType: selector.eventType,
        actorType: selector.actorType,
        entityType: selector.entityType,
        limit: selector.limit
      });
      const payload = buildDeveloperLaunchReviewPayload({
        generatedAt: launchWorkflow?.manifest?.generatedAt || opsSnapshot?.generatedAt || nowIso(),
        launchWorkflow,
        opsSnapshot,
        filters: {
          productCode: project.code || selector.productCode || selector.projectCode || selector.softwareCode || null,
          channel,
          username: selector.username || null,
          search: selector.search || null,
          eventType: selector.eventType || null,
          actorType: selector.actorType || null,
          entityType: selector.entityType || null,
          reviewMode: selector.reviewMode || null
        }
      });
      const session = requireDeveloperSession(db, token);
      auditDeveloperSession(db, session, "product.launch-review.export", "product", project.id, {
        code: project.code,
        channel,
        fileName: payload.fileName
      });
      return payload;
    },

    async developerLaunchSmokeKit(token, selector = {}, options = {}) {
      const launchWorkflow = await this.developerLaunchWorkflowPackage(token, selector, options);
      const project = launchWorkflow?.manifest?.project || {};
      const channel = launchWorkflow?.manifest?.channel || normalizeChannel(selector.channel, "stable");
      const [accountsPayload, entitlementsPayload, cardsPayload] = await Promise.all([
        this.developerListAccounts(token, { productCode: project.code || selector.productCode || selector.projectCode || selector.softwareCode || null }),
        this.developerListEntitlements(token, { productCode: project.code || selector.productCode || selector.projectCode || selector.softwareCode || null }),
        this.developerListCards(token, { productCode: project.code || selector.productCode || selector.projectCode || selector.softwareCode || null })
      ]);
      const payload = buildDeveloperLaunchSmokeKitPayload({
        generatedAt: launchWorkflow?.manifest?.generatedAt || nowIso(),
        launchWorkflow,
        accounts: Array.isArray(accountsPayload?.items) ? accountsPayload.items : [],
        entitlements: Array.isArray(entitlementsPayload?.items) ? entitlementsPayload.items : [],
        cards: Array.isArray(cardsPayload?.items) ? cardsPayload.items : [],
        filters: {
          productCode: project.code || selector.productCode || selector.projectCode || selector.softwareCode || null,
          channel
        }
      });
      const session = requireDeveloperSession(db, token);
      auditDeveloperSession(db, session, "product.launch-smoke-kit.export", "product", project.id, {
        code: project.code,
        channel,
        fileName: payload.fileName
      });
      return payload;
    },

    releasePackageDownloadAsset(payload, format = "json") {
      return buildReleasePackageDownloadAsset(payload, format);
    },

    launchWorkflowPackageDownloadAsset(payload, format = "json") {
      return buildLaunchWorkflowPackageDownloadAsset(payload, format);
    },

    launchReviewDownloadAsset(payload, format = "json") {
      return buildDeveloperLaunchReviewDownloadAsset(payload, format);
    },

    launchSmokeKitDownloadAsset(payload, format = "json") {
      return buildDeveloperLaunchSmokeKitDownloadAsset(payload, format);
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
      const items = await Promise.all(products.map((product) => buildDeveloperIntegrationPackagePayloadAsync({
        db,
        store,
        developer,
        actor,
        product,
        transport,
        signing,
        tokenKeys,
        examples,
        generatedAt
      })));
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
      const payload = await this.developerExportCards(token, filters);
      return payload.csvText;
    },

    async developerExportCards(token, filters = {}) {
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

      const accessibleProjects = await listDeveloperAccessibleProductRows(db, store, session);
      const scopedProjects = filters.productCode
        ? accessibleProjects.filter((item) => item.code === String(filters.productCode).trim().toUpperCase())
        : accessibleProjects;
      const cards = await Promise.resolve(store.cards.queryCardRows(
        db,
        { ...filters, productIds: scopedProjects.map((item) => item.id) },
        { limit: 5000 }
      ));
      const payload = buildDeveloperCardExportPayload({
        developer: buildDeveloperIdentityPayload(session),
        actor: buildDeveloperActor(session),
        accessibleProjects,
        projects: scopedProjects,
        filters: cards.filters || {},
        cards
      });

      auditDeveloperSession(db, session, "card.export", "license_key", null, {
        productCode: payload.scope.productCode,
        policyId: payload.scope.policyId,
        batchCode: payload.scope.batchCode,
        usageStatus: payload.scope.usageStatus,
        status: payload.scope.status,
        search: payload.scope.search,
        total: payload.summary.total,
        productCodes: payload.productCodes,
        fileName: payload.fileName,
        csvFileName: payload.csvFileName
      });

      return payload;
    },

    developerCardExportDownloadAsset(payload, format = "json") {
      return buildDeveloperCardExportDownloadAsset(payload, format);
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

    async developerCreateAccount(token, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage customer accounts under your assigned projects."
      );
      requireField(body, "productCode");
      requireField(body, "username");
      requireField(body, "password");

      const product = await getStoreActiveProductByCode(readProductCodeInput(body));
      ensureDeveloperCanAccessProduct(
        db,
        session,
        {
          id: product.id,
          owner_developer_id: product.ownerDeveloperId ?? product.ownerDeveloper?.id ?? null
        },
        "ops.write",
        "DEVELOPER_OPS_FORBIDDEN",
        "You can only manage customer accounts under your assigned projects."
      );

      const username = String(body.username).trim();
      const password = String(body.password);
      if (username.length < 3 || password.length < 8) {
        throw new AppError(400, "INVALID_ACCOUNT", "Username must be 3+ chars and password 8+ chars.");
      }

      const timestamp = nowIso();
      const account = await Promise.resolve(store.accounts.createAccount(product, {
        username,
        passwordHash: hashPassword(password)
      }, timestamp));
      await syncSqliteAccountRecordShadow(account, product);

      const manageRow = await getStoreAccountById(account.id);

      auditDeveloperSession(db, session, "account.seed", "account", account.id, {
        productCode: product.code,
        username
      });

      return {
        ...manageRow,
        created: true
      };
    },

    async developerBootstrapLicenseQuickstart(token, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireField(body, "productCode");

      const productCode = readProductCodeInput(body);
      const product = await getStoreActiveProductByCode(productCode);
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

      const featureConfig = product?.featureConfig && typeof product.featureConfig === "object"
        ? product.featureConfig
        : {};
      const collectState = async () => {
        const [policies, cardsPayload, accountsPayload, entitlementsPayload] = await Promise.all([
          this.developerListPolicies(token, { productCode }),
          this.developerListCards(token, { productCode }),
          this.developerListAccounts(token, { productCode }),
          this.developerListEntitlements(token, { productCode })
        ]);
        const policyItems = Array.isArray(policies) ? policies : [];
        const activePolicies = policyItems.filter((item) => normalizeProductStatus(item?.status || "active") === "active");
        const cardItems = Array.isArray(cardsPayload?.items) ? cardsPayload.items : [];
        const freshCards = cardItems.filter((item) =>
          normalizeCardControlStatus(item?.status || "active") === "active"
            && isFreshCardInventoryStatus(item?.usageStatus ?? item?.displayStatus)
        );
        const redeemedCards = cardItems.filter((item) => item?.usageStatus === "redeemed");
        const accountItems = Array.isArray(accountsPayload?.items) ? accountsPayload.items : [];
        const activeAccounts = accountItems.filter((item) => String(item?.status || "active").trim().toLowerCase() === "active");
        const entitlementItems = Array.isArray(entitlementsPayload?.items) ? entitlementsPayload.items : [];
        const activeEntitlements = entitlementItems.filter((item) =>
          String(item?.lifecycleStatus || item?.status || "").trim().toLowerCase() === "active"
        ).length;
        const authorization = buildLaunchWorkflowAuthorizationReadiness({
          product,
          metrics: {
            policies: activePolicies.length,
            cardsFresh: freshCards.length,
            cardsRedeemed: redeemedCards.length,
            accounts: accountItems.length,
            activeEntitlements,
            cards: cardItems
          },
          policies: activePolicies
        });
        return {
          policies: policyItems,
          activePolicies,
          cards: cardItems,
          freshCards,
          accounts: accountItems,
          activeAccounts,
          entitlements: entitlementItems,
          activeEntitlements,
          authorization
        };
      };

      const before = await collectState();
      const accountLoginEnabled = featureConfig.allowAccountLogin !== false;
      const registerEnabled = featureConfig.allowRegister !== false;
      const cardLoginEnabled = featureConfig.allowCardLogin !== false;
      const cardRechargeEnabled = featureConfig.allowCardRecharge !== false;
      const missingLoginPath = !accountLoginEnabled && !cardLoginEnabled;

      if (missingLoginPath) {
        throw new AppError(
          409,
          "LAUNCH_BOOTSTRAP_BLOCKED",
          "Enable account login or direct-card login in the project authorization preset before running launch bootstrap."
        );
      }

      const needsPolicy = before.activePolicies.length <= 0;
      const needsCards = (cardLoginEnabled || cardRechargeEnabled) && before.freshCards.length <= 0;
      const needsStarterAccount = accountLoginEnabled && !registerEnabled && before.accounts.length <= 0;
      const needsStarterEntitlement = accountLoginEnabled
        && !cardLoginEnabled
        && !cardRechargeEnabled
        && before.activeEntitlements <= 0;
      const needsBootstrapAccount = needsStarterAccount || (needsStarterEntitlement && before.activeAccounts.length <= 0);

      if (!needsPolicy && !needsCards && !needsBootstrapAccount && !needsStarterEntitlement) {
        const followUp = buildLaunchQuickstartFollowUpPlan({
          product,
          policies: before.activePolicies,
          launchRecommendations: before.authorization?.launchRecommendations,
          operation: "bootstrap"
        });
        return {
          productCode,
          productName: product.name,
          modeSummary: buildLaunchAuthorizationModeSummary(featureConfig),
          created: {},
          skipped: ["No quickstart bootstrap actions were needed."],
          before: {
            authorization: before.authorization,
            counts: {
              policies: before.activePolicies.length,
              freshCards: before.freshCards.length,
              accounts: before.accounts.length,
              activeEntitlements: before.activeEntitlements
            }
          },
          after: {
            authorization: before.authorization,
            counts: {
              policies: before.activePolicies.length,
              freshCards: before.freshCards.length,
              accounts: before.accounts.length,
              activeEntitlements: before.activeEntitlements
            }
          },
          followUp,
          message: `Launch quickstart is already staged for ${productCode}.`
        };
      }

      const created = {};
      let effectivePolicies = before.activePolicies.slice();

      if (needsPolicy) {
        created.policy = await this.developerCreatePolicy(token, {
          productCode,
          ...buildLaunchStarterPolicyDraft(product, effectivePolicies)
        });
        effectivePolicies = [created.policy, ...effectivePolicies];
      }

      if (needsCards) {
        const cardBatchDrafts = buildLaunchRecommendedCardInventoryStates(product, effectivePolicies, before.cards)
          .filter((item) => item.inventoryStatus === "missing");
        if (!cardBatchDrafts.length) {
          throw new AppError(
            409,
            "LAUNCH_BOOTSTRAP_CARD_BATCH_NOT_APPLICABLE",
            "Launch bootstrap could not find a missing starter card batch for this lane."
          );
        }
        created.cardBatches = [];
        for (const cardBatchDraft of cardBatchDrafts) {
          if (!cardBatchDraft.policyId) {
            throw new AppError(
              409,
              "LAUNCH_BOOTSTRAP_POLICY_REQUIRED",
              "Create or keep at least one active starter policy before issuing bootstrap card inventory."
            );
          }
          const createdBatch = await this.developerCreateCardBatch(token, {
            productCode,
            policyId: cardBatchDraft.policyId,
            count: cardBatchDraft.count,
            prefix: cardBatchDraft.prefix,
            notes: cardBatchDraft.notes
          });
          created.cardBatches.push({
            ...createdBatch,
            mode: cardBatchDraft.mode,
            label: cardBatchDraft.label,
            prefix: cardBatchDraft.prefix
          });
        }
        created.cardBatch = created.cardBatches[0] || null;
      }

      if (needsBootstrapAccount) {
        const starterAccountDraft = buildLaunchStarterAccountDraft(product, before.accounts.length);
        const account = await this.developerCreateAccount(token, {
          productCode,
          username: starterAccountDraft.username,
          password: starterAccountDraft.password
        });
        created.account = {
          ...account,
          temporaryPassword: starterAccountDraft.password
        };
      }

      if (needsStarterEntitlement) {
        const targetAccountId = created.account?.id
          ?? before.activeAccounts[0]?.id
          ?? before.accounts[0]?.id
          ?? null;

        if (!targetAccountId) {
          throw new AppError(
            409,
            "LAUNCH_BOOTSTRAP_ACCOUNT_REQUIRED",
            "Launch bootstrap could not find an account to seed the internal starter entitlement."
          );
        }

        const targetAccount = await getStoreAccountRecordById(targetAccountId);
        if (!targetAccount) {
          throw new AppError(
            404,
            "ACCOUNT_NOT_FOUND",
            "Starter entitlement bootstrap could not load the target account."
          );
        }

        const seedBatchDraft = buildLaunchInternalSeedCardBatchDraft(product, effectivePolicies);
        if (!seedBatchDraft.policyId) {
          throw new AppError(
            409,
            "LAUNCH_BOOTSTRAP_POLICY_REQUIRED",
            "Create or keep at least one active starter policy before seeding an internal entitlement."
          );
        }

        const seedPolicy = await getStorePolicyById(seedBatchDraft.policyId);
        if (!seedPolicy || seedPolicy.productId !== product.id || normalizeProductStatus(seedPolicy.status || "active") !== "active") {
          throw new AppError(
            404,
            "POLICY_NOT_FOUND",
            "Launch bootstrap could not find an active policy for the internal entitlement seed."
          );
        }

        const seedTimestamp = nowIso();
        const { seedBatch, activation } = await withTransaction(db, async () => {
          const seedBatch = await createShadowedCardBatch(product, seedPolicy, seedBatchDraft, seedTimestamp);
          const seedEntry = Array.isArray(seedBatch?.issued) ? seedBatch.issued[0] : null;
          const seedCardId = seedEntry?.licenseKeyId ?? seedEntry?.id ?? null;

          if (!seedCardId) {
            throw new AppError(
              500,
              "LAUNCH_BOOTSTRAP_SEED_CARD_MISSING",
              "Launch bootstrap could not stage the internal entitlement seed card."
            );
          }

          const seedCard = await getStoreCardById(seedCardId);
          if (!seedCard) {
            throw new AppError(
              404,
              "CARD_NOT_FOUND",
              "Launch bootstrap could not load the internal entitlement seed card."
            );
          }
          const seedActivationCard = {
            ...seedCard,
            policyId: seedPolicy.id,
            policyName: seedPolicy.name,
            durationDays: seedPolicy.durationDays,
            grantType: seedPolicy.grantType,
            grantPoints: seedPolicy.grantPoints
          };

          const activation = await activateFreshCardEntitlementWithShadow(
            product,
            targetAccount,
            seedActivationCard,
            seedTimestamp
          );

          return { seedBatch, activation };
        });

        created.entitlement = {
          id: activation.entitlementId,
          accountId: targetAccount.id,
          username: targetAccount.username,
          policyName: activation.policyName,
          grantType: activation.grantType,
          startsAt: activation.startsAt,
          endsAt: activation.endsAt,
          totalPoints: activation.totalPoints,
          remainingPoints: activation.remainingPoints,
          sourceCardKey: activation.cardKey,
          seedBatchCode: seedBatch.batchCode
        };
      }

      const rawAfter = await collectState();
      const afterActiveEntitlements = Math.max(
        Number(rawAfter.activeEntitlements ?? 0),
        Number(before.activeEntitlements ?? 0) + (created.entitlement ? 1 : 0)
      );
      const after = afterActiveEntitlements === Number(rawAfter.activeEntitlements ?? 0)
        ? rawAfter
        : {
            ...rawAfter,
            activeEntitlements: afterActiveEntitlements,
            authorization: buildLaunchWorkflowAuthorizationReadiness({
              product,
              metrics: {
                policies: rawAfter.activePolicies.length,
                cardsFresh: rawAfter.freshCards.length,
                cardsRedeemed: rawAfter.cards.filter((item) => item?.usageStatus === "redeemed").length,
                accounts: rawAfter.accounts.length,
                activeEntitlements: afterActiveEntitlements,
                cards: rawAfter.cards
              },
              policies: rawAfter.activePolicies
            })
          };
      const followUp = buildLaunchQuickstartFollowUpPlan({
        product,
        policies: after.activePolicies,
        launchRecommendations: after.authorization?.launchRecommendations,
        operation: "bootstrap"
      });

      auditDeveloperSession(db, session, "license.quickstart.bootstrap", "product", product.id, {
        productCode,
        createdPolicy: Boolean(created.policy),
        createdCardBatch: Boolean(created.cardBatch),
        createdCardBatches: Array.isArray(created.cardBatches) ? created.cardBatches.map((item) => item.batchCode) : [],
        createdAccount: Boolean(created.account),
        createdEntitlement: Boolean(created.entitlement),
        policyId: created.policy?.id ?? null,
        batchCode: created.cardBatch?.batchCode ?? null,
        starterUsername: created.account?.username ?? null,
        entitlementId: created.entitlement?.id ?? null,
        entitlementUsername: created.entitlement?.username ?? null,
        entitlementSeedBatchCode: created.entitlement?.seedBatchCode ?? null,
        beforeStatus: before.authorization.status,
        afterStatus: after.authorization.status
      });

      const createdParts = [
        created.policy ? `policy:${created.policy.name}` : null,
        Array.isArray(created.cardBatches) && created.cardBatches.length
          ? `cards:${created.cardBatches.reduce((sum, item) => sum + Number(item?.count ?? 0), 0)}`
          : (created.cardBatch ? `cards:${created.cardBatch.count}` : null),
        created.account ? `account:${created.account.username}` : null,
        created.entitlement ? `entitlement:${created.entitlement.username}` : null
      ].filter(Boolean);

      return {
        productCode,
        productName: product.name,
        modeSummary: buildLaunchAuthorizationModeSummary(featureConfig),
        created,
        skipped: [],
        before: {
          authorization: before.authorization,
          counts: {
            policies: before.activePolicies.length,
            freshCards: before.freshCards.length,
            accounts: before.accounts.length,
            activeEntitlements: before.activeEntitlements
          }
        },
        after: {
          authorization: after.authorization,
          counts: {
            policies: after.activePolicies.length,
            freshCards: after.freshCards.length,
            accounts: after.accounts.length,
            activeEntitlements: after.activeEntitlements
          }
        },
        followUp,
        message: createdParts.length
          ? `Launch quickstart bootstrap created ${createdParts.join(", ")} for ${productCode}.`
          : `Launch quickstart bootstrap completed for ${productCode}.`
      };
    },

    async developerCreateLicenseQuickstartFirstBatches(token, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "cards.write",
        "DEVELOPER_CARD_FORBIDDEN",
        "You can only manage cards under your assigned projects."
      );
      requireField(body, "productCode");

      const productCode = readProductCodeInput(body);
      const product = await getStoreActiveProductByCode(productCode);
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

      const featureConfig = product?.featureConfig && typeof product.featureConfig === "object"
        ? product.featureConfig
        : {};
      if (featureConfig.allowCardLogin === false && featureConfig.allowCardRecharge === false) {
        throw new AppError(
          409,
          "FIRST_BATCH_SETUP_NOT_APPLICABLE",
          "This launch lane does not use direct-card login or recharge inventory."
        );
      }

      const requestedMode = String(body.mode || "recommended").trim().toLowerCase();
      if (!["recommended", "direct_card", "recharge"].includes(requestedMode)) {
        throw new AppError(
          400,
          "INVALID_FIRST_BATCH_MODE",
          "mode must be recommended, direct_card, or recharge."
        );
      }

      const collectState = async () => {
        const [policiesPayload, cardsPayload] = await Promise.all([
          this.developerListPolicies(token, { productCode }),
          this.developerListCards(token, { productCode })
        ]);
        const policyItems = Array.isArray(policiesPayload) ? policiesPayload : [];
        const activePolicies = policyItems.filter((item) => normalizeProductStatus(item?.status || "active") === "active");
        const cardItems = Array.isArray(cardsPayload?.items) ? cardsPayload.items : [];
        const freshCards = cardItems.filter((item) =>
          normalizeCardControlStatus(item?.status || "active") === "active"
            && isFreshCardInventoryStatus(item?.usageStatus ?? item?.displayStatus)
        );
        return {
          policies: policyItems,
          activePolicies,
          cards: cardItems,
          freshCards
        };
      };

      const before = await collectState();
      if (before.activePolicies.length <= 0) {
        throw new AppError(
          409,
          "FIRST_BATCH_POLICY_REQUIRED",
          "Create or bootstrap at least one active starter policy before running first-batch setup."
        );
      }

      const recommendedStates = buildLaunchRecommendedCardInventoryStates(product, before.activePolicies, before.cards);
      const requestedStates = requestedMode === "recommended"
        ? recommendedStates
        : recommendedStates.filter((item) => item.mode === requestedMode);
      const drafts = requestedStates.filter((item) => item.inventoryStatus === "missing");

      if (!requestedStates.length) {
        throw new AppError(
          409,
          "FIRST_BATCH_SETUP_NOT_APPLICABLE",
          requestedMode === "direct_card"
            ? "Direct-card starter inventory is not enabled for this project."
            : "Recharge starter inventory is not enabled for this project."
        );
      }

      if (!drafts.length) {
        const lowInventoryStates = requestedStates.filter((item) => item.inventoryStatus === "low");
        throw new AppError(
          409,
          "FIRST_BATCH_SETUP_NOT_NEEDED",
          lowInventoryStates.length
            ? `Starter inventory already exists for ${lowInventoryStates.map((item) => item.label).join(" + ")}. Use inventory refill when the launch buffer runs low.`
            : `First-batch setup found no missing recommended card batches for ${productCode}.`
        );
      }

      const createdBatches = [];
      const skipped = [];

      for (const draft of drafts) {
        if (!draft.policyId) {
          throw new AppError(
            409,
            "FIRST_BATCH_POLICY_REQUIRED",
            `Launch quickstart could not find an active policy for ${draft.label.toLowerCase()}.`
          );
        }

        const createdBatch = await this.developerCreateCardBatch(token, {
          productCode,
          policyId: draft.policyId,
          count: draft.count,
          prefix: draft.prefix,
          notes: draft.notes
        });

        createdBatches.push({
          key: draft.key,
          mode: draft.mode,
          label: draft.label,
          grantType: draft.grantType,
          count: createdBatch.count,
          batchCode: createdBatch.batchCode,
          prefix: draft.prefix,
          purpose: draft.purpose
        });
      }

      const after = await collectState();
      const followUp = buildLaunchQuickstartFollowUpPlan({
        product,
        policies: after.activePolicies,
        metrics: {
          policies: after.activePolicies.length,
          cardsFresh: after.freshCards.length,
          cardsRedeemed: Math.max(0, after.cards.length - after.freshCards.length),
          accounts: 0,
          activeEntitlements: 0,
          cards: after.cards
        },
        operation: "first_batch_setup"
      });

      auditDeveloperSession(db, session, "license.quickstart.first_batch_setup", "product", product.id, {
        productCode,
        requestedMode,
        createdBatchCodes: createdBatches.map((item) => item.batchCode),
        skipped,
        beforeFreshCards: before.freshCards.length,
        afterFreshCards: after.freshCards.length
      });

      return {
        productCode,
        productName: product.name,
        modeSummary: buildLaunchAuthorizationModeSummary(featureConfig),
        requestedMode,
        createdBatches,
        skipped,
        inventoryStates: recommendedStates.map((item) => ({
          key: item.key,
          mode: item.mode,
          label: item.label,
          status: item.inventoryStatus,
          freshCount: item.freshCount,
          targetCount: item.targetCount
        })),
        before: {
          counts: {
            policies: before.activePolicies.length,
            freshCards: before.freshCards.length
          }
        },
        after: {
          counts: {
            policies: after.activePolicies.length,
            freshCards: after.freshCards.length
          }
        },
        followUp,
        message: createdBatches.length
          ? `First-batch setup created ${createdBatches.map((item) => item.batchCode).join(", ")} for ${productCode}.`
          : `First-batch setup found no missing recommended card batches for ${productCode}.`
      };
    },

    async developerRestockLicenseQuickstartBatches(token, body = {}) {
      const session = requireDeveloperSession(db, token);
      requireDeveloperPermission(
        session,
        "cards.write",
        "DEVELOPER_CARD_FORBIDDEN",
        "You can only manage cards under your assigned projects."
      );
      requireField(body, "productCode");

      const productCode = readProductCodeInput(body);
      const product = await getStoreActiveProductByCode(productCode);
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

      const featureConfig = product?.featureConfig && typeof product.featureConfig === "object"
        ? product.featureConfig
        : {};
      if (featureConfig.allowCardLogin === false && featureConfig.allowCardRecharge === false) {
        throw new AppError(
          409,
          "INVENTORY_REFILL_NOT_APPLICABLE",
          "This launch lane does not use direct-card login or recharge inventory."
        );
      }

      const requestedMode = String(body.mode || "recommended").trim().toLowerCase();
      if (!["recommended", "direct_card", "recharge"].includes(requestedMode)) {
        throw new AppError(
          400,
          "INVALID_RESTOCK_MODE",
          "mode must be recommended, direct_card, or recharge."
        );
      }

      const collectState = async () => {
        const [policiesPayload, cardsPayload] = await Promise.all([
          this.developerListPolicies(token, { productCode }),
          this.developerListCards(token, { productCode })
        ]);
        const policyItems = Array.isArray(policiesPayload) ? policiesPayload : [];
        const activePolicies = policyItems.filter((item) => normalizeProductStatus(item?.status || "active") === "active");
        const cardItems = Array.isArray(cardsPayload?.items) ? cardsPayload.items : [];
        const freshCards = cardItems.filter((item) =>
          normalizeCardControlStatus(item?.status || "active") === "active"
            && isFreshCardInventoryStatus(item?.usageStatus ?? item?.displayStatus)
        );
        return {
          policies: policyItems,
          activePolicies,
          cards: cardItems,
          freshCards
        };
      };

      const before = await collectState();
      if (before.activePolicies.length <= 0) {
        throw new AppError(
          409,
          "INVENTORY_REFILL_POLICY_REQUIRED",
          "Create or bootstrap at least one active starter policy before running inventory refill."
        );
      }

      const recommendedStates = buildLaunchRecommendedCardInventoryStates(product, before.activePolicies, before.cards);
      const requestedStates = requestedMode === "recommended"
        ? recommendedStates
        : recommendedStates.filter((item) => item.mode === requestedMode);
      const drafts = requestedStates.filter((item) => item.inventoryStatus === "low");

      if (!requestedStates.length) {
        throw new AppError(
          409,
          "INVENTORY_REFILL_NOT_APPLICABLE",
          requestedMode === "direct_card"
            ? "Direct-card starter inventory is not enabled for this project."
            : "Recharge starter inventory is not enabled for this project."
        );
      }

      if (!drafts.length) {
        const missingStates = requestedStates.filter((item) => item.inventoryStatus === "missing");
        throw new AppError(
          409,
          "INVENTORY_REFILL_NOT_NEEDED",
          missingStates.length
            ? `Starter inventory is still missing for ${missingStates.map((item) => item.label).join(" + ")}. Run First Batch Setup before inventory refill.`
            : `Starter inventory already has enough fresh cards for ${productCode}.`
        );
      }

      const createdBatches = [];
      for (const draft of drafts) {
        if (!draft.policyId) {
          throw new AppError(
            409,
            "INVENTORY_REFILL_POLICY_REQUIRED",
            `Launch quickstart could not find an active policy for ${draft.label.toLowerCase()}.`
          );
        }

        const refillCount = Math.max(1, Number(draft.refillCount ?? 0) || 0);
        const createdBatch = await this.developerCreateCardBatch(token, {
          productCode,
          policyId: draft.policyId,
          count: refillCount,
          prefix: draft.prefix,
          notes: `${draft.notes} | inventory refill ${draft.freshCount}->${draft.targetCount}`
        });

        createdBatches.push({
          key: draft.key,
          mode: draft.mode,
          label: draft.label,
          grantType: draft.grantType,
          count: createdBatch.count,
          batchCode: createdBatch.batchCode,
          prefix: draft.prefix,
          purpose: draft.purpose,
          refillCount,
          beforeFresh: draft.freshCount,
          targetCount: draft.targetCount
        });
      }

      const after = await collectState();
      const followUp = buildLaunchQuickstartFollowUpPlan({
        product,
        policies: after.activePolicies,
        metrics: {
          policies: after.activePolicies.length,
          cardsFresh: after.freshCards.length,
          cardsRedeemed: Math.max(0, after.cards.length - after.freshCards.length),
          accounts: 0,
          activeEntitlements: 0,
          cards: after.cards
        },
        operation: "restock"
      });

      auditDeveloperSession(db, session, "license.quickstart.restock", "product", product.id, {
        productCode,
        requestedMode,
        createdBatchCodes: createdBatches.map((item) => item.batchCode),
        beforeFreshCards: before.freshCards.length,
        afterFreshCards: after.freshCards.length
      });

      return {
        productCode,
        productName: product.name,
        modeSummary: buildLaunchAuthorizationModeSummary(featureConfig),
        requestedMode,
        createdBatches,
        inventoryStates: recommendedStates.map((item) => ({
          key: item.key,
          mode: item.mode,
          label: item.label,
          status: item.inventoryStatus,
          freshCount: item.freshCount,
          targetCount: item.targetCount,
          refillCount: item.refillCount
        })),
        before: {
          counts: {
            policies: before.activePolicies.length,
            freshCards: before.freshCards.length
          }
        },
        after: {
          counts: {
            policies: after.activePolicies.length,
            freshCards: after.freshCards.length
          }
        },
        followUp,
        message: createdBatches.length
          ? `Inventory refill created ${createdBatches.map((item) => item.batchCode).join(", ")} for ${productCode}.`
          : `Inventory refill found no low starter batches for ${productCode}.`
      };
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

    async clientStartupBootstrap(reqLike, body, rawBody) {
      const product = await requireSignedProduct(db, store, config, stateStore, reqLike, rawBody);
      requireField(body, "clientVersion");
      requireSignedProductCodeMatch(product, body);

      const featureConfig = resolveProductFeatureConfig(db, product);
      const clientVersion = String(body.clientVersion).trim();
      const channel = body.channel ? String(body.channel).trim() : "stable";
      const includeTokenKeys = body.includeTokenKeys !== false;
      const versionManifest = featureConfig.allowVersionCheck
        ? await buildVersionManifest(db, store, product, clientVersion, channel)
        : buildDisabledVersionManifest(product, clientVersion, channel);
      const notices = featureConfig.allowNotices
        ? {
            productCode: product.code,
            channel: normalizeNoticeChannel(channel, "stable"),
            enabled: true,
            status: "enabled",
            message: "Active notices loaded.",
            notices: await activeNoticesForProduct(db, store, product.id, channel)
          }
        : buildDisabledNoticeManifest(product, channel);
      const tokenKeys = includeTokenKeys ? this.tokenKeys() : null;
      const activeTokenKey = includeTokenKeys
        ? (
            tokenKeys.keys.find((entry) => entry.keyId === tokenKeys.activeKeyId) || this.tokenKey()
          )
        : this.tokenKey();

      return buildClientStartupBootstrapPayload({
        product,
        clientVersion,
        channel,
        versionManifest,
        notices,
        activeTokenKey,
        tokenKeys,
        hasTokenKeys: includeTokenKeys
      });
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
