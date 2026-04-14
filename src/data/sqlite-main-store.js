import * as products from "./product-repository.js";
import * as policies from "./policy-repository.js";
import * as cards from "./card-repository.js";
import * as entitlements from "./entitlement-repository.js";
import { createSqliteProductStore } from "./sqlite-product-store.js";

export function createSqliteMainStore({ db }) {
  const repositories = {
    products: {
      ...products,
      ...createSqliteProductStore({ db })
    },
    policies,
    cards,
    entitlements
  };

  const metadata = {
    driver: "sqlite",
    repositories: Object.keys(repositories),
    configuredDriver: "sqlite",
    targetDriver: "sqlite",
    implementationStage: "native",
    adapterReady: true,
    repositoryDrivers: {
      products: "sqlite",
      policies: "sqlite",
      cards: "sqlite",
      entitlements: "sqlite"
    },
    repositoryWriteDrivers: {
      products: "sqlite"
    }
  };

  return {
    ...metadata,
    db,
    ...repositories,
    health() {
      return { ...metadata };
    },
    async close() {
      return undefined;
    }
  };
}
