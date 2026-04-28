#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
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
    handoffFile: null
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
    handoffFile: readOptionOrEnv(options.handoffFile, "RSL_REHEARSAL_HANDOFF_FILE")
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
    ...(status === "fail"
      ? {
        failedPhase: firstFailedPhase(phases),
        error: {
          message: "A no-write rehearsal gate failed; live-write staging smoke remains blocked."
        }
      }
      : {})
  };
  return {
    ...result,
    operatorChecklist: gatesPassed ? buildStagingOperatorChecklist(result) : []
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

function writeHandoffFile(result) {
  if (!result.handoffFile) {
    return result;
  }
  if (result.status !== "pass") {
    return result;
  }

  mkdirSync(path.dirname(result.handoffFile.path), { recursive: true });
  writeFileSync(result.handoffFile.path, renderHandoffFile(result), "utf8");
  return {
    ...result,
    handoffFile: {
      ...result.handoffFile,
      written: true
    }
  };
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
    const result = writeHandoffFile(buildResult(options));
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
