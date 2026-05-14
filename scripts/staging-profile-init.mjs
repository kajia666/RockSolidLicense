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

function buildRecoveryPreflightCommand({ options, closeoutInputFile, readinessActionQueueFile }) {
  const parts = [
    "npm.cmd run recovery:preflight --",
    "--target-os",
    commandValue(options.targetOs),
    "--storage-profile",
    commandValue(options.storageProfile),
    "--target-env-file",
    commandValue(options.targetEnvFile),
    "--app-backup-dir",
    commandValue(options.appBackupDir)
  ];
  if (options.postgresBackupDir) {
    parts.push("--postgres-backup-dir", commandValue(options.postgresBackupDir));
  }
  parts.push(
    "--base-url",
    commandValue(options.baseUrl),
    "--product-code",
    commandValue(options.productCode),
    "--channel",
    commandValue(options.channel || "stable"),
    "--closeout-input-file",
    commandValue(closeoutInputFile),
    "--actions-file",
    commandValue(readinessActionQueueFile)
  );
  return parts.join(" ");
}

function buildRouteMapGateCommand({ options, closeoutInputFile, readinessActionQueueFile, dryRun = false }) {
  const parts = ["npm.cmd run launch:route-map-gate --"];
  if (dryRun) {
    parts.push("--dry-run", "--json");
  }
  parts.push(
    "--product-code",
    commandValue(options.productCode),
    "--channel",
    commandValue(options.channel || "stable"),
    "--staging-base-url",
    commandValue(options.baseUrl),
    "--closeout-input-file",
    commandValue(closeoutInputFile),
    "--actions-file",
    commandValue(readinessActionQueueFile)
  );
  return parts.join(" ");
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

function buildOperatorNextCommands({
  outputFile,
  closeoutInputFile,
  readinessActionQueueFile,
  backupRestoreArtifactFile,
  nextCommand,
  closeoutInitCommand,
  postCloseoutInitStatusCommand,
  recoveryPreflightCommand,
  routeMapGateDryRunCommand,
  routeMapGateCommand,
  routeMapGateDryRunFile,
  routeMapGateOutputFile
}) {
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
    },
    {
      key: "recovery_preflight",
      status: "blocked_after_readiness_status",
      command: recoveryPreflightCommand,
      artifactPath: backupRestoreArtifactFile,
      nextAction: "Run recovery preflight to print backup/restore commands and the backup_restore_drill_result closeout backfill handoff."
    },
    {
      key: "route_map_gate_dry_run",
      status: "blocked_after_recovery_preflight",
      command: routeMapGateDryRunCommand,
      artifactPath: routeMapGateDryRunFile,
      nextAction: "Review the route-map gate dry-run queue before running the targeted gate."
    },
    {
      key: "route_map_gate",
      status: "blocked_after_route_map_gate_dry_run",
      command: routeMapGateCommand,
      artifactPath: routeMapGateOutputFile,
      nextAction: "Run the targeted route-map gate, save its output, then follow the route-map operator queue from route_map_gate_result backfill onward."
    }
  ];
}

