#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildBoundSecretEnvProof } from "./staging-proof-utils.mjs";

const OPTION_FLAGS = {
  "--input-file": "inputFile",
  "--output-file": "outputFile",
  "--key": "key",
  "--value-json": "valueJson",
  "--artifact-path": "artifactPath",
  "--receipt-id": "receiptIds",
  "--actions-file": "actionsFile"
};

const DEFAULT_ARTIFACT_ROOT = "artifacts/staging/<productCode>/<channel>";

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
    receiptIds: []
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
    const value = requireArgValue(name, inlineValue ?? argv[index + 1], inlineValue);
    if (key === "receiptIds") {
      options.receiptIds.push(value);
    } else {
      options[key] = value;
    }
    if (inlineValue === undefined) {
      index += 1;
    }
  }
  for (const required of ["inputFile", "key", "valueJson"]) {
    if (!options[required]) {
      throw new Error(`--${required.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} requires a value.`);
    }
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

function artifactRootFromPath(value) {
  const parts = path.resolve(value).replaceAll("\\", "/").split("/").filter(Boolean);
  for (let index = 0; index < parts.length - 3; index += 1) {
    if (parts[index] === "artifacts" && parts[index + 1] === "staging" && parts[index + 2] && parts[index + 3]) {
      return `artifacts/staging/${parts[index + 2]}/${parts[index + 3]}`;
    }
  }
  return DEFAULT_ARTIFACT_ROOT;
}

function signoffBackfillCommand({ outputFile, artifactRoot, actionsFile = null }) {
  const actionsArg = actionsFile ? ` --actions-file ${commandValue(actionsFile)}` : "";
  return [
    "npm.cmd run staging:signoff:backfill --",
    `--input-file ${commandValue(outputFile)}`,
    "--condition-key full_test_window_passed",
    "--value-json <redacted-json>",
    `--artifact-path ${path.posix.join(artifactRoot, "full-test-output.txt")}`,
    "--decision ready-for-production-signoff",
    actionsArg.trimStart()
  ].filter(Boolean).join(" ");
}

function buildSignoffEvidenceBackfillCommand({
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

function receiptIdArgs(receiptOperations = []) {
  return receiptOperations
    .filter(Boolean)
    .map((operation) => ` --receipt-id <${operation}-receipt-id>`)
    .join("");
}

function buildNextBackfillCommand({ outputFile, target, actionsFile = null }) {
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
  nextBackfillCommand,
  nextBackfillArtifactPath
}) {
  const commands = [
    {
      key: "readiness_status",
      status: "current",
      command: readinessStatusCommand,
      artifactPath: actionsFile || null,
      nextAction: "Refresh the readiness action queue after this evidence backfill."
    }
  ];
  if (nextBackfillCommand) {
    commands.push({
      key: "next_closeout_backfill",
      status: "blocked_after_readiness_status",
      command: nextBackfillCommand,
      artifactPath: nextBackfillArtifactPath || null,
      nextAction: "Backfill the next pending closeout evidence item after the readiness action queue is refreshed."
    });
  }
  commands.push(
    {
      key: "rehearsal_reload",
      status: nextBackfillCommand ? "blocked_after_next_closeout_backfill" : "blocked_after_readiness_status",
      command: rehearsalCommand,
      artifactPath: outputFile,
      nextAction: "Reload rehearsal after status confirms the next gate or all closeout evidence is ready."
    }
  );
  return commands;
}

function buildEvidenceValue(options) {
  const parsed = JSON.parse(options.valueJson);
  const value = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? { ...parsed }
    : { value: parsed };
  if (options.artifactPath) {
    value.artifactPath = options.artifactPath;
  }
  if (options.receiptIds.length) {
    value.receiptIds = options.receiptIds;
  }
  return value;
}

function extractDecisionValue(value) {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of ["decision", "value"]) {
      if (typeof value[key] === "string" && value[key].trim()) {
        return value[key].trim();
      }
    }
  }
  return null;
}

function backfill(payload, options) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("closeout input must be a JSON object.");
  }
  const acceptanceFields = Array.isArray(payload.acceptanceFields) ? payload.acceptanceFields : [];
  const fieldIndex = acceptanceFields.findIndex((field) => field?.key === options.key);
  if (fieldIndex < 0) {
    throw new Error(`Unknown closeout key: ${options.key}`);
  }
  const value = buildEvidenceValue(options);
  const nextFields = acceptanceFields.map((field, index) => index === fieldIndex
    ? {
      ...field,
      status: "filled",
      value,
      artifactPath: options.artifactPath || field.artifactPath || null,
      receiptIds: options.receiptIds
    }
    : field);
  const decision = options.key === "operator_go_no_go" ? extractDecisionValue(value) : null;
  return {
    ...payload,
    decision: decision || payload.decision || null,
    acceptanceFields: nextFields
  };
}

