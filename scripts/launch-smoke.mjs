#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_NO_WARNINGS ??= "1";
process.on("warning", () => {});
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  const warningType = typeof args[0] === "string" ? args[0] : args[0]?.type;
  const warningName = typeof warning === "object" && warning ? warning.name : null;
  if (warningType === "ExperimentalWarning" || warningName === "ExperimentalWarning") {
    return;
  }
  emitWarning(warning, ...args);
};

const DEFAULT_ADMIN_USERNAME = "admin";
const DEFAULT_ADMIN_PASSWORD = "Pass123!abc";
const DEFAULT_DEVELOPER_USERNAME = "launch.smoke.owner";
const DEFAULT_DEVELOPER_PASSWORD = "LaunchSmokeOwner123!";

function parseArgs(argv) {
  const options = {
    json: false,
    baseUrl: null,
    allowLiveWrites: false,
    requireHttps: false,
    productCode: "LAUNCH_SMOKE",
    channel: "stable",
    limit: "20",
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
    if (arg === "--allow-live-writes") {
      options.allowLiveWrites = true;
      continue;
    }
    if (arg === "--require-https") {
      options.requireHttps = true;
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
    if (name === "--limit") {
      options.limit = requireArgValue(name, value, inlineValue);
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

  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  options.productCode = String(options.productCode || "").trim().toUpperCase();
  options.channel = String(options.channel || "stable").trim().toLowerCase();
  options.limit = String(options.limit || "20").trim();
  options.adminUsername = readOptionOrEnv(options.adminUsername, "RSL_SMOKE_ADMIN_USERNAME");
  options.adminPassword = readOptionOrEnv(options.adminPassword, "RSL_SMOKE_ADMIN_PASSWORD");
  options.developerUsername = readOptionOrEnv(options.developerUsername, "RSL_SMOKE_DEVELOPER_USERNAME");
  options.developerPassword = readOptionOrEnv(options.developerPassword, "RSL_SMOKE_DEVELOPER_PASSWORD");

  if (options.baseUrl) {
    ensure(options.allowLiveWrites, "Remote launch smoke creates a developer, product, policy, first batches, and handoff confirmation. Pass --allow-live-writes to run against --base-url.");
    ensure(!options.requireHttps || options.baseUrl.startsWith("https://"), "Remote launch smoke with --require-https requires an https:// base URL.");
    ensure(options.adminUsername, "Remote launch smoke requires --admin-username or RSL_SMOKE_ADMIN_USERNAME.");
    ensure(options.adminPassword, "Remote launch smoke requires --admin-password or RSL_SMOKE_ADMIN_PASSWORD.");
    ensure(options.developerUsername, "Remote launch smoke requires --developer-username or RSL_SMOKE_DEVELOPER_USERNAME.");
    ensure(options.developerPassword, "Remote launch smoke requires --developer-password or RSL_SMOKE_DEVELOPER_PASSWORD.");
  } else {
    options.adminUsername ??= DEFAULT_ADMIN_USERNAME;
    options.adminPassword ??= DEFAULT_ADMIN_PASSWORD;
    options.developerUsername ??= DEFAULT_DEVELOPER_USERNAME;
    options.developerPassword ??= DEFAULT_DEVELOPER_PASSWORD;
  }

  ensure(/^[A-Z0-9_-]{2,64}$/.test(options.productCode), "Product code must be 2-64 characters using A-Z, 0-9, _ or -.");
  ensure(/^[a-z0-9_-]{2,32}$/.test(options.channel), "Channel must be 2-32 characters using a-z, 0-9, _ or -.");
  ensure(/^[A-Za-z0-9._@-]{3,80}$/.test(options.adminUsername), "Admin username must be 3-80 characters using letters, numbers, dot, underscore, at, or dash.");
  ensure(/^[A-Za-z0-9._@-]{3,80}$/.test(options.developerUsername), "Developer username must be 3-80 characters using letters, numbers, dot, underscore, at, or dash.");
  ensure(String(options.adminPassword).length >= 8, "Admin password must be at least 8 characters.");
  ensure(String(options.developerPassword).length >= 8, "Developer password must be at least 8 characters.");
  ensure(/^\d+$/.test(options.limit) && Number(options.limit) >= 1 && Number(options.limit) <= 200, "Limit must be an integer from 1 to 200.");

  return options;
}

function requireArgValue(name, value, inlineValue) {
  const missingValue = value === undefined
    || value === null
    || String(value).trim() === ""
    || (inlineValue === undefined && String(value).startsWith("--"));
  ensure(!missingValue, `${name} requires a value.`);
  return value;
}

function readOptionOrEnv(value, envName) {
  const resolved = value ?? process.env[envName] ?? null;
  return resolved === null ? null : String(resolved).trim();
}

function normalizeBaseUrl(value) {
  if (!value) {
    return null;
  }
  const raw = String(value).trim();
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("--base-url must be a valid http:// or https:// URL.");
  }
  ensure(parsed.protocol === "http:" || parsed.protocol === "https:", "--base-url must use http:// or https://.");
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function ensure(condition, message, details = null) {
  if (condition) {
    return;
  }

  const error = new Error(message);
  if (details) {
    error.details = details;
  }
  throw error;
}

function buildQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value) !== "") {
      query.set(key, String(value));
    }
  }
  return query.toString();
}

