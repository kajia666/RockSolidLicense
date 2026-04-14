import { AppError } from "../http.js";
import { generateId, nowIso } from "../security.js";
import {
  formatPolicyRow,
  normalizeBindMode,
  normalizeGrantType,
  parseBindFieldsInput
} from "./policy-repository.js";

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

function resolvePolicyField(policy, snakeCaseKey, camelCaseKey, fallbackValue = undefined) {
  if (policy && policy[snakeCaseKey] !== undefined) {
    return policy[snakeCaseKey];
  }
  if (policy && camelCaseKey && policy[camelCaseKey] !== undefined) {
    return policy[camelCaseKey];
  }
  return fallbackValue;
}

async function loadPolicyRow(adapter, policyId) {
  const rows = await Promise.resolve(adapter.query(
    `
      SELECT p.*, pr.code AS product_code, pr.name AS product_name, pr.owner_developer_id,
             pbc.bind_fields_json,
             puc.allow_client_unbind, puc.client_unbind_limit, puc.client_unbind_window_days,
             puc.client_unbind_deduct_days,
             pgc.grant_type, pgc.grant_points
      FROM policies p
      JOIN products pr ON pr.id = p.product_id
      LEFT JOIN policy_bind_configs pbc ON pbc.policy_id = p.id
      LEFT JOIN policy_unbind_configs puc ON puc.policy_id = p.id
      LEFT JOIN policy_grant_configs pgc ON pgc.policy_id = p.id
      WHERE p.id = $1
      LIMIT 1
    `,
    [policyId],
    {
      repository: "policies",
      operation: "loadPolicyRow",
      policyId
    }
  ));

  return rows[0] ? formatPolicyRow(rows[0]) : null;
}

async function persistPolicyBindConfig(adapter, policyId, bindMode, bindFields, timestamp) {
  await Promise.resolve(adapter.query(
    `
      INSERT INTO policy_bind_configs (policy_id, bind_mode, bind_fields_json, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT(policy_id) DO UPDATE SET
        bind_mode = EXCLUDED.bind_mode,
        bind_fields_json = EXCLUDED.bind_fields_json,
        updated_at = EXCLUDED.updated_at
    `,
    [policyId, bindMode, JSON.stringify(parseBindFieldsInput(bindFields, bindMode)), timestamp, timestamp],
    {
      repository: "policies",
      operation: "persistPolicyBindConfig",
      policyId
    }
  ));
}

async function persistPolicyUnbindConfig(adapter, policyId, body = {}, timestamp) {
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

  await Promise.resolve(adapter.query(
    `
      INSERT INTO policy_unbind_configs
      (
        policy_id, allow_client_unbind, client_unbind_limit, client_unbind_window_days,
        client_unbind_deduct_days, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT(policy_id) DO UPDATE SET
        allow_client_unbind = EXCLUDED.allow_client_unbind,
        client_unbind_limit = EXCLUDED.client_unbind_limit,
        client_unbind_window_days = EXCLUDED.client_unbind_window_days,
        client_unbind_deduct_days = EXCLUDED.client_unbind_deduct_days,
        updated_at = EXCLUDED.updated_at
    `,
    [
      policyId,
      config.allowClientUnbind,
      config.clientUnbindLimit,
      config.clientUnbindWindowDays,
      config.clientUnbindDeductDays,
      timestamp,
      timestamp
    ],
    {
      repository: "policies",
      operation: "persistPolicyUnbindConfig",
      policyId
    }
  ));

  return config;
}

async function persistPolicyGrantConfig(adapter, policyId, body = {}, timestamp) {
  const config = {
    grantType: normalizeGrantType(body.grantType ?? "duration"),
    grantPoints: normalizeNonNegativeInteger(body.grantPoints, "grantPoints", 0, 1000000)
  };

  if (config.grantType === "points" && config.grantPoints < 1) {
    throw new AppError(400, "INVALID_GRANT_POINTS", "grantPoints must be at least 1 for points policies.");
  }

  await Promise.resolve(adapter.query(
    `
      INSERT INTO policy_grant_configs (policy_id, grant_type, grant_points, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT(policy_id) DO UPDATE SET
        grant_type = EXCLUDED.grant_type,
        grant_points = EXCLUDED.grant_points,
        updated_at = EXCLUDED.updated_at
    `,
    [policyId, config.grantType, config.grantPoints, timestamp, timestamp],
    {
      repository: "policies",
      operation: "persistPolicyGrantConfig",
      policyId
    }
  ));

  return config;
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
    policy.maxDevices <= 0
    || policy.heartbeatIntervalSeconds <= 0
    || policy.heartbeatTimeoutSeconds <= 0
    || policy.tokenTtlSeconds <= 0
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

  return { policy, grantType, grantPoints };
}

