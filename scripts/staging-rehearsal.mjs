#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const ADMIN_PASSWORD_ENV = "RSL_SMOKE_ADMIN_PASSWORD";
const DEVELOPER_PASSWORD_ENV = "RSL_SMOKE_DEVELOPER_PASSWORD";
const DEVELOPER_BEARER_TOKEN_ENV = "RSL_DEVELOPER_BEARER_TOKEN";

const EVIDENCE_ORDER = [
  "Record Launch Rehearsal Run",
  "Record Recovery Drill",
  "Record Backup Verification",
  "Record Operations Walkthrough",
  "Record Deploy Verification",
  "Record Health Verification",
  "Record Rollback Walkthrough",
  "Record Cutover Walkthrough",
  "Record Launch Day Readiness Review",
  "Record First-Wave Ops Sweep",
  "Record Launch Closeout Review",
  "Record Launch Stabilization Review"
];

const EVIDENCE_ACTIONS = [
  ["Record Launch Rehearsal Run", "record_launch_rehearsal_run"],
  ["Record Recovery Drill", "record_recovery_drill"],
  ["Record Backup Verification", "record_backup_verification"],
  ["Record Operations Walkthrough", "record_operations_walkthrough"],
  ["Record Deploy Verification", "record_deploy_verification"],
  ["Record Health Verification", "record_health_verification"],
  ["Record Rollback Walkthrough", "record_rollback_walkthrough"],
  ["Record Cutover Walkthrough", "record_cutover_walkthrough"],
  ["Record Launch Day Readiness Review", "record_launch_day_readiness_review"],
  ["Record First-Wave Ops Sweep", "record_post_launch_ops_sweep"],
  ["Record Launch Closeout Review", "record_launch_closeout_review"],
  ["Record Launch Stabilization Review", "record_launch_stabilization_review"]
];

const RECEIPT_VISIBILITY_KEYS = [
  "launchMainline",
  "launchReview",
  "launchSmoke",
  "developerOps"
];

