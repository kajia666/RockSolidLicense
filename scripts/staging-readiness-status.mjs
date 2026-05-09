#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REQUIRED_CLOSEOUT_KEYS = [
  "route_map_gate_result",
  "backup_restore_drill_result",
  "live_write_smoke_result",
  "launch_smoke_handoff",
  "launch_mainline_evidence_receipts",
  "receipt_visibility_review",
  "operator_go_no_go"
];

const REQUIRED_SIGNOFF_KEYS = [
  "full_test_window_passed",
  "staging_artifacts_archived",
  "launch_mainline_receipts_visible",
  "launch_ops_overview_status_visible",
  "backup_restore_drill_passed",
  "rollback_path_confirmed",
  "operator_signoff_recorded"
];

const RECEIPT_VISIBILITY_KEYS = [
  "launchMainline",
  "launchReview",
  "launchSmoke",
  "developerOps",
  "launchOpsOverviewStatus"
];

const DEFAULT_ARTIFACT_PATH_ROOT = "artifacts/staging/<productCode>/<channel>";

const CLOSEOUT_EVIDENCE = {
  route_map_gate_result: {
    expectedEvidence: "Record the targeted gate exit status, pass count, and redacted output artifact path.",
    valueJsonExample: {
      result: "pass",
      exitCode: 0,
      summary: "<redacted route-map gate summary>"
    },
    artifactPathHint: "artifacts/staging/<productCode>/<channel>/route-map-gate-output.txt",
    receiptOperations: []
  },
  backup_restore_drill_result: {
    expectedEvidence: "Record backup artifact path, restore dry-run result, and post-restore healthcheck result.",
    valueJsonExample: {
      result: "pass",
      restoreDryRun: "pass",
      healthcheck: "pass",
      summary: "<redacted operator summary>"
    },
    artifactPathHint: "artifacts/staging/<productCode>/<channel>/backup-restore-drill.txt",
    receiptOperations: ["record_recovery_drill", "record_backup_verification"]
  },
  live_write_smoke_result: {
    expectedEvidence: "Record smoke exit status, created test project/account/card identifiers, and the redacted smoke output artifact path.",
    valueJsonExample: {
      result: "pass",
      createdProject: "<redacted project id>",
      createdCardBatch: "<redacted card batch id>",
      summary: "<redacted smoke summary>"
    },
    artifactPathHint: "artifacts/staging/<productCode>/<channel>/live-write-smoke-output.json",
    receiptOperations: ["record_launch_rehearsal_run"]
  },
  launch_smoke_handoff: {
    expectedEvidence: "Save the launch smoke handoff JSON or Markdown path with passwords and bearer tokens redacted.",
    valueJsonExample: {
      result: "archived",
      handoffPath: "<redacted handoff path>",
      summary: "<redacted operator summary>"
    },
    artifactPathHint: "artifacts/staging/<productCode>/<channel>/launch-smoke-handoff.json",
    receiptOperations: ["record_post_launch_ops_sweep"]
  },
  launch_mainline_evidence_receipts: {
    expectedEvidence: "Record the Launch Mainline receipt IDs or handoff file names produced by each evidence action.",
    valueJsonExample: {
      result: "recorded",
      receiptIds: ["<receipt-id>"],
      summary: "<redacted receipt summary>"
    },
    artifactPathHint: "artifacts/staging/<productCode>/<channel>/launch-mainline-evidence-receipts.json",
    receiptOperations: [
      "record_launch_rehearsal_run",
      "record_recovery_drill",
      "record_backup_verification",
      "record_operations_walkthrough",
      "record_deploy_verification",
      "record_health_verification",
      "record_rollback_walkthrough",
      "record_cutover_walkthrough",
      "record_launch_day_readiness_review",
      "record_post_launch_ops_sweep",
      "record_launch_closeout_review",
      "record_launch_stabilization_review"
    ]
  },
  receipt_visibility_review: {
    expectedEvidence: "Verify Launch Review, Launch Smoke, and Launch Ops Overview Status receipt-visibility summaries show the recorded first-wave receipt.",
    valueJsonExample: {
      result: "visible",
      summaryPath: "<redacted receipt visibility summary path>",
      summary: "<redacted operator summary>"
    },
    artifactPathHint: "artifacts/staging/<productCode>/<channel>/receipt-visibility-review.txt",
    receiptOperations: ["record_post_launch_ops_sweep"]
  },
  operator_go_no_go: {
    expectedEvidence: "Record ready-for-full-test-window, hold, or rollback-follow-up with the operator name and timestamp.",
    valueJsonExample: {
      decision: "ready-for-full-test-window",
      operator: "<operator name>",
      timestamp: "<ISO-8601 timestamp>",
      summary: "<redacted go/no-go summary>"
    },
    artifactPathHint: "artifacts/staging/<productCode>/<channel>/operator-go-no-go.md",
    receiptOperations: []
  }
};

const SIGNOFF_EVIDENCE = {
  full_test_window_passed: {
    expectedEvidence: "Attach the full `npm.cmd test` output summary and failure count.",
    valueJsonExample: {
      result: "pass",
      command: "npm.cmd test",
      failureCount: 0,
      summary: "<redacted test summary>"
    },
    artifactPathHint: "artifacts/staging/<productCode>/<channel>/full-test-output.txt",
    receiptOperations: []
  },
  staging_artifacts_archived: {
    expectedEvidence: "Confirm the artifact/receipt ledger archive paths exist and contain redacted artifacts.",
    valueJsonExample: {
      result: "confirmed",
      summary: "<redacted operator summary>"
    },
    artifactPathHint: "artifacts/staging/<productCode>/<channel>/staging-artifacts-archive.txt",
    receiptOperations: [],
    receiptIdHint: "Attach receipt IDs if your operating process records this sign-off in Launch Mainline."
  },
  launch_mainline_receipts_visible: {
    expectedEvidence: "Confirm Launch Mainline, Launch Review, Launch Smoke, and Developer Ops show the latest receipts.",
    valueJsonExample: {
      result: "confirmed",
      summary: "<redacted operator summary>"
    },
    artifactPathHint: "artifacts/staging/<productCode>/<channel>/launch-mainline-receipts-visible.json",
    receiptOperations: ["record_post_launch_ops_sweep"]
  },
  launch_ops_overview_status_visible: {
    expectedEvidence: "Confirm Launch Ops Overview Status shows the latest receipt visibility status before cutover.",
    valueJsonExample: {
      result: "confirmed",
      summary: "<redacted operator summary>"
    },
    artifactPathHint: "artifacts/staging/<productCode>/<channel>/launch-ops-overview-status-visible.json",
    receiptOperations: ["record_post_launch_ops_sweep"]
  },
  backup_restore_drill_passed: {
    expectedEvidence: "Confirm the backup and restore drill passed on the intended staging storage profile.",
    valueJsonExample: {
      result: "pass",
      summary: "<redacted backup/restore summary>"
    },
    artifactPathHint: "artifacts/staging/<productCode>/<channel>/backup-restore-drill.txt",
    receiptOperations: ["record_recovery_drill", "record_backup_verification"]
  },
  rollback_path_confirmed: {
    expectedEvidence: "Confirm rollback walkthrough and recovery handoff are current before production cutover.",
    valueJsonExample: {
      result: "confirmed",
      summary: "<redacted rollback summary>"
    },
    artifactPathHint: "artifacts/staging/<productCode>/<channel>/rollback-path-confirmed.md",
    receiptOperations: ["record_rollback_walkthrough"]
  },
  operator_signoff_recorded: {
    expectedEvidence: "Record operator, timestamp, decision, and reason in the go/no-go artifact.",
    valueJsonExample: {
      decision: "ready-for-production-signoff",
      operator: "<operator name>",
      timestamp: "<ISO-8601 timestamp>",
      summary: "<redacted sign-off summary>"
    },
    artifactPathHint: "artifacts/staging/<productCode>/<channel>/operator-production-signoff.md",
    receiptOperations: []
  }
};