function isFilled(field) {
  if (!field || field.value === null || field.value === undefined) {
    return false;
  }
  if (typeof field.value === "string") {
    return field.value.trim() !== "";
  }
  if (Array.isArray(field.value)) {
    return field.value.length > 0;
  }
  if (typeof field.value === "object") {
    return Object.keys(field.value).length > 0;
  }
  return true;
}

function buildEvidenceProgress({ fields, outputFile, actionsFile, readinessStatusCommand }) {
  const acceptanceFields = Array.isArray(fields) ? fields : [];
  const pendingFields = acceptanceFields.filter((field) => !isFilled(field));
  const currentTarget = pendingFields[0] || null;
  const receiptOperations = Array.isArray(currentTarget?.receiptOperations) ? currentTarget.receiptOperations : [];
  const nextBackfillCommand = buildNextBackfillCommand({
    outputFile,
    target: currentTarget ? { ...currentTarget, receiptOperations } : null,
    actionsFile
  });
  return {
    status: pendingFields.length === 0 ? "filled" : "awaiting_more_closeout_evidence",
    requiredCount: acceptanceFields.length,
    filledCount: acceptanceFields.length - pendingFields.length,
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
    nextBackfillCommand,
    statusCommand: readinessStatusCommand,
    nextAction: nextBackfillCommand
      ? "Run statusCommand, then run nextBackfillCommand with real redacted evidence."
      : "Run statusCommand to move to the full-test or sign-off action."
  };
}

function buildNextCloseoutEvidenceHandoff({
  backfilledKey,
  evidenceProgress,
  actionsFile,
  rehearsalCommand
}) {
  if (!evidenceProgress?.nextBackfillCommand || !evidenceProgress.currentTarget) {
    return null;
  }
  return {
    status: "ready_for_next_closeout_backfill",
    currentActionKey: "backfill_closeout_evidence",
    backfilledKey,
    progress: {
      requiredCount: evidenceProgress.requiredCount,
      filledCount: evidenceProgress.filledCount,
      pendingCount: evidenceProgress.pendingCount
    },
    statusCommand: evidenceProgress.statusCommand,
    nextBackfillCommand: evidenceProgress.nextBackfillCommand,
    nextBackfillTarget: {
      key: evidenceProgress.currentTarget.key,
      artifactPath: evidenceProgress.currentTarget.artifactPath,
      sourceStep: evidenceProgress.currentTarget.sourceStep,
      receiptOperations: evidenceProgress.currentTarget.receiptOperations
    },
    actionQueueFile: actionsFile || null,
    reloadCommand: rehearsalCommand,
    nextAction: "Run statusCommand, then nextBackfillCommand with real redacted evidence before the rehearsal reload."
  };
}

function buildFullTestReadyHandoff({
  outputFile,
  actionsFile,
  artifactRoot,
  closeoutDecision,
  readinessStatusCommand,
  rehearsalCommand,
  evidenceProgress
}) {
  if (closeoutDecision !== "ready-for-full-test-window" || evidenceProgress?.status !== "filled") {
    return null;
  }
  return {
    status: "ready_for_full_test_window",
    currentActionKey: "run_full_test_window",
    statusCommand: readinessStatusCommand,
    reloadCommand: rehearsalCommand,
    actionQueueFile: actionsFile || null,
    fullTestCommand: "npm.cmd test",
    fullTestResultArtifactPath: path.posix.join(artifactRoot, "full-test-output.txt"),
    productionSignoffPacketPath: path.posix.join(artifactRoot, "staging-production-signoff-packet.json"),
    signoffBackfillCommand: signoffBackfillCommand({ outputFile, artifactRoot, actionsFile }),
    nextAction: "Run statusCommand to confirm full-test readiness, run fullTestCommand, then use signoffBackfillCommand with the redacted full-test result."
  };
}

