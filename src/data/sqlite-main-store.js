import * as accounts from "./account-repository.js";
import * as versions from "./client-version-repository.js";
import * as notices from "./notice-repository.js";
import * as networkRules from "./network-rule-repository.js";
import * as sessions from "./session-repository.js";
import * as products from "./product-repository.js";
import * as policies from "./policy-repository.js";
import * as cards from "./card-repository.js";
import * as entitlements from "./entitlement-repository.js";
import { createSqliteAccountStore } from "./sqlite-account-store.js";
import { createSqliteCardStore } from "./sqlite-card-store.js";
import { createSqliteDeviceStore } from "./sqlite-device-store.js";
import { createSqliteEntitlementStore } from "./sqlite-entitlement-store.js";
import { createSqlitePolicyStore } from "./sqlite-policy-store.js";
import { createSqliteProductStore } from "./sqlite-product-store.js";
import { createSqliteSessionStore } from "./sqlite-session-store.js";

export function createSqliteMainStore({ db }) {
  const repositories = {
    products: {
      ...products,
      ...createSqliteProductStore({ db })
    },
    policies: {
      ...policies,
      ...createSqlitePolicyStore({ db })
    },
    cards: {
      ...cards,
      ...createSqliteCardStore({ db })
    },
    entitlements: {
      ...entitlements,
      ...createSqliteEntitlementStore({ db })
    },
    accounts: {
      ...accounts,
      ...createSqliteAccountStore({ db })
    },
    versions: {
      ...versions
    },
    notices: {
      ...notices
    },
    networkRules: {
      ...networkRules
    },
    devices: {
      ...createSqliteDeviceStore({ db })
    },
    sessions: {
      ...sessions,
      ...createSqliteSessionStore({ db })
    }
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
      entitlements: "sqlite",
      accounts: "sqlite",
      versions: "sqlite",
      notices: "sqlite",
      networkRules: "sqlite",
      devices: "sqlite",
      sessions: "sqlite"
    },
    repositoryWriteDrivers: {
      products: "sqlite",
      policies: "sqlite",
      cards: "sqlite",
      entitlements: "sqlite",
      accounts: "sqlite",
      versions: "sqlite",
      notices: "sqlite",
      networkRules: "sqlite",
      devices: "sqlite",
      sessions: "sqlite"
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
