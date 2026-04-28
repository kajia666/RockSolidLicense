import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

async function startServer(overrides = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rocksolid-launch-mainline-visibility-"));
  const app = createApp({
    host: "127.0.0.1",
    port: 0,
    tcpHost: "127.0.0.1",
    tcpPort: 0,
    dbPath: ":memory:",
    licensePrivateKeyPath: path.join(tempDir, "license_private.pem"),
    licensePublicKeyPath: path.join(tempDir, "license_public.pem"),
    licenseKeyringPath: path.join(tempDir, "license_keyring.json"),
    adminUsername: "admin",
    adminPassword: "Pass123!abc",
    serverTokenSecret: "launch-mainline-visibility-test-secret",
    ...overrides
  });

  await app.listen();
  const httpAddress = app.server.address();
  return {
    app,
    baseUrl: `http://127.0.0.1:${httpAddress.port}`,
    tempDir
  };
}

async function postJson(baseUrl, route, body, token = null) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json.data;
}

async function getJson(baseUrl, route, token = null) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  const json = await response.json();
  assert.equal(response.ok, true, JSON.stringify(json));
  return json.data;
}

async function getText(baseUrl, route, token = null) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return {
    contentType: response.headers.get("content-type"),
    body: text
  };
}

test("developer launch mainline action receipt exposes visibility checkpoints for first-wave ops sweep", async () => {
  const { app, baseUrl, tempDir } = await startServer();

  try {
    const adminSession = await postJson(baseUrl, "/api/admin/login", {
      username: "admin",
      password: "Pass123!abc"
    });

    const owner = await postJson(
      baseUrl,
      "/api/admin/developers",
      {
        username: "launch.visibility.owner",
        password: "LaunchVisibilityOwner123!",
        displayName: "Launch Visibility Owner"
      },
      adminSession.token
    );

    await postJson(
      baseUrl,
      "/api/admin/products",
      {
        code: "VISIBILITY_ALPHA",
        name: "Visibility Alpha App",
        ownerDeveloperId: owner.id,
        featureConfig: {
          allowRegister: true,
          allowAccountLogin: true,
          allowCardLogin: true,
          allowCardRecharge: true
        }
      },
      adminSession.token
    );

    const ownerSession = await postJson(baseUrl, "/api/developer/login", {
      username: "launch.visibility.owner",
      password: "LaunchVisibilityOwner123!"
    });

    const actionResult = await postJson(
      baseUrl,
      "/api/developer/launch-mainline/action",
      {
        productCode: "VISIBILITY_ALPHA",
        channel: "stable",
        operation: "record_post_launch_ops_sweep"
      },
      ownerSession.token
    );

    const visibility = actionResult.receipt?.visibility;
    assert.equal(visibility?.status, "ready");
    assert.match(visibility?.headline || "", /Developer Ops/i);
    assert.equal(visibility?.recordedReceipt?.operation, "record_post_launch_ops_sweep");
    assert.match(
      visibility?.recordedReceipt?.handoffFileName || "",
      /VISIBILITY_ALPHA-stable-record_post_launch_ops_sweep.*\.txt/i
    );

    assert.equal(visibility?.workspaces?.developerOps?.key, "ops");
    assert.match(visibility?.workspaces?.developerOps?.href || "", /^\/developer\/ops\?/);
    assert.match(visibility?.workspaces?.developerOps?.href || "", /productCode=VISIBILITY_ALPHA/);
    assert.match(visibility?.workspaces?.developerOps?.href || "", /autofocus=snapshot/);

    assert.equal(visibility?.workspaces?.launchMainline?.key, "launch-mainline");
    assert.match(visibility?.workspaces?.launchMainline?.href || "", /^\/developer\/launch-mainline\?/);
    assert.match(visibility?.workspaces?.launchMainline?.href || "", /productCode=VISIBILITY_ALPHA/);
    assert.match(visibility?.workspaces?.launchMainline?.href || "", /channel=stable/);
    assert.match(visibility?.workspaces?.launchMainline?.href || "", /autofocus=summary/);

    assert.equal(visibility?.downloads?.developerOpsSummary?.format, "summary");
    assert.match(visibility?.downloads?.developerOpsSummary?.href || "", /^\/api\/developer\/ops\/export\/download\?/);
    assert.match(visibility?.downloads?.developerOpsSummary?.href || "", /productCode=VISIBILITY_ALPHA/);
    assert.match(visibility?.downloads?.developerOpsSummary?.href || "", /format=summary/);

    assert.equal(visibility?.downloads?.launchReceiptNextFollowUp?.format, "launch-receipt-next-follow-up");
    assert.match(visibility?.downloads?.launchReceiptNextFollowUp?.href || "", /format=launch-receipt-next-follow-up/);

    assert.equal(visibility?.downloads?.postLaunchSweepHandoff?.format, "post-launch-sweep-handoff");
    assert.match(visibility?.downloads?.postLaunchSweepHandoff?.href || "", /^\/api\/developer\/launch-mainline\/download\?/);
    assert.match(visibility?.downloads?.postLaunchSweepHandoff?.href || "", /format=post-launch-sweep-handoff/);

    assert.equal(visibility?.downloads?.postLaunchHandoffIndex?.format, "post-launch-handoff-index");
    assert.match(visibility?.downloads?.postLaunchHandoffIndex?.href || "", /format=post-launch-handoff-index/);

    assert.deepEqual(
      Array.isArray(visibility?.checkpoints) ? visibility.checkpoints.map((item) => item.key) : [],
      [
        "developer_ops_summary",
        "launch_receipt_next_follow_up",
        "post_launch_sweep_handoff",
        "post_launch_handoff_index"
      ]
    );

    const visibilitySection = Array.isArray(actionResult.receipt?.mainlineLastActionScreen?.sections)
      ? actionResult.receipt.mainlineLastActionScreen.sections.find((item) => item?.key === "receipt_visibility")
      : null;
    assert.equal(visibilitySection?.title, "Receipt Visibility");
    assert.deepEqual(
      Array.isArray(visibilitySection?.cards) ? visibilitySection.cards.map((item) => item?.key) : [],
      [
        "receipt_visibility_summary",
        "receipt_visibility_developer_ops_summary",
        "receipt_visibility_launch_receipt_next_follow_up",
        "receipt_visibility_post_launch_sweep_handoff",
        "receipt_visibility_post_launch_handoff_index"
      ]
    );
    assert.deepEqual(
      Array.isArray(visibilitySection?.cards)
        ? visibilitySection.cards.flatMap((card) =>
            Array.isArray(card?.controls)
              ? card.controls.map((control) => ({
                  kind: control?.kind || null,
                  workspace: control?.workspaceAction?.key || null,
                  download: control?.recommendedDownload?.key || null
                }))
              : []
          )
        : [],
      [
        { kind: "workspace", workspace: "ops", download: null },
        { kind: "workspace", workspace: "launch-mainline", download: null },
        { kind: "download", workspace: null, download: "ops_summary" },
        { kind: "download", workspace: null, download: "ops_launch_receipt_next_follow_up" },
        { kind: "download", workspace: null, download: "launch_mainline_post_launch_sweep_handoff" },
        { kind: "download", workspace: null, download: "launch_mainline_post_launch_handoff_index" }
      ]
    );
    assert.equal(
      actionResult.receipt?.mainlineView?.lastActionScreen?.sections?.some((item) => item?.key === "receipt_visibility"),
      true
    );
    assert.equal(
      actionResult.receipt?.mainlinePage?.lastActionScreen?.sections?.some((item) => item?.key === "receipt_visibility"),
      true
    );

    assert.match(actionResult.receipt?.handoffText || "", /Receipt Visibility:/);
    assert.match(actionResult.receipt?.handoffText || "", /developer-ops-launch-receipt-next-follow-up\.txt/i);
    assert.match(actionResult.receipt?.handoffText || "", /post-launch-handoff-index/i);

    const opsExport = await getJson(
      baseUrl,
      "/api/developer/ops/export?productCode=VISIBILITY_ALPHA&limit=20",
      ownerSession.token
    );
    const latestReceipt = Array.isArray(opsExport.overview?.latestLaunchReceipts)
      ? opsExport.overview.latestLaunchReceipts.find((item) => item?.operation === "record_post_launch_ops_sweep")
      : null;
    assert.equal(latestReceipt?.receiptVisibility?.status, "ready");
    assert.deepEqual(latestReceipt?.receiptVisibility?.workspaceKeys, ["ops", "launch-mainline"]);
    assert.deepEqual(
      latestReceipt?.receiptVisibility?.downloadKeys,
      [
        "ops_summary",
        "ops_launch_receipt_next_follow_up",
        "launch_mainline_post_launch_sweep_handoff",
        "launch_mainline_post_launch_handoff_index"
      ]
    );
    assert.match(latestReceipt?.receiptVisibility?.downloads?.developerOpsSummary?.href || "", /format=summary/);
    assert.match(latestReceipt?.receiptVisibility?.downloads?.launchReceiptNextFollowUp?.href || "", /format=launch-receipt-next-follow-up/);
    assert.match(latestReceipt?.receiptVisibility?.downloads?.postLaunchSweepHandoff?.href || "", /format=post-launch-sweep-handoff/);
    assert.match(latestReceipt?.receiptVisibility?.downloads?.postLaunchHandoffIndex?.href || "", /format=post-launch-handoff-index/);
    assert.deepEqual(
      Array.isArray(latestReceipt?.receiptVisibility?.checkpoints)
        ? latestReceipt.receiptVisibility.checkpoints.map((item) => ({
            key: item?.key || null,
            workspaceKey: item?.workspaceKey || null,
            downloadKey: item?.downloadKey || null
          }))
        : [],
      [
        { key: "developer_ops_summary", workspaceKey: "ops", downloadKey: "ops_summary" },
        { key: "launch_receipt_next_follow_up", workspaceKey: "ops", downloadKey: "ops_launch_receipt_next_follow_up" },
        { key: "post_launch_sweep_handoff", workspaceKey: "launch-mainline", downloadKey: "launch_mainline_post_launch_sweep_handoff" },
        { key: "post_launch_handoff_index", workspaceKey: "launch-mainline", downloadKey: "launch_mainline_post_launch_handoff_index" }
      ]
    );
    assert.match(opsExport.summaryText || "", /Receipt Visibility:/);
    assert.match(opsExport.summaryText || "", /developer-ops-launch-receipt-next-follow-up\.txt/);
    assert.match(opsExport.summaryText || "", /post-launch-sweep-handoff/);
    assert.match(opsExport.summaryText || "", /post-launch-handoff-index/);

    const opsSummaryDownload = await getText(
      baseUrl,
      "/api/developer/ops/export/download?productCode=VISIBILITY_ALPHA&format=summary&limit=20",
      ownerSession.token
    );
    assert.equal(opsSummaryDownload.contentType, "text/plain; charset=utf-8");
    assert.match(opsSummaryDownload.body, /Receipt Visibility:/);
    assert.match(opsSummaryDownload.body, /developer-ops-launch-receipt-next-follow-up\.txt/);
    assert.match(opsSummaryDownload.body, /post-launch-sweep-handoff/);
    assert.match(opsSummaryDownload.body, /post-launch-handoff-index/);

    const opsHandoffIndex = await getText(
      baseUrl,
      "/api/developer/ops/export/download?productCode=VISIBILITY_ALPHA&format=handoff-index&limit=20",
      ownerSession.token
    );
    assert.equal(opsHandoffIndex.contentType, "text/plain; charset=utf-8");
    assert.match(opsHandoffIndex.body, /Receipt Visibility:/);
    assert.match(opsHandoffIndex.body, /developer-ops-launch-receipt-next-follow-up\.txt/);
    assert.match(opsHandoffIndex.body, /post-launch-sweep-handoff/);
    assert.match(opsHandoffIndex.body, /post-launch-handoff-index/);
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