function buildOperatorQueueCheckpoint({
  outputFile,
  actionsFile,
  targetType,
  key,
  artifactPath,
  evidenceProgress,
  fullTestReadyHandoff,
  operatorNextCommands
}) {
  const currentCommand = operatorNextCommands.find((item) => item.status === "current") || null;
  const nextBackfill = operatorNextCommands.find((item) => item.key === "next_closeout_backfill") || null;
  const rehearsalReload = operatorNextCommands.find((item) => item.key === "rehearsal_reload") || null;
  const readyForFullTestWindow = Boolean(fullTestReadyHandoff);
  return {
    mode: "staging-closeout-backfill-operator-queue-checkpoint",
    status: readyForFullTestWindow ? "ready_for_full_test_window" : "awaiting_closeout_readiness_refresh",
    currentActionKey: currentCommand?.key || "readiness_status",
    currentCommand: currentCommand?.command || evidenceProgress?.statusCommand || null,
    actionQueueFile: actionsFile || null,
    outputFile,
    backfilledTargetType: targetType,
    backfilledKey: key,
    backfilledArtifactPath: artifactPath || null,
    filledFieldCount: evidenceProgress?.filledCount ?? 0,
    requiredFieldCount: evidenceProgress?.requiredCount ?? 0,
    pendingFieldCount: evidenceProgress?.pendingCount ?? 0,
    nextBackfillType: nextBackfill ? "closeout_evidence" : null,
    nextBackfillKey: nextBackfill ? evidenceProgress?.currentTarget?.key || null : null,
    nextBackfillCommand: nextBackfill?.command || null,
    nextBackfillArtifactPath: nextBackfill?.artifactPath || null,
    fullTestReadyStatus: fullTestReadyHandoff?.status || null,
    fullTestCommand: fullTestReadyHandoff?.fullTestCommand || null,
    fullTestResultArtifactPath: fullTestReadyHandoff?.fullTestResultArtifactPath || null,
    productionSignoffPacketPath: fullTestReadyHandoff?.productionSignoffPacketPath || null,
    signoffBackfillCommand: fullTestReadyHandoff?.signoffBackfillCommand || null,
    operatorCommandCount: operatorNextCommands.length,
    nextAction: fullTestReadyHandoff
      ? fullTestReadyHandoff.nextAction
      : "Run the readiness status refresh, then continue the next closeout evidence backfill."
  };
}

function inferArchiveRoot(fields) {
  const artifactPath = (Array.isArray(fields) ? fields : [])
    .map((field) => field?.artifactPath)
    .find((value) => typeof value === "string" && value.trim());
  if (!artifactPath) {
    return DEFAULT_ARTIFACT_ROOT;
  }
  const normalized = artifactPath.replace(/\\/g, "/");
  const dirname = path.posix.dirname(normalized);
  return dirname === "." ? DEFAULT_ARTIFACT_ROOT : dirname;
}

