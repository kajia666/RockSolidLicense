import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { nowIso, sha256Hex } from "./security.js";

function createRsaKeyPair() {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: "spki",
      format: "pem"
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem"
    }
  });
}

function makeKeyRecord(publicKeyPem, createdAt, status = "active") {
  const publicKeyFingerprint = sha256Hex(publicKeyPem);
  return {
    keyId: publicKeyFingerprint.slice(0, 16),
    algorithm: "RS256",
    publicKeyPem,
    publicKeyFingerprint,
    createdAt,
    status
  };
}

function normalizeKeyring(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.keys)) {
    return {
      activeKeyId: null,
      keys: []
    };
  }

  return {
    activeKeyId: typeof raw.activeKeyId === "string" ? raw.activeKeyId : null,
    keys: raw.keys
      .filter((entry) => entry && typeof entry === "object" && typeof entry.publicKeyPem === "string")
      .map((entry) => ({
        keyId: entry.keyId,
        algorithm: entry.algorithm ?? "RS256",
        publicKeyPem: entry.publicKeyPem,
        publicKeyFingerprint: entry.publicKeyFingerprint ?? sha256Hex(entry.publicKeyPem),
        createdAt: entry.createdAt ?? nowIso(),
        status: entry.status === "retired" ? "retired" : "active"
      }))
  };
}

function loadKeyring(config) {
  if (!fs.existsSync(config.licenseKeyringPath)) {
    return {
      activeKeyId: null,
      keys: []
    };
  }

  return normalizeKeyring(JSON.parse(fs.readFileSync(config.licenseKeyringPath, "utf8")));
}

function saveKeyring(config, keyring) {
  fs.mkdirSync(path.dirname(config.licenseKeyringPath), { recursive: true });
  fs.writeFileSync(config.licenseKeyringPath, JSON.stringify(keyring, null, 2), "utf8");
}

function writeActivePemFiles(config, keyPair) {
  fs.mkdirSync(path.dirname(config.licensePrivateKeyPath), { recursive: true });
  fs.mkdirSync(path.dirname(config.licensePublicKeyPath), { recursive: true });
  fs.writeFileSync(config.licensePrivateKeyPath, keyPair.privateKey, "utf8");
  fs.writeFileSync(config.licensePublicKeyPath, keyPair.publicKey, "utf8");
}

function ensureActiveKeyringEntry(config, activePrivateKeyPem, activePublicKeyPem, existingKeyring) {
  const generatedActiveRecord = makeKeyRecord(activePublicKeyPem, nowIso(), "active");
  const previousActiveRecord = existingKeyring.keys.find(
    (entry) => entry.keyId === generatedActiveRecord.keyId
  );
  const activeRecord = previousActiveRecord
    ? {
        ...previousActiveRecord,
        status: "active",
        publicKeyPem: activePublicKeyPem,
        publicKeyFingerprint: generatedActiveRecord.publicKeyFingerprint
      }
    : generatedActiveRecord;

  const filtered = existingKeyring.keys.filter((entry) => entry.keyId !== activeRecord.keyId);
  const keyring = {
    activeKeyId: activeRecord.keyId,
    keys: [
      activeRecord,
      ...filtered.map((entry) => ({
        ...entry,
        status: "retired"
      }))
    ].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
  };

  saveKeyring(config, keyring);

  return {
    algorithm: "RS256",
    keyId: activeRecord.keyId,
    privateKeyPem: activePrivateKeyPem,
    publicKeyPem: activePublicKeyPem,
    publicKeyFingerprint: activeRecord.publicKeyFingerprint,
    createdAt: activeRecord.createdAt,
    keyring
  };
}

export function loadOrCreateLicenseKeyStore(config) {
  let privateKeyPem = null;
  let publicKeyPem = null;

  if (fs.existsSync(config.licensePrivateKeyPath) && fs.existsSync(config.licensePublicKeyPath)) {
    privateKeyPem = fs.readFileSync(config.licensePrivateKeyPath, "utf8");
    publicKeyPem = fs.readFileSync(config.licensePublicKeyPath, "utf8");
  } else {
    const generated = createRsaKeyPair();
    writeActivePemFiles(config, generated);
    privateKeyPem = generated.privateKey;
    publicKeyPem = generated.publicKey;
  }

  return ensureActiveKeyringEntry(config, privateKeyPem, publicKeyPem, loadKeyring(config));
}

export function rotateLicenseKeyStore(config, currentStore) {
  const generated = createRsaKeyPair();
  writeActivePemFiles(config, generated);

  const existing = currentStore?.keyring ?? loadKeyring(config);
  const retiredKeys = existing.keys.map((entry) => ({
    ...entry,
    status: "retired"
  }));

  return ensureActiveKeyringEntry(config, generated.privateKey, generated.publicKey, {
    activeKeyId: null,
    keys: retiredKeys
  });
}
