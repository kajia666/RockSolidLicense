#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";

const REQUIRED_FIELDS = [
  "baseUrl",
  "productCode",
  "channel",
  "adminUsername",
  "developerUsername",
  "targetOs",
  "storageProfile",
  "targetEnvFile",
  "appBackupDir",
  "readinessActionQueueFile",
  "productionProofExecutionPackFile",
  "productionProofPreflightCommand"
];

const SUPPORTED_TARGET_OS = new Set(["linux", "windows"]);
const SUPPORTED_STORAGE_PROFILES = new Set(["sqlite", "postgres-preview"]);
const SECRET_FIELD_PATTERN = /(password|bearer.*token|token|secret)/i;
const SECRET_ENV_FIELD_PATTERN = /env(?:name)?$/i;

function requireArgValue(name, value, inlineValue) {
  const missingValue = value === undefined
    || value === null
    || String(value).trim() === ""
    || (inlineValue === undefined && String(value).startsWith("--"));
  if (missingValue) {
    throw new Error(`${name} requires a value.`);
  }
  return String(value).trim();
}

function parseArgs(argv) {
  const options = {
    json: false,
    profileFile: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const [name, inlineValue] = arg.split("=", 2);
    if (name !== "--profile-file") {
      throw new Error(`Unknown option: ${name}`);
    }
    options.profileFile = requireArgValue(name, inlineValue ?? argv[index + 1], inlineValue);
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  if (!options.help && !options.profileFile) {
    throw new Error("--profile-file is required.");
  }
  return options;
}

function commandValue(value) {
  const text = String(value || "");
  if (/[\s"`]/.test(text)) {
    return `"${text.replace(/"/g, "`\"")}"`;
  }
  return text;
}

function buildProductionProofPreflightCommand(profileFile) {
  return [
    "npm.cmd run launch:production-proof-preflight --",
    "--profile-file",
    commandValue(profileFile)
  ].join(" ");
}

function buildLegacyProductionProofPreflightCommand(profileFile, executionPackFile) {
  return [
    buildProductionProofPreflightCommand(profileFile),
    "--execution-pack-file",
    commandValue(executionPackFile)
  ].join(" ");
}

function buildSiblingArtifactPath(filePath, nextFileName) {
  const normalized = String(filePath || "").trim().replace(/\\/g, "/");
  const lastSlashIndex = normalized.lastIndexOf("/");
  return lastSlashIndex < 0
    ? nextFileName
    : `${normalized.slice(0, lastSlashIndex + 1)}${nextFileName}`;
}

