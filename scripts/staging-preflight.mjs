#!/usr/bin/env node

const DEFAULT_PRODUCT_CODE = "LAUNCH_SMOKE";
const DEFAULT_ADMIN_PASSWORDS = new Set(["Pass123!abc", "ChangeMe!123"]);
const DEFAULT_DEVELOPER_PASSWORDS = new Set(["LaunchSmokeOwner123!"]);

function parseArgs(argv) {
  const options = {
    json: false,
    baseUrl: null,
    productCode: null,
    channel: null,
    adminUsername: null,
    adminPassword: null,
    developerUsername: null,
    developerPassword: null
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
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }
    if (name === "--product-code") {
      options.productCode = requireArgValue(name, value, inlineValue);
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }
    if (name === "--channel") {
      options.channel = requireArgValue(name, value, inlineValue);
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }
    if (name === "--admin-username") {
      options.adminUsername = requireArgValue(name, value, inlineValue);
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }
    if (name === "--admin-password") {
      options.adminPassword = requireArgValue(name, value, inlineValue);
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }
    if (name === "--developer-username") {
      options.developerUsername = requireArgValue(name, value, inlineValue);
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }
    if (name === "--developer-password") {
      options.developerPassword = requireArgValue(name, value, inlineValue);
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return {
    ...options,
    baseUrl: readOptionOrEnv(options.baseUrl, "RSL_STAGING_BASE_URL"),
    productCode: readOptionOrEnv(options.productCode, "RSL_SMOKE_PRODUCT_CODE"),
    channel: readOptionOrEnv(options.channel, "RSL_SMOKE_CHANNEL") ?? "stable",
    adminUsername: readOptionOrEnv(options.adminUsername, "RSL_SMOKE_ADMIN_USERNAME"),
    adminPassword: readOptionOrEnv(options.adminPassword, "RSL_SMOKE_ADMIN_PASSWORD"),
    developerUsername: readOptionOrEnv(options.developerUsername, "RSL_SMOKE_DEVELOPER_USERNAME"),
    developerPassword: readOptionOrEnv(options.developerPassword, "RSL_SMOKE_DEVELOPER_PASSWORD")
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

function normalizeHttpsBaseUrl(value) {
  if (!value) {
    return null;
  }
  const raw = String(value).trim();
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function makeCheck(name, passed, message) {
  return {
    name,
    status: passed ? "pass" : "fail",
    message
  };
}

function validateOptions(options) {
  const checks = [];
  const baseUrl = normalizeHttpsBaseUrl(options.baseUrl);
  const productCode = String(options.productCode || "").trim().toUpperCase();
  const channel = String(options.channel || "stable").trim().toLowerCase();
  const adminUsername = String(options.adminUsername || "").trim();
  const adminPassword = String(options.adminPassword || "");
  const developerUsername = String(options.developerUsername || "").trim();
  const developerPassword = String(options.developerPassword || "");

  checks.push(makeCheck(
    "base-url.present",
    Boolean(baseUrl),
    "Set --base-url or RSL_STAGING_BASE_URL before staging rehearsal."
  ));
  checks.push(makeCheck(
    "base-url.https",
    Boolean(baseUrl?.startsWith("https://")),
    "Staging rehearsal requires https:// staging base URL before live-write smoke."
  ));
  checks.push(makeCheck(
    "product-code.explicit",
    /^[A-Z0-9_-]{2,64}$/.test(productCode) && productCode !== DEFAULT_PRODUCT_CODE,
    "Use an explicit staging product code instead of the local launch-smoke default."
  ));
  checks.push(makeCheck(
    "channel.format",
    /^[a-z0-9_-]{2,32}$/.test(channel),
    "Channel must be 2-32 characters using a-z, 0-9, _ or -."
  ));
  checks.push(makeCheck(
    "smoke-admin.username",
    /^[A-Za-z0-9._@-]{3,80}$/.test(adminUsername),
    "Set --admin-username or RSL_SMOKE_ADMIN_USERNAME."
  ));
  checks.push(makeCheck(
    "smoke-admin.password",
    adminPassword.length >= 8 && !DEFAULT_ADMIN_PASSWORDS.has(adminPassword),
    "Set a non-default admin smoke password with RSL_SMOKE_ADMIN_PASSWORD or --admin-password."
  ));
  checks.push(makeCheck(
    "smoke-developer.username",
    /^[A-Za-z0-9._@-]{3,80}$/.test(developerUsername),
    "Set --developer-username or RSL_SMOKE_DEVELOPER_USERNAME."
  ));
  checks.push(makeCheck(
    "smoke-developer.password",
    developerPassword.length >= 8 && !DEFAULT_DEVELOPER_PASSWORDS.has(developerPassword),
    "Set a non-default developer smoke password with RSL_SMOKE_DEVELOPER_PASSWORD or --developer-password."
  ));

  return {
    normalized: {
      baseUrl,
      productCode,
      channel,
      adminUsername,
      developerUsername
    },
    checks
  };
}

function buildNextCommand({ baseUrl, productCode, channel, adminUsername, developerUsername }) {
  const lines = [
    "npm.cmd --silent run launch:smoke:staging -- --json `",
    `  --base-url ${baseUrl} \``,
    "  --allow-live-writes `",
    `  --admin-username ${adminUsername} \``,
    "  --admin-password $env:RSL_SMOKE_ADMIN_PASSWORD `",
    `  --developer-username ${developerUsername} \``,
    "  --developer-password $env:RSL_SMOKE_DEVELOPER_PASSWORD `",
    `  --product-code ${productCode} \``,
    `  --channel ${channel}`
  ];
  return {
    key: "run-staging-launch-smoke",
    label: "Run the HTTPS-gated staging launch smoke after this preflight passes.",
    powershell: lines.join("\n"),
    willWriteLiveData: true
  };
}

function buildResult(options) {
  const { normalized, checks } = validateOptions(options);
  const failedChecks = checks.filter((item) => item.status === "fail");
  const status = failedChecks.length === 0 ? "pass" : "fail";
  const summary = {
    baseUrl: normalized.baseUrl,
    productCode: normalized.productCode,
    channel: normalized.channel,
    checksPassed: checks.length - failedChecks.length,
    checksFailed: failedChecks.length,
    willWriteLiveData: false
  };

  return {
    status,
    mode: "staging-preflight",
    generatedAt: new Date().toISOString(),
    summary,
    checks,
    ...(status === "pass"
      ? { nextCommand: buildNextCommand(normalized) }
      : { error: { message: failedChecks[0]?.message || "Staging preflight failed." } })
  };
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.status === "pass") {
    console.log("Staging preflight passed.");
    console.log(result.nextCommand.powershell);
    return;
  }

  console.error(`Staging preflight failed: ${result.error.message}`);
  for (const check of result.checks) {
    console.error(`- ${check.status.toUpperCase()} ${check.name}: ${check.message}`);
  }
}

function main() {
  let json = process.argv.includes("--json");
  try {
    const options = parseArgs(process.argv.slice(2));
    json = options.json;
    const result = buildResult(options);
    writeResult(result, json);
    if (result.status !== "pass") {
      process.exitCode = 1;
    }
  } catch (error) {
    const result = {
      status: "fail",
      mode: "staging-preflight",
      generatedAt: new Date().toISOString(),
      summary: {
        willWriteLiveData: false
      },
      error: {
        message: error.message
      },
      checks: []
    };
    writeResult(result, json);
    process.exitCode = 1;
  }
}

main();
