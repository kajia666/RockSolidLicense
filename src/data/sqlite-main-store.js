import * as products from "./product-repository.js";
import * as policies from "./policy-repository.js";
import * as cards from "./card-repository.js";
import * as entitlements from "./entitlement-repository.js";

const SQLITE_MAIN_STORE_REPOSITORIES = Object.freeze({
  products,
  policies,
  cards,
  entitlements
});

export function createSqliteMainStore({ db }) {
  const metadata = {
    driver: "sqlite",
    repositories: Object.keys(SQLITE_MAIN_STORE_REPOSITORIES),
    configuredDriver: "sqlite",
    targetDriver: "sqlite",
    implementationStage: "native",
    adapterReady: true,
    repositoryDrivers: {
      products: "sqlite",
      policies: "sqlite",
      cards: "sqlite",
      entitlements: "sqlite"
    }
  };

  return {
    ...metadata,
    db,
    ...SQLITE_MAIN_STORE_REPOSITORIES,
    health() {
      return { ...metadata };
    }
  };
}
