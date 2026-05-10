#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RECEIPT_VISIBILITY_KEYS = [
  "launchMainline",
  "launchReview",
  "launchSmoke",
  "developerOps",
  "launchOpsOverviewStatus"
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
    const launchDutyReadyHandoff = buildLaunchDutyReadyHandoff({
      outputFile,
      actionsFile,
      artifactRoot,
      productionDecision: productionSignoff.decision || null,
      readinessStatusCommand: nextStatusCommand,
      rehearsalCommand: nextCommand,
      signoffProgress
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
      ...(launchDutyReadyHandoff ? { launchDutyReadyHandoff } : {}),
      nextCommand,
      statusCommand: nextStatusCommand,
      operatorNextCommands: buildOperatorNextCommands({
        outputFile,
        actionsFile,
        rehearsalCommand: nextCommand,
        readinessStatusCommand: nextStatusCommand,
        nextBackfillCommand: signoffProgress.nextBackfillCommand,
        nextBackfillArtifactPath: signoffProgress.currentTarget?.artifactPath
      }),
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