export function createPostgresPolicyStore(adapter) {
  if (!adapter || typeof adapter.withTransaction !== "function") {
    return {};
  }

  return {
    async createPolicy(product, body = {}, timestamp = nowIso()) {
      if (body.name === undefined || body.name === null || String(body.name).trim() === "") {
        throw new AppError(400, "FIELD_REQUIRED", "name is required.");
      }

      return adapter.withTransaction(async (tx) => {
        const { policy } = normalizeBasePolicyInput(body);
        await Promise.resolve(tx.query(
          `
            INSERT INTO policies
            (
              id, product_id, name, duration_days, max_devices, allow_concurrent_sessions, heartbeat_interval_seconds,
              heartbeat_timeout_seconds, token_ttl_seconds, bind_mode, status, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          `,
          [
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
          ],
          {
            repository: "policies",
            operation: "createPolicy",
            policyId: policy.id
          }
        ));

        await persistPolicyBindConfig(tx, policy.id, policy.bindMode, policy.bindFields, timestamp);
        await persistPolicyUnbindConfig(tx, policy.id, body, timestamp);
        await persistPolicyGrantConfig(tx, policy.id, body, timestamp);

        return loadPolicyRow(tx, policy.id);
      });
    },

    async updatePolicyRuntimeConfig(policy, body = {}, timestamp = nowIso()) {
      const policyId = resolvePolicyField(policy, "id", "id");
      return adapter.withTransaction(async (tx) => {
        const currentPolicy = await loadPolicyRow(tx, policyId);
        if (!currentPolicy) {
          throw new AppError(404, "POLICY_NOT_FOUND", "Policy does not exist.");
        }

        const nextBindMode = body.bindMode !== undefined
          ? normalizeBindMode(body.bindMode)
          : resolvePolicyField(currentPolicy, "bind_mode", "bindMode", "strict");
        const currentBindFields = resolvePolicyField(currentPolicy, "bind_fields", "bindFields", ["deviceFingerprint"]);
        const nextBindFields = body.bindFields !== undefined
          ? parseBindFieldsInput(body.bindFields, nextBindMode)
          : currentBindFields;
        const allowConcurrentSessions = parseOptionalBoolean(body.allowConcurrentSessions, "allowConcurrentSessions");
        const currentAllowConcurrentSessions = resolvePolicyField(
          currentPolicy,
          "allow_concurrent_sessions",
          "allowConcurrentSessions",
          true
        );
        const nextAllowConcurrentSessions = allowConcurrentSessions === null
          ? (currentAllowConcurrentSessions ? 1 : 0)
          : allowConcurrentSessions ? 1 : 0;

        await Promise.resolve(tx.query(
          `
            UPDATE policies
            SET allow_concurrent_sessions = $1, bind_mode = $2, updated_at = $3
            WHERE id = $4
          `,
          [nextAllowConcurrentSessions, nextBindMode, timestamp, policyId],
          {
            repository: "policies",
            operation: "updatePolicyRuntimeConfig",
            policyId
          }
        ));

        await persistPolicyBindConfig(tx, policyId, nextBindMode, nextBindFields, timestamp);
        return loadPolicyRow(tx, policyId);
      });
    },

    async updatePolicyUnbindConfig(policy, body = {}, timestamp = nowIso()) {
      const policyId = resolvePolicyField(policy, "id", "id");
      return adapter.withTransaction(async (tx) => {
        const currentPolicy = await loadPolicyRow(tx, policyId);
        if (!currentPolicy) {
          throw new AppError(404, "POLICY_NOT_FOUND", "Policy does not exist.");
        }

        const nextConfig = {
          allowClientUnbind: body.allowClientUnbind === undefined
            ? resolvePolicyField(currentPolicy, "allow_client_unbind", "allowClientUnbind", false)
            : parseOptionalBoolean(body.allowClientUnbind, "allowClientUnbind"),
          clientUnbindLimit: body.clientUnbindLimit === undefined
            ? resolvePolicyField(currentPolicy, "client_unbind_limit", "clientUnbindLimit", 0)
            : normalizeNonNegativeInteger(body.clientUnbindLimit, "clientUnbindLimit", 0, 1000),
          clientUnbindWindowDays: body.clientUnbindWindowDays === undefined
            ? resolvePolicyField(currentPolicy, "client_unbind_window_days", "clientUnbindWindowDays", 30)
            : Math.max(
                1,
                normalizeNonNegativeInteger(body.clientUnbindWindowDays, "clientUnbindWindowDays", 30, 3650)
              ),
          clientUnbindDeductDays: body.clientUnbindDeductDays === undefined
            ? resolvePolicyField(currentPolicy, "client_unbind_deduct_days", "clientUnbindDeductDays", 0)
            : normalizeNonNegativeInteger(body.clientUnbindDeductDays, "clientUnbindDeductDays", 0, 3650)
        };

        await persistPolicyUnbindConfig(tx, policyId, nextConfig, timestamp);
        return loadPolicyRow(tx, policyId);
      });
    }
  };
}
