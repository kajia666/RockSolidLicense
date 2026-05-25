#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const OPTION_FLAGS = {
  "--draft-file": "draftFile",
  "--output-file": "outputFile",
  "--actions-file": "actionsFile"
};

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
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    const [name, inlineValue] = arg.split("=", 2);
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
  if (!options.draftFile) {
    throw new Error("--draft-file requires a value.");
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

function statusCommand(outputFile, actionsFile = null) {
  const actionsArg = actionsFile ? ` --actions-file ${commandValue(actionsFile)}` : "";
  return `npm.cmd run staging:readiness:status -- --input-file ${commandValue(outputFile)}${actionsArg}`;
}

function receiptIdArgs(receiptOperations = []) {
  return receiptOperations
    .filter(Boolean)
    .map((operation) => ` --receipt-id <${operation}-receipt-id>`)
    .join("");
}

function buildFirstBackfillCommand({ outputFile, target, actionsFile = null }) {
  if (!target?.key) {
    return null;
  }
  const artifactArg = target.artifactPath ? ` --artifact-path ${commandValue(target.artifactPath)}` : "";
  const actionsArg = actionsFile ? ` --actions-file ${commandValue(actionsFile)}` : "";
  return [
    "npm.cmd run staging:closeout:backfill --",
    `--input-file ${commandValue(outputFile)}`,
    `--key ${commandValue(target.key)}`,
    "--value-json <redacted-json>",
    artifactArg.trimStart(),
    receiptIdArgs(Array.isArray(target.receiptOperations) ? target.receiptOperations : []).trimStart(),
    actionsArg.trimStart()
  ].filter(Boolean).join(" ");
}

function buildOperatorNextCommands({
  outputFile,
  actionsFile,
  rehearsalCommand,
  readinessStatusCommand,
  firstBackfillCommand,
  firstBackfillArtifactPath
}) {
  const commands = [
    {
      key: "readiness_status",
      status: "current",
      command: readinessStatusCommand,
      artifactPath: actionsFile || null,
      nextAction: "Generate or refresh the readiness action queue before backfilling evidence."
    }
  ];
  if (firstBackfillCommand) {
    commands.push({
      key: "first_closeout_backfill",
      status: "blocked_after_readiness_status",
      command: firstBackfillCommand,
      artifactPath: firstBackfillArtifactPath || null,
      nextAction: "Backfill the first pending closeout evidence item after the readiness action queue is refreshed."
    });
  }
  commands.push(
    {
      key: "rehearsal_reload",
      status: firstBackfillCommand ? "blocked_after_first_closeout_backfill" : "blocked_after_readiness_status",
      command: rehearsalCommand,
      artifactPath: outputFile,
      nextAction: "Reload rehearsal after the current evidence backfill item is recorded."
    }
  );
  return commands;
}

function isFilledValue(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim() !== "";
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return true;
}

function buildEvidenceProgress({ acceptanceFields, statusCommand, outputFile, actionsFile }) {
  const fields = Array.isArray(acceptanceFields) ? acceptanceFields : [];
  const pendingFields = fields.filter((field) => !isFilledValue(field?.value));
  const currentTarget = pendingFields[0] || null;
  const receiptOperations = Array.isArray(currentTarget?.receiptOperations) ? currentTarget.receiptOperations : [];
  const firstBackfillCommand = buildFirstBackfillCommand({
    outputFile,
    target: currentTarget ? { ...currentTarget, receiptOperations } : null,
    actionsFile
  });
  return {
    status: pendingFields.length === 0 ? "filled" : "awaiting_real_evidence",
    requiredCount: fields.length,
    filledCount: fields.length - pendingFields.length,
    pendingCount: pendingFields.length,
    currentTarget: currentTarget
      ? {
        key: currentTarget.key || null,
        status: currentTarget.status || "pending_operator_entry",
        artifactPath: currentTarget.artifactPath || null,
        sourceStep: currentTarget.sourceStep || null,
        receiptOperations
      }
      : null,
    pendingKeys: pendingFields.map((field) => field.key).filter(Boolean),
    firstBackfillCommand,
    statusCommand,
    nextAction: firstBackfillCommand
      ? "Run statusCommand, then run firstBackfillCommand with real redacted evidence."
      : "Run statusCommand, then backfill the currentTarget with real redacted evidence."
  };
}

function buildFirstEvidenceBackfillHandoff({
  evidenceProgress,
  actionsFile,
  rehearsalCommand
}) {
  if (!evidenceProgress?.firstBackfillCommand || !evidenceProgress.currentTarget) {
    return null;
  }
  return {
    status: "ready_for_first_closeout_backfill",
    currentActionKey: "backfill_closeout_evidence",
    statusCommand: evidenceProgress.statusCommand,
    firstBackfillCommand: evidenceProgress.firstBackfillCommand,
    firstBackfillTarget: {
      key: evidenceProgress.currentTarget.key,
      artifactPath: evidenceProgress.currentTarget.artifactPath,
      sourceStep: evidenceProgress.currentTarget.sourceStep,
      receiptOperations: evidenceProgress.currentTarget.receiptOperations
    },
    actionQueueFile: actionsFile || null,
    reloadCommand: rehearsalCommand,
    nextAction: "Run statusCommand, then firstBackfillCommand with real redacted evidence before the rehearsal reload."
  };
}

function inferArchiveRoot(acceptanceFields) {
  const artifactPath = (Array.isArray(acceptanceFields) ? acceptanceFields : [])
    .map((field) => field?.artifactPath)
    .find((value) => typeof value === "string" && value.trim());
  if (!artifactPath) {
    return "artifacts/staging/<productCode>/<channel>";
  }
  const normalized = artifactPath.replace(/\\/g, "/");
  const dirname = path.posix.dirname(normalized);
  return dirname === "." ? "artifacts/staging/<productCode>/<channel>" : dirname;
}

function buildSignoffBackfillCommand({
  outputFile,
  actionsFile = null,
  keyFlag,
  key,
  artifactPath,
  receiptIds = [],
  decision = null
}) {
  const actionsArg = actionsFile ? ["--actions-file", commandValue(actionsFile)] : [];
  const decisionArg = decision ? ["--decision", decision] : [];
  return [
    "npm.cmd run staging:signoff:backfill --",
    "--input-file",
    commandValue(outputFile),
    keyFlag,
    key,
    "--value-json",
    "<redacted-json>",
    "--artifact-path",
    commandValue(artifactPath),
    ...receiptIds.flatMap((receiptId) => ["--receipt-id", receiptId]),
    ...decisionArg,
    ...actionsArg
  ].join(" ");
}

function buildLaunchDutyRecordCommand({
  outputFile,
  actionsFile = null,
  recordIndexFile,
  key,
  artifactPath,
  receiptIds = [],
  sourceRecords = []
}) {
  const actionsArg = actionsFile ? ["--actions-file", commandValue(actionsFile)] : [];
  return [
    "npm.cmd run staging:launch-duty:record --",
    "--closeout-input-file",
    commandValue(outputFile),
    "--key",
    key,
    "--artifact-path",
    commandValue(artifactPath),
    "--value-json",
    "<redacted-json>",
    ...receiptIds.flatMap((receiptId) => ["--receipt-id", receiptId]),
    ...sourceRecords.flatMap((record) => ["--source-record", commandValue(`${record.key}=${record.artifactPath}`)]),
    "--record-index-file",
    commandValue(recordIndexFile),
    ...actionsArg
  ].join(" ");
}

function buildLaunchEvidenceItem({
  order,
  key,
  type,
  status,
  artifactPath,
  command,
  receiptIds = [],
  sourceRecordKeys = []
}) {
  const item = {
    order,
    key,
    type,
    status,
    artifactPath,
    command,
    receiptIds: Array.isArray(receiptIds) ? receiptIds.slice() : []
  };
  if (Array.isArray(sourceRecordKeys) && sourceRecordKeys.length) {
    item.sourceRecordKeys = sourceRecordKeys.slice();
  }
  return item;
}

function productionSignoffConditionValue(closeoutInput, key) {
  const conditions = closeoutInput?.productionSignoff?.conditions;
  if (Array.isArray(conditions)) {
    const match = conditions.find((item) => item?.key === key || item?.conditionKey === key);
    return match?.value ?? match?.status ?? null;
  }
  if (conditions && typeof conditions === "object") {
    return conditions[key];
  }
  return null;
}

function receiptVisibilityLaneValue(closeoutInput, key) {
  const lanes = closeoutInput?.receiptVisibility;
  if (!lanes || typeof lanes !== "object" || Array.isArray(lanes)) {
    return null;
  }
  return lanes[key] ?? null;
}

function buildCloseoutInitLaunchEvidenceReadinessGate({
  closeoutInput,
  acceptanceFields,
  evidenceProgress,
  outputFile,
  actionsFile,
  statusCommand,
  reloadCommand
}) {
  const fields = Array.isArray(acceptanceFields) ? acceptanceFields : [];
  const archiveRoot = inferArchiveRoot(fields);
  const fieldByKey = new Map(fields.map((field) => [field?.key, field]));
  const closeoutKeys = [
    "route_map_gate_result",
    "backup_restore_drill_result",
    "live_write_smoke_result",
    "launch_smoke_handoff",
    "launch_mainline_evidence_receipts",
    "receipt_visibility_review",
    "operator_go_no_go"
  ];
  const signoffDefinitions = [
    {
      key: "full_test_window_passed",
      status: "blocked_after_full_test_window",
      artifactPath: path.posix.join(archiveRoot, "full-test-output.txt"),
      receiptIds: [],
      decision: "ready-for-production-signoff"
    },
    {
      key: "staging_artifacts_archived",
      status: "blocked_after_post_full_test_readiness_status",
      artifactPath: path.posix.join(archiveRoot, "staging-artifacts-archive.txt"),
      receiptIds: []
    },
    {
      key: "launch_mainline_receipts_visible",
      status: "blocked_after_staging_artifacts_archived",
      artifactPath: path.posix.join(archiveRoot, "launch-mainline-receipts-visible.json"),
      receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"]
    },
    {
      key: "launch_ops_overview_status_visible",
      status: "blocked_after_launch_mainline_receipts_visible",
      artifactPath: path.posix.join(archiveRoot, "launch-ops-overview-status-visible.json"),
      receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"]
    },
    {
      key: "backup_restore_drill_passed",
      status: "blocked_after_launch_ops_overview_status_visible",
      artifactPath: path.posix.join(archiveRoot, "backup-restore-drill.txt"),
      receiptIds: ["<record_recovery_drill-receipt-id>", "<record_backup_verification-receipt-id>"]
    },
    {
      key: "rollback_path_confirmed",
      status: "blocked_after_backup_restore_drill_passed",
      artifactPath: path.posix.join(archiveRoot, "rollback-path-confirmed.md"),
      receiptIds: ["<record_rollback_walkthrough-receipt-id>"]
    },
    {
      key: "operator_signoff_recorded",
      status: "blocked_after_rollback_path_confirmed",
      artifactPath: path.posix.join(archiveRoot, "operator-production-signoff.md"),
      receiptIds: []
    }
  ];
  const receiptDefinitions = [
    ["launchMainline", "blocked_after_operator_signoff_recorded", "launch-mainline-receipt-visibility.json"],
    ["launchReview", "blocked_after_launchMainline_receipt_visibility", "launch-review-receipt-visibility.json"],
    ["launchSmoke", "blocked_after_launchReview_receipt_visibility", "launch-smoke-receipt-visibility.json"],
    ["developerOps", "blocked_after_launchSmoke_receipt_visibility", "developer-ops-receipt-visibility.json"],
    ["launchOpsOverviewStatus", "blocked_after_developerOps_receipt_visibility", "launch-ops-overview-status-receipt-visibility.json"]
  ];
  const closeoutEvidenceItems = closeoutKeys.map((key, index) => {
    const field = fieldByKey.get(key) || {};
    const artifactPath = field.artifactPath || path.posix.join(archiveRoot, `${key}.txt`);
    const receiptOperations = Array.isArray(field.receiptOperations) ? field.receiptOperations : [];
    const receiptIds = receiptOperations.map((operation) => `<${operation}-receipt-id>`);
    return buildLaunchEvidenceItem({
      order: index + 1,
      key,
      type: "closeout_evidence",
      status: isFilledValue(field.value) ? "filled" : field.status || "pending_operator_entry",
      artifactPath,
      command: buildFirstBackfillCommand({
        outputFile,
        target: { key, artifactPath, receiptOperations },
        actionsFile
      }),
      receiptIds
    });
  });
  const productionSignoffEvidenceItems = signoffDefinitions.map((definition, index) => {
    const value = productionSignoffConditionValue(closeoutInput, definition.key);
    return buildLaunchEvidenceItem({
      order: index + 8,
      key: definition.key,
      type: "production_signoff_condition",
      status: isFilledValue(value) ? "filled" : definition.status,
      artifactPath: definition.artifactPath,
      command: buildSignoffBackfillCommand({
        outputFile,
        actionsFile,
        keyFlag: "--condition-key",
        key: definition.key,
        artifactPath: definition.artifactPath,
        receiptIds: definition.receiptIds,
        decision: definition.decision
      }),
      receiptIds: definition.receiptIds
    });
  });
  const receiptVisibilityEvidenceItems = receiptDefinitions.map(([key, status, fileName], index) => {
    const artifactPath = path.posix.join(archiveRoot, fileName);
    const value = receiptVisibilityLaneValue(closeoutInput, key);
    return buildLaunchEvidenceItem({
      order: index + 15,
      key,
      type: "receipt_visibility_lane",
      status: isFilledValue(value) ? "visible" : status,
      artifactPath,
      command: buildSignoffBackfillCommand({
        outputFile,
        actionsFile,
        keyFlag: "--receipt-lane",
        key,
        artifactPath,
        receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"]
      }),
      receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"]
    });
  });
  const launchDutyRecordIndexPath = path.posix.join(archiveRoot, "launch-duty-record-index.json");
  const launchDayWatchArtifact = path.posix.join(archiveRoot, "launch-day-watch-summary.md");
  const firstWaveCloseoutArtifact = path.posix.join(archiveRoot, "first-wave-closeout.md");
  const firstWaveSourceRecords = [
    { key: "first_wave_incident_log", artifactPath: path.posix.join(archiveRoot, "first-wave-incident-log.md") },
    { key: "rollback_signal_review", artifactPath: path.posix.join(archiveRoot, "rollback-signal-review.md") },
    { key: "stabilization_owner_handoff", artifactPath: path.posix.join(archiveRoot, "stabilization-owner-handoff.md") }
  ];
  const launchDutyEvidenceItems = [
    buildLaunchEvidenceItem({
      order: 20,
      key: "launch_day_watch_summary",
      type: "launch_duty_record",
      status: "blocked_after_production_signoff_readiness_status",
      artifactPath: launchDayWatchArtifact,
      command: buildLaunchDutyRecordCommand({
        outputFile,
        actionsFile,
        recordIndexFile: launchDutyRecordIndexPath,
        key: "launch_day_watch_summary",
        artifactPath: launchDayWatchArtifact,
        receiptIds: ["<record_cutover_walkthrough-receipt-id>", "<record_launch_day_readiness_review-receipt-id>"]
      }),
      receiptIds: ["<record_cutover_walkthrough-receipt-id>", "<record_launch_day_readiness_review-receipt-id>"]
    }),
    buildLaunchEvidenceItem({
      order: 21,
      key: "first_wave_closeout",
      type: "launch_duty_record",
      status: "blocked_until_source_records",
      artifactPath: firstWaveCloseoutArtifact,
      command: buildLaunchDutyRecordCommand({
        outputFile,
        actionsFile,
        recordIndexFile: launchDutyRecordIndexPath,
        key: "first_wave_closeout",
        artifactPath: firstWaveCloseoutArtifact,
        receiptIds: ["<record_launch_closeout_review-receipt-id>"],
        sourceRecords: firstWaveSourceRecords
      }),
      receiptIds: ["<record_launch_closeout_review-receipt-id>"],
      sourceRecordKeys: firstWaveSourceRecords.map((record) => record.key)
    })
  ];
  const evidenceItems = [
    ...closeoutEvidenceItems,
    ...productionSignoffEvidenceItems,
    ...receiptVisibilityEvidenceItems,
    ...launchDutyEvidenceItems
  ];
  const completedEvidenceCount = evidenceItems.filter((item) =>
    item.status === "filled" || item.status === "visible" || item.status === "recorded"
  ).length;
  const currentEvidence = closeoutEvidenceItems.find((item) => item.key === evidenceProgress?.currentTarget?.key)
    || evidenceItems.find((item) => !["filled", "visible", "recorded"].includes(item.status))
    || evidenceItems[0]
    || null;
  const productionSignoffCompleted = productionSignoffEvidenceItems.filter((item) => item.status === "filled").length;
  const receiptVisibilityCompleted = receiptVisibilityEvidenceItems.filter((item) => item.status === "visible").length;
  const launchDutyCompleted = launchDutyEvidenceItems.filter((item) => item.status === "recorded").length;

  return {
    version: "staging-closeout-init-launch-evidence-gate/v1",
    status: completedEvidenceCount < evidenceItems.length
      ? "blocked_until_real_launch_evidence_attached"
      : "ready_for_stabilization_handoff",
    currentGate: "closeout_init",
    currentEvidenceKey: currentEvidence?.key || null,
    currentEvidenceType: currentEvidence?.type || null,
    currentEvidenceStatus: currentEvidence?.status || null,
    currentCommand: evidenceProgress?.firstBackfillCommand || currentEvidence?.command || null,
    currentArtifactPath: evidenceProgress?.currentTarget?.artifactPath || currentEvidence?.artifactPath || null,
    closeoutInputFile: outputFile,
    readinessActionQueueFile: actionsFile || null,
    archiveRoot,
    evidenceCount: evidenceItems.length,
    closeoutEvidenceCount: closeoutEvidenceItems.length,
    productionSignoffEvidenceCount: productionSignoffEvidenceItems.length,
    receiptVisibilityEvidenceCount: receiptVisibilityEvidenceItems.length,
    launchDutyEvidenceCount: launchDutyEvidenceItems.length,
    completedEvidenceCount,
    pendingEvidenceCount: evidenceItems.length - completedEvidenceCount,
    readinessStatusCommand: statusCommand,
    rehearsalReloadCommand: reloadCommand,
    fullTestCommand: "npm.cmd test",
    fullTestOutputArtifact: path.posix.join(archiveRoot, "full-test-output.txt"),
    productionSignoffPacket: path.posix.join(archiveRoot, "staging-production-signoff-packet.json"),
    launchDayWatchArtifact,
    firstWaveCloseoutArtifact,
    launchDutyRecordIndexPath,
    progress: {
      closeout: {
        completed: evidenceProgress?.filledCount || 0,
        total: closeoutEvidenceItems.length
      },
      productionSignoff: {
        completed: productionSignoffCompleted,
        total: productionSignoffEvidenceItems.length
      },
      receiptVisibility: {
        completed: receiptVisibilityCompleted,
        total: receiptVisibilityEvidenceItems.length
      },
      launchDuty: {
        completed: launchDutyCompleted,
        total: launchDutyEvidenceItems.length
      }
    },
    evidenceItems,
    nextAction: "Run readinessStatusCommand, attach the current closeout evidence item, then rerun readiness status before continuing to smoke, full-test, production signoff, receipt visibility, launch-day watch, and first-wave closeout."
  };
}

function promoteDraft(draft, draftFile) {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    throw new Error("closeout draft must be a JSON object.");
  }
  if (draft.mode !== "staging-closeout-input-draft") {
    throw new Error("Only staging-closeout-input-draft payloads can be promoted.");
  }
  const nextDraft = {
    ...draft,
    status: "awaiting_real_evidence",
    promotedFromDraft: {
      path: draftFile,
      promotedAt: "pending_operator_evidence"
    }
  };
  delete nextDraft.exampleOnly;
  delete nextDraft.doNotSubmitWithoutReplacingPlaceholders;
  return nextDraft;
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.status === "written") {
    console.log(`Filled closeout input initialized: ${result.outputFile}`);
    if (result.evidenceProgress) {
      const progress = result.evidenceProgress;
      console.log(`Evidence progress: ${progress.filledCount}/${progress.requiredCount} filled, ${progress.pendingCount} pending`);
      if (progress.currentTarget) {
        console.log(`First backfill target: ${progress.currentTarget.key}`);
        if (progress.currentTarget.artifactPath) {
          console.log(`First target artifact: ${progress.currentTarget.artifactPath}`);
        }
        if (progress.currentTarget.sourceStep) {
          console.log(`First target source step: ${progress.currentTarget.sourceStep}`);
        }
      }
      if (progress.firstBackfillCommand) {
        console.log(`First backfill command: ${progress.firstBackfillCommand}`);
      }
      console.log(`First target status check: ${progress.statusCommand}`);
    }
    if (result.firstEvidenceBackfillHandoff) {
      const handoff = result.firstEvidenceBackfillHandoff;
      console.log(`First evidence handoff: ${handoff.status}`);
      console.log(`First evidence status refresh: ${handoff.statusCommand}`);
      console.log(`First evidence backfill: ${handoff.firstBackfillCommand}`);
      console.log(`First evidence target: ${handoff.firstBackfillTarget.key} -> ${handoff.firstBackfillTarget.artifactPath || "-"}`);
      if (handoff.firstBackfillTarget.sourceStep) {
        console.log(`First evidence source step: ${handoff.firstBackfillTarget.sourceStep}`);
      }
      console.log(`First evidence rehearsal reload: ${handoff.reloadCommand}`);
      console.log(`First evidence next action: ${handoff.nextAction}`);
    }
    if (result.launchEvidenceReadinessGate) {
      const gate = result.launchEvidenceReadinessGate;
      console.log(
        `Launch evidence gate: ${gate.status || "-"}`
          + ` (current=${gate.currentEvidenceKey || "-"}, pending=${gate.pendingEvidenceCount ?? "-"}/${gate.evidenceCount ?? "-"})`
      );
      console.log(`Launch evidence current: ${gate.currentEvidenceType || "-"}/${gate.currentEvidenceKey || "-"} -> ${gate.currentCommand || "-"}`);
      console.log(`Launch evidence artifact: ${gate.currentArtifactPath || "-"}`);
      console.log(
        `Launch evidence progress: closeout=${gate.progress?.closeout?.completed ?? "-"}/${gate.progress?.closeout?.total ?? "-"}`
          + `, signoff=${gate.progress?.productionSignoff?.completed ?? "-"}/${gate.progress?.productionSignoff?.total ?? "-"}`
          + `, receipts=${gate.progress?.receiptVisibility?.completed ?? "-"}/${gate.progress?.receiptVisibility?.total ?? "-"}`
          + `, launchDuty=${gate.progress?.launchDuty?.completed ?? "-"}/${gate.progress?.launchDuty?.total ?? "-"}`
      );
      console.log(`Launch evidence readiness status: ${gate.readinessStatusCommand || "-"}`);
      console.log(`Launch evidence full-test: ${gate.fullTestCommand || "-"} -> ${gate.fullTestOutputArtifact || "-"}`);
      console.log(`Launch evidence production signoff packet: ${gate.productionSignoffPacket || "-"}`);
      console.log(`Launch evidence launch-day watch: ${gate.launchDayWatchArtifact || "-"}`);
      console.log(`Launch evidence first-wave closeout: ${gate.firstWaveCloseoutArtifact || "-"}`);
      console.log(`Launch evidence next action: ${gate.nextAction || "-"}`);
    }
    const currentCommand = result.operatorNextCommands?.find((item) => item.status === "current");
    const firstBackfill = result.operatorNextCommands?.find((item) => item.key === "first_closeout_backfill");
    const rehearsalReload = result.operatorNextCommands?.find((item) => item.key === "rehearsal_reload");
    if (currentCommand) {
      console.log(`Current command: ${currentCommand.command}`);
      if (currentCommand.artifactPath) {
        console.log(`Action queue file: ${currentCommand.artifactPath}`);
      }
    } else {
      console.log(result.statusCommand);
    }
    if (firstBackfill) {
      console.log(`First backfill after status: ${firstBackfill.command}`);
    }
    if (rehearsalReload) {
      console.log(`Rehearsal reload: ${rehearsalReload.command}`);
    } else {
      console.log(result.nextCommand);
    }
    console.log(`Next action: ${result.nextAction}`);
    return;
  }
  console.log(`Staging closeout init failed: ${result.error.message}`);
}

