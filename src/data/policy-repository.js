import { AppError } from "../http.js";

const SUPPORTED_BIND_FIELDS = new Set([
  "deviceFingerprint",
  "machineCode",
  "machineGuid",
  "cpuId",
  "diskSerial",
  "boardSerial",
  "biosSerial",
  "macAddress",
  "installationId",
  "requestIp",
  "localIp",
  "publicIp"
]);

const BIND_FIELD_ALIASES = new Map([
  ["devicefingerprint", "deviceFingerprint"],
  ["fingerprint", "deviceFingerprint"],
  ["machinecode", "machineCode"],
  ["machineguid", "machineGuid"],
  ["cpuid", "cpuId"],
  ["cpuserial", "cpuId"],
  ["diskserial", "diskSerial"],
  ["diskid", "diskSerial"],
  ["boardserial", "boardSerial"],
  ["motherboardserial", "boardSerial"],
  ["biosserial", "biosSerial"],
  ["macaddress", "macAddress"],
  ["mac", "macAddress"],
  ["installationid", "installationId"],
  ["installid", "installationId"],
  ["requestip", "requestIp"],
  ["ip", "requestIp"],
  ["publicip", "publicIp"],
  ["localip", "localIp"]
]);

const DEFAULT_BIND_FIELDS = ["deviceFingerprint"];
const SUPPORTED_BIND_MODES = new Set(["strict", "selected_fields"]);
const SUPPORTED_GRANT_TYPES = new Set(["duration", "points"]);

function one(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

function many(db, sql, ...params) {
  return db.prepare(sql).all(...params);
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

export function normalizeBindMode(value = "strict") {
  const normalized = String(value ?? "strict")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

  if (!SUPPORTED_BIND_MODES.has(normalized)) {
    throw new AppError(
      400,
      "INVALID_BIND_MODE",
      `Bind mode must be one of: ${Array.from(SUPPORTED_BIND_MODES).join(", ")}.`
    );
  }

  return normalized;
}

function normalizeBindFieldName(value) {
  const compact = String(value ?? "")
    .trim()
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();

  if (!compact) {
    return null;
  }

  return BIND_FIELD_ALIASES.get(compact) ?? null;
}

export function parseBindFieldsInput(value, bindMode = "strict") {
  if (bindMode === "strict") {
    return [...DEFAULT_BIND_FIELDS];
  }

  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\n]/)
      : [];

  const fields = [];
  for (const rawValue of rawValues) {
    const normalized = normalizeBindFieldName(rawValue);
    if (!normalized) {
      continue;
    }

    if (!SUPPORTED_BIND_FIELDS.has(normalized)) {
      throw new AppError(400, "INVALID_BIND_FIELD", `Unsupported bind field: ${rawValue}.`);
    }

    if (!fields.includes(normalized)) {
      fields.push(normalized);
    }
  }

  return fields.length ? fields : [...DEFAULT_BIND_FIELDS];
}

export function normalizeGrantType(value = "duration") {
  const grantType = String(value ?? "duration").trim().toLowerCase();
  if (!SUPPORTED_GRANT_TYPES.has(grantType)) {
    throw new AppError(
      400,
      "INVALID_GRANT_TYPE",
      `grantType must be one of: ${Array.from(SUPPORTED_GRANT_TYPES).join(", ")}.`
    );
  }
  return grantType;
}

export function parsePolicyBindConfigRow(row, fallbackBindMode = "strict", fallbackUpdatedAt = null) {
  const bindMode = normalizeBindMode(row?.bind_mode ?? fallbackBindMode);
  const bindFields = parseBindFieldsInput(
    row?.bind_fields_json ? (() => {
      try {
        return JSON.parse(row.bind_fields_json);
      } catch {
        return null;
      }
    })() : null,
    bindMode
  );

  return {
    bindMode,
    bindFields,
    createdAt: row?.created_at ?? fallbackUpdatedAt ?? null,
    updatedAt: row?.updated_at ?? fallbackUpdatedAt ?? null
  };
}

