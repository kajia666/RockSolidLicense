import path from "node:path";
import { createPostgresCardRepository } from "./postgres-card-repository.js";
import { createPostgresEntitlementRepository } from "./postgres-entitlement-repository.js";
import { createPostgresPolicyRepository } from "./postgres-policy-repository.js";
import { createPostgresPolicyStore } from "./postgres-policy-store.js";
import { createPostgresProductRepository } from "./postgres-product-repository.js";
import { createPostgresProductStore } from "./postgres-product-store.js";
import { createSqliteMainStore } from "./sqlite-main-store.js";

export function createPostgresMainStore({ db, config, adapterResolution = null }) {
  const fallbackStore = createSqliteMainStore({ db });
  const adapter = adapterResolution?.adapter ?? config.postgresMainStoreAdapter ?? null;
  const adapterMetadata = adapterResolution?.metadata ?? {};
  const adapterReady = Boolean(adapter && typeof adapter.query === "function");
  const productPolicyWriteReady = Boolean(adapterReady && typeof adapter.withTransaction === "function");

  if (adapterReady) {
    const repositories = {
      products: {
        ...fallbackStore.products,
        ...createPostgresProductRepository(adapter),
        ...createPostgresProductStore(adapter)
      },
      policies: {
        ...fallbackStore.policies,
        ...createPostgresPolicyRepository(adapter),
        ...createPostgresPolicyStore(adapter)
      },
      cards: {
        ...fallbackStore.cards,
        ...createPostgresCardRepository(adapter)
      },
      entitlements: {
        ...fallbackStore.entitlements,
        ...createPostgresEntitlementRepository(adapter)
      }
    };

    const metadata = {
      driver: "postgres",
      configuredDriver: "postgres",
      targetDriver: "postgres",
      implementationStage: productPolicyWriteReady ? "product_policy_write_preview" : "read_side_preview",
      fallbackReason: productPolicyWriteReady ? "cards_and_entitlements_still_use_sqlite" : "writes_still_use_sqlite",
      ...adapterMetadata,
      adapterReady,
      postgresUrlConfigured: Boolean(config.postgresUrl),
      schemaScriptPath: path.join(config.cwd, "deploy", "postgres", "init.sql"),
      repositories: Object.keys(repositories),
      repositoryDrivers: {
        products: "postgres",
        policies: "postgres",
        cards: "postgres",
        entitlements: "postgres"
      },
      repositoryWriteDrivers: {
        products: productPolicyWriteReady ? "postgres" : "sqlite",
        policies: productPolicyWriteReady ? "postgres" : "sqlite",
        cards: "sqlite",
        entitlements: "sqlite"
      }
    };

    return {
      ...repositories,
      db,
      ...metadata,
      async health() {
        const runtimeHealth = typeof adapter.health === "function"
          ? await Promise.resolve(adapter.health())
          : null;
        return runtimeHealth ? { ...metadata, ...runtimeHealth } : { ...metadata };
      },
      async close() {
        if (typeof adapter.close === "function") {
          await Promise.resolve(adapter.close());
        }
      }
    };
  }

  const metadata = {
    driver: fallbackStore.driver,
    configuredDriver: "postgres",
    targetDriver: "postgres",
    implementationStage: "sqlite_fallback",
    fallbackReason: "postgres_runtime_not_implemented",
    ...adapterMetadata,
    adapterReady,
    postgresUrlConfigured: Boolean(config.postgresUrl),
    schemaScriptPath: path.join(config.cwd, "deploy", "postgres", "init.sql"),
    repositories: fallbackStore.repositories,
    repositoryDrivers: {
      products: "sqlite",
      policies: "sqlite",
      cards: "sqlite",
      entitlements: "sqlite"
    },
    repositoryWriteDrivers: {
      products: "sqlite",
      policies: "sqlite",
      cards: "sqlite",
      entitlements: "sqlite"
    }
  };

  return {
    ...fallbackStore,
    ...metadata,
    async health() {
      const runtimeHealth = adapter && typeof adapter.health === "function"
        ? await Promise.resolve(adapter.health())
        : null;
      return runtimeHealth ? { ...metadata, ...runtimeHealth } : { ...metadata };
    },
    async close() {
      if (adapter && typeof adapter.close === "function") {
        await Promise.resolve(adapter.close());
      }
    }
  };
}
