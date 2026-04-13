import { createPostgresMainStore } from "./postgres-main-store.js";
import { createSqliteMainStore } from "./sqlite-main-store.js";

export function createMainStore({ db, config }) {
  if (config.mainStoreDriver === "postgres") {
    return createPostgresMainStore({ db, config });
  }

  return createSqliteMainStore({ db });
}
