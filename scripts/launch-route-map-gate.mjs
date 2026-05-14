#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const rawArgs = process.argv.slice(2);
const dryRun = rawArgs.includes("--dry-run");
const json = rawArgs.includes("--json");
const help = rawArgs.includes("--help") || rawArgs.includes("-h");

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

function parseOptions(argv) {
  const options = {
    productCode: "ROUTE_MAP_GATE",
    channel: "stable",
    stagingBaseUrl: "https://staging.example.com",
    closeoutInputFile: null,
    actionsFile: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--dry-run", "--json", "--help", "-h"].includes(arg)) {
      continue;
    }
    const [name, inlineValue] = arg.split("=", 2);
    const value = requireArgValue(name, inlineValue ?? argv[index + 1], inlineValue);
    if (name === "--product-code") {
      options.productCode = value.toUpperCase();
    } else if (name === "--channel") {
      options.channel = value.toLowerCase();
    } else if (name === "--staging-base-url") {
      options.stagingBaseUrl = value;
    } else if (name === "--closeout-input-file") {
      options.closeoutInputFile = value;
    } else if (name === "--actions-file") {
      options.actionsFile = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (inlineValue === undefined) {
      index += 1;
    }
  }
  return options;
}

const options = parseOptions(rawArgs);

const launchMainlinePattern = [
  "developer ops export bundles scoped data and downloadable assets",
  "developer launch mainline action can record a first-wave ops sweep and refresh post-launch evidence",
  "developer license quickstart first-batch setup can create recommended launch card batches"
].join("|");

const launchDownloadSurfacePattern = [
  "developer release package export bundles integration, versions, and notices inside scope",
  "developer first-wave recommendations summarize launch inventory, card issuance, and ops actions",
  "developer integration package export is scoped and includes cpp quickstart snippets",
  "developer operators can manage scoped authorization operations for assigned projects",
  "admin ops export bundles platform snapshots and filtered downloadable assets"
].join("|");

const commands = [
  {
    key: "launch_mainline_action_visibility",
    label: "Launch Mainline action receipt visibility",
    command: "node",
    executable: process.execPath,
    args: [
      "--test",
      "--test-concurrency=1",
      "--test-isolation=none",
      "test/launch-mainline-action-visibility.test.js"
    ]
  },
  {
    key: "launch_route_map_gate_script",
    label: "Launch route-map gate script continuity",
    command: "node",
    executable: process.execPath,
    args: [
      "--test",
      "--test-concurrency=1",
      "--test-isolation=none",
      "test/launch-route-map-gate-script.test.js"
    ]
  },
  {
    key: "recovery_preflight_script",
    label: "Recovery preflight closeout handoff continuity",
    command: "node",
    executable: process.execPath,
    args: [
      "--test",
      "--test-concurrency=1",
      "--test-isolation=none",
      "test/recovery-preflight-script.test.js"
    ]
  },
  {
    key: "developer_ops_export_and_mainline_action",
    label: "Developer Ops export, Launch Mainline action, and first-batch runtime evidence",
    command: "node",
    executable: process.execPath,
    args: [
      "--test",
      "--test-concurrency=1",
      "--test-isolation=none",
      "--test-name-pattern",
      launchMainlinePattern,
      "test/license-flow.test.js"
    ]
  },
  {
    key: "launch_download_surface_audit",
    label: "Low-frequency launch download surface audit",
    command: "node",
    executable: process.execPath,
    args: [
      "--test",
      "--test-concurrency=1",
      "--test-isolation=none",
      "--test-name-pattern",
      launchDownloadSurfacePattern,
      "test/license-flow.test.js"
    ]
  },
  {
    key: "launch_smoke_script",
    label: "Launch Smoke script handoff continuity",
    command: "node",
    executable: process.execPath,
    args: [
      "--test",
      "--test-concurrency=1",
      "--test-isolation=none",
      "test/launch-smoke-script.test.js"
    ]
  },
  {
    key: "staging_profile_init_script",
    label: "Staging profile init handoff continuity",
    command: "node",
    executable: process.execPath,
    args: [
      "--test",
      "--test-concurrency=1",
      "--test-isolation=none",
      "test/staging-profile-init-script.test.js"
    ]
  },
  {
    key: "staging_closeout_init_script",
    label: "Staging closeout init handoff continuity",
    command: "node",
    executable: process.execPath,
    args: [
      "--test",
      "--test-concurrency=1",
      "--test-isolation=none",
      "test/staging-closeout-init-script.test.js"
    ]
  },
  {
    key: "staging_closeout_backfill_script",
    label: "Staging closeout backfill handoff continuity",
    command: "node",
    executable: process.execPath,
    args: [
      "--test",
      "--test-concurrency=1",
      "--test-isolation=none",
      "test/staging-closeout-backfill-script.test.js"
    ]
  },
  {
    key: "staging_signoff_backfill_script",
    label: "Staging signoff backfill handoff continuity",
    command: "node",
    executable: process.execPath,
    args: [
      "--test",
      "--test-concurrency=1",
      "--test-isolation=none",
      "test/staging-signoff-backfill-script.test.js"
    ]
  },
  {
    key: "staging_readiness_status_script",
    label: "Staging readiness status next-step continuity",
    command: "node",
    executable: process.execPath,
    args: [
      "--test",
      "--test-concurrency=1",
      "--test-isolation=none",
      "test/staging-readiness-status-script.test.js"
    ]
  },
  {
    key: "staging_launch_duty_record_script",
    label: "Staging launch-duty record artifact continuity",
    command: "node",
    executable: process.execPath,
    args: [
      "--test",
      "--test-concurrency=1",
      "--test-isolation=none",
      "test/staging-launch-duty-record-script.test.js"
    ]
  },
  {
    key: "staging_rehearsal_syntax_check",
    label: "Staging rehearsal script syntax check",
    command: "node",
    executable: process.execPath,
    args: ["--check", "scripts/staging-rehearsal.mjs"]
  },
  {
    key: "staging_rehearsal_script",
    label: "Staging rehearsal handoff continuity",
    command: "node",
    executable: process.execPath,
    args: [
      "--test",
      "--test-concurrency=1",
      "--test-isolation=none",
      "test/staging-rehearsal-script.test.js"
    ]
  },
  {
    key: "services_syntax_check",
    label: "Services syntax check",
    command: "node",
    executable: process.execPath,
    args: ["--check", "src/services.js"]
  },
  {
    key: "diff_whitespace_check",
    label: "Git diff whitespace check",
    command: "git",
    executable: "git",
    args: ["diff", "--check"]
  }
];

