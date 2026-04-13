import path from "node:path";
import { createPostgresCardRepository } from "./postgres-card-repository.js";
import { createPostgresEntitlementRepository } from "./postgres-entitlement-repository.js";
import { createPostgresPolicyRepository } from "./postgres-policy-repository.js";
import { createPostgresProductRepository } from "./postgres-product-repository.js";
import { createSqliteMainStore } from "./sqlite-main-store.js";

export function createPostgresMainStore({ db, config }) {
  const fallbackStore = createSqliteMainStore({ db });
  const adapter = config.postgresMainStoreAdapter;
  const adapterReady = Boolean(adapter && typeof adapter.query === "function");

  if (adapterReady) {
    const repositories = {
      products: createPostgresProductRepository(adapter),
      policies: createPostgresPolicyRepository(adapter),
      cards: createPostgresCardRepository(adapter),
      entitlements: createPostgresEntitlementRepository(adapter)
    };

    const metadata = {
      driver: "postgres",
      configuredDriver: "postgres",
      targetDriver: "postgres",
      implementationStage: "read_side_preview",
      fallbackReason: "writes_still_use_sqlite",
      adapterReady,
      postgresUrlConfigured: Boolean(config.postgresUrl),
      schemaScriptPath: path.join(config.cwd, "deploy", "postgres", "init.sql"),
      repositories: Object.keys(repositories),
      repositoryDrivers: {
        products: "postgres",
        policies: "postgres",
        cards: "postgres",
        entitlements: "postgres"
      }
    };

    return {
      ...repositories,
      db,
      ...metadata,
      health() {
        return { ...metadata };
      }
    };
  }

  const metadata = {
    driver: fallbackStore.driver,
    configuredDriver: "postgres",
    targetDriver: "postgres",
    implementationStage: "sqlite_fallback",
    fallbackReason: "postgres_runtime_not_implemented",
    adapterReady,
    postgresUrlConfigured: Boolean(config.postgresUrl),
    schemaScriptPath: path.join(config.cwd, "deploy", "postgres", "init.sql"),
    repositories: fallbackStore.repositories,
    repositoryDrivers: {
      products: "sqlite",
      policies: "sqlite",
      cards: "sqlite",
      entitlements: "sqlite"
    }
  };

  return {
    ...fallbackStore,
    ...metadata,
    health() {
      return { ...metadata };
    }
  };
}
