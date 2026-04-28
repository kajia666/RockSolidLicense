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

  return {
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
      launchMainline
    },
    evidenceOrder: gatesPassed ? EVIDENCE_ORDER : [],
    evidenceActionPlan: gatesPassed ? buildEvidenceActionPlan(options) : null,
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
    console.log(result.nextCommands.launchMainline);
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