function quoteArg(arg) {
  if (/^[A-Za-z0-9_./:=\\-]+$/.test(arg)) {
    return arg;
  }
  return `"${arg.replaceAll('"', '\\"')}"`;
}

function commandLine(command) {
  return [command.command, ...command.args].map(quoteArg).join(" ");
}

function publicCommand(command) {
  return {
    key: command.key,
    label: command.label,
    command: command.command,
    args: command.args,
    commandLine: commandLine(command)
  };
}

function commandValue(value) {
  const text = String(value || "");
  if (/[\s"`]/.test(text)) {
    return `"${text.replace(/"/g, "`\"")}"`;
  }
  return text;
}

function defaultArtifactRoot() {
  return `artifacts/staging/${options.productCode}/${options.channel}`;
}

function defaultFilledCloseoutInputFile() {
  return `${defaultArtifactRoot()}/filled-closeout-input.json`;
}

function defaultReadinessActionQueueFile() {
  return `${defaultArtifactRoot()}/readiness-action-queue.md`;
}

function defaultLaunchDutyRecordIndexFile() {
  return `${defaultArtifactRoot()}/launch-duty-record-index.json`;
}

function buildLaunchSmokeReceiptVisibilityQueue() {
  const productCode = options.productCode;
  const channel = options.channel;
  const launchDutyRecordIndexPath = defaultLaunchDutyRecordIndexFile();
  const downloads = [
    {
      key: "verify_launch_review_receipt_visibility",
      label: "Verify Launch Review receipt visibility",
      target: `/api/developer/launch-review/download?productCode=${productCode}&channel=${channel}&source=launch-smoke&handoff=first-wave&format=summary`
    },
    {
      key: "verify_launch_smoke_receipt_visibility",
      label: "Verify Launch Smoke receipt visibility",
      target: `/api/developer/launch-smoke-kit/download?productCode=${productCode}&channel=${channel}&operation=record_post_launch_ops_sweep&downloadKey=launch_smoke_summary&format=summary`
    },
    {
      key: "verify_launch_ops_overview_status",
      label: "Verify Launch Ops overview status",
      target: `/api/developer/ops/export/download?productCode=${productCode}&format=launch-operations-overview-status&limit=20`
    },
    {
      key: "verify_mainline_route_map_overview_evidence",
      label: "Verify Mainline route map overview evidence",
      target: `/api/developer/launch-mainline/download?productCode=${productCode}&channel=${channel}&source=launch-smoke&handoff=first-wave&format=handoff-download-routes`
    },
    {
      key: "download_ops_handoff_index",
      label: "Download Ops handoff index",
      target: `/api/developer/ops/export/download?productCode=${productCode}&format=handoff-index&limit=20`
    }
  ];
  return downloads.map((item, index) => ({
    order: index + 1,
    key: item.key,
    label: item.label,
    status: index === 0 ? "current" : "next",
    kind: "download",
    target: item.target,
    launchDutyRecordIndexPath
  }));
}

