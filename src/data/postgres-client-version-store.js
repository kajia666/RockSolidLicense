import { AppError } from "../http.js";
import { generateId, nowIso } from "../security.js";
import {
  formatClientVersionManageRow,
  normalizeChannel,
  normalizeClientVersionStatus
} from "./client-version-repository.js";

function parseForceUpdate(value, fallback = 0) {
  if (value === undefined) {
    return fallback ? 1 : 0;
  }
  return value === true || value === 1 || value === "true" ? 1 : 0;
}

function normalizeVersionValue(value) {
  const version = String(value ?? "").trim();
  if (!version) {
    throw new AppError(400, "FIELD_REQUIRED", "version is required.");
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/.test(version)) {
    throw new AppError(
      400,
      "INVALID_CLIENT_VERSION",
      "Version must be 1-32 chars using letters, digits, dot, underscore, or hyphen."
    );
  }
  return version;
}

async function loadClientVersionRow(adapter, versionId) {
  const rows = await Promise.resolve(adapter.query(
    `
      SELECT v.*, pr.code AS product_code, pr.name AS product_name, pr.owner_developer_id
      FROM client_versions v
      JOIN products pr ON pr.id = v.product_id
      WHERE v.id = $1
      LIMIT 1
    `,
    [versionId],
    {
      repository: "versions",
      operation: "getClientVersionRowById",
      versionId
    }
  ));

  return rows[0] ? formatClientVersionManageRow(rows[0]) : null;
}

export function createPostgresClientVersionStore(adapter) {
  if (!adapter || typeof adapter.withTransaction !== "function") {
    return {};
  }

  return {
    async createClientVersion(product, body = {}, timestamp = nowIso()) {
      const version = normalizeVersionValue(body.version);
      const channel = normalizeChannel(body.channel);
      const status = normalizeClientVersionStatus(body.status ?? "active");
      const forceUpdate = parseForceUpdate(body.forceUpdate);
      const downloadUrl = String(body.downloadUrl ?? "").trim() || null;
      const releaseNotes = String(body.releaseNotes ?? "").trim() || null;
      const noticeTitle = String(body.noticeTitle ?? "").trim() || null;
      const noticeBody = String(body.noticeBody ?? "").trim() || null;
      const releasedAt = body.releasedAt ? new Date(body.releasedAt).toISOString() : timestamp;

      return adapter.withTransaction(async (tx) => {
        const existing = await Promise.resolve(tx.query(
          `
            SELECT id
            FROM client_versions
            WHERE product_id = $1 AND channel = $2 AND version = $3
            LIMIT 1
          `,
          [product.id, channel, version],
          {
            repository: "versions",
            operation: "assertClientVersionAvailable",
            productId: product.id,
            channel,
            version
          }
        ));
        if (existing[0]) {
          throw new AppError(409, "CLIENT_VERSION_EXISTS", "This version already exists for the product channel.");
        }

        const id = generateId("ver");
        await Promise.resolve(tx.query(
          `
            INSERT INTO client_versions
            (
              id, product_id, channel, version, status, force_update,
              download_url, release_notes, notice_title, notice_body,
              released_at, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          `,
          [
            id,
            product.id,
            channel,
            version,
            status,
            forceUpdate,
            downloadUrl,
            releaseNotes,
            noticeTitle,
            noticeBody,
            releasedAt,
            timestamp,
            timestamp
          ],
          {
            repository: "versions",
            operation: "createClientVersion",
            versionId: id,
            productId: product.id
          }
        ));

        return {
          id,
          productCode: product.code,
          channel,
          version,
          status,
          forceUpdate: Boolean(forceUpdate),
          downloadUrl,
          noticeTitle,
          noticeBody,
          releaseNotes,
          releasedAt
        };
      });
    },

    async updateClientVersionStatus(versionId, body = {}, timestamp = nowIso()) {
      return adapter.withTransaction(async (tx) => {
        const row = await loadClientVersionRow(tx, versionId);
        if (!row) {
          throw new AppError(404, "CLIENT_VERSION_NOT_FOUND", "Client version does not exist.");
        }

        const status = normalizeClientVersionStatus(body.status);
        const forceUpdate = parseForceUpdate(body.forceUpdate, row.forceUpdate);

        await Promise.resolve(tx.query(
          `
            UPDATE client_versions
            SET status = $1, force_update = $2, updated_at = $3
            WHERE id = $4
          `,
          [status, forceUpdate, timestamp, row.id],
          {
            repository: "versions",
            operation: "updateClientVersionStatus",
            versionId: row.id
          }
        ));

        return {
          id: row.id,
          productCode: row.productCode,
          channel: row.channel,
          version: row.version,
          status,
          forceUpdate: Boolean(forceUpdate),
          changed: status !== row.status || forceUpdate !== (row.forceUpdate ? 1 : 0),
          updatedAt: timestamp
        };
      });
    }
  };
}