function buildRoute(pathname, params = {}) {
  const query = buildQuery(params);
  return query ? `${pathname}?${query}` : pathname;
}

function buildHandoffLink(baseUrl, route) {
  return {
    route,
    href: baseUrl ? `${baseUrl}${route}` : null
  };
}

function parseAttachmentFileName(contentDisposition) {
  if (!contentDisposition) {
    return null;
  }
  const match = /filename="([^"]+)"/i.exec(contentDisposition);
  return match?.[1] ?? null;
}

function buildLaunchDutyHandoff({
  options,
  handoffBaseUrl,
  afterSetup,
  handoffConfirmation,
  summaryDownload,
  checksumDownload,
  handoffIndex,
  opsSnapshot
}) {
  const sharedWorkspaceParams = {
    productCode: options.productCode,
    channel: options.channel,
    source: "launch-smoke",
    handoff: "first-wave"
  };
  const launchReview = buildHandoffLink(
    handoffBaseUrl,
    buildRoute("/developer/launch-review", sharedWorkspaceParams)
  );
  const developerOps = buildHandoffLink(
    handoffBaseUrl,
    buildRoute("/developer/ops", {
      productCode: options.productCode,
      source: "launch-smoke",
      handoff: "first-wave"
    })
  );
  const firstWaveSummary = buildHandoffLink(
    handoffBaseUrl,
    buildRoute("/api/developer/ops/first-wave/recommendations/download", {
      productCode: options.productCode,
      channel: options.channel,
      limit: options.limit,
      format: "summary"
    })
  );
  const firstWaveChecksums = buildHandoffLink(
    handoffBaseUrl,
    buildRoute("/api/developer/ops/first-wave/recommendations/download", {
      productCode: options.productCode,
      channel: options.channel,
      limit: options.limit,
      format: "checksums"
    })
  );
  const opsHandoffIndex = buildHandoffLink(
    handoffBaseUrl,
    buildRoute("/api/developer/ops/export/download", {
      productCode: options.productCode,
      format: "handoff-index",
      limit: options.limit
    })
  );

  const firstWaveConfirmation = opsSnapshot.summary.initialLaunchOpsReadiness.firstWaveHandoffConfirmation;
  const auditLogId = handoffConfirmation.auditLogId;

  return {
    version: "launch-smoke-duty-handoff/v1",
    status: "ready_for_launch_review",
    productCode: options.productCode,
    channel: options.channel,
    generatedFor: options.baseUrl ? "remote-live-writes" : "ephemeral-in-memory",
    nextWorkspace: {
      key: "launch-review",
      label: "Open Launch Review",
      ...launchReview
    },
    reviewWorkspaces: {
      launchReview: {
        key: "launch-review",
        label: "Launch Review",
        ...launchReview
      },
      developerOps: {
        key: "developer-ops",
        label: "Developer Ops",
        ...developerOps
      }
    },
    downloads: {
      firstWaveSummary: {
        key: "first-wave-summary",
        label: "First-wave recommendation summary",
        fileName: summaryDownload.fileName || handoffConfirmation.handoffFileName,
        ...firstWaveSummary
      },
      firstWaveChecksums: {
        key: "first-wave-checksums",
        label: "First-wave recommendation checksums",
        fileName: checksumDownload.fileName || "first-wave-recommendations-sha256.txt",
        ...firstWaveChecksums
      },
      opsHandoffIndex: {
        key: "ops-handoff-index",
        label: "Developer Ops handoff index",
        fileName: handoffIndex.fileName || "developer-ops-handoff-index.txt",
        ...opsHandoffIndex
      }
    },
    evidence: {
      inventoryStatus: afterSetup.inventory.status,
      firstCardStatus: afterSetup.firstCards.status,
      firstRoundOpsStatus: afterSetup.firstRoundOps.status,
      firstWaveConfirmationStatus: firstWaveConfirmation.status,
      latestLaunchReceiptOperation: afterSetup.traceability.latestLaunchReceipt.operation,
      auditLogId,
      handoffFileName: handoffConfirmation.handoffFileName
    },
    operatorChecklist: [
      {
        key: "open_launch_review",
        label: "Open Launch Review with the smoke lane already scoped.",
        status: "next",
        route: launchReview.route,
        href: launchReview.href
      },
      {
        key: "verify_first_wave_confirmation",
        label: "Verify first-wave handoff confirmation evidence is present.",
        status: firstWaveConfirmation.status,
        auditLogId,
        handoffFileName: handoffConfirmation.handoffFileName
      },
      {
        key: "download_ops_handoff_index",
        label: "Download the Developer Ops handoff index for launch-duty handover.",
        status: "next",
        route: opsHandoffIndex.route,
        href: opsHandoffIndex.href,
        fileName: handoffIndex.fileName || "developer-ops-handoff-index.txt"
      },
      {
        key: "continue_developer_ops_watch",
        label: "Continue the first-wave watch from Developer Ops.",
        status: "next",
        route: developerOps.route,
        href: developerOps.href
      }
    ]
  };
}

