import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkPostgresInitSync, renderPostgresInit, targetPath } from "../scripts/render-postgres-init.mjs";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..");

test("postgres init script stays in sync with the sqlite schema", () => {
  assert.equal(checkPostgresInitSync(), true);
  assert.equal(fs.readFileSync(targetPath, "utf8"), renderPostgresInit());
});

test("postgres init artifact includes expected schema primitives", () => {
  const initSqlPath = path.join(repoRoot, "deploy", "postgres", "init.sql");
  const sql = fs.readFileSync(initSqlPath, "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS products \(/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS sessions \(/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS audit_logs \(/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_network_rules_lookup/);
  assert.match(sql, /\bTIMESTAMPTZ\b/);
  assert.match(sql, /\bJSONB\b/);
  assert.match(sql, /\bBOOLEAN\b/);
  assert.doesNotMatch(sql, /\bPRAGMA\b/);
});
