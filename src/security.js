import crypto from "node:crypto";

export function nowIso() {
  return new Date().toISOString();
}

export function addSeconds(isoString, seconds) {
  return new Date(new Date(isoString).getTime() + seconds * 1000).toISOString();
}

export function addDays(isoString, days) {
  return new Date(new Date(isoString).getTime() + days * 86400000).toISOString();
}

export function generateId(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

export function randomAppId() {
  return `app_${crypto.randomBytes(8).toString("hex")}`;
}

export function randomCardKey(prefix = "RSL") {
  const groups = Array.from({ length: 4 }, () =>
    crypto.randomBytes(3).toString("hex").toUpperCase()
  );
  return `${prefix}-${groups.join("-")}`;
}

export function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function hmacHex(secret, input) {
  return crypto.createHmac("sha256", secret).update(input).digest("hex");
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export function verifyPassword(password, encoded) {
  const [saltHex, hashHex] = String(encoded).split(":");
  if (!saltHex || !hashHex) {
    return false;
  }

  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function canonicalizeSignedRequest({
  method,
  path,
  timestamp,
  nonce,
  body
}) {
  return [
    method.toUpperCase(),
    path,
    timestamp,
    nonce,
    sha256Hex(body ?? "")
  ].join("\n");
}

export function signClientRequest(secret, request) {
  return hmacHex(secret, canonicalizeSignedRequest(request));
}

export function issueLicenseToken(signer, payload) {
  const header = {
    alg: signer.algorithm ?? "RS256",
    typ: "RSL",
    kid: signer.keyId ?? null
  };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedPayload}`), signer.privateKeyPem)
    .toString("base64url");

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export function decodeLicenseTokenPayload(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid token format.");
  }

  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

export function verifyLicenseToken(publicKeyPem, token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) {
    return false;
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const verified = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    publicKeyPem,
    Buffer.from(encodedSignature, "base64url")
  );

  if (!verified) {
    return false;
  }

  try {
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
    return header.alg === "RS256";
  } catch {
    return false;
  }
}
