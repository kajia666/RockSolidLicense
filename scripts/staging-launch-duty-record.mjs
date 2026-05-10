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

function sourceRecordArgs(sourceRecordKeys = []) {
  return sourceRecordKeys
    .filter(Boolean)
    .map((key) => ` --source-record ${key}=<${key}-artifact-path>`)
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

function buildRecordCommand({ closeoutInputFile, actionsFile, key, artifactPath, recordIndexFile }) {
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
    sourceRecordArgs(target.sourceRecordKeys).trimStart(),
    recordIndexArg.trimStart(),
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

function buildIndexNextRecordCommand({ progress, options, recordIndexFile }) {
  if (!progress.nextRecordKey) {
    return null;
  }
  return buildRecordCommand({
    closeoutInputFile: options.closeoutInputFile,
    actionsFile: options.actionsFile,
    key: progress.nextRecordKey,
    artifactPath: nextArtifactPath(options.artifactPath, progress.nextRecordKey),
    recordIndexFile
  });
}

function buildRecordIndex({ options, target, value, sourceRecords, recordIndexFile, recordedAt, statusRefreshCommand, rehearsalReloadCommand }) {
  const existingIndex = loadRecordIndex(recordIndexFile);
  const records = {
    ...existingIndex.records,
    [options.key]: {
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
    }
  };
  const progress = recordIndexProgress(records);
  const nextRecordCommand = buildIndexNextRecordCommand({ progress, options, recordIndexFile });
  return {
    ...existingIndex,
    mode: "staging-launch-duty-record-index",
    version: 1,
    status: progress.status,
    closeoutInputFile: options.closeoutInputFile,
    actionsFile: options.actionsFile || null,
    recordIndexFile,
    updatedRecordKey: options.key,
    updatedAt: recordedAt,
    recordedKeys: progress.recordedKeys,
    pendingKeys: progress.pendingKeys,
    recordedCount: progress.recordedCount,
    pendingCount: progress.pendingCount,
    nextRecordKey: progress.nextRecordKey,
    nextRecordCommand,
    statusCommand: statusRefreshCommand,
    rehearsalReloadCommand,
    records,
    nextAction: nextRecordCommand
      ? `Run nextRecordCommand for ${progress.nextRecordKey}, then refresh readiness status.`
      : "Refresh readiness status, then reload rehearsal for the latest launch-duty archive."
  };
}

function writeRecordIndex(recordIndexFile, recordIndex) {
  const resolvedRecordIndexFile = path.resolve(recordIndexFile);
  mkdirSync(path.dirname(resolvedRecordIndexFile), { recursive: true });
  writeFileSync(resolvedRecordIndexFile, `${JSON.stringify(recordIndex, null, 2)}\n`, "utf8");
}

function buildOperatorNextCommands({ nextRecordCommand, nextRecord, statusRefreshCommand, rehearsalReloadCommand, actionsFile, closeoutInputFile }) {
  const commands = [];
  if (nextRecordCommand) {
    commands.push({
      key: "next_launch_duty_record",
      status: "current",
      command: nextRecordCommand,
      artifactPath: nextRecord?.artifactPath || null,
      nextAction: `Record ${nextRecord?.key || "the next launch-duty artifact"} before refreshing readiness status.`
    });
  }
  commands.push(
    {
      key: "readiness_status",
      status: nextRecordCommand ? "blocked_after_next_record" : "current",
      command: statusRefreshCommand,
      artifactPath: actionsFile || null,
      nextAction: "Refresh the readiness action queue after this launch-duty record is written."
    },
    {
      key: "rehearsal_reload",
      status: "blocked_after_readiness_status",
      command: rehearsalReloadCommand,
      artifactPath: closeoutInputFile,
      nextAction: "Reload rehearsal so the launch-duty packet and archive index point at the latest record artifacts."
    }
  );
  return commands;
}

function buildResult(options) {
  const target = LAUNCH_DUTY_RECORDS[options.key];
  if (!target) {
    throw new Error(`Unknown launch duty record key: ${options.key}`);
  }
  const value = JSON.parse(options.valueJson);
  const sourceRecords = options.sourceRecords.map(parseSourceRecord);
  const missingSourceRecordKeys = requiredSourceRecordKeysMissing(target, sourceRecords);
  if (missingSourceRecordKeys.length) {
    throw new Error(`Missing required source records for ${options.key}: ${missingSourceRecordKeys.join(", ")}`);
  }
  const recordIndexFile = options.recordIndexFile || defaultRecordIndexFile(options.artifactPath);
  const recordedAt = new Date().toISOString();
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
      recordIndexFile
    })
    : null;
  const statusRefreshCommand = statusCommand(options.closeoutInputFile, options.actionsFile);
  const rehearsalReloadCommand = reloadCommand(options.closeoutInputFile);
  const recordIndex = buildRecordIndex({
    options,
    target,
    value,
    sourceRecords,
    recordIndexFile,
    recordedAt,
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
    statusCommand: statusRefreshCommand,
    rehearsalReloadCommand,
    operatorNextCommands: buildOperatorNextCommands({
      nextRecordCommand,
      nextRecord,
      statusRefreshCommand,
      rehearsalReloadCommand,
      actionsFile: options.actionsFile,
      closeoutInputFile: options.closeoutInputFile
    }),
    nextAction: nextRecord
      ? `Run nextRecordCommand for ${nextRecord.key}, then refresh readiness status.`
      : "Refresh readiness status, then reload rehearsal for the latest launch-duty archive."
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
    console.log(`Launch duty record status refresh: ${result.statusCommand}`);
    console.log(`Launch duty record rehearsal reload: ${result.rehearsalReloadCommand}`);
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
