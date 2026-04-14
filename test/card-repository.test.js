import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { describeLicenseKeyControl, getCardRowById, queryCardRows } from "../src/data/card-repository.js";

function createTestApp() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rocksolid-card-repo-"));
  const app = createApp({
    host: "127.0.0.1",
    port: 0,
    tcpEnabled: false,
    dbPath: ":memory:",
    licensePrivateKeyPath: path.join(tempDir, "license_private.pem"),
    licensePublicKeyPath: path.join(tempDir, "license_public.pem"),
    licenseKeyringPath: path.join(tempDir, "license_keyring.json"),
    adminUsername: "admin",
    adminPassword: "Pass123!abc",
    serverTokenSecret: "test-secret"
  });

  return { app, tempDir };
}

test("card repository formats card rows and control-state filters", async () => {
  const { app, tempDir } = createTestApp();

  try {
    const admin = app.services.adminLogin({
      username: "admin",
      password: "Pass123!abc"
    });
    const developer = app.services.createDeveloper(admin.token, {
      username: "carddev",
      password: "Pass123!abc",
      displayName: "Card Dev"
    });
    await app.services.createProduct(admin.token, {
      code: "CARDREPO",
      name: "Card Repo Product",
      ownerDeveloperId: developer.id
    });
    const policy = await app.services.createPolicy(admin.token, {
      productCode: "CARDREPO",
      name: "Card Policy",
      durationDays: 30,
      maxDevices: 1
    });
    await app.services.createCardBatch(admin.token, {
      productCode: "CARDREPO",
      policyId: policy.id,
      count: 2,
      prefix: "CRD"
    });

    const initial = queryCardRows(app.db, {
      ownerDeveloperId: developer.id,
      productCode: "CARDREPO"
    });
    assert.equal(initial.items.length, 2);
    assert.equal(initial.summary.total, 2);
    assert.equal(initial.summary.unused, 2);
    assert.equal(initial.items[0].displayStatus, "unused");
    assert.equal(initial.items[0].maskedKey.startsWith("CRD"), true);

    const frozen = await app.services.updateCardStatus(admin.token, initial.items[0].id, {
      status: "frozen",
      notes: "Manual freeze"
    });
    assert.equal(frozen.displayStatus, "frozen");
    assert.equal(frozen.effectiveControlStatus, "frozen");

    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    await app.services.updateCardStatus(admin.token, initial.items[1].id, {
      status: "active",
      expiresAt: expiredAt,
      notes: "Expired card"
    });

    const filteredFrozen = queryCardRows(app.db, {
      productCode: "CARDREPO",
      status: "frozen"
    });
    assert.equal(filteredFrozen.items.length, 1);
    assert.equal(filteredFrozen.items[0].id, initial.items[0].id);

    const filteredExpired = queryCardRows(app.db, {
      productCode: "CARDREPO",
      status: "expired"
    });
    assert.equal(filteredExpired.items.length, 1);
    assert.equal(filteredExpired.items[0].id, initial.items[1].id);
    assert.equal(filteredExpired.items[0].displayStatus, "expired");

    const byId = getCardRowById(app.db, initial.items[1].id);
    assert.equal(byId.productCode, "CARDREPO");
    assert.equal(byId.effectiveControlStatus, "expired");

    const control = describeLicenseKeyControl({
      status: "active",
      expires_at: expiredAt,
      notes: "Expired card"
    }, new Date().toISOString());
    assert.equal(control.available, false);
    assert.equal(control.effectiveStatus, "expired");
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
