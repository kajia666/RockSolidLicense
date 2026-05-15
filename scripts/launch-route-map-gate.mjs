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
  options.stagingBaseUrl = normalizeStagingBaseUrl(options.stagingBaseUrl);
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
    key: "staging_preflight_script",
    label: "Staging smoke preflight handoff continuity",
    command: "node",
    executable: process.execPath,
    args: [
      "--test",
      "--test-concurrency=1",
      "--test-isolation=none",
      "test/staging-preflight-script.test.js"
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

function normalizeStagingBaseUrl(value) {
  const text = String(value || "").trim().replace(/\/+$/, "");
  let parsed = null;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("--staging-base-url must be a valid https:// URL for launch:smoke:staging handoff.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("--staging-base-url must use https:// for launch:smoke:staging handoff.");
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

function buildRehearsalReloadCommand(filledCloseoutInputFile) {
  return `npm.cmd run staging:rehearsal -- --closeout-input-file ${commandValue(filledCloseoutInputFile)}`;
}

function buildCloseoutBackfillCommand({
  filledCloseoutInputFile,
  key,
  artifactPath,
  receiptIds = [],
  readinessActionQueueFile
}) {
  const receiptArgs = receiptIds.flatMap((receiptId) => [
    "--receipt-id",
    receiptId
  ]);
  return [
    "npm.cmd run staging:closeout:backfill --",
    "--input-file",
    commandValue(filledCloseoutInputFile),
    "--key",
    key,
    "--value-json",
    "<redacted-json>",
    "--artifact-path",
    commandValue(artifactPath),
    ...receiptArgs,
    "--actions-file",
    commandValue(readinessActionQueueFile)
  ].join(" ");
}

function buildLaunchDutyRecordCommand({
  filledCloseoutInputFile,
  key,
  artifactPath,
  receiptOperations = [],
  sourceRecords = [],
  launchDutyRecordIndexPath,
  readinessActionQueueFile
}) {
  const receiptArgs = receiptOperations.flatMap((operation) => [
    "--receipt-id",
    `<${operation}-receipt-id>`
  ]);
  const sourceRecordArgs = sourceRecords.flatMap((record) => [
    "--source-record",
    commandValue(`${record.key}=${record.artifactPath}`)
  ]);
  return [
    "npm.cmd run staging:launch-duty:record --",
    "--closeout-input-file",
    commandValue(filledCloseoutInputFile),
    "--key",
    key,
    "--artifact-path",
    commandValue(artifactPath),
    "--value-json",
    "<redacted-json>",
    ...receiptArgs,
    ...sourceRecordArgs,
    "--record-index-file",
    commandValue(launchDutyRecordIndexPath),
    "--actions-file",
    commandValue(readinessActionQueueFile)
  ].join(" ");
}

function buildLaunchSwitchWatchHandoff() {
  const artifactRoot = defaultArtifactRoot();
  const filledCloseoutInputFile = options.closeoutInputFile || defaultFilledCloseoutInputFile();
  const readinessActionQueueFile = options.actionsFile || defaultReadinessActionQueueFile();
  const launchDutyRecordIndexPath = defaultLaunchDutyRecordIndexFile();
  const credentialEnv = [
    "RSL_SMOKE_ADMIN_USERNAME",
    "RSL_SMOKE_ADMIN_PASSWORD",
    "RSL_SMOKE_DEVELOPER_USERNAME",
    "RSL_SMOKE_DEVELOPER_PASSWORD"
  ];
  const closeoutBackfill = buildRouteMapCloseoutBackfill();
  const receiptVisibilityQueue = buildLaunchSmokeReceiptVisibilityQueue();
  const currentCommand = buildReadinessStatusCommand(filledCloseoutInputFile, readinessActionQueueFile);
  const smokePreflightCommand = [
    "npm.cmd run staging:preflight --",
    "--base-url",
    commandValue(options.stagingBaseUrl),
    "--product-code",
    commandValue(options.productCode),
    "--channel",
    commandValue(options.channel)
  ].join(" ");
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
  const preSmokeOperatorCommands = [
    {
      key: "backfill_route_map_gate_result",
      label: "Backfill route-map gate result",
      status: "current",
      kind: "command",
      command: closeoutBackfill.command,
      targetKey: "route_map_gate_result",
      launchDutyRecordIndexPath,
      nextAction: "Run this after the route-map targeted gate passes, then refresh staging readiness."
    },
    {
      key: "refresh_staging_readiness_after_route_map",
      label: "Refresh staging readiness after route-map backfill",
      status: "blocked_after_route_map_backfill",
      kind: "command",
      command: currentCommand,
      targetKey: "staging_readiness_status",
      launchDutyRecordIndexPath,
      nextAction: "Confirm the action queue sees route_map_gate_result before live-write smoke."
    },
    {
      key: "run_staging_smoke_preflight",
      label: "Run staging smoke no-write preflight",
      status: "blocked_after_readiness_refresh",
      kind: "command",
      command: smokePreflightCommand,
      targetKey: "staging_smoke_preflight",
      launchDutyRecordIndexPath,
      nextAction: "Confirm HTTPS, non-default smoke credentials, explicit product/channel, and no-write readiness before live-write smoke."
    },
    {
      key: "run_launch_smoke_staging",
      label: "Run staging Launch Smoke live-write preflight",
      status: "blocked_after_smoke_preflight",
      kind: "command",
      command: launchSmokeCommand,
      targetKey: "live_write_smoke_result",
      launchDutyRecordIndexPath,
      nextAction: "Run only after staging:preflight passes, then use the smoke closeout-backfill handoff."
    }
  ].map((item, index) => ({
    order: index + 1,
    ...item
  }));
  const smokePrerequisites = {
    status: "ready_for_staging_launch_smoke_command",
    stagingBaseUrl: options.stagingBaseUrl,
    requireHttps: true,
    allowLiveWrites: true,
    credentialEnv,
    smokePreflightCommand,
    launchSmokeCommand,
    filledCloseoutInputFile,
    readinessActionQueueFile,
    nextAction: "Set smoke credential env vars, run smokePreflightCommand, then run launchSmokeCommand only after the no-write preflight passes."
  };
  const postSmokeCloseoutChecks = {
    status: "ready_for_post_smoke_closeout_confirmation",
    filledCloseoutInputFile,
    readinessActionQueueFile,
    statusCommand: currentCommand,
    actionQueueFile: readinessActionQueueFile,
    evidenceChecks: [
      {
        key: "live_write_smoke_result",
        label: "Confirm live-write smoke result was backfilled",
        status: "expected_after_launch_smoke",
        artifactPath: `${artifactRoot}/live-write-smoke-output.json`,
        receiptIds: ["<record_launch_rehearsal_run-receipt-id>"],
        statusCommand: currentCommand,
        nextAction: "Confirm the smoke output artifact path and live_write_smoke_result closeout value are present."
      },
      {
        key: "launch_smoke_handoff",
        label: "Confirm Launch Smoke handoff was archived",
        status: "expected_after_launch_smoke",
        artifactPath: `${artifactRoot}/launch-smoke-handoff.json`,
        receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"],
        statusCommand: currentCommand,
        nextAction: "Confirm the launch smoke handoff JSON is saved with secrets redacted."
      },
      {
        key: "launch_mainline_evidence_receipts",
        label: "Confirm Launch Mainline evidence receipts were captured",
        status: "expected_after_launch_smoke",
        artifactPath: `${artifactRoot}/launch-mainline-evidence-receipts.json`,
        receiptIds: ["<record_launch_rehearsal_run-receipt-id>"],
        statusCommand: currentCommand,
        nextAction: "Confirm Launch Mainline receipt IDs or handoff file names are backfilled."
      },
      {
        key: "receipt_visibility_review",
        label: "Confirm receipt visibility review was completed",
        status: "expected_after_receipt_visibility_review",
        artifactPath: `${artifactRoot}/receipt-visibility-review.txt`,
        receiptIds: ["<record_post_launch_ops_sweep-receipt-id>"],
        statusCommand: currentCommand,
        receiptVisibilityQueue,
        nextAction: "Verify the receipt-visibility download queue in order, then refresh staging readiness."
      }
    ].map((item, index) => ({
      order: index + 1,
      launchDutyRecordIndexPath,
      ...item,
      command: buildCloseoutBackfillCommand({
        filledCloseoutInputFile,
        key: item.key,
        artifactPath: item.artifactPath,
        receiptIds: item.receiptIds,
        readinessActionQueueFile
      })
    })),
    nextAction: "After launch smoke, verify these four closeout evidence records before entering full-test or production sign-off."
  };
  const postSmokeBackfillOperatorCommands = postSmokeCloseoutChecks.evidenceChecks.map((item, index) => {
    const blockedAfter = index === 0
      ? "launch_smoke"
      : postSmokeCloseoutChecks.evidenceChecks[index - 1].key;
    return {
      key: `backfill_post_smoke_${item.key}`,
      label: `Backfill post-smoke ${item.key}`,
      status: `blocked_after_${blockedAfter}`,
      kind: "command",
      command: item.command,
      targetKey: item.key,
      launchDutyRecordIndexPath,
      receiptIds: item.receiptIds,
      artifactPath: item.artifactPath,
      nextAction: item.nextAction
    };
  });
  const fullTestCommand = "npm.cmd test";
  const fullTestResultArtifactPath = `${artifactRoot}/full-test-output.txt`;
  const signoffBackfillCommand = [
    "npm.cmd run staging:signoff:backfill --",
    "--input-file",
    commandValue(filledCloseoutInputFile),
    "--condition-key",
    "full_test_window_passed",
    "--value-json",
    "<redacted-json>",
    "--artifact-path",
    commandValue(fullTestResultArtifactPath),
    "--decision",
    "ready-for-production-signoff",
    "--actions-file",
    commandValue(readinessActionQueueFile)
  ].join(" ");
  const postSmokeReadinessGate = {
    status: "ready_for_readiness_gate_after_post_smoke",
    statusCommand: currentCommand,
    actionQueueFile: readinessActionQueueFile,
    fullTestCommand,
    fullTestResultArtifactPath,
    signoffBackfillCommand,
    expectedGateProgression: [
      {
        order: 1,
        gate: "full_test_window",
        status: "current_after_post_smoke_closeout_confirmed",
        command: fullTestCommand,
        artifactPath: fullTestResultArtifactPath,
        nextAction: "Run the full test window only after post-smoke closeout checks are confirmed."
      },
      {
        order: 2,
        gate: "production_signoff",
        status: "blocked_after_full_test_window",
        command: signoffBackfillCommand,
        artifactPath: fullTestResultArtifactPath,
        nextAction: "Backfill full_test_window_passed with the redacted full-test result, then refresh readiness."
      },
      {
        order: 3,
        gate: "launch_day_watch",
        status: "blocked_after_production_signoff",
        command: currentCommand,
        artifactPath: null,
        nextAction: "After production sign-off evidence and receipt visibility are complete, refresh readiness for launch-day watch."
      }
    ],
    nextAction: "Use staging:readiness:status to confirm the gate before moving from post-smoke closeout into the full-test window."
  };
  const productionSignoffPacketPath = `${artifactRoot}/staging-production-signoff-packet.json`;
  const archiveIndexPath = `${artifactRoot}/staging-launch-duty-archive-index.json`;
  const launchDayWatchSummaryPath = `${artifactRoot}/launch-day-watch-summary.md`;
  const receiptVisibilitySnapshotPath = `${artifactRoot}/receipt-visibility-snapshot.txt`;
  const firstWaveIncidentLogPath = `${artifactRoot}/first-wave-incident-log.md`;
  const rollbackSignalReviewPath = `${artifactRoot}/rollback-signal-review.md`;
  const stabilizationOwnerHandoffPath = `${artifactRoot}/stabilization-owner-handoff.md`;
  const firstWaveCloseoutPath = `${artifactRoot}/first-wave-closeout.md`;
  const launchDayWatchCommand = [
    "npm.cmd run staging:launch-duty:record --",
    "--closeout-input-file",
    commandValue(filledCloseoutInputFile),
    "--key",
    "launch_day_watch_summary",
    "--artifact-path",
    commandValue(launchDayWatchSummaryPath),
    "--value-json",
    "<redacted-json>",
    "--receipt-id",
    "<record_cutover_walkthrough-receipt-id>",
    "--receipt-id",
    "<record_launch_day_readiness_review-receipt-id>",
    "--record-index-file",
    commandValue(launchDutyRecordIndexPath),
    "--actions-file",
    commandValue(readinessActionQueueFile)
  ].join(" ");
  const firstWaveCloseoutCommand = [
    "npm.cmd run staging:launch-duty:record --",
    "--closeout-input-file",
    commandValue(filledCloseoutInputFile),
    "--key",
    "first_wave_closeout",
    "--artifact-path",
    commandValue(firstWaveCloseoutPath),
    "--value-json",
    "<redacted-json>",
    "--receipt-id",
    "<record_launch_closeout_review-receipt-id>",
    "--record-index-file",
    commandValue(launchDutyRecordIndexPath),
    "--actions-file",
    commandValue(readinessActionQueueFile)
  ].join(" ");
  const closeoutSourceRecords = [
    { key: "first_wave_incident_log", artifactPath: firstWaveIncidentLogPath },
    { key: "rollback_signal_review", artifactPath: rollbackSignalReviewPath },
    { key: "stabilization_owner_handoff", artifactPath: stabilizationOwnerHandoffPath }
  ];
  const stabilizationRecordQueue = [
    {
      key: "receipt_visibility_snapshot",
      status: "blocked_after_launch_day_watch_summary",
      artifactPath: receiptVisibilitySnapshotPath,
      receiptOperations: ["record_post_launch_ops_sweep"],
      sourceRecordKeys: [],
      nextAction: "Save receipt visibility snapshots before incident and rollback review records."
    },
    {
      key: "first_wave_incident_log",
      status: "blocked_after_receipt_visibility_snapshot",
      artifactPath: firstWaveIncidentLogPath,
      receiptOperations: ["record_post_launch_ops_sweep"],
      sourceRecordKeys: [],
      nextAction: "Record first-wave incidents, impact, mitigation, owner, and status."
    },
    {
      key: "rollback_signal_review",
      status: "blocked_after_first_wave_incident_log",
      artifactPath: rollbackSignalReviewPath,
      receiptOperations: ["record_rollback_walkthrough", "record_launch_stabilization_review"],
      sourceRecordKeys: [],
      nextAction: "Record whether rollback signals were observed, dismissed, or escalated."
    },
    {
      key: "stabilization_owner_handoff",
      status: "blocked_after_rollback_signal_review",
      artifactPath: stabilizationOwnerHandoffPath,
      receiptOperations: ["record_launch_stabilization_review"],
      sourceRecordKeys: [],
      nextAction: "Record stabilization owner, unresolved items, and next-duty follow-up."
    },
    {
      key: "first_wave_closeout",
      status: "blocked_until_source_records",
      artifactPath: firstWaveCloseoutPath,
      receiptOperations: ["record_launch_closeout_review"],
      sourceRecordKeys: closeoutSourceRecords.map((record) => record.key),
      sourceRecords: closeoutSourceRecords,
      nextAction: "Close first-wave only after incident, rollback, and stabilization owner records are attached."
    }
  ].map((item, index) => ({
    order: index + 1,
    ...item,
    recordIndexFile: launchDutyRecordIndexPath,
    command: buildLaunchDutyRecordCommand({
      filledCloseoutInputFile,
      key: item.key,
      artifactPath: item.artifactPath,
      receiptOperations: item.receiptOperations,
      sourceRecords: item.sourceRecords || [],
      launchDutyRecordIndexPath,
      readinessActionQueueFile
    })
  }));
  const productionSignoffLaunchDayWatch = {
    status: "ready_for_launch_day_watch_after_production_signoff",
    currentGate: "production_signoff",
    nextGate: "launch_day_watch",
    productionSignoffPacketPath,
    archiveIndexPath,
    recordIndexFile: launchDutyRecordIndexPath,
    statusCommand: currentCommand,
    stabilizationRecordQueueStatus: "ready_after_launch_day_watch_summary",
    stabilizationCloseoutKey: "first_wave_closeout",
    recordCommands: [
      {
        order: 1,
        key: "launch_day_watch_summary",
        status: "current_after_production_signoff",
        artifactPath: launchDayWatchSummaryPath,
        command: launchDayWatchCommand,
        receiptOperations: ["record_cutover_walkthrough", "record_launch_day_readiness_review"],
        sourceRecordKeys: [],
        nextAction: "Record launch-day watch summary after production sign-off is confirmed."
      },
      {
        order: 2,
        key: "first_wave_closeout",
        status: "blocked_after_launch_day_watch_summary",
        artifactPath: firstWaveCloseoutPath,
        command: firstWaveCloseoutCommand,
        receiptOperations: ["record_launch_closeout_review"],
        sourceRecordKeys: ["first_wave_incident_log", "rollback_signal_review", "stabilization_owner_handoff"],
        nextAction: "Close first wave only after incident, rollback, and stabilization owner source records are attached."
      }
    ],
    stabilizationRecordQueue,
    nextAction: "After production sign-off, record launch_day_watch_summary first, then write stabilization records and close the first wave with required source records."
  };
  const stableOperationsHandoff = {
    status: "blocked_until_first_wave_closeout_recorded",
    recordIndexFile: launchDutyRecordIndexPath,
    firstWaveCloseoutArtifactPath: firstWaveCloseoutPath,
    readinessStatusCommand: currentCommand,
    rehearsalReloadCommand: buildRehearsalReloadCommand(filledCloseoutInputFile),
    handoffArtifacts: [launchDutyRecordIndexPath, firstWaveCloseoutPath],
    nextAction: "After first_wave_closeout records 6/6, refresh readiness, reload rehearsal, then hand off the completed record index and first-wave closeout artifact to stable operations."
  };
  productionSignoffLaunchDayWatch.stableOperationsHandoff = stableOperationsHandoff;
  const launchDayWatchOperatorCommands = [
    {
      key: "record_launch_day_watch_summary",
      label: "Record launch-day watch summary",
      status: "blocked_after_production_signoff",
      kind: "command",
      command: productionSignoffLaunchDayWatch.recordCommands[0].command,
      targetKey: "launch_day_watch_summary",
      launchDutyRecordIndexPath,
      receiptOperations: productionSignoffLaunchDayWatch.recordCommands[0].receiptOperations,
      sourceRecordKeys: productionSignoffLaunchDayWatch.recordCommands[0].sourceRecordKeys,
      artifactPath: productionSignoffLaunchDayWatch.recordCommands[0].artifactPath,
      nextAction: productionSignoffLaunchDayWatch.recordCommands[0].nextAction
    },
    ...productionSignoffLaunchDayWatch.stabilizationRecordQueue.map((item) => ({
      key: `record_stabilization_${item.key}`,
      label: `Record stabilization ${item.key}`,
      status: item.status,
      kind: "command",
      command: item.command,
      targetKey: item.key,
      launchDutyRecordIndexPath,
      receiptOperations: item.receiptOperations,
      sourceRecordKeys: item.sourceRecordKeys,
      sourceRecords: item.sourceRecords || [],
      artifactPath: item.artifactPath,
      nextAction: item.nextAction
    })),
    {
      key: "refresh_staging_readiness_after_first_wave_closeout",
      label: "Refresh staging readiness after first-wave closeout",
      status: "blocked_after_first_wave_closeout",
      kind: "command",
      command: stableOperationsHandoff.readinessStatusCommand,
      targetKey: "stable_operations_handoff",
      launchDutyRecordIndexPath,
      artifactPath: readinessActionQueueFile,
      nextAction: "Refresh readiness after first_wave_closeout so the completed launch-duty record index is recognized as stable_operations_handoff."
    },
    {
      key: "reload_staging_rehearsal_for_stable_operations",
      label: "Reload staging rehearsal for stable operations",
      status: "blocked_after_stable_operations_readiness",
      kind: "command",
      command: stableOperationsHandoff.rehearsalReloadCommand,
      targetKey: "stable_operations_handoff",
      launchDutyRecordIndexPath,
      artifactPath: firstWaveCloseoutPath,
      nextAction: "Reload rehearsal so final packet, operator execution plan, and go-live entry show stable_operations_handoff."
    },
    {
      key: "handoff_stable_operations",
      label: "Hand off stable operations",
      status: "blocked_after_rehearsal_reload",
      kind: "handoff",
      command: null,
      targetKey: "stable_operations_handoff",
      launchDutyRecordIndexPath,
      artifactPath: firstWaveCloseoutPath,
      handoffArtifacts: stableOperationsHandoff.handoffArtifacts,
      nextAction: "Hand off the completed record index and first-wave closeout artifact to the stable-operations owner."
    }
  ];
  const operatorNextCommands = [
    ...preSmokeOperatorCommands,
    ...postSmokeBackfillOperatorCommands,
    {
      key: "refresh_staging_readiness_after_post_smoke_backfill",
      label: "Refresh staging readiness after post-smoke backfill",
      status: "blocked_after_post_smoke_backfill",
      kind: "command",
      command: currentCommand,
      targetKey: "staging_readiness_status",
      launchDutyRecordIndexPath,
      nextAction: "Confirm post-smoke backfills are reflected before full-test, production sign-off, or launch-day watch."
    },
    {
      key: "verify_receipt_visibility_queue",
      label: "Verify Launch Smoke receipt visibility queue",
      status: "blocked_after_post_smoke_backfill",
      kind: "download_queue",
      target: receiptVisibilityQueue[0]?.target || null,
      queue: receiptVisibilityQueue,
      targetKey: "receipt_visibility_review",
      launchDutyRecordIndexPath,
      nextAction: "Open the queue in order after receipt visibility is backfilled."
    },
    {
      key: "run_full_test_window",
      label: "Run full test window",
      status: "blocked_after_receipt_visibility_review",
      kind: "command",
      command: postSmokeReadinessGate.fullTestCommand,
      targetKey: "full_test_window",
      launchDutyRecordIndexPath,
      artifactPath: postSmokeReadinessGate.fullTestResultArtifactPath,
      nextAction: postSmokeReadinessGate.expectedGateProgression[0].nextAction
    },
    {
      key: "backfill_full_test_window_passed",
      label: "Backfill full test window sign-off",
      status: "blocked_after_full_test_window",
      kind: "command",
      command: postSmokeReadinessGate.signoffBackfillCommand,
      targetKey: "full_test_window_passed",
      launchDutyRecordIndexPath,
      artifactPath: postSmokeReadinessGate.fullTestResultArtifactPath,
      nextAction: postSmokeReadinessGate.expectedGateProgression[1].nextAction
    },
    {
      key: "refresh_staging_readiness_for_production_signoff",
      label: "Refresh staging readiness for production sign-off",
      status: "blocked_after_full_test_window_backfill",
      kind: "command",
      command: postSmokeReadinessGate.expectedGateProgression[2].command,
      targetKey: "production_signoff",
      launchDutyRecordIndexPath,
      nextAction: postSmokeReadinessGate.expectedGateProgression[2].nextAction
    },
    ...launchDayWatchOperatorCommands
  ].map((item, index) => ({
    order: index + 1,
    ...item
  }));
  return {
    version: "launch-route-map-gate-switch-watch-handoff/v1",
    status: "ready_for_staging_readiness_and_launch_smoke_switch",
    currentActionKey: "refresh_staging_readiness",
    currentCommand,
    nextActionKey: "run_staging_smoke_preflight",
    smokePreflightCommand,
    liveWriteActionKey: "run_launch_smoke_staging",
    launchSmokeCommand,
    credentialEnv,
    smokePrerequisites,
    postSmokeCloseoutChecks,
    postSmokeReadinessGate,
    productionSignoffLaunchDayWatch,
    filledCloseoutInputFile,
    readinessActionQueueFile,
    launchDutyRecordIndexPath,
    backfillSequence,
    operatorNextCommands,
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
    console.log(`Launch switch next: ${launchSwitchWatchHandoff.nextActionKey} -> ${launchSwitchWatchHandoff.smokePreflightCommand}`);
    console.log(`Launch switch live-write smoke: ${launchSwitchWatchHandoff.liveWriteActionKey} -> ${launchSwitchWatchHandoff.launchSmokeCommand}`);
    console.log(`Launch switch evidence sequence: ${launchSwitchWatchHandoff.backfillSequence.map((item) => item.key).join(" -> ")}`);
    console.log(`Launch switch credential env: ${launchSwitchWatchHandoff.credentialEnv.join(", ")}`);
    console.log(
      `Launch switch smoke prerequisites: ${launchSwitchWatchHandoff.smokePrerequisites.status}`
      + ` | https=${launchSwitchWatchHandoff.smokePrerequisites.requireHttps ? "yes" : "no"}`
      + ` | allowLiveWrites=${launchSwitchWatchHandoff.smokePrerequisites.allowLiveWrites ? "yes" : "no"}`
      + ` | baseUrl=${launchSwitchWatchHandoff.smokePrerequisites.stagingBaseUrl}`
      + ` | preflight=${launchSwitchWatchHandoff.smokePrerequisites.smokePreflightCommand}`
    );
    console.log(
      `Launch switch post-smoke checks: ${launchSwitchWatchHandoff.postSmokeCloseoutChecks.status}`
      + ` | statusCommand=${launchSwitchWatchHandoff.postSmokeCloseoutChecks.statusCommand}`
    );
    for (const item of launchSwitchWatchHandoff.postSmokeCloseoutChecks.evidenceChecks) {
      const queueText = item.receiptVisibilityQueue ? ` | queue=${item.receiptVisibilityQueue.length}` : "";
      console.log(`Post-smoke check ${item.order}. ${item.key}: ${item.status} -> ${item.artifactPath}${queueText}`);
    }
    for (const item of launchSwitchWatchHandoff.postSmokeCloseoutChecks.evidenceChecks) {
      const queueText = item.receiptVisibilityQueue ? ` | queue=${item.receiptVisibilityQueue.length}` : "";
      console.log(`Post-smoke backfill ${item.order}. ${item.key}: ${item.status} -> ${item.command}${queueText}`);
    }
    console.log(
      `Launch switch readiness gate: ${launchSwitchWatchHandoff.postSmokeReadinessGate.status}`
      + ` | statusCommand=${launchSwitchWatchHandoff.postSmokeReadinessGate.statusCommand}`
    );
    for (const item of launchSwitchWatchHandoff.postSmokeReadinessGate.expectedGateProgression) {
      const artifactText = item.artifactPath ? ` | artifact=${item.artifactPath}` : "";
      console.log(`Readiness gate ${item.order}. ${item.gate}: ${item.status} -> ${item.command}${artifactText}`);
    }
    console.log(
      `Launch switch launch-day watch: ${launchSwitchWatchHandoff.productionSignoffLaunchDayWatch.status}`
      + ` | packet=${launchSwitchWatchHandoff.productionSignoffLaunchDayWatch.productionSignoffPacketPath}`
      + ` | recordIndex=${launchSwitchWatchHandoff.productionSignoffLaunchDayWatch.recordIndexFile}`
    );
    for (const item of launchSwitchWatchHandoff.productionSignoffLaunchDayWatch.recordCommands) {
      const sourceText = item.sourceRecordKeys?.length ? ` | sources=${item.sourceRecordKeys.join(", ")}` : "";
      console.log(`Launch-day watch ${item.order}. ${item.key}: ${item.status} -> ${item.command}${sourceText}`);
    }
    console.log(
      `Launch switch stabilization record queue: ${launchSwitchWatchHandoff.productionSignoffLaunchDayWatch.stabilizationRecordQueueStatus}`
      + ` | records=${launchSwitchWatchHandoff.productionSignoffLaunchDayWatch.stabilizationRecordQueue.length}`
      + ` | closeout=${launchSwitchWatchHandoff.productionSignoffLaunchDayWatch.stabilizationCloseoutKey}`
    );
    for (const item of launchSwitchWatchHandoff.productionSignoffLaunchDayWatch.stabilizationRecordQueue) {
      const sourceText = item.sourceRecordKeys?.length ? ` | sources=${item.sourceRecordKeys.join(", ")}` : "";
      console.log(`Stabilization record ${item.order}. ${item.key}: ${item.status} -> ${item.command}${sourceText}`);
    }
    const stableOperationsHandoff = launchSwitchWatchHandoff.productionSignoffLaunchDayWatch.stableOperationsHandoff;
    console.log(
      `Launch switch stable-operations handoff: ${stableOperationsHandoff.status}`
      + ` | readiness=${stableOperationsHandoff.readinessStatusCommand}`
      + ` | rehearsal=${stableOperationsHandoff.rehearsalReloadCommand}`
    );
    console.log(`Launch switch record index: ${launchSwitchWatchHandoff.launchDutyRecordIndexPath}`);
    console.log("Launch switch operator queue:");
    for (const item of launchSwitchWatchHandoff.operatorNextCommands) {
      if (item.kind === "download_queue") {
        console.log(
          `${item.order}. ${item.key}: ${item.status} ${item.kind} -> first=${item.target || "-"}`
          + ` | count=${item.queue?.length || 0}`
        );
      } else {
        console.log(`${item.order}. ${item.key}: ${item.status} ${item.kind} -> ${item.command || "-"}`);
      }
    }
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