const RECEIPT_VISIBILITY_EVIDENCE = {
  launchMainline: "Confirm Launch Mainline receipt visibility shows the latest staging evidence receipts before cutover.",
  launchReview: "Confirm Launch Review summary download shows the latest staging evidence receipts before cutover.",
  launchSmoke: "Confirm Launch Smoke summary download shows the latest staging evidence receipts before cutover.",
  developerOps: "Confirm Developer Ops receipt visibility shows the latest staging evidence receipts before cutover.",
  launchOpsOverviewStatus: "Confirm Launch Ops Overview Status shows the latest receipt visibility status before cutover."
};

const LAUNCH_DUTY_FOLLOW_UP_EVIDENCE = {
  launch_day_watch_summary: {
    expectedEvidence: "Record cutover watch start/end time, owner, route checks, and launch-day operator decisions.",
    valueJsonExample: {
      result: "recorded",
      watchWindow: "T-30m through T+2h",
      summary: "<redacted launch-day watch summary>"
    },
    artifactPathHint: "artifacts/staging/<productCode>/<channel>/launch-day-watch-summary.md",
    receiptOperations: ["record_cutover_walkthrough", "record_launch_day_readiness_review"]
  },
  first_wave_closeout: {
    expectedEvidence: "Record first-wave closeout decision, unresolved incident list, customer impact notes, next-duty owner, and follow-up timestamp.",
    valueJsonExample: {
      result: "closed",
      unresolvedIncidents: [],
      summary: "<redacted first-wave closeout summary>"
    },
    artifactPathHint: "artifacts/staging/<productCode>/<channel>/first-wave-closeout.md",
    receiptOperations: ["record_launch_closeout_review"]
  }
};

const OPTION_FLAGS = {
  "--input-file": "inputFile",
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
    options[key] = requireArgValue(name, inlineValue ?? argv[index + 1], inlineValue);
    if (inlineValue === undefined) {
      index += 1;
    }
  }
  if (!options.inputFile) {
    throw new Error("--input-file requires a value.");
  }
  return options;
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