function main() {
  const json = process.argv.includes("--json");
  try {
    const options = parseArgs(process.argv.slice(2));
    const draftFile = path.resolve(options.draftFile);
    const draft = JSON.parse(readFileSync(draftFile, "utf8"));
    const outputFile = path.resolve(options.outputFile || draft.copyTo || "filled-closeout-input.json");
    const actionsFile = options.actionsFile ? path.resolve(options.actionsFile) : null;
    const closeoutInput = promoteDraft(draft, draftFile);
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(closeoutInput, null, 2)}\n`, "utf8");
    const acceptanceFields = Array.isArray(closeoutInput.acceptanceFields) ? closeoutInput.acceptanceFields : [];
    const placeholderCount = acceptanceFields.filter((field) => field?.value === null || field?.value === undefined).length;
    const nextCommand = `npm.cmd run staging:rehearsal -- --closeout-input-file ${commandValue(outputFile)}`;
    const nextStatusCommand = statusCommand(outputFile, actionsFile);
    const evidenceProgress = buildEvidenceProgress({
      acceptanceFields,
      statusCommand: nextStatusCommand,
      outputFile,
      actionsFile
    });
    const firstEvidenceBackfillHandoff = buildFirstEvidenceBackfillHandoff({
      evidenceProgress,
      actionsFile,
      rehearsalCommand: nextCommand
    });
    const launchEvidenceReadinessGate = buildCloseoutInitLaunchEvidenceReadinessGate({
      closeoutInput,
      acceptanceFields,
      evidenceProgress,
      outputFile,
      actionsFile,
      statusCommand: nextStatusCommand,
      reloadCommand: nextCommand
    });
    writeResult({
      status: "written",
      mode: "staging-closeout-init",
      draftFile,
      outputFile,
      ...(actionsFile ? { actionsFile } : {}),
      acceptanceFieldCount: acceptanceFields.length,
      placeholderCount,
      evidenceProgress,
      ...(firstEvidenceBackfillHandoff ? { firstEvidenceBackfillHandoff } : {}),
      nextCommand,
      statusCommand: nextStatusCommand,
      launchEvidenceReadinessGate,
      operatorNextCommands: buildOperatorNextCommands({
        outputFile,
        actionsFile,
        rehearsalCommand: nextCommand,
        readinessStatusCommand: nextStatusCommand,
        firstBackfillCommand: evidenceProgress.firstBackfillCommand,
        firstBackfillArtifactPath: evidenceProgress.currentTarget?.artifactPath
      }),
      nextAction: "Run statusCommand to pick the first closeout evidence backfill target."
    }, options.json);
  } catch (error) {
    writeResult({
      status: "fail",
      mode: "staging-closeout-init",
      error: {
        message: error.message
      }
    }, json);
    process.exitCode = 1;
  }
}

main();
