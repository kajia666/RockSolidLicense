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
  return {
    driver: "sqlite",
    db,
    repositories: Object.keys(SQLITE_MAIN_STORE_REPOSITORIES),
    ...SQLITE_MAIN_STORE_REPOSITORIES
  };
}
