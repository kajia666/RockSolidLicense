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

function buildRouteMapGateBackfillCommand({ closeoutInputFile, readinessActionQueueFile, routeMapGateOutputFile }) {
  return [
    "npm.cmd run staging:closeout:backfill --",
    "--input-file",
    commandValue(closeoutInputFile),
    "--key",
    "route_map_gate_result",
    "--value-json",
    "<redacted-json>",
    "--artifact-path",
    commandValue(routeMapGateOutputFile),
    "--receipt-id",
    "<route-map-gate-receipt-id>",
    "--actions-file",
    commandValue(readinessActionQueueFile)
  ].join(" ");
}

function buildStagingSmokePreflightCommand(options) {
  return [
    "npm.cmd run staging:preflight --",
    "--base-url",
    commandValue(options.baseUrl),
    "--product-code",
    commandValue(options.productCode),
    "--channel",
    commandValue(options.channel || "stable")
  ].join(" ");
}

function buildLaunchSmokeStagingCommand({ options, closeoutInputFile, readinessActionQueueFile }) {
  return [
    "npm.cmd run launch:smoke:staging --",
    "--base-url",
    commandValue(options.baseUrl),
    "--allow-live-writes",
    "--product-code",
    commandValue(options.productCode),
    "--channel",
    commandValue(options.channel || "stable"),
    "--closeout-input-file",
    commandValue(closeoutInputFile),
    "--actions-file",
    commandValue(readinessActionQueueFile)
  ].join(" ");
}

