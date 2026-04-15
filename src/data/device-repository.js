import { AppError } from "../http.js";
export {
  appendPostgresInCondition,
  appendSqliteInCondition,
  escapeLikeText,
  likeFilter
} from "./query-helpers.js";

function makeSqlPlaceholders(count) {
  return Array.from({ length: Math.max(0, Number(count) || 0) }, () => "?").join(", ");
}

function makePostgresPlaceholders(startIndex, count) {
  return Array.from({ length: Math.max(0, Number(count) || 0) }, (_, index) => `$${startIndex + index}`).join(", ");
}

export function safeParseJson(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function formatBindingRow(row) {
  return {
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
    matchFields: safeParseJson(row.match_fields_json, []),
    identity: safeParseJson(row.identity_json, {}),
    bindRequestIp: row.request_ip ?? null,
    activeSessionCount: Number(row.active_session_count ?? 0)
  };
}

export function formatBindingQueryRow(row) {
  return {
    ...row,
    matchFields: safeParseJson(row.match_fields_json, []),
    identity: safeParseJson(row.identity_json, {}),
    bindRequestIp: row.bind_request_ip ?? null,
    activeSessionCount: Number(row.active_session_count ?? 0)
  };
}

export function formatDeviceBlockQueryRow(row) {
  return {
    ...row,
    deviceId: row.device_id ?? null,
    deviceName: row.device_name ?? null,
    lastSeenAt: row.last_seen_at ?? null,
    lastSeenIp: row.last_seen_ip ?? null,
    activeSessionCount: Number(row.active_session_count ?? 0)
  };
}

export function normalizeBindingStatus(value, fieldName = "status") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!["active", "revoked"].includes(normalized)) {
    const message = fieldName === "status"
      ? "Binding status must be active or revoked."
      : `${fieldName} must be active or revoked.`;
    throw new AppError(400, "INVALID_BINDING_STATUS", message);
  }
  return normalized;
}

export function normalizeDeviceBlockStatus(value, fieldName = "status") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!["active", "released"].includes(normalized)) {
    const message = fieldName === "status"
      ? "Device block status must be active or released."
      : `${fieldName} must be active or released.`;
    throw new AppError(400, "INVALID_DEVICE_BLOCK_STATUS", message);
  }
  return normalized;
}

export function normalizeDeviceBindingFilters(filters = {}) {
  return {
    productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
    username: filters.username ? String(filters.username).trim() : null,
    status: filters.status ? normalizeBindingStatus(filters.status) : null,
    search: filters.search ? String(filters.search).trim() : null
  };
}

export function normalizeDeviceBlockFilters(filters = {}) {
  return {
    productCode: filters.productCode ? String(filters.productCode).trim().toUpperCase() : null,
    status: filters.status ? normalizeDeviceBlockStatus(filters.status) : null,
    search: filters.search ? String(filters.search).trim() : null
  };
}