function isFilledField(field) {
  return Boolean(field) && isFilledValue(field.value);
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

function fieldsByKey(fields = []) {
  return new Map(
    (Array.isArray(fields) ? fields : [])
      .filter((field) => field?.key)
      .map((field) => [field.key, field])
  );
}

function artifactPathRootFromInputFile(inputFile) {
  const parts = path.resolve(inputFile).replaceAll("\\", "/").split("/").filter(Boolean);
  for (let index = 0; index < parts.length - 3; index += 1) {
    if (parts[index] === "artifacts" && parts[index + 1] === "staging" && parts[index + 2] && parts[index + 3]) {
      return {
        status: "inferred",
        path: `artifacts/staging/${parts[index + 2]}/${parts[index + 3]}`,
        source: "input-file"
      };
    }
  }
  return {
    status: "placeholder",
    path: DEFAULT_ARTIFACT_PATH_ROOT,
    source: "default"
  };
}

function applyArtifactPathRoot(evidence, artifactPathRoot) {
  if (!evidence) {
    return null;
  }
  return {
    ...evidence,
    artifactPathHint: evidence.artifactPathHint.replace(DEFAULT_ARTIFACT_PATH_ROOT, artifactPathRoot.path)
  };
}

function receiptIdHint(receiptOperations) {
  if (!receiptOperations.length) {
    return "No Launch Mainline receipt is required for this condition unless your operating process records one.";
  }
  if (receiptOperations.length === 1) {
    return `Attach the latest receipt ID for ${receiptOperations[0]} when available.`;
  }
  return `Attach receipt IDs produced by: ${receiptOperations.join(", ")}.`;
}

function evidenceWithReceiptHint(evidence) {
  if (!evidence) {
    return null;
  }
  return {
    ...evidence,
    receiptIdHint: evidence.receiptIdHint || receiptIdHint(evidence.receiptOperations || [])
  };
}

function receiptLaneArtifactPathHint(key) {
  return `artifacts/staging/<productCode>/<channel>/${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-receipt-visibility.json`;
}

function evidenceForCloseoutKey(key, artifactPathRoot) {
  return evidenceWithReceiptHint(applyArtifactPathRoot(CLOSEOUT_EVIDENCE[key], artifactPathRoot));
}

function evidenceForSignoffKey(key, artifactPathRoot) {
  return evidenceWithReceiptHint(applyArtifactPathRoot(SIGNOFF_EVIDENCE[key], artifactPathRoot));
}

function evidenceForReceiptLane(key, artifactPathRoot) {
  return evidenceWithReceiptHint(applyArtifactPathRoot({
    expectedEvidence: RECEIPT_VISIBILITY_EVIDENCE[key] || "Confirm the receipt visibility lane shows the latest staging evidence receipts before cutover.",
    valueJsonExample: {
      status: "visible",
      summaryPath: "<redacted receipt visibility summary path>",
      summary: "<redacted operator summary>"
    },
    artifactPathHint: receiptLaneArtifactPathHint(key),
    receiptOperations: ["record_post_launch_ops_sweep"]
  }, artifactPathRoot));
}

function evidenceForLaunchDutyFollowUp(key, artifactPathRoot) {
  return evidenceWithReceiptHint(applyArtifactPathRoot(LAUNCH_DUTY_FOLLOW_UP_EVIDENCE[key], artifactPathRoot));
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

function commandValue(value) {
  const text = String(value || "");
  if (/[\s"`]/.test(text)) {
    return `"${text.replace(/"/g, "`\"")}"`;
  }
  return text;
}

function actionsFileArgs(actionsFile) {
  return actionsFile ? ` --actions-file ${commandValue(actionsFile)}` : "";
}

function commandForCloseoutBackfill(inputFile, key, actionsFile = null) {
  return `npm.cmd run staging:closeout:backfill -- --input-file ${inputFile} --key ${key} --value-json <redacted-json>${actionsFileArgs(actionsFile)}`;
}

function quoteValueJson(value) {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'`;
}

function receiptIdArgs(receiptOperations = []) {
  return receiptOperations.map((operation) => ` --receipt-id <${operation}-receipt-id>`).join("");
}

function evidenceArgs(evidence) {
  if (!evidence) {
    return "";
  }
  return [
    ` --value-json ${quoteValueJson(evidence.valueJsonExample)}`,
    ` --artifact-path ${evidence.artifactPathHint}`,
    receiptIdArgs(evidence.receiptOperations)
  ].join("");
}

function commandForCloseoutBackfillExample(inputFile, key, evidence, actionsFile = null) {
  return `npm.cmd run staging:closeout:backfill -- --input-file ${inputFile} --key ${key}${evidenceArgs(evidence)}${actionsFileArgs(actionsFile)}`;
}

function commandForSignoffCondition(inputFile, key, includeDecision = false, actionsFile = null) {
  const decision = includeDecision ? " --decision ready-for-production-signoff" : "";
  return `npm.cmd run staging:signoff:backfill -- --input-file ${inputFile} --condition-key ${key} --value-json <redacted-json>${decision}${actionsFileArgs(actionsFile)}`;
}

function commandForSignoffConditionExample(inputFile, key, evidence, includeDecision = false, actionsFile = null) {
  const decision = includeDecision ? " --decision ready-for-production-signoff" : "";
  return `npm.cmd run staging:signoff:backfill -- --input-file ${inputFile} --condition-key ${key}${evidenceArgs(evidence)}${decision}${actionsFileArgs(actionsFile)}`;
}

function commandForReceiptLane(inputFile, key, actionsFile = null) {
  return `npm.cmd run staging:signoff:backfill -- --input-file ${inputFile} --receipt-lane ${key} --value-json <redacted-json>${actionsFileArgs(actionsFile)}`;
}

function commandForReceiptLaneExample(inputFile, key, evidence, actionsFile = null) {
  return `npm.cmd run staging:signoff:backfill -- --input-file ${inputFile} --receipt-lane ${key}${evidenceArgs(evidence)}${actionsFileArgs(actionsFile)}`;
}

function reloadCommand(inputFile) {
  return `npm.cmd run staging:rehearsal -- --closeout-input-file ${inputFile}`;
}

function statusCommand(inputFile, actionsFile = null) {
  const actionsArg = actionsFile ? ` --actions-file ${commandValue(actionsFile)}` : "";
  return `npm.cmd run staging:readiness:status -- --input-file ${commandValue(inputFile)}${actionsArg}`;
}

function queueStatus(index) {
  return index === 0 ? "current" : "blocked_after_prior_actions";
}

function buildLaunchDutyReadyActionQueue({ inputFile, actionsFile, artifactPathRoot }) {
  const localStatusCommand = statusCommand(inputFile, actionsFile);
  return [
    {
      key: "reload_rehearsal_for_launch_day_watch",
      phase: "launch_day_watch",
      status: "current",
      targetKey: null,
      actionKey: "archive_production_signoff",
      command: reloadCommand(inputFile),
      operatorInstruction: "Reload rehearsal, archive the production sign-off packet, then use the generated launch-duty packet for watch evidence.",
      statusCommand: localStatusCommand
    },
    {
      key: "record_launch_day_watch_summary",
      phase: "launch_day_watch",
      status: "blocked_after_prior_actions",
      targetKey: "launch_day_watch_summary",
      actionKey: "record_launch_day_watch_summary",
      evidence: evidenceForLaunchDutyFollowUp("launch_day_watch_summary", artifactPathRoot),
      operatorInstruction: "Record launch-day watch summary and attach the cutover/readiness receipt IDs after the rehearsal packet is regenerated.",
      statusCommand: localStatusCommand
    },
    {
      key: "close_first_wave",
      phase: "first_wave_closeout",
      status: "blocked_after_prior_actions",
      targetKey: "first_wave_closeout",
      actionKey: "close_first_wave",
      evidence: evidenceForLaunchDutyFollowUp("first_wave_closeout", artifactPathRoot),
      sourceRecordKeys: ["first_wave_incident_log", "rollback_signal_review", "stabilization_owner_handoff"],
      operatorInstruction: "Close the first wave after incident, rollback, and stabilization owner records are attached.",
      statusCommand: localStatusCommand
    }
  ];
}

function buildActionQueue({
  inputFile,
  actionsFile,
  artifactPathRoot,
  missingCloseoutKeys,
  closeoutDecision,
  missingSignoffKeys,
  missingReceiptVisibilityKeys,
  productionDecision,
  canRunFullTestWindow,
  canSignoffProduction
}) {
  const localStatusCommand = statusCommand(inputFile, actionsFile);
  if (missingCloseoutKeys.length > 0) {
    return missingCloseoutKeys.map((key, index) => {
      const evidence = evidenceForCloseoutKey(key, artifactPathRoot);
      return {
        key: "backfill_closeout_evidence",
        phase: "pre_full_test_closeout",
        status: queueStatus(index),
        targetKey: key,
        command: commandForCloseoutBackfill(inputFile, key, actionsFile),
        exampleCommand: commandForCloseoutBackfillExample(inputFile, key, evidence, actionsFile),
        evidence,
        statusCommand: localStatusCommand
      };
    });
  }
  if (closeoutDecision !== "ready-for-full-test-window") {
    const evidence = evidenceForCloseoutKey("operator_go_no_go", artifactPathRoot);
    return [
      {
        key: "confirm_full_test_go_no_go",
        phase: "pre_full_test_closeout",
        status: "current",
        targetKey: "operator_go_no_go",
        command: commandForCloseoutBackfill(inputFile, "operator_go_no_go", actionsFile),
        exampleCommand: commandForCloseoutBackfillExample(inputFile, "operator_go_no_go", evidence, actionsFile),
        evidence,
        statusCommand: localStatusCommand
      }
    ];
  }
  if (!canRunFullTestWindow) {
    return [
      {
        key: "reload_closeout_input",
        phase: "pre_full_test_closeout",
        status: "current",
        targetKey: null,
        command: reloadCommand(inputFile)
      }
    ];
  }
  if (missingSignoffKeys.includes("full_test_window_passed")) {
    const evidence = evidenceForSignoffKey("full_test_window_passed", artifactPathRoot);
    return [
      {
        key: "run_full_test_window",
        phase: "full_test_window",
        status: "current",
        targetKey: "full_test_window_passed",
        command: "npm.cmd test",
        followUpCommand: commandForSignoffCondition(inputFile, "full_test_window_passed", true, actionsFile),
        followUpExampleCommand: commandForSignoffConditionExample(inputFile, "full_test_window_passed", evidence, true, actionsFile),
        evidence,
        statusCommand: localStatusCommand
      }
    ];
  }
  if (productionDecision !== "ready-for-production-signoff") {
    const key = missingSignoffKeys[0] || "operator_signoff_recorded";
    const evidence = evidenceForSignoffKey(key, artifactPathRoot);
    return [
      {
        key: "set_production_signoff_decision",
        phase: "production_signoff",
        status: "current",
        targetKey: "productionSignoff.decision",
        command: commandForSignoffCondition(inputFile, key, true, actionsFile),
        exampleCommand: commandForSignoffConditionExample(inputFile, key, evidence, true, actionsFile),
        evidence,
        statusCommand: localStatusCommand
      }
    ];
  }
  const signoffQueue = missingSignoffKeys.map((key, index) => {
    const evidence = evidenceForSignoffKey(key, artifactPathRoot);
    return {
      key: "backfill_production_signoff",
      phase: "production_signoff",
      status: queueStatus(index),
      targetKey: key,
      command: commandForSignoffCondition(inputFile, key, false, actionsFile),
      exampleCommand: commandForSignoffConditionExample(inputFile, key, evidence, false, actionsFile),
      evidence,
      statusCommand: localStatusCommand
    };
  });
  const receiptQueue = missingReceiptVisibilityKeys.map((key, index) => {
    const evidence = evidenceForReceiptLane(key, artifactPathRoot);
    return {
      key: "backfill_receipt_visibility",
      phase: "receipt_visibility",
      status: signoffQueue.length === 0 && index === 0 ? "current" : "blocked_after_prior_actions",
      targetKey: key,
      command: commandForReceiptLane(inputFile, key, actionsFile),
      exampleCommand: commandForReceiptLaneExample(inputFile, key, evidence, actionsFile),
      evidence,
      statusCommand: localStatusCommand
    };
  });
  if (signoffQueue.length > 0 || receiptQueue.length > 0) {
    return [...signoffQueue, ...receiptQueue];
  }
  if (canSignoffProduction) {
    return buildLaunchDutyReadyActionQueue({ inputFile, actionsFile, artifactPathRoot });
  }
  return [
    {
      key: "review_readiness_packet",
      phase: "readiness_review",
      status: "current",
      targetKey: null,
      command: reloadCommand(inputFile)
    }
  ];
}

function buildLaunchDutyNextRun({ inputFile, actionQueue, artifactPathRoot }) {
  const reloadAction = actionQueue.find((item) => item.key === "reload_rehearsal_for_launch_day_watch") || {};
  const watchAction = actionQueue.find((item) => item.key === "record_launch_day_watch_summary") || {};
  const firstWaveAction = actionQueue.find((item) => item.key === "close_first_wave") || {};
  const archiveRoot = artifactPathRoot?.path || DEFAULT_ARTIFACT_PATH_ROOT;
  const reload = reloadAction.command || reloadCommand(inputFile);
  return {
    status: "ready_for_launch_day_watch",
    currentActionKey: reloadAction.actionKey || "archive_production_signoff",
    reloadCommand: reload,
    actionKeys: actionQueue.map((item) => item.actionKey).filter(Boolean),
    artifactPathHints: {
      launchDayWatchSummary: watchAction.evidence?.artifactPathHint || null,
      firstWaveCloseout: firstWaveAction.evidence?.artifactPathHint || null
    },
    productionSignoffArchive: {
      actionKey: reloadAction.actionKey || "archive_production_signoff",
      packetPath: path.posix.join(archiveRoot, "staging-production-signoff-packet.json"),
      archiveIndexPath: path.posix.join(archiveRoot, "staging-launch-duty-archive-index.json"),
      reloadCommand: reload,
      nextAction: "Run reloadCommand, archive the production sign-off packet, then record launch_day_watch_summary."
    },
    receiptOperations: {
      launchDayWatchSummary: watchAction.evidence?.receiptOperations || [],
      firstWaveCloseout: firstWaveAction.evidence?.receiptOperations || []
    },
    sourceRecordKeys: firstWaveAction.sourceRecordKeys || [],
    nextAction: "Run the rehearsal reload, archive production sign-off, then record launch-day watch summary before first-wave closeout."
  };
}

function launchDutyOperatorStatus(item, index) {
  if (index === 0) {
    return "current";
  }
  if (item.key === "record_launch_day_watch_summary") {
    return "blocked_after_rehearsal_reload";
  }
  if (item.key === "close_first_wave") {
    return "blocked_after_launch_day_watch_summary";
  }
  return item.status || "blocked_after_prior_actions";
}

function buildLaunchDutyOperatorNextCommands(actionQueue) {
  return actionQueue.map((item, index) => ({
    key: item.key,
    status: launchDutyOperatorStatus(item, index),
    phase: item.phase,
    actionKey: item.actionKey || null,
    command: item.command || null,
    statusCommand: item.statusCommand || null,
    artifactPathHint: item.evidence?.artifactPathHint || null,
    receiptOperations: item.evidence?.receiptOperations || [],
    sourceRecordKeys: item.sourceRecordKeys || [],
    nextAction: item.operatorInstruction || null
  }));
}

function buildFullTestOperatorNextCommands(actionQueue) {
  const item = actionQueue.find((entry) => entry.key === "run_full_test_window");
  if (!item) {
    return [];
  }
  return [
    {
      key: "run_full_test_window",
      status: "current",
      phase: item.phase,
      actionKey: "run_full_test_window",
      targetKey: item.targetKey || "full_test_window_passed",
      command: item.command || "npm.cmd test",
      statusCommand: item.statusCommand || null,
      artifactPathHint: item.evidence?.artifactPathHint || null,
      receiptOperations: item.evidence?.receiptOperations || [],
      nextAction: "Run the full test window and save the redacted output artifact before backfilling full_test_window_passed."
    },
    {
      key: "backfill_full_test_result",
      status: "blocked_after_full_test_window",
      phase: "production_signoff",
      actionKey: "backfill_full_test_window_passed",
      targetKey: item.targetKey || "full_test_window_passed",
      command: item.followUpCommand || null,
      exampleCommand: item.followUpExampleCommand || null,
      statusCommand: item.statusCommand || null,
      artifactPathHint: item.evidence?.artifactPathHint || null,
      receiptOperations: item.evidence?.receiptOperations || [],
      nextAction: "Backfill full_test_window_passed, then rerun staging:readiness:status."
    },
    {
      key: "refresh_readiness_status",
      status: "blocked_after_full_test_backfill",
      phase: "production_signoff",
      actionKey: "refresh_readiness_status",
      targetKey: null,
      command: item.statusCommand || null,
      statusCommand: item.statusCommand || null,
      artifactPathHint: null,
      receiptOperations: [],
      nextAction: "Refresh readiness status to continue production sign-off evidence."
    }
  ];
}

function productionSignoffActionKey(item) {
  if (item.key === "set_production_signoff_decision") {
    return "set_production_signoff_decision";
  }
  return item.key;
}

function buildProductionSignoffOperatorNextCommands(actionQueue) {
  return actionQueue.map((item) => ({
    key: item.key,
    status: item.status || "blocked_after_prior_actions",
    phase: item.phase,
    actionKey: productionSignoffActionKey(item),
    targetKey: item.targetKey || null,
    command: item.command || null,
    exampleCommand: item.exampleCommand || null,
    statusCommand: item.statusCommand || null,
    artifactPathHint: item.evidence?.artifactPathHint || null,
    receiptOperations: item.evidence?.receiptOperations || [],
    nextAction: item.targetKey
      ? `Backfill ${item.targetKey}, then rerun staging:readiness:status.`
      : "Complete the current production sign-off action, then rerun staging:readiness:status."
  }));
}

function buildReadinessOperatorNextCommands({ currentGate, actionQueue }) {
  if (currentGate === "launch_day_watch") {
    return buildLaunchDutyOperatorNextCommands(actionQueue);
  }
  if (currentGate === "full_test_window") {
    return buildFullTestOperatorNextCommands(actionQueue);
  }
  if (currentGate === "production_signoff") {
    return buildProductionSignoffOperatorNextCommands(actionQueue);
  }
  return null;
}

function valueObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function evidenceArtifactPath(record) {
  const value = valueObject(record?.value ?? record);
  return record?.artifactPath || value.artifactPath || null;
}

function evidenceReceiptIds(record) {
  const value = valueObject(record?.value ?? record);
  if (Array.isArray(record?.receiptIds)) {
    return record.receiptIds;
  }
  if (Array.isArray(value.receiptIds)) {
    return value.receiptIds;
  }
  return [];
}

function evidenceStatus(record, fallback) {
  if (typeof record?.status === "string" && record.status.trim()) {
    return record.status.trim();
  }
  if (typeof record === "string" && record.trim()) {
    return record.trim();
  }
  if (record === true) {
    return fallback;
  }
  return fallback;
}

function evidenceSummaryItem(key, record, fallbackStatus) {
  return {
    key,
    status: evidenceStatus(record, fallbackStatus),
    artifactPath: evidenceArtifactPath(record),
    receiptIds: evidenceReceiptIds(record)
  };
}

function buildEvidenceSummary({
  closeoutFieldsByKey,
  signoffFieldsByKey,
  receiptVisibility,
  filledCloseoutKeys,
  missingCloseoutKeys,
  filledSignoffKeys,
  missingSignoffKeys,
  visibleReceiptVisibilityKeys,
  missingReceiptVisibilityKeys
}) {
  return {
    closeout: {
      requiredCount: REQUIRED_CLOSEOUT_KEYS.length,
      filledCount: filledCloseoutKeys.length,
      missingCount: missingCloseoutKeys.length,
      filledItems: filledCloseoutKeys.map((key) => evidenceSummaryItem(key, closeoutFieldsByKey.get(key), "filled"))
    },
    productionSignoff: {
      requiredConditionCount: REQUIRED_SIGNOFF_KEYS.length,
      filledConditionCount: filledSignoffKeys.length,
      missingConditionCount: missingSignoffKeys.length,
      filledConditions: filledSignoffKeys.map((key) => evidenceSummaryItem(key, signoffFieldsByKey.get(key), "filled"))
    },
    receiptVisibility: {
      requiredLaneCount: RECEIPT_VISIBILITY_KEYS.length,
      visibleLaneCount: visibleReceiptVisibilityKeys.length,
      missingLaneCount: missingReceiptVisibilityKeys.length,
      visibleLanes: visibleReceiptVisibilityKeys.map((key) => evidenceSummaryItem(key, receiptVisibility[key], "visible"))
    }
  };
}

function buildActionsFileSummary(actionsFile, actionQueue, inputFile) {
  return {
    path: actionsFile,
    status: "written",
    itemCount: actionQueue.length,
    currentCount: actionQueue.filter((item) => item.status === "current").length,
    rerunCommand: statusCommand(inputFile, actionsFile),
    nextAction: "Open the action file, complete the current item, then rerun staging:readiness:status."
  };
}

function renderActionTarget(targetKey) {
  return targetKey ? `\`${targetKey}\`` : "`none`";
}

function receiptText(receiptIds = []) {
  return receiptIds.length ? receiptIds.join(", ") : "-";
}

function artifactText(artifactPath) {
  return artifactPath || "-";
}

function renderEvidenceSummaryMarkdown(result) {
  const summary = result.evidenceSummary;
  const lines = [
    "## Evidence Progress",
    "",
    `Closeout evidence: \`${summary.closeout.filledCount}/${summary.closeout.requiredCount}\` filled, \`${summary.closeout.missingCount}\` missing`
  ];
  for (const item of summary.closeout.filledItems) {
    lines.push(`- closeout \`${item.key}\`: artifact \`${artifactText(item.artifactPath)}\`; receipts \`${receiptText(item.receiptIds)}\``);
  }
  lines.push(`Production sign-off evidence: \`${summary.productionSignoff.filledConditionCount}/${summary.productionSignoff.requiredConditionCount}\` filled, \`${summary.productionSignoff.missingConditionCount}\` missing`);
  for (const item of summary.productionSignoff.filledConditions) {
    lines.push(`- production sign-off \`${item.key}\`: artifact \`${artifactText(item.artifactPath)}\`; receipts \`${receiptText(item.receiptIds)}\``);
  }
  lines.push(`Receipt visibility: \`${summary.receiptVisibility.visibleLaneCount}/${summary.receiptVisibility.requiredLaneCount}\` visible, \`${summary.receiptVisibility.missingLaneCount}\` missing`);
  for (const item of summary.receiptVisibility.visibleLanes) {
    lines.push(`- receipt visibility \`${item.key}\`: artifact \`${artifactText(item.artifactPath)}\`; receipts \`${receiptText(item.receiptIds)}\``);
  }
  return lines;
}

function renderActionQueueMarkdown(result) {
  const lines = [
    "# Staging Readiness Action Queue",
    "",
    `Input file: \`${result.inputFile}\``,
    `Current gate: \`${result.readiness.currentGate}\``,
    `Launch status: \`${result.readiness.launchStatus}\``,
    "",
    ...renderEvidenceSummaryMarkdown(result),
    "",
    "Complete only `[current]` items first. Items marked `[blocked_after_prior_actions]` become safe after the earlier items are backfilled and the status command is rerun.",
    ""
  ];

  if (result.launchDutyNextRun) {
    const nextRun = result.launchDutyNextRun;
    lines.push("## Launch Duty Next Run");
    lines.push("");
    lines.push(`Launch-duty status: \`${nextRun.status || "-"}\``);
    lines.push(`Current action key: \`${nextRun.currentActionKey || "-"}\``);
    lines.push(`Reload command: \`${nextRun.reloadCommand || "-"}\``);
    lines.push(`Production sign-off packet: \`${nextRun.productionSignoffArchive?.packetPath || "-"}\``);
    lines.push(`Launch-duty archive index: \`${nextRun.productionSignoffArchive?.archiveIndexPath || "-"}\``);
    lines.push(`Archive next action: ${nextRun.productionSignoffArchive?.nextAction || "-"}`);
    lines.push(`Follow-up action keys: ${(nextRun.actionKeys || []).join(", ") || "-"}`);
    lines.push(`Watch artifact: \`${nextRun.artifactPathHints?.launchDayWatchSummary || "-"}\``);
    lines.push(`First-wave closeout artifact: \`${nextRun.artifactPathHints?.firstWaveCloseout || "-"}\``);
    if (result.operatorNextCommands?.length) {
      lines.push("Operator next commands:");
      for (const item of result.operatorNextCommands) {
        lines.push(`- ${item.status}: ${item.actionKey || item.key} -> \`${item.command || item.artifactPathHint || "-"}\``);
      }
    }
    lines.push("");
  }

  if (!result.launchDutyNextRun && result.operatorNextCommands?.length) {
    lines.push("## Operator Next Commands");
    lines.push("");
    for (const item of result.operatorNextCommands) {
      lines.push(`- ${item.status}: ${item.actionKey || item.key} -> \`${item.command || item.artifactPathHint || "-"}\``);
      if (item.exampleCommand) {
        lines.push(`  - Example: \`${item.exampleCommand}\``);
      }
      if (item.statusCommand) {
        lines.push(`  - Status check: \`${item.statusCommand}\``);
      }
      if (item.nextAction) {
        lines.push(`  - Next action: ${item.nextAction}`);
      }
    }
    lines.push("");
  }

  for (const [index, item] of result.actionQueue.entries()) {
    lines.push(`${index + 1}. [${item.status}] \`${item.phase}\` -> ${renderActionTarget(item.targetKey)}`);
    lines.push(`   Key: \`${item.key}\``);
    if (item.actionKey) {
      lines.push(`   Action key: \`${item.actionKey}\``);
    }
    if (item.sourceRecordKeys?.length) {
      lines.push(`   Source records: ${item.sourceRecordKeys.join(", ")}`);
    }
    if (item.operatorInstruction) {
      lines.push(`   Operator instruction: ${item.operatorInstruction}`);
    }
    if (item.evidence) {
      lines.push(`   Expected evidence: ${item.evidence.expectedEvidence}`);
      lines.push(`   Value JSON example: \`${JSON.stringify(item.evidence.valueJsonExample)}\``);
      lines.push(`   Artifact path hint: \`${item.evidence.artifactPathHint}\``);
      if (item.evidence.receiptOperations?.length) {
        lines.push(`   Receipt operations: ${item.evidence.receiptOperations.join(", ")}`);
      }
      lines.push(`   Receipt ID hint: ${item.evidence.receiptIdHint}`);
    }
    if (item.command) {
      lines.push(`   Command: \`${item.command}\``);
    }
    if (item.exampleCommand) {
      lines.push(`   Example command: \`${item.exampleCommand}\``);
    }
    if (item.followUpCommand) {
      lines.push(`   Follow-up: \`${item.followUpCommand}\``);
    }
    if (item.followUpExampleCommand) {
      lines.push(`   Follow-up example: \`${item.followUpExampleCommand}\``);
    }
    if (item.statusCommand) {
      lines.push(`   Status check: \`${item.statusCommand}\``);
    }
    lines.push("");
  }

  lines.push("Next action: complete the current item, rerun the status command, then regenerate this action file if the gate changes.");
  return `${lines.join("\n")}\n`;
}

function buildNextStep({
  inputFile,
  actionsFile,
  missingCloseoutKeys,
  closeoutDecision,
  missingSignoffKeys,
  missingReceiptVisibilityKeys,
  productionDecision,
  canRunFullTestWindow,
  canSignoffProduction
}) {
  if (missingCloseoutKeys.length > 0) {
    const targetKey = missingCloseoutKeys[0];
    return {
      key: "backfill_closeout_evidence",
      targetKey,
      command: commandForCloseoutBackfill(inputFile, targetKey, actionsFile),
      reloadCommand: reloadCommand(inputFile),
      nextAction: `Backfill ${targetKey}, then run reloadCommand.`
    };
  }
  if (closeoutDecision !== "ready-for-full-test-window") {
    return {
      key: "confirm_full_test_go_no_go",
      targetKey: "operator_go_no_go",
      command: commandForCloseoutBackfill(inputFile, "operator_go_no_go", actionsFile),
      reloadCommand: reloadCommand(inputFile),
      nextAction: "Set operator_go_no_go to ready-for-full-test-window, then run reloadCommand."
    };
  }
  if (!canRunFullTestWindow) {
    return {
      key: "reload_closeout_input",
      targetKey: null,
      command: reloadCommand(inputFile),
      nextAction: "Reload the closeout input to refresh full-test readiness."
    };
  }
  if (missingSignoffKeys.includes("full_test_window_passed")) {
    return {
      key: "run_full_test_window",
      targetKey: "full_test_window_passed",
      command: "npm.cmd test",
      backfillCommand: commandForSignoffCondition(inputFile, "full_test_window_passed", true, actionsFile),
      reloadCommand: reloadCommand(inputFile),
      nextAction: "Run the full test window, backfill full_test_window_passed, then run reloadCommand."
    };
  }
  if (productionDecision !== "ready-for-production-signoff") {
    return {
      key: "set_production_signoff_decision",
      targetKey: "productionSignoff.decision",
      command: commandForSignoffCondition(inputFile, missingSignoffKeys[0] || "operator_signoff_recorded", true, actionsFile),
      reloadCommand: reloadCommand(inputFile),
      nextAction: "Set productionSignoff.decision to ready-for-production-signoff while backfilling the next sign-off evidence."
    };
  }
  if (missingSignoffKeys.length > 0) {
    const targetKey = missingSignoffKeys[0];
    return {
      key: "backfill_production_signoff",
      targetKey,
      command: commandForSignoffCondition(inputFile, targetKey, false, actionsFile),
      reloadCommand: reloadCommand(inputFile),
      nextAction: `Backfill ${targetKey}, then run reloadCommand.`
    };
  }
  if (missingReceiptVisibilityKeys.length > 0) {
    const targetKey = missingReceiptVisibilityKeys[0];
    return {
      key: "backfill_receipt_visibility",
      targetKey,
      command: commandForReceiptLane(inputFile, targetKey, actionsFile),
      reloadCommand: reloadCommand(inputFile),
      nextAction: `Backfill ${targetKey} receipt visibility, then run reloadCommand.`
    };
  }
  if (canSignoffProduction) {
    return {
      key: "reload_rehearsal_for_launch_day_watch",
      targetKey: null,
      command: reloadCommand(inputFile),
      nextAction: "Reload rehearsal and start launch-day watch from the generated packet."
    };
  }
  return {
    key: "review_readiness_packet",
    targetKey: null,
    command: reloadCommand(inputFile),
    nextAction: "Reload rehearsal and inspect the readiness packet for remaining blockers."
  };
}

function buildStatus(payload, inputFile, actionsFile = null) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("closeout input must be a JSON object.");
  }
  if (payload.exampleOnly === true || payload.mode === "staging-closeout-input-example") {
    throw new Error("Refusing to inspect example closeout input; use a real filled closeout input file.");
  }

  const artifactPathRoot = artifactPathRootFromInputFile(inputFile);
  const closeoutFieldsByKey = fieldsByKey(payload.acceptanceFields);
  const filledCloseoutKeys = REQUIRED_CLOSEOUT_KEYS.filter((key) => isFilledField(closeoutFieldsByKey.get(key)));
  const missingCloseoutKeys = REQUIRED_CLOSEOUT_KEYS.filter((key) => !filledCloseoutKeys.includes(key));
  const operatorGoNoGo = closeoutFieldsByKey.get("operator_go_no_go");
  const closeoutDecision = extractDecisionValue(operatorGoNoGo?.value)
    || extractDecisionValue(payload.decision)
    || null;

  const productionSignoff = payload.productionSignoff && typeof payload.productionSignoff === "object"
    ? payload.productionSignoff
    : {};
  const signoffFieldsByKey = fieldsByKey(productionSignoff.conditions);
  const filledSignoffKeys = REQUIRED_SIGNOFF_KEYS.filter((key) => isFilledField(signoffFieldsByKey.get(key)));
  const missingSignoffKeys = REQUIRED_SIGNOFF_KEYS.filter((key) => !filledSignoffKeys.includes(key));
  const receiptVisibility = payload.receiptVisibility || productionSignoff.receiptVisibility || {};
  const visibleReceiptVisibilityKeys = RECEIPT_VISIBILITY_KEYS.filter((key) => isReceiptVisibilityVisible(receiptVisibility[key]));
  const missingReceiptVisibilityKeys = RECEIPT_VISIBILITY_KEYS.filter((key) => !visibleReceiptVisibilityKeys.includes(key));
  const productionDecision = productionSignoff.decision || null;

  const canRunFullTestWindow = missingCloseoutKeys.length === 0 && closeoutDecision === "ready-for-full-test-window";
  const canSignoffProduction = canRunFullTestWindow
    && missingSignoffKeys.length === 0
    && missingReceiptVisibilityKeys.length === 0
    && productionDecision === "ready-for-production-signoff";
  const currentGate = !canRunFullTestWindow
    ? "pre_full_test_closeout"
    : canSignoffProduction
      ? "launch_day_watch"
      : missingSignoffKeys.includes("full_test_window_passed")
        ? "full_test_window"
        : "production_signoff";
  const launchStatus = canSignoffProduction ? "ready_for_launch_day_watch" : "blocked";
  const nextStep = buildNextStep({
    inputFile,
    actionsFile,
    missingCloseoutKeys,
    closeoutDecision,
    missingSignoffKeys,
    missingReceiptVisibilityKeys,
    productionDecision,
    canRunFullTestWindow,
    canSignoffProduction
  });
  const actionQueue = buildActionQueue({
    inputFile,
    actionsFile,
    artifactPathRoot,
    missingCloseoutKeys,
    closeoutDecision,
    missingSignoffKeys,
    missingReceiptVisibilityKeys,
    productionDecision,
    canRunFullTestWindow,
    canSignoffProduction
  });
  const launchDutyNextRun = canSignoffProduction
    ? buildLaunchDutyNextRun({ inputFile, actionQueue, artifactPathRoot })
    : null;
  const operatorNextCommands = buildReadinessOperatorNextCommands({ currentGate, actionQueue });
  const evidenceSummary = buildEvidenceSummary({
    closeoutFieldsByKey,
    signoffFieldsByKey,
    receiptVisibility,
    filledCloseoutKeys,
    missingCloseoutKeys,
    filledSignoffKeys,
    missingSignoffKeys,
    visibleReceiptVisibilityKeys,
    missingReceiptVisibilityKeys
  });

  return {
    status: "pass",
    mode: "staging-readiness-status",
    inputFile,
    artifactPathRoot,
    readiness: {
      currentGate,
      launchStatus,
      canRunFullTestWindow,
      canSignoffProduction,
      canStartLaunchDayWatch: canSignoffProduction,
      closeout: {
        requiredCount: REQUIRED_CLOSEOUT_KEYS.length,
        filledCount: filledCloseoutKeys.length,
        requiredDecision: "ready-for-full-test-window",
        decision: closeoutDecision,
        missingKeys: missingCloseoutKeys
      },
      productionSignoff: {
        requiredDecision: "ready-for-production-signoff",
        decision: productionDecision,
        requiredConditionCount: REQUIRED_SIGNOFF_KEYS.length,
        filledConditionCount: filledSignoffKeys.length,
        missingConditionKeys: missingSignoffKeys,
        requiredReceiptVisibilityKeys: RECEIPT_VISIBILITY_KEYS,
        visibleReceiptLaneCount: visibleReceiptVisibilityKeys.length,
        missingReceiptVisibilityKeys
      }
    },
    evidenceSummary,
    ...(launchDutyNextRun ? { launchDutyNextRun } : {}),
    ...(operatorNextCommands?.length ? { operatorNextCommands } : {}),
    nextStep,
    actionQueue
  };
}

