import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function resolvePgModule(config) {
  const moduleTarget = config.postgresPgModulePath ?? config.postgresPgModule ?? "pg";

  try {
    const loaded = require(moduleTarget);
    const Pool = loaded?.Pool ?? loaded?.default?.Pool ?? null;
    if (!Pool) {
      return {
        moduleTarget,
        loaded: false,
        errorMessage: "Loaded module does not export Pool."
      };
    }
    return {
      moduleTarget,
      loaded: true,
      Pool
    };
  } catch (error) {
    return {
      moduleTarget,
      loaded: false,
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }
}

export function resolvePostgresMainStoreAdapter(config) {
  if (config.postgresMainStoreAdapter && typeof config.postgresMainStoreAdapter.query === "function") {
    return {
      adapter: config.postgresMainStoreAdapter,
      metadata: {
        adapterReady: true,
        adapterSource: "custom",
        adapterState: "override",
        pgModuleTarget: config.postgresPgModulePath ?? config.postgresPgModule ?? "pg",
        pgModuleLoaded: true
      }
    };
  }

  const pgModule = resolvePgModule(config);
  const baseMetadata = {
    adapterReady: false,
    adapterSource: "pg_pool",
    adapterState: "unavailable",
    pgModuleTarget: pgModule.moduleTarget,
    pgModuleLoaded: pgModule.loaded
  };

  if (!config.postgresUrl) {
    return {
      adapter: null,
      metadata: {
        ...baseMetadata,
        adapterState: "missing_postgres_url",
        errorMessage: "RSL_POSTGRES_URL is not configured."
      }
    };
  }

  if (!pgModule.loaded || !pgModule.Pool) {
    return {
      adapter: null,
      metadata: {
        ...baseMetadata,
        adapterState: "pg_module_unavailable",
        errorMessage: pgModule.errorMessage
      }
    };
  }

  const poolMax = Number.isFinite(config.postgresPoolMax)
    ? Math.max(1, Number(config.postgresPoolMax))
    : 10;
  const pool = new pgModule.Pool({
    connectionString: config.postgresUrl,
    max: poolMax
  });

  const adapter = {
    async query(sql, params = []) {
      const result = await pool.query(sql, params);
      return result.rows ?? [];
    },

    async health() {
      try {
        await pool.query("SELECT 1 AS ok");
        return {
          adapterState: "ready",
          connectionOk: true
        };
      } catch (error) {
        return {
          adapterState: "query_failed",
          connectionOk: false,
          errorMessage: error instanceof Error ? error.message : String(error)
        };
      }
    },

    async close() {
      await pool.end();
    }
  };

  return {
    adapter,
    metadata: {
      adapterReady: true,
      adapterSource: "pg_pool",
      adapterState: "pool_created",
      pgModuleTarget: pgModule.moduleTarget,
      pgModuleLoaded: true,
      poolMax
    }
  };
}
