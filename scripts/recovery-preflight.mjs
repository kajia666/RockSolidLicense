#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const SUPPORTED_TARGET_OS = new Set(["linux", "windows"]);
const SUPPORTED_STORAGE_PROFILES = new Set(["sqlite", "postgres-preview"]);

function parseArgs(argv) {
  const options = {
    json: false,
    targetOs: null,
    storageProfile: null,
    envFile: null,
    appBackupDir: null,
    postgresBackupDir: null,
    baseUrl: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }

    const [name, inlineValue] = arg.split("=", 2);
    const value = inlineValue ?? argv[index + 1];
    if (name === "--target-os") {
      options.targetOs = requireArgValue(name, value, inlineValue);
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }
    if (name === "--storage-profile") {
      options.storageProfile = requireArgValue(name, value, inlineValue);
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }
    if (name === "--target-env-file") {
      options.envFile = requireArgValue(name, value, inlineValue);
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }
    if (name === "--app-backup-dir") {
      options.appBackupDir = requireArgValue(name, value, inlineValue);
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }
    if (name === "--postgres-backup-dir") {
      options.postgresBackupDir = requireArgValue(name, value, inlineValue);
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }
    if (name === "--base-url") {
      options.baseUrl = requireArgValue(name, value, inlineValue);
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return normalizeOptions(options);
}

function requireArgValue(name, value, inlineValue) {
  const missingValue = value === undefined
    || value === null
    || String(value).trim() === ""
    || (inlineValue === undefined && String(value).startsWith("--"));
  if (missingValue) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function readOptionOrEnv(value, envName) {
  const resolved = value ?? process.env[envName] ?? null;
  return resolved === null ? null : String(resolved).trim();
}

function normalizeOptions(options) {
  const targetOs = String(readOptionOrEnv(options.targetOs, "RSL_RECOVERY_TARGET_OS") || "").trim().toLowerCase();
  const storageProfile = String(readOptionOrEnv(options.storageProfile, "RSL_RECOVERY_STORAGE_PROFILE") || "").trim().toLowerCase();
  const defaultEnvFile = targetOs === "windows"
    ? "C:\\RockSolidLicense\\deploy\\windows\\rocksolid.env.ps1"
    : "/etc/rocksolidlicense/rocksolid.env";
  const defaultAppBackupDir = targetOs === "windows"
    ? "C:\\RockSolidLicense\\backups"
    : "/var/lib/rocksolid/backups";
  const defaultPostgresBackupDir = targetOs === "windows"
    ? "C:\\RockSolidLicense\\postgres-backups"
    : "/var/lib/rocksolid/postgres-backups";

  return {
    json: options.json,
    targetOs,
    storageProfile,
    envFile: readOptionOrEnv(options.envFile, "RSL_RECOVERY_ENV_FILE") || defaultEnvFile,
    appBackupDir: readOptionOrEnv(options.appBackupDir, "RSL_RECOVERY_APP_BACKUP_DIR") || defaultAppBackupDir,
    postgresBackupDir: readOptionOrEnv(options.postgresBackupDir, "RSL_RECOVERY_POSTGRES_BACKUP_DIR") || defaultPostgresBackupDir,
    baseUrl: readOptionOrEnv(options.baseUrl, "RSL_RECOVERY_BASE_URL") || "http://127.0.0.1:3000"
  };
}

function makeCheck(name, passed, message) {
  return {
    name,
    status: passed ? "pass" : "fail",
    message
  };
}

function requiredAssetsFor(options) {
  if (options.targetOs === "linux") {
    const assets = [
      "deploy/linux/backup-rocksolid.sh",
      "deploy/linux/healthcheck-rocksolid.sh"
    ];
    if (options.storageProfile === "postgres-preview") {
      assets.push(
        "deploy/postgres/backup-postgres.sh",
        "deploy/postgres/restore-postgres.sh",
        "deploy/systemd/rocksolid-postgres-backup.timer",
        "docs/postgres-backup-restore.md"
      );
    }
    assets.push("docs/production-operations-runbook.md");
    return assets;
  }

  if (options.targetOs === "windows") {
    const assets = [
      "deploy/windows/backup-rocksolid.ps1",
      "deploy/windows/healthcheck-rocksolid.ps1"
    ];
    if (options.storageProfile === "postgres-preview") {
      assets.push(
        "deploy/postgres/backup-postgres.ps1",
        "deploy/postgres/restore-postgres.ps1",
        "deploy/windows/register-rocksolid-postgres-backup-task.ps1",
        "docs/postgres-backup-restore.md"
      );
    }
    assets.push("docs/production-operations-runbook.md");
    return assets;
  }

  return [];
}

function validateOptions(options) {
  const checks = [];
  checks.push(makeCheck(
    "target-os.supported",
    SUPPORTED_TARGET_OS.has(options.targetOs),
    "Use --target-os linux or --target-os windows."
  ));
  checks.push(makeCheck(
    "storage-profile.supported",
    SUPPORTED_STORAGE_PROFILES.has(options.storageProfile),
    "Use --storage-profile sqlite or --storage-profile postgres-preview."
  ));
  checks.push(makeCheck(
    "env-file.present",
    Boolean(options.envFile),
    "Pass --env-file for the staging target environment file path."
  ));
  checks.push(makeCheck(
    "app-backup-dir.present",
    Boolean(options.appBackupDir),
    "Pass --app-backup-dir for the staging target app backup directory."
  ));
  checks.push(makeCheck(
    "postgres-backup-dir.present",
    options.storageProfile !== "postgres-preview" || Boolean(options.postgresBackupDir),
    "Pass --postgres-backup-dir for PostgreSQL preview recovery rehearsal."
  ));

  const requiredAssets = requiredAssetsFor(options).map((assetPath) => ({
    path: assetPath,
    exists: fs.existsSync(path.join(repoRoot, assetPath))
  }));
  for (const asset of requiredAssets) {
    checks.push(makeCheck(
      `asset.${asset.path}`,
      asset.exists,
      `Required recovery rehearsal asset is missing: ${asset.path}`
    ));
  }

  return { checks, requiredAssets };
}

function shellQuote(value) {
  return String(value).replace(/"/g, '\\"');
}

function powershellQuote(value) {
  return String(value).replace(/'/g, "''");
}

function buildLinuxCommands(options) {
  const appBackup = `ENV_FILE="${shellQuote(options.envFile)}" BACKUP_DIR="${shellQuote(options.appBackupDir)}" LABEL=rehearsal deploy/linux/backup-rocksolid.sh`;
  const healthcheck = `BASE_URL="${shellQuote(options.baseUrl)}" deploy/linux/healthcheck-rocksolid.sh --skip-tcp`;
  if (options.storageProfile !== "postgres-preview") {
    return {
      appBackup,
      postgresBackup: null,
      postgresRestoreDryRun: null,
      restoreDrillReminder: "Restore the app archive only on a separate restore target; never overwrite staging before the archive is inspected.",
      healthcheck
    };
  }

  return {
    appBackup,
    postgresBackup: `ENV_FILE="${shellQuote(options.envFile)}" BACKUP_DIR="${shellQuote(options.postgresBackupDir)}" LABEL=rehearsal deploy/postgres/backup-postgres.sh`,
    postgresRestoreDryRun: `BACKUP_FILE="$BACKUP_FILE" ENV_FILE="${shellQuote(options.envFile)}" deploy/postgres/restore-postgres.sh --file $BACKUP_FILE --no-clean`,
    restoreDrillReminder: "Set BACKUP_FILE to a copied PostgreSQL dump on a separate restore target before running restore-postgres.sh.",
    healthcheck
  };
}

function buildWindowsCommands(options) {
  const appBackup = `powershell -ExecutionPolicy Bypass -File .\\deploy\\windows\\backup-rocksolid.ps1 -EnvScriptPath '${powershellQuote(options.envFile)}' -BackupRoot '${powershellQuote(options.appBackupDir)}' -Label rehearsal`;
  const healthcheck = `powershell -ExecutionPolicy Bypass -File .\\deploy\\windows\\healthcheck-rocksolid.ps1 -BaseUrl '${powershellQuote(options.baseUrl)}' -SkipTcp`;
  if (options.storageProfile !== "postgres-preview") {
    return {
      appBackup,
      postgresBackup: null,
      postgresRestoreDryRun: null,
      restoreDrillReminder: "Restore the app archive only on a separate restore target; never overwrite staging before the archive is inspected.",
      healthcheck
    };
  }

  return {
    appBackup,
    postgresBackup: `powershell -ExecutionPolicy Bypass -File .\\deploy\\postgres\\backup-postgres.ps1 -EnvScriptPath '${powershellQuote(options.envFile)}' -BackupRoot '${powershellQuote(options.postgresBackupDir)}' -Label rehearsal`,
    postgresRestoreDryRun: "powershell -ExecutionPolicy Bypass -File .\\deploy\\postgres\\restore-postgres.ps1 -BackupPath $env:BACKUP_FILE -EnvScriptPath '" + powershellQuote(options.envFile) + "' -SkipClean",
    restoreDrillReminder: "Set $env:BACKUP_FILE to a copied PostgreSQL dump on a separate restore target before running restore-postgres.ps1.",
    healthcheck
  };
}

function buildNextCommands(options) {
  if (options.targetOs === "windows") {
    return buildWindowsCommands(options);
  }
  return buildLinuxCommands(options);
}

function buildResult(options) {
  const { checks, requiredAssets } = validateOptions(options);
  const failedChecks = checks.filter((item) => item.status === "fail");
  const status = failedChecks.length === 0 ? "pass" : "fail";
  return {
    status,
    mode: "recovery-preflight",
    generatedAt: new Date().toISOString(),
    summary: {
      targetOs: options.targetOs,
      storageProfile: options.storageProfile,
      checksPassed: checks.length - failedChecks.length,
      checksFailed: failedChecks.length,
      willModifyData: false
    },
    requiredAssets,
    checks,
    ...(status === "pass"
      ? { nextCommands: buildNextCommands(options) }
      : { error: { message: failedChecks[0]?.message || "Recovery preflight failed." } })
  };
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.status === "pass") {
    console.log("Recovery preflight passed. No data was modified.");
    console.log(`App backup: ${result.nextCommands.appBackup}`);
    if (result.nextCommands.postgresBackup) {
      console.log(`PostgreSQL backup: ${result.nextCommands.postgresBackup}`);
      console.log(`PostgreSQL restore drill: ${result.nextCommands.postgresRestoreDryRun}`);
    }
    console.log(`Healthcheck: ${result.nextCommands.healthcheck}`);
    return;
  }

  console.error(`Recovery preflight failed: ${result.error.message}`);
  for (const check of result.checks) {
    console.error(`- ${check.status.toUpperCase()} ${check.name}: ${check.message}`);
  }
}

function main() {
  let json = process.argv.includes("--json");
  try {
    const options = parseArgs(process.argv.slice(2));
    json = options.json;
    const result = buildResult(options);
    writeResult(result, json);
    if (result.status !== "pass") {
      process.exitCode = 1;
    }
  } catch (error) {
    const result = {
      status: "fail",
      mode: "recovery-preflight",
      generatedAt: new Date().toISOString(),
      summary: {
        willModifyData: false
      },
      requiredAssets: [],
      error: {
        message: error.message
      },
      checks: []
    };
    writeResult(result, json);
    process.exitCode = 1;
  }
}

main();
