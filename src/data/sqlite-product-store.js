import { AppError } from "../http.js";
import { generateId, nowIso, randomAppId, randomToken } from "../security.js";
import {
  DEFAULT_PRODUCT_FEATURE_CONFIG,
  getProductRecordById,
  getProductRowById,
  mergeProductFeatureConfig,
  parseProductFeatureConfigInput,
  parseProductFeatureConfigRow,
  productCodeExists,
  serializeProductFeatureConfigValues
} from "./product-repository.js";

function one(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

function run(db, sql, ...params) {
  return db.prepare(sql).run(...params);
}

function parseOptionalBoolean(value, fieldName) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new AppError(400, "INVALID_BOOLEAN", `${fieldName} must be a boolean value.`);
}

function persistProductFeatureConfig(db, productId, body = {}, timestamp = nowIso()) {
  const existing = one(db, "SELECT * FROM product_feature_configs WHERE product_id = ?", productId);
  const current = existing
    ? parseProductFeatureConfigRow(existing, timestamp)
    : DEFAULT_PRODUCT_FEATURE_CONFIG;
  const resolved = mergeProductFeatureConfig(
    current,
    parseProductFeatureConfigInput(body, parseOptionalBoolean)
  );
  const values = serializeProductFeatureConfigValues(resolved, (value) => (value ? 1 : 0));

  if (existing) {
    run(
      db,
      `
        UPDATE product_feature_configs
        SET allow_register = ?, allow_account_login = ?, allow_card_login = ?, allow_card_recharge = ?,
            allow_version_check = ?, allow_notices = ?, allow_client_unbind = ?, updated_at = ?
        WHERE product_id = ?
      `,
      ...values,
      timestamp,
      productId
    );
  } else {
    run(
      db,
      `
        INSERT INTO product_feature_configs
        (
          product_id,
          allow_register,
          allow_account_login,
          allow_card_login,
          allow_card_recharge,
          allow_version_check,
          allow_notices,
          allow_client_unbind,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      productId,
      ...values,
      timestamp,
      timestamp
    );
  }

  return {
    ...resolved,
    createdAt: existing?.created_at ?? timestamp,
    updatedAt: timestamp
  };
}

export function createSqliteProductStore({ db }) {
  return {
    createProduct(body = {}, ownerDeveloperId = null) {
      if (body.code === undefined || body.code === null || String(body.code).trim() === "") {
        throw new AppError(400, "FIELD_REQUIRED", "code is required.");
      }
      if (body.name === undefined || body.name === null || String(body.name).trim() === "") {
        throw new AppError(400, "FIELD_REQUIRED", "name is required.");
      }

      const code = String(body.code).trim().toUpperCase();
      if (!/^[A-Z0-9_]{3,32}$/.test(code)) {
        throw new AppError(400, "INVALID_PRODUCT_CODE", "Product code must be 3-32 chars: A-Z, 0-9 or underscore.");
      }
      if (productCodeExists(db, code)) {
        throw new AppError(409, "PRODUCT_EXISTS", "Product code already exists.");
      }

      const timestamp = nowIso();
      const product = {
        id: generateId("prod"),
        code,
        name: String(body.name).trim(),
        description: String(body.description ?? "").trim(),
        status: "active",
        ownerDeveloperId,
        sdkAppId: randomAppId(),
        sdkAppSecret: randomToken(24),
        createdAt: timestamp,
        updatedAt: timestamp
      };

      run(
        db,
        `
          INSERT INTO products
          (id, code, name, description, status, owner_developer_id, sdk_app_id, sdk_app_secret, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        product.id,
        product.code,
        product.name,
        product.description,
        product.status,
        product.ownerDeveloperId,
        product.sdkAppId,
        product.sdkAppSecret,
        product.createdAt,
        product.updatedAt
      );
      persistProductFeatureConfig(db, product.id, body, timestamp);

      return getProductRowById(db, product.id);
    },

    updateProductOwner(productId, ownerDeveloperId, timestamp = nowIso()) {
      run(
        db,
        `
          UPDATE products
          SET owner_developer_id = ?, updated_at = ?
          WHERE id = ?
        `,
        ownerDeveloperId,
        timestamp,
        productId
      );
      return getProductRowById(db, productId);
    },

    updateProductFeatureConfig(productId, body = {}, timestamp = nowIso()) {
      const product = getProductRecordById(db, productId);
      if (!product) {
        throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
      }

      const featureConfig = persistProductFeatureConfig(db, product.id, body, timestamp);
      run(db, "UPDATE products SET updated_at = ? WHERE id = ?", timestamp, product.id);

      return {
        product: getProductRowById(db, product.id),
        featureConfig
      };
    },

    rotateProductSdkCredentials(productId, body = {}, timestamp = nowIso()) {
      const product = getProductRecordById(db, productId);
      if (!product) {
        throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
      }

      const rotateAppId = parseOptionalBoolean(body.rotateAppId, "rotateAppId") === true;
      const nextSdkAppId = rotateAppId ? randomAppId() : product.sdk_app_id;
      const nextSdkAppSecret = randomToken(24);

      run(
        db,
        `
          UPDATE products
          SET sdk_app_id = ?, sdk_app_secret = ?, updated_at = ?
          WHERE id = ?
        `,
        nextSdkAppId,
        nextSdkAppSecret,
        timestamp,
        product.id
      );

      return {
        product: getProductRowById(db, product.id),
        rotated: {
          rotateAppId,
          previousSdkAppId: product.sdk_app_id,
          sdkAppId: nextSdkAppId,
          sdkAppSecret: nextSdkAppSecret,
          updatedAt: timestamp
        }
      };
    }
  };
}