async function requestJson(baseUrl, route, { method = "GET", token = null, body = null } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Expected JSON response from ${method} ${route}, received: ${text.slice(0, 200)}`);
  }

  if (!response.ok || payload?.ok === false) {
    const error = new Error(`HTTP ${response.status} from ${method} ${route}: ${payload?.error?.message || text}`);
    error.status = response.status;
    error.code = payload?.error?.code;
    error.payload = payload;
    throw error;
  }

  return payload?.data ?? payload;
}

async function requestText(baseUrl, route, token = null) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  const body = await response.text();
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} from GET ${route}: ${body.slice(0, 200)}`);
    error.status = response.status;
    throw error;
  }

  return {
    contentType: response.headers.get("content-type") || "",
    contentDisposition: response.headers.get("content-disposition") || "",
    body
  };
}

function makeStepRunner(checks) {
  return async function step(name, fn) {
    const startedAt = Date.now();
    try {
      const details = await fn();
      checks.push({
        name,
        status: "pass",
        durationMs: Date.now() - startedAt,
        ...(details ? { details } : {})
      });
      return details;
    } catch (error) {
      checks.push({
        name,
        status: "fail",
        durationMs: Date.now() - startedAt,
        error: {
          message: error.message,
          ...(error.code ? { code: error.code } : {}),
          ...(error.status ? { status: error.status } : {}),
          ...(error.details ? { details: error.details } : {})
        }
      });
      throw error;
    }
  };
}

async function createSmokeApp(tempDir, options) {
  const { createApp } = await import("../src/app.js");
  return createApp({
    host: "127.0.0.1",
    port: 0,
    tcpHost: "127.0.0.1",
    tcpPort: 0,
    dbPath: ":memory:",
    licensePrivateKeyPath: path.join(tempDir, "license_private.pem"),
    licensePublicKeyPath: path.join(tempDir, "license_public.pem"),
    licenseKeyringPath: path.join(tempDir, "license_keyring.json"),
    adminUsername: options.adminUsername,
    adminPassword: options.adminPassword,
    serverTokenSecret: "launch-smoke-secret"
  });
}

