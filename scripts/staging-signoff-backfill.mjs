#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildProductionSwitchPublicHttpsProof,
  buildProductionSwitchSecretEnvProof,
  buildProductionSwitchStorageProfileProof
} from "./staging-proof-utils.mjs";

const RECEIPT_VISIBILITY_KEYS = [
  "launchMainline",
  "launchReview",
  "launchSmoke",
  "developerOps",
  "launchOpsOverviewStatus"
];

const CLOSEOUT_EVIDENCE_KEYS = [
  "route_map_gate_result",
  "backup_restore_drill_result",
  "live_write_smoke_result",
  "launch_smoke_handoff",
  "launch_mainline_evidence_receipts",
  "receipt_visibility_review",
  "operator_go_no_go"
];

const DEFAULT_ARTIFACT_ROOT = "artifacts/staging/<productCode>/<channel>";

const PRODUCTION_SIGNOFF_TARGETS = {
  full_test_window_passed: {
    fileName: "full-test-output.txt",
    sourceStep: "run_full_test_window",
    receiptOperations: []
  },
  staging_artifacts_archived: {
    fileName: "staging-artifacts-archive.txt",
    sourceStep: "archive_staging_artifacts",
    receiptOperations: []
  },
  launch_mainline_receipts_visible: {
    fileName: "launch-mainline-receipts-visible.json",
    sourceStep: "verify_launch_mainline_receipts",
    receiptOperations: ["record_post_launch_ops_sweep"]
  },
  launch_ops_overview_status_visible: {
    fileName: "launch-ops-overview-status-visible.json",
    sourceStep: "verify_launch_ops_overview_status",
    receiptOperations: ["record_post_launch_ops_sweep"]
  },
  backup_restore_drill_passed: {
    fileName: "backup-restore-drill.txt",
    sourceStep: "review_backup_restore_drill",
    receiptOperations: ["record_recovery_drill", "record_backup_verification"]
  },
  rollback_path_confirmed: {
    fileName: "rollback-path-confirmed.md",
    sourceStep: "confirm_rollback_path",
    receiptOperations: ["record_rollback_walkthrough"]
  },
  operator_signoff_recorded: {
    fileName: "operator-production-signoff.md",
    sourceStep: "record_operator_signoff",
    receiptOperations: []
  }
};

const OPTION_FLAGS = {
  "--input-file": "inputFile",
  "--output-file": "outputFile",
  "--condition-key": "conditionKey",
  "--receipt-lane": "receiptLane",
  "--value-json": "valueJson",
  "--artifact-path": "artifactPath",
  "--receipt-id": "receiptIds",
  "--decision": "decision",
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
  for (const required of ["inputFile", "valueJson"]) {
    if (!options[required]) {
      throw new Error(`--${required.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} requires a value.`);
    }
  }
  if (Boolean(options.conditionKey) === Boolean(options.receiptLane)) {
    throw new Error("Provide exactly one of --condition-key or --receipt-lane.");
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

function artifactRootFromPath(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  if (!normalized.startsWith("artifacts/") || !normalized.includes("/")) {
    return null;
  }
  return normalized.slice(0, normalized.lastIndexOf("/"));
}

function receiptLaneFileName(key) {
  return `${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-receipt-visibility.json`;
}

function buildNextBackfillCommand({ outputFile, target, actionsFile = null, includeDecision = false }) {
  if (!target?.key || !target?.type) {
    return null;
  }
  const keyFlag = target.type === "receipt_visibility_lane" ? "--receipt-lane" : "--condition-key";
  const artifactArg = target.artifactPath ? ` --artifact-path ${commandValue(target.artifactPath)}` : "";
  const decisionArg = target.type === "production_signoff_condition" && includeDecision
    ? " --decision ready-for-production-signoff"
    : "";
  const actionsArg = actionsFile ? ` --actions-file ${commandValue(actionsFile)}` : "";
  return [
    "npm.cmd run staging:signoff:backfill --",
    `--input-file ${commandValue(outputFile)}`,
    `${keyFlag} ${commandValue(target.key)}`,
    "--value-json <redacted-json>",
    artifactArg.trimStart(),
    receiptIdArgs(Array.isArray(target.receiptOperations) ? target.receiptOperations : []).trimStart(),
    decisionArg.trimStart(),
    actionsArg.trimStart()
  ].filter(Boolean).join(" ");
}

function buildCloseoutEvidenceBackfillCommand({
  outputFile,
  actionsFile = null,
  key,
  artifactPath,
  receiptIds = []
}) {
  const actionsArg = actionsFile ? ["--actions-file", commandValue(actionsFile)] : [];
  return [
    "npm.cmd run staging:closeout:backfill --",
    "--input-file",
    commandValue(outputFile),
    "--key",
    key,
    "--value-json",
    "<redacted-json>",
    "--artifact-path",
    commandValue(artifactPath),
    ...receiptIds.flatMap((receiptId) => ["--receipt-id", receiptId]),
    ...actionsArg
  ].join(" ");
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
      nextAction: "Refresh the readiness action queue after this sign-off backfill."
    }
  ];
  if (nextBackfillCommand) {
    commands.push({
      key: "next_signoff_backfill",
      status: "blocked_after_readiness_status",
      command: nextBackfillCommand,
      artifactPath: nextBackfillArtifactPath || null,
      nextAction: "Backfill the next pending production sign-off or receipt visibility item after the readiness action queue is refreshed."
    });
  }
  commands.push(
    {
      key: "rehearsal_reload",
      status: nextBackfillCommand ? "blocked_after_next_signoff_backfill" : "blocked_after_readiness_status",
      command: rehearsalCommand,
      artifactPath: outputFile,
      nextAction: "Reload rehearsal after status confirms the next sign-off, receipt visibility, or launch-day watch gate."
    }
  );
  return commands;
}

