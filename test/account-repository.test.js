import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import {
  getAccountManageRowById,
  getAccountRecordByProductUsername,
  queryAccountRows
} from "../src/data/account-repository.js";

function createTestApp() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rocksolid-account-repo-"));
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

test("account repository formats scoped account rows and lookup helpers", async () => {
  const { app, tempDir } = createTestApp();

  try {
    const admin = app.services.adminLogin({
      username: "admin",
      password: "Pass123!abc"
    });
    const developer = app.services.createDeveloper(admin.token, {
      username: "accountdev",
      password: "Pass123!abc",
      displayName: "Account Dev"
    });
    const product = await app.services.createProduct(admin.token, {
      code: "ACCREPO",
      name: "Account Repo Product",
      ownerDeveloperId: developer.id
    });

    const account = app.mainStore.accounts.createAccount(product, {
      username: "repo_user",
      passwordHash: "repo-hash"
    });
    app.mainStore.accounts.touchAccountLastLogin(account.id, "2026-01-03T00:00:00.000Z");

    const listed = queryAccountRows(app.db, {
      productCode: "ACCREPO",
      search: "repo_"
    });
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].productCode, "ACCREPO");
    assert.equal(listed.items[0].ownerDeveloperId, developer.id);
    assert.equal(listed.items[0].lastLoginAt, "2026-01-03T00:00:00.000Z");

    const byUsername = getAccountRecordByProductUsername(app.db, product.id, "repo_user", "active");
    assert.equal(byUsername.id, account.id);

    app.mainStore.accounts.updateAccountStatus(account.id, "disabled", "2026-01-04T00:00:00.000Z");
    const manageRow = getAccountManageRowById(app.db, account.id);
    assert.equal(manageRow.status, "disabled");
    assert.equal(manageRow.updatedAt, "2026-01-04T00:00:00.000Z");
  } finally {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