async function runLaunchSmoke(options) {
  const checks = [];
  const step = makeStepRunner(checks);
  const tempDir = options.baseUrl ? null : fs.mkdtempSync(path.join(os.tmpdir(), "rocksolid-launch-smoke-"));
  let app = null;
  let baseUrl = options.baseUrl;
  let adminToken = null;
  let developerToken = null;
  let afterSetup = null;
  let handoffConfirmation = null;
  let opsSnapshot = null;

  try {
    if (!baseUrl) {
      app = await createSmokeApp(tempDir, options);
      await app.listen();
      const httpAddress = app.server.address();
      baseUrl = `http://127.0.0.1:${httpAddress.port}`;
    }

    await step("admin.login", async () => {
      const session = await requestJson(baseUrl, "/api/admin/login", {
        method: "POST",
        body: {
          username: options.adminUsername,
          password: options.adminPassword
        }
      });
      ensure(session.token, "Admin login did not return a token.");
      adminToken = session.token;
      return { username: options.adminUsername };
    });

    const developer = await step("developer.create", async () => {
      const created = await requestJson(baseUrl, "/api/admin/developers", {
        method: "POST",
        token: adminToken,
        body: {
          username: options.developerUsername,
          password: options.developerPassword,
          displayName: "Launch Smoke Owner"
        }
      });
      ensure(created.id, "Developer creation did not return an id.");
      return {
        developerId: created.id,
        username: created.username
      };
    });

    await step("product.create", async () => {
      const product = await requestJson(baseUrl, "/api/admin/products", {
        method: "POST",
        token: adminToken,
        body: {
          code: options.productCode,
          name: `${options.productCode} Smoke Product`,
          ownerDeveloperId: developer.developerId
        }
      });
      ensure(product.code === options.productCode, "Product creation returned an unexpected code.", product);
      return {
        productId: product.id,
        productCode: product.code
      };
    });

    await step("policy.create", async () => {
      const policy = await requestJson(baseUrl, "/api/admin/policies", {
        method: "POST",
        token: adminToken,
        body: {
          productCode: options.productCode,
          name: "Launch Smoke Starter",
          durationDays: 30,
          maxDevices: 1
        }
      });
      ensure(policy.id, "Policy creation did not return an id.");
      return {
        policyId: policy.id,
        durationDays: policy.durationDays ?? policy.duration_days ?? 30
      };
    });

    await step("developer.login", async () => {
      const session = await requestJson(baseUrl, "/api/developer/login", {
        method: "POST",
        body: {
          username: options.developerUsername,
          password: options.developerPassword
        }
      });
      ensure(session.token, "Developer login did not return a token.");
      developerToken = session.token;
      return { username: options.developerUsername };
    });

    const commonQuery = {
      productCode: options.productCode,
      channel: options.channel,
      limit: options.limit
    };
    const firstWaveRoute = `/api/developer/ops/first-wave/recommendations?${buildQuery(commonQuery)}`;

    await step("first-wave.before", async () => {
      const before = await requestJson(baseUrl, firstWaveRoute, {
        token: developerToken
      });
      ensure(before.version === "developer-ops-first-wave-recommendations/v1", "Unexpected first-wave recommendation version.", before);
      ensure(before.productCode === options.productCode, "First-wave recommendation used the wrong product.", before);
      ensure(before.inventory?.status === "missing", "Fresh smoke product should start with missing inventory.", before.inventory);
      ensure(before.inventory?.action?.operation === "first_batch_setup", "Missing inventory should route to first_batch_setup.", before.inventory);
      ensure(before.firstCards?.action?.operation === "first_batch_setup", "First card recommendation should route to first_batch_setup.", before.firstCards);
      return {
        inventoryStatus: before.inventory.status,
        recommendedCardCount: before.firstCards?.recommendedCardCount ?? 0
      };
    });

    await step("first-batches.create", async () => {
      const setup = await requestJson(baseUrl, "/api/developer/license-quickstart/first-batches", {
        method: "POST",
        token: developerToken,
        body: {
          productCode: options.productCode,
          mode: "recommended"
        }
      });
      ensure(Array.isArray(setup.createdBatches) && setup.createdBatches.length > 0, "First batch setup did not create any batches.", setup);
      return {
        createdBatchCount: setup.createdBatches.length,
        createdCardCount: setup.createdBatches.reduce((sum, item) => sum + Number(item.cardCount ?? item.count ?? 0), 0)
      };
    });

    await step("first-wave.after", async () => {
      afterSetup = await requestJson(baseUrl, firstWaveRoute, {
        token: developerToken
      });
      ensure(afterSetup.inventory?.status === "ready", "First-wave inventory should be ready after first batch setup.", afterSetup.inventory);
      ensure(afterSetup.firstCards?.status === "ready", "First-wave first card issuance should be ready.", afterSetup.firstCards);
      ensure(afterSetup.firstRoundOps?.status === "review", "First-wave first round ops should move to review.", afterSetup.firstRoundOps);
      ensure(afterSetup.traceability?.latestLaunchReceipt?.operation === "first_batch_setup", "Latest launch receipt should trace first_batch_setup.", afterSetup.traceability);
      return {
        inventoryStatus: afterSetup.inventory.status,
        firstCardStatus: afterSetup.firstCards.status,
        firstRoundOpsStatus: afterSetup.firstRoundOps.status,
        latestLaunchReceiptOperation: afterSetup.traceability.latestLaunchReceipt.operation
      };
    });

    const summaryDownload = await step("first-wave.download.summary", async () => {
      const download = await requestText(
        baseUrl,
        `/api/developer/ops/first-wave/recommendations/download?${buildQuery({ ...commonQuery, format: "summary" })}`,
        developerToken
      );
      ensure(download.contentType === "text/plain; charset=utf-8", "First-wave summary download should be text/plain.", download);
      ensure(/first-wave-recommendations.*\.txt/i.test(download.contentDisposition), "First-wave summary download should expose a recommendation file name.", download);
      ensure(download.body.includes("RockSolid Developer Ops First-Wave Recommendations"), "First-wave summary download missed its title.");
      ensure(download.body.includes(`Project Code: ${options.productCode}`), "First-wave summary download missed the smoke product code.");
      ensure(download.body.includes("Traceability:"), "First-wave summary download missed traceability.");
      return {
        fileName: parseAttachmentFileName(download.contentDisposition)
      };
    });

    const checksumDownload = await step("first-wave.download.checksums", async () => {
      const download = await requestText(
        baseUrl,
        `/api/developer/ops/first-wave/recommendations/download?${buildQuery({ ...commonQuery, format: "checksums" })}`,
        developerToken
      );
      ensure(download.contentType === "text/plain; charset=utf-8", "First-wave checksum download should be text/plain.", download);
      ensure(download.body.includes("first-wave-recommendations.json"), "First-wave checksums missed the JSON asset.");
      ensure(download.body.includes("first-wave-recommendations.txt"), "First-wave checksums missed the summary asset.");
      return {
        fileName: parseAttachmentFileName(download.contentDisposition)
      };
    });

    const fallbackHandoffFileName = `developer-ops-first-wave-recommendations-${options.productCode.toLowerCase()}-${options.channel}.txt`;
    const handoffFileName = summaryDownload.fileName || fallbackHandoffFileName;
    await step("first-wave.confirm", async () => {
      handoffConfirmation = await requestJson(baseUrl, "/api/developer/ops/first-wave/recommendations/confirm", {
        method: "POST",
        token: developerToken,
        body: {
          productCode: options.productCode,
          channel: options.channel,
          decision: "confirmed",
          note: "launch smoke first-wave handoff reviewed by ops",
          handoffFileName,
          inventoryStatus: afterSetup.inventory.status,
          firstCardStatus: afterSetup.firstCards.status,
          firstRoundOpsStatus: afterSetup.firstRoundOps.status,
          latestLaunchReceiptOperation: afterSetup.traceability.latestLaunchReceipt.operation,
          recommendedCardCount: afterSetup.firstCards.recommendedCardCount,
          issuedFreshCardCount: afterSetup.firstCards.issuedFreshCardCount
        }
      });
      ensure(handoffConfirmation.status === "confirmed", "First-wave handoff confirmation should be confirmed.", handoffConfirmation);
      ensure(handoffConfirmation.productCode === options.productCode, "First-wave handoff confirmation used the wrong product.", handoffConfirmation);
      ensure(handoffConfirmation.sourceRecommendation?.inventoryStatus === "ready", "First-wave confirmation did not retain ready inventory evidence.", handoffConfirmation);
      ensure(handoffConfirmation.auditLogId, "First-wave confirmation did not return an audit log id.", handoffConfirmation);
      return {
        status: handoffConfirmation.status,
        auditLogId: handoffConfirmation.auditLogId,
        handoffFileName: handoffConfirmation.handoffFileName
      };
    });

    await step("ops.export", async () => {
      opsSnapshot = await requestJson(
        baseUrl,
        `/api/developer/ops/export?${buildQuery({ productCode: options.productCode, limit: options.limit })}`,
        { token: developerToken }
      );
      const latestConfirmation = opsSnapshot.overview?.latestFirstWaveHandoffConfirmations?.[0];
      const readinessConfirmation = opsSnapshot.summary?.initialLaunchOpsReadiness?.firstWaveHandoffConfirmation;
      ensure(latestConfirmation?.auditLogId === handoffConfirmation.auditLogId, "Ops export did not surface the latest first-wave confirmation.", opsSnapshot.overview);
      ensure(readinessConfirmation?.status === "confirmed", "Initial launch ops readiness did not include confirmed first-wave handoff.", opsSnapshot.summary?.initialLaunchOpsReadiness);
      ensure(opsSnapshot.summaryText?.includes("First-Wave Handoff Confirmation:"), "Ops export summary text missed first-wave confirmation evidence.");
      return {
        firstWaveConfirmationStatus: readinessConfirmation.status,
        firstWaveConfirmationAuditLogId: readinessConfirmation.auditLogId
      };
    });

    const handoffIndex = await step("ops.handoff-index", async () => {
      const download = await requestText(
        baseUrl,
        `/api/developer/ops/export/download?${buildQuery({ productCode: options.productCode, format: "handoff-index", limit: options.limit })}`,
        developerToken
      );
      ensure(download.contentType === "text/plain; charset=utf-8", "Ops handoff index should be text/plain.", download);
      ensure(/developer-ops-handoff-index\.txt/i.test(download.contentDisposition), "Ops handoff index should expose a handoff-index file name.", download);
      ensure(download.body.includes("First-Wave Handoff Confirmation:"), "Ops handoff index missed first-wave confirmation.");
      ensure(download.body.includes(handoffConfirmation.handoffFileName), "Ops handoff index missed the confirmed first-wave handoff file.");
      return {
        fileName: parseAttachmentFileName(download.contentDisposition)
      };
    });
    const handoff = buildLaunchDutyHandoff({
      options,
      handoffBaseUrl: options.baseUrl,
      afterSetup,
      handoffConfirmation,
      summaryDownload,
      checksumDownload,
      handoffIndex,
      opsSnapshot
    });

    return {
      status: "pass",
      generatedAt: new Date().toISOString(),
      mode: options.baseUrl ? "remote-live-writes" : "ephemeral-in-memory",
      summary: {
        productCode: options.productCode,
        channel: options.channel,
        checksPassed: checks.length,
        firstWave: {
          inventoryStatus: afterSetup.inventory.status,
          firstCardStatus: afterSetup.firstCards.status,
          firstRoundOpsStatus: afterSetup.firstRoundOps.status,
          confirmationStatus: handoffConfirmation.status,
          latestLaunchReceiptOperation: afterSetup.traceability.latestLaunchReceipt.operation,
          recommendedCardCount: afterSetup.firstCards.recommendedCardCount,
          issuedFreshCardCount: afterSetup.firstCards.issuedFreshCardCount
        },
        ops: {
          firstWaveConfirmationStatus: opsSnapshot.summary.initialLaunchOpsReadiness.firstWaveHandoffConfirmation.status,
          firstWaveConfirmationAuditLogId: handoffConfirmation.auditLogId,
          handoffIndexFileName: handoffIndex.fileName || "developer-ops-handoff-index.txt"
        }
      },
      handoff,
      checks
    };
  } catch (error) {
    error.checks = checks;
    throw error;
  } finally {
    if (app) {
      await app.close();
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

function writeResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.status === "pass") {
    console.log(`Launch smoke passed for ${result.summary.productCode} (${result.summary.channel}).`);
    for (const check of result.checks) {
      console.log(`- ${check.status.toUpperCase()} ${check.name} (${check.durationMs}ms)`);
    }
    console.log(`First-wave handoff: ${result.summary.firstWave.confirmationStatus}`);
    console.log(`Ops handoff index: ${result.summary.ops.handoffIndexFileName}`);
    if (result.handoff) {
      console.log("Next launch-duty handoff:");
      console.log(`- Open Launch Review: ${result.handoff.nextWorkspace.href || result.handoff.nextWorkspace.route}`);
      console.log(`- Download Ops handoff index: ${result.handoff.downloads.opsHandoffIndex.href || result.handoff.downloads.opsHandoffIndex.route}`);
      console.log(`- Continue Developer Ops watch: ${result.handoff.reviewWorkspaces.developerOps.href || result.handoff.reviewWorkspaces.developerOps.route}`);
    }
    return;
  }

  console.error(`Launch smoke failed: ${result.error.message}`);
  for (const check of result.checks) {
    console.error(`- ${check.status.toUpperCase()} ${check.name} (${check.durationMs}ms)`);
  }
}

async function main() {
  let options = {
    json: process.argv.includes("--json")
  };
  try {
    options = parseArgs(process.argv.slice(2));
    const result = await runLaunchSmoke(options);
    writeResult(result, options.json);
  } catch (error) {
    const result = {
      status: "fail",
      generatedAt: new Date().toISOString(),
      error: {
        message: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.status ? { status: error.status } : {})
      },
      checks: error.checks || []
    };
    writeResult(result, options.json);
    process.exitCode = 1;
  }
}

await main();
