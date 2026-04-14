import { AppError } from "../http.js";
import { generateId, hashPassword, nowIso, randomToken } from "../security.js";
import {
  accountUsernameExists,
  getAccountManageRowById,
  getAccountRecordById,
  normalizeAccountStatus
} from "./account-repository.js";

function run(db, sql, ...params) {
  return db.prepare(sql).run(...params);
}

function buildCardLoginUsername(product, card, accountId) {
  const productCode = String(product.code)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8) || "product";
  const cardTail = String(card.card_key ?? card.id)
    .trim()
    .replace(/[^A-Z0-9]/gi, "")
    .slice(-6)
    .toLowerCase() || accountId.slice(-6).toLowerCase();
  return `card_${productCode}_${cardTail}_${accountId.slice(-4).toLowerCase()}`;
}

export function createSqliteAccountStore({ db }) {
  return {
    createAccount(product, body = {}, timestamp = nowIso()) {
      const username = String(body.username ?? "").trim();
      const passwordHash = String(body.passwordHash ?? "").trim();

      if (!username) {
        throw new AppError(400, "FIELD_REQUIRED", "username is required.");
      }
      if (!passwordHash) {
        throw new AppError(400, "FIELD_REQUIRED", "passwordHash is required.");
      }
      if (accountUsernameExists(db, product.id, username)) {
        throw new AppError(409, "ACCOUNT_EXISTS", "This username has already been registered.");
      }

      const accountId = generateId("acct");
      run(
        db,
        `
          INSERT INTO customer_accounts
          (id, product_id, username, password_hash, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'active', ?, ?)
        `,
        accountId,
        product.id,
        username,
        passwordHash,
        timestamp,
        timestamp
      );

      return getAccountRecordById(db, accountId);
    },

    createCardLoginAccount(product, card, timestamp = nowIso()) {
      const accountId = generateId("acct");
      const username = buildCardLoginUsername(product, card, accountId);

      run(
        db,
        `
          INSERT INTO customer_accounts
          (id, product_id, username, password_hash, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'active', ?, ?)
        `,
        accountId,
        product.id,
        username,
        hashPassword(randomToken(32)),
        timestamp,
        timestamp
      );

      run(
        db,
        `
          INSERT INTO card_login_accounts (license_key_id, account_id, product_id, created_at)
          VALUES (?, ?, ?, ?)
        `,
        card.id,
        accountId,
        product.id,
        timestamp
      );

      return getAccountRecordById(db, accountId);
    },

    updateAccountStatus(accountId, status, timestamp = nowIso()) {
      const current = getAccountRecordById(db, accountId);
      if (!current) {
        throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account does not exist.");
      }

      run(
        db,
        `
          UPDATE customer_accounts
          SET status = ?, updated_at = ?
          WHERE id = ?
        `,
        normalizeAccountStatus(status),
        timestamp,
        current.id
      );

      return getAccountManageRowById(db, current.id);
    },

    touchAccountLastLogin(accountId, timestamp = nowIso()) {
      run(
        db,
        `
          UPDATE customer_accounts
          SET last_login_at = ?, updated_at = ?
          WHERE id = ?
        `,
        timestamp,
        timestamp,
        accountId
      );

      return getAccountRecordById(db, accountId);
    }
  };
}
