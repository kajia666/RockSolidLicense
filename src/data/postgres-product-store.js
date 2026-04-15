import { AppError } from "../http.js";
import { generateId, nowIso, randomAppId, randomToken } from "../security.js";
import {
  DEFAULT_PRODUCT_FEATURE_CONFIG,
  formatProductRow,
  mergeProductFeatureConfig,
  normalizeProductProfileInput,
  normalizeProductStatus,
  parseProductFeatureConfigInput,
  parseProductFeatureConfigRow,
  serializeProductFeatureConfigValues
} from "./product-repository.js";

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

async function loadProductRow(adapter, productId) {
  const rows = await Promise.resolve(adapter.query(
    `
      SELECT p.*, pfc.allow_register, pfc.allow_account_login, pfc.allow_card_login, pfc.allow_card_recharge,
             pfc.allow_version_check, pfc.allow_notices, pfc.allow_client_unbind,
             pfc.created_at AS feature_created_at, pfc.updated_at AS feature_updated_at,
             da.id AS owner_developer_id,
             da.username AS owner_developer_username,
             da.display_name AS owner_developer_display_name,
             da.status AS owner_developer_status
      FROM products p
      LEFT JOIN product_feature_configs pfc ON pfc.product_id = p.id
      LEFT JOIN developer_accounts da ON da.id = p.owner_developer_id
      WHERE p.id = $1
      LIMIT 1
    `,
    [productId],
    {
      repository: "products",
      operation: "loadProductRow",
      productId
    }
  ));

  return rows[0] ? formatProductRow(rows[0]) : null;
}

