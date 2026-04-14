import { AppError } from "../http.js";
import { generateId, nowIso, randomCardKey } from "../security.js";
import {
  describeLicenseKeyControl,
  getCardRowById,
  normalizeCardControlStatus
} from "./card-repository.js";

function one(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

function run(db, sql, ...params) {
  return db.prepare(sql).run(...params);
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

function issueLicenseKeys(db, { productId, policyId, prefix, count, batchCode, notes, issuedAt }) {
  const created = [];
  for (let index = 0; index < count; index += 1) {
    const licenseKeyId = generateId("card");
    const cardKey = randomCardKey(prefix);
    run(
      db,
      `
        INSERT INTO license_keys
        (id, product_id, policy_id, card_key, batch_code, status, notes, issued_at)
        VALUES (?, ?, ?, ?, ?, 'fresh', ?, ?)
      `,
      licenseKeyId,
      productId,
      policyId,
      cardKey,
      batchCode,
      notes,
      issuedAt
    );
    created.push({
      licenseKeyId,
      cardKey
    });
  }
  return created;
}

function upsertLicenseKeyControl(db, licenseKeyId, payload = {}, timestamp = nowIso()) {
  const status = normalizeCardControlStatus(payload.status ?? "active");
  const expiresAt = normalizeOptionalIsoDate(payload.expiresAt, "expiresAt");
  const notes = normalizeOptionalText(payload.notes, 1000) || null;
  const existing = one(db, "SELECT license_key_id FROM license_key_controls WHERE license_key_id = ?", licenseKeyId);

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
      timestamp,
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
      timestamp,
      timestamp
    );
  }

  return describeLicenseKeyControl({ status, expires_at: expiresAt, notes }, timestamp);
}

export function createSqliteCardStore({ db }) {
  return {
    createCardBatch(product, policy, body = {}, timestamp = nowIso()) {
      const count = Number(body.count ?? 1);
      if (!Number.isInteger(count) || count < 1 || count > 5000) {
        throw new AppError(400, "INVALID_BATCH_SIZE", "Batch count must be between 1 and 5000.");
      }

      const prefix = String(body.prefix ?? String(product.code ?? "").slice(0, 6))
        .replace(/[^A-Z0-9]/gi, "")
        .toUpperCase();
      const batchCode = `BATCH-${Date.now()}`;
      const expiresAt = normalizeOptionalIsoDate(body.expiresAt, "expiresAt");
      const notes = normalizeOptionalText(body.notes, 1000);

      const issued = issueLicenseKeys(db, {
        productId: product.id,
        policyId: policy.id,
        prefix,
        count,
        batchCode,
        notes,
        issuedAt: timestamp
      });

      if (expiresAt) {
        for (const entry of issued) {
          upsertLicenseKeyControl(db, entry.licenseKeyId, {
            status: "active",
            expiresAt,
            notes
          }, timestamp);
        }
      }

      return {
        batchCode,
        count,
        expiresAt,
        preview: issued.slice(0, 10).map((entry) => entry.cardKey),
        keys: issued.map((entry) => entry.cardKey)
      };
    },

    updateCardStatus(cardId, body = {}, timestamp = nowIso()) {
      const card = one(
        db,
        `
          SELECT id
          FROM license_keys
          WHERE id = ?
        `,
        cardId
      );

      if (!card) {
        throw new AppError(404, "CARD_NOT_FOUND", "Card key does not exist.");
      }

      const control = upsertLicenseKeyControl(db, card.id, {
        status: body.status ?? "active",
        expiresAt: body.expiresAt,
        notes: body.notes
      }, timestamp);

      return {
        control,
        card: getCardRowById(db, card.id)
      };
    }
  };
}