function fieldReceiptIds(field) {
  if (Array.isArray(field?.receiptIds)) {
    return field.receiptIds;
  }
  if (field?.value && typeof field.value === "object" && Array.isArray(field.value.receiptIds)) {
    return field.value.receiptIds;
  }
  const receiptOperations = Array.isArray(field?.receiptOperations) ? field.receiptOperations : [];
  return receiptOperations.map((operation) => `<${operation}-receipt-id>`);
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

function buildCloseoutBackfillLaunchEvidenceReadinessGate({
  closeoutInput,
  fields,
  evidenceProgress,
  outputFile,
  actionsFile,
  readinessStatusCommand,
  rehearsalCommand,
  fullTestReadyHandoff
}) {
  const acceptanceFields = Array.isArray(fields) ? fields : [];
  const archiveRoot = inferArchiveRoot(acceptanceFields);
  const fieldByKey = new Map(acceptanceFields.map((field) => [field?.key, field]));
  const closeoutKeys = [
    "route_map_gate_result",
    "backup_restore_drill_result",
    "live_write_smoke_result",
    "launch_smoke_handoff",
    "launch_mainline_evidence_receipts",
    "receipt_visibility_review",
    "operator_go_no_go"
  ];
  const closeoutEvidenceItems = closeoutKeys.map((key, index) => {
    const field = fieldByKey.get(key) || {};
    const artifactPath = field.artifactPath || path.posix.join(archiveRoot, `${key}.txt`);
    return buildLaunchEvidenceItem({
      order: index + 1,
      key,
      type: "closeout_evidence",
      status: isFilled(field) ? "filled" : field.status || "pending_operator_entry",
      artifactPath,
      command: buildNextBackfillCommand({
        outputFile,
        target: {
          key,
          artifactPath,
          receiptOperations: Array.isArray(field.receiptOperations) ? field.receiptOperations : []
        },
        actionsFile
      }),
      receiptIds: fieldReceiptIds(field)
    });
  });
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
  const productionSignoffEvidenceItems = signoffDefinitions.map((definition, index) => {
    const value = productionSignoffConditionValue(closeoutInput, definition.key);
    return buildLaunchEvidenceItem({
      order: index + 8,
      key: definition.key,
      type: "production_signoff_condition",
      status: isFilledValue(value) ? "filled" : definition.status,
      artifactPath: definition.artifactPath,
      command: buildSignoffEvidenceBackfillCommand({
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
  const receiptDefinitions = [
    ["launchMainline", "blocked_after_operator_signoff_recorded", "launch-mainline-receipt-visibility.json"],
    ["launchReview", "blocked_after_launchMainline_receipt_visibility", "launch-review-receipt-visibility.json"],
    ["launchSmoke", "blocked_after_launchReview_receipt_visibility", "launch-smoke-receipt-visibility.json"],
    ["developerOps", "blocked_after_launchSmoke_receipt_visibility", "developer-ops-receipt-visibility.json"],
    ["launchOpsOverviewStatus", "blocked_after_developerOps_receipt_visibility", "launch-ops-overview-status-receipt-visibility.json"]
  ];
  const receiptVisibilityEvidenceItems = receiptDefinitions.map(([key, status, fileName], index) => {
    const artifactPath = path.posix.join(archiveRoot, fileName);
    const value = receiptVisibilityLaneValue(closeoutInput, key);
    return buildLaunchEvidenceItem({
      order: index + 15,
      key,
      type: "receipt_visibility_lane",
      status: isFilledValue(value) ? "visible" : status,
      artifactPath,
      command: buildSignoffEvidenceBackfillCommand({
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
  const closeoutCompleted = closeoutEvidenceItems.filter((item) => item.status === "filled").length;
  const productionSignoffCompleted = productionSignoffEvidenceItems.filter((item) => item.status === "filled").length;
  const receiptVisibilityCompleted = receiptVisibilityEvidenceItems.filter((item) => item.status === "visible").length;
  const launchDutyCompleted = launchDutyEvidenceItems.filter((item) => item.status === "recorded").length;
  const completedEvidenceCount = closeoutCompleted + productionSignoffCompleted + receiptVisibilityCompleted + launchDutyCompleted;
  const currentEvidence = fullTestReadyHandoff
    ? productionSignoffEvidenceItems.find((item) => item.key === "full_test_window_passed")
    : closeoutEvidenceItems.find((item) => item.key === evidenceProgress?.currentTarget?.key)
      || evidenceItems.find((item) => !["filled", "visible", "recorded"].includes(item.status))
      || evidenceItems[0]
      || null;

  return {
    version: "staging-closeout-backfill-launch-evidence-gate/v1",
    status: completedEvidenceCount < evidenceItems.length
      ? "blocked_until_real_launch_evidence_attached"
      : "ready_for_stabilization_handoff",
    currentGate: "closeout_backfill",
    currentEvidenceKey: currentEvidence?.key || null,
    currentEvidenceType: currentEvidence?.type || null,
    currentEvidenceStatus: currentEvidence?.status || null,
    currentCommand: fullTestReadyHandoff?.signoffBackfillCommand || evidenceProgress?.nextBackfillCommand || currentEvidence?.command || null,
    currentArtifactPath: fullTestReadyHandoff?.fullTestResultArtifactPath || evidenceProgress?.currentTarget?.artifactPath || currentEvidence?.artifactPath || null,
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
    readinessStatusCommand,
    rehearsalReloadCommand: rehearsalCommand,
    fullTestCommand: "npm.cmd test",
    fullTestOutputArtifact: path.posix.join(archiveRoot, "full-test-output.txt"),
    productionSignoffPacket: path.posix.join(archiveRoot, "staging-production-signoff-packet.json"),
    launchDayWatchArtifact,
    firstWaveCloseoutArtifact,
    launchDutyRecordIndexPath,
    progress: {
      closeout: {
        completed: closeoutCompleted,
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
    nextAction: "Run readinessStatusCommand, verify the backfilled evidence is reflected, then continue the next launch evidence command."
  };
}

function artifactRootLane(artifactRoot) {
  const parts = String(artifactRoot || DEFAULT_ARTIFACT_ROOT).split("/");
  return {
    productCode: parts[2] || "<productCode>",
    channel: parts[3] || "<channel>"
  };
}

function buildCloseoutBackfillProductionSwitchProofPacket({
  closeoutInput,
  outputFile,
  actionsFile,
  artifactRoot,
  evidenceProgress,
  fullTestReadyHandoff,
  launchEvidenceReadinessGate
}) {
  const inferredArchiveRoot = inferArchiveRoot(closeoutInput?.acceptanceFields);
  const archiveRoot = inferredArchiveRoot !== DEFAULT_ARTIFACT_ROOT
    ? inferredArchiveRoot
    : artifactRoot || DEFAULT_ARTIFACT_ROOT;
  const lane = artifactRootLane(archiveRoot);
  const closeoutFields = new Map(
    (Array.isArray(closeoutInput?.acceptanceFields) ? closeoutInput.acceptanceFields : [])
      .filter((field) => field?.key)
      .map((field) => [field.key, field])
  );
  const fullTestConditionValue = productionSignoffConditionValue(closeoutInput, "full_test_window_passed");
  const launchDutyProgress = launchEvidenceReadinessGate?.progress?.launchDuty || {};
  const launchDutyReady = launchDutyProgress.total > 0 && launchDutyProgress.completed === launchDutyProgress.total;
  const currentActionKey = fullTestReadyHandoff
    ? "run_full_test_window"
    : evidenceProgress?.nextBackfillCommand
      ? "backfill_closeout_evidence"
      : "review_readiness_status";
  const targetEnvFile = closeoutInput?.targetEnvFile || closeoutInput?.stagingEnvironmentBinding?.environment?.targetEnvFile || null;
  const baseUrl = closeoutInput?.baseUrl || closeoutInput?.summary?.baseUrl || null;
  const storageProfile = closeoutInput?.storageProfile || closeoutInput?.summary?.storageProfile || null;
  const secretEnvProof = buildBoundSecretEnvProof(closeoutInput);
  const backupRestoreField = closeoutFields.get("backup_restore_drill_result");
  const backupRestoreArtifactPath = backupRestoreField?.artifactPath || path.posix.join(archiveRoot, "backup_restore_drill_result.txt");
  const backupRestoreReady = isFilled(backupRestoreField);
  const backupRestoreCommand = backupRestoreReady
    ? null
    : buildNextBackfillCommand({
      outputFile,
      target: {
        key: "backup_restore_drill_result",
        artifactPath: backupRestoreArtifactPath,
        receiptOperations: Array.isArray(backupRestoreField?.receiptOperations) ? backupRestoreField.receiptOperations : []
      },
      actionsFile
    });
  const liveWriteField = closeoutFields.get("live_write_smoke_result");
  const liveWriteArtifactPath = liveWriteField?.artifactPath || path.posix.join(archiveRoot, "live_write_smoke_result.txt");
  const liveWriteReady = isFilled(liveWriteField);
  const liveWriteCommand = liveWriteReady
    ? null
    : buildNextBackfillCommand({
      outputFile,
      target: {
        key: "live_write_smoke_result",
        artifactPath: liveWriteArtifactPath,
        receiptOperations: Array.isArray(liveWriteField?.receiptOperations) ? liveWriteField.receiptOperations : []
      },
      actionsFile
    });
  const proofItems = [
    {
      order: 1,
      key: "public_https_entrypoint",
      status: baseUrl
        ? /^https:\/\//i.test(String(baseUrl)) ? "ready_from_closeout_input" : "blocked_until_public_https"
        : "pending_real_environment_value",
      command: null,
      artifactPath: baseUrl,
      nextAction: "Keep the public staging entrypoint on HTTPS for all live-write smoke and launch switch checks."
    },
    {
      order: 2,
      key: "non_default_secret_env",
      status: secretEnvProof.status,
      command: null,
      artifactPath: targetEnvFile,
      nextAction: "Confirm non-default admin, developer, and bearer-token secrets are loaded from environment variables before continuing evidence backfill."
    },
    {
      order: 3,
      key: "storage_profile_selected",
      status: storageProfile ? "ready_from_closeout_input" : "pending_real_environment_value",
      command: null,
      artifactPath: storageProfile,
      nextAction: "Keep storage profile and backup paths aligned through recovery preflight and staging evidence backfill."
    },
    {
      order: 4,
      key: "backup_restore_drill",
      status: backupRestoreReady ? "ready_evidence_attached" : "blocked_after_readiness_status",
      command: backupRestoreCommand,
      artifactPath: backupRestoreArtifactPath,
      nextAction: "Attach backup/restore drill evidence before live-write smoke and production sign-off."
    },
    {
      order: 5,
      key: "live_write_smoke",
      status: liveWriteReady ? "ready_evidence_attached" : "blocked_after_route_map_gate",
      command: liveWriteCommand,
      artifactPath: liveWriteArtifactPath,
      nextAction: "Attach launch:smoke:staging output after no-write preflight and route-map gate pass."
    },
    {
      order: 6,
      key: "full_test_window",
      status: isFilledValue(fullTestConditionValue) ? "ready_evidence_attached" : "ready_local_baseline_available",
      command: "npm.cmd test",
      artifactPath: path.posix.join(archiveRoot, "full-test-output.txt"),
      nextAction: "Attach the redacted full-suite output artifact before or while backfilling full_test_window_passed."
    },
    {
      order: 7,
      key: "production_signoff_and_receipts",
      status: "blocked_after_full_test_signoff_backfill",
      command: null,
      artifactPath: path.posix.join(archiveRoot, "staging-production-signoff-packet.json"),
      nextAction: "Backfill production sign-off conditions and receipt visibility lanes before launch-day watch."
    },
    {
      order: 8,
      key: "launch_day_watch_and_stabilization",
      status: launchDutyReady ? "ready_evidence_attached" : "blocked_after_production_signoff_readiness",
      command: null,
      artifactPath: path.posix.join(archiveRoot, "launch-day-watch-summary.md"),
      nextAction: "Record launch-day watch, stabilization, and first-wave closeout records into the shared launch-duty record index."
    }
  ];
  const ready = proofItems.filter((item) => String(item.status || "").startsWith("ready_")).length;
  return {
    version: "staging-closeout-backfill-production-switch-proof-packet/v1",
    status: ready === proofItems.length ? "ready_for_production_switch_review" : "blocked_until_real_environment_evidence",
    currentActionKey,
    currentCommand: fullTestReadyHandoff?.signoffBackfillCommand || evidenceProgress?.nextBackfillCommand || statusCommand(outputFile, actionsFile),
    baseUrl,
    productCode: closeoutInput?.productCode || closeoutInput?.summary?.productCode || lane.productCode,
    channel: closeoutInput?.channel || closeoutInput?.summary?.channel || lane.channel,
    targetOs: closeoutInput?.targetOs || closeoutInput?.summary?.targetOs || null,
    storageProfile,
    archiveRoot,
    closeoutInputFile: outputFile,
    readinessActionQueueFile: actionsFile || null,
    launchDutyRecordIndexFile: path.posix.join(archiveRoot, "launch-duty-record-index.json"),
    localFullSuiteBaseline: {
      command: "npm.cmd test",
      status: "available_from_2026-05-27_full_suite_pass",
      testCount: 192,
      failureCount: 0,
      outputArtifact: path.posix.join(archiveRoot, "full-test-output.txt"),
      nextAction: "Reuse this local baseline unless another meaningful backend/API or launch-control change lands before cutover."
    },
    proofCounts: {
      total: proofItems.length,
      ready,
      blocked: proofItems.length - ready
    },
    proofItems,
    nextAction: "Continue the current closeout evidence command, rerun staging:readiness:status, then use this packet as the production switch proof checklist."
  };
}

function writeProductionSwitchProofPacketPlain(packet) {
  if (!packet) {
    return;
  }
  const counts = packet.proofCounts || {};
  console.log(
    `Production switch proof packet: ${packet.status || "-"}`
      + ` (ready=${counts.ready ?? "-"}/${counts.total ?? "-"}`
      + `, blocked=${counts.blocked ?? "-"}/${counts.total ?? "-"}`
      + `, current=${packet.currentActionKey || "-"})`
  );
  const baseline = packet.localFullSuiteBaseline || {};
  console.log(
    `Production switch local baseline: ${baseline.command || "-"} -> ${baseline.outputArtifact || "-"}`
      + ` (${baseline.status || "-"}, tests=${baseline.testCount ?? "-"}, failures=${baseline.failureCount ?? "-"})`
  );
  (packet.proofItems || []).forEach((item) => {
    console.log(`Production switch proof ${item.order}. ${item.key}: ${item.status} -> ${item.command || item.artifactPath || "-"}`);
  });
  console.log(`Production switch next action: ${packet.nextAction || "-"}`);
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.status === "written") {
    console.log(`Closeout evidence backfilled: ${result.key}`);
    console.log(`Backfilled target: ${result.targetType}/${result.key}`);
    if (result.artifactPath) {
      console.log(`Backfilled artifact path: ${result.artifactPath}`);
    }
    if (Array.isArray(result.receiptIds) && result.receiptIds.length) {
      console.log(`Backfilled receipt IDs: ${result.receiptIds.join(", ")}`);
    }
    if (result.evidenceProgress) {
      const progress = result.evidenceProgress;
      console.log(`Closeout evidence progress: ${progress.filledCount}/${progress.requiredCount} filled, ${progress.pendingCount} pending`);
      if (progress.currentTarget) {
        console.log(`Next closeout target: ${progress.currentTarget.key}`);
        if (progress.currentTarget.artifactPath) {
          console.log(`Next target artifact: ${progress.currentTarget.artifactPath}`);
        }
        if (progress.currentTarget.sourceStep) {
          console.log(`Next target source step: ${progress.currentTarget.sourceStep}`);
        }
      }
      if (progress.nextBackfillCommand) {
        console.log(`Next backfill command: ${progress.nextBackfillCommand}`);
      }
    }
    if (result.operatorQueueCheckpoint) {
      const checkpoint = result.operatorQueueCheckpoint;
      console.log(`Closeout operator checkpoint: ${checkpoint.currentActionKey} (status=${checkpoint.status}, commands=${checkpoint.operatorCommandCount})`);
      if (checkpoint.currentCommand) {
        console.log(`Closeout checkpoint current: ${checkpoint.currentCommand}`);
      }
      console.log(`Closeout checkpoint progress: ${checkpoint.filledFieldCount}/${checkpoint.requiredFieldCount} filled, ${checkpoint.pendingFieldCount} pending`);
      if (checkpoint.nextBackfillCommand) {
        console.log(`Closeout checkpoint next backfill: ${checkpoint.nextBackfillType}/${checkpoint.nextBackfillKey} -> ${checkpoint.nextBackfillCommand}`);
      } else {
        console.log("Closeout checkpoint next backfill: none");
      }
      if (checkpoint.fullTestReadyStatus) {
        console.log(`Closeout checkpoint full-test readiness: ${checkpoint.fullTestReadyStatus}`);
      }
      if (checkpoint.fullTestCommand) {
        console.log(`Closeout checkpoint full-test command: ${checkpoint.fullTestCommand}`);
      }
      if (checkpoint.fullTestResultArtifactPath) {
        console.log(`Closeout checkpoint full-test result artifact: ${checkpoint.fullTestResultArtifactPath}`);
      }
      if (checkpoint.productionSignoffPacketPath) {
        console.log(`Closeout checkpoint production signoff packet: ${checkpoint.productionSignoffPacketPath}`);
      }
      if (checkpoint.signoffBackfillCommand) {
        console.log(`Closeout checkpoint signoff backfill: ${checkpoint.signoffBackfillCommand}`);
      }
      console.log(`Closeout checkpoint next action: ${checkpoint.nextAction}`);
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
    writeProductionSwitchProofPacketPlain(result.productionSwitchProofPacket);
    if (result.nextCloseoutEvidenceHandoff) {
      const handoff = result.nextCloseoutEvidenceHandoff;
      console.log(`Next closeout handoff: ${handoff.status}`);
      console.log(`Next closeout status refresh: ${handoff.statusCommand}`);
      console.log(`Next closeout backfill: ${handoff.nextBackfillCommand}`);
      console.log(`Next closeout target: ${handoff.nextBackfillTarget.key} -> ${handoff.nextBackfillTarget.artifactPath || "-"}`);
      if (handoff.nextBackfillTarget.sourceStep) {
        console.log(`Next closeout source step: ${handoff.nextBackfillTarget.sourceStep}`);
      }
      console.log(`Next closeout progress: ${handoff.progress.filledCount}/${handoff.progress.requiredCount} filled, ${handoff.progress.pendingCount} pending`);
      console.log(`Next closeout rehearsal reload: ${handoff.reloadCommand}`);
      console.log(`Next closeout next action: ${handoff.nextAction}`);
    }
    if (result.fullTestReadyHandoff) {
      const handoff = result.fullTestReadyHandoff;
      console.log(`Full-test readiness: ${handoff.status}`);
      console.log(`Full-test status refresh: ${handoff.statusCommand}`);
      console.log(`Full-test rehearsal reload: ${handoff.reloadCommand}`);
      console.log(`Full-test command: ${handoff.fullTestCommand}`);
      console.log(`Full-test result artifact: ${handoff.fullTestResultArtifactPath}`);
      console.log(`Production signoff packet: ${handoff.productionSignoffPacketPath}`);
      console.log(`Full-test signoff backfill: ${handoff.signoffBackfillCommand}`);
      console.log(`Full-test next action: ${handoff.nextAction}`);
    }
    console.log(`Backfilled status refresh: ${result.statusCommand}`);
    const currentCommand = result.operatorNextCommands?.find((item) => item.status === "current");
    const nextBackfill = result.operatorNextCommands?.find((item) => item.key === "next_closeout_backfill");
    const rehearsalReload = result.operatorNextCommands?.find((item) => item.key === "rehearsal_reload");
    if (currentCommand) {
      console.log(`Current command: ${currentCommand.command}`);
      if (currentCommand.artifactPath) {
        console.log(`Action queue file: ${currentCommand.artifactPath}`);
      }
    } else {
      console.log(result.statusCommand);
    }
    if (nextBackfill) {
      console.log(`Next backfill after status: ${nextBackfill.command}`);
    }
    if (rehearsalReload) {
      console.log(`Rehearsal reload: ${rehearsalReload.command}`);
    } else {
      console.log(result.nextCommand);
    }
    console.log(`Next action: ${result.nextAction}`);
    return;
  }
  console.log(`Staging closeout backfill failed: ${result.error.message}`);
}

function main() {
  const json = process.argv.includes("--json");
  try {
    const options = parseArgs(process.argv.slice(2));
    const inputFile = path.resolve(options.inputFile);
    const outputFile = path.resolve(options.outputFile || options.inputFile);
    const actionsFile = options.actionsFile ? path.resolve(options.actionsFile) : null;
    const payload = JSON.parse(readFileSync(inputFile, "utf8"));
    const nextPayload = backfill(payload, options);
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(nextPayload, null, 2)}\n`, "utf8");
    const fields = Array.isArray(nextPayload.acceptanceFields) ? nextPayload.acceptanceFields : [];
    const filledFieldCount = fields.filter(isFilled).length;
    const nextCommand = `npm.cmd run staging:rehearsal -- --closeout-input-file ${commandValue(outputFile)}`;
    const nextStatusCommand = statusCommand(outputFile, actionsFile);
    const artifactRoot = artifactRootFromPath(outputFile);
    const evidenceProgress = buildEvidenceProgress({
      fields,
      outputFile,
      actionsFile,
      readinessStatusCommand: nextStatusCommand
    });
    const operatorNextCommands = buildOperatorNextCommands({
      outputFile,
      actionsFile,
      rehearsalCommand: nextCommand,
      readinessStatusCommand: nextStatusCommand,
      nextBackfillCommand: evidenceProgress.nextBackfillCommand,
      nextBackfillArtifactPath: evidenceProgress.currentTarget?.artifactPath
    });
    const nextCloseoutEvidenceHandoff = buildNextCloseoutEvidenceHandoff({
      backfilledKey: options.key,
      evidenceProgress,
      actionsFile,
      rehearsalCommand: nextCommand
    });
    const fullTestReadyHandoff = buildFullTestReadyHandoff({
      outputFile,
      actionsFile,
      artifactRoot,
      closeoutDecision: nextPayload.decision || null,
      readinessStatusCommand: nextStatusCommand,
      rehearsalCommand: nextCommand,
      evidenceProgress
    });
    const launchEvidenceReadinessGate = buildCloseoutBackfillLaunchEvidenceReadinessGate({
      closeoutInput: nextPayload,
      fields,
      evidenceProgress,
      outputFile,
      actionsFile,
      readinessStatusCommand: nextStatusCommand,
      rehearsalCommand: nextCommand,
      fullTestReadyHandoff
    });
    const productionSwitchProofPacket = buildCloseoutBackfillProductionSwitchProofPacket({
      closeoutInput: nextPayload,
      outputFile,
      actionsFile,
      artifactRoot,
      evidenceProgress,
      fullTestReadyHandoff,
      launchEvidenceReadinessGate
    });
    const operatorQueueCheckpoint = buildOperatorQueueCheckpoint({
      outputFile,
      actionsFile,
      targetType: "closeout_evidence",
      key: options.key,
      artifactPath: options.artifactPath || null,
      evidenceProgress,
      fullTestReadyHandoff,
      operatorNextCommands
    });
    writeResult({
      status: "written",
      mode: "staging-closeout-backfill",
      inputFile,
      outputFile,
      ...(actionsFile ? { actionsFile } : {}),
      targetType: "closeout_evidence",
      key: options.key,
      artifactPath: options.artifactPath || null,
      receiptIds: options.receiptIds,
      filledFieldCount,
      remainingPlaceholderCount: fields.length - filledFieldCount,
      evidenceProgress,
      operatorQueueCheckpoint,
      launchEvidenceReadinessGate,
      productionSwitchProofPacket,
      ...(nextCloseoutEvidenceHandoff ? { nextCloseoutEvidenceHandoff } : {}),
      ...(fullTestReadyHandoff ? { fullTestReadyHandoff } : {}),
      nextCommand,
      statusCommand: nextStatusCommand,
      operatorNextCommands,
      nextAction: "Run statusCommand to pick the next closeout, full-test, or sign-off action."
    }, options.json);
  } catch (error) {
    writeResult({
      status: "fail",
      mode: "staging-closeout-backfill",
      error: {
        message: error.message
      }
    }, json);
    process.exitCode = 1;
  }
}

main();
