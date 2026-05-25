#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RECORD_INDEX_FILE_NAME = "launch-duty-record-index.json";

const RECORD_SEQUENCE = [
  "launch_day_watch_summary",
  "receipt_visibility_snapshot",
  "first_wave_incident_log",
  "rollback_signal_review",
  "stabilization_owner_handoff",
  "first_wave_closeout"
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

const PRODUCTION_SIGNOFF_DEFINITIONS = [
  {
    key: "full_test_window_passed",
    fileName: "full-test-output.txt",
    receiptOperations: [],
    decision: "ready-for-production-signoff"
  },
  {
    key: "staging_artifacts_archived",
    fileName: "staging-artifacts-archive.txt",
    receiptOperations: []
  },
  {
    key: "launch_mainline_receipts_visible",
    fileName: "launch-mainline-receipts-visible.json",
    receiptOperations: ["record_post_launch_ops_sweep"]
  },
  {
    key: "launch_ops_overview_status_visible",
    fileName: "launch-ops-overview-status-visible.json",
    receiptOperations: ["record_post_launch_ops_sweep"]
  },
  {
    key: "backup_restore_drill_passed",
    fileName: "backup-restore-drill.txt",
    receiptOperations: ["record_recovery_drill", "record_backup_verification"]
  },
  {
    key: "rollback_path_confirmed",
    fileName: "rollback-path-confirmed.md",
    receiptOperations: ["record_rollback_walkthrough"]
  },
  {
    key: "operator_signoff_recorded",
    fileName: "operator-production-signoff.md",
    receiptOperations: []
  }
];

const RECEIPT_VISIBILITY_DEFINITIONS = [
  ["launchMainline", "launch-mainline-receipt-visibility.json"],
  ["launchReview", "launch-review-receipt-visibility.json"],
  ["launchSmoke", "launch-smoke-receipt-visibility.json"],
  ["developerOps", "developer-ops-receipt-visibility.json"],
  ["launchOpsOverviewStatus", "launch-ops-overview-status-receipt-visibility.json"]
];

const LAUNCH_DUTY_RECORDS = {
  launch_day_watch_summary: {
    actionKey: "record_launch_day_watch_summary",
    fileName: "launch-day-watch-summary.md",
    category: "launch_day_watch_record",
    receiptOperations: ["record_cutover_walkthrough", "record_launch_day_readiness_review"],
    expectedEvidence: "Record cutover watch start/end time, owner, route checks, and launch-day operator decisions.",
    nextAction: "Record receipt visibility snapshot, incident log, rollback review, and stabilization owner handoff before first-wave closeout."
  },
  receipt_visibility_snapshot: {
    actionKey: "record_receipt_visibility_snapshot",
    fileName: "receipt-visibility-snapshot.txt",
    category: "launch_day_watch_record",
    receiptOperations: ["record_post_launch_ops_sweep"],
    expectedEvidence: "Save Launch Mainline, Developer Ops, Launch Review, Launch Smoke, and Launch Ops Overview Status receipt visibility snapshots.",
    nextAction: "Record first-wave incident log after the receipt visibility snapshot is saved."
  },
  first_wave_incident_log: {
    actionKey: "record_first_wave_incident_log",
    fileName: "first-wave-incident-log.md",
    category: "launch_day_watch_record",
    receiptOperations: ["record_post_launch_ops_sweep"],
    expectedEvidence: "Record first-wave incidents, customer impact, mitigation, owner, and status.",
    nextAction: "Record rollback signal review after the incident log is saved."
  },
  rollback_signal_review: {
    actionKey: "record_rollback_signal_review",
    fileName: "rollback-signal-review.md",
    category: "launch_day_watch_record",
    receiptOperations: ["record_rollback_walkthrough", "record_launch_stabilization_review"],
    expectedEvidence: "Record whether rollback signals were observed, dismissed, or escalated.",
    nextAction: "Record stabilization owner handoff after rollback signals are reviewed."
  },
  stabilization_owner_handoff: {
    actionKey: "handoff_stabilization_owner",
    fileName: "stabilization-owner-handoff.md",
    category: "launch_day_watch_record",
    receiptOperations: ["record_launch_stabilization_review"],
    expectedEvidence: "Record stabilization owner, timestamp, unresolved items, and next-duty follow-up.",
    nextAction: "Close first-wave stabilization with incident, rollback, and owner-handoff records attached."
  },
  first_wave_closeout: {
    actionKey: "close_first_wave",
    fileName: "first-wave-closeout.md",
    category: "first_wave_closeout",
    receiptOperations: ["record_launch_closeout_review"],
    sourceRecordKeys: ["first_wave_incident_log", "rollback_signal_review", "stabilization_owner_handoff"],
    expectedEvidence: "Record first-wave closeout decision, unresolved incident list, customer impact notes, next-duty owner, and follow-up timestamp.",
    nextAction: "Refresh readiness status and reload rehearsal with the first-wave closeout artifact attached."
  }
};

const OPTION_FLAGS = {
  "--closeout-input-file": "closeoutInputFile",
  "--actions-file": "actionsFile",
  "--key": "key",
  "--artifact-path": "artifactPath",
  "--value-json": "valueJson",
  "--record-index-file": "recordIndexFile",
  "--receipt-id": "receiptIds",
  "--source-record": "sourceRecords"
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
    receiptIds: [],
    sourceRecords: []
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
    if (key === "receiptIds" || key === "sourceRecords") {
      options[key].push(value);
    } else {
      options[key] = value;
    }
    if (inlineValue === undefined) {
      index += 1;
    }
  }
  for (const required of ["closeoutInputFile", "key", "artifactPath", "valueJson"]) {
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

function receiptIdArgs(receiptOperations = []) {
  return receiptOperations
    .filter(Boolean)
    .map((operation) => ` --receipt-id <${operation}-receipt-id>`)
    .join("");
}

function sourceRecordArgs(sourceRecordKeys = [], sourceRecordPaths = {}) {
  return sourceRecordKeys
    .filter(Boolean)
    .map((key) => {
      const value = sourceRecordPaths[key]
        ? `${key}=${sourceRecordPaths[key]}`
        : `${key}=<${key}-artifact-path>`;
      return ` --source-record ${commandValue(value)}`;
    })
    .join("");
}

function statusCommand(closeoutInputFile, actionsFile = null) {
  const actionsArg = actionsFile ? ` --actions-file ${commandValue(actionsFile)}` : "";
  return `npm.cmd run staging:readiness:status -- --input-file ${commandValue(closeoutInputFile)}${actionsArg}`;
}

function reloadCommand(closeoutInputFile) {
  return `npm.cmd run staging:rehearsal -- --closeout-input-file ${commandValue(closeoutInputFile)}`;
}

function nextArtifactPath(currentArtifactPath, nextKey) {
  const target = LAUNCH_DUTY_RECORDS[nextKey];
  if (!target) {
    return null;
  }
  if (!path.isAbsolute(currentArtifactPath) && currentArtifactPath.includes("/")) {
    return path.posix.join(path.posix.dirname(currentArtifactPath.replaceAll("\\", "/")), target.fileName);
  }
  return path.join(path.dirname(currentArtifactPath), target.fileName);
}

function defaultRecordIndexFile(artifactPath) {
  if (!artifactPath) {
    return RECORD_INDEX_FILE_NAME;
  }
  if (!path.isAbsolute(artifactPath) && artifactPath.includes("/")) {
    return path.posix.join(path.posix.dirname(artifactPath.replaceAll("\\", "/")), RECORD_INDEX_FILE_NAME);
  }
  return path.join(path.dirname(artifactPath), RECORD_INDEX_FILE_NAME);
}

function archiveRootFromCloseoutInputFile(closeoutInputFile) {
  const root = path.dirname(closeoutInputFile || "");
  if (!root || root === ".") {
    return "artifacts/staging/<productCode>/<channel>";
  }
  return root;
}

function joinArtifactPath(root, fileName) {
  if (path.isAbsolute(root)) {
    return path.join(root, fileName);
  }
  return path.posix.join(root.replaceAll("\\", "/"), fileName);
}

function buildRecordCommand({ closeoutInputFile, actionsFile, key, artifactPath, recordIndexFile, sourceRecordPaths }) {
  const target = LAUNCH_DUTY_RECORDS[key];
  if (!target) {
    return null;
  }
  const actionsArg = actionsFile ? ` --actions-file ${commandValue(actionsFile)}` : "";
  const recordIndexArg = recordIndexFile ? ` --record-index-file ${commandValue(recordIndexFile)}` : "";
  return [
    "npm.cmd run staging:launch-duty:record --",
    `--closeout-input-file ${commandValue(closeoutInputFile)}`,
    `--key ${commandValue(key)}`,
    `--artifact-path ${commandValue(artifactPath)}`,
    "--value-json <redacted-json>",
    receiptIdArgs(target.receiptOperations).trimStart(),
    sourceRecordArgs(target.sourceRecordKeys, sourceRecordPaths).trimStart(),
    recordIndexArg.trimStart(),
    actionsArg.trimStart()
  ].filter(Boolean).join(" ");
}

function buildCloseoutEvidenceBackfillCommand({
  closeoutInputFile,
  actionsFile = null,
  key,
  artifactPath
}) {
  const actionsArg = actionsFile ? ` --actions-file ${commandValue(actionsFile)}` : "";
  return [
    "npm.cmd run staging:closeout:backfill --",
    `--input-file ${commandValue(closeoutInputFile)}`,
    `--key ${commandValue(key)}`,
    "--value-json <redacted-json>",
    `--artifact-path ${commandValue(artifactPath)}`,
    actionsArg.trimStart()
  ].filter(Boolean).join(" ");
}

function buildSignoffEvidenceBackfillCommand({
  closeoutInputFile,
  actionsFile = null,
  keyFlag,
  key,
  artifactPath,
  receiptOperations = [],
  decision = null
}) {
  const actionsArg = actionsFile ? ` --actions-file ${commandValue(actionsFile)}` : "";
  const decisionArg = decision ? ` --decision ${decision}` : "";
  return [
    "npm.cmd run staging:signoff:backfill --",
    `--input-file ${commandValue(closeoutInputFile)}`,
    `${keyFlag} ${commandValue(key)}`,
    "--value-json <redacted-json>",
    `--artifact-path ${commandValue(artifactPath)}`,
    receiptIdArgs(receiptOperations).trimStart(),
    decisionArg.trimStart(),
    actionsArg.trimStart()
  ].filter(Boolean).join(" ");
}

function parseSourceRecord(value) {
  const separator = value.indexOf("=");
  if (separator < 1) {
    return {
      key: value,
      path: null
    };
  }
  return {
    key: value.slice(0, separator),
    path: value.slice(separator + 1)
  };
}

function renderSourceRecords(sourceRecords = []) {
  if (!sourceRecords.length) {
    return "-";
  }
  return sourceRecords.map((item) => `${item.key}${item.path ? `=${item.path}` : ""}`).join("; ");
}

function requiredSourceRecordKeysMissing(target, sourceRecords) {
  const providedKeys = new Set(sourceRecords.map((item) => item.key).filter(Boolean));
  return (target.sourceRecordKeys || []).filter((key) => !providedKeys.has(key));
}

function sourceRecordsWithIndexFallback(target, sourceRecords, records = {}) {
  const sourceRecordsByKey = new Map(sourceRecords.map((item) => [item.key, item]));
  for (const key of target.sourceRecordKeys || []) {
    if (!sourceRecordsByKey.has(key) && records[key]?.artifactPath) {
      sourceRecordsByKey.set(key, {
        key,
        path: records[key].artifactPath
      });
    }
  }
  return [...sourceRecordsByKey.values()];
}

function renderArtifactMarkdown({ key, target, artifactPath, value, receiptIds, sourceRecords }) {
  const lines = [
    "# Staging Launch Duty Record",
    "",
    `Key: \`${key}\``,
    `Action key: \`${target.actionKey}\``,
    `Category: \`${target.category}\``,
    `Artifact: \`${artifactPath}\``,
    `Expected evidence: ${target.expectedEvidence}`,
    `Receipt operations: \`${target.receiptOperations.join(", ") || "-"}\``,
    `Receipt IDs: \`${receiptIds.join(", ") || "-"}\``,
    `Source records: \`${renderSourceRecords(sourceRecords)}\``,
    "",
    "Evidence JSON:",
    "",
    "```json",
    JSON.stringify(value, null, 2),
    "```",
    "",
    `Next action: ${target.nextAction}`,
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function loadRecordIndex(recordIndexFile) {
  const resolvedRecordIndexFile = path.resolve(recordIndexFile);
  if (!existsSync(resolvedRecordIndexFile)) {
    return {
      mode: "staging-launch-duty-record-index",
      version: 1,
      records: {}
    };
  }
  const payload = JSON.parse(readFileSync(resolvedRecordIndexFile, "utf8"));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`launch duty record index must be a JSON object: ${recordIndexFile}`);
  }
  return {
    ...payload,
    records: payload.records && typeof payload.records === "object" && !Array.isArray(payload.records)
      ? payload.records
      : {}
  };
}

function recordIndexProgress(records) {
  const recordedKeys = RECORD_SEQUENCE.filter((key) => records[key]?.status === "recorded");
  const pendingKeys = RECORD_SEQUENCE.filter((key) => !recordedKeys.includes(key));
  return {
    status: pendingKeys.length === 0 ? "complete" : "in_progress",
    recordedKeys,
    pendingKeys,
    recordedCount: recordedKeys.length,
    pendingCount: pendingKeys.length,
    nextRecordKey: pendingKeys[0] || null
  };
}

function sourceRecordPathsFromRecords(sourceRecordKeys = [], records = {}) {
  return Object.fromEntries(
    sourceRecordKeys
      .map((key) => [key, records[key]?.artifactPath])
      .filter(([, artifactPath]) => artifactPath)
  );
}

function buildIndexNextRecordCommand({ progress, options, recordIndexFile, records }) {
  if (!progress.nextRecordKey) {
    return null;
  }
  const target = LAUNCH_DUTY_RECORDS[progress.nextRecordKey];
  return buildRecordCommand({
    closeoutInputFile: options.closeoutInputFile,
    actionsFile: options.actionsFile,
    key: progress.nextRecordKey,
    artifactPath: nextArtifactPath(options.artifactPath, progress.nextRecordKey),
    recordIndexFile,
    sourceRecordPaths: sourceRecordPathsFromRecords(target?.sourceRecordKeys, records)
  });
}

function buildCompletionHandoff({ progress, records, options, recordIndexFile, statusRefreshCommand, rehearsalReloadCommand }) {
  if (progress.status !== "complete") {
    return null;
  }
  const firstWaveCloseoutRecord = records.first_wave_closeout;
  if (!firstWaveCloseoutRecord?.artifactPath) {
    return null;
  }
  return {
    status: "ready_for_stabilization_handoff",
    completedAt: firstWaveCloseoutRecord.recordedAt,
    closeoutInputFile: options.closeoutInputFile,
    actionsFile: options.actionsFile || null,
    recordIndexFile,
    recordedCount: progress.recordedCount,
    pendingCount: progress.pendingCount,
    completedRecordKeys: progress.recordedKeys,
    firstWaveCloseoutArtifactPath: firstWaveCloseoutRecord.artifactPath,
    sourceRecords: firstWaveCloseoutRecord.sourceRecords || [],
    handoffArtifacts: [recordIndexFile, firstWaveCloseoutRecord.artifactPath],
    statusCommand: statusRefreshCommand,
    rehearsalReloadCommand,
    nextAction: "Refresh readiness status, reload rehearsal, then hand off the launch-duty record index and first-wave closeout artifact to the stabilization owner."
  };
}

function buildRecordIndexEntry({ options, target, value, sourceRecords, recordedAt }) {
  return {
    key: options.key,
    status: "recorded",
    actionKey: target.actionKey,
    category: target.category,
    artifactPath: options.artifactPath,
    receiptOperations: target.receiptOperations,
    receiptIds: options.receiptIds,
    sourceRecords,
    expectedEvidence: target.expectedEvidence,
    value,
    recordedAt
  };
}

function buildRecordIndex({ existingIndex, recordEntry, options, recordIndexFile, statusRefreshCommand, rehearsalReloadCommand }) {
  const records = {
    ...existingIndex.records,
    [options.key]: recordEntry
  };
  const progress = recordIndexProgress(records);
  const nextRecordCommand = buildIndexNextRecordCommand({ progress, options, recordIndexFile, records });
  const completionHandoff = buildCompletionHandoff({
    progress,
    records,
    options,
    recordIndexFile,
    statusRefreshCommand,
    rehearsalReloadCommand
  });
  return {
    ...existingIndex,
    mode: "staging-launch-duty-record-index",
    version: 1,
    status: progress.status,
    closeoutInputFile: options.closeoutInputFile,
    actionsFile: options.actionsFile || null,
    recordIndexFile,
    updatedRecordKey: options.key,
    updatedAt: recordEntry.recordedAt,
    recordedKeys: progress.recordedKeys,
    pendingKeys: progress.pendingKeys,
    recordedCount: progress.recordedCount,
    pendingCount: progress.pendingCount,
    nextRecordKey: progress.nextRecordKey,
    nextRecordCommand,
    statusCommand: statusRefreshCommand,
    rehearsalReloadCommand,
    completionHandoff,
    records,
    nextAction: nextRecordCommand
      ? `Run nextRecordCommand for ${progress.nextRecordKey}, then refresh readiness status.`
      : completionHandoff
        ? completionHandoff.nextAction
        : "Refresh readiness status, then reload rehearsal for the latest launch-duty archive."
  };
}

function writeRecordIndex(recordIndexFile, recordIndex) {
  const resolvedRecordIndexFile = path.resolve(recordIndexFile);
  mkdirSync(path.dirname(resolvedRecordIndexFile), { recursive: true });
  writeFileSync(resolvedRecordIndexFile, `${JSON.stringify(recordIndex, null, 2)}\n`, "utf8");
}

function buildOperatorNextCommands({ nextRecordCommand, nextRecord, statusRefreshCommand, rehearsalReloadCommand, actionsFile, closeoutInputFile, recordIndexFile, completionHandoff = null }) {
  const commands = [];
  if (nextRecordCommand) {
    commands.push({
      key: "next_launch_duty_record",
      status: "current",
      command: nextRecordCommand,
      artifactPath: nextRecord?.artifactPath || null,
      recordIndexFile,
      nextAction: `Record ${nextRecord?.key || "the next launch-duty artifact"} before refreshing readiness status.`
    });
  }
  commands.push(
    {
      key: "readiness_status",
      status: nextRecordCommand ? "blocked_after_next_record" : "current",
      command: statusRefreshCommand,
      artifactPath: actionsFile || null,
      recordIndexFile,
      nextAction: "Refresh the readiness action queue after this launch-duty record is written."
    },
    {
      key: "rehearsal_reload",
      status: "blocked_after_readiness_status",
      command: rehearsalReloadCommand,
      artifactPath: closeoutInputFile,
      recordIndexFile,
      nextAction: "Reload rehearsal so the launch-duty packet and archive index point at the latest record artifacts."
    }
  );
  if (completionHandoff) {
    commands.push({
      key: "stable_operations_handoff",
      status: "blocked_after_rehearsal_reload",
      command: null,
      artifactPath: completionHandoff.firstWaveCloseoutArtifactPath,
      recordIndexFile,
      handoffArtifacts: completionHandoff.handoffArtifacts,
      nextAction: completionHandoff.nextAction
    });
  }
  return commands;
}

function buildOperatorQueueCheckpoint({
  closeoutInputFile,
  actionsFile,
  recordIndexFile,
  recordIndex,
  nextRecord,
  nextRecordCommand,
  completionHandoff,
  operatorNextCommands,
  nextAction
}) {
  const currentCommand = operatorNextCommands.find((item) => item.status === "current") || null;
  return {
    mode: "staging-launch-duty-record-operator-queue-checkpoint",
    status: completionHandoff ? "ready_for_stabilization_handoff" : "awaiting_next_launch_duty_record",
    currentActionKey: currentCommand?.key || "readiness_status",
    currentCommand: currentCommand?.command || null,
    recordIndexFile,
    closeoutInputFile,
    actionsFile: actionsFile || null,
    currentArtifactPath: currentCommand?.artifactPath || null,
    recordedCount: recordIndex?.recordedCount ?? 0,
    pendingCount: recordIndex?.pendingCount ?? 0,
    nextRecordKey: nextRecord?.key || null,
    nextRecordCommand: nextRecordCommand || null,
    nextRecordArtifactPath: nextRecord?.artifactPath || null,
    completionHandoffStatus: completionHandoff?.status || null,
    completionHandoffArtifacts: completionHandoff?.handoffArtifacts || null,
    completionHandoffNextAction: completionHandoff?.nextAction || null,
    operatorCommandCount: operatorNextCommands.length,
    nextAction: nextAction || (completionHandoff?.nextAction || "Refresh readiness status, then reload rehearsal for the latest launch-duty archive.")
  };
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

function recordReceiptIds(record, fallbackOperations = []) {
  if (Array.isArray(record?.receiptIds) && record.receiptIds.length) {
    return record.receiptIds;
  }
  return fallbackOperations.map((operation) => `<${operation}-receipt-id>`);
}

function buildLaunchDutyRecordLaunchEvidenceGate({
  options,
  recordIndex,
  recordIndexFile,
  nextRecord,
  nextRecordCommand,
  statusRefreshCommand,
  rehearsalReloadCommand
}) {
  const archiveRoot = archiveRootFromCloseoutInputFile(options.closeoutInputFile);
  const records = recordIndex?.records || {};
  const closeoutEvidenceItems = CLOSEOUT_EVIDENCE_KEYS.map((key, index) => {
    const artifactPath = joinArtifactPath(archiveRoot, `${key}.txt`);
    return buildLaunchEvidenceItem({
      order: index + 1,
      key,
      type: "closeout_evidence",
      status: "filled",
      artifactPath,
      command: buildCloseoutEvidenceBackfillCommand({
        closeoutInputFile: options.closeoutInputFile,
        actionsFile: options.actionsFile,
        key,
        artifactPath
      })
    });
  });
  const productionSignoffEvidenceItems = PRODUCTION_SIGNOFF_DEFINITIONS.map((definition, index) => {
    const artifactPath = joinArtifactPath(archiveRoot, definition.fileName);
    return buildLaunchEvidenceItem({
      order: index + 8,
      key: definition.key,
      type: "production_signoff_condition",
      status: "filled",
      artifactPath,
      command: buildSignoffEvidenceBackfillCommand({
        closeoutInputFile: options.closeoutInputFile,
        actionsFile: options.actionsFile,
        keyFlag: "--condition-key",
        key: definition.key,
        artifactPath,
        receiptOperations: definition.receiptOperations,
        decision: definition.decision
      }),
      receiptIds: definition.receiptOperations.map((operation) => `<${operation}-receipt-id>`)
    });
  });
  const receiptVisibilityEvidenceItems = RECEIPT_VISIBILITY_DEFINITIONS.map(([key, fileName], index) => {
    const artifactPath = joinArtifactPath(archiveRoot, fileName);
    return buildLaunchEvidenceItem({
      order: index + 15,
      key,
      type: "receipt_visibility_lane",
      status: "visible",
      artifactPath,
      command: buildSignoffEvidenceBackfillCommand({
        closeoutInputFile: options.closeoutInputFile,
        actionsFile: options.actionsFile,
        keyFlag: "--receipt-lane",
        key,
        artifactPath,
        receiptOperations: ["record_post_launch_ops_sweep"]
      }),
      receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"]
    });
  });
  const launchDayWatchRecord = records.launch_day_watch_summary || null;
  const firstWaveCloseoutRecord = records.first_wave_closeout || null;
  const launchDayWatchArtifact = launchDayWatchRecord?.artifactPath || joinArtifactPath(archiveRoot, LAUNCH_DUTY_RECORDS.launch_day_watch_summary.fileName);
  const firstWaveCloseoutArtifact = firstWaveCloseoutRecord?.artifactPath || joinArtifactPath(archiveRoot, LAUNCH_DUTY_RECORDS.first_wave_closeout.fileName);
  const firstWaveSourceRecordPaths = sourceRecordPathsFromRecords(
    LAUNCH_DUTY_RECORDS.first_wave_closeout.sourceRecordKeys,
    records
  );
  const launchDutyEvidenceItems = [
    buildLaunchEvidenceItem({
      order: 20,
      key: "launch_day_watch_summary",
      type: "launch_duty_record",
      status: launchDayWatchRecord?.status === "recorded" ? "recorded" : "blocked_after_production_signoff_readiness_status",
      artifactPath: launchDayWatchArtifact,
      command: buildRecordCommand({
        closeoutInputFile: options.closeoutInputFile,
        actionsFile: options.actionsFile,
        key: "launch_day_watch_summary",
        artifactPath: launchDayWatchArtifact,
        recordIndexFile,
        sourceRecordPaths: {}
      }),
      receiptIds: recordReceiptIds(launchDayWatchRecord, LAUNCH_DUTY_RECORDS.launch_day_watch_summary.receiptOperations)
    }),
    buildLaunchEvidenceItem({
      order: 21,
      key: "first_wave_closeout",
      type: "launch_duty_record",
      status: firstWaveCloseoutRecord?.status === "recorded" ? "recorded" : "blocked_until_source_records",
      artifactPath: firstWaveCloseoutArtifact,
      command: buildRecordCommand({
        closeoutInputFile: options.closeoutInputFile,
        actionsFile: options.actionsFile,
        key: "first_wave_closeout",
        artifactPath: firstWaveCloseoutArtifact,
        recordIndexFile,
        sourceRecordPaths: firstWaveSourceRecordPaths
      }),
      receiptIds: recordReceiptIds(firstWaveCloseoutRecord, LAUNCH_DUTY_RECORDS.first_wave_closeout.receiptOperations),
      sourceRecordKeys: LAUNCH_DUTY_RECORDS.first_wave_closeout.sourceRecordKeys
    })
  ];
  const evidenceItems = [
    ...closeoutEvidenceItems,
    ...productionSignoffEvidenceItems,
    ...receiptVisibilityEvidenceItems,
    ...launchDutyEvidenceItems
  ];
  const closeoutCompleted = closeoutEvidenceItems.length;
  const productionSignoffCompleted = productionSignoffEvidenceItems.length;
  const receiptVisibilityCompleted = receiptVisibilityEvidenceItems.length;
  const launchDutyCompleted = launchDutyEvidenceItems.filter((item) => item.status === "recorded").length;
  const completedEvidenceCount = closeoutCompleted + productionSignoffCompleted + receiptVisibilityCompleted + launchDutyCompleted;
  const currentEvidence = launchDutyEvidenceItems.find((item) => item.status !== "recorded")
    || launchDutyEvidenceItems[launchDutyEvidenceItems.length - 1]
    || null;
  const completionHandoff = recordIndex?.completionHandoff || null;
  const currentCommand = nextRecordCommand || completionHandoff?.statusCommand || currentEvidence?.command || null;
  const currentArtifactPath = nextRecord?.artifactPath || currentEvidence?.artifactPath || null;

  return {
    version: "staging-launch-duty-record-launch-evidence-gate/v1",
    status: completedEvidenceCount < evidenceItems.length
      ? "blocked_until_real_launch_evidence_attached"
      : completionHandoff?.status || "ready_for_stabilization_handoff",
    currentGate: "launch_duty_record",
    currentEvidenceKey: currentEvidence?.key || null,
    currentEvidenceType: currentEvidence?.type || null,
    currentEvidenceStatus: currentEvidence?.status || null,
    currentLaunchDutyRecordKey: recordIndex?.nextRecordKey || null,
    currentCommand,
    currentArtifactPath,
    closeoutInputFile: options.closeoutInputFile,
    readinessActionQueueFile: options.actionsFile || null,
    archiveRoot,
    evidenceCount: evidenceItems.length,
    closeoutEvidenceCount: closeoutEvidenceItems.length,
    productionSignoffEvidenceCount: productionSignoffEvidenceItems.length,
    receiptVisibilityEvidenceCount: receiptVisibilityEvidenceItems.length,
    launchDutyEvidenceCount: launchDutyEvidenceItems.length,
    completedEvidenceCount,
    pendingEvidenceCount: evidenceItems.length - completedEvidenceCount,
    readinessStatusCommand: statusRefreshCommand,
    rehearsalReloadCommand,
    fullTestCommand: "npm.cmd test",
    fullTestOutputArtifact: joinArtifactPath(archiveRoot, "full-test-output.txt"),
    productionSignoffPacket: joinArtifactPath(archiveRoot, "staging-production-signoff-packet.json"),
    launchDayWatchArtifact,
    firstWaveCloseoutArtifact,
    launchDutyRecordIndexPath: recordIndexFile,
    launchDutyRecordProgress: {
      recorded: recordIndex?.recordedCount ?? 0,
      pending: recordIndex?.pendingCount ?? RECORD_SEQUENCE.length,
      total: RECORD_SEQUENCE.length,
      nextRecordKey: recordIndex?.nextRecordKey || null
    },
    stableOperationsHandoff: completionHandoff
      ? {
        status: completionHandoff.status,
        handoffArtifacts: completionHandoff.handoffArtifacts,
        nextAction: completionHandoff.nextAction
      }
      : null,
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
    nextAction: completionHandoff?.nextAction || "Run currentCommand to continue launch-duty record capture, then refresh readiness status and reload rehearsal."
  };
}

function buildResult(options) {
  const target = LAUNCH_DUTY_RECORDS[options.key];
  if (!target) {
    throw new Error(`Unknown launch duty record key: ${options.key}`);
  }
  const value = JSON.parse(options.valueJson);
  const recordIndexFile = options.recordIndexFile || defaultRecordIndexFile(options.artifactPath);
  const existingIndex = loadRecordIndex(recordIndexFile);
  const sourceRecords = sourceRecordsWithIndexFallback(
    target,
    options.sourceRecords.map(parseSourceRecord),
    existingIndex.records
  );
  const missingSourceRecordKeys = requiredSourceRecordKeysMissing(target, sourceRecords);
  if (missingSourceRecordKeys.length) {
    throw new Error(`Missing required source records for ${options.key}: ${missingSourceRecordKeys.join(", ")}`);
  }
  const recordedAt = new Date().toISOString();
  const recordIndexEntry = buildRecordIndexEntry({
    options,
    target,
    value,
    sourceRecords,
    recordedAt
  });
  const recordsForNextCommand = {
    ...existingIndex.records,
    [options.key]: recordIndexEntry
  };
  const artifactPath = path.resolve(options.artifactPath);
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, renderArtifactMarkdown({
    key: options.key,
    target,
    artifactPath: options.artifactPath,
    value,
    receiptIds: options.receiptIds,
    sourceRecords
  }), "utf8");

  const sequenceIndex = RECORD_SEQUENCE.indexOf(options.key);
  const nextKey = sequenceIndex >= 0 ? RECORD_SEQUENCE[sequenceIndex + 1] : null;
  const nextRecord = nextKey
    ? {
      key: nextKey,
      actionKey: LAUNCH_DUTY_RECORDS[nextKey].actionKey,
      artifactPath: nextArtifactPath(options.artifactPath, nextKey),
      receiptOperations: LAUNCH_DUTY_RECORDS[nextKey].receiptOperations,
      sourceRecordKeys: LAUNCH_DUTY_RECORDS[nextKey].sourceRecordKeys || [],
      expectedEvidence: LAUNCH_DUTY_RECORDS[nextKey].expectedEvidence
    }
    : null;
  const nextRecordCommand = nextRecord
    ? buildRecordCommand({
      closeoutInputFile: options.closeoutInputFile,
      actionsFile: options.actionsFile,
      key: nextRecord.key,
      artifactPath: nextRecord.artifactPath,
      recordIndexFile,
      sourceRecordPaths: sourceRecordPathsFromRecords(nextRecord.sourceRecordKeys, recordsForNextCommand)
    })
    : null;
  const statusRefreshCommand = statusCommand(options.closeoutInputFile, options.actionsFile);
  const rehearsalReloadCommand = reloadCommand(options.closeoutInputFile);
  const recordIndex = buildRecordIndex({
    existingIndex,
    recordEntry: recordIndexEntry,
    options,
    recordIndexFile,
    statusRefreshCommand,
    rehearsalReloadCommand
  });
  const operatorNextCommands = buildOperatorNextCommands({
    nextRecordCommand,
    nextRecord,
    statusRefreshCommand,
    rehearsalReloadCommand,
    actionsFile: options.actionsFile,
    closeoutInputFile: options.closeoutInputFile,
    recordIndexFile,
    completionHandoff: recordIndex.completionHandoff
  });
  const operatorQueueCheckpoint = buildOperatorQueueCheckpoint({
    closeoutInputFile: options.closeoutInputFile,
    actionsFile: options.actionsFile,
    recordIndexFile,
    recordIndex,
    nextRecord,
    nextRecordCommand,
    completionHandoff: recordIndex.completionHandoff,
    operatorNextCommands,
    nextAction: recordIndex.nextAction
  });
  const launchEvidenceReadinessGate = buildLaunchDutyRecordLaunchEvidenceGate({
    options,
    recordIndex,
    recordIndexFile,
    nextRecord,
    nextRecordCommand,
    statusRefreshCommand,
    rehearsalReloadCommand
  });
  writeRecordIndex(recordIndexFile, recordIndex);
  return {
    status: "written",
    mode: "staging-launch-duty-record",
    closeoutInputFile: options.closeoutInputFile,
    actionsFile: options.actionsFile || null,
    key: options.key,
    actionKey: target.actionKey,
    category: target.category,
    artifactPath: options.artifactPath,
    receiptOperations: target.receiptOperations,
    receiptIds: options.receiptIds,
    sourceRecords,
    expectedEvidence: target.expectedEvidence,
    value,
    recordedAt,
    recordIndex: {
      path: recordIndexFile,
      status: recordIndex.status,
      recordedCount: recordIndex.recordedCount,
      pendingCount: recordIndex.pendingCount,
      nextRecordKey: recordIndex.nextRecordKey
    },
    nextRecord,
    nextRecordCommand,
    completionHandoff: recordIndex.completionHandoff || null,
    statusCommand: statusRefreshCommand,
    rehearsalReloadCommand,
    operatorNextCommands,
    operatorQueueCheckpoint,
    launchEvidenceReadinessGate,
    nextAction: recordIndex.nextAction
  };
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.status === "written") {
    console.log(`Launch duty record written: ${result.key}`);
    console.log(`Launch duty record action: ${result.actionKey}`);
    console.log(`Launch duty record artifact: ${result.artifactPath}`);
    console.log(`Launch duty record receipts: ${result.receiptIds.join(", ") || "-"}`);
    console.log(`Launch duty record source records: ${renderSourceRecords(result.sourceRecords)}`);
    console.log(`Launch duty record index: ${result.recordIndex?.path || "-"}`);
    console.log(`Launch duty record index status: ${result.recordIndex?.status || "-"}`);
    console.log(`Launch duty record index progress: ${result.recordIndex?.recordedCount || 0}/6 recorded, ${result.recordIndex?.pendingCount || 0} pending`);
    console.log(`Launch duty record index next key: ${result.recordIndex?.nextRecordKey || "-"}`);
    console.log(`Launch duty record next command: ${result.nextRecordCommand || "-"}`);
    if (result.operatorQueueCheckpoint) {
      const checkpoint = result.operatorQueueCheckpoint;
      console.log(`Launch duty operator checkpoint: ${checkpoint.currentActionKey} (status=${checkpoint.status}, commands=${checkpoint.operatorCommandCount})`);
      if (checkpoint.currentCommand) {
        console.log(`Launch duty checkpoint current: ${checkpoint.currentCommand}`);
      }
      if (checkpoint.recordIndexFile) {
        console.log(`Launch duty checkpoint record index: ${checkpoint.recordIndexFile}`);
      }
      console.log(`Launch duty checkpoint progress: ${checkpoint.recordedCount}/6 recorded, ${checkpoint.pendingCount} pending`);
      if (checkpoint.nextRecordKey && checkpoint.nextRecordCommand) {
        console.log(`Launch duty checkpoint next record: ${checkpoint.nextRecordKey} -> ${checkpoint.nextRecordCommand}`);
      } else {
        console.log("Launch duty checkpoint next record: none");
      }
      if (checkpoint.completionHandoffStatus) {
        console.log(`Launch duty checkpoint completion handoff: ${checkpoint.completionHandoffStatus}`);
        if (checkpoint.completionHandoffArtifacts?.length) {
          console.log(`Launch duty checkpoint handoff artifacts: ${checkpoint.completionHandoffArtifacts.join("; ")}`);
        }
        if (checkpoint.completionHandoffNextAction) {
          console.log(`Launch duty checkpoint handoff next action: ${checkpoint.completionHandoffNextAction}`);
        }
      }
      console.log(`Launch duty checkpoint next action: ${checkpoint.nextAction}`);
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
      console.log(
        `Launch evidence launch-duty records: ${gate.launchDutyRecordProgress?.recorded ?? "-"}/${gate.launchDutyRecordProgress?.total ?? "-"} recorded`
          + `, ${gate.launchDutyRecordProgress?.pending ?? "-"} pending`
          + `, next=${gate.launchDutyRecordProgress?.nextRecordKey || "-"}`
      );
      console.log(`Launch evidence readiness status: ${gate.readinessStatusCommand || "-"}`);
      console.log(`Launch evidence rehearsal reload: ${gate.rehearsalReloadCommand || "-"}`);
      console.log(`Launch evidence record index: ${gate.launchDutyRecordIndexPath || "-"}`);
      if (gate.stableOperationsHandoff) {
        console.log(`Launch evidence stable handoff: ${gate.stableOperationsHandoff.status || "-"} -> ${gate.stableOperationsHandoff.handoffArtifacts?.join("; ") || "-"}`);
      }
      console.log(`Launch evidence next action: ${gate.nextAction || "-"}`);
    }
    console.log(`Launch duty record status refresh: ${result.statusCommand}`);
    console.log(`Launch duty record rehearsal reload: ${result.rehearsalReloadCommand}`);
    if (result.completionHandoff) {
      console.log(`Launch duty completion handoff: ${result.completionHandoff.status}`);
      console.log(`Launch duty completion handoff artifacts: ${result.completionHandoff.handoffArtifacts.join("; ")}`);
      console.log(`Launch duty completion handoff next action: ${result.completionHandoff.nextAction}`);
    }
    for (const item of result.operatorNextCommands || []) {
      console.log(`Launch duty operator next ${item.status || "-"}: ${item.key || "-"} -> ${item.command || "-"}`);
      console.log(`Launch duty operator next ${item.status || "-"} record index: ${item.recordIndexFile || "-"}`);
    }
    console.log(`Launch duty record next action: ${result.nextAction}`);
    return;
  }
  console.log(`Staging launch duty record failed: ${result.error.message}`);
}

function main() {
  const json = process.argv.includes("--json");
  try {
    const options = parseArgs(process.argv.slice(2));
    writeResult(buildResult(options), options.json);
  } catch (error) {
    writeResult({
      status: "fail",
      mode: "staging-launch-duty-record",
      error: {
        message: error.message
      }
    }, json);
    process.exitCode = 1;
  }
}

main();