export function parsePolicyUnbindConfigRow(row, fallbackUpdatedAt = null) {
  return {
    allowClientUnbind: Boolean(Number(row?.allow_client_unbind ?? 0)),
    clientUnbindLimit: normalizeNonNegativeInteger(row?.client_unbind_limit ?? 0, "clientUnbindLimit", 0, 1000),
    clientUnbindWindowDays: Math.max(
      1,
      normalizeNonNegativeInteger(row?.client_unbind_window_days ?? 30, "clientUnbindWindowDays", 30, 3650)
    ),
    clientUnbindDeductDays: normalizeNonNegativeInteger(
      row?.client_unbind_deduct_days ?? 0,
      "clientUnbindDeductDays",
      0,
      3650
    ),
    createdAt: row?.created_at ?? fallbackUpdatedAt ?? null,
    updatedAt: row?.updated_at ?? fallbackUpdatedAt ?? null
  };
}

export function parsePolicyGrantConfigRow(row, fallbackUpdatedAt = null) {
  const grantType = normalizeGrantType(row?.grant_type ?? "duration");
  return {
    grantType,
    grantPoints: grantType === "points"
      ? normalizeNonNegativeInteger(row?.grant_points ?? 0, "grantPoints", 0, 1000000)
      : 0,
    createdAt: row?.created_at ?? fallbackUpdatedAt ?? null,
    updatedAt: row?.updated_at ?? fallbackUpdatedAt ?? null
  };
}

export function formatPolicyRow(row) {
  const bindConfig = parsePolicyBindConfigRow(row, row.bind_mode, row.updated_at);
  const unbindConfig = parsePolicyUnbindConfigRow(row, row.updated_at);
  const grantConfig = parsePolicyGrantConfigRow(row, row.updated_at);

  return {
    id: row.id,
    productId: row.product_id,
    productCode: row.product_code,
    productName: row.product_name,
    name: row.name,
    durationDays: Number(row.duration_days),
    maxDevices: Number(row.max_devices),
    allowConcurrentSessions: Boolean(row.allow_concurrent_sessions),
    heartbeatIntervalSeconds: Number(row.heartbeat_interval_seconds),
    heartbeatTimeoutSeconds: Number(row.heartbeat_timeout_seconds),
    tokenTtlSeconds: Number(row.token_ttl_seconds),
    bindMode: bindConfig.bindMode,
    bindFields: bindConfig.bindFields,
    allowClientUnbind: unbindConfig.allowClientUnbind,
    clientUnbindLimit: unbindConfig.clientUnbindLimit,
    clientUnbindWindowDays: unbindConfig.clientUnbindWindowDays,
    clientUnbindDeductDays: unbindConfig.clientUnbindDeductDays,
    grantType: grantConfig.grantType,
    grantPoints: grantConfig.grantPoints,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function queryPolicyRows(db, filters = {}) {
  const conditions = [];
  const params = [];

  if (filters.productCode) {
    conditions.push("pr.code = ?");
    params.push(String(filters.productCode).trim().toUpperCase());
  }
  if (filters.ownerDeveloperId) {
    conditions.push("pr.owner_developer_id = ?");
    params.push(filters.ownerDeveloperId);
  }
  appendInCondition("pr.id", filters.productIds, conditions, params);

  const rows = many(
    db,
    `
      SELECT p.*, pr.code AS product_code, pr.name AS product_name,
             pbc.bind_fields_json,
             puc.allow_client_unbind, puc.client_unbind_limit, puc.client_unbind_window_days,
             puc.client_unbind_deduct_days,
             pgc.grant_type, pgc.grant_points
      FROM policies p
      JOIN products pr ON pr.id = p.product_id
      LEFT JOIN policy_bind_configs pbc ON pbc.policy_id = p.id
      LEFT JOIN policy_unbind_configs puc ON puc.policy_id = p.id
      LEFT JOIN policy_grant_configs pgc ON pgc.policy_id = p.id
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY p.created_at DESC
    `,
    ...params
  );

  return rows.map(formatPolicyRow);
}

export function getPolicyAccessRowById(db, policyId) {
  return one(
    db,
    `
      SELECT p.*, pr.code AS product_code, pr.name AS product_name, pr.owner_developer_id
      FROM policies p
      JOIN products pr ON pr.id = p.product_id
      WHERE p.id = ?
    `,
    policyId
  );
}
