import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const defaultProductCode = "FIRSTBATCH";
const defaultChannel = "stable";
const defaultTargetDir = "C:\\RockSolidLicense";
const defaultOutputFile = path.resolve("artifacts", "deploy", "windows", "windows-deploy-evidence-pack.md");

function requireArgValue(name, value, inlineValue) {
  const missingValue = value === undefined
    || value === null
    || (inlineValue === undefined && String(value).startsWith("--"));
  if (missingValue) {
    throw new Error(`${name} requires a value.`);
  }
  return String(value);
}

function parseArgs(argv) {
  const options = {
    channel: defaultChannel,
    help: false,
    json: false,
    outputFile: defaultOutputFile,
    productCode: defaultProductCode,
    targetDir: defaultTargetDir
  };
  const optionMap = {
    "--channel": "channel",
    "--output-file": "outputFile",
    "--product-code": "productCode",
    "--target-dir": "targetDir"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const [name, inlineValue] = arg.split("=", 2);
    const key = optionMap[name];
    if (!key) {
      throw new Error(`Unknown option: ${name}`);
    }
    const value = requireArgValue(name, inlineValue ?? argv[index + 1], inlineValue);
    options[key] = key === "outputFile" ? path.resolve(value.trim()) : value.trim();
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  if (!options.productCode) {
    throw new Error("productCode must not be blank.");
  }
  if (!options.channel) {
    throw new Error("channel must not be blank.");
  }
  return options;
}

function isSameOrInside(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function artifactRoot(productCode, channel) {
  return `artifacts/staging/${productCode}/${channel}`;
}

function buildPaths(root) {
  return {
    actionsFile: `${root}/readiness-action-queue.md`,
    closeoutInputFile: `${root}/filled-closeout-input.json`,
    launchDutyRecordIndexFile: `${root}/launch-duty-record-index.json`
  };
}

function closeoutCommand(paths, key, artifactPath, receiptIds = []) {
  return [
    "npm.cmd run staging:closeout:backfill --",
    `--input-file ${paths.closeoutInputFile}`,
    `--key ${key}`,
    "--value-json <redacted-json>",
    `--artifact-path ${artifactPath}`,
    ...receiptIds.map((id) => `--receipt-id <${id}>`),
    `--actions-file ${paths.actionsFile}`
  ].join(" ");
}

function signoffCommand(paths, key, artifactPath, receiptIds = [], decision = "") {
  return [
    "npm.cmd run staging:signoff:backfill --",
    `--input-file ${paths.closeoutInputFile}`,
    `--condition-key ${key}`,
    "--value-json <redacted-json>",
    `--artifact-path ${artifactPath}`,
    ...receiptIds.map((id) => `--receipt-id <${id}>`),
    decision ? `--decision ${decision}` : "",
    `--actions-file ${paths.actionsFile}`
  ].filter(Boolean).join(" ");
}

function receiptLaneCommand(paths, lane, artifactPath) {
  return [
    "npm.cmd run staging:signoff:backfill --",
    `--input-file ${paths.closeoutInputFile}`,
    `--receipt-lane ${lane}`,
    "--value-json <redacted-json>",
    `--artifact-path ${artifactPath}`,
    "--receipt-id <record_post_launch_ops_sweep-receipt-id>",
    `--actions-file ${paths.actionsFile}`
  ].join(" ");
}

function launchDutyCommand(paths, key, artifactPath, receiptIds = [], sourceRecords = []) {
  return [
    "npm.cmd run staging:launch-duty:record --",
    `--closeout-input-file ${paths.closeoutInputFile}`,
    `--key ${key}`,
    `--artifact-path ${artifactPath}`,
    "--value-json <redacted-json>",
    ...receiptIds.map((id) => `--receipt-id <${id}>`),
    ...sourceRecords.map(([sourceKey, sourcePath]) => `--source-record ${sourceKey}=${sourcePath}`),
    `--record-index-file ${paths.launchDutyRecordIndexFile}`,
    `--actions-file ${paths.actionsFile}`
  ].join(" ");
}

function buildEvidenceGroups(options) {
  const root = artifactRoot(options.productCode, options.channel);
  const paths = buildPaths(root);
  const firstWaveSources = [
    ["first_wave_incident_log", `${root}/first-wave-incident-log.md`],
    ["rollback_signal_review", `${root}/rollback-signal-review.md`],
    ["stabilization_owner_handoff", `${root}/stabilization-owner-handoff.md`]
  ];
  return [
    {
      order: 1,
      key: "deployment_readiness",
      title: "Deployment Readiness",
      gate: "Run before evidence capture starts.",
      items: [
        {
          key: "windows_prepare_pack",
          expectedEvidence: "Confirm the first deploy pack has been generated and reviewed.",
          artifactPath: "artifacts/deploy/windows/windows-first-deploy-pack.md",
          command: "npm.cmd run deploy:windows:prepare-pack"
        },
        {
          key: "windows_preflight",
          expectedEvidence: "Confirm the Windows preflight reports ready_for_manual_start or the expected next setup state.",
          artifactPath: null,
          command: "npm.cmd run deploy:windows:preflight"
        }
      ]
    },
    {
      order: 2,
      key: "closeout_backfill",
      title: "Closeout Evidence Backfill",
      gate: "Run after manual start, local healthcheck, HTTPS, and required secret env are in place.",
      items: [
        {
          key: "backup_restore_drill_result",
          expectedEvidence: "Backup artifact path, restore dry-run result, and post-restore healthcheck result.",
          artifactPath: `${root}/backup-restore-drill.txt`,
          command: closeoutCommand(paths, "backup_restore_drill_result", `${root}/backup-restore-drill.txt`, [
            "record_recovery_drill-receipt-id",
            "record_backup_verification-receipt-id"
          ])
        },
        {
          key: "live_write_smoke_result",
          expectedEvidence: "Smoke exit status, created test identifiers, and redacted smoke output path.",
          artifactPath: `${root}/live-write-smoke-output.json`,
          command: closeoutCommand(paths, "live_write_smoke_result", `${root}/live-write-smoke-output.json`, [
            "record_launch_rehearsal_run-receipt-id"
          ])
        },
        {
          key: "receipt_visibility_review",
          expectedEvidence: "Launch Review, Launch Smoke, Developer Ops, and overview receipt visibility confirmation.",
          artifactPath: `${root}/receipt-visibility-review.txt`,
          command: closeoutCommand(paths, "receipt_visibility_review", `${root}/receipt-visibility-review.txt`, [
            "record_post_launch_ops_sweep-receipt-id"
          ])
        }
      ]
    },
    {
      order: 3,
      key: "production_signoff",
      title: "Production Signoff Evidence",
      gate: "Run after post-smoke closeout and readiness refresh.",
      items: [
        {
          key: "full_test_window_passed",
          expectedEvidence: "Full npm.cmd test output summary and failure count.",
          artifactPath: `${root}/full-test-output.txt`,
          command: signoffCommand(paths, "full_test_window_passed", `${root}/full-test-output.txt`, [], "ready-for-production-signoff")
        },
        {
          key: "staging_artifacts_archived",
          expectedEvidence: "Archive paths for redacted staging artifacts and receipts.",
          artifactPath: `${root}/staging-artifacts-archive.txt`,
          command: signoffCommand(paths, "staging_artifacts_archived", `${root}/staging-artifacts-archive.txt`)
        },
        {
          key: "launch_mainline_receipts_visible",
          expectedEvidence: "Launch Mainline and mirrored review surfaces show latest receipts.",
          artifactPath: `${root}/launch-mainline-receipts-visible.json`,
          command: signoffCommand(paths, "launch_mainline_receipts_visible", `${root}/launch-mainline-receipts-visible.json`, [
            "record_post_launch_ops_sweep-receipt-id"
          ])
        },
        {
          key: "launch_ops_overview_status_visible",
          expectedEvidence: "Launch Ops Overview Status shows the latest receipt visibility state.",
          artifactPath: `${root}/launch-ops-overview-status-visible.json`,
          command: signoffCommand(paths, "launch_ops_overview_status_visible", `${root}/launch-ops-overview-status-visible.json`, [
            "record_post_launch_ops_sweep-receipt-id"
          ])
        },
        {
          key: "backup_restore_drill_passed",
          expectedEvidence: "Backup/restore drill passed on the intended storage profile.",
          artifactPath: `${root}/backup-restore-drill.txt`,
          command: signoffCommand(paths, "backup_restore_drill_passed", `${root}/backup-restore-drill.txt`, [
            "record_recovery_drill-receipt-id",
            "record_backup_verification-receipt-id"
          ])
        },
        {
          key: "rollback_path_confirmed",
          expectedEvidence: "Rollback walkthrough and recovery handoff are current.",
          artifactPath: `${root}/rollback-path-confirmed.md`,
          command: signoffCommand(paths, "rollback_path_confirmed", `${root}/rollback-path-confirmed.md`, [
            "record_rollback_walkthrough-receipt-id"
          ])
        },
        {
          key: "operator_signoff_recorded",
          expectedEvidence: "Operator, timestamp, decision, and reason.",
          artifactPath: `${root}/operator-production-signoff.md`,
          command: signoffCommand(paths, "operator_signoff_recorded", `${root}/operator-production-signoff.md`)
        }
      ]
    },
    {
      order: 4,
      key: "receipt_visibility",
      title: "Receipt Visibility Lanes",
      gate: "Run after signoff evidence is visible on the launch surfaces.",
      items: [
        "launchMainline",
        "launchReview",
        "launchSmoke",
        "developerOps",
        "launchOpsOverviewStatus"
      ].map((lane) => ({
        key: lane,
        expectedEvidence: `Confirm ${lane} shows latest staging evidence receipts before cutover.`,
        artifactPath: `${root}/${lane.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-receipt-visibility.json`,
        command: receiptLaneCommand(paths, lane, `${root}/${lane.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-receipt-visibility.json`)
      }))
    },
    {
      order: 5,
      key: "launch_duty_records",
      title: "Launch Duty Records",
      gate: "Run after production signoff and receipt visibility are ready.",
      items: [
        {
          key: "launch_day_watch_summary",
          expectedEvidence: "Cutover watch window, owner, route checks, and operator decisions.",
          artifactPath: `${root}/launch-day-watch-summary.md`,
          command: launchDutyCommand(paths, "launch_day_watch_summary", `${root}/launch-day-watch-summary.md`, [
            "record_cutover_walkthrough-receipt-id",
            "record_launch_day_readiness_review-receipt-id"
          ])
        },
        {
          key: "receipt_visibility_snapshot",
          expectedEvidence: "Receipt visibility snapshot after launch-day watch starts.",
          artifactPath: `${root}/receipt-visibility-snapshot.txt`,
          command: launchDutyCommand(paths, "receipt_visibility_snapshot", `${root}/receipt-visibility-snapshot.txt`, [
            "record_post_launch_ops_sweep-receipt-id"
          ])
        },
        {
          key: "first_wave_incident_log",
          expectedEvidence: "First-wave incident log or explicit no-incident statement.",
          artifactPath: `${root}/first-wave-incident-log.md`,
          command: launchDutyCommand(paths, "first_wave_incident_log", `${root}/first-wave-incident-log.md`, [
            "record_post_launch_ops_sweep-receipt-id"
          ])
        },
        {
          key: "rollback_signal_review",
          expectedEvidence: "Rollback signal review and decision.",
          artifactPath: `${root}/rollback-signal-review.md`,
          command: launchDutyCommand(paths, "rollback_signal_review", `${root}/rollback-signal-review.md`, [
            "record_rollback_walkthrough-receipt-id"
          ])
        },
        {
          key: "stabilization_owner_handoff",
          expectedEvidence: "Owner, next check time, and stabilization handoff notes.",
          artifactPath: `${root}/stabilization-owner-handoff.md`,
          command: launchDutyCommand(paths, "stabilization_owner_handoff", `${root}/stabilization-owner-handoff.md`, [
            "record_launch_stabilization_review-receipt-id"
          ])
        },
        {
          key: "first_wave_closeout",
          expectedEvidence: "Closeout decision, unresolved incidents, customer impact, and next-duty owner.",
          artifactPath: `${root}/first-wave-closeout.md`,
          command: launchDutyCommand(paths, "first_wave_closeout", `${root}/first-wave-closeout.md`, [
            "record_launch_closeout_review-receipt-id"
          ], firstWaveSources)
        }
      ]
    },
    {
      order: 6,
      key: "readiness_readback",
      title: "Readiness Readback",
      gate: "Run after each evidence batch to verify the next gate.",
      items: [
        {
          key: "staging_readiness_status",
          expectedEvidence: "Readiness output confirms the latest evidence row advanced.",
          artifactPath: paths.actionsFile,
          command: `npm.cmd run staging:readiness:status -- --input-file ${paths.closeoutInputFile} --actions-file ${paths.actionsFile}`
        },
        {
          key: "staging_rehearsal_reload",
          expectedEvidence: "Rehearsal reload confirms the current handoff and next action.",
          artifactPath: `${root}/staging-rehearsal-handoff.md`,
          command: `npm.cmd run staging:rehearsal -- --closeout-input-file ${paths.closeoutInputFile}`
        }
      ]
    }
  ];
}

function renderMarkdown(result) {
  const groups = result.evidenceGroups.map((group) => {
    const items = group.items.map((item) => [
      `### ${item.key}`,
      "",
      `Expected evidence: ${item.expectedEvidence}`,
      "",
      `Artifact: ${item.artifactPath || "-"}`,
      "",
      "```powershell",
      item.command,
      "```"
    ].join("\n")).join("\n\n");
    return [
      `## ${group.order}. ${group.title}`,
      "",
      `Gate: ${group.gate}`,
      "",
      items
    ].join("\n");
  }).join("\n\n");

  return [
    "# Windows Deploy Evidence Pack",
    "",
    `Generated: ${result.generatedAt}`,
    "",
    `Product: ${result.productCode}`,
    `Channel: ${result.channel}`,
    `Future Windows target: ${result.targetDirectory}`,
    `Artifact root: ${result.artifactRoot}`,
    "",
    "## Safety Boundary",
    "",
    "This pack is for evidence planning after manual start, local healthcheck, HTTPS, and required secret configuration. Generating it does not modify the target directory, call backend APIs, start services, run smoke tests, run full tests, or write evidence.",
    "",
    "Run these local preparation commands first:",
    "",
    "```powershell",
    "npm.cmd run deploy:windows:prepare-pack",
    "npm.cmd run deploy:windows:preflight",
    "```",
    "",
    "Core files:",
    "",
    `- Closeout input: \`${result.closeoutInputFile}\``,
    `- Actions file: \`${result.actionsFile}\``,
    `- Launch-duty record index: \`${result.launchDutyRecordIndexFile}\``,
    "",
    groups,
    ""
  ].join("\n");
}

function buildResult(options) {
  if (isSameOrInside(options.targetDir, options.outputFile)) {
    throw new Error("Generated pack output must stay outside the future target directory.");
  }
  const root = artifactRoot(options.productCode, options.channel);
  const paths = buildPaths(root);
  return {
    status: "prepared",
    mode: "windows-deploy-evidence-pack",
    generatedAt: new Date().toISOString(),
    generatedPackFile: options.outputFile,
    productCode: options.productCode,
    channel: options.channel,
    targetDirectory: options.targetDir,
    artifactRoot: root,
    closeoutInputFile: paths.closeoutInputFile,
    actionsFile: paths.actionsFile,
    launchDutyRecordIndexFile: paths.launchDutyRecordIndexFile,
    summary: {
      willModifyTargetDirectory: false,
      willCallBackend: false,
      willStartService: false,
      willRunSmoke: false,
      willRunFullTest: false,
      willWriteEvidence: false
    },
    evidenceGroups: buildEvidenceGroups(options),
    nextAction: "npm.cmd run deploy:windows:preflight"
  };
}

function writeHelp() {
  console.log([
    "Usage: npm.cmd run deploy:windows:evidence-pack -- [options]",
    "",
    "Options:",
    "  --product-code <code>  Product code for artifact paths. Defaults to FIRSTBATCH.",
    "  --channel <name>       Channel for artifact paths. Defaults to stable.",
    "  --target-dir <path>    Future Windows server install directory. Defaults to C:\\RockSolidLicense.",
    "  --output-file <path>   Secret-free Markdown evidence pack output file.",
    "  --json                 Print machine-readable JSON.",
    "  --help                 Print this help.",
    "",
    "This command only writes a secret-free evidence handoff pack."
  ].join("\n"));
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Windows deploy evidence pack: ${result.status}`);
  console.log(`Generated pack: ${result.generatedPackFile}`);
  console.log(`Product/channel: ${result.productCode}/${result.channel}`);
  console.log(`Artifact root: ${result.artifactRoot}`);
  console.log(`Evidence groups: ${result.evidenceGroups.map((item) => item.key).join(", ")}`);
  console.log(`Next action: ${result.nextAction}`);
}

function main() {
  let json = process.argv.includes("--json");
  try {
    const options = parseArgs(process.argv.slice(2));
    json = options.json;
    if (options.help) {
      writeHelp();
      return;
    }
    const result = buildResult(options);
    mkdirSync(path.dirname(result.generatedPackFile), { recursive: true });
    writeFileSync(result.generatedPackFile, renderMarkdown(result), "utf8");
    writeResult(result, json);
  } catch (error) {
    const result = {
      status: "fail",
      mode: "windows-deploy-evidence-pack",
      error: {
        message: error.message
      }
    };
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`Windows deploy evidence pack failed: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

main();
