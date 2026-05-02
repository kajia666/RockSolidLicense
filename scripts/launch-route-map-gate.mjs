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
    console.log("Launch route-map targeted gate dry run:");
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
