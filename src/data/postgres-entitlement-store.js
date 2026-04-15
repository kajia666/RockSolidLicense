import { AppError } from "../http.js";
import { addDays, generateId, nowIso } from "../security.js";
import { normalizeEntitlementStatus } from "./entitlement-repository.js";
import { normalizeGrantType } from "./policy-repository.js";

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

function normalizePointAdjustMode(value = "add") {
  const mode = String(value ?? "add").trim().toLowerCase();
  if (!["add", "subtract", "set"].includes(mode)) {
    throw new AppError(400, "INVALID_POINT_ADJUST_MODE", "mode must be add, subtract, or set.");
  }
  return mode;
}

function defaultPointsEntitlementEndsAt(referenceTime = nowIso()) {
  return addDays(referenceTime, 36500);
}

function getCardField(card, camelKey, snakeKey = camelKey) {
  return card?.[camelKey] ?? card?.[snakeKey] ?? null;
}

function getEntitlementField(entitlement, camelKey, snakeKey = camelKey) {
  return entitlement?.[camelKey] ?? entitlement?.[snakeKey] ?? null;
}

async function loadLatestEntitlementEndsAtByPolicy(adapter, accountId, productId, policyId) {
  const rows = await Promise.resolve(adapter.query(
    `
      SELECT ends_at
      FROM entitlements
      WHERE account_id = $1 AND product_id = $2 AND policy_id = $3
      ORDER BY ends_at DESC
      LIMIT 1
    `,
    [accountId, productId, policyId],
    {
      repository: "entitlements",
      operation: "loadLatestEntitlementEndsAtByPolicy",
      accountId,
      productId,
      policyId
    }
  ));

  return rows[0]?.ends_at ?? null;
}

async function loadEntitlementMetering(adapter, entitlementId) {
  const rows = await Promise.resolve(adapter.query(
    `
      SELECT entitlement_id, grant_type, total_points, remaining_points, consumed_points, created_at, updated_at
      FROM entitlement_metering
      WHERE entitlement_id = $1
      LIMIT 1
    `,
    [entitlementId],
    {
      repository: "entitlements",
      operation: "loadEntitlementMetering",
      entitlementId
    }
  ));

  return rows[0] ?? null;
}

async function loadEntitlementManageRow(adapter, entitlementId) {
  const rows = await Promise.resolve(adapter.query(
    `
      SELECT e.*, pr.code AS product_code, pr.name AS product_name,
             a.username, pol.name AS policy_name, lk.card_key
      FROM entitlements e
      JOIN products pr ON pr.id = e.product_id
      JOIN customer_accounts a ON a.id = e.account_id
      JOIN policies pol ON pol.id = e.policy_id
      JOIN license_keys lk ON lk.id = e.source_license_key_id
      WHERE e.id = $1
      LIMIT 1
    `,
    [entitlementId],
    {
      repository: "entitlements",
      operation: "loadEntitlementManageRow",
      entitlementId
    }
  ));

  return rows[0] ?? null;
}

async function loadPointEntitlementForAdmin(adapter, entitlementId) {
  const rows = await Promise.resolve(adapter.query(
    `
      SELECT e.id, e.status, e.ends_at, e.account_id,
             pr.code AS product_code, pr.name AS product_name,
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
      WHERE e.id = $1
      LIMIT 1
    `,
    [entitlementId],
    {
      repository: "entitlements",
      operation: "loadPointEntitlementForAdmin",
      entitlementId
    }
  ));

  return rows[0] ?? null;
}

async function upsertEntitlementMetering(adapter, entitlementId, grantType, totalPoints, remainingPoints, consumedPoints, timestamp) {
  const existing = await loadEntitlementMetering(adapter, entitlementId);

  await Promise.resolve(adapter.query(
    `
      INSERT INTO entitlement_metering
      (entitlement_id, grant_type, total_points, remaining_points, consumed_points, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT(entitlement_id) DO UPDATE SET
        grant_type = EXCLUDED.grant_type,
        total_points = EXCLUDED.total_points,
        remaining_points = EXCLUDED.remaining_points,
        consumed_points = EXCLUDED.consumed_points,
        updated_at = EXCLUDED.updated_at
    `,
    [
      entitlementId,
      grantType,
      totalPoints,
      remainingPoints,
      consumedPoints,
      existing?.created_at ?? timestamp,
      timestamp
    ],
    {
      repository: "entitlements",
      operation: "upsertEntitlementMetering",
      entitlementId
    }
  ));
}