function writeActionsFile(result, actionsFile) {
  const resolvedActionsFile = path.resolve(actionsFile);
  const nextResult = {
    ...result,
    actionsFile: buildActionsFileSummary(resolvedActionsFile, result.actionQueue, result.inputFile)
  };
  mkdirSync(path.dirname(resolvedActionsFile), { recursive: true });
  writeFileSync(resolvedActionsFile, renderActionQueueMarkdown(nextResult), "utf8");
  return nextResult;
}

function writeEvidenceSummaryPlain(summary) {
  console.log(`Evidence progress closeout: ${summary.closeout.filledCount}/${summary.closeout.requiredCount} filled, ${summary.closeout.missingCount} missing`);
  for (const item of summary.closeout.filledItems) {
    console.log(`Evidence filled closeout ${item.key}: artifact=${artifactText(item.artifactPath)} receipts=${receiptText(item.receiptIds)}`);
  }
  console.log(`Evidence progress production signoff: ${summary.productionSignoff.filledConditionCount}/${summary.productionSignoff.requiredConditionCount} filled, ${summary.productionSignoff.missingConditionCount} missing`);
  for (const item of summary.productionSignoff.filledConditions) {
    console.log(`Evidence filled production signoff ${item.key}: artifact=${artifactText(item.artifactPath)} receipts=${receiptText(item.receiptIds)}`);
  }
  console.log(`Evidence progress receipt visibility: ${summary.receiptVisibility.visibleLaneCount}/${summary.receiptVisibility.requiredLaneCount} visible, ${summary.receiptVisibility.missingLaneCount} missing`);
  for (const item of summary.receiptVisibility.visibleLanes) {
    console.log(`Evidence visible receipt ${item.key}: artifact=${artifactText(item.artifactPath)} receipts=${receiptText(item.receiptIds)}`);
  }
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.status === "pass") {
    console.log(`Current gate: ${result.readiness.currentGate}`);
    console.log(`Next step: ${result.nextStep.key}`);
    console.log(result.nextStep.command);
    writeEvidenceSummaryPlain(result.evidenceSummary);
    if (result.operatorNextCommands?.length) {
      for (const item of result.operatorNextCommands) {
        console.log(`Operator next ${item.status}: ${item.actionKey || item.key} -> ${item.command || item.artifactPathHint || "-"}`);
        if (item.exampleCommand) {
          console.log(`Operator next ${item.status} example: ${item.exampleCommand}`);
        }
        if (item.artifactPathHint) {
          console.log(`Operator next ${item.status} artifact: ${item.artifactPathHint}`);
        }
        if (item.statusCommand) {
          console.log(`Operator next ${item.status} status check: ${item.statusCommand}`);
        }
        if (item.receiptOperations?.length) {
          console.log(`Operator next ${item.status} receipts: ${item.receiptOperations.join(", ")}`);
        }
        if (item.sourceRecordKeys?.length) {
          console.log(`Operator next ${item.status} source records: ${item.sourceRecordKeys.join(", ")}`);
        }
        if (item.nextAction) {
          console.log(`Operator next ${item.status} next action: ${item.nextAction}`);
        }
      }
    }
    if (result.launchDutyNextRun) {
      const nextRun = result.launchDutyNextRun;
      console.log(`Launch duty current action: ${nextRun.currentActionKey}`);
      console.log(`Launch duty reload: ${nextRun.reloadCommand}`);
      console.log(`Launch duty production signoff packet: ${nextRun.productionSignoffArchive?.packetPath || "-"}`);
      console.log(`Launch duty archive index: ${nextRun.productionSignoffArchive?.archiveIndexPath || "-"}`);
      console.log(`Launch duty archive next action: ${nextRun.productionSignoffArchive?.nextAction || "-"}`);
      console.log(`Launch duty follow-up actions: ${(nextRun.actionKeys || []).join(" -> ") || "-"}`);
      console.log(`Launch duty watch artifact: ${nextRun.artifactPathHints?.launchDayWatchSummary || "-"}`);
      console.log(`Launch duty watch receipts: ${(nextRun.receiptOperations?.launchDayWatchSummary || []).join(", ") || "-"}`);
      console.log(`Launch duty first-wave closeout: ${nextRun.artifactPathHints?.firstWaveCloseout || "-"}`);
      console.log(`Launch duty first-wave receipts: ${(nextRun.receiptOperations?.firstWaveCloseout || []).join(", ") || "-"}`);
      console.log(`Launch duty first-wave source records: ${(nextRun.sourceRecordKeys || []).join(", ") || "-"}`);
      console.log(`Launch duty next action: ${nextRun.nextAction || "-"}`);
    }
    if (result.actionsFile) {
      console.log(`Action file: ${result.actionsFile.path}`);
    }
    return;
  }
  console.log(`Staging readiness status failed: ${result.error.message}`);
}

function main() {
  const json = process.argv.includes("--json");
  try {
    const options = parseArgs(process.argv.slice(2));
    const inputFile = path.resolve(options.inputFile);
    const actionsFile = options.actionsFile ? path.resolve(options.actionsFile) : null;
    const payload = JSON.parse(readFileSync(inputFile, "utf8"));
    const result = buildStatus(payload, inputFile, actionsFile);
    writeResult(actionsFile ? writeActionsFile(result, actionsFile) : result, options.json);
  } catch (error) {
    writeResult({
      status: "fail",
      mode: "staging-readiness-status",
      error: {
        message: error.message
      }
    }, json);
    process.exitCode = 1;
  }
}

main();
