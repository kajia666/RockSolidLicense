import { AppError } from "../http.js";
import { generateId, nowIso } from "../security.js";
import {
  formatNetworkRuleManageRow,
  normalizeNetworkRuleStatus
} from "./network-rule-repository.js";

function normalizeNetworkTargetType(value, pattern) {
  const targetType = String(value ?? (String(pattern ?? "").includes("/") ? "cidr" : "ip"))
    .trim()
    .toLowerCase();
  if (!["ip", "cidr"].includes(targetType)) {
    throw new AppError(400, "INVALID_NETWORK_TARGET_TYPE", "Target type must be ip or cidr.");
  }
  return targetType;
}

function normalizeNetworkActionScope(value) {
  const actionScope = String(value ?? "all").trim().toLowerCase();
  if (!["all", "register", "recharge", "login", "heartbeat"].includes(actionScope)) {
    throw new AppError(400, "INVALID_NETWORK_ACTION_SCOPE", "Action scope is not supported.");
  }
  return actionScope;
}

function normalizeNetworkDecision(value) {
  const decision = String(value ?? "block").trim().toLowerCase();
  if (decision !== "block") {
    throw new AppError(400, "INVALID_NETWORK_DECISION", "Only block rules are supported in this version.");
  }
  return decision;
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

function assertNetworkPattern(targetType, pattern) {
  if (targetType === "ip" && !normalizeIpAddress(pattern)) {
    throw new AppError(400, "INVALID_NETWORK_PATTERN", "IP pattern is invalid.");
  }
  if (targetType === "cidr" && !ipv4CidrMatch(String(pattern).split("/")[0], pattern)) {
    throw new AppError(400, "INVALID_NETWORK_PATTERN", "CIDR pattern must be a valid IPv4 CIDR.");
  }
}

async function loadNetworkRuleRow(adapter, ruleId) {
  const rows = await Promise.resolve(adapter.query(
    `
      SELECT nr.*, pr.code AS product_code, pr.name AS product_name, pr.owner_developer_id
      FROM network_rules nr
      LEFT JOIN products pr ON pr.id = nr.product_id
      WHERE nr.id = $1
      LIMIT 1
    `,
    [ruleId],
    {
      repository: "networkRules",
      operation: "getNetworkRuleRowById",
      ruleId
    }
  ));

  return rows[0] ? formatNetworkRuleManageRow(rows[0]) : null;
}

export function createPostgresNetworkRuleStore(adapter) {
  if (!adapter || typeof adapter.withTransaction !== "function") {
    return {};
  }

  return {
    async createNetworkRule(product = null, body = {}, timestamp = nowIso()) {
      const pattern = String(body.pattern ?? "").trim();
      if (!pattern) {
        throw new AppError(400, "FIELD_REQUIRED", "pattern is required.");
      }

      const targetType = normalizeNetworkTargetType(body.targetType, pattern);
      const actionScope = normalizeNetworkActionScope(body.actionScope);
      const decision = normalizeNetworkDecision(body.decision);
      const status = normalizeNetworkRuleStatus(body.status ?? "active");
      const notes = String(body.notes ?? "").trim() || null;
      assertNetworkPattern(targetType, pattern);

      return adapter.withTransaction(async (tx) => {
        const id = generateId("nrule");
        await Promise.resolve(tx.query(
          `
            INSERT INTO network_rules
            (
              id, product_id, target_type, pattern, action_scope,
              decision, status, notes, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `,
          [
            id,
            product?.id ?? null,
            targetType,
            pattern,
            actionScope,
            decision,
            status,
            notes,
            timestamp,
            timestamp
          ],
          {
            repository: "networkRules",
            operation: "createNetworkRule",
            ruleId: id,
            productId: product?.id ?? null
          }
        ));

        return {
          id,
          productCode: product?.code ?? null,
          targetType,
          pattern,
          actionScope,
          decision,
          status,
          notes
        };
      });
    },

    async updateNetworkRuleStatus(ruleId, body = {}, timestamp = nowIso()) {
      return adapter.withTransaction(async (tx) => {
        const row = await loadNetworkRuleRow(tx, ruleId);
        if (!row) {
          throw new AppError(404, "NETWORK_RULE_NOT_FOUND", "Network rule does not exist.");
        }

        const status = normalizeNetworkRuleStatus(body.status);
        await Promise.resolve(tx.query(
          `
            UPDATE network_rules
            SET status = $1, updated_at = $2
            WHERE id = $3
          `,
          [status, timestamp, row.id],
          {
            repository: "networkRules",
            operation: "updateNetworkRuleStatus",
            ruleId: row.id
          }
        ));

        return {
          id: row.id,
          productCode: row.productCode,
          pattern: row.pattern,
          actionScope: row.actionScope,
          status,
          changed: status !== row.status,
          updatedAt: timestamp
        };
      });
    }
  };
}