async function persistProductFeatureConfig(adapter, productId, body = {}, timestamp = nowIso()) {
  const existingRows = await Promise.resolve(adapter.query(
    `
      SELECT allow_register, allow_account_login, allow_card_login, allow_card_recharge,
             allow_version_check, allow_notices, allow_client_unbind,
             created_at AS feature_created_at, updated_at AS feature_updated_at
      FROM product_feature_configs
      WHERE product_id = $1
      LIMIT 1
    `,
    [productId],
    {
      repository: "products",
      operation: "loadProductFeatureConfig",
      productId
    }
  ));

  const current = existingRows[0]
    ? parseProductFeatureConfigRow(existingRows[0], timestamp)
    : DEFAULT_PRODUCT_FEATURE_CONFIG;
  const resolved = mergeProductFeatureConfig(
    current,
    parseProductFeatureConfigInput(body, parseOptionalBoolean)
  );
  const values = serializeProductFeatureConfigValues(resolved);

  await Promise.resolve(adapter.query(
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
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT(product_id) DO UPDATE SET
        allow_register = EXCLUDED.allow_register,
        allow_account_login = EXCLUDED.allow_account_login,
        allow_card_login = EXCLUDED.allow_card_login,
        allow_card_recharge = EXCLUDED.allow_card_recharge,
        allow_version_check = EXCLUDED.allow_version_check,
        allow_notices = EXCLUDED.allow_notices,
        allow_client_unbind = EXCLUDED.allow_client_unbind,
        updated_at = EXCLUDED.updated_at
    `,
    [
      productId,
      ...values,
      existingRows[0]?.feature_created_at ?? timestamp,
      timestamp
    ],
    {
      repository: "products",
      operation: "persistProductFeatureConfig",
      productId
    }
  ));

  return {
    ...resolved,
    createdAt: existingRows[0]?.feature_created_at ?? timestamp,
    updatedAt: timestamp
  };
}

export function createPostgresProductStore(adapter) {
  if (!adapter || typeof adapter.withTransaction !== "function") {
    return {};
  }

  return {
    async createProduct(body = {}, ownerDeveloperId = null) {
      const profile = normalizeProductProfileInput(body);

      return adapter.withTransaction(async (tx) => {
        const existing = await Promise.resolve(tx.query(
          "SELECT id FROM products WHERE code = $1 LIMIT 1",
          [profile.code],
          {
            repository: "products",
            operation: "assertProductCodeAvailable",
            code: profile.code
          }
        ));
        if (existing[0]) {
          throw new AppError(409, "PRODUCT_EXISTS", "Product code already exists.");
        }

        const timestamp = nowIso();
        const product = {
          id: generateId("prod"),
          code: profile.code,
          name: profile.name,
          description: profile.description,
          status: "active",
          ownerDeveloperId,
          sdkAppId: randomAppId(),
          sdkAppSecret: randomToken(24),
          createdAt: timestamp,
          updatedAt: timestamp
        };

        await Promise.resolve(tx.query(
          `
            INSERT INTO products
            (id, code, name, description, status, owner_developer_id, sdk_app_id, sdk_app_secret, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `,
          [
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
          ],
          {
            repository: "products",
            operation: "createProduct",
            productId: product.id
          }
        ));

        await persistProductFeatureConfig(tx, product.id, body, timestamp);
        return loadProductRow(tx, product.id);
      });
    },

    async updateProductProfile(productId, body = {}, timestamp = nowIso()) {
      return adapter.withTransaction(async (tx) => {
        const product = await loadProductRow(tx, productId);
        if (!product) {
          throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
        }

        const profile = normalizeProductProfileInput(body, product);
        if (profile.code !== product.code) {
          const existing = await Promise.resolve(tx.query(
            "SELECT id FROM products WHERE code = $1 AND id <> $2 LIMIT 1",
            [profile.code, product.id],
            {
              repository: "products",
              operation: "assertProductCodeAvailableForUpdate",
              productId: product.id,
              code: profile.code
            }
          ));
          if (existing[0]) {
            throw new AppError(409, "PRODUCT_EXISTS", "Product code already exists.");
          }
        }

        await Promise.resolve(tx.query(
          `
            UPDATE products
            SET code = $1, name = $2, description = $3, updated_at = $4
            WHERE id = $5
          `,
          [profile.code, profile.name, profile.description, timestamp, product.id],
          {
            repository: "products",
            operation: "updateProductProfile",
            productId: product.id
          }
        ));

        return loadProductRow(tx, product.id);
      });
    },

    async updateProductStatus(productId, status, timestamp = nowIso()) {
      const nextStatus = normalizeProductStatus(status);

      return adapter.withTransaction(async (tx) => {
        await Promise.resolve(tx.query(
          `
            UPDATE products
            SET status = $1, updated_at = $2
            WHERE id = $3
          `,
          [nextStatus, timestamp, productId],
          {
            repository: "products",
            operation: "updateProductStatus",
            productId,
            status: nextStatus
          }
        ));

        const product = await loadProductRow(tx, productId);
        if (!product) {
          throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
        }
        return product;
      });
    },

    async updateProductOwner(productId, ownerDeveloperId, timestamp = nowIso()) {
      return adapter.withTransaction(async (tx) => {
        await Promise.resolve(tx.query(
          `
            UPDATE products
            SET owner_developer_id = $1, updated_at = $2
            WHERE id = $3
          `,
          [ownerDeveloperId, timestamp, productId],
          {
            repository: "products",
            operation: "updateProductOwner",
            productId
          }
        ));

        const product = await loadProductRow(tx, productId);
        if (!product) {
          throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
        }
        return product;
      });
    },

    async updateProductFeatureConfig(productId, body = {}, timestamp = nowIso()) {
      return adapter.withTransaction(async (tx) => {
        const product = await loadProductRow(tx, productId);
        if (!product) {
          throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
        }

        const featureConfig = await persistProductFeatureConfig(tx, product.id, body, timestamp);
        await Promise.resolve(tx.query(
          "UPDATE products SET updated_at = $1 WHERE id = $2",
          [timestamp, product.id],
          {
            repository: "products",
            operation: "touchProductUpdatedAt",
            productId: product.id
          }
        ));

        return {
          product: await loadProductRow(tx, product.id),
          featureConfig
        };
      });
    },

    async rotateProductSdkCredentials(productId, body = {}, timestamp = nowIso()) {
      return adapter.withTransaction(async (tx) => {
        const product = await loadProductRow(tx, productId);
        if (!product) {
          throw new AppError(404, "PRODUCT_NOT_FOUND", "Product does not exist.");
        }

        const rotateAppId = parseOptionalBoolean(body.rotateAppId, "rotateAppId") === true;
        const nextSdkAppId = rotateAppId ? randomAppId() : product.sdkAppId;
        const nextSdkAppSecret = randomToken(24);

        await Promise.resolve(tx.query(
          `
            UPDATE products
            SET sdk_app_id = $1, sdk_app_secret = $2, updated_at = $3
            WHERE id = $4
          `,
          [nextSdkAppId, nextSdkAppSecret, timestamp, product.id],
          {
            repository: "products",
            operation: "rotateProductSdkCredentials",
            productId: product.id
          }
        ));

        return {
          product: await loadProductRow(tx, product.id),
          rotated: {
            rotateAppId,
            previousSdkAppId: product.sdkAppId,
            sdkAppId: nextSdkAppId,
            sdkAppSecret: nextSdkAppSecret,
            updatedAt: timestamp
          }
        };
      });
    }
  };
}
