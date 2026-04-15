import { AppError } from "../http.js";
import { generateId, nowIso } from "../security.js";
import {
  formatNoticeManageRow,
  normalizeNoticeChannel,
  normalizeNoticeKind,
  normalizeNoticeStatus
} from "./notice-repository.js";

function parseBlockLogin(value, fallback = 0) {
  if (value === undefined) {
    return fallback ? 1 : 0;
  }
  return value === true || value === 1 || value === "true" ? 1 : 0;
}

function normalizeNoticeSeverity(value) {
  const severity = String(value ?? "info").trim().toLowerCase();
  if (!["info", "warning", "critical"].includes(severity)) {
    throw new AppError(400, "INVALID_NOTICE_SEVERITY", "Notice severity must be info, warning, or critical.");
  }
  return severity;
}

async function loadNoticeRow(adapter, noticeId) {
  const rows = await Promise.resolve(adapter.query(
    `
      SELECT n.*, pr.code AS product_code, pr.name AS product_name, pr.owner_developer_id
      FROM notices n
      LEFT JOIN products pr ON pr.id = n.product_id
      WHERE n.id = $1
      LIMIT 1
    `,
    [noticeId],
    {
      repository: "notices",
      operation: "getNoticeRowById",
      noticeId
    }
  ));

  return rows[0] ? formatNoticeManageRow(rows[0]) : null;
}

export function createPostgresNoticeStore(adapter) {
  if (!adapter || typeof adapter.withTransaction !== "function") {
    return {};
  }

  return {
    async createNotice(product = null, body = {}, timestamp = nowIso()) {
      const title = String(body.title ?? "").trim();
      const content = String(body.body ?? "").trim();
      if (!title) {
        throw new AppError(400, "FIELD_REQUIRED", "title is required.");
      }
      if (!content) {
        throw new AppError(400, "FIELD_REQUIRED", "body is required.");
      }

      const channel = normalizeNoticeChannel(body.channel, "all");
      const kind = normalizeNoticeKind(body.kind ?? "announcement");
      const severity = normalizeNoticeSeverity(body.severity ?? "info");
      const status = normalizeNoticeStatus(body.status ?? "active");
      const blockLogin = parseBlockLogin(body.blockLogin);
      const actionUrl = String(body.actionUrl ?? "").trim() || null;
      const startsAt = body.startsAt ? new Date(body.startsAt).toISOString() : timestamp;
      const endsAt = body.endsAt ? new Date(body.endsAt).toISOString() : null;

      if (endsAt && endsAt <= startsAt) {
        throw new AppError(400, "INVALID_NOTICE_WINDOW", "Notice end time must be later than start time.");
      }

      return adapter.withTransaction(async (tx) => {
        const id = generateId("notice");
        await Promise.resolve(tx.query(
          `
            INSERT INTO notices
            (
              id, product_id, channel, kind, severity, title, body,
              action_url, status, block_login, starts_at, ends_at,
              created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          `,
          [
            id,
            product?.id ?? null,
            channel,
            kind,
            severity,
            title,
            content,
            actionUrl,
            status,
            blockLogin,
            startsAt,
            endsAt,
            timestamp,
            timestamp
          ],
          {
            repository: "notices",
            operation: "createNotice",
            noticeId: id,
            productId: product?.id ?? null
          }
        ));

        return {
          id,
          productCode: product?.code ?? null,
          channel,
          kind,
          severity,
          title,
          body: content,
          actionUrl,
          status,
          blockLogin: Boolean(blockLogin),
          startsAt,
          endsAt
        };
      });
    },

    async updateNoticeStatus(noticeId, body = {}, timestamp = nowIso()) {
      return adapter.withTransaction(async (tx) => {
        const row = await loadNoticeRow(tx, noticeId);
        if (!row) {
          throw new AppError(404, "NOTICE_NOT_FOUND", "Notice does not exist.");
        }

        const status = normalizeNoticeStatus(body.status);
        const blockLogin = parseBlockLogin(body.blockLogin, row.blockLogin);

        await Promise.resolve(tx.query(
          `
            UPDATE notices
            SET status = $1, block_login = $2, updated_at = $3
            WHERE id = $4
          `,
          [status, blockLogin, timestamp, row.id],
          {
            repository: "notices",
            operation: "updateNoticeStatus",
            noticeId: row.id
          }
        ));

        return {
          id: row.id,
          productCode: row.productCode,
          channel: row.channel,
          status,
          blockLogin: Boolean(blockLogin),
          changed: status !== row.status || blockLogin !== (row.blockLogin ? 1 : 0),
          updatedAt: timestamp
        };
      });
    }
  };
}
