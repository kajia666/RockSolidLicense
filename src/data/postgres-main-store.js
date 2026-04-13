import path from "node:path";
import { createSqliteMainStore } from "./sqlite-main-store.js";

export function createPostgresMainStore({ db, config }) {
  const fallbackStore = createSqliteMainStore({ db });
  const metadata = {
    driver: fallbackStore.driver,
    configuredDriver: "postgres",
    targetDriver: "postgres",
    implementationStage: "sqlite_fallback",
    fallbackReason: "postgres_runtime_not_implemented",
    postgresUrlConfigured: Boolean(config.postgresUrl),
    schemaScriptPath: path.join(config.cwd, "deploy", "postgres", "init.sql"),
    repositories: fallbackStore.repositories
  };

  return {
    ...fallbackStore,
    ...metadata,
    health() {
      return { ...metadata };
    }
  };
}