function buildPostSmokeBackfillCommands({ closeoutInputFile, readinessActionQueueFile, artifactPaths }) {
  return [
    {
      key: "live_write_smoke_result",
      artifactPath: artifactPaths.launchSmokeOutputFile,
      receiptIds: ["<record_launch_rehearsal_run-receipt-id>"]
    },
    {
      key: "launch_smoke_handoff",
      artifactPath: artifactPaths.launchSmokeHandoffFile,
      receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"]
    },
    {
      key: "launch_mainline_evidence_receipts",
      artifactPath: artifactPaths.launchMainlineEvidenceReceiptsFile,
      receiptIds: ["<record_launch_rehearsal_run-receipt-id>"]
    },
    {
      key: "receipt_visibility_review",
      artifactPath: artifactPaths.receiptVisibilityReviewFile,
      receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"]
    }
  ].map((item) => ({
    ...item,
    command: [
      "npm.cmd run staging:closeout:backfill --",
      "--input-file",
      commandValue(closeoutInputFile),
      "--key",
      item.key,
      "--value-json",
      "<redacted-json>",
      "--artifact-path",
      commandValue(item.artifactPath),
      ...item.receiptIds.flatMap((receiptId) => ["--receipt-id", receiptId]),
      "--actions-file",
      commandValue(readinessActionQueueFile)
    ].join(" ")
  }));
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
  routeMapGateBackfillCommand,
  postRouteMapReadinessStatusCommand,
  smokePreflightCommand,
  launchSmokeStagingCommand,
  postSmokeBackfillCommands,
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
    },
    {
      key: "route_map_gate_result_backfill",
      status: "blocked_after_route_map_gate",
      command: routeMapGateBackfillCommand,
      artifactPath: routeMapGateOutputFile,
      nextAction: "Backfill route_map_gate_result after the targeted route-map gate passes."
    },
    {
      key: "post_route_map_readiness_status",
      status: "blocked_after_route_map_gate_result_backfill",
      command: postRouteMapReadinessStatusCommand,
      artifactPath: readinessActionQueueFile,
      nextAction: "Refresh readiness so the action queue reflects route_map_gate_result before smoke preflight."
    },
    {
      key: "staging_smoke_preflight",
      status: "blocked_after_post_route_map_readiness_status",
      command: smokePreflightCommand,
      artifactPath: null,
      nextAction: "Run no-write smoke preflight before any launch:smoke:staging live-write command."
    },
    {
      key: "run_launch_smoke_staging",
      status: "blocked_after_staging_smoke_preflight",
      command: launchSmokeStagingCommand,
      artifactPath: postSmokeBackfillCommands[0].artifactPath,
      nextAction: "Run live-write smoke only after the no-write preflight passes and smoke credentials are loaded."
    },
    {
      key: "backfill_post_smoke_live_write_smoke_result",
      status: "blocked_after_launch_smoke_staging",
      command: postSmokeBackfillCommands[0].command,
      artifactPath: postSmokeBackfillCommands[0].artifactPath,
      targetKey: postSmokeBackfillCommands[0].key,
      receiptIds: postSmokeBackfillCommands[0].receiptIds,
      nextAction: "Backfill the live_write_smoke_result closeout evidence after Launch Smoke writes the output artifact."
    },
    {
      key: "backfill_post_smoke_launch_smoke_handoff",
      status: "blocked_after_live_write_smoke_result",
      command: postSmokeBackfillCommands[1].command,
      artifactPath: postSmokeBackfillCommands[1].artifactPath,
      targetKey: postSmokeBackfillCommands[1].key,
      receiptIds: postSmokeBackfillCommands[1].receiptIds,
      nextAction: "Backfill the launch_smoke_handoff evidence after saving the smoke handoff JSON."
    },
    {
      key: "backfill_post_smoke_launch_mainline_evidence_receipts",
      status: "blocked_after_launch_smoke_handoff",
      command: postSmokeBackfillCommands[2].command,
      artifactPath: postSmokeBackfillCommands[2].artifactPath,
      targetKey: postSmokeBackfillCommands[2].key,
      receiptIds: postSmokeBackfillCommands[2].receiptIds,
      nextAction: "Backfill Launch Mainline evidence receipts after recording the first-wave evidence chain."
    },
    {
      key: "backfill_post_smoke_receipt_visibility_review",
      status: "blocked_after_launch_mainline_evidence_receipts",
      command: postSmokeBackfillCommands[3].command,
      artifactPath: postSmokeBackfillCommands[3].artifactPath,
      targetKey: postSmokeBackfillCommands[3].key,
      receiptIds: postSmokeBackfillCommands[3].receiptIds,
      nextAction: "Backfill receipt_visibility_review after the Launch Review, Launch Smoke, Developer Ops, and Launch Mainline receipt queue is visible."
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
  routeMapGateOutputFile,
  launchSmokeOutputFile,
  launchSmokeHandoffFile,
  launchMainlineEvidenceReceiptsFile,
  receiptVisibilityReviewFile
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
    launchSmokeOutputFile,
    launchSmokeHandoffFile,
    launchMainlineEvidenceReceiptsFile,
    receiptVisibilityReviewFile,
    handoffFile: profile.handoffFile,
    launchDutyArchiveIndexFile: profile.launchDutyArchiveIndexFile,
    launchDutyRecordIndexFile: path.posix.join(archiveRoot, "launch-duty-record-index.json"),
    nextAction: "Use these paths for the first real staging rehearsal, closeout init, readiness refresh, backup/restore evidence, route-map gate handoff, and launch smoke closeout backfills."
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
    const routeMapGateBackfill = result.operatorNextCommands?.find((item) => item.key === "route_map_gate_result_backfill");
    const postRouteMapReadinessStatus = result.operatorNextCommands?.find((item) => item.key === "post_route_map_readiness_status");
    const smokePreflight = result.operatorNextCommands?.find((item) => item.key === "staging_smoke_preflight");
    const launchSmokeStaging = result.operatorNextCommands?.find((item) => item.key === "run_launch_smoke_staging");
    const postSmokeBackfills = (result.operatorNextCommands || []).filter((item) => item.key?.startsWith("backfill_post_smoke_"));
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
    if (routeMapGateBackfill) {
      console.log(`Route-map result backfill: ${routeMapGateBackfill.command}`);
    }
    if (postRouteMapReadinessStatus) {
      console.log(`Post-route-map readiness status: ${postRouteMapReadinessStatus.command}`);
    }
    if (smokePreflight) {
      console.log(`Staging smoke preflight: ${smokePreflight.command}`);
    }
    if (launchSmokeStaging) {
      console.log(`Launch smoke staging: ${launchSmokeStaging.command}`);
    }
    if (postSmokeBackfills.length) {
      postSmokeBackfills.forEach((item, index) => {
        console.log(`Post-smoke backfill ${index + 1}. ${item.targetKey}: ${item.status} -> ${item.command}`);
      });
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
    const launchSmokeOutputFile = path.posix.join(archiveRoot, "live-write-smoke-output.json");
    const launchSmokeHandoffFile = path.posix.join(archiveRoot, "launch-smoke-handoff.json");
    const launchMainlineEvidenceReceiptsFile = path.posix.join(archiveRoot, "launch-mainline-evidence-receipts.json");
    const receiptVisibilityReviewFile = path.posix.join(archiveRoot, "receipt-visibility-review.txt");
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
    const routeMapGateBackfillCommand = buildRouteMapGateBackfillCommand({
      closeoutInputFile,
      readinessActionQueueFile,
      routeMapGateOutputFile
    });
    const postRouteMapReadinessStatusCommand = postCloseoutInitStatusCommand;
    const smokePreflightCommand = buildStagingSmokePreflightCommand(options);
    const launchSmokeStagingCommand = buildLaunchSmokeStagingCommand({
      options,
      closeoutInputFile,
      readinessActionQueueFile
    });
    const postSmokeBackfillCommands = buildPostSmokeBackfillCommands({
      closeoutInputFile,
      readinessActionQueueFile,
      artifactPaths: {
        launchSmokeOutputFile,
        launchSmokeHandoffFile,
        launchMainlineEvidenceReceiptsFile,
        receiptVisibilityReviewFile
      }
    });
    const launchLaneFiles = buildLaunchLaneFiles({
      archiveRoot,
      outputFile,
      profile,
      closeoutInputFile,
      readinessActionQueueFile,
      backupRestoreArtifactFile,
      routeMapGateDryRunFile,
      routeMapGateOutputFile,
      launchSmokeOutputFile,
      launchSmokeHandoffFile,
      launchMainlineEvidenceReceiptsFile,
      receiptVisibilityReviewFile
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
      routeMapGateBackfillCommand,
      postRouteMapReadinessStatusCommand,
      smokePreflightCommand,
      launchSmokeStagingCommand,
      postSmokeBackfillCommands,
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
        routeMapGateBackfillCommand,
        postRouteMapReadinessStatusCommand,
        smokePreflightCommand,
        launchSmokeStagingCommand,
        postSmokeBackfillCommands,
        routeMapGateDryRunFile,
        routeMapGateOutputFile
      }),
      nextAction: "Review the secret-free profile values, set required secret env vars, run nextCommand, then follow operatorNextCommands through closeout init, readiness status, recovery preflight, route-map gate, route-map result backfill, readiness refresh, smoke preflight, live-write smoke, and post-smoke closeout backfills."
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