function buildRouteMapCloseoutBackfill() {
  const artifactRoot = defaultArtifactRoot();
  const filledCloseoutInputFile = options.closeoutInputFile || defaultFilledCloseoutInputFile();
  const readinessActionQueueFile = options.actionsFile || defaultReadinessActionQueueFile();
  const artifactPath = `${artifactRoot}/route-map-gate-output.txt`;
  const command = [
    "npm.cmd run staging:closeout:backfill --",
    "--input-file",
    commandValue(filledCloseoutInputFile),
    "--key",
    "route_map_gate_result",
    "--value-json",
    "<redacted-json>",
    "--artifact-path",
    commandValue(artifactPath),
    "--receipt-id",
    "<route-map-gate-receipt-id>",
    "--actions-file",
    commandValue(readinessActionQueueFile)
  ].join(" ");
  const statusCommand = buildReadinessStatusCommand(filledCloseoutInputFile, readinessActionQueueFile);
  return {
    version: "launch-route-map-gate-closeout-backfill/v1",
    status: "ready_for_route_map_gate_backfill",
    key: "route_map_gate_result",
    filledCloseoutInputFile,
    readinessActionQueueFile,
    artifactPath,
    command,
    statusCommand,
    nextAction: "After the route-map gate passes, backfill route_map_gate_result, then refresh staging readiness status."
  };
}

function buildReadinessStatusCommand(filledCloseoutInputFile, readinessActionQueueFile) {
  return [
    "npm.cmd run staging:readiness:status --",
    "--input-file",
    commandValue(filledCloseoutInputFile),
    "--actions-file",
    commandValue(readinessActionQueueFile)
  ].join(" ");
}

function buildLaunchSwitchWatchHandoff() {
  const filledCloseoutInputFile = options.closeoutInputFile || defaultFilledCloseoutInputFile();
  const readinessActionQueueFile = options.actionsFile || defaultReadinessActionQueueFile();
  const launchDutyRecordIndexPath = defaultLaunchDutyRecordIndexFile();
  const currentCommand = buildReadinessStatusCommand(filledCloseoutInputFile, readinessActionQueueFile);
  const launchSmokeCommand = [
    "npm.cmd run launch:smoke:staging --",
    "--base-url",
    commandValue(options.stagingBaseUrl),
    "--allow-live-writes",
    "--product-code",
    commandValue(options.productCode),
    "--channel",
    commandValue(options.channel),
    "--closeout-input-file",
    commandValue(filledCloseoutInputFile),
    "--actions-file",
    commandValue(readinessActionQueueFile)
  ].join(" ");
  const backfillSequence = [
    {
      key: "route_map_gate_result",
      label: "Route-map targeted gate result",
      status: "current",
      source: "launch-route-map-gate"
    },
    {
      key: "live_write_smoke_result",
      label: "Remote live-write smoke result",
      status: "blocked_until_launch_smoke",
      source: "launch-smoke closeout backfill"
    },
    {
      key: "launch_smoke_handoff",
      label: "Launch Smoke handoff archive",
      status: "blocked_until_launch_smoke",
      source: "launch-smoke closeout backfill"
    },
    {
      key: "launch_mainline_evidence_receipts",
      label: "Launch Mainline evidence receipts",
      status: "blocked_until_launch_smoke",
      source: "launch-smoke closeout backfill"
    },
    {
      key: "receipt_visibility_review",
      label: "Receipt visibility review",
      status: "blocked_until_receipt_visibility_review",
      source: "launch-smoke receipt visibility queue"
    }
  ].map((item, index) => ({
    order: index + 1,
    ...item,
    launchDutyRecordIndexPath
  }));
  return {
    version: "launch-route-map-gate-switch-watch-handoff/v1",
    status: "ready_for_staging_readiness_and_launch_smoke_switch",
    currentActionKey: "refresh_staging_readiness",
    currentCommand,
    nextActionKey: "run_launch_smoke_staging",
    launchSmokeCommand,
    credentialEnv: [
      "RSL_SMOKE_DEVELOPER_USERNAME",
      "RSL_SMOKE_DEVELOPER_PASSWORD"
    ],
    filledCloseoutInputFile,
    readinessActionQueueFile,
    launchDutyRecordIndexPath,
    backfillSequence,
    nextAction: "Refresh staging readiness after route_map_gate_result is backfilled, then run launchSmokeCommand with staging smoke credentials to produce the remaining closeout and receipt-visibility evidence."
  };
}