function buildLaunchLaneFiles({
  archiveRoot,
  outputFile,
  profile,
  closeoutInputFile,
  readinessActionQueueFile,
  backupRestoreArtifactFile,
  routeMapGateDryRunFile,
  routeMapGateOutputFile
}) {
  return {
    archiveRoot,
    profileFile: outputFile,
    closeoutDraftFile: profile.filledCloseoutDraftFile,
    closeoutInputFile,
    readinessActionQueueFile,
    backupRestoreArtifactFile,
    routeMapGateDryRunFile,
    routeMapGateOutputFile,
    handoffFile: profile.handoffFile,
    launchDutyArchiveIndexFile: profile.launchDutyArchiveIndexFile,
    launchDutyRecordIndexFile: path.posix.join(archiveRoot, "launch-duty-record-index.json"),
    nextAction: "Use these paths for the first real staging rehearsal, closeout init, readiness refresh, backup/restore evidence, and route-map gate handoff."
  };
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.status === "written") {
    console.log(`Staging profile written: ${result.outputFile}`);
    if (result.launchLaneFiles) {
      const files = result.launchLaneFiles;
      console.log(`Launch lane archive root: ${files.archiveRoot}`);
      console.log(`Launch lane profile: ${files.profileFile}`);
      console.log(`Launch lane closeout draft: ${files.closeoutDraftFile}`);
      console.log(`Launch lane closeout input: ${files.closeoutInputFile}`);
      console.log(`Launch lane action queue: ${files.readinessActionQueueFile}`);
      console.log(`Launch lane backup/restore artifact: ${files.backupRestoreArtifactFile}`);
      console.log(`Launch lane route-map dry run: ${files.routeMapGateDryRunFile}`);
      console.log(`Launch lane route-map output: ${files.routeMapGateOutputFile}`);
      console.log(`Launch lane record index: ${files.launchDutyRecordIndexFile}`);
    }
    const currentCommand = result.operatorNextCommands?.find((item) => item.status === "current");
    const closeoutInit = result.operatorNextCommands?.find((item) => item.key === "closeout_init");
    const readinessStatus = result.operatorNextCommands?.find((item) => item.key === "readiness_status");
    const recoveryPreflight = result.operatorNextCommands?.find((item) => item.key === "recovery_preflight");
    const routeMapGateDryRun = result.operatorNextCommands?.find((item) => item.key === "route_map_gate_dry_run");
    const routeMapGate = result.operatorNextCommands?.find((item) => item.key === "route_map_gate");
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
    if (recoveryPreflight) {
      console.log(`Recovery preflight: ${recoveryPreflight.command}`);
    }
    if (routeMapGateDryRun) {
      console.log(`Route-map gate dry run: ${routeMapGateDryRun.command}`);
    }
    if (routeMapGate) {
      console.log(`Route-map gate: ${routeMapGate.command}`);
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
    const backupRestoreArtifactFile = path.posix.join(archiveRoot, "backup-restore-drill.txt");
    const routeMapGateDryRunFile = path.posix.join(archiveRoot, "route-map-gate-dry-run.json");
    const routeMapGateOutputFile = path.posix.join(archiveRoot, "route-map-gate-output.txt");
    const outputFile = options.outputFile
      ? path.resolve(options.outputFile)
      : path.resolve("artifacts", "staging", sanitizeArtifactSegment(options.productCode, "product"), sanitizeArtifactSegment(options.channel || "stable", "stable"), "staging-rehearsal-profile.json");
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    const nextCommand = `npm.cmd run staging:rehearsal -- --profile-file ${commandValue(outputFile)}`;
    const closeoutInitCommand = `npm.cmd run staging:closeout:init -- --draft-file ${commandValue(closeoutDraftFile)} --output-file ${commandValue(closeoutInputFile)} --actions-file ${commandValue(readinessActionQueueFile)}`;
    const postCloseoutInitStatusCommand = `npm.cmd run staging:readiness:status -- --input-file ${commandValue(closeoutInputFile)} --actions-file ${commandValue(readinessActionQueueFile)}`;
    const recoveryPreflightCommand = buildRecoveryPreflightCommand({
      options,
      closeoutInputFile,
      readinessActionQueueFile
    });
    const routeMapGateDryRunCommand = buildRouteMapGateCommand({
      options,
      closeoutInputFile,
      readinessActionQueueFile,
      dryRun: true
    });
    const routeMapGateCommand = buildRouteMapGateCommand({
      options,
      closeoutInputFile,
      readinessActionQueueFile
    });
    const launchLaneFiles = buildLaunchLaneFiles({
      archiveRoot,
      outputFile,
      profile,
      closeoutInputFile,
      readinessActionQueueFile,
      backupRestoreArtifactFile,
      routeMapGateDryRunFile,
      routeMapGateOutputFile
    });
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
      launchLaneFiles,
      closeoutInitCommand,
      postCloseoutInitStatusCommand,
      recoveryPreflightCommand,
      routeMapGateDryRunCommand,
      routeMapGateCommand,
      operatorNextCommands: buildOperatorNextCommands({
        outputFile,
        closeoutInputFile,
        readinessActionQueueFile,
        backupRestoreArtifactFile,
        nextCommand,
        closeoutInitCommand,
        postCloseoutInitStatusCommand,
        recoveryPreflightCommand,
        routeMapGateDryRunCommand,
        routeMapGateCommand,
        routeMapGateDryRunFile,
        routeMapGateOutputFile
      }),
      nextAction: "Review the secret-free profile values, set required secret env vars, run nextCommand, then follow operatorNextCommands through closeout init, readiness status, recovery preflight, route-map gate dry run, and route-map gate."
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
