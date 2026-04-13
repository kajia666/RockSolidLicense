import path from "node:path";
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
      cards: fallbackStore.cards,
      entitlements: fallbackStore.entitlements
    };

    const metadata = {
      driver: "postgres",
      configuredDriver: "postgres",
      targetDriver: "postgres",
      implementationStage: "read_side_preview",
      fallbackReason: "cards_and_entitlements_still_use_sqlite",
      adapterReady,
      postgresUrlConfigured: Boolean(config.postgresUrl),
      schemaScriptPath: path.join(config.cwd, "deploy", "postgres", "init.sql"),
      repositories: Object.keys(repositories),
      repositoryDrivers: {
        products: "postgres",
        policies: "postgres",
        cards: "sqlite",
        entitlements: "sqlite"
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