function parseArgs(argv) {
  const options = {
    json: false,
    baseUrl: null,
    productCode: null,
    channel: "stable",
    adminUsername: null,
    adminPassword: null,
    developerUsername: null,
    developerPassword: null,
    targetOs: null,
    storageProfile: null,
    targetEnvFile: null,
    appBackupDir: null,
    postgresBackupDir: null,
    handoffFile: null,
    closeoutFile: null,
    closeoutInputFile: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }

    const [name, inlineValue] = arg.split("=", 2);
    const value = inlineValue ?? argv[index + 1];
    if (name === "--base-url") {
      options.baseUrl = requireArgValue(name, value, inlineValue);
    } else if (name === "--product-code") {
      options.productCode = requireArgValue(name, value, inlineValue);
    } else if (name === "--channel") {
      options.channel = requireArgValue(name, value, inlineValue);
    } else if (name === "--admin-username") {
      options.adminUsername = requireArgValue(name, value, inlineValue);
    } else if (name === "--admin-password") {
      options.adminPassword = requireArgValue(name, value, inlineValue);
    } else if (name === "--developer-username") {
      options.developerUsername = requireArgValue(name, value, inlineValue);
    } else if (name === "--developer-password") {
      options.developerPassword = requireArgValue(name, value, inlineValue);
    } else if (name === "--target-os") {
      options.targetOs = requireArgValue(name, value, inlineValue);
    } else if (name === "--storage-profile") {
      options.storageProfile = requireArgValue(name, value, inlineValue);
    } else if (name === "--target-env-file") {
      options.targetEnvFile = requireArgValue(name, value, inlineValue);
    } else if (name === "--app-backup-dir") {
      options.appBackupDir = requireArgValue(name, value, inlineValue);
    } else if (name === "--postgres-backup-dir") {
      options.postgresBackupDir = requireArgValue(name, value, inlineValue);
    } else if (name === "--handoff-file") {
      options.handoffFile = requireArgValue(name, value, inlineValue);
    } else if (name === "--closeout-file") {
      options.closeoutFile = requireArgValue(name, value, inlineValue);
    } else if (name === "--closeout-input-file") {
      options.closeoutInputFile = requireArgValue(name, value, inlineValue);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return {
    ...options,
    baseUrl: readOptionOrEnv(options.baseUrl, "RSL_STAGING_BASE_URL"),
    productCode: readOptionOrEnv(options.productCode, "RSL_SMOKE_PRODUCT_CODE"),
    channel: readOptionOrEnv(options.channel, "RSL_SMOKE_CHANNEL") || "stable",
    adminUsername: readOptionOrEnv(options.adminUsername, "RSL_SMOKE_ADMIN_USERNAME"),
    adminPassword: readOptionOrEnv(options.adminPassword, "RSL_SMOKE_ADMIN_PASSWORD"),
    developerUsername: readOptionOrEnv(options.developerUsername, "RSL_SMOKE_DEVELOPER_USERNAME"),
    developerPassword: readOptionOrEnv(options.developerPassword, "RSL_SMOKE_DEVELOPER_PASSWORD"),
    targetOs: readOptionOrEnv(options.targetOs, "RSL_RECOVERY_TARGET_OS"),
    storageProfile: readOptionOrEnv(options.storageProfile, "RSL_RECOVERY_STORAGE_PROFILE"),
    targetEnvFile: readOptionOrEnv(options.targetEnvFile, "RSL_RECOVERY_ENV_FILE"),
    appBackupDir: readOptionOrEnv(options.appBackupDir, "RSL_RECOVERY_APP_BACKUP_DIR"),
    postgresBackupDir: readOptionOrEnv(options.postgresBackupDir, "RSL_RECOVERY_POSTGRES_BACKUP_DIR"),
    handoffFile: readOptionOrEnv(options.handoffFile, "RSL_REHEARSAL_HANDOFF_FILE"),
    closeoutFile: readOptionOrEnv(options.closeoutFile, "RSL_REHEARSAL_CLOSEOUT_FILE"),
    closeoutInputFile: readOptionOrEnv(options.closeoutInputFile, "RSL_REHEARSAL_CLOSEOUT_INPUT_FILE")
  };
}

function requireArgValue(name, value, inlineValue) {
  const missingValue = value === undefined
    || value === null
    || String(value).trim() === ""
    || (inlineValue === undefined && String(value).startsWith("--"));
  if (missingValue) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function readOptionOrEnv(value, envName) {
  const resolved = value ?? process.env[envName] ?? null;
  return resolved === null ? null : String(resolved).trim();
}

function runJsonScript(scriptName, args) {
  const result = spawnSync(process.execPath, [path.join("scripts", scriptName), "--json", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000
  });

  const stdout = result.stdout || "";
  let payload = null;
  try {
    payload = stdout ? JSON.parse(stdout) : null;
  } catch {
    payload = {
      status: "fail",
      error: {
        message: `Could not parse JSON from ${scriptName}: ${stdout.slice(0, 200)}`
      }
    };
  }

  if (result.status !== 0 && payload?.status !== "fail") {
    payload = {
      status: "fail",
      error: {
        message: result.stderr || `${scriptName} exited with ${result.status}`
      }
    };
  }

  return payload;
}

function buildStagingPreflightArgs(options) {
  return [
    "--base-url", options.baseUrl,
    "--product-code", options.productCode,
    "--channel", options.channel,
    "--admin-username", options.adminUsername,
    "--admin-password", options.adminPassword,
    "--developer-username", options.developerUsername,
    "--developer-password", options.developerPassword
  ];
}

function buildRecoveryPreflightArgs(options) {
  const args = [
    "--target-os", options.targetOs,
    "--storage-profile", options.storageProfile,
    "--target-env-file", options.targetEnvFile,
    "--app-backup-dir", options.appBackupDir,
    "--base-url", options.baseUrl
  ];
  if (options.postgresBackupDir) {
    args.push("--postgres-backup-dir", options.postgresBackupDir);
  }
  return args;
}

function buildRoute(baseUrl, pathname, params) {
  const url = new URL(pathname, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value) !== "") {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function buildPhases(status) {
  return [
    {
      key: "staging_command_preflight",
      status: status.staging
    },
    {
      key: "recovery_command_preflight",
      status: status.recovery
    },
    {
      key: "run_staging_launch_smoke",
      status: status.liveSmoke
    },
    {
      key: "open_launch_mainline",
      status: status.launchMainline
    },
    {
      key: "record_mainline_evidence",
      status: status.evidence
    }
  ];
}

function firstFailedPhase(phases) {
  return phases.find((phase) => phase.status === "blocked" || phase.status === "fail") || null;
}

function quotePowerShellSingleQuoted(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function buildEvidenceRequest(endpoint, payload) {
  return {
    method: "POST",
    url: endpoint,
    contentType: "application/json",
    bearerTokenEnv: DEVELOPER_BEARER_TOKEN_ENV,
    powershell: [
      `$headers = @{ Authorization = "Bearer $env:${DEVELOPER_BEARER_TOKEN_ENV}" }`,
      "$body = @'",
      JSON.stringify(payload, null, 2),
      "'@",
      `Invoke-RestMethod -Method Post -Uri ${quotePowerShellSingleQuoted(endpoint)} -Headers $headers -ContentType 'application/json' -Body $body`
    ].join("\n")
  };
}

function buildEvidenceActionPlan(options) {
  const endpoint = buildRoute(options.baseUrl, "/api/developer/launch-mainline/action", {});
  return {
    endpoint,
    method: "POST",
    willModifyData: true,
    auth: "developer bearer token",
    items: EVIDENCE_ACTIONS.map(([label, operation], index) => {
      const payload = {
        productCode: options.productCode,
        channel: options.channel,
        operation
      };
      return {
        key: operation,
        label,
        operation,
        order: index + 1,
        payload,
        expectedReceiptOperation: operation,
        request: buildEvidenceRequest(endpoint, payload)
      };
    })
  };
}

function buildEvidenceReadiness(options, actionPlan) {
  const developerBearerToken = process.env[DEVELOPER_BEARER_TOKEN_ENV] || "";
  const targetLaneReady = Boolean(options.productCode && options.channel);
  const endpointReady = Boolean(actionPlan?.endpoint);
  const tokenReady = developerBearerToken.trim() !== "";
  const readyToExecute = targetLaneReady && endpointReady && tokenReady;

  return {
    status: readyToExecute ? "ready" : "needs_operator_input",
    readyToExecute,
    checks: {
      targetLane: targetLaneReady ? "pass" : "missing",
      evidenceEndpoint: endpointReady ? "pass" : "missing",
      developerBearerToken: tokenReady ? "present" : "missing"
    },
    tokenEnv: DEVELOPER_BEARER_TOKEN_ENV,
    targetLane: {
      productCode: options.productCode,
      channel: options.channel
    },
    endpoint: actionPlan?.endpoint || null,
    nextAction: readyToExecute
      ? "Copy evidence request snippets only after the matching launch evidence has actually happened."
      : `Set $env:${DEVELOPER_BEARER_TOKEN_ENV} before copying evidence request snippets.`
  };
}

function buildReceiptVisibilitySummaryDownloads(options) {
  return {
    launchReviewSummary: buildRoute(options.baseUrl, "/api/developer/launch-review/download", {
      productCode: options.productCode,
      channel: options.channel,
      source: "launch-smoke",
      handoff: "first-wave",
      format: "summary"
    }),
    launchSmokeSummary: buildRoute(options.baseUrl, "/api/developer/launch-smoke-kit/download", {
      productCode: options.productCode,
      channel: options.channel,
      operation: "record_post_launch_ops_sweep",
      downloadKey: "launch_smoke_summary",
      format: "summary"
    })
  };
}

function buildLaunchRouteMapGateCommand() {
  return {
    command: "npm.cmd run launch:route-map-gate",
    dryRunCommand: "npm.cmd run launch:route-map-gate -- --dry-run --json",
    willModifyData: false,
    willRunFullSuite: false,
    purpose: "Re-run the Launch Mainline / Launch Smoke / Developer Ops route-map visibility and low-frequency download surface targeted gate before live-write staging smoke."
  };
}

function buildStagingEnvironmentReadiness(options, { recovery = null, launchRouteMapGate = null } = {}) {
  const recoveryCommandKeys = Object.keys(recovery?.nextCommands || {});
  return {
    status: "needs_operator_execution",
    willModifyData: false,
    nextAction: "Complete the operator_confirm and operator_execute items before running the live-write staging smoke command.",
    checks: [
      {
        key: "public_https_entrypoint",
        label: "Public HTTPS entrypoint",
        status: String(options.baseUrl || "").startsWith("https://") ? "pass" : "fail",
        evidence: `Base URL: ${options.baseUrl || "-"}`,
        nextAction: "Keep staging smoke pointed at the public HTTPS endpoint."
      },
      {
        key: "non_default_secrets",
        label: "Non-default secrets",
        status: "operator_confirm",
        evidence: "Smoke commands reference password environment variables and do not print secret values.",
        nextAction: "Confirm the deployed server token secret, admin password, and smoke developer credentials are non-default before live-write smoke."
      },
      {
        key: "persistent_storage",
        label: "Persistent storage",
        status: "operator_confirm",
        evidence: [
          `Storage profile: ${options.storageProfile || "-"}`,
          `Env file: ${options.targetEnvFile || "-"}`,
          `App backup dir: ${options.appBackupDir || "-"}`,
          `Postgres backup dir: ${options.postgresBackupDir || "-"}`
        ].join(" | "),
        nextAction: "Confirm the target uses the intended persistent storage profile and backup directories before writing smoke data."
      },
      {
        key: "backup_restore_drill",
        label: "Backup and restore drill",
        status: "operator_execute",
        evidence: recoveryCommandKeys.length
          ? `Recovery command keys: ${recoveryCommandKeys.join(", ")}`
          : "Recovery commands are not available.",
        commandKeys: recoveryCommandKeys,
        nextAction: "Run the generated backup and restore dry-run commands on a separate restore target before staging sign-off."
      },
      {
        key: "route_map_gate",
        label: "Route-map and download-surface gate",
        status: "operator_execute",
        evidence: launchRouteMapGate?.dryRunCommand || "Run the route-map gate dry run first.",
        command: launchRouteMapGate?.command || null,
        dryRunCommand: launchRouteMapGate?.dryRunCommand || null,
        nextAction: "Run the targeted gate after the rehearsal handoff and before live-write staging smoke."
      },
      {
        key: "live_write_approval",
        label: "Live-write approval",
        status: "operator_confirm",
        evidence: "The generated staging smoke command includes --allow-live-writes and will modify staging data.",
        nextAction: "Get explicit launch-duty approval before running the live-write smoke command."
      }
    ]
  };
}

function buildStagingOperatorChecklist(result) {
  const recoveryCommandKeys = Object.keys(result.nextCommands?.recovery || {});
  const evidenceOperations = Array.isArray(result.evidenceActionPlan?.items)
    ? result.evidenceActionPlan.items.map((item) => item.operation)
    : [];
  return [
    {
      key: "review_environment_readiness",
      order: 1,
      label: "Review environment readiness",
      status: "operator_review",
      summary: "Confirm HTTPS, non-default secrets, storage, recovery, route-map gate, and live-write approval readiness.",
      readinessStatus: result.environmentReadiness?.status || "not_available"
    },
    {
      key: "run_route_map_gate",
      order: 2,
      label: "Run route-map and download-surface gate",
      status: "operator_execute",
      command: result.nextCommands?.launchRouteMapGate?.command || null,
      dryRunCommand: result.nextCommands?.launchRouteMapGate?.dryRunCommand || null,
      summary: "Run the targeted pre-staging gate before any live-write smoke command."
    },
    {
      key: "run_backup_restore_drill",
      order: 3,
      label: "Run backup and restore drill",
      status: "operator_execute",
      commandKeys: recoveryCommandKeys,
      summary: "Run generated backup and restore dry-run commands on a separate restore target."
    },
    {
      key: "approve_live_write_smoke",
      order: 4,
      label: "Approve live-write smoke",
      status: "operator_confirm",
      summary: "Confirm launch duty accepts staging writes before running the smoke command."
    },
    {
      key: "run_live_write_smoke",
      order: 5,
      label: "Run live-write staging smoke",
      status: "operator_execute",
      command: result.nextCommands?.launchSmoke || null,
      summary: "Run launch:smoke:staging only after approvals and recovery checks are complete."
    },
    {
      key: "save_smoke_handoff",
      order: 6,
      label: "Save smoke handoff",
      status: "operator_archive",
      summary: "Keep the launch smoke JSON handoff with duty notes, summary downloads, and route links."
    },
    {
      key: "open_launch_mainline",
      order: 7,
      label: "Open Launch Mainline",
      status: "operator_open",
      route: result.nextCommands?.launchMainline || null,
      summary: "Open the scoped Launch Mainline lane after smoke completes."
    },
    {
      key: "record_launch_mainline_evidence",
      order: 8,
      label: "Record Launch Mainline evidence",
      status: "operator_execute",
      endpoint: result.evidenceActionPlan?.endpoint || null,
      bearerTokenEnv: result.evidenceReadiness?.tokenEnv || DEVELOPER_BEARER_TOKEN_ENV,
      evidenceOperations,
      summary: "Record evidence receipts in the order shown by evidenceActionPlan.items."
    },
    {
      key: "verify_receipt_visibility",
      order: 9,
      label: "Verify receipt visibility",
      status: "operator_review",
      downloads: result.nextCommands?.receiptVisibilitySummaries || null,
      summary: "Verify Launch Review and Launch Smoke receipt-visibility summaries after evidence is recorded."
    }
  ];
}

function buildStagingResultBackfillSummary(result) {
  const productCode = result.summary?.productCode || "";
  const baseUrl = result.summary?.baseUrl || "";
  const developerOps = baseUrl
    ? buildRoute(baseUrl, "/developer/ops", {
      productCode,
      source: "staging-rehearsal",
      handoff: "first-wave"
    })
    : null;
  return {
    status: "awaiting_staging_execution",
    willModifyData: false,
    requiredResultKeys: [
      "route_map_gate_result",
      "backup_restore_drill_result",
      "live_write_smoke_result",
      "launch_smoke_handoff",
      "launch_mainline_evidence_receipts",
      "receipt_visibility_review"
    ],
    destinations: {
      launchMainline: result.nextCommands?.launchMainline || null,
      developerOps
    },
    evidenceEndpoint: result.evidenceActionPlan?.endpoint || null,
    receiptVisibilityDownloads: result.nextCommands?.receiptVisibilitySummaries || null,
    operatorNote: "Do not paste passwords or bearer tokens into the result summary; record pass/fail status, receipt IDs, artifact paths, and redacted handoff file names only."
  };
}

function fileOutputStatus(file) {
  if (!file) {
    return "not_requested";
  }
  return file.written ? "written" : "pending_write";
}

function isFilledCloseoutField(field) {
  if (!field || field.status === "pending_operator_entry") {
    return false;
  }
  if (field.value === null || field.value === undefined) {
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

function buildReceiptVisibilityTemplate() {
  return Object.fromEntries(
    RECEIPT_VISIBILITY_KEYS.map((key) => [
      key,
      {
        status: "pending_operator_entry",
        value: null,
        expectedValue: "visible",
        operatorNote: "Set value to visible only after this lane shows the latest staging evidence receipts."
      }
    ])
  );
}

function buildProductionSignoffInputTemplate(signoff = {}) {
  return {
    decision: null,
    requiredDecision: signoff.requiredDecision || null,
    conditions: (signoff.conditions || []).map((condition) => ({
      key: condition.key,
      status: "pending_operator_entry",
      value: null,
      expectedEvidence: condition.evidence || null,
      operatorNote: "Backfill a redacted pass/confirmed result after the full test window and sign-off review."
    }))
  };
}

function buildCloseoutBackfillGuide(result) {
  const closeout = result.stagingAcceptanceCloseout || {};
  const orderedBackfillKeys = (closeout.acceptanceChecks || [])
    .map((item) => item.key)
    .filter(Boolean);
  const productionSignoffKeys = (closeout.productionSignoffConditions?.conditions || [])
    .map((item) => item.key)
    .filter(Boolean);
  return {
    status: "awaiting_staging_results",
    willModifyData: false,
    closeoutInputReload: {
      option: "--closeout-input-file",
      command: "npm.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout.json>",
      purpose: "Reload the redacted closeout input after staging results are backfilled."
    },
    orderedBackfillKeys,
    receiptVisibilityKeys: RECEIPT_VISIBILITY_KEYS,
    productionSignoffKeys,
    fullTestWindow: {
      command: closeout.fullTestWindowEntry?.command || "npm.cmd test",
      requiredDecision: closeout.fullTestWindowEntry?.triggerDecision || "ready-for-full-test-window",
      requiredCloseoutKeys: closeout.fullTestWindowEntry?.requiredCloseoutKeys || orderedBackfillKeys
    },
    productionSignoff: {
      requiredDecision: closeout.productionSignoffConditions?.requiredDecision || "ready-for-production-signoff",
      requiredSignoffKeys: productionSignoffKeys,
      requiredReceiptVisibilityKeys: RECEIPT_VISIBILITY_KEYS
    },
    nextAction: "Backfill the generated closeout JSON, reload it with --closeout-input-file, then enter the full test window only after the readiness gaps clear."
  };
}

function buildFullTestWindowReadiness(result) {
  const closeout = result.stagingAcceptanceCloseout || {};
  const closeoutInput = result.closeoutInput || null;
  const command = closeout.fullTestWindowEntry?.command || "npm.cmd test";
  const missingCloseoutKeys = closeoutInput?.missingKeys
    || (closeout.acceptanceChecks || []).map((item) => item.key).filter(Boolean);
  const canRun = closeoutInput?.readyForFullTestWindow === true;
  return {
    status: canRun ? "ready" : "blocked",
    canRun,
    command,
    willRunFullSuite: closeout.fullTestWindowEntry?.willRunFullSuite !== false,
    willModifyData: false,
    requiredDecision: closeout.fullTestWindowEntry?.triggerDecision || "ready-for-full-test-window",
    closeoutInputStatus: closeoutInput?.status || "missing",
    missingCloseoutKeys,
    reloadCommand: result.closeoutBackfillGuide?.closeoutInputReload?.command || "npm.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout.json>",
    nextAction: canRun
      ? `Run ${command} in the reserved full test window, then backfill productionSignoff.`
      : `Backfill closeout input and reload it before running ${command}.`
  };
}

function buildProductionSignoffReadiness(result) {
  const closeout = result.stagingAcceptanceCloseout || {};
  const closeoutInput = result.closeoutInput || null;
  const requiredSignoffKeys = (closeout.productionSignoffConditions?.conditions || [])
    .map((item) => item.key)
    .filter(Boolean);
  const canSignoff = closeoutInput?.readyForProductionSignoff === true;
  return {
    status: canSignoff ? "ready" : "blocked",
    canSignoff,
    requiredDecision: closeout.productionSignoffConditions?.requiredDecision || "ready-for-production-signoff",
    productionDecision: closeoutInput?.productionDecision || null,
    closeoutInputStatus: closeoutInput?.status || "missing",
    readyForFullTestWindow: closeoutInput?.readyForFullTestWindow === true,
    missingSignoffKeys: closeoutInput?.signoffMissingKeys || requiredSignoffKeys,
    missingReceiptVisibilityKeys: closeoutInput?.missingReceiptVisibilityKeys || RECEIPT_VISIBILITY_KEYS,
    reloadCommand: result.closeoutBackfillGuide?.closeoutInputReload?.command || "npm.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout.json>",
    nextAction: canSignoff
      ? "Production sign-off is ready; keep the closeout artifact with release evidence before cutover."
      : "Backfill full-test evidence, production sign-off conditions, production decision, and receipt visibility before cutover."
  };
}

function buildLaunchDayWatchPlan(result) {
  const readiness = result.productionSignoffReadiness || buildProductionSignoffReadiness(result);
  const canStartCutoverWatch = readiness?.canSignoff === true;
  return {
    status: canStartCutoverWatch ? "ready" : "blocked",
    canStartCutoverWatch,
    willModifyData: false,
    watchStartGate: "production_signoff_readiness",
    requiredDecision: readiness?.requiredDecision || "ready-for-production-signoff",
    productionDecision: readiness?.productionDecision || null,
    closeoutInputStatus: readiness?.closeoutInputStatus || "missing",
    missingSignoffKeys: readiness?.missingSignoffKeys || [],
    missingReceiptVisibilityKeys: readiness?.missingReceiptVisibilityKeys || [],
    routes: {
      launchMainline: result.nextCommands?.launchMainline || null,
      developerOps: result.resultBackfillSummary?.destinations?.developerOps || null,
      launchReviewSummary: result.nextCommands?.receiptVisibilitySummaries?.launchReviewSummary || null,
      launchSmokeSummary: result.nextCommands?.receiptVisibilitySummaries?.launchSmokeSummary || null
    },
    watchWindows: [
      {
        key: "cutover_watch",
        status: canStartCutoverWatch ? "operator_watch" : "blocked_until_production_signoff",
        window: "T-30m through T+2h",
        summary: "Keep Launch Mainline, Developer Ops, Launch Review, and Launch Smoke receipt visibility open during cutover."
      },
      {
        key: "first_wave_stabilization",
        status: canStartCutoverWatch ? "operator_handoff" : "blocked_until_cutover_watch_started",
        window: "T+2h through T+24h",
        summary: "Hand off first-wave incidents, receipt mismatches, rollback signals, and stabilization notes into Developer Ops."
      }
    ],
    escalationTriggers: [
      "production_signoff_missing",
      "receipt_visibility_missing",
      "launch_mainline_action_failure",
      "developer_ops_receipt_mismatch",
      "backup_restore_or_rollback_unclear"
    ],
    nextAction: canStartCutoverWatch
      ? "Start launch-day watch with Launch Mainline, Developer Ops, Launch Review, and Launch Smoke receipt visibility open."
      : "Do not start launch-day watch until production sign-off readiness is ready."
  };
}

function buildStabilizationHandoffPlan(result) {
  const watchPlan = result.launchDayWatchPlan || buildLaunchDayWatchPlan(result);
  const canStartStabilizationHandoff = watchPlan?.canStartCutoverWatch === true;
  const requiredEvidenceKeys = [
    "launch_day_watch_summary",
    "first_wave_incident_log",
    "receipt_visibility_snapshot",
    "rollback_signal_review",
    "stabilization_owner_handoff"
  ];
  return {
    status: canStartStabilizationHandoff ? "ready" : "blocked",
    canStartStabilizationHandoff,
    willModifyData: false,
    sourceWatchStatus: watchPlan?.status || "not_available",
    requiredWatchWindows: (watchPlan?.watchWindows || []).map((item) => item.key).filter(Boolean),
    requiredEvidenceKeys,
    routes: {
      launchMainline: watchPlan?.routes?.launchMainline || result.nextCommands?.launchMainline || null,
      developerOps: watchPlan?.routes?.developerOps || result.resultBackfillSummary?.destinations?.developerOps || null,
      launchReviewSummary: watchPlan?.routes?.launchReviewSummary || result.nextCommands?.receiptVisibilitySummaries?.launchReviewSummary || null,
      launchSmokeSummary: watchPlan?.routes?.launchSmokeSummary || result.nextCommands?.receiptVisibilitySummaries?.launchSmokeSummary || null
    },
    handoffWindows: [
      {
        key: "stabilization_owner_handoff",
        label: "T+2h stabilization owner handoff",
        status: canStartStabilizationHandoff ? "operator_handoff" : "blocked_until_cutover_watch",
        summary: "Hand off launch-day watch summary, incidents, receipt snapshots, and rollback signals to the stabilization owner."
      },
      {
        key: "first_wave_closeout",
        label: "T+24h first-wave closeout",
        status: canStartStabilizationHandoff ? "operator_closeout" : "blocked_until_stabilization_owner_handoff",
        summary: "Close first-wave stabilization with unresolved incident list, customer impact notes, and next-duty owner."
      }
    ],
    escalationTriggers: [
      ...new Set([
        ...(watchPlan?.escalationTriggers || []),
        "unresolved_first_wave_incident",
        "missing_stabilization_owner"
      ])
    ],
    nextAction: canStartStabilizationHandoff
      ? "Hand off stabilization notes, first-wave incidents, receipt visibility snapshots, and rollback signals to the stabilization owner."
      : "Complete launch-day watch readiness before starting stabilization handoff."
  };
}

function buildStagingRunRecordTemplate(result) {
  const closeout = result.stagingAcceptanceCloseout || {};
  const ledger = closeout.artifactReceiptLedger || {};
  const archiveRoot = ledger.archiveRoot || path.posix.join(
    "artifacts",
    "staging",
    sanitizeArtifactPathSegment(result.summary?.productCode, "product"),
    sanitizeArtifactPathSegment(result.summary?.channel || "stable", "stable")
  );
  const readiness = {
    fullTestWindow: result.fullTestWindowReadiness?.status || "not_available",
    productionSignoff: result.productionSignoffReadiness?.status || "not_available",
    launchDayWatch: result.launchDayWatchPlan?.status || "not_available",
    stabilizationHandoff: result.stabilizationHandoffPlan?.status || "not_available"
  };
  const ledgerRecords = (ledger.rows || []).map((row) => ({
    key: row.checkKey,
    sourcePlan: "stagingAcceptanceCloseout",
    artifactKey: row.artifactKey || null,
    artifactPath: row.artifactPath || null,
    receiptOperations: row.receiptOperations || [],
    operatorNote: row.operatorNote || null
  }));
  const extraRecords = [
    {
      key: "launch_day_watch_summary",
      sourcePlan: "launchDayWatchPlan",
      artifactKey: "launch_day_watch_summary",
      artifactPath: path.posix.join(archiveRoot, "launch-day-watch-summary.md"),
      receiptOperations: ["record_cutover_walkthrough", "record_launch_day_readiness_review"],
      operatorNote: "Record cutover watch start/end time, owner, route checks, and any operator decisions."
    },
    {
      key: "first_wave_incident_log",
      sourcePlan: "launchDayWatchPlan",
      artifactKey: "first_wave_incident_log",
      artifactPath: path.posix.join(archiveRoot, "first-wave-incident-log.md"),
      receiptOperations: ["record_post_launch_ops_sweep"],
      operatorNote: "Record first-wave incidents, customer impact, mitigation, owner, and status."
    },
    {
      key: "receipt_visibility_snapshot",
      sourcePlan: "launchDayWatchPlan",
      artifactKey: "receipt_visibility_snapshot",
      artifactPath: path.posix.join(archiveRoot, "receipt-visibility-snapshot.txt"),
      receiptOperations: ["record_post_launch_ops_sweep"],
      operatorNote: "Save Launch Mainline, Developer Ops, Launch Review, and Launch Smoke receipt visibility snapshots."
    },
    {
      key: "rollback_signal_review",
      sourcePlan: "stabilizationHandoffPlan",
      artifactKey: "rollback_signal_review",
      artifactPath: path.posix.join(archiveRoot, "rollback-signal-review.md"),
      receiptOperations: ["record_rollback_walkthrough", "record_launch_stabilization_review"],
      operatorNote: "Record whether rollback signals were observed, dismissed, or escalated."
    },
    {
      key: "stabilization_owner_handoff",
      sourcePlan: "stabilizationHandoffPlan",
      artifactKey: "stabilization_owner_handoff",
      artifactPath: path.posix.join(archiveRoot, "stabilization-owner-handoff.md"),
      receiptOperations: ["record_launch_stabilization_review"],
      operatorNote: "Record stabilization owner, timestamp, unresolved items, and next-duty follow-up."
    }
  ];
  const records = [...ledgerRecords, ...extraRecords];
  return {
    status: readiness.stabilizationHandoff === "ready" ? "ready_for_stabilization_handoff" : "awaiting_staging_execution",
    willModifyData: false,
    archiveRoot,
    sourceReadiness: readiness,
    closeoutInputReloadCommand: result.closeoutBackfillGuide?.closeoutInputReload?.command || "npm.cmd run staging:rehearsal -- --closeout-input-file <filled-closeout.json>",
    requiredRecordKeys: records.map((item) => item.key).filter(Boolean),
    records,
    operatorNote: "Keep only redacted artifact paths, receipt IDs, route snapshots, incident summaries, and operator decisions in these records."
  };
}

function buildFilledCloseoutInputExample(result) {
  const closeout = result.stagingAcceptanceCloseout || {};
  const runTemplate = result.stagingRunRecordTemplate || buildStagingRunRecordTemplate(result);
  const archiveRoot = runTemplate.archiveRoot || "artifacts/staging/product/stable";
  const recordByKey = new Map((runTemplate.records || []).map((record) => [record.key, record]));
  const exampleStatus = "example_replace_before_use";
  const exampleValue = (key) => {
    const record = recordByKey.get(key) || {};
    if (key === "operator_go_no_go") {
      return "ready-for-full-test-window";
    }
    return {
      result: "pass",
      artifactPath: record.artifactPath || path.posix.join(archiveRoot, `${key}.txt`),
      receiptIds: (record.receiptOperations || []).map((operation) => `<${operation}-receipt-id>`)
    };
  };
  const receiptVisibility = Object.fromEntries(
    RECEIPT_VISIBILITY_KEYS.map((key) => [
      key,
      {
        status: exampleStatus,
        value: "visible",
        evidence: `<${key}-visibility-evidence>`
      }
    ])
  );
  return {
    mode: "staging-closeout-input-example",
    status: "example_only",
    exampleOnly: true,
    willModifyData: false,
    doNotSubmitWithoutReplacingPlaceholders: true,
    saveAs: path.posix.join(archiveRoot, "filled-closeout-input.example.json"),
    reloadCommand: `npm.cmd run staging:rehearsal -- --closeout-input-file ${path.posix.join(archiveRoot, "filled-closeout-input.json")}`,
    decision: "ready-for-full-test-window",
    acceptanceFields: (closeout.acceptanceChecks || []).map((check) => {
      const record = recordByKey.get(check.key) || {};
      return {
        key: check.key,
        status: exampleStatus,
        value: exampleValue(check.key),
        artifactPath: record.artifactPath || null,
        receiptOperations: record.receiptOperations || [],
        operatorNote: "Replace this example value with real redacted staging evidence before loading it."
      };
    }),
    receiptVisibility,
    productionSignoff: {
      decision: closeout.productionSignoffConditions?.requiredDecision || "ready-for-production-signoff",
      conditions: (closeout.productionSignoffConditions?.conditions || []).map((condition) => ({
        key: condition.key,
        status: exampleStatus,
        value: {
          result: "pass",
          evidence: `<${condition.key}-evidence>`
        },
        operatorNote: "Replace this example sign-off value with real full-test and sign-off evidence before loading it."
      })),
      receiptVisibility
    },
    operatorNote: "Copy this shape to filled-closeout-input.json and replace every placeholder/example value with redacted real staging results before using --closeout-input-file."
  };
}

function formatPowerShellArg(value) {
  const text = String(value ?? "");
  if (text === "") {
    return "''";
  }
  if (/[\s"'|&;<>()[\]{}]/.test(text)) {
    return `'${text.replace(/'/g, "''")}'`;
  }
  return text;
}

function buildStagingEnvironmentBinding(result, options = {}) {
  const runTemplate = result.stagingRunRecordTemplate || buildStagingRunRecordTemplate(result);
  const archiveRoot = runTemplate.archiveRoot || "artifacts/staging/product/stable";
  const handoffPath = result.handoffFile?.path || path.posix.join(archiveRoot, "staging-rehearsal-handoff.md");
  const closeoutPath = result.closeoutFile?.path || path.posix.join(archiveRoot, "staging-closeout-template.json");
  const filledCloseoutInputPath = path.posix.join(archiveRoot, "filled-closeout-input.json");
  const filledExamplePath = result.filledCloseoutInputExample?.saveAs || path.posix.join(archiveRoot, "filled-closeout-input.example.json");
  const environment = {
    baseUrl: result.summary?.baseUrl || options.baseUrl || null,
    productCode: result.summary?.productCode || options.productCode || null,
    channel: result.summary?.channel || options.channel || null,
    targetOs: result.summary?.targetOs || options.targetOs || null,
    storageProfile: result.summary?.storageProfile || options.storageProfile || null,
    targetEnvFile: options.targetEnvFile || null,
    appBackupDir: options.appBackupDir || null,
    postgresBackupDir: options.postgresBackupDir || null
  };
  const commandParts = [
    "npm.cmd",
    "run",
    "staging:rehearsal",
    "--",
    "--json",
    "--base-url",
    environment.baseUrl,
    "--product-code",
    environment.productCode,
    "--channel",
    environment.channel,
    "--admin-username",
    options.adminUsername,
    "--admin-password",
    `$env:${ADMIN_PASSWORD_ENV}`,
    "--developer-username",
    options.developerUsername,
    "--developer-password",
    `$env:${DEVELOPER_PASSWORD_ENV}`,
    "--target-os",
    environment.targetOs,
    "--storage-profile",
    environment.storageProfile,
    "--target-env-file",
    environment.targetEnvFile,
    "--app-backup-dir",
    environment.appBackupDir,
    ...(environment.postgresBackupDir
      ? ["--postgres-backup-dir", environment.postgresBackupDir]
      : []),
    "--handoff-file",
    handoffPath,
    "--closeout-file",
    closeoutPath
  ].filter((part) => part !== null && part !== undefined && String(part) !== "");
  return {
    status: "ready_for_real_staging_binding",
    willModifyData: false,
    environment,
    credentialEnv: {
      adminPassword: ADMIN_PASSWORD_ENV,
      developerPassword: DEVELOPER_PASSWORD_ENV,
      developerBearerToken: DEVELOPER_BEARER_TOKEN_ENV
    },
    recommendedOutputFiles: [
      {
        key: "handoff_file",
        path: handoffPath,
        status: result.handoffFile ? fileOutputStatus(result.handoffFile) : "recommended_default"
      },
      {
        key: "closeout_file",
        path: closeoutPath,
        status: result.closeoutFile ? fileOutputStatus(result.closeoutFile) : "recommended_default"
      },
      {
        key: "filled_closeout_input",
        path: filledCloseoutInputPath,
        status: "operator_create"
      },
      {
        key: "filled_closeout_input_example",
        path: filledExamplePath,
        status: "example_only"
      },
      {
        key: "artifact_archive_root",
        path: archiveRoot,
        status: "operator_archive"
      }
    ],
    dryRunCommand: commandParts.map(formatPowerShellArg).join(" "),
    nextAction: "Verify these real staging values, generate handoff and closeout files under the artifact archive root, then run this dry-run command before live-write smoke.",
    operatorNote: "This binding is safe to store: it references password and bearer-token environment variable names only, not raw secret values."
  };
}

function buildStagingExecutionRunbook(result) {
  const binding = result.stagingEnvironmentBinding || null;
  const closeout = result.stagingAcceptanceCloseout || {};
  const ledger = closeout.artifactReceiptLedger || {};
  const ledgerRowsByKey = new Map((ledger.rows || []).map((row) => [row.checkKey, row]));
  const outputFileByKey = new Map((binding?.recommendedOutputFiles || []).map((item) => [item.key, item]));
  const archiveRoot = outputFileByKey.get("artifact_archive_root")?.path
    || ledger.archiveRoot
    || result.stagingRunRecordTemplate?.archiveRoot
    || "artifacts/staging/product/stable";
  const filledCloseoutInputPath = outputFileByKey.get("filled_closeout_input")?.path
    || path.posix.join(archiveRoot, "filled-closeout-input.json");
  const filledExample = result.filledCloseoutInputExample || buildFilledCloseoutInputExample(result);
  const sourceStepByCloseoutKey = {
    route_map_gate_result: "run_route_map_gate",
    backup_restore_drill_result: "run_backup_restore_drill",
    live_write_smoke_result: "run_live_write_smoke",
    launch_smoke_handoff: "archive_launch_smoke_handoff",
    launch_mainline_evidence_receipts: "record_launch_mainline_evidence",
    receipt_visibility_review: "verify_receipt_visibility",
    operator_go_no_go: "backfill_filled_closeout_input"
  };
  const commandSequence = [
    {
      key: "prepare_secret_env",
      status: "operator_prepare",
      willModifyData: false,
      env: [
        binding?.credentialEnv?.adminPassword || ADMIN_PASSWORD_ENV,
        binding?.credentialEnv?.developerPassword || DEVELOPER_PASSWORD_ENV,
        binding?.credentialEnv?.developerBearerToken || DEVELOPER_BEARER_TOKEN_ENV
      ],
      summary: "Set smoke password env vars and developer bearer token before copying generated commands."
    },
    {
      key: "generate_rehearsal_outputs",
      status: "operator_execute",
      willModifyData: false,
      command: binding?.dryRunCommand || null,
      outputs: ["handoff_file", "closeout_file"],
      summary: "Generate the redacted handoff and closeout template from the real staging binding."
    },
    {
      key: "run_route_map_gate",
      status: "operator_execute",
      willModifyData: false,
      command: result.nextCommands?.launchRouteMapGate?.command || null,
      closeoutKey: "route_map_gate_result",
      artifactPath: ledgerRowsByKey.get("route_map_gate_result")?.artifactPath || null,
      summary: "Run targeted route/download visibility tests before staging writes."
    },
    {
      key: "run_backup_restore_drill",
      status: "operator_execute",
      willModifyData: false,
      commandKeys: Object.keys(result.nextCommands?.recovery || {}),
      closeoutKey: "backup_restore_drill_result",
      artifactPath: ledgerRowsByKey.get("backup_restore_drill_result")?.artifactPath || null,
      summary: "Run backup, restore dry-run, and healthcheck commands on a separate restore target."
    },
    {
      key: "approve_live_write_smoke",
      status: "operator_confirm",
      willModifyData: false,
      summary: "Confirm launch duty accepts staging writes before running launch:smoke:staging."
    },
    {
      key: "run_live_write_smoke",
      status: "operator_execute",
      willModifyData: true,
      command: result.nextCommands?.launchSmoke || null,
      closeoutKey: "live_write_smoke_result",
      artifactPath: ledgerRowsByKey.get("live_write_smoke_result")?.artifactPath || null,
      summary: "Run the HTTPS staging smoke command after approval and archive the redacted output."
    },
    {
      key: "archive_launch_smoke_handoff",
      status: "operator_archive",
      willModifyData: false,
      closeoutKey: "launch_smoke_handoff",
      artifactPath: ledgerRowsByKey.get("launch_smoke_handoff")?.artifactPath || null,
      summary: "Save the Launch Smoke handoff consumed by Launch Review, Developer Ops, and Launch Mainline."
    },
    {
      key: "record_launch_mainline_evidence",
      status: "operator_execute",
      willModifyData: true,
      endpoint: result.evidenceActionPlan?.endpoint || null,
      bearerTokenEnv: result.evidenceReadiness?.tokenEnv || DEVELOPER_BEARER_TOKEN_ENV,
      closeoutKey: "launch_mainline_evidence_receipts",
      artifactPath: ledgerRowsByKey.get("launch_mainline_evidence_receipts")?.artifactPath || null,
      summary: "Record Launch Mainline evidence receipts and attach receipt IDs to closeout."
    },
    {
      key: "verify_receipt_visibility",
      status: "operator_review",
      willModifyData: false,
      downloads: result.nextCommands?.receiptVisibilitySummaries || null,
      closeoutKey: "receipt_visibility_review",
      artifactPath: ledgerRowsByKey.get("receipt_visibility_review")?.artifactPath || null,
      summary: "Verify Launch Mainline, Launch Review, Launch Smoke, and Developer Ops receipt visibility."
    },
    {
      key: "backfill_filled_closeout_input",
      status: "operator_backfill",
      willModifyData: false,
      closeoutInputPath: filledCloseoutInputPath,
      examplePath: outputFileByKey.get("filled_closeout_input_example")?.path || filledExample.saveAs || null,
      closeoutKey: "operator_go_no_go",
      artifactPath: ledgerRowsByKey.get("operator_go_no_go")?.artifactPath || null,
      summary: "Copy the example closeout input, replace placeholders with redacted evidence, and record go/no-go."
    },
    {
      key: "reload_closeout_input",
      status: "operator_execute",
      willModifyData: false,
      command: filledExample.reloadCommand || null,
      summary: "Reload the filled closeout input and confirm readiness gaps narrow before the full test window."
    }
  ];
  return {
    status: binding?.status === "ready_for_real_staging_binding"
      ? "ready_for_real_staging_dry_run"
      : "blocked_until_environment_binding",
    willModifyData: false,
    containsLiveWriteStep: true,
    liveWriteRequiresApproval: true,
    sourceBindingStatus: binding?.status || null,
    artifactArchiveRoot: archiveRoot,
    outputFiles: binding?.recommendedOutputFiles || [],
    commandSequence,
    closeoutBackfillTargets: (closeout.acceptanceChecks || []).map((check) => {
      const row = ledgerRowsByKey.get(check.key) || {};
      return {
        key: check.key,
        sourceStep: sourceStepByCloseoutKey[check.key] || "operator_backfill",
        artifactPath: row.artifactPath || null,
        receiptOperations: row.receiptOperations || [],
        expectedEvidence: check.expectedEvidence || null,
        operatorNote: row.operatorNote || null
      };
    }),
    nextAction: "Run the command sequence through receipt visibility review, then backfill and reload the filled closeout input before the full test window."
  };
}

function buildFinalRehearsalPacket(result) {
  const closeout = result.stagingAcceptanceCloseout || {};
  const runTemplate = result.stagingRunRecordTemplate || buildStagingRunRecordTemplate(result);
  const filledExample = result.filledCloseoutInputExample || buildFilledCloseoutInputExample({
    ...result,
    stagingRunRecordTemplate: runTemplate
  });
  const archiveRoot = runTemplate.archiveRoot || "artifacts/staging/product/stable";
  const filledCloseoutInputPath = path.posix.join(archiveRoot, "filled-closeout-input.json");
  const sourceReadiness = runTemplate.sourceReadiness || {
    fullTestWindow: result.fullTestWindowReadiness?.status || "not_available",
    productionSignoff: result.productionSignoffReadiness?.status || "not_available",
    launchDayWatch: result.launchDayWatchPlan?.status || "not_available",
    stabilizationHandoff: result.stabilizationHandoffPlan?.status || "not_available"
  };
  const readyForLaunchDayWatch = sourceReadiness.fullTestWindow === "ready"
    && sourceReadiness.productionSignoff === "ready"
    && sourceReadiness.launchDayWatch === "ready"
    && sourceReadiness.stabilizationHandoff === "ready";
  const orderedSteps = [
    {
      key: "generate_rehearsal_outputs",
      status: "operator_generate",
      summary: "Generate or archive the Markdown handoff, closeout template, filled closeout input copy, and staging artifact record paths."
    },
    {
      key: "run_route_map_gate",
      status: "operator_execute",
      command: result.nextCommands?.launchRouteMapGate?.command || null,
      summary: "Run the targeted Launch Mainline / Launch Smoke / Developer Ops route-map gate before live writes."
    },
    {
      key: "run_backup_restore_drill",
      status: "operator_execute",
      commandKeys: Object.keys(result.nextCommands?.recovery || {}),
      summary: "Run backup and restore drill commands on a separate restore target."
    },
    {
      key: "run_live_write_smoke",
      status: "operator_execute",
      command: result.nextCommands?.launchSmoke || null,
      summary: "Run the HTTPS live-write staging smoke only after operator approval."
    },
    {
      key: "record_launch_mainline_evidence",
      status: "operator_execute",
      endpoint: result.evidenceActionPlan?.endpoint || null,
      summary: "Record Launch Mainline evidence receipts and attach redacted receipt IDs."
    },
    {
      key: "backfill_filled_closeout_input",
      status: "operator_backfill",
      path: filledCloseoutInputPath,
      summary: "Copy the example to the real filled closeout input path and replace every placeholder with redacted staging evidence."
    },
    {
      key: "reload_closeout_input",
      status: "operator_execute",
      command: filledExample.reloadCommand || null,
      summary: "Reload the filled closeout input and verify readiness gaps narrow before the full test window."
    },
    {
      key: "run_full_test_window",
      status: "operator_execute",
      command: closeout.fullTestWindowEntry?.command || "npm.cmd test",
      summary: "Run the full repository test suite in the reserved test window after closeout reload."
    },
    {
      key: "production_signoff_review",
      status: "operator_review",
      requiredDecision: closeout.productionSignoffConditions?.requiredDecision || null,
      summary: "Review production sign-off evidence and receipt visibility before cutover."
    },
    {
      key: "launch_day_watch",
      status: "operator_watch",
      summary: "Start launch-day watch with Launch Mainline, Developer Ops, Launch Review, and Launch Smoke routes open."
    },
    {
      key: "stabilization_handoff",
      status: "operator_handoff",
      summary: "Hand off stabilization records, incidents, receipt snapshots, and rollback signals."
    }
  ];
  return {
    status: readyForLaunchDayWatch ? "ready_for_launch_day_watch" : "ready_for_operator_rehearsal",
    willModifyData: false,
    environmentBindingStatus: result.stagingEnvironmentBinding?.status || null,
    executionRunbookStatus: result.stagingExecutionRunbook?.status || null,
    archiveRoot,
    sourceReadiness,
    commands: {
      stagingRehearsalDryRun: result.stagingEnvironmentBinding?.dryRunCommand || null,
      routeMapGate: result.nextCommands?.launchRouteMapGate?.command || null,
      liveWriteSmoke: result.nextCommands?.launchSmoke || null,
      closeoutReload: filledExample.reloadCommand || null,
      fullTestWindow: closeout.fullTestWindowEntry?.command || "npm.cmd test"
    },
    localFiles: [
      {
        key: "handoff_file",
        path: result.handoffFile?.path || null,
        status: fileOutputStatus(result.handoffFile)
      },
      {
        key: "closeout_file",
        path: result.closeoutFile?.path || null,
        status: fileOutputStatus(result.closeoutFile)
      },
      {
        key: "filled_closeout_input",
        path: filledCloseoutInputPath,
        status: "operator_copy_from_example"
      },
      {
        key: "filled_closeout_input_example",
        path: filledExample.saveAs || null,
        status: "example_only"
      },
      {
        key: "artifact_archive_root",
        path: archiveRoot,
        status: "operator_archive"
      }
    ],
    orderedSteps,
    nextAction: readyForLaunchDayWatch
      ? "Start launch-day watch and stabilization handoff with the packet artifacts open."
      : "Generate handoff and closeout files, run the ordered rehearsal steps, then reload the filled closeout input before the full test window."
  };
}

function buildCloseoutInput(closeoutInputFile, closeout = {}) {
  if (!closeoutInputFile) {
    return null;
  }
  const resolvedPath = path.resolve(repoRoot, closeoutInputFile);
  const payload = JSON.parse(readFileSync(resolvedPath, "utf8"));
  if (payload.exampleOnly === true || payload.mode === "staging-closeout-input-example") {
    throw new Error("Refusing to load example closeout input; copy it to a real filled closeout input file and replace placeholders first.");
  }
  const acceptanceFields = Array.isArray(payload.acceptanceFields) ? payload.acceptanceFields : [];
  const fieldsByKey = new Map(
    acceptanceFields
      .filter((field) => field && field.key)
      .map((field) => [field.key, field])
  );
  const requiredKeys = (closeout.acceptanceChecks || []).map((item) => item.key).filter(Boolean);
  const filledKeys = requiredKeys.filter((key) => isFilledCloseoutField(fieldsByKey.get(key)));
  const missingKeys = requiredKeys.filter((key) => !filledKeys.includes(key));
  const goNoGoField = fieldsByKey.get("operator_go_no_go");
  const decision = typeof goNoGoField?.value === "string"
    ? goNoGoField.value
    : payload.decision || closeout.decision || null;
  const signoffConditions = Array.isArray(payload.productionSignoff?.conditions)
    ? payload.productionSignoff.conditions
    : [];
  const signoffFieldsByKey = new Map(
    signoffConditions
      .filter((field) => field && field.key)
      .map((field) => [field.key, field])
  );
  const requiredSignoffKeys = (closeout.productionSignoffConditions?.conditions || [])
    .map((item) => item.key)
    .filter(Boolean);
  const signoffFilledKeys = requiredSignoffKeys.filter((key) => isFilledCloseoutField(signoffFieldsByKey.get(key)));
  const signoffMissingKeys = requiredSignoffKeys.filter((key) => !signoffFilledKeys.includes(key));
  const productionDecision = payload.productionSignoff?.decision || null;
  const receiptVisibility = payload.receiptVisibility || payload.productionSignoff?.receiptVisibility || {};
  const receiptVisibilityChecks = Object.fromEntries(
    RECEIPT_VISIBILITY_KEYS.map((key) => [
      key,
      {
        status: isReceiptVisibilityVisible(receiptVisibility[key]) ? "visible" : "missing"
      }
    ])
  );
  const missingReceiptVisibilityKeys = RECEIPT_VISIBILITY_KEYS.filter(
    (key) => receiptVisibilityChecks[key].status !== "visible"
  );
  const readyForReceiptVisibility = missingReceiptVisibilityKeys.length === 0;
  const readyForFullTestWindow = missingKeys.length === 0 && decision === "ready-for-full-test-window";
  const readyForProductionSignoff = readyForFullTestWindow
    && signoffMissingKeys.length === 0
    && productionDecision === closeout.productionSignoffConditions?.requiredDecision
    && readyForReceiptVisibility;
  return {
    status: "loaded",
    path: resolvedPath,
    sourceMode: payload.mode || null,
    willModifyData: false,
    decision,
    fieldCount: acceptanceFields.length,
    requiredKeys,
    filledKeys,
    missingKeys,
    requiredSignoffKeys,
    signoffFilledKeys,
    signoffMissingKeys,
    productionDecision,
    receiptVisibilityStatus: readyForReceiptVisibility ? "visible" : "missing",
    receiptVisibilityChecks,
    missingReceiptVisibilityKeys,
    readyForFullTestWindow,
    readyForReceiptVisibility,
    readyForProductionSignoff,
    nextAction: missingKeys.length === 0
      ? "Closeout input is backfilled; confirm operator_go_no_go before entering the full test window."
      : "Backfill missingKeys in the closeout input before entering the full test window."
  };
}

function buildOperatorReadinessGaps(result, { closeout = {}, outputFiles = [] } = {}) {
  const outputStatus = new Map(outputFiles.map((item) => [item.key, item.status]));
  const closeoutInput = result.closeoutInput || null;
  const missingCloseoutKeys = closeoutInput?.missingKeys
    || (closeout.acceptanceChecks || []).map((item) => item.key).filter(Boolean);
  const hasEvidenceReceipts = Array.isArray(closeoutInput?.filledKeys)
    && closeoutInput.filledKeys.includes("launch_mainline_evidence_receipts");
  const gaps = [];
  if (outputStatus.get("handoff_file") === "not_requested") {
    gaps.push({
      key: "handoff_file_not_requested",
      severity: "warning",
      stepKey: "review_generated_bundle",
      summary: "No Markdown handoff file was requested for launch duty.",
      nextAction: "Re-run staging:rehearsal with --handoff-file before live-write smoke."
    });
  }
  if (outputStatus.get("closeout_file") === "not_requested") {
    gaps.push({
      key: "closeout_file_not_requested",
      severity: "warning",
      stepKey: "review_generated_bundle",
      summary: "No JSON closeout template was requested for operator backfill.",
      nextAction: "Re-run staging:rehearsal with --closeout-file before live-write smoke."
    });
  }
  if (result.evidenceReadiness?.checks?.developerBearerToken !== "present" && !hasEvidenceReceipts) {
    gaps.push({
      key: "developer_bearer_token_missing",
      severity: "blocker",
      stepKey: "record_launch_mainline_evidence",
      env: result.evidenceReadiness?.tokenEnv || DEVELOPER_BEARER_TOKEN_ENV,
      summary: "Launch Mainline evidence requests cannot run until the developer bearer token env var is set.",
      nextAction: `Set $env:${result.evidenceReadiness?.tokenEnv || DEVELOPER_BEARER_TOKEN_ENV} before copying evidence request snippets.`
    });
  }
  if (missingCloseoutKeys.length > 0 || closeoutInput?.readyForFullTestWindow !== true) {
    gaps.push({
      key: "closeout_backfill_pending",
      severity: "blocker",
      stepKey: "backfill_closeout_template",
      missingCloseoutKeys,
      summary: "Staging closeout is still waiting for redacted result values, artifact paths, receipt IDs, and operator_go_no_go.",
      nextAction: "Backfill every required closeout key before reserving the full test window."
    });
    gaps.push({
      key: "full_test_window_blocked",
      severity: "blocker",
      stepKey: "reserve_full_test_window",
      command: closeout.fullTestWindowEntry?.command || null,
      summary: "The full repository test window is blocked until closeout is backfilled.",
      nextAction: "Run the full test command only after operator_go_no_go is ready-for-full-test-window."
    });
  }
  const signoffConditionsReady = Array.isArray(closeoutInput?.signoffMissingKeys)
    && closeoutInput.signoffMissingKeys.length === 0;
  const productionDecisionReady = closeoutInput?.productionDecision === closeout.productionSignoffConditions?.requiredDecision;
  if (
    closeoutInput?.readyForFullTestWindow === true
    && signoffConditionsReady
    && productionDecisionReady
    && closeoutInput.readyForReceiptVisibility !== true
  ) {
    gaps.push({
      key: "receipt_visibility_not_confirmed",
      severity: "blocker",
      stepKey: "verify_receipt_visibility",
      missingReceiptVisibilityKeys: closeoutInput.missingReceiptVisibilityKeys || [],
      summary: "Production sign-off needs Launch Mainline, Launch Review, Launch Smoke, and Developer Ops receipt visibility confirmed.",
      nextAction: "Backfill receiptVisibility with visible statuses for every required lane before production sign-off review."
    });
  }
  if (closeoutInput?.readyForProductionSignoff !== true) {
    gaps.push({
      key: "production_signoff_blocked",
      severity: "blocker",
      stepKey: "production_signoff_review",
      requiredDecision: closeout.productionSignoffConditions?.requiredDecision || null,
      missingSignoffKeys: closeoutInput?.signoffMissingKeys || (closeout.productionSignoffConditions?.conditions || []).map((item) => item.key).filter(Boolean),
      missingReceiptVisibilityKeys: closeoutInput?.missingReceiptVisibilityKeys || RECEIPT_VISIBILITY_KEYS,
      summary: "Production sign-off is blocked until the full test window passes and sign-off evidence is attached.",
      nextAction: "Do not move to production cutover before production sign-off review is ready."
    });
  }
  return gaps;
}

function buildStagingOperatorExecutionPlan(result) {
  const closeout = result.stagingAcceptanceCloseout || {};
  const evidenceOperations = Array.isArray(result.evidenceActionPlan?.items)
    ? result.evidenceActionPlan.items.map((item) => item.operation).filter(Boolean)
    : [];
  const outputFiles = [
    {
      key: "handoff_file",
      label: "Staging rehearsal Markdown handoff",
      status: fileOutputStatus(result.handoffFile),
      path: result.handoffFile?.path || null,
      purpose: "Carry commands, routes, evidence requests, and operator notes into the live-write step."
    },
    {
      key: "closeout_file",
      label: "Staging closeout JSON template",
      status: fileOutputStatus(result.closeoutFile),
      path: result.closeoutFile?.path || null,
      purpose: "Backfill redacted result values, artifact paths, receipt IDs, and go/no-go decision."
    }
  ];
  const readinessGaps = buildOperatorReadinessGaps(result, { closeout, outputFiles });
  return {
    status: "ready_for_staging_execution",
    willModifyData: false,
    trigger: "no-write-rehearsal-gates-passed",
    outputFiles,
    readinessSummary: {
      status: readinessGaps.length ? "needs_operator_input" : "ready",
      gapCount: readinessGaps.length,
      canRunLiveWriteSmoke: false,
      canRunFullTestWindow: result.closeoutInput?.readyForFullTestWindow === true,
      canSignoffProduction: result.closeoutInput?.readyForProductionSignoff === true,
      nextAction: "Resolve readinessGaps in order before live-write smoke, full test window, or production sign-off."
    },
    readinessGaps,
    orderedSteps: [
      {
        key: "review_generated_bundle",
        order: 1,
        status: "operator_review",
        outputFileKeys: ["handoff_file", "closeout_file"],
        summary: "Review generated handoff and closeout template before touching staging data."
      },
      {
        key: "run_route_map_gate",
        order: 2,
        status: "operator_execute",
        command: result.nextCommands?.launchRouteMapGate?.command || null,
        dryRunCommand: result.nextCommands?.launchRouteMapGate?.dryRunCommand || null,
        closeoutKey: "route_map_gate_result",
        summary: "Run the repeatable Launch Mainline / Launch Smoke / Developer Ops route-map gate."
      },
      {
        key: "run_backup_restore_drill",
        order: 3,
        status: "operator_execute",
        commandKeys: Object.keys(result.nextCommands?.recovery || {}),
        closeoutKey: "backup_restore_drill_result",
        receiptOperations: ["record_recovery_drill", "record_backup_verification"],
        summary: "Run backup and restore drill on the intended restore target."
      },
      {
        key: "approve_and_run_live_write_smoke",
        order: 4,
        status: "operator_confirm_then_execute",
        command: result.nextCommands?.launchSmoke || null,
        closeoutKey: "live_write_smoke_result",
        receiptOperations: ["record_launch_rehearsal_run"],
        summary: "Confirm staging writes are approved, then run the live-write smoke command."
      },
      {
        key: "archive_launch_smoke_handoff",
        order: 5,
        status: "operator_archive",
        closeoutKey: "launch_smoke_handoff",
        summary: "Archive the redacted Launch Smoke handoff and generated test identifiers."
      },
      {
        key: "record_launch_mainline_evidence",
        order: 6,
        status: "operator_execute",
        endpoint: result.evidenceActionPlan?.endpoint || null,
        bearerTokenEnv: result.evidenceReadiness?.tokenEnv || DEVELOPER_BEARER_TOKEN_ENV,
        closeoutKey: "launch_mainline_evidence_receipts",
        evidenceOperations,
        summary: "Post Launch Mainline evidence actions and capture receipt IDs or handoff filenames."
      },
      {
        key: "verify_receipt_visibility",
        order: 7,
        status: "operator_review",
        downloads: result.nextCommands?.receiptVisibilitySummaries || null,
        closeoutKey: "receipt_visibility_review",
        summary: "Verify Launch Review and Launch Smoke visibility summaries show the recorded receipts."
      },
      {
        key: "backfill_closeout_template",
        order: 8,
        status: "operator_backfill",
        outputFileKey: "closeout_file",
        requiredCloseoutKeys: (closeout.acceptanceChecks || []).map((item) => item.key).filter(Boolean),
        summary: "Fill the closeout template with redacted statuses, artifact paths, receipt IDs, and operator_go_no_go."
      },
      {
        key: "reserve_full_test_window",
        order: 9,
        status: "operator_schedule",
        command: closeout.fullTestWindowEntry?.command || null,
        triggerDecision: closeout.fullTestWindowEntry?.triggerDecision || null,
        summary: "Reserve the full repository test window only after closeout is backfilled."
      },
      {
        key: "production_signoff_review",
        order: 10,
        status: "operator_review",
        requiredDecision: closeout.productionSignoffConditions?.requiredDecision || null,
        summary: "Attach production sign-off evidence before cutover."
      }
    ],
    requiredCloseoutKeys: (closeout.acceptanceChecks || []).map((item) => item.key).filter(Boolean),
    closeoutInput: result.closeoutInput || null,
    artifactArchiveRoot: closeout.artifactReceiptLedger?.archiveRoot || null,
    evidenceOperations,
    fullTestWindow: closeout.fullTestWindowEntry || null,
    productionSignoff: closeout.productionSignoffConditions || null,
    nextAction: "Run the ordered steps in sequence, then backfill closeout with redacted statuses, receipt IDs, and artifact paths before starting the full test window."
  };
}

function sanitizeArtifactPathSegment(value, fallback = "unknown") {
  const segment = String(value || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return segment || fallback;
}

function buildStagingArtifactReceiptLedger(result) {
  const productCode = sanitizeArtifactPathSegment(result.summary?.productCode, "product");
  const channel = sanitizeArtifactPathSegment(result.summary?.channel || "stable", "stable");
  const archiveRoot = path.posix.join("artifacts", "staging", productCode, channel);
  const evidenceOperations = Array.isArray(result.evidenceActionPlan?.items)
    ? result.evidenceActionPlan.items.map((item) => item.operation).filter(Boolean)
    : [];
  const row = ({
    checkKey,
    artifactKey,
    fileName,
    receiptOperations = [],
    closeoutStatus = "pending",
    operatorNote = "",
    allowedDecisions = null
  }) => ({
    checkKey,
    artifactKey,
    artifactPath: path.posix.join(archiveRoot, fileName),
    receiptOperations,
    closeoutStatus,
    operatorNote,
    ...(allowedDecisions ? { allowedDecisions } : {})
  });
  return {
    status: "awaiting_staging_artifacts",
    willModifyData: false,
    archiveRoot,
    columns: [
      "check_key",
      "artifact_key",
      "artifact_path",
      "receipt_operations",
      "closeout_status",
      "operator_note"
    ],
    rows: [
      row({
        checkKey: "route_map_gate_result",
        artifactKey: "route_map_gate_output",
        fileName: "route-map-gate-output.txt",
        operatorNote: "Attach the targeted gate output after secrets have been redacted."
      }),
      row({
        checkKey: "backup_restore_drill_result",
        artifactKey: "backup_restore_drill_log",
        fileName: "backup-restore-drill.txt",
        receiptOperations: ["record_recovery_drill", "record_backup_verification"],
        operatorNote: "Record backup, restore dry-run, and healthcheck artifact paths."
      }),
      row({
        checkKey: "live_write_smoke_result",
        artifactKey: "live_write_smoke_output",
        fileName: "live-write-smoke-output.json",
        receiptOperations: ["record_launch_rehearsal_run"],
        operatorNote: "Attach the live-write smoke output with generated test identifiers only."
      }),
      row({
        checkKey: "launch_smoke_handoff",
        artifactKey: "launch_smoke_handoff",
        fileName: "launch-smoke-handoff.json",
        receiptOperations: ["record_post_launch_ops_sweep"],
        operatorNote: "Save the Launch Smoke handoff used by Launch Review, Developer Ops, and Launch Mainline."
      }),
      row({
        checkKey: "launch_mainline_evidence_receipts",
        artifactKey: "launch_mainline_evidence_receipts",
        fileName: "launch-mainline-evidence-receipts.json",
        receiptOperations: evidenceOperations,
        operatorNote: "List the Launch Mainline receipt IDs or handoff file names for every evidence action."
      }),
      row({
        checkKey: "receipt_visibility_review",
        artifactKey: "receipt_visibility_review",
        fileName: "receipt-visibility-review.txt",
        receiptOperations: ["record_post_launch_ops_sweep"],
        operatorNote: "Record the Launch Review and Launch Smoke visibility summary review result."
      }),
      row({
        checkKey: "operator_go_no_go",
        artifactKey: "operator_go_no_go",
        fileName: "operator-go-no-go.md",
        allowedDecisions: ["ready-for-full-test-window", "hold", "rollback-follow-up"],
        operatorNote: "Record the final staging decision, operator, timestamp, and reason."
      })
    ],
    operatorNote: "Keep artifact paths and receipt identifiers here; do not paste passwords, bearer tokens, or raw secret-bearing logs."
  };
}

function buildFullTestWindowEntry(result, acceptanceChecks = [], artifactReceiptLedger = null) {
  return {
    status: "blocked_until_staging_closeout",
    command: "npm.cmd test",
    willRunFullSuite: true,
    willModifyData: false,
    triggerDecision: "ready-for-full-test-window",
    requiredCloseoutKeys: acceptanceChecks.map((item) => item.key).filter(Boolean),
    archiveRoot: artifactReceiptLedger?.archiveRoot || null,
    entryCriteria: [
      {
        key: "staging_closeout_completed",
        status: "operator_confirm",
        summary: "All staging acceptance closeout checks have redacted results."
      },
      {
        key: "artifact_receipt_ledger_filled",
        status: "operator_confirm",
        summary: "Every required artifact path and Launch Mainline receipt operation is recorded."
      },
      {
        key: "operator_go_no_go_ready",
        status: "operator_confirm",
        summary: "Operator decision is ready-for-full-test-window, not hold or rollback-follow-up."
      },
      {
        key: "test_window_reserved",
        status: "operator_confirm",
        summary: "A quiet test window is reserved for the full repository suite and follow-up fixes."
      }
    ],
    nextAction: "Do not run the full suite until staging closeout is backfilled and operator_go_no_go is ready-for-full-test-window."
  };
}

function buildProductionSignoffConditions(result) {
  return {
    status: "blocked_until_full_test_window",
    requiredDecision: "ready-for-production-signoff",
    willModifyData: false,
    conditions: [
      {
        key: "full_test_window_passed",
        status: "required",
        evidence: "Attach the full `npm.cmd test` output summary and failure count."
      },
      {
        key: "staging_artifacts_archived",
        status: "required",
        evidence: "Confirm the artifact/receipt ledger archive paths exist and contain redacted artifacts."
      },
      {
        key: "launch_mainline_receipts_visible",
        status: "required",
        evidence: "Confirm Launch Mainline, Launch Review, Launch Smoke, and Developer Ops show the latest receipts."
      },
      {
        key: "backup_restore_drill_passed",
        status: "required",
        evidence: "Confirm the backup and restore drill passed on the intended staging storage profile."
      },
      {
        key: "rollback_path_confirmed",
        status: "required",
        evidence: "Confirm rollback walkthrough and recovery handoff are current before production cutover."
      },
      {
        key: "operator_signoff_recorded",
        status: "required",
        evidence: "Record operator, timestamp, decision, and reason in the go/no-go artifact."
      }
    ],
    nextAction: "Only move to production cutover after every condition is attached to the staging closeout and the full test window has passed."
  };
}

function buildStagingAcceptanceCloseout(result) {
  const resultBackfill = result.resultBackfillSummary || null;
  const evidenceOperations = Array.isArray(result.evidenceActionPlan?.items)
    ? result.evidenceActionPlan.items.map((item) => item.operation).filter(Boolean)
    : [];
  const artifactReceiptLedger = buildStagingArtifactReceiptLedger(result);
  const acceptanceChecks = [
    {
      key: "route_map_gate_result",
      label: "Route-map and download-surface targeted gate",
      required: true,
      command: result.nextCommands?.launchRouteMapGate?.command || null,
      expectedEvidence: "Record the targeted gate exit status, pass count, and redacted output artifact path."
    },
    {
      key: "backup_restore_drill_result",
      label: "Backup and restore drill",
      required: true,
      commandKeys: result.environmentReadiness?.checks?.find((item) => item.key === "backup_restore_drill")?.commandKeys || [],
      expectedEvidence: "Record backup artifact path, restore dry-run result, and post-restore healthcheck result."
    },
    {
      key: "live_write_smoke_result",
      label: "Live-write staging smoke",
      required: true,
      command: result.nextCommands?.launchSmoke || null,
      expectedEvidence: "Record smoke exit status, created test project/account/card identifiers, and the redacted smoke output artifact path."
    },
    {
      key: "launch_smoke_handoff",
      label: "Launch smoke handoff archive",
      required: true,
      expectedEvidence: "Save the launch smoke handoff JSON or Markdown path with passwords and bearer tokens redacted."
    },
    {
      key: "launch_mainline_evidence_receipts",
      label: "Launch Mainline evidence receipts",
      required: true,
      endpoint: result.evidenceActionPlan?.endpoint || null,
      operations: evidenceOperations,
      expectedEvidence: "Record the Launch Mainline receipt IDs or handoff file names produced by each evidence action."
    },
    {
      key: "receipt_visibility_review",
      label: "Receipt visibility review",
      required: true,
      downloads: result.nextCommands?.receiptVisibilitySummaries || null,
      expectedEvidence: "Verify Launch Review and Launch Smoke receipt-visibility summaries show the recorded first-wave receipt."
    },
    {
      key: "operator_go_no_go",
      label: "Operator go/no-go decision",
      required: true,
      expectedEvidence: "Record ready-for-full-test-window, hold, or rollback-follow-up with the operator name and timestamp."
    }
  ];
  return {
    status: "awaiting_operator_closeout",
    willModifyData: false,
    decision: "pending_staging_results",
    requiredResultKeys: resultBackfill?.requiredResultKeys || [],
    evidenceOperations,
    acceptanceChecks,
    destinations: {
      launchMainline: resultBackfill?.destinations?.launchMainline || result.nextCommands?.launchMainline || null,
      developerOps: resultBackfill?.destinations?.developerOps || null,
      evidenceEndpoint: result.evidenceActionPlan?.endpoint || null,
      receiptVisibilityDownloads: result.nextCommands?.receiptVisibilitySummaries || null
    },
    nextAction: "Run the real staging steps, backfill the redacted result values, then schedule the full repository test window before production sign-off.",
    operatorNote: "Use redacted result values only: statuses, receipt IDs, artifact paths, handoff file names, and operator decisions. Do not paste passwords or bearer tokens.",
    artifactReceiptLedger,
    fullTestWindowEntry: buildFullTestWindowEntry(result, acceptanceChecks, artifactReceiptLedger),
    productionSignoffConditions: buildProductionSignoffConditions(result)
  };
}

function buildResult(options) {
  const staging = runJsonScript("staging-preflight.mjs", buildStagingPreflightArgs(options));
  const recovery = runJsonScript("recovery-preflight.mjs", buildRecoveryPreflightArgs(options));
  const gatesPassed = staging?.status === "pass" && recovery?.status === "pass";
  const status = gatesPassed ? "pass" : "fail";
  const phaseStatus = {
    staging: staging?.status === "pass" ? "pass" : "fail",
    recovery: recovery?.status === "pass" ? "pass" : "fail",
    liveSmoke: gatesPassed ? "next" : "blocked",
    launchMainline: gatesPassed ? "next" : "blocked",
    evidence: gatesPassed ? "next" : "blocked"
  };
  const phases = buildPhases(phaseStatus);
  const launchMainline = gatesPassed
    ? buildRoute(options.baseUrl, "/developer/launch-mainline", {
      productCode: options.productCode,
      channel: options.channel,
      source: "staging-rehearsal",
      handoff: "first-wave"
    })
    : null;
  const evidenceActionPlan = gatesPassed ? buildEvidenceActionPlan(options) : null;
  const receiptVisibilitySummaries = gatesPassed ? buildReceiptVisibilitySummaryDownloads(options) : null;
  const launchRouteMapGate = gatesPassed ? buildLaunchRouteMapGateCommand() : null;
  const environmentReadiness = gatesPassed
    ? buildStagingEnvironmentReadiness(options, { recovery, launchRouteMapGate })
    : null;

  const result = {
    status,
    mode: "staging-rehearsal",
    generatedAt: new Date().toISOString(),
    summary: {
      baseUrl: options.baseUrl,
      productCode: options.productCode,
      channel: options.channel,
      targetOs: options.targetOs,
      storageProfile: options.storageProfile,
      willModifyData: false
    },
    preflights: {
      staging,
      recovery
    },
    phases,
    nextCommands: {
      launchSmoke: gatesPassed ? staging.nextCommand?.powershell || null : null,
      recovery: gatesPassed ? recovery.nextCommands || null : null,
      launchRouteMapGate,
      launchMainline,
      receiptVisibilitySummaries
    },
    evidenceOrder: gatesPassed ? EVIDENCE_ORDER : [],
    evidenceActionPlan,
    evidenceReadiness: gatesPassed ? buildEvidenceReadiness(options, evidenceActionPlan) : null,
    environmentReadiness,
    ...(options.handoffFile
      ? {
        handoffFile: {
          path: path.resolve(repoRoot, options.handoffFile),
          written: false
        }
      }
      : {}),
    ...(options.closeoutFile
      ? {
        closeoutFile: {
          path: path.resolve(repoRoot, options.closeoutFile),
          written: false
        }
      }
      : {}),
    ...(status === "fail"
      ? {
        failedPhase: firstFailedPhase(phases),
        error: {
          message: "A no-write rehearsal gate failed; live-write staging smoke remains blocked."
        }
      }
      : {})
  };
  const operatorChecklist = gatesPassed ? buildStagingOperatorChecklist(result) : [];
  const resultWithBackfill = {
    ...result,
    operatorChecklist,
    resultBackfillSummary: gatesPassed ? buildStagingResultBackfillSummary(result) : null
  };
  const resultWithCloseout = {
    ...resultWithBackfill,
    stagingAcceptanceCloseout: gatesPassed ? buildStagingAcceptanceCloseout(resultWithBackfill) : null
  };
  const closeoutInput = gatesPassed ? buildCloseoutInput(options.closeoutInputFile, resultWithCloseout.stagingAcceptanceCloseout) : null;
  const resultWithCloseoutInput = {
    ...resultWithCloseout,
    closeoutInput
  };
  const resultWithCloseoutBackfillGuide = {
    ...resultWithCloseoutInput,
    closeoutBackfillGuide: gatesPassed ? buildCloseoutBackfillGuide(resultWithCloseoutInput) : null
  };
  const resultWithFullTestWindowReadiness = {
    ...resultWithCloseoutBackfillGuide,
    fullTestWindowReadiness: gatesPassed ? buildFullTestWindowReadiness(resultWithCloseoutBackfillGuide) : null
  };
  const resultWithProductionSignoffReadiness = {
    ...resultWithFullTestWindowReadiness,
    productionSignoffReadiness: gatesPassed ? buildProductionSignoffReadiness(resultWithFullTestWindowReadiness) : null
  };
  const resultWithLaunchDayWatchPlan = {
    ...resultWithProductionSignoffReadiness,
    launchDayWatchPlan: gatesPassed ? buildLaunchDayWatchPlan(resultWithProductionSignoffReadiness) : null
  };
  const resultWithStabilizationHandoffPlan = {
    ...resultWithLaunchDayWatchPlan,
    stabilizationHandoffPlan: gatesPassed ? buildStabilizationHandoffPlan(resultWithLaunchDayWatchPlan) : null
  };
  const resultWithStagingRunRecordTemplate = {
    ...resultWithStabilizationHandoffPlan,
    stagingRunRecordTemplate: gatesPassed ? buildStagingRunRecordTemplate(resultWithStabilizationHandoffPlan) : null
  };
  const resultWithFilledCloseoutInputExample = {
    ...resultWithStagingRunRecordTemplate,
    filledCloseoutInputExample: gatesPassed ? buildFilledCloseoutInputExample(resultWithStagingRunRecordTemplate) : null
  };
  const resultWithStagingEnvironmentBinding = {
    ...resultWithFilledCloseoutInputExample,
    stagingEnvironmentBinding: gatesPassed ? buildStagingEnvironmentBinding(resultWithFilledCloseoutInputExample, options) : null
  };
  const resultWithStagingExecutionRunbook = {
    ...resultWithStagingEnvironmentBinding,
    stagingExecutionRunbook: gatesPassed ? buildStagingExecutionRunbook(resultWithStagingEnvironmentBinding) : null
  };
  const resultWithFinalRehearsalPacket = {
    ...resultWithStagingExecutionRunbook,
    finalRehearsalPacket: gatesPassed ? buildFinalRehearsalPacket(resultWithStagingExecutionRunbook) : null
  };
  return {
    ...resultWithFinalRehearsalPacket,
    operatorExecutionPlan: gatesPassed ? buildStagingOperatorExecutionPlan(resultWithFinalRehearsalPacket) : null
  };
}

function renderCommandList(commands) {
  if (!commands) {
    return "- Not available";
  }
  if (typeof commands === "string") {
    return `\`\`\`powershell\n${commands}\n\`\`\``;
  }
  return Object.entries(commands)
    .map(([key, value]) => `- ${key}: \`${value}\``)
    .join("\n");
}

function renderEvidenceActions(plan) {
  if (!plan) {
    return "- Not available";
  }
  return plan.items
    .map((item) => [
      `${item.order}. ${item.label} - \`${item.operation}\``,
      "",
      "```powershell",
      item.request.powershell,
      "```"
    ].join("\n"))
    .join("\n\n");
}

function renderEvidenceReadiness(readiness) {
  if (!readiness) {
    return "- Not available";
  }
  return [
    `- Ready to execute evidence requests: ${readiness.readyToExecute ? "yes" : "no"}`,
    `- Target lane: ${readiness.targetLane.productCode} / ${readiness.targetLane.channel}`,
    `- Evidence endpoint: ${readiness.endpoint}`,
    `- Developer bearer token env: ${readiness.tokenEnv}`,
    `- Developer bearer token status: ${readiness.checks.developerBearerToken}`,
    `- Next action: ${readiness.nextAction}`
  ].join("\n");
}

function renderReceiptVisibilitySummaries(downloads) {
  if (!downloads) {
    return "- Not available";
  }
  return [
    `- Launch Review summary: \`${downloads.launchReviewSummary}\``,
    `- Launch Smoke Kit summary: \`${downloads.launchSmokeSummary}\``
  ].join("\n");
}

function renderLaunchRouteMapGate(command) {
  if (!command) {
    return "- Not available";
  }
  return [
    `- Command: \`${command.command}\``,
    `- Dry run: \`${command.dryRunCommand}\``,
    `- Writes data: ${command.willModifyData ? "yes" : "no"}`,
    `- Runs full suite: ${command.willRunFullSuite ? "yes" : "no"}`,
    `- Purpose: ${command.purpose}`
  ].join("\n");
}

function renderStagingEnvironmentReadiness(readiness) {
  if (!readiness) {
    return "- Not available";
  }
  const lines = [
    `- Status: ${readiness.status}`,
    `- Writes data: ${readiness.willModifyData ? "yes" : "no"}`,
    `- Next action: ${readiness.nextAction}`
  ];
  for (const check of readiness.checks || []) {
    lines.push(`- ${check.key}: ${check.status}`);
    lines.push(`  - Evidence: ${check.evidence || "-"}`);
    if (check.command) {
      lines.push(`  - Command: \`${check.command}\``);
    }
    if (check.dryRunCommand) {
      lines.push(`  - Dry run: \`${check.dryRunCommand}\``);
    }
    if (Array.isArray(check.commandKeys) && check.commandKeys.length) {
      lines.push(`  - Command keys: ${check.commandKeys.join(", ")}`);
    }
    lines.push(`  - Next action: ${check.nextAction || "-"}`);
  }
  return lines.join("\n");
}

function renderStagingOperatorChecklist(checklist = []) {
  if (!Array.isArray(checklist) || checklist.length === 0) {
    return "- Not available";
  }
  return checklist
    .map((item) => {
      const details = [
        `${item.order}. ${item.label}`,
        `   - status: ${item.status}`,
        `   - summary: ${item.summary}`
      ];
      if (item.command) {
        details.push(`   - command: \`${item.command}\``);
      }
      if (item.dryRunCommand) {
        details.push(`   - dryRun: \`${item.dryRunCommand}\``);
      }
      if (item.route) {
        details.push(`   - route: ${item.route}`);
      }
      if (item.endpoint) {
        details.push(`   - endpoint: ${item.endpoint}`);
      }
      if (Array.isArray(item.commandKeys) && item.commandKeys.length) {
        details.push(`   - commandKeys: ${item.commandKeys.join(", ")}`);
      }
      if (Array.isArray(item.evidenceOperations) && item.evidenceOperations.length) {
        details.push(`   - evidenceOperations: ${item.evidenceOperations.join(", ")}`);
      }
      return details.join("\n");
    })
    .join("\n");
}

function renderOperatorExecutionPlan(plan) {
  if (!plan) {
    return "- Not available";
  }
  const lines = [
    `- Status: ${plan.status || "-"}`,
    `- Writes data: ${plan.willModifyData ? "yes" : "no"}`,
    `- Trigger: ${plan.trigger || "-"}`,
    `- Artifact archive root: ${plan.artifactArchiveRoot || "-"}`,
    `- Required closeout keys: ${(plan.requiredCloseoutKeys || []).join(", ")}`,
    `- Evidence operations: ${(plan.evidenceOperations || []).join(", ")}`,
    `- Full test command: ${plan.fullTestWindow?.command || "-"}`,
    `- Production sign-off decision: ${plan.productionSignoff?.requiredDecision || "-"}`,
    `- Readiness status: ${plan.readinessSummary?.status || "-"}`,
    `- Readiness gap count: ${plan.readinessSummary?.gapCount ?? "-"}`,
    `- Next action: ${plan.nextAction || "-"}`
  ];
  if (Array.isArray(plan.outputFiles) && plan.outputFiles.length) {
    lines.push("- Output files:");
    for (const file of plan.outputFiles) {
      lines.push(`  - ${file.key || "-"}: ${file.status || "-"}`);
      lines.push(`    - path: ${file.path || "-"}`);
      lines.push(`    - purpose: ${file.purpose || "-"}`);
    }
  }
  if (Array.isArray(plan.readinessGaps) && plan.readinessGaps.length) {
    lines.push("- Readiness gaps:");
    for (const gap of plan.readinessGaps) {
      lines.push(`  - ${gap.key || "-"}: ${gap.severity || "-"}`);
      lines.push(`    - stepKey: ${gap.stepKey || "-"}`);
      lines.push(`    - summary: ${gap.summary || "-"}`);
      if (gap.command) {
        lines.push(`    - command: \`${gap.command}\``);
      }
      if (gap.env) {
        lines.push(`    - env: ${gap.env}`);
      }
      if (Array.isArray(gap.missingCloseoutKeys) && gap.missingCloseoutKeys.length) {
        lines.push(`    - missingCloseoutKeys: ${gap.missingCloseoutKeys.join(", ")}`);
      }
      if (Array.isArray(gap.missingSignoffKeys) && gap.missingSignoffKeys.length) {
        lines.push(`    - missingSignoffKeys: ${gap.missingSignoffKeys.join(", ")}`);
      }
      if (Array.isArray(gap.missingReceiptVisibilityKeys) && gap.missingReceiptVisibilityKeys.length) {
        lines.push(`    - missingReceiptVisibilityKeys: ${gap.missingReceiptVisibilityKeys.join(", ")}`);
      }
      lines.push(`    - nextAction: ${gap.nextAction || "-"}`);
    }
  }
  if (Array.isArray(plan.orderedSteps) && plan.orderedSteps.length) {
    lines.push("- Ordered steps:");
    for (const step of plan.orderedSteps) {
      lines.push(`  - ${step.order || "-"}: ${step.key || "-"}`);
      lines.push(`    - status: ${step.status || "-"}`);
      lines.push(`    - summary: ${step.summary || "-"}`);
      if (step.command) {
        lines.push(`    - command: \`${step.command}\``);
      }
      if (step.endpoint) {
        lines.push(`    - endpoint: ${step.endpoint}`);
      }
      if (step.closeoutKey) {
        lines.push(`    - closeoutKey: ${step.closeoutKey}`);
      }
    }
  }
  return lines.join("\n");
}

function renderStagingResultBackfillSummary(summary) {
  if (!summary) {
    return "- Not available";
  }
  return [
    `- Status: ${summary.status}`,
    `- Writes data: ${summary.willModifyData ? "yes" : "no"}`,
    `- Required result keys: ${(summary.requiredResultKeys || []).join(", ")}`,
    `- Launch Mainline: ${summary.destinations?.launchMainline || "-"}`,
    `- Developer Ops: ${summary.destinations?.developerOps || "-"}`,
    `- Evidence endpoint: ${summary.evidenceEndpoint || "-"}`,
    `- Launch Review visibility: ${summary.receiptVisibilityDownloads?.launchReviewSummary || "-"}`,
    `- Launch Smoke visibility: ${summary.receiptVisibilityDownloads?.launchSmokeSummary || "-"}`,
    `- Operator note: ${summary.operatorNote || "-"}`
  ].join("\n");
}

function renderStagingAcceptanceCloseout(closeout) {
  if (!closeout) {
    return "- Not available";
  }
  const lines = [
    `- Status: ${closeout.status}`,
    `- Decision: ${closeout.decision}`,
    `- Writes data: ${closeout.willModifyData ? "yes" : "no"}`,
    `- Required result keys: ${(closeout.requiredResultKeys || []).join(", ")}`,
    `- Evidence operations: ${(closeout.evidenceOperations || []).join(", ")}`,
    `- Launch Mainline: ${closeout.destinations?.launchMainline || "-"}`,
    `- Developer Ops: ${closeout.destinations?.developerOps || "-"}`,
    `- Evidence endpoint: ${closeout.destinations?.evidenceEndpoint || "-"}`,
    `- Launch Review visibility: ${closeout.destinations?.receiptVisibilityDownloads?.launchReviewSummary || "-"}`,
    `- Launch Smoke visibility: ${closeout.destinations?.receiptVisibilityDownloads?.launchSmokeSummary || "-"}`,
    `- Next action: ${closeout.nextAction || "-"}`,
    `- Operator note: ${closeout.operatorNote || "-"}`
  ];
  if (Array.isArray(closeout.acceptanceChecks) && closeout.acceptanceChecks.length) {
    lines.push("- Acceptance checks:");
    for (const check of closeout.acceptanceChecks) {
      lines.push(`  - ${check.key}: ${check.label || "-"}`);
      lines.push(`    - required: ${check.required ? "yes" : "no"}`);
      if (check.command) {
        lines.push(`    - command: \`${check.command}\``);
      }
      if (Array.isArray(check.commandKeys) && check.commandKeys.length) {
        lines.push(`    - commandKeys: ${check.commandKeys.join(", ")}`);
      }
      if (check.endpoint) {
        lines.push(`    - endpoint: ${check.endpoint}`);
      }
      if (Array.isArray(check.operations) && check.operations.length) {
        lines.push(`    - operations: ${check.operations.join(", ")}`);
      }
      if (check.downloads) {
        lines.push(`    - launchReviewVisibility: ${check.downloads.launchReviewSummary || "-"}`);
        lines.push(`    - launchSmokeVisibility: ${check.downloads.launchSmokeSummary || "-"}`);
      }
      lines.push(`    - expectedEvidence: ${check.expectedEvidence || "-"}`);
    }
  }
  return lines.join("\n");
}

function renderCloseoutBackfillGuide(guide) {
  if (!guide) {
    return "- Not available";
  }
  return [
    `- Status: ${guide.status || "-"}`,
    `- Writes data: ${guide.willModifyData ? "yes" : "no"}`,
    `- Closeout input reload: \`${guide.closeoutInputReload?.command || "-"}\``,
    `- Ordered backfill keys: ${(guide.orderedBackfillKeys || []).join(", ")}`,
    `- Receipt visibility keys: ${(guide.receiptVisibilityKeys || []).join(", ")}`,
    `- Production sign-off keys: ${(guide.productionSignoffKeys || []).join(", ")}`,
    `- Full test window command: \`${guide.fullTestWindow?.command || "-"}\``,
    `- Full test window decision: ${guide.fullTestWindow?.requiredDecision || "-"}`,
    `- Production sign-off decision: ${guide.productionSignoff?.requiredDecision || "-"}`,
    `- Next action: ${guide.nextAction || "-"}`
  ].join("\n");
}

function renderArtifactReceiptLedger(ledger) {
  if (!ledger) {
    return "- Not available";
  }
  const lines = [
    `- Status: ${ledger.status || "-"}`,
    `- Writes data: ${ledger.willModifyData ? "yes" : "no"}`,
    `- Archive root: ${ledger.archiveRoot || "-"}`,
    `- Columns: ${(ledger.columns || []).join(", ")}`,
    `- Operator note: ${ledger.operatorNote || "-"}`
  ];
  if (Array.isArray(ledger.rows) && ledger.rows.length) {
    lines.push("- Rows:");
    for (const item of ledger.rows) {
      lines.push(`  - ${item.checkKey || "-"} -> ${item.artifactKey || "-"}`);
      lines.push(`    - artifactPath: ${item.artifactPath || "-"}`);
      lines.push(`    - receiptOperations: ${(item.receiptOperations || []).join(", ") || "-"}`);
      if (Array.isArray(item.allowedDecisions) && item.allowedDecisions.length) {
        lines.push(`    - allowedDecisions: ${item.allowedDecisions.join(", ")}`);
      }
      lines.push(`    - closeoutStatus: ${item.closeoutStatus || "-"}`);
      lines.push(`    - operatorNote: ${item.operatorNote || "-"}`);
    }
  }
  return lines.join("\n");
}

function renderFullTestWindowEntry(entry) {
  if (!entry) {
    return "- Not available";
  }
  const lines = [
    `- Status: ${entry.status || "-"}`,
    `- Command: \`${entry.command || "-"}\``,
    `- Runs full suite: ${entry.willRunFullSuite ? "yes" : "no"}`,
    `- Writes data: ${entry.willModifyData ? "yes" : "no"}`,
    `- Trigger decision: ${entry.triggerDecision || "-"}`,
    `- Required closeout keys: ${(entry.requiredCloseoutKeys || []).join(", ")}`,
    `- Archive root: ${entry.archiveRoot || "-"}`,
    `- Next action: ${entry.nextAction || "-"}`
  ];
  if (Array.isArray(entry.entryCriteria) && entry.entryCriteria.length) {
    lines.push("- Entry criteria:");
    for (const item of entry.entryCriteria) {
      lines.push(`  - ${item.key || "-"}: ${item.status || "-"}`);
      lines.push(`    - summary: ${item.summary || "-"}`);
    }
  }
  return lines.join("\n");
}

function renderFullTestWindowReadiness(readiness) {
  if (!readiness) {
    return "- Not available";
  }
  return [
    `- Status: ${readiness.status || "-"}`,
    `- Can run: ${readiness.canRun ? "yes" : "no"}`,
    `- Command: \`${readiness.command || "-"}\``,
    `- Runs full suite: ${readiness.willRunFullSuite ? "yes" : "no"}`,
    `- Writes data: ${readiness.willModifyData ? "yes" : "no"}`,
    `- Required decision: ${readiness.requiredDecision || "-"}`,
    `- Closeout input status: ${readiness.closeoutInputStatus || "-"}`,
    `- Missing closeout keys: ${(readiness.missingCloseoutKeys || []).join(", ") || "-"}`,
    `- Reload command: \`${readiness.reloadCommand || "-"}\``,
    `- Next action: ${readiness.nextAction || "-"}`
  ].join("\n");
}

function renderProductionSignoffReadiness(readiness) {
  if (!readiness) {
    return "- Not available";
  }
  return [
    `- Status: ${readiness.status || "-"}`,
    `- Can sign off: ${readiness.canSignoff ? "yes" : "no"}`,
    `- Required decision: ${readiness.requiredDecision || "-"}`,
    `- Production decision: ${readiness.productionDecision || "-"}`,
    `- Closeout input status: ${readiness.closeoutInputStatus || "-"}`,
    `- Full test window ready: ${readiness.readyForFullTestWindow ? "yes" : "no"}`,
    `- Missing sign-off keys: ${(readiness.missingSignoffKeys || []).join(", ") || "-"}`,
    `- Missing receipt visibility keys: ${(readiness.missingReceiptVisibilityKeys || []).join(", ") || "-"}`,
    `- Reload command: \`${readiness.reloadCommand || "-"}\``,
    `- Next action: ${readiness.nextAction || "-"}`
  ].join("\n");
}

function renderLaunchDayWatchPlan(plan) {
  if (!plan) {
    return "- Not available";
  }
  const routes = plan.routes || {};
  const watchWindows = Array.isArray(plan.watchWindows) ? plan.watchWindows : [];
  const lines = [
    `- Status: ${plan.status || "-"}`,
    `- Can start cutover watch: ${plan.canStartCutoverWatch ? "yes" : "no"}`,
    `- Watch start gate: ${plan.watchStartGate || "-"}`,
    `- Required decision: ${plan.requiredDecision || "-"}`,
    `- Production decision: ${plan.productionDecision || "-"}`,
    `- Closeout input status: ${plan.closeoutInputStatus || "-"}`,
    `- Missing sign-off keys: ${(plan.missingSignoffKeys || []).join(", ") || "-"}`,
    `- Missing receipt visibility keys: ${(plan.missingReceiptVisibilityKeys || []).join(", ") || "-"}`,
    `- Launch Mainline: ${routes.launchMainline || "-"}`,
    `- Developer Ops: ${routes.developerOps || "-"}`,
    `- Launch Review summary: ${routes.launchReviewSummary || "-"}`,
    `- Launch Smoke summary: ${routes.launchSmokeSummary || "-"}`,
    `- Watch windows: ${watchWindows.map((item) => item.key).filter(Boolean).join(", ") || "-"}`,
    `- Escalation triggers: ${(plan.escalationTriggers || []).join(", ") || "-"}`,
    `- Next action: ${plan.nextAction || "-"}`
  ];
  for (const item of watchWindows) {
    lines.push(`  - ${item.key || "-"}: ${item.status || "-"}`);
    lines.push(`    - window: ${item.window || "-"}`);
    lines.push(`    - summary: ${item.summary || "-"}`);
  }
  return lines.join("\n");
}

function renderStabilizationHandoffPlan(plan) {
  if (!plan) {
    return "- Not available";
  }
  const routes = plan.routes || {};
  const handoffWindows = Array.isArray(plan.handoffWindows) ? plan.handoffWindows : [];
  const lines = [
    `- Status: ${plan.status || "-"}`,
    `- Can start stabilization handoff: ${plan.canStartStabilizationHandoff ? "yes" : "no"}`,
    `- Source watch status: ${plan.sourceWatchStatus || "-"}`,
    `- Required watch windows: ${(plan.requiredWatchWindows || []).join(", ") || "-"}`,
    `- Required evidence keys: ${(plan.requiredEvidenceKeys || []).join(", ") || "-"}`,
    `- Launch Mainline: ${routes.launchMainline || "-"}`,
    `- Developer Ops: ${routes.developerOps || "-"}`,
    `- Launch Review summary: ${routes.launchReviewSummary || "-"}`,
    `- Launch Smoke summary: ${routes.launchSmokeSummary || "-"}`,
    `- Handoff windows: ${handoffWindows.map((item) => item.label || item.key).filter(Boolean).join(", ") || "-"}`,
    `- Escalation triggers: ${(plan.escalationTriggers || []).join(", ") || "-"}`,
    `- Next action: ${plan.nextAction || "-"}`
  ];
  for (const item of handoffWindows) {
    lines.push(`  - ${item.key || "-"}: ${item.status || "-"}`);
    lines.push(`    - label: ${item.label || "-"}`);
    lines.push(`    - summary: ${item.summary || "-"}`);
  }
  return lines.join("\n");
}

function renderStagingRunRecordTemplate(template) {
  if (!template) {
    return "- Not available";
  }
  const lines = [
    `- Status: ${template.status || "-"}`,
    `- Writes data: ${template.willModifyData ? "yes" : "no"}`,
    `- Archive root: ${template.archiveRoot || "-"}`,
    `- Closeout reload: \`${template.closeoutInputReloadCommand || "-"}\``,
    `- Source readiness: fullTestWindow=${template.sourceReadiness?.fullTestWindow || "-"}, productionSignoff=${template.sourceReadiness?.productionSignoff || "-"}, launchDayWatch=${template.sourceReadiness?.launchDayWatch || "-"}, stabilizationHandoff=${template.sourceReadiness?.stabilizationHandoff || "-"}`,
    `- Required record keys: ${(template.requiredRecordKeys || []).join(", ") || "-"}`,
    `- Operator note: ${template.operatorNote || "-"}`
  ];
  if (Array.isArray(template.records) && template.records.length) {
    lines.push("- Records:");
    for (const record of template.records) {
      lines.push(`  - ${record.key || "-"}: ${record.artifactPath || "-"}`);
      lines.push(`    - sourcePlan: ${record.sourcePlan || "-"}`);
      lines.push(`    - receiptOperations: ${(record.receiptOperations || []).join(", ") || "-"}`);
      lines.push(`    - operatorNote: ${record.operatorNote || "-"}`);
    }
  }
  return lines.join("\n");
}

function renderFilledCloseoutInputExample(example) {
  if (!example) {
    return "- Not available";
  }
  return [
    `- Status: ${example.status || "-"}`,
    `- Example only: ${example.exampleOnly ? "yes" : "no"}`,
    `- Save as: ${example.saveAs || "-"}`,
    `- Reload command: \`${example.reloadCommand || "-"}\``,
    `- Do not submit without replacing placeholders: ${example.doNotSubmitWithoutReplacingPlaceholders ? "yes" : "no"}`,
    `- Acceptance field keys: ${(example.acceptanceFields || []).map((item) => item.key).join(", ") || "-"}`,
    `- Receipt visibility keys: ${Object.keys(example.receiptVisibility || {}).join(", ") || "-"}`,
    `- Production sign-off decision: ${example.productionSignoff?.decision || "-"}`,
    `- Operator note: ${example.operatorNote || "-"}`
  ].join("\n");
}

function renderStagingEnvironmentBinding(binding) {
  if (!binding) {
    return "- Not available";
  }
  const fileByKey = new Map((binding.recommendedOutputFiles || []).map((item) => [item.key, item]));
  return [
    `- Binding status: ${binding.status || "-"}`,
    `- Writes data: ${binding.willModifyData ? "yes" : "no"}`,
    `- Base URL: ${binding.environment?.baseUrl || "-"}`,
    `- Product code: ${binding.environment?.productCode || "-"}`,
    `- Channel: ${binding.environment?.channel || "-"}`,
    `- Target OS: ${binding.environment?.targetOs || "-"}`,
    `- Storage profile: ${binding.environment?.storageProfile || "-"}`,
    `- Target env file: ${binding.environment?.targetEnvFile || "-"}`,
    `- App backup dir: ${binding.environment?.appBackupDir || "-"}`,
    `- Postgres backup dir: ${binding.environment?.postgresBackupDir || "-"}`,
    `- Admin password env: ${binding.credentialEnv?.adminPassword || "-"}`,
    `- Developer password env: ${binding.credentialEnv?.developerPassword || "-"}`,
    `- Developer bearer token env: ${binding.credentialEnv?.developerBearerToken || "-"}`,
    `- Handoff file: ${fileByKey.get("handoff_file")?.path || "-"}`,
    `- Closeout file: ${fileByKey.get("closeout_file")?.path || "-"}`,
    `- Filled closeout input: ${fileByKey.get("filled_closeout_input")?.path || "-"}`,
    `- Artifact archive root: ${fileByKey.get("artifact_archive_root")?.path || "-"}`,
    `- Dry run command: \`${binding.dryRunCommand || "-"}\``,
    `- Next action: ${binding.nextAction || "-"}`
  ].join("\n");
}

function renderStagingExecutionRunbook(runbook) {
  if (!runbook) {
    return "- Not available";
  }
  const lines = [
    `- Runbook status: ${runbook.status || "-"}`,
    `- Writes data by itself: ${runbook.willModifyData ? "yes" : "no"}`,
    `- Contains live-write step: ${runbook.containsLiveWriteStep ? "yes" : "no"}`,
    `- Live-write requires approval: ${runbook.liveWriteRequiresApproval ? "yes" : "no"}`,
    `- Source binding status: ${runbook.sourceBindingStatus || "-"}`,
    `- Artifact archive root: ${runbook.artifactArchiveRoot || "-"}`,
    `- Command sequence: ${(runbook.commandSequence || []).map((item) => item.key).join(", ") || "-"}`,
    `- Next action: ${runbook.nextAction || "-"}`
  ];
  if (Array.isArray(runbook.closeoutBackfillTargets) && runbook.closeoutBackfillTargets.length) {
    lines.push("- Closeout backfill targets:");
    for (const target of runbook.closeoutBackfillTargets) {
      lines.push(`  - ${target.key || "-"}: ${target.sourceStep || "-"} -> ${target.artifactPath || "-"}`);
      lines.push(`    - receiptOperations: ${(target.receiptOperations || []).join(", ") || "-"}`);
    }
  }
  return lines.join("\n");
}

function renderFinalRehearsalPacket(packet) {
  if (!packet) {
    return "- Not available";
  }
  const fileByKey = new Map((packet.localFiles || []).map((item) => [item.key, item]));
  return [
    `- Packet status: ${packet.status || "-"}`,
    `- Writes data: ${packet.willModifyData ? "yes" : "no"}`,
    `- Environment binding status: ${packet.environmentBindingStatus || "-"}`,
    `- Execution runbook status: ${packet.executionRunbookStatus || "-"}`,
    `- Archive root: ${packet.archiveRoot || "-"}`,
    `- Staging rehearsal dry run: \`${packet.commands?.stagingRehearsalDryRun || "-"}\``,
    `- Route-map gate: \`${packet.commands?.routeMapGate || "-"}\``,
    `- Live-write smoke: \`${packet.commands?.liveWriteSmoke || "-"}\``,
    `- Closeout reload: \`${packet.commands?.closeoutReload || "-"}\``,
    `- Full test window: \`${packet.commands?.fullTestWindow || "-"}\``,
    `- Handoff file: ${fileByKey.get("handoff_file")?.path || "-"}`,
    `- Closeout file: ${fileByKey.get("closeout_file")?.path || "-"}`,
    `- Filled closeout input: ${fileByKey.get("filled_closeout_input")?.path || "-"}`,
    `- Filled closeout input example: ${fileByKey.get("filled_closeout_input_example")?.path || "-"}`,
    `- Source readiness: fullTestWindow=${packet.sourceReadiness?.fullTestWindow || "-"}, productionSignoff=${packet.sourceReadiness?.productionSignoff || "-"}, launchDayWatch=${packet.sourceReadiness?.launchDayWatch || "-"}, stabilizationHandoff=${packet.sourceReadiness?.stabilizationHandoff || "-"}`,
    `- Ordered packet steps: ${(packet.orderedSteps || []).map((item) => item.key).join(", ") || "-"}`,
    `- Next action: ${packet.nextAction || "-"}`
  ].join("\n");
}

function renderProductionSignoffConditions(signoff) {
  if (!signoff) {
    return "- Not available";
  }
  const lines = [
    `- Status: ${signoff.status || "-"}`,
    `- Required decision: ${signoff.requiredDecision || "-"}`,
    `- Writes data: ${signoff.willModifyData ? "yes" : "no"}`,
    `- Next action: ${signoff.nextAction || "-"}`
  ];
  if (Array.isArray(signoff.conditions) && signoff.conditions.length) {
    lines.push("- Conditions:");
    for (const item of signoff.conditions) {
      lines.push(`  - ${item.key || "-"}: ${item.status || "-"}`);
      lines.push(`    - evidence: ${item.evidence || "-"}`);
    }
  }
  return lines.join("\n");
}

function renderHandoffFile(result) {
  return [
    "# Staging Rehearsal Handoff",
    "",
    `Generated at: ${result.generatedAt}`,
    "",
    "## Lane",
    "",
    `- Base URL: ${result.summary.baseUrl}`,
    `- Product code: ${result.summary.productCode}`,
    `- Channel: ${result.summary.channel}`,
    `- Target OS: ${result.summary.targetOs}`,
    `- Storage profile: ${result.summary.storageProfile}`,
    `- Rehearsal writes data: ${result.summary.willModifyData ? "yes" : "no"}`,
    "",
    "## Gate Status",
    "",
    result.phases.map((phase) => `- ${phase.key}: ${phase.status}`).join("\n"),
    "",
    "## Next Live-Write Smoke Command",
    "",
    renderCommandList(result.nextCommands.launchSmoke),
    "",
    "## Recovery Commands",
    "",
    renderCommandList(result.nextCommands.recovery),
    "",
    "## Launch Mainline",
    "",
    result.nextCommands.launchMainline || "Not available",
    "",
    "## Launch Route Map Targeted Gate",
    "",
    renderLaunchRouteMapGate(result.nextCommands.launchRouteMapGate),
    "",
    "## Receipt Visibility Summary Downloads",
    "",
    renderReceiptVisibilitySummaries(result.nextCommands.receiptVisibilitySummaries),
    "",
    "## Staging Environment Readiness",
    "",
    renderStagingEnvironmentReadiness(result.environmentReadiness),
    "",
    "## Staging Operator Checklist",
    "",
    renderStagingOperatorChecklist(result.operatorChecklist),
    "",
    "## Operator Execution Plan",
    "",
    renderOperatorExecutionPlan(result.operatorExecutionPlan),
    "",
    "## Staging Result Backfill Summary",
    "",
    renderStagingResultBackfillSummary(result.resultBackfillSummary),
    "",
    "## Staging Acceptance Closeout",
    "",
    renderStagingAcceptanceCloseout(result.stagingAcceptanceCloseout),
    "",
    "## Closeout Backfill Guide",
    "",
    renderCloseoutBackfillGuide(result.closeoutBackfillGuide),
    "",
    "## Artifact / Receipt Ledger",
    "",
    renderArtifactReceiptLedger(result.stagingAcceptanceCloseout?.artifactReceiptLedger),
    "",
    "## Full Test Window Entry",
    "",
    renderFullTestWindowEntry(result.stagingAcceptanceCloseout?.fullTestWindowEntry),
    "",
    "## Full Test Window Readiness",
    "",
    renderFullTestWindowReadiness(result.fullTestWindowReadiness),
    "",
    "## Production Sign-Off Readiness",
    "",
    renderProductionSignoffReadiness(result.productionSignoffReadiness),
    "",
    "## Launch Day Watch Plan",
    "",
    renderLaunchDayWatchPlan(result.launchDayWatchPlan),
    "",
    "## Stabilization Handoff Plan",
    "",
    renderStabilizationHandoffPlan(result.stabilizationHandoffPlan),
    "",
    "## Staging Run Record Template",
    "",
    renderStagingRunRecordTemplate(result.stagingRunRecordTemplate),
    "",
    "## Staging Environment Binding",
    "",
    renderStagingEnvironmentBinding(result.stagingEnvironmentBinding),
    "",
    "## Staging Execution Runbook",
    "",
    renderStagingExecutionRunbook(result.stagingExecutionRunbook),
    "",
    "## Filled Closeout Input Example",
    "",
    renderFilledCloseoutInputExample(result.filledCloseoutInputExample),
    "",
    "## Final Rehearsal Packet",
    "",
    renderFinalRehearsalPacket(result.finalRehearsalPacket),
    "",
    "## Production Sign-Off Conditions",
    "",
    renderProductionSignoffConditions(result.stagingAcceptanceCloseout?.productionSignoffConditions),
    "",
    "## Evidence Readiness",
    "",
    renderEvidenceReadiness(result.evidenceReadiness),
    "",
    "## Evidence Action Plan",
    "",
    `Endpoint: ${result.evidenceActionPlan?.endpoint || "Not available"}`,
    `Method: ${result.evidenceActionPlan?.method || "Not available"}`,
    `Will modify data: ${result.evidenceActionPlan?.willModifyData ? "yes" : "no"}`,
    "",
    renderEvidenceActions(result.evidenceActionPlan),
    "",
    "## Handling Notes",
    "",
    "- This file is generated only after no-write rehearsal gates pass.",
    "- Password values stay in environment variables and are not written to this handoff.",
    "- Run the live-write smoke command only when launch duty intentionally allows staging writes.",
    ""
  ].join("\n");
}

function buildCloseoutTemplate(result) {
  const closeout = result.stagingAcceptanceCloseout || {};
  const ledger = closeout.artifactReceiptLedger || {};
  const ledgerRowsByKey = new Map((ledger.rows || []).map((row) => [row.checkKey, row]));
  return {
    mode: "staging-closeout-template",
    source: "staging-rehearsal",
    generatedAt: result.generatedAt,
    status: closeout.status || "not_available",
    decision: closeout.decision || "pending_staging_results",
    willModifyData: false,
    baseUrl: result.summary?.baseUrl || null,
    productCode: result.summary?.productCode || null,
    channel: result.summary?.channel || null,
    targetOs: result.summary?.targetOs || null,
    storageProfile: result.summary?.storageProfile || null,
    requiredResultKeys: closeout.requiredResultKeys || [],
    evidenceOperations: closeout.evidenceOperations || [],
    archiveRoot: ledger.archiveRoot || null,
    acceptanceFields: (closeout.acceptanceChecks || []).map((check) => {
      const row = ledgerRowsByKey.get(check.key) || {};
      return {
        key: check.key,
        label: check.label || null,
        required: check.required === true,
        status: "pending_operator_entry",
        value: null,
        expectedEvidence: check.expectedEvidence || null,
        command: check.command || null,
        commandKeys: check.commandKeys || null,
        endpoint: check.endpoint || null,
        operations: check.operations || null,
        downloads: check.downloads || null,
        artifactKey: row.artifactKey || null,
        artifactPath: row.artifactPath || null,
        receiptOperations: row.receiptOperations || [],
        allowedDecisions: row.allowedDecisions || null,
        operatorNote: row.operatorNote || null
      };
    }),
    resultBackfillSummary: result.resultBackfillSummary || null,
    artifactReceiptLedger: ledger,
    receiptVisibility: buildReceiptVisibilityTemplate(),
    productionSignoff: buildProductionSignoffInputTemplate(closeout.productionSignoffConditions || {}),
    closeoutBackfillGuide: result.closeoutBackfillGuide || buildCloseoutBackfillGuide(result),
    fullTestWindowReadiness: result.fullTestWindowReadiness || buildFullTestWindowReadiness(result),
    productionSignoffReadiness: result.productionSignoffReadiness || buildProductionSignoffReadiness(result),
    launchDayWatchPlan: result.launchDayWatchPlan || buildLaunchDayWatchPlan(result),
    stabilizationHandoffPlan: result.stabilizationHandoffPlan || buildStabilizationHandoffPlan(result),
    stagingRunRecordTemplate: result.stagingRunRecordTemplate || buildStagingRunRecordTemplate(result),
    stagingEnvironmentBinding: result.stagingEnvironmentBinding || null,
    stagingExecutionRunbook: result.stagingExecutionRunbook || null,
    filledCloseoutInputExample: result.filledCloseoutInputExample || buildFilledCloseoutInputExample(result),
    finalRehearsalPacket: result.finalRehearsalPacket || buildFinalRehearsalPacket(result),
    closeoutInput: result.closeoutInput || null,
    operatorExecutionPlan: result.operatorExecutionPlan || null,
    fullTestWindowEntry: closeout.fullTestWindowEntry || null,
    productionSignoffConditions: closeout.productionSignoffConditions || null,
    destinations: closeout.destinations || null,
    nextCommands: {
      launchSmoke: result.nextCommands?.launchSmoke || null,
      recovery: result.nextCommands?.recovery || null,
      launchRouteMapGate: result.nextCommands?.launchRouteMapGate || null,
      launchMainline: result.nextCommands?.launchMainline || null,
      receiptVisibilitySummaries: result.nextCommands?.receiptVisibilitySummaries || null
    },
    operatorChecklist: result.operatorChecklist || [],
    operatorNote: closeout.operatorNote || null,
    nextAction: closeout.nextAction || null
  };
}

function writeHandoffFile(result) {
  if (!result.handoffFile) {
    return result;
  }
  if (result.status !== "pass") {
    return result;
  }

  const nextResult = {
    ...result,
    handoffFile: {
      ...result.handoffFile,
      written: true
    }
  };
  mkdirSync(path.dirname(result.handoffFile.path), { recursive: true });
  writeFileSync(result.handoffFile.path, renderHandoffFile(refreshOperatorExecutionPlan(nextResult)), "utf8");
  return nextResult;
}

function writeCloseoutFile(result) {
  if (!result.closeoutFile) {
    return result;
  }
  if (result.status !== "pass") {
    return result;
  }

  const nextResult = {
    ...result,
    closeoutFile: {
      ...result.closeoutFile,
      written: true
    }
  };
  mkdirSync(path.dirname(result.closeoutFile.path), { recursive: true });
  writeFileSync(result.closeoutFile.path, `${JSON.stringify(buildCloseoutTemplate(refreshOperatorExecutionPlan(nextResult)), null, 2)}\n`, "utf8");
  return nextResult;
}

function refreshOperatorExecutionPlan(result) {
  if (!result.operatorExecutionPlan) {
    return result;
  }
  return {
    ...result,
    operatorExecutionPlan: buildStagingOperatorExecutionPlan(result)
  };
}

function writeOutputFiles(result) {
  return refreshOperatorExecutionPlan(writeCloseoutFile(writeHandoffFile(result)));
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.status === "pass") {
    console.log("Staging rehearsal gates passed. No data was modified.");
    console.log(result.nextCommands.launchSmoke);
    console.log(result.nextCommands.launchRouteMapGate?.command || "");
    console.log(result.nextCommands.launchMainline);
    console.log(result.environmentReadiness?.nextAction || "");
    console.log(result.nextCommands.receiptVisibilitySummaries?.launchReviewSummary || "");
    console.log(result.nextCommands.receiptVisibilitySummaries?.launchSmokeSummary || "");
    return;
  }

  console.error(`Staging rehearsal blocked: ${result.error.message}`);
  if (result.failedPhase) {
    console.error(`Failed phase: ${result.failedPhase.key}`);
  }
}

function main() {
  let json = process.argv.includes("--json");
  try {
    const options = parseArgs(process.argv.slice(2));
    json = options.json;
    const result = writeOutputFiles(buildResult(options));
    writeResult(result, json);
    if (result.status !== "pass") {
      process.exitCode = 1;
    }
  } catch (error) {
    const result = {
      status: "fail",
      mode: "staging-rehearsal",
      generatedAt: new Date().toISOString(),
      summary: {
        willModifyData: false
      },
      preflights: {
        staging: null,
        recovery: null
      },
      phases: [],
      nextCommands: {
        launchSmoke: null,
        recovery: null,
        launchMainline: null
      },
      evidenceOrder: [],
      error: {
        message: error.message
      }
    };
    writeResult(result, json);
    process.exitCode = 1;
  }
}

main();
