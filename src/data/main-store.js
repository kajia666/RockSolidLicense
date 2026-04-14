import { resolvePostgresMainStoreAdapter } from "./postgres-runtime-adapter.js";
import { createPostgresMainStore } from "./postgres-main-store.js";
import { createSqliteMainStore } from "./sqlite-main-store.js";

export function createMainStore({ db, config }) {
  if (config.mainStoreDriver === "postgres") {
    const adapterResolution = resolvePostgresMainStoreAdapter(config);
    return createPostgresMainStore({ db, config, adapterResolution });
  }

  return createSqliteMainStore({ db });
}