function readProfile(profileFile) {
  const resolvedPath = path.resolve(profileFile);
  let profile = null;
  try {
    profile = JSON.parse(readFileSync(resolvedPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read --profile-file ${resolvedPath}: ${error.message}`);
  }
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error(`--profile-file ${resolvedPath} must be a JSON object.`);
  }
  return profile;
}

function findSecretFieldKeys(value, prefix = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, nestedValue]) => {
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    const secretField = SECRET_FIELD_PATTERN.test(key)
      && !SECRET_ENV_FIELD_PATTERN.test(key)
      && nestedValue !== null
      && String(nestedValue).trim() !== "";
    return [
      ...(secretField ? [fieldPath] : []),
      ...findSecretFieldKeys(nestedValue, fieldPath)
    ];
  });
}

function makeCheck(name, passed, message) {
  return {
    name,
    status: passed ? "pass" : "fail",
    message
  };
}

function validateProfile(profileFile, profile) {
  const missingRequiredKeys = REQUIRED_FIELDS.filter((key) => {
    const value = profile[key];
    return value === undefined || value === null || String(value).trim() === "";
  });
  if (profile.storageProfile === "postgres-preview" && !profile.postgresBackupDir) {
    missingRequiredKeys.push("postgresBackupDir");
  }
  const secretFieldKeys = findSecretFieldKeys(profile);
  const expectedExecutionPackFile = buildSiblingArtifactPath(
    profile.readinessActionQueueFile,
    "production-proof-execution-pack.md"
  );
  const productionProofCommand = String(profile.productionProofPreflightCommand || "").trim();
  const expectedProductionProofCommand = buildProductionProofPreflightCommand(profileFile);
  const legacyProductionProofCommand = productionProofCommand === buildLegacyProductionProofPreflightCommand(
    profileFile,
    profile.productionProofExecutionPackFile
  );
  const productionProofCommandReady = productionProofCommand === expectedProductionProofCommand
    || legacyProductionProofCommand;
  const httpsReady = (() => {
    try {
      return new URL(profile.baseUrl).protocol === "https:";
    } catch {
      return false;
    }
  })();
  const checks = [
    makeCheck(
      "required_profile_fields",
      missingRequiredKeys.length === 0,
      missingRequiredKeys.length
        ? `Missing required profile key(s): ${missingRequiredKeys.join(", ")}.`
        : "Required profile fields are present."
    ),
    makeCheck(
      "secret_free_profile",
      secretFieldKeys.length === 0,
      secretFieldKeys.length
        ? `Secret values must stay in environment variables. Remove profile field(s): ${secretFieldKeys.join(", ")}.`
        : "Profile contains no secret values."
    ),
    makeCheck("public_https_base_url", httpsReady, "baseUrl must be a public HTTPS URL."),
    makeCheck(
      "supported_target_os",
      SUPPORTED_TARGET_OS.has(String(profile.targetOs || "").trim().toLowerCase()),
      "targetOs must be linux or windows."
    ),
    makeCheck(
      "supported_storage_profile",
      SUPPORTED_STORAGE_PROFILES.has(String(profile.storageProfile || "").trim().toLowerCase()),
      "storageProfile must be sqlite or postgres-preview."
    ),
    makeCheck(
      "production_proof_execution_pack_path",
      profile.productionProofExecutionPackFile === expectedExecutionPackFile,
      `productionProofExecutionPackFile must be ${expectedExecutionPackFile}.`
    ),
    makeCheck(
      "production_proof_short_command",
      productionProofCommandReady,
      "productionProofPreflightCommand must use the single-argument --profile-file handoff."
    )
  ];
  const failedChecks = checks.filter((item) => item.status === "fail");
  const executionPackFile = profile.productionProofExecutionPackFile || expectedExecutionPackFile;
  return {
    status: failedChecks.length ? "fail" : "pass",
    mode: "staging-profile-check",
    summary: {
      checksPassed: checks.length - failedChecks.length,
      checksFailed: failedChecks.length,
      secretFree: secretFieldKeys.length === 0,
      willWriteLiveData: false,
      willModifyData: false,
      missingRequiredKeys,
      secretFieldKeys,
      legacyProductionProofCommand
    },
    checks,
    productionProofExecutionPackFile: executionPackFile,
    nextCommand: buildProductionProofPreflightCommand(profileFile),
    nextAction: failedChecks.length
      ? failedChecks[0].message
      : "Set required secret env vars, run nextCommand, then execute the no-write recovery and staging preflight steps before the manual live-write smoke gate.",
    ...(failedChecks.length
      ? { error: { message: failedChecks[0].message } }
      : {})
  };
}

function writeHelp() {
  console.log([
    "Usage: npm.cmd run staging:profile:check -- --profile-file <staging-profile.json>",
    "",
    "Validates the secret-free real-like staging profile before production proof execution.",
    "This command does not load secrets, write files, or modify live data."
  ].join("\n"));
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const writeLine = result.status === "pass" ? console.log : console.error;
  writeLine(`Staging profile check ${result.status === "pass" ? "passed" : "failed"}. No data was modified.`);
  for (const check of result.checks || []) {
    writeLine(`- ${check.status.toUpperCase()} ${check.name}: ${check.message}`);
  }
  writeLine(`Next command: ${result.nextCommand || "-"}`);
}

function main() {
  let json = process.argv.includes("--json");
  try {
    const options = parseArgs(process.argv.slice(2));
    json = options.json;
    if (options.help) {
      writeHelp();
      return;
    }
    const result = validateProfile(options.profileFile, readProfile(options.profileFile));
    writeResult(result, json);
    if (result.status !== "pass") {
      process.exitCode = 1;
    }
  } catch (error) {
    const result = {
      status: "fail",
      mode: "staging-profile-check",
      error: {
        message: error.message
      }
    };
    writeResult(result, json);
    process.exitCode = 1;
  }
}

main();
