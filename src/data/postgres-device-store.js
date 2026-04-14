import { addDays, generateId, nowIso } from "../security.js";

async function loadBindingRecord(tx, bindingId) {
  const rows = await Promise.resolve(tx.query(
    `
      SELECT *
      FROM device_bindings
      WHERE id = $1
      LIMIT 1
    `,
    [bindingId],
    {
      repository: "devices",
      operation: "loadBindingRecordById",
      bindingId
    }
  ));

  return rows[0] ?? null;
}

async function loadEntitlementUnbindLog(tx, logId) {
  const rows = await Promise.resolve(tx.query(
    `
      SELECT *
      FROM entitlement_unbind_logs
      WHERE id = $1
      LIMIT 1
    `,
    [logId],
    {
      repository: "devices",
      operation: "loadEntitlementUnbindLog",
      logId
    }
  ));

  return rows[0] ?? null;
}

export function createPostgresDeviceStore(adapter) {
  if (!adapter || typeof adapter.withTransaction !== "function") {
    return {};
  }

  return {
    async releaseBinding(bindingId, timestamp = nowIso()) {
      return adapter.withTransaction(async (tx) => {
        await Promise.resolve(tx.query(
          `
            UPDATE device_bindings
            SET status = 'revoked', revoked_at = $1, last_bound_at = $2
            WHERE id = $3
          `,
          [timestamp, timestamp, bindingId],
          {
            repository: "devices",
            operation: "releaseBinding",
            bindingId
          }
        ));

        return loadBindingRecord(tx, bindingId);
      });
    },

    async countRecentClientUnbinds(_db, entitlementId, windowDays, referenceTime = nowIso()) {
      const since = addDays(referenceTime, -Math.max(1, Number(windowDays ?? 1)));
      const rows = await Promise.resolve(adapter.query(
        `
          SELECT COUNT(*) AS count
          FROM entitlement_unbind_logs
          WHERE entitlement_id = $1
            AND actor_type = 'client'
            AND created_at >= $2
        `,
        [entitlementId, since],
        {
          repository: "devices",
          operation: "countRecentClientUnbinds",
          entitlementId,
          since
        }
      ));

      return Number(rows[0]?.count ?? 0);
    },

    async recordEntitlementUnbind(entitlementId, bindingId, actorType, actorId, reason, deductedDays, timestamp = nowIso()) {
      return adapter.withTransaction(async (tx) => {
        const logId = generateId("unbind");
        await Promise.resolve(tx.query(
          `
            INSERT INTO entitlement_unbind_logs
            (id, entitlement_id, binding_id, actor_type, actor_id, reason, deducted_days, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [logId, entitlementId, bindingId, actorType, actorId, reason, deductedDays, timestamp],
          {
            repository: "devices",
            operation: "recordEntitlementUnbind",
            logId,
            entitlementId,
            bindingId
          }
        ));

        return loadEntitlementUnbindLog(tx, logId);
      });
    }
  };
}
