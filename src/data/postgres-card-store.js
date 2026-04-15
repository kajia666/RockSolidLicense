import { AppError } from "../http.js";
import { generateId, nowIso, randomCardKey } from "../security.js";
import {
  describeLicenseKeyControl,
  formatCardRow,
  normalizeCardControlStatus
} from "./card-repository.js";

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

async function loadCardRow(adapter, cardId) {
  const rows = await Promise.resolve(adapter.query(
    `
      SELECT lk.*, pr.code AS product_code, pr.name AS product_name,
             pol.name AS policy_name,
             pgc.grant_type, pgc.grant_points,
             a.username AS redeemed_username,
             lkc.status AS control_status, lkc.expires_at, lkc.notes AS control_notes,
             e.id AS entitlement_id, e.status AS entitlement_status, e.ends_at AS entitlement_ends_at,
             r.id AS reseller_id, r.code AS reseller_code, r.name AS reseller_name
      FROM license_keys lk
      JOIN products pr ON pr.id = lk.product_id
      JOIN policies pol ON pol.id = lk.policy_id
      LEFT JOIN policy_grant_configs pgc ON pgc.policy_id = pol.id
      LEFT JOIN customer_accounts a ON a.id = lk.redeemed_by_account_id
      LEFT JOIN license_key_controls lkc ON lkc.license_key_id = lk.id
      LEFT JOIN entitlements e ON e.source_license_key_id = lk.id
      LEFT JOIN reseller_inventory ri ON ri.license_key_id = lk.id AND ri.status = 'active'
      LEFT JOIN resellers r ON r.id = ri.reseller_id
      WHERE lk.id = $1
      ORDER BY lk.issued_at DESC, lk.id DESC
      LIMIT 1
    `,
    [cardId],
    {
      repository: "cards",
      operation: "loadCardRow",
      cardId
    }
  ));

  const row = rows[0] ?? null;
  return row ? formatCardRow({
    ...row,
    status: row.status,
    notes: row.control_notes ?? row.notes
  }) : null;
}

async function upsertLicenseKeyControl(adapter, licenseKeyId, payload = {}, timestamp = nowIso()) {
  const status = normalizeCardControlStatus(payload.status ?? "active");
  const expiresAt = normalizeOptionalIsoDate(payload.expiresAt, "expiresAt");
  const notes = normalizeOptionalText(payload.notes, 1000) || null;
  const existingRows = await Promise.resolve(adapter.query(
    `
      SELECT license_key_id, status, expires_at, notes, created_at, updated_at
      FROM license_key_controls
      WHERE license_key_id = $1
      LIMIT 1
    `,
    [licenseKeyId],
    {
      repository: "cards",
      operation: "loadCardControl",
      cardId: licenseKeyId
    }
  ));

  await Promise.resolve(adapter.query(
    `
      INSERT INTO license_key_controls
      (license_key_id, status, expires_at, notes, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT(license_key_id) DO UPDATE SET
        status = EXCLUDED.status,
        expires_at = EXCLUDED.expires_at,
        notes = EXCLUDED.notes,
        updated_at = EXCLUDED.updated_at
    `,
    [
      licenseKeyId,
      status,
      expiresAt,
      notes,
      existingRows[0]?.created_at ?? timestamp,
      timestamp
    ],
    {
      repository: "cards",
      operation: "upsertCardControl",
      cardId: licenseKeyId
    }
  ));

  return describeLicenseKeyControl({ status, expires_at: expiresAt, notes }, timestamp);
}

export function createPostgresCardStore(adapter) {
  if (!adapter || typeof adapter.withTransaction !== "function") {
    return {};
  }

  return {
    async createCardBatch(product, policy, body = {}, timestamp = nowIso()) {
      const count = Number(body.count ?? 1);
      if (!Number.isInteger(count) || count < 1 || count > 5000) {
        throw new AppError(400, "INVALID_BATCH_SIZE", "Batch count must be between 1 and 5000.");
      }

      const prefix = String(body.prefix ?? String(product.code ?? "").slice(0, 6))
        .replace(/[^A-Z0-9]/gi, "")
        .toUpperCase();
      const batchCode = String(body.batchCode ?? `BATCH-${Date.now()}`).trim() || `BATCH-${Date.now()}`;
      const expiresAt = normalizeOptionalIsoDate(body.expiresAt, "expiresAt");
      const notes = normalizeOptionalText(body.notes, 1000);
      const includeIssuedEntries = Boolean(body.includeIssuedEntries);

      return adapter.withTransaction(async (tx) => {
        const issued = [];
        for (let index = 0; index < count; index += 1) {
          const licenseKeyId = generateId("card");
          const cardKey = randomCardKey(prefix);
          await Promise.resolve(tx.query(
            `
              INSERT INTO license_keys
              (id, product_id, policy_id, card_key, batch_code, status, notes, issued_at)
              VALUES ($1, $2, $3, $4, $5, 'fresh', $6, $7)
            `,
            [
              licenseKeyId,
              product.id,
              policy.id,
              cardKey,
              batchCode,
              notes || null,
              timestamp
            ],
            {
              repository: "cards",
              operation: "createCard",
              cardId: licenseKeyId
            }
          ));
          issued.push({
            licenseKeyId,
            cardKey
          });
        }

        if (expiresAt) {
          for (const entry of issued) {
            await upsertLicenseKeyControl(tx, entry.licenseKeyId, {
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
          keys: issued.map((entry) => entry.cardKey),
          ...(includeIssuedEntries ? { issued } : {})
        };
      });
    },

    async updateCardStatus(cardId, body = {}, timestamp = nowIso()) {
      return adapter.withTransaction(async (tx) => {
        const card = await loadCardRow(tx, cardId);
        if (!card) {
          throw new AppError(404, "CARD_NOT_FOUND", "Card key does not exist.");
        }

        const control = await upsertLicenseKeyControl(tx, card.id, {
          status: body.status ?? "active",
          expiresAt: body.expiresAt,
          notes: body.notes
        }, timestamp);

        return {
          control,
          card: await loadCardRow(tx, card.id)
        };
      });
    }
  };
}
