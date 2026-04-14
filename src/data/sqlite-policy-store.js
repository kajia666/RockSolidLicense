import { AppError } from "../http.js";
import { generateId, nowIso } from "../security.js";
import {
  normalizeBindMode,
  normalizeGrantType,
  parseBindFieldsInput,
  parsePolicyGrantConfigRow,
  parsePolicyBindConfigRow,
  parsePolicyUnbindConfigRow
} from "./policy-repository.js";

function one(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

function run(db, sql, ...params) {
  return db.prepare(sql).run(...params);
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

function normalizeBasePolicyInput(body = {}) {
  const grantType = normalizeGrantType(body.grantType ?? "duration");
  const grantPoints = normalizeNonNegativeInteger(body.grantPoints, "grantPoints", 0, 1000000);
  const policy = {
    id: generateId("pol"),
    name: String(body.name).trim(),
    durationDays: Number(body.durationDays ?? (grantType === "duration" ? 30 : 0)),
    maxDevices: Number(body.maxDevices ?? 1),
    allowConcurrentSessions: parseOptionalBoolean(body.allowConcurrentSessions, "allowConcurrentSessions") === false ? 0 : 1,
    heartbeatIntervalSeconds: Number(body.heartbeatIntervalSeconds ?? 60),
    heartbeatTimeoutSeconds: Number(body.heartbeatTimeoutSeconds ?? 180),
    tokenTtlSeconds: Number(body.tokenTtlSeconds ?? 300),
    bindMode: normalizeBindMode(body.bindMode ?? "strict"),
    bindFields: parseBindFieldsInput(body.bindFields, normalizeBindMode(body.bindMode ?? "strict")),
    status: "active"
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

  return {
    policy,
    grantType,
    grantPoints
  };
}

export function createSqlitePolicyStore({ db }) {
  return {
    createPolicy(product, body = {}, timestamp = nowIso()) {
      if (body.name === undefined || body.name === null || String(body.name).trim() === "") {
        throw new AppError(400, "FIELD_REQUIRED", "name is required.");
      }

      const { policy, grantType, grantPoints } = normalizeBasePolicyInput(body);

      run(
        db,
        `
          INSERT INTO policies
          (id, product_id, name, duration_days, max_devices, allow_concurrent_sessions, heartbeat_interval_seconds,
           heartbeat_timeout_seconds, token_ttl_seconds, bind_mode, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        policy.id,
        product.id,
        policy.name,
        policy.durationDays,
        policy.maxDevices,
        policy.allowConcurrentSessions,
        policy.heartbeatIntervalSeconds,
        policy.heartbeatTimeoutSeconds,
        policy.tokenTtlSeconds,
        policy.bindMode,
        policy.status,
        timestamp,
        timestamp
      );

      persistPolicyBindConfig(db, policy.id, policy.bindMode, policy.bindFields, timestamp);
      persistPolicyUnbindConfig(db, policy.id, body, timestamp);
      persistPolicyGrantConfig(db, policy.id, { grantType, grantPoints }, timestamp);

      return {
        id: policy.id,
        productId: product.id,
        productCode: product.code,
        productName: product.name,
        name: policy.name,
        durationDays: policy.durationDays,
        maxDevices: policy.maxDevices,
        allowConcurrentSessions: Boolean(policy.allowConcurrentSessions),
        heartbeatIntervalSeconds: policy.heartbeatIntervalSeconds,
        heartbeatTimeoutSeconds: policy.heartbeatTimeoutSeconds,
        tokenTtlSeconds: policy.tokenTtlSeconds,
        bindMode: policy.bindMode,
        bindFields: policy.bindFields,
        status: policy.status,
        createdAt: timestamp,
        updatedAt: timestamp,
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
          created_at: timestamp,
          updated_at: timestamp
        }),
        ...parsePolicyGrantConfigRow({
          grant_type: grantType,
          grant_points: grantPoints,
          created_at: timestamp,
          updated_at: timestamp
        })
      };
    },

    updatePolicyRuntimeConfig(policy, body = {}, timestamp = nowIso()) {
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

    updatePolicyUnbindConfig(policy, body = {}, timestamp = nowIso()) {
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

      persistPolicyUnbindConfig(db, policy.id, nextConfig, timestamp);

      return {
        id: policy.id,
        productId: policy.product_id,
        productCode: policy.product_code,
        productName: policy.product_name,
        name: policy.name,
        ...nextConfig,
        updatedAt: timestamp
      };
    }
  };
}
