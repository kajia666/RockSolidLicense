import path from "node:path";
import { createPostgresAccountStore } from "./postgres-account-store.js";
import { createPostgresAccountRepository } from "./postgres-account-repository.js";
import { createPostgresCardRepository } from "./postgres-card-repository.js";
import { createPostgresCardStore } from "./postgres-card-store.js";
import { createPostgresDeviceRepository } from "./postgres-device-repository.js";
import { createPostgresDeviceStore } from "./postgres-device-store.js";
import { createPostgresEntitlementRepository } from "./postgres-entitlement-repository.js";
import { createPostgresEntitlementStore } from "./postgres-entitlement-store.js";
import { createPostgresPolicyRepository } from "./postgres-policy-repository.js";
import { createPostgresPolicyStore } from "./postgres-policy-store.js";
import { createPostgresProductRepository } from "./postgres-product-repository.js";
import { createPostgresProductStore } from "./postgres-product-store.js";
import { createPostgresSessionRepository } from "./postgres-session-repository.js";
import { createSqliteMainStore } from "./sqlite-main-store.js";

export function createPostgresMainStore({ db, config, adapterResolution = null }) {
  const fallbackStore = createSqliteMainStore({ db });
  const adapter = adapterResolution?.adapter ?? config.postgresMainStoreAdapter ?? null;
  const adapterMetadata = adapterResolution?.metadata ?? {};
  const adapterReady = Boolean(adapter && typeof adapter.query === "function");
  const coreWriteReady = Boolean(adapterReady && typeof adapter.withTransaction === "function");

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
        ...createPostgresCardRepository(adapter),
        ...createPostgresCardStore(adapter)
      },
      entitlements: {
        ...fallbackStore.entitlements,
        ...createPostgresEntitlementRepository(adapter),
        ...createPostgresEntitlementStore(adapter)
      },
      accounts: {
        ...fallbackStore.accounts,
        ...createPostgresAccountRepository(adapter),
        ...createPostgresAccountStore(adapter)
      },
      devices: {
        ...fallbackStore.devices,
        ...createPostgresDeviceRepository(adapter),
        ...createPostgresDeviceStore(adapter)
      },
      sessions: {
        ...fallbackStore.sessions,
        ...createPostgresSessionRepository(adapter)
      }
    };

    const metadata = {
      driver: "postgres",
      configuredDriver: "postgres",
      targetDriver: "postgres",
      implementationStage: coreWriteReady ? "core_write_preview" : "read_side_preview",
      fallbackReason: coreWriteReady ? "non_main_store_tables_still_use_sqlite" : "writes_still_use_sqlite",
      ...adapterMetadata,
      adapterReady,
      postgresUrlConfigured: Boolean(config.postgresUrl),
      schemaScriptPath: path.join(config.cwd, "deploy", "postgres", "init.sql"),
      repositories: Object.keys(repositories),
      repositoryDrivers: {
        products: "postgres",
        policies: "postgres",
        cards: "postgres",
        entitlements: "postgres",
        accounts: "postgres",
        devices: "postgres",
        sessions: "postgres"
      },
      repositoryWriteDrivers: {
        products: coreWriteReady ? "postgres" : "sqlite",
        policies: coreWriteReady ? "postgres" : "sqlite",
        cards: coreWriteReady ? "postgres" : "sqlite",
        entitlements: coreWriteReady ? "postgres" : "sqlite",
        accounts: coreWriteReady ? "postgres" : "sqlite",
        devices: coreWriteReady ? "postgres_partial" : "sqlite",
        sessions: "sqlite"
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
      entitlements: "sqlite",
      accounts: "sqlite",
      devices: "sqlite",
      sessions: "sqlite"
    },
    repositoryWriteDrivers: {
      products: "sqlite",
      policies: "sqlite",
      cards: "sqlite",
      entitlements: "sqlite",
      accounts: "sqlite",
      devices: "sqlite",
      sessions: "sqlite"
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
