#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const SECRET_FLAGS = new Set([
  "--admin-password",
  "--developer-password",
  "--developer-bearer-token",
  "--bearer-token",
  "--token",
  "--password"
]);

const OPTION_FLAGS = {
  "--base-url": "baseUrl",
  "--product-code": "productCode",
  "--channel": "channel",
  "--admin-username": "adminUsername",
  "--developer-username": "developerUsername",
  "--target-os": "targetOs",
  "--storage-profile": "storageProfile",
  "--target-env-file": "targetEnvFile",
  "--app-backup-dir": "appBackupDir",
  "--postgres-backup-dir": "postgresBackupDir",
  "--output-file": "outputFile"
};

const REQUIRED_FIELDS = [
  "baseUrl",
  "productCode",
  "adminUsername",
  "developerUsername",
  "targetOs",
  "storageProfile",
  "targetEnvFile",
  "appBackupDir"
];

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
    channel: "stable"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }

    const [name, inlineValue] = arg.split("=", 2);
    if (SECRET_FLAGS.has(name)) {
      throw new Error(`${name} secret values are not accepted in staging profiles. Use environment variables when running staging:rehearsal.`);
    }
    const key = OPTION_FLAGS[name];
    if (!key) {
      throw new Error(`Unknown option: ${name}`);
    }
    const value = inlineValue ?? argv[index + 1];
    options[key] = requireArgValue(name, value, inlineValue);
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  const missingFields = REQUIRED_FIELDS.filter((key) => !options[key]);
  if (options.storageProfile === "postgres-preview" && !options.postgresBackupDir) {
    missingFields.push("postgresBackupDir");
  }
  if (missingFields.length) {
    throw new Error(`Missing required staging profile field(s): ${missingFields.join(", ")}`);
  }
  return options;
}

function sanitizeArtifactSegment(value, fallback) {
  const normalized = String(value || fallback || "default")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback || "default";
}

function commandValue(value) {
  const text = String(value || "");
  if (/[\s"`]/.test(text)) {
    return `"${text.replace(/"/g, "`\"")}"`;
  }
  return text;
}

function buildProfile(options) {
  const productCode = sanitizeArtifactSegment(options.productCode, "product");
  const channel = sanitizeArtifactSegment(options.channel || "stable", "stable");
  const archiveRoot = path.posix.join("artifacts", "staging", productCode, channel);
  const profile = {
    baseUrl: options.baseUrl,
    productCode: options.productCode,
    channel: options.channel || "stable",
    adminUsername: options.adminUsername,
    developerUsername: options.developerUsername,
    targetOs: options.targetOs,
    storageProfile: options.storageProfile,
    targetEnvFile: options.targetEnvFile,
    appBackupDir: options.appBackupDir
  };
  if (options.postgresBackupDir) {
    profile.postgresBackupDir = options.postgresBackupDir;
  }
  return {
    archiveRoot,
    profile: {
      ...profile,
      handoffFile: path.posix.join(archiveRoot, "staging-rehearsal-handoff.md"),
      closeoutFile: path.posix.join(archiveRoot, "staging-closeout-template.json"),
      runRecordFile: path.posix.join(archiveRoot, "staging-run-record-index.json"),
      artifactManifestFile: path.posix.join(archiveRoot, "staging-artifact-manifest.json"),
      backupRestorePacketFile: path.posix.join(archiveRoot, "staging-backup-restore-drill-packet.json"),
      closeoutReloadPacketFile: path.posix.join(archiveRoot, "staging-closeout-reload-packet.json"),
      readinessReviewPacketFile: path.posix.join(archiveRoot, "staging-readiness-review-packet.json"),
      productionSignoffPacketFile: path.posix.join(archiveRoot, "staging-production-signoff-packet.json"),
      launchDutyArchiveIndexFile: path.posix.join(archiveRoot, "staging-launch-duty-archive-index.json"),
      filledCloseoutDraftFile: path.posix.join(archiveRoot, "filled-closeout-input.draft.json"),
      readinessActionQueueFile: path.posix.join(archiveRoot, "readiness-action-queue.md")
    }
  };
}

