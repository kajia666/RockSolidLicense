import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const args = [...argv];
  let cwd = "";

  while (args.length > 0) {
    const current = args[0];
    if (current === "--cwd") {
      args.shift();
      cwd = args.shift() || "";
      continue;
    }
    if (current === "--") {
      args.shift();
      break;
    }
    if (current.startsWith("--")) {
      throw new Error(`Unknown option: ${current}`);
    }
    break;
  }

  const filePath = args.shift();
  if (!filePath) {
    throw new Error("Missing file path.");
  }

  return { cwd, filePath, childArgs: args };
}

function buildDedupedEnv() {
  const keyed = new Map();

  for (const [name, value] of Object.entries(process.env)) {
    keyed.set(name.toLowerCase(), [name, value]);
  }

  const env = {};
  for (const [, [name, value]] of keyed) {
    env[name] = value;
  }
  return env;
}

function main() {
  const { cwd, filePath, childArgs } = parseArgs(process.argv.slice(2));
  const result = spawnSync(filePath, childArgs, {
    cwd: cwd || undefined,
    env: buildDedupedEnv(),
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }
  process.exit(result.status ?? 1);
}

main();
