import { AppError } from "../http.js";
import { generateId, hashPassword, nowIso, randomToken } from "../security.js";
import { formatAccountRow, normalizeAccountStatus } from "./account-repository.js";

function buildCardLoginUsername(product, card, accountId) {
  const productCode = String(product.code)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8) || "product";
  const cardTail = String(card.card_key ?? card.cardKey ?? card.id)
    .trim()
    .replace(/[^A-Z0-9]/gi, "")
    .slice(-6)
    .toLowerCase() || accountId.slice(-6).toLowerCase();
  return `card_${productCode}_${cardTail}_${accountId.slice(-4).toLowerCase()}`;
}

async function loadAccountRecord(tx, accountId) {
  const rows = await Promise.resolve(tx.query(
    `
      SELECT *
      FROM customer_accounts
      WHERE id = $1
      LIMIT 1
    `,
    [accountId],
    {
      repository: "accounts",
      operation: "getAccountRecordById",
      accountId
    }
  ));

  return rows[0] ?? null;
}

async function loadAccountManageRow(tx, accountId) {
  const rows = await Promise.resolve(tx.query(
    `
      SELECT a.id, a.product_id, a.username, a.status, a.created_at, a.updated_at, a.last_login_at,
             pr.code AS product_code, pr.name AS product_name, pr.owner_developer_id,
             COALESCE(ent.active_entitlement_count, 0) AS active_entitlement_count,
             ent.latest_entitlement_ends_at,
             COALESCE(sess.active_session_count, 0) AS active_session_count
      FROM customer_accounts a
      JOIN products pr ON pr.id = a.product_id
      LEFT JOIN (
        SELECT account_id,
               COUNT(*) AS active_entitlement_count,
               MAX(ends_at) AS latest_entitlement_ends_at
        FROM entitlements
        WHERE status = 'active' AND ends_at > $1
        GROUP BY account_id
      ) ent ON ent.account_id = a.id
      LEFT JOIN (
        SELECT account_id, COUNT(*) AS active_session_count
        FROM sessions
        WHERE status = 'active'
        GROUP BY account_id
      ) sess ON sess.account_id = a.id
      WHERE a.id = $2
      LIMIT 1
    `,
    [nowIso(), accountId],
    {
      repository: "accounts",
      operation: "getAccountManageRowById",
      accountId
    }
  ));

  return rows[0] ? formatAccountRow(rows[0]) : null;
}

export function createPostgresAccountStore(adapter) {
  if (!adapter || typeof adapter.withTransaction !== "function") {
    return {};
  }

  return {
    async createAccount(product, body = {}, timestamp = nowIso()) {
      const username = String(body.username ?? "").trim();
      const passwordHash = String(body.passwordHash ?? "").trim();

      if (!username) {
        throw new AppError(400, "FIELD_REQUIRED", "username is required.");
      }
      if (!passwordHash) {
        throw new AppError(400, "FIELD_REQUIRED", "passwordHash is required.");
      }

      return adapter.withTransaction(async (tx) => {
        const existing = await Promise.resolve(tx.query(
          `
            SELECT id
            FROM customer_accounts
            WHERE product_id = $1 AND username = $2
            LIMIT 1
          `,
          [product.id, username],
          {
            repository: "accounts",
            operation: "accountUsernameExists",
            productId: product.id,
            username
          }
        ));
        if (existing[0]) {
          throw new AppError(409, "ACCOUNT_EXISTS", "This username has already been registered.");
        }

        const accountId = generateId("acct");
        await Promise.resolve(tx.query(
          `
            INSERT INTO customer_accounts
            (id, product_id, username, password_hash, status, created_at, updated_at)
            VALUES ($1, $2, $3, $4, 'active', $5, $6)
          `,
          [accountId, product.id, username, passwordHash, timestamp, timestamp],
          {
            repository: "accounts",
            operation: "createAccount",
            accountId,
            productId: product.id
          }
        ));

        return loadAccountRecord(tx, accountId);
      });
    },

    async createCardLoginAccount(product, card, timestamp = nowIso()) {
      return adapter.withTransaction(async (tx) => {
        const accountId = generateId("acct");
        const username = buildCardLoginUsername(product, card, accountId);

        await Promise.resolve(tx.query(
          `
            INSERT INTO customer_accounts
            (id, product_id, username, password_hash, status, created_at, updated_at)
            VALUES ($1, $2, $3, $4, 'active', $5, $6)
          `,
          [accountId, product.id, username, hashPassword(randomToken(32)), timestamp, timestamp],
          {
            repository: "accounts",
            operation: "createCardLoginAccount",
            accountId,
            productId: product.id,
            licenseKeyId: card.id
          }
        ));

        await Promise.resolve(tx.query(
          `
            INSERT INTO card_login_accounts (license_key_id, account_id, product_id, created_at)
            VALUES ($1, $2, $3, $4)
          `,
          [card.id, accountId, product.id, timestamp],
          {
            repository: "accounts",
            operation: "linkCardLoginAccount",
            accountId,
            productId: product.id,
            licenseKeyId: card.id
          }
        ));

        return loadAccountRecord(tx, accountId);
      });
    },

    async updateAccountStatus(accountId, status, timestamp = nowIso()) {
      return adapter.withTransaction(async (tx) => {
        const current = await loadAccountRecord(tx, accountId);
        if (!current) {
          throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account does not exist.");
        }

        await Promise.resolve(tx.query(
          `
            UPDATE customer_accounts
            SET status = $1, updated_at = $2
            WHERE id = $3
          `,
          [normalizeAccountStatus(status), timestamp, accountId],
          {
            repository: "accounts",
            operation: "updateAccountStatus",
            accountId
          }
        ));

        return loadAccountManageRow(tx, accountId);
      });
    },

    async touchAccountLastLogin(accountId, timestamp = nowIso()) {
      return adapter.withTransaction(async (tx) => {
        await Promise.resolve(tx.query(
          `
            UPDATE customer_accounts
            SET last_login_at = $1, updated_at = $2
            WHERE id = $3
          `,
          [timestamp, timestamp, accountId],
          {
            repository: "accounts",
            operation: "touchAccountLastLogin",
            accountId
          }
        ));

        return loadAccountRecord(tx, accountId);
      });
    }
  };
}