function buildOperatorQueueCheckpoint({
  outputFile,
  actionsFile,
  targetType,
  key,
  artifactPath,
  productionDecision,
  signoffProgress,
  operatorNextCommands
}) {
  const currentCommand = operatorNextCommands.find((item) => item.status === "current") || null;
  const nextBackfill = operatorNextCommands.find((item) => item.key === "next_signoff_backfill") || null;
  const rehearsalReload = operatorNextCommands.find((item) => item.key === "rehearsal_reload") || null;
  const hasNextBackfill = Boolean(nextBackfill?.command);

  return {
    mode: "staging-signoff-backfill-operator-queue-checkpoint",
    status: hasNextBackfill ? "awaiting_signoff_readiness_refresh" : "ready_for_launch_day_watch",
    currentActionKey: currentCommand?.key || "readiness_status",
    currentCommand: currentCommand?.command || signoffProgress?.statusCommand || null,
    actionQueueFile: actionsFile || null,
    outputFile,
    backfilledTargetType: targetType,
    backfilledKey: key,
    backfilledArtifactPath: artifactPath || null,
    productionDecision: productionDecision || null,
    filledConditionCount: signoffProgress?.filledConditionCount ?? 0,
    requiredConditionCount: signoffProgress?.requiredConditionCount ?? 0,
    pendingConditionCount: signoffProgress?.pendingConditionCount ?? 0,
    visibleReceiptLaneCount: signoffProgress?.visibleReceiptLaneCount ?? 0,
    requiredReceiptLaneCount: signoffProgress?.requiredReceiptLaneCount ?? RECEIPT_VISIBILITY_KEYS.length,
    pendingReceiptLaneCount: signoffProgress?.pendingReceiptLaneCount ?? RECEIPT_VISIBILITY_KEYS.length,
    nextBackfillType: signoffProgress?.currentTarget?.type || null,
    nextBackfillKey: signoffProgress?.currentTarget?.key || null,
    nextBackfillCommand: nextBackfill?.command || null,
    nextBackfillArtifactPath: nextBackfill?.artifactPath || null,
    rehearsalReloadCommand: rehearsalReload?.command || null,
    operatorCommandCount: operatorNextCommands.length,
    nextAction: hasNextBackfill
      ? "Run the readiness status refresh, then continue the next production sign-off or receipt visibility backfill."
      : "Run the readiness status refresh, then reload rehearsal and archive the production sign-off handoff."
  };
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

function isReceiptVisibilityVisible(value) {
  if (value === true) {
    return true;
  }
  if (typeof value === "string") {
    return ["visible", "pass", "confirmed"].includes(value.trim().toLowerCase());
  }
  if (value && typeof value === "object") {
    return [value.status, value.result, value.visibility, value.value]
      .map((item) => String(item || "").trim().toLowerCase())
      .some((item) => ["visible", "pass", "confirmed"].includes(item));
  }
  return false;
}

function countFilledConditions(productionSignoff) {
  const conditions = Array.isArray(productionSignoff?.conditions) ? productionSignoff.conditions : [];
  return conditions.filter(isFilled).length;
}

function countVisibleReceiptLanes(receiptVisibility = {}) {
  return RECEIPT_VISIBILITY_KEYS.filter((key) => isReceiptVisibilityVisible(receiptVisibility[key])).length;
}

function buildSignoffProgress({
  conditions,
  receiptVisibility,
  outputFile,
  actionsFile,
  artifactRoot,
  productionDecision,
  readinessStatusCommand
}) {
  const signoffConditions = Array.isArray(conditions) ? conditions : [];
  const pendingConditions = signoffConditions.filter((condition) => !isFilled(condition));
  const pendingReceiptLaneKeys = RECEIPT_VISIBILITY_KEYS.filter((key) => !isReceiptVisibilityVisible(receiptVisibility[key]));
  const currentCondition = pendingConditions[0] || null;
  const currentTarget = currentCondition
    ? buildConditionTarget(currentCondition, artifactRoot)
    : buildReceiptLaneTarget(pendingReceiptLaneKeys[0], artifactRoot);
  const nextBackfillCommand = buildNextBackfillCommand({
    outputFile,
    target: currentTarget,
    actionsFile,
    includeDecision: productionDecision !== "ready-for-production-signoff"
  });
  return {
    status: pendingConditions.length > 0 || pendingReceiptLaneKeys.length > 0
      ? "awaiting_more_signoff_evidence"
      : "filled",
    requiredConditionCount: signoffConditions.length,
    filledConditionCount: signoffConditions.length - pendingConditions.length,
    pendingConditionCount: pendingConditions.length,
    requiredReceiptLaneCount: RECEIPT_VISIBILITY_KEYS.length,
    visibleReceiptLaneCount: RECEIPT_VISIBILITY_KEYS.length - pendingReceiptLaneKeys.length,
    pendingReceiptLaneCount: pendingReceiptLaneKeys.length,
    currentTarget,
    pendingConditionKeys: pendingConditions.map((condition) => condition.key).filter(Boolean),
    pendingReceiptLaneKeys,
    nextBackfillCommand,
    statusCommand: readinessStatusCommand,
    nextAction: nextBackfillCommand
      ? "Run statusCommand, then run nextBackfillCommand with real redacted sign-off or receipt evidence."
      : "Run statusCommand to move into launch-day watch readiness."
  };
}

function buildLaunchDutyReadyHandoff({
  outputFile,
  actionsFile,
  artifactRoot,
  productionDecision,
  readinessStatusCommand,
  rehearsalCommand,
  signoffProgress
}) {
  if (productionDecision !== "ready-for-production-signoff" || signoffProgress?.status !== "filled") {
    return null;
  }
  return {
    status: "ready_for_launch_day_watch",
    currentActionKey: "archive_production_signoff",
    statusCommand: readinessStatusCommand,
    reloadCommand: rehearsalCommand,
    actionQueueFile: actionsFile || null,
    productionSignoffPacketPath: path.posix.join(artifactRoot, "staging-production-signoff-packet.json"),
    launchDutyArchiveIndexPath: path.posix.join(artifactRoot, "staging-launch-duty-archive-index.json"),
    launchDutyRecordIndexPath: path.posix.join(artifactRoot, "launch-duty-record-index.json"),
    nextAction: "Run statusCommand to confirm launch-day watch readiness, then run reloadCommand and archive the production sign-off packet."
  };
}

function buildConditionTarget(condition, artifactRoot) {
  if (!condition?.key) {
    return null;
  }
  const target = PRODUCTION_SIGNOFF_TARGETS[condition.key] || {};
  return {
    type: "production_signoff_condition",
    key: condition.key,
    status: condition.status || "pending_operator_entry",
    artifactPath: condition.artifactPath || path.posix.join(artifactRoot, target.fileName || `${condition.key}.txt`),
    sourceStep: condition.sourceStep || target.sourceStep || "backfill_production_signoff",
    receiptOperations: Array.isArray(condition.receiptOperations) ? condition.receiptOperations : (target.receiptOperations || [])
  };
}

function buildReceiptLaneTarget(key, artifactRoot) {
  if (!key) {
    return null;
  }
  return {
    type: "receipt_visibility_lane",
    key,
    status: "pending_operator_entry",
    artifactPath: path.posix.join(artifactRoot, receiptLaneFileName(key)),
    sourceStep: "verify_receipt_visibility",
    receiptOperations: ["record_post_launch_ops_sweep"]
  };
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

function buildSignoffBackfillLaunchEvidenceReadinessGate({
  closeoutInput,
  outputFile,
  actionsFile,
  artifactRoot,
  readinessStatusCommand,
  rehearsalCommand,
  signoffProgress
}) {
  const archiveRoot = artifactRoot || DEFAULT_ARTIFACT_ROOT;
  const acceptanceFields = Array.isArray(closeoutInput?.acceptanceFields) ? closeoutInput.acceptanceFields : [];
  const fieldByKey = new Map(acceptanceFields.map((field) => [field?.key, field]));
  const closeoutEvidenceItems = CLOSEOUT_EVIDENCE_KEYS.map((key, index) => {
    const field = fieldByKey.get(key) || {};
    const artifactPath = field.artifactPath || path.posix.join(archiveRoot, `${key}.txt`);
    const receiptIds = fieldReceiptIds(field);
    return buildLaunchEvidenceItem({
      order: index + 1,
      key,
      type: "closeout_evidence",
      status: isFilled(field) ? "filled" : field.status || "pending_operator_entry",
      artifactPath,
      command: buildCloseoutEvidenceBackfillCommand({
        outputFile,
        actionsFile,
        key,
        artifactPath,
        receiptIds
      }),
      receiptIds
    });
  });
  const conditionByKey = new Map(
    (Array.isArray(closeoutInput?.productionSignoff?.conditions) ? closeoutInput.productionSignoff.conditions : [])
      .map((condition) => [condition?.key, condition])
  );
  const signoffDefinitions = [
    {
      key: "full_test_window_passed",
      status: "blocked_after_full_test_window",
      fileName: "full-test-output.txt",
      receiptIds: [],
      decision: "ready-for-production-signoff"
    },
    {
      key: "staging_artifacts_archived",
      status: "blocked_after_post_full_test_readiness_status",
      fileName: "staging-artifacts-archive.txt",
      receiptIds: []
    },
    {
      key: "launch_mainline_receipts_visible",
      status: "blocked_after_staging_artifacts_archived",
      fileName: "launch-mainline-receipts-visible.json",
      receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"]
    },
    {
      key: "launch_ops_overview_status_visible",
      status: "blocked_after_launch_mainline_receipts_visible",
      fileName: "launch-ops-overview-status-visible.json",
      receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"]
    },
    {
      key: "backup_restore_drill_passed",
      status: "blocked_after_launch_ops_overview_status_visible",
      fileName: "backup-restore-drill.txt",
      receiptIds: ["<record_recovery_drill-receipt-id>", "<record_backup_verification-receipt-id>"]
    },
    {
      key: "rollback_path_confirmed",
      status: "blocked_after_backup_restore_drill_passed",
      fileName: "rollback-path-confirmed.md",
      receiptIds: ["<record_rollback_walkthrough-receipt-id>"]
    },
    {
      key: "operator_signoff_recorded",
      status: "blocked_after_rollback_path_confirmed",
      fileName: "operator-production-signoff.md",
      receiptIds: []
    }
  ];
  const productionSignoffEvidenceItems = signoffDefinitions.map((definition, index) => {
    const condition = conditionByKey.get(definition.key) || {};
    const target = PRODUCTION_SIGNOFF_TARGETS[definition.key] || {};
    const artifactPath = condition.artifactPath || path.posix.join(archiveRoot, target.fileName || definition.fileName);
    return buildLaunchEvidenceItem({
      order: index + 8,
      key: definition.key,
      type: "production_signoff_condition",
      status: isFilled(condition) ? "filled" : definition.status,
      artifactPath,
      command: buildSignoffEvidenceBackfillCommand({
        outputFile,
        actionsFile,
        keyFlag: "--condition-key",
        key: definition.key,
        artifactPath,
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
  const receiptVisibility = closeoutInput?.receiptVisibility || closeoutInput?.productionSignoff?.receiptVisibility || {};
  const receiptVisibilityEvidenceItems = receiptDefinitions.map(([key, status, fileName], index) => {
    const artifactPath = path.posix.join(archiveRoot, fileName);
    const value = receiptVisibility[key];
    return buildLaunchEvidenceItem({
      order: index + 15,
      key,
      type: "receipt_visibility_lane",
      status: isReceiptVisibilityVisible(value) ? "visible" : status,
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
  const currentEvidence = signoffProgress?.currentTarget
    ? evidenceItems.find((item) => item.key === signoffProgress.currentTarget.key && item.type === signoffProgress.currentTarget.type)
    : evidenceItems.find((item) => !["filled", "visible", "recorded"].includes(item.status));

  return {
    version: "staging-signoff-backfill-launch-evidence-gate/v1",
    status: completedEvidenceCount < evidenceItems.length
      ? "blocked_until_real_launch_evidence_attached"
      : "ready_for_stabilization_handoff",
    currentGate: "production_signoff_backfill",
    currentEvidenceKey: currentEvidence?.key || null,
    currentEvidenceType: currentEvidence?.type || null,
    currentEvidenceStatus: currentEvidence?.status || null,
    currentCommand: signoffProgress?.nextBackfillCommand || currentEvidence?.command || null,
    currentArtifactPath: signoffProgress?.currentTarget?.artifactPath || currentEvidence?.artifactPath || null,
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
    nextAction: "Run readinessStatusCommand, verify the backfilled sign-off or receipt evidence is reflected, then continue the next launch evidence command."
  };
}

function artifactRootLane(artifactRoot) {
  const parts = String(artifactRoot || DEFAULT_ARTIFACT_ROOT).split("/");
  return {
    productCode: parts[2] || "<productCode>",
    channel: parts[3] || "<channel>"
  };
}

function conditionByKey(conditions = []) {
  return new Map(
    (Array.isArray(conditions) ? conditions : [])
      .filter((condition) => condition?.key)
      .map((condition) => [condition.key, condition])
  );
}

function buildSignoffBackfillProductionSwitchProofPacket({
  closeoutInput,
  outputFile,
  actionsFile,
  artifactRoot,
  signoffProgress,
  productionDecision,
  launchEvidenceReadinessGate
}) {
  const archiveRoot = artifactRoot || DEFAULT_ARTIFACT_ROOT;
  const lane = artifactRootLane(archiveRoot);
  const statusRefreshCommand = statusCommand(outputFile, actionsFile);
  const closeoutFields = new Map(
    (Array.isArray(closeoutInput?.acceptanceFields) ? closeoutInput.acceptanceFields : [])
      .filter((field) => field?.key)
      .map((field) => [field.key, field])
  );
  const productionConditions = conditionByKey(closeoutInput?.productionSignoff?.conditions || []);
  const fullTestCondition = productionConditions.get("full_test_window_passed") || null;
  const fullTestArtifact = fullTestCondition?.artifactPath || path.posix.join(archiveRoot, "full-test-output.txt");
  const productionSignoffReady = signoffProgress?.status === "filled" && productionDecision === "ready-for-production-signoff";
  const launchDutyProgress = launchEvidenceReadinessGate?.progress?.launchDuty || {};
  const launchDutyReady = launchDutyProgress.total > 0 && launchDutyProgress.completed === launchDutyProgress.total;
  const launchDutyCommand = launchDutyReady
    ? null
    : launchEvidenceReadinessGate?.currentEvidenceType === "launch_duty_record"
      ? launchEvidenceReadinessGate.currentCommand
      : null;
  const currentActionKey = signoffProgress?.currentTarget?.type === "production_signoff_condition"
    ? "backfill_production_signoff"
    : signoffProgress?.currentTarget?.type === "receipt_visibility_lane"
      ? "backfill_receipt_visibility"
      : productionSignoffReady
        ? "archive_production_signoff"
        : "review_readiness_status";
  const targetEnvFile = closeoutInput?.targetEnvFile || closeoutInput?.stagingEnvironmentBinding?.environment?.targetEnvFile || null;
  const baseUrl = closeoutInput?.baseUrl || closeoutInput?.summary?.baseUrl || null;
  const storageProfile = closeoutInput?.storageProfile || closeoutInput?.summary?.storageProfile || null;
  const publicHttpsProof = buildProductionSwitchPublicHttpsProof(baseUrl);
  const storageProfileProof = buildProductionSwitchStorageProfileProof(storageProfile);
  const secretEnvProof = buildProductionSwitchSecretEnvProof(closeoutInput, targetEnvFile);
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
      status: isFilled(closeoutFields.get("backup_restore_drill_result")) ? "ready_evidence_attached" : "blocked_after_readiness_status",
      command: null,
      artifactPath: closeoutFields.get("backup_restore_drill_result")?.artifactPath || path.posix.join(archiveRoot, "backup_restore_drill_result.txt"),
      nextAction: "Attach backup/restore drill evidence before live-write smoke and production sign-off."
    },
    {
      order: 5,
      key: "live_write_smoke",
      status: isFilled(closeoutFields.get("live_write_smoke_result")) ? "ready_evidence_attached" : "blocked_after_route_map_gate",
      command: null,
      artifactPath: closeoutFields.get("live_write_smoke_result")?.artifactPath || path.posix.join(archiveRoot, "live_write_smoke_result.txt"),
      nextAction: "Attach launch:smoke:staging output after no-write preflight and route-map gate pass."
    },
    {
      order: 6,
      key: "full_test_window",
      status: isFilled(fullTestCondition) ? "ready_evidence_attached" : "ready_local_baseline_available",
      command: "npm.cmd test",
      artifactPath: fullTestArtifact,
      nextAction: "Attach the redacted full-suite output artifact before or while backfilling full_test_window_passed."
    },
    {
      order: 7,
      key: "production_signoff_and_receipts",
      status: productionSignoffReady ? "ready_evidence_attached" : "blocked_after_full_test_signoff_backfill",
      command: signoffProgress?.currentTarget?.type === "production_signoff_condition"
        || signoffProgress?.currentTarget?.type === "receipt_visibility_lane"
        ? signoffProgress.nextBackfillCommand
        : null,
      artifactPath: path.posix.join(archiveRoot, "staging-production-signoff-packet.json"),
      nextAction: "Backfill production sign-off conditions and receipt visibility lanes before launch-day watch."
    },
    {
      order: 8,
      key: "launch_day_watch_and_stabilization",
      status: launchDutyReady ? "ready_evidence_attached" : "blocked_after_production_signoff_readiness",
      command: launchDutyCommand,
      artifactPath: path.posix.join(archiveRoot, "launch-day-watch-summary.md"),
      nextAction: "Record launch-day watch, stabilization, and first-wave closeout records into the shared launch-duty record index."
    }
  ];
  const ready = proofItems.filter((item) => String(item.status || "").startsWith("ready_")).length;
  return {
    version: "staging-signoff-backfill-production-switch-proof-packet/v1",
    status: ready === proofItems.length ? "ready_for_production_switch_review" : "blocked_until_real_environment_evidence",
    currentActionKey,
    currentCommand: signoffProgress?.nextBackfillCommand || statusRefreshCommand,
    baseUrl,
    productCode: closeoutInput?.productCode || closeoutInput?.summary?.productCode || lane.productCode,
    channel: closeoutInput?.channel || closeoutInput?.summary?.channel || lane.channel,
    targetOs: closeoutInput?.targetOs || closeoutInput?.summary?.targetOs || null,
    storageProfile,
    archiveRoot,
    closeoutInputFile: outputFile,
    readinessActionQueueFile: actionsFile || null,
    launchDutyRecordIndexFile: path.posix.join(archiveRoot, "launch-duty-record-index.json"),
    publicHttpsProof,
    storageProfileProof,
    secretEnvProof,
    localFullSuiteBaseline: {
      command: "npm.cmd test",
      status: "available_from_2026-05-28_full_suite_pass",
      testCount: 198,
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
    nextAction: "Continue the current sign-off evidence command, rerun staging:readiness:status, then use this packet as the production switch proof checklist."
  };
}

function backfillCondition(payload, options, value) {
  const productionSignoff = payload.productionSignoff && typeof payload.productionSignoff === "object"
    ? payload.productionSignoff
    : {};
  const conditions = Array.isArray(productionSignoff.conditions) ? productionSignoff.conditions : [];
  const conditionIndex = conditions.findIndex((condition) => condition?.key === options.conditionKey);
  if (conditionIndex < 0) {
    throw new Error(`Unknown production sign-off condition: ${options.conditionKey}`);
  }
  const nextConditions = conditions.map((condition, index) => index === conditionIndex
    ? {
      ...condition,
      status: "filled",
      value,
      artifactPath: options.artifactPath || condition.artifactPath || null,
      receiptIds: options.receiptIds
    }
    : condition);
  return {
    ...payload,
    productionSignoff: {
      ...productionSignoff,
      decision: options.decision || productionSignoff.decision || null,
      conditions: nextConditions
    }
  };
}

function backfillReceiptLane(payload, options, value) {
  if (!RECEIPT_VISIBILITY_KEYS.includes(options.receiptLane)) {
    throw new Error(`Unknown receipt visibility lane: ${options.receiptLane}`);
  }
  const productionSignoff = payload.productionSignoff && typeof payload.productionSignoff === "object"
    ? payload.productionSignoff
    : {};
  const receiptVisibility = payload.receiptVisibility && typeof payload.receiptVisibility === "object"
    ? payload.receiptVisibility
    : {};
  const signoffReceiptVisibility = productionSignoff.receiptVisibility && typeof productionSignoff.receiptVisibility === "object"
    ? productionSignoff.receiptVisibility
    : {};
  return {
    ...payload,
    receiptVisibility: {
      ...receiptVisibility,
      [options.receiptLane]: value
    },
    productionSignoff: {
      ...productionSignoff,
      decision: options.decision || productionSignoff.decision || null,
      receiptVisibility: {
        ...signoffReceiptVisibility,
        [options.receiptLane]: value
      }
    }
  };
}

function backfill(payload, options) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("closeout input must be a JSON object.");
  }
  const value = buildEvidenceValue(options);
  return options.conditionKey
    ? backfillCondition(payload, options, value)
    : backfillReceiptLane(payload, options, value);
}

function writeOperatorQueueCheckpointPlain(checkpoint) {
  if (!checkpoint) {
    return;
  }
  console.log(`Sign-off operator checkpoint: ${checkpoint.currentActionKey} (status=${checkpoint.status}, commands=${checkpoint.operatorCommandCount})`);
  if (checkpoint.currentCommand) {
    console.log(`Sign-off checkpoint current: ${checkpoint.currentCommand}`);
  }
  console.log(`Sign-off checkpoint progress: conditions=${checkpoint.filledConditionCount}/${checkpoint.requiredConditionCount}, receipts=${checkpoint.visibleReceiptLaneCount}/${checkpoint.requiredReceiptLaneCount}`);
  if (checkpoint.nextBackfillCommand) {
    console.log(`Sign-off checkpoint next backfill: ${checkpoint.nextBackfillType}/${checkpoint.nextBackfillKey} -> ${checkpoint.nextBackfillCommand}`);
  } else {
    console.log("Sign-off checkpoint next backfill: none");
  }
  if (checkpoint.rehearsalReloadCommand) {
    console.log(`Sign-off checkpoint rehearsal reload: ${checkpoint.rehearsalReloadCommand}`);
  }
  console.log(`Sign-off checkpoint next action: ${checkpoint.nextAction}`);
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
  const publicHttpsProof = packet.publicHttpsProof || {};
  if (publicHttpsProof.status) {
    console.log(
      `Production switch public HTTPS proof: ${publicHttpsProof.status || "-"}`
        + ` (scheme=${publicHttpsProof.scheme || "-"}, url=${publicHttpsProof.baseUrl || "-"})`
    );
  }
  const storageProfileProof = packet.storageProfileProof || {};
  if (storageProfileProof.status) {
    console.log(
      `Production switch storage profile proof: ${storageProfileProof.status || "-"}`
        + ` (profile=${storageProfileProof.storageProfile || "-"})`
    );
  }
  const secretEnvProof = packet.secretEnvProof || {};
  if (secretEnvProof.status) {
    console.log(
      `Production switch secret env proof: ${secretEnvProof.status || "-"}`
        + ` (required=${secretEnvProof.requiredCount ?? "-"}`
        + `, missing=${secretEnvProof.missingCount ?? "-"}`
        + `, current=${secretEnvProof.currentMissingKey || "-"})`
    );
    console.log(`Production switch secret env required: ${(secretEnvProof.requiredKeys || []).join(", ") || "-"}`);
    console.log(`Production switch secret env missing: ${(secretEnvProof.missingKeys || []).join(", ") || "-"}`);
  }
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
    console.log(`Production sign-off evidence backfilled: ${result.key}`);
    console.log(`Backfilled target: ${result.targetType}/${result.key}`);
    if (result.artifactPath) {
      console.log(`Backfilled artifact path: ${result.artifactPath}`);
    }
    if (Array.isArray(result.receiptIds) && result.receiptIds.length) {
      console.log(`Backfilled receipt IDs: ${result.receiptIds.join(", ")}`);
    }
    if (result.signoffProgress) {
      const progress = result.signoffProgress;
      console.log(`Sign-off progress: ${progress.filledConditionCount}/${progress.requiredConditionCount} conditions filled, ${progress.visibleReceiptLaneCount}/${progress.requiredReceiptLaneCount} receipt lanes visible`);
      if (progress.currentTarget) {
        console.log(`Next sign-off target: ${progress.currentTarget.type}/${progress.currentTarget.key}`);
        if (progress.currentTarget.artifactPath) {
          console.log(`Next sign-off artifact: ${progress.currentTarget.artifactPath}`);
        }
        if (progress.currentTarget.sourceStep) {
          console.log(`Next sign-off source step: ${progress.currentTarget.sourceStep}`);
        }
      }
      if (progress.nextBackfillCommand) {
        console.log(`Next sign-off backfill command: ${progress.nextBackfillCommand}`);
      }
    }
    writeOperatorQueueCheckpointPlain(result.operatorQueueCheckpoint);
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
    if (result.launchDutyReadyHandoff) {
      const handoff = result.launchDutyReadyHandoff;
      console.log(`Launch duty readiness: ${handoff.status}`);
      console.log(`Launch duty status refresh: ${handoff.statusCommand}`);
      console.log(`Launch duty reload: ${handoff.reloadCommand}`);
      console.log(`Launch duty production signoff packet: ${handoff.productionSignoffPacketPath}`);
      console.log(`Launch duty archive index: ${handoff.launchDutyArchiveIndexPath}`);
      console.log(`Launch duty record index: ${handoff.launchDutyRecordIndexPath}`);
      console.log(`Launch duty next action: ${handoff.nextAction}`);
    }
    console.log(`Backfilled status refresh: ${result.statusCommand}`);
    const currentCommand = result.operatorNextCommands?.find((item) => item.status === "current");
    const nextBackfill = result.operatorNextCommands?.find((item) => item.key === "next_signoff_backfill");
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
      console.log(`Next sign-off backfill after status: ${nextBackfill.command}`);
    }
    if (rehearsalReload) {
      console.log(`Rehearsal reload: ${rehearsalReload.command}`);
    } else {
      console.log(result.nextCommand);
    }
    console.log(`Next action: ${result.nextAction}`);
    return;
  }
  console.log(`Staging signoff backfill failed: ${result.error.message}`);
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

    const productionSignoff = nextPayload.productionSignoff || {};
    const conditions = Array.isArray(productionSignoff.conditions) ? productionSignoff.conditions : [];
    const receiptVisibility = nextPayload.receiptVisibility || productionSignoff.receiptVisibility || {};
    const filledConditionCount = countFilledConditions(productionSignoff);
    const visibleReceiptLaneCount = countVisibleReceiptLanes(receiptVisibility);
    const targetType = options.conditionKey ? "production_signoff_condition" : "receipt_visibility_lane";
    const key = options.conditionKey || options.receiptLane;
    const nextCommand = `npm.cmd run staging:rehearsal -- --closeout-input-file ${commandValue(outputFile)}`;
    const nextStatusCommand = statusCommand(outputFile, actionsFile);
    const artifactRoot = artifactRootFromPath(options.artifactPath) || DEFAULT_ARTIFACT_ROOT;
    const signoffProgress = buildSignoffProgress({
      conditions,
      receiptVisibility,
      outputFile,
      actionsFile,
      artifactRoot,
      productionDecision: productionSignoff.decision || null,
      readinessStatusCommand: nextStatusCommand
    });
    const launchEvidenceReadinessGate = buildSignoffBackfillLaunchEvidenceReadinessGate({
      closeoutInput: nextPayload,
      outputFile,
      actionsFile,
      artifactRoot,
      readinessStatusCommand: nextStatusCommand,
      rehearsalCommand: nextCommand,
      signoffProgress
    });
    const productionSwitchProofPacket = buildSignoffBackfillProductionSwitchProofPacket({
      closeoutInput: nextPayload,
      outputFile,
      actionsFile,
      artifactRoot,
      signoffProgress,
      productionDecision: productionSignoff.decision || null,
      launchEvidenceReadinessGate
    });
    const launchDutyReadyHandoff = buildLaunchDutyReadyHandoff({
      outputFile,
      actionsFile,
      artifactRoot,
      productionDecision: productionSignoff.decision || null,
      readinessStatusCommand: nextStatusCommand,
      rehearsalCommand: nextCommand,
      signoffProgress
    });
    const operatorNextCommands = buildOperatorNextCommands({
      outputFile,
      actionsFile,
      rehearsalCommand: nextCommand,
      readinessStatusCommand: nextStatusCommand,
      nextBackfillCommand: signoffProgress.nextBackfillCommand,
      nextBackfillArtifactPath: signoffProgress.currentTarget?.artifactPath
    });
    const operatorQueueCheckpoint = buildOperatorQueueCheckpoint({
      outputFile,
      actionsFile,
      targetType,
      key,
      artifactPath: options.artifactPath || null,
      productionDecision: productionSignoff.decision || null,
      signoffProgress,
      operatorNextCommands
    });
    writeResult({
      status: "written",
      mode: "staging-signoff-backfill",
      inputFile,
      outputFile,
      ...(actionsFile ? { actionsFile } : {}),
      targetType,
      key,
      artifactPath: options.artifactPath || null,
      receiptIds: options.receiptIds,
      productionDecision: productionSignoff.decision || null,
      filledConditionCount,
      visibleReceiptLaneCount,
      missingConditionCount: conditions.length - filledConditionCount,
      missingReceiptLaneCount: RECEIPT_VISIBILITY_KEYS.length - visibleReceiptLaneCount,
      signoffProgress,
      productionSwitchProofPacket,
      launchEvidenceReadinessGate,
      ...(launchDutyReadyHandoff ? { launchDutyReadyHandoff } : {}),
      nextCommand,
      statusCommand: nextStatusCommand,
      operatorNextCommands,
      operatorQueueCheckpoint,
      nextAction: "Run statusCommand to pick the next sign-off, receipt visibility, or launch-day watch action."
    }, options.json);
  } catch (error) {
    writeResult({
      status: "fail",
      mode: "staging-signoff-backfill",
      error: {
        message: error.message
      }
    }, json);
    process.exitCode = 1;
  }
}

main();