function payload(status = "pass") {
  return {
    status,
    mode: "launch-route-map-gate",
    dryRun,
    summary: {
      commandCount: commands.length,
      willRunFullSuite: false,
      scope: "Launch Mainline / Launch Smoke / Developer Ops route-map visibility, first-batch runtime evidence, and launch download surface targeted gate"
    },
    closeoutBackfill: buildRouteMapCloseoutBackfill(),
    launchSwitchWatchHandoff: buildLaunchSwitchWatchHandoff(),
    launchSmokeReceiptVisibilityQueue: buildLaunchSmokeReceiptVisibilityQueue(),
    commands: commands.map(publicCommand)
  };
}

function printHelp() {
  const lines = [
    "Usage: npm run launch:route-map-gate -- [--dry-run] [--json]",
    "",
    "Runs the targeted launch route-map visibility gate without invoking the full repository suite.",
    "",
    "Options:",
    "  --dry-run  Print the commands without executing them.",
    "  --json     Print machine-readable output. Intended for --dry-run.",
    "  --product-code <code>  Product code used for default staging artifact paths.",
    "  --channel <channel>    Channel used for default staging artifact paths.",
    "  --staging-base-url <url>  Base URL used in the staging Launch Smoke command template.",
    "  --closeout-input-file <path>  Override the filled closeout input path.",
    "  --actions-file <path>  Override the readiness action queue path.",
    "  --help     Show this help."
  ];
  console.log(lines.join("\n"));
}

if (help) {
  printHelp();
  process.exit(0);
}

if (dryRun) {
  if (json) {
    console.log(JSON.stringify(payload(), null, 2));
  } else {
    const closeoutBackfill = buildRouteMapCloseoutBackfill();
    const launchSwitchWatchHandoff = buildLaunchSwitchWatchHandoff();
    const launchSmokeReceiptVisibilityQueue = buildLaunchSmokeReceiptVisibilityQueue();
    console.log("Launch route-map targeted gate dry run:");
    console.log(`Route-map closeout backfill current: ${closeoutBackfill.key}`);
    console.log(`Route-map closeout backfill command: ${closeoutBackfill.command}`);
    console.log(`Route-map readiness status: ${closeoutBackfill.statusCommand}`);
    console.log(`Launch switch watch handoff: ${launchSwitchWatchHandoff.status}`);
    console.log(`Launch switch current: ${launchSwitchWatchHandoff.currentActionKey} -> ${launchSwitchWatchHandoff.currentCommand}`);
    console.log(`Launch switch next: ${launchSwitchWatchHandoff.nextActionKey} -> ${launchSwitchWatchHandoff.launchSmokeCommand}`);
    console.log(`Launch switch evidence sequence: ${launchSwitchWatchHandoff.backfillSequence.map((item) => item.key).join(" -> ")}`);
    console.log(`Launch switch credential env: ${launchSwitchWatchHandoff.credentialEnv.join(", ")}`);
    console.log(`Launch switch record index: ${launchSwitchWatchHandoff.launchDutyRecordIndexPath}`);
    console.log("Launch Smoke receipt visibility queue:");
    for (const item of launchSmokeReceiptVisibilityQueue) {
      console.log(
        `${item.order}. ${item.key}: ${item.status} ${item.kind} -> ${item.target}`
        + ` | recordIndex=${item.launchDutyRecordIndexPath}`
      );
    }
    for (const [index, command] of commands.entries()) {
      console.log(`${index + 1}. ${command.label}`);
      console.log(`   ${commandLine(command)}`);
    }
  }
  process.exit(0);
}

if (json) {
  console.error("--json is only supported together with --dry-run for this gate.");
  process.exit(1);
}

for (const [index, command] of commands.entries()) {
  console.log(`\n[${index + 1}/${commands.length}] ${command.label}`);
  console.log(commandLine(command));

  const result = spawnSync(command.executable, command.args, {
    cwd: repoRoot,
    stdio: "inherit"
  });

  if (result.error) {
    console.error(`Failed to run ${command.key}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("\nLaunch route-map targeted gate passed.");
