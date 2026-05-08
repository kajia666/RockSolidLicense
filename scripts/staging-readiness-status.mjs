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

function commandForCloseoutBackfill(inputFile, key) {
  return `npm.cmd run staging:closeout:backfill -- --input-file ${inputFile} --key ${key} --value-json <redacted-json>`;
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

function commandForCloseoutBackfillExample(inputFile, key, evidence) {
  return `npm.cmd run staging:closeout:backfill -- --input-file ${inputFile} --key ${key}${evidenceArgs(evidence)}`;
}

function commandForSignoffCondition(inputFile, key, includeDecision = false) {
  const decision = includeDecision ? " --decision ready-for-production-signoff" : "";
  return `npm.cmd run staging:signoff:backfill -- --input-file ${inputFile} --condition-key ${key} --value-json <redacted-json>${decision}`;
}

function commandForSignoffConditionExample(inputFile, key, evidence, includeDecision = false) {
  const decision = includeDecision ? " --decision ready-for-production-signoff" : "";
  return `npm.cmd run staging:signoff:backfill -- --input-file ${inputFile} --condition-key ${key}${evidenceArgs(evidence)}${decision}`;
}

function commandForReceiptLane(inputFile, key) {
  return `npm.cmd run staging:signoff:backfill -- --input-file ${inputFile} --receipt-lane ${key} --value-json <redacted-json>`;
}

function commandForReceiptLaneExample(inputFile, key, evidence) {
  return `npm.cmd run staging:signoff:backfill -- --input-file ${inputFile} --receipt-lane ${key}${evidenceArgs(evidence)}`;
}

function reloadCommand(inputFile) {
  return `npm.cmd run staging:rehearsal -- --closeout-input-file ${inputFile}`;
}

function statusCommand(inputFile) {
  return `npm.cmd run staging:readiness:status -- --input-file ${inputFile}`;
}

function queueStatus(index) {
  return index === 0 ? "current" : "blocked_after_prior_actions";
}

function buildActionQueue({
  inputFile,
  artifactPathRoot,
  missingCloseoutKeys,
  closeoutDecision,
  missingSignoffKeys,
  missingReceiptVisibilityKeys,
  productionDecision,
  canRunFullTestWindow,
  canSignoffProduction
}) {
  const localStatusCommand = statusCommand(inputFile);
  if (missingCloseoutKeys.length > 0) {
    return missingCloseoutKeys.map((key, index) => {
      const evidence = evidenceForCloseoutKey(key, artifactPathRoot);
      return {
        key: "backfill_closeout_evidence",
        phase: "pre_full_test_closeout",
        status: queueStatus(index),
        targetKey: key,
        command: commandForCloseoutBackfill(inputFile, key),
        exampleCommand: commandForCloseoutBackfillExample(inputFile, key, evidence),
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
        command: commandForCloseoutBackfill(inputFile, "operator_go_no_go"),
        exampleCommand: commandForCloseoutBackfillExample(inputFile, "operator_go_no_go", evidence),
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
        followUpCommand: commandForSignoffCondition(inputFile, "full_test_window_passed", true),
        followUpExampleCommand: commandForSignoffConditionExample(inputFile, "full_test_window_passed", evidence, true),
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
        command: commandForSignoffCondition(inputFile, key, true),
        exampleCommand: commandForSignoffConditionExample(inputFile, key, evidence, true),
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
      command: commandForSignoffCondition(inputFile, key),
      exampleCommand: commandForSignoffConditionExample(inputFile, key, evidence),
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
      command: commandForReceiptLane(inputFile, key),
      exampleCommand: commandForReceiptLaneExample(inputFile, key, evidence),
      evidence,
      statusCommand: localStatusCommand
    };
  });
  if (signoffQueue.length > 0 || receiptQueue.length > 0) {
    return [...signoffQueue, ...receiptQueue];
  }
  if (canSignoffProduction) {
    return [
      {
        key: "reload_rehearsal_for_launch_day_watch",
        phase: "launch_day_watch",
        status: "current",
        targetKey: null,
        command: reloadCommand(inputFile)
      }
    ];
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

function buildActionsFileSummary(actionsFile, actionQueue) {
  return {
    path: actionsFile,
    status: "written",
    itemCount: actionQueue.length,
    currentCount: actionQueue.filter((item) => item.status === "current").length,
    nextAction: "Open the action file, complete the current item, then rerun staging:readiness:status."
  };
}

function renderActionTarget(targetKey) {
  return targetKey ? `\`${targetKey}\`` : "`none`";
}

function renderActionQueueMarkdown(result) {
  const lines = [
    "# Staging Readiness Action Queue",
    "",
    `Input file: \`${result.inputFile}\``,
    `Current gate: \`${result.readiness.currentGate}\``,
    `Launch status: \`${result.readiness.launchStatus}\``,
    "",
    "Complete only `[current]` items first. Items marked `[blocked_after_prior_actions]` become safe after the earlier items are backfilled and the status command is rerun.",
    ""
  ];

  for (const [index, item] of result.actionQueue.entries()) {
    lines.push(`${index + 1}. [${item.status}] \`${item.phase}\` -> ${renderActionTarget(item.targetKey)}`);
    lines.push(`   Key: \`${item.key}\``);
    if (item.evidence) {
      lines.push(`   Expected evidence: ${item.evidence.expectedEvidence}`);
      lines.push(`   Value JSON example: \`${JSON.stringify(item.evidence.valueJsonExample)}\``);
      lines.push(`   Artifact path hint: \`${item.evidence.artifactPathHint}\``);
      if (item.evidence.receiptOperations?.length) {
        lines.push(`   Receipt operations: ${item.evidence.receiptOperations.join(", ")}`);
      }
      lines.push(`   Receipt ID hint: ${item.evidence.receiptIdHint}`);
    }
    lines.push(`   Command: \`${item.command}\``);
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
      command: commandForCloseoutBackfill(inputFile, targetKey),
      reloadCommand: reloadCommand(inputFile),
      nextAction: `Backfill ${targetKey}, then run reloadCommand.`
    };
  }
  if (closeoutDecision !== "ready-for-full-test-window") {
    return {
      key: "confirm_full_test_go_no_go",
      targetKey: "operator_go_no_go",
      command: commandForCloseoutBackfill(inputFile, "operator_go_no_go"),
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
      backfillCommand: commandForSignoffCondition(inputFile, "full_test_window_passed", true),
      reloadCommand: reloadCommand(inputFile),
      nextAction: "Run the full test window, backfill full_test_window_passed, then run reloadCommand."
    };
  }
  if (productionDecision !== "ready-for-production-signoff") {
    return {
      key: "set_production_signoff_decision",
      targetKey: "productionSignoff.decision",
      command: commandForSignoffCondition(inputFile, missingSignoffKeys[0] || "operator_signoff_recorded", true),
      reloadCommand: reloadCommand(inputFile),
      nextAction: "Set productionSignoff.decision to ready-for-production-signoff while backfilling the next sign-off evidence."
    };
  }
  if (missingSignoffKeys.length > 0) {
    const targetKey = missingSignoffKeys[0];
    return {
      key: "backfill_production_signoff",
      targetKey,
      command: commandForSignoffCondition(inputFile, targetKey),
      reloadCommand: reloadCommand(inputFile),
      nextAction: `Backfill ${targetKey}, then run reloadCommand.`
    };
  }
  if (missingReceiptVisibilityKeys.length > 0) {
    const targetKey = missingReceiptVisibilityKeys[0];
    return {
      key: "backfill_receipt_visibility",
      targetKey,
      command: commandForReceiptLane(inputFile, targetKey),
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

function buildStatus(payload, inputFile) {
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
    artifactPathRoot,
    missingCloseoutKeys,
    closeoutDecision,
    missingSignoffKeys,
    missingReceiptVisibilityKeys,
    productionDecision,
    canRunFullTestWindow,
    canSignoffProduction
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
    nextStep,
    actionQueue
  };
}

function writeActionsFile(result, actionsFile) {
  const resolvedActionsFile = path.resolve(actionsFile);
  const nextResult = {
    ...result,
    actionsFile: buildActionsFileSummary(resolvedActionsFile, result.actionQueue)
  };
  mkdirSync(path.dirname(resolvedActionsFile), { recursive: true });
  writeFileSync(resolvedActionsFile, renderActionQueueMarkdown(nextResult), "utf8");
  return nextResult;
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
    const payload = JSON.parse(readFileSync(inputFile, "utf8"));
    const result = buildStatus(payload, inputFile);
    writeResult(options.actionsFile ? writeActionsFile(result, options.actionsFile) : result, options.json);
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
