import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SQLITE_SCHEMA_SQL } from "../src/database.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..");
export const targetPath = path.join(repoRoot, "deploy", "postgres", "init.sql");

const booleanColumns = [
  "allow_register",
  "allow_account_login",
  "allow_card_login",
  "allow_card_recharge",
  "allow_version_check",
  "allow_notices",
  "allow_client_unbind",
  "require_startup_bootstrap",
  "require_local_token_validation",
  "require_heartbeat_gate",
  "allow_concurrent_sessions",
  "can_view_descendants",
  "force_update",
  "block_login"
];

const timestampColumns = [
  "created_at",
  "updated_at",
  "last_login_at",
  "expires_at",
  "last_seen_at",
  "issued_at",
  "redeemed_at",
  "starts_at",
  "ends_at",
  "first_seen_at",
  "last_seen_at",
  "first_bound_at",
  "last_bound_at",
  "revoked_at",
  "released_at",
  "released_at",
  "allocated_at",
  "priced_at",
  "period_start",
  "period_end",
  "paid_at",
  "last_heartbeat_at",
  "released_at",
  "released_at"
];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyColumnReplacements(sql, columnNames, replacementFactory) {
  let next = sql;
  for (const columnName of columnNames) {
    const pattern = new RegExp(`\\b${escapeRegex(columnName)}\\s+TEXT\\b`, "g");
    next = next.replace(pattern, replacementFactory(columnName));
  }
  return next;
}

function applyBooleanReplacements(sql) {
  let next = sql;
  for (const columnName of booleanColumns) {
    const truePattern = new RegExp(`\\b${escapeRegex(columnName)}\\s+INTEGER\\s+NOT NULL\\s+DEFAULT\\s+1\\b`, "g");
    const falsePattern = new RegExp(`\\b${escapeRegex(columnName)}\\s+INTEGER\\s+NOT NULL\\s+DEFAULT\\s+0\\b`, "g");
    next = next.replace(truePattern, `${columnName} BOOLEAN NOT NULL DEFAULT TRUE`);
    next = next.replace(falsePattern, `${columnName} BOOLEAN NOT NULL DEFAULT FALSE`);
  }
  return next;
}

export function renderPostgresInit() {
  let sql = SQLITE_SCHEMA_SQL.replace(/\r\n/g, "\n").trim();
  sql = sql.replace(/^PRAGMA foreign_keys = ON;\n*/m, "");
  sql = applyBooleanReplacements(sql);
  sql = applyColumnReplacements(sql, timestampColumns, (columnName) => `${columnName} TIMESTAMPTZ`);
  sql = sql.replace(/\b([a-z_]+_json)\s+TEXT\b/g, "$1 JSONB");

  return [
    "-- Generated from src/database.js",
    "-- Purpose: bootstrap a PostgreSQL main-store schema that mirrors the current SQLite model.",
    "-- Note: the application still runs its main store on SQLite today; this script prepares the next migration phase.",
    "",
    sql,
    ""
  ].join("\n");
}

export function checkPostgresInitSync() {
  const rendered = renderPostgresInit();
  const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";
  return existing === rendered;
}

function main() {
  const rendered = renderPostgresInit();
  const checkMode = process.argv.includes("--check");

  if (checkMode) {
    if (!checkPostgresInitSync()) {
      console.error("PostgreSQL init.sql is out of date. Run `npm run db:postgres:init`.");
      process.exitCode = 1;
      return;
    }
    console.log("PostgreSQL init.sql is up to date.");
    return;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, rendered, "utf8");
  console.log(`Wrote ${targetPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