export function createPostgresEntitlementStore(adapter) {
  if (!adapter || typeof adapter.withTransaction !== "function") {
    return {};
  }

  return {
    async activateFreshCardEntitlement(product, account, card, timestamp = nowIso()) {
      return adapter.withTransaction(async (tx) => {
        const policyId = getCardField(card, "policyId", "policy_id");
        const policyName = getCardField(card, "policyName", "policy_name");
        const grantType = normalizeGrantType(getCardField(card, "grantType", "grant_type") ?? "duration");
        const cardId = getCardField(card, "id");
        const cardKey = getCardField(card, "cardKey", "card_key");
        const durationDays = Number(getCardField(card, "durationDays", "duration_days") ?? 0);
        const grantPoints = Number(getCardField(card, "grantPoints", "grant_points") ?? 0);

        let startsAt = timestamp;
        let endsAt = defaultPointsEntitlementEndsAt(timestamp);
        let totalPoints = null;
        let remainingPoints = null;

        if (grantType === "duration") {
          const latestEndsAt = await loadLatestEntitlementEndsAtByPolicy(tx, account.id, product.id, policyId);
          startsAt = latestEndsAt && latestEndsAt > timestamp ? latestEndsAt : timestamp;
          endsAt = addDays(startsAt, durationDays);
        } else {
          totalPoints = grantPoints;
          remainingPoints = totalPoints;
          if (remainingPoints <= 0) {
            throw new AppError(400, "INVALID_GRANT_POINTS", "Point-based policy must grant at least 1 point.");
          }
        }

        const entitlementId = generateId("ent");
        await Promise.resolve(tx.query(
          `
            INSERT INTO entitlements
            (id, product_id, policy_id, account_id, source_license_key_id, status, starts_at, ends_at, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9)
          `,
          [
            entitlementId,
            product.id,
            policyId,
            account.id,
            cardId,
            startsAt,
            endsAt,
            timestamp,
            timestamp
          ],
          {
            repository: "entitlements",
            operation: "createEntitlement",
            entitlementId,
            accountId: account.id,
            productId: product.id,
            cardId
          }
        ));

        if (grantType === "points") {
          await upsertEntitlementMetering(tx, entitlementId, "points", totalPoints, remainingPoints, 0, timestamp);
        }

        await Promise.resolve(tx.query(
          `
            UPDATE license_keys
            SET status = 'redeemed', redeemed_at = $1, redeemed_by_account_id = $2
            WHERE id = $3
          `,
          [timestamp, account.id, cardId],
          {
            repository: "entitlements",
            operation: "markCardRedeemed",
            entitlementId,
            accountId: account.id,
            cardId
          }
        ));

        return {
          entitlementId,
          policyName,
          grantType,
          totalPoints,
          remainingPoints,
          startsAt,
          endsAt,
          cardKey,
          reseller: null
        };
      });
    },

    async consumeEntitlementLoginQuota(entitlement, timestamp = nowIso()) {
      return adapter.withTransaction(async (tx) => {
        const grantType = normalizeGrantType(getEntitlementField(entitlement, "grantType", "grant_type") ?? "duration");
        if (grantType !== "points") {
          return {
            grantType: "duration",
            totalPoints: null,
            remainingPoints: null,
            consumedPoints: null,
            consumedThisLogin: 0
          };
        }

        const entitlementId = getEntitlementField(entitlement, "id");
        const metering = await loadEntitlementMetering(tx, entitlementId);
        if (!metering || Number(metering.remaining_points ?? 0) <= 0) {
          throw new AppError(403, "LICENSE_POINTS_EXHAUSTED", "This authorization has no remaining points.", {
            entitlementId,
            totalPoints: Number(metering?.total_points ?? 0),
            remainingPoints: Number(metering?.remaining_points ?? 0),
            consumedPoints: Number(metering?.consumed_points ?? 0)
          });
        }

        const nextRemaining = Number(metering.remaining_points) - 1;
        const nextConsumed = Number(metering.consumed_points ?? 0) + 1;
        await upsertEntitlementMetering(
          tx,
          entitlementId,
          "points",
          Number(metering.total_points ?? 0),
          nextRemaining,
          nextConsumed,
          timestamp
        );

        return {
          grantType: "points",
          totalPoints: Number(metering.total_points ?? 0),
          remainingPoints: nextRemaining,
          consumedPoints: nextConsumed,
          consumedThisLogin: 1
        };
      });
    },

    async updateEntitlementStatus(entitlementId, body = {}, timestamp = nowIso()) {
      return adapter.withTransaction(async (tx) => {
        const entitlement = await loadEntitlementManageRow(tx, entitlementId);
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

        await Promise.resolve(tx.query(
          `
            UPDATE entitlements
            SET status = $1, updated_at = $2
            WHERE id = $3
          `,
          [nextStatus, timestamp, entitlement.id],
          {
            repository: "entitlements",
            operation: "updateEntitlementStatus",
            entitlementId: entitlement.id
          }
        ));

        return {
          id: entitlement.id,
          productCode: entitlement.product_code,
          username: entitlement.username,
          status: nextStatus,
          changed: true,
          revokedSessions: 0,
          endsAt: entitlement.ends_at,
          updatedAt: timestamp
        };
      });
    },

    async extendEntitlement(entitlementId, body = {}, timestamp = nowIso()) {
      return adapter.withTransaction(async (tx) => {
        const entitlement = await loadEntitlementManageRow(tx, entitlementId);
        if (!entitlement) {
          throw new AppError(404, "ENTITLEMENT_NOT_FOUND", "Entitlement does not exist.");
        }

        const days = Number(body.days ?? body.extendDays ?? 0);
        if (!Number.isInteger(days) || days < 1 || days > 3650) {
          throw new AppError(400, "INVALID_EXTENSION_DAYS", "days must be an integer between 1 and 3650.");
        }

        const baseTime = entitlement.ends_at > timestamp ? entitlement.ends_at : timestamp;
        const endsAt = addDays(baseTime, days);

        await Promise.resolve(tx.query(
          `
            UPDATE entitlements
            SET ends_at = $1, updated_at = $2
            WHERE id = $3
          `,
          [endsAt, timestamp, entitlement.id],
          {
            repository: "entitlements",
            operation: "extendEntitlement",
            entitlementId: entitlement.id
          }
        ));

        return {
          id: entitlement.id,
          productCode: entitlement.product_code,
          productName: entitlement.product_name,
          username: entitlement.username,
          status: entitlement.status,
          previousEndsAt: entitlement.ends_at,
          endsAt,
          addedDays: days,
          updatedAt: timestamp
        };
      });
    },

    async adjustEntitlementPoints(entitlementId, body = {}, timestamp = nowIso(), options = {}) {
      return adapter.withTransaction(async (tx) => {
        const entitlement = await loadPointEntitlementForAdmin(tx, entitlementId);
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

        const strategy = options.totalStrategy === "preserve_total"
          ? "preserve_total"
          : "preserve_consumed";

        let nextConsumedPoints = previous.consumedPoints;
        let nextTotalPoints = previous.consumedPoints + nextRemainingPoints;
        if (strategy === "preserve_total") {
          nextConsumedPoints = Math.max(0, previous.totalPoints - nextRemainingPoints);
          nextTotalPoints = Math.max(previous.totalPoints, nextRemainingPoints + nextConsumedPoints);
        }

        await upsertEntitlementMetering(
          tx,
          entitlement.id,
          "points",
          nextTotalPoints,
          nextRemainingPoints,
          nextConsumedPoints,
          timestamp
        );

        return {
          id: entitlement.id,
          productCode: entitlement.product_code,
          productName: entitlement.product_name,
          username: entitlement.username,
          policyName: entitlement.policy_name,
          status: entitlement.status,
          grantType: "points",
          mode,
          points,
          previous,
          current: {
            totalPoints: nextTotalPoints,
            remainingPoints: nextRemainingPoints,
            consumedPoints: nextConsumedPoints
          },
          activeSessionCount: Number(entitlement.active_session_count ?? 0),
          updatedAt: timestamp
        };
      });
    }
  };
}