function buildOperatorNextCommands({ outputFile, closeoutInputFile, readinessActionQueueFile, nextCommand, closeoutInitCommand, postCloseoutInitStatusCommand }) {
  return [
    {
      key: "profile_rehearsal",
      status: "current",
      command: nextCommand,
      artifactPath: outputFile,
      nextAction: "Run the profile-driven rehearsal to write launch-duty artifacts and the closeout draft."
    },
    {
      key: "closeout_init",
      status: "blocked_after_profile_rehearsal",
      command: closeoutInitCommand,
      artifactPath: closeoutInputFile,
      nextAction: "Promote the generated closeout draft into the real filled closeout input."
    },
    {
      key: "readiness_status",
      status: "blocked_after_closeout_init",
      command: postCloseoutInitStatusCommand,
      artifactPath: readinessActionQueueFile,
      nextAction: "Refresh the readiness action queue after closeout init."
    }
  ];
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.status === "written") {
    console.log(`Staging profile written: ${result.outputFile}`);
    const currentCommand = result.operatorNextCommands?.find((item) => item.status === "current");
    const closeoutInit = result.operatorNextCommands?.find((item) => item.key === "closeout_init");
    const readinessStatus = result.operatorNextCommands?.find((item) => item.key === "readiness_status");
    if (currentCommand) {
      console.log(`Current command: ${currentCommand.command}`);
    } else {
      console.log(result.nextCommand);
    }
    if (closeoutInit) {
      console.log(`Closeout init: ${closeoutInit.command}`);
    } else {
      console.log(result.closeoutInitCommand);
    }
    if (readinessStatus) {
      console.log(`Readiness status: ${readinessStatus.command}`);
      if (readinessStatus.artifactPath) {
        console.log(`Action queue file: ${readinessStatus.artifactPath}`);
      }
    } else {
      console.log(result.postCloseoutInitStatusCommand);
    }
    console.log(`Next action: ${result.nextAction}`);
    return;
  }
  console.log(`Staging profile init failed: ${result.error.message}`);
}

function main() {
  const json = process.argv.includes("--json");
  try {
    const options = parseArgs(process.argv.slice(2));
    const { archiveRoot, profile } = buildProfile(options);
    const closeoutDraftFile = profile.filledCloseoutDraftFile;
    const closeoutInputFile = path.posix.join(archiveRoot, "filled-closeout-input.json");
    const readinessActionQueueFile = profile.readinessActionQueueFile;
    const outputFile = options.outputFile
      ? path.resolve(options.outputFile)
      : path.resolve("artifacts", "staging", sanitizeArtifactSegment(options.productCode, "product"), sanitizeArtifactSegment(options.channel || "stable", "stable"), "staging-rehearsal-profile.json");
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    const nextCommand = `npm.cmd run staging:rehearsal -- --profile-file ${commandValue(outputFile)}`;
    const closeoutInitCommand = `npm.cmd run staging:closeout:init -- --draft-file ${commandValue(closeoutDraftFile)} --output-file ${commandValue(closeoutInputFile)} --actions-file ${commandValue(readinessActionQueueFile)}`;
    const postCloseoutInitStatusCommand = `npm.cmd run staging:readiness:status -- --input-file ${commandValue(closeoutInputFile)} --actions-file ${commandValue(readinessActionQueueFile)}`;
    writeResult({
      status: "written",
      mode: "staging-profile-init",
      outputFile,
      productCode: profile.productCode,
      channel: profile.channel,
      archiveRoot,
      profileKeyCount: Object.keys(profile).length,
      secretPolicy: "passwords_and_bearer_tokens_must_stay_in_environment_variables",
      nextCommand,
      closeoutDraftFile,
      closeoutInputFile,
      readinessActionQueueFile,
      closeoutInitCommand,
      postCloseoutInitStatusCommand,
      operatorNextCommands: buildOperatorNextCommands({
        outputFile,
        closeoutInputFile,
        readinessActionQueueFile,
        nextCommand,
        closeoutInitCommand,
        postCloseoutInitStatusCommand
      }),
      nextAction: "Review the secret-free profile values, set required secret env vars, run nextCommand, then run closeoutInitCommand after the draft is written."
    }, options.json);
  } catch (error) {
    writeResult({
      status: "fail",
      mode: "staging-profile-init",
      error: {
        message: error.message
      }
    }, json);
    process.exitCode = 1;
  }
}

main();
