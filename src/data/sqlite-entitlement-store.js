import { AppError } from "../http.js";
import { addDays, nowIso } from "../security.js";
import {
  loadPointEntitlementForAdmin,
  normalizeEntitlementStatus
} from "./entitlement-repository.js";
import { normalizeGrantType } from "./policy-repository.js";

function one(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

function run(db, sql, ...params) {
  return db.prepare(sql).run(...params);
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

function normalizePointAdjustMode(value = "add") {
  const mode = String(value ?? "add").trim().toLowerCase();
  if (!["add", "subtract", "set"].includes(mode)) {
    throw new AppError(400, "INVALID_POINT_ADJUST_MODE", "mode must be add, subtract, or set.");
  }
  return mode;
}

function getEntitlementManageRowById(db, entitlementId) {
  return one(
    db,
    `
      SELECT e.*, pr.code AS product_code, pr.name AS product_name,
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
}

function upsertEntitlementMetering(db, entitlementId, grantType, totalPoints, remainingPoints, consumedPoints, timestamp) {
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
    return;
  }

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

export function createSqliteEntitlementStore({ db }) {
  return {
    updateEntitlementStatus(entitlementId, body = {}, timestamp = nowIso()) {
      const entitlement = getEntitlementManageRowById(db, entitlementId);
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
    },

    extendEntitlement(entitlementId, body = {}, timestamp = nowIso()) {
      const entitlement = getEntitlementManageRowById(db, entitlementId);
      if (!entitlement) {
        throw new AppError(404, "ENTITLEMENT_NOT_FOUND", "Entitlement does not exist.");
      }

      const days = Number(body.days ?? body.extendDays ?? 0);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        throw new AppError(400, "INVALID_EXTENSION_DAYS", "days must be an integer between 1 and 3650.");
      }

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
    },

    adjustEntitlementPoints(entitlementId, body = {}, timestamp = nowIso(), options = {}) {
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

      const strategy = options.totalStrategy === "preserve_total"
        ? "preserve_total"
        : "preserve_consumed";

      let nextConsumedPoints = previous.consumedPoints;
      let nextTotalPoints = previous.consumedPoints + nextRemainingPoints;
      if (strategy === "preserve_total") {
        nextConsumedPoints = Math.max(0, previous.totalPoints - nextRemainingPoints);
        nextTotalPoints = Math.max(previous.totalPoints, nextRemainingPoints + nextConsumedPoints);
      }

      upsertEntitlementMetering(
        db,
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
    }
  };
}
