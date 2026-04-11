export class AppError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      throw new AppError(413, "PAYLOAD_TOO_LARGE", "Payload exceeds 1 MB.");
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  const body = raw ? JSON.parse(raw) : {};
  return { raw, body };
}

export function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers":
      "content-type, authorization, x-rs-app-id, x-rs-timestamp, x-rs-nonce, x-rs-signature",
    "access-control-allow-methods": "GET, POST, OPTIONS"
  });
  res.end(JSON.stringify(payload, null, 2));
}

export function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(html);
}

export function getBearerToken(req) {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) {
    return null;
  }
  return header.slice("Bearer ".length).trim();
}

export function requestMeta(req) {
  return {
    ip:
      req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ??
      req.socket.remoteAddress ??
      "unknown",
    userAgent: req.headers["user-agent"] ?? "unknown"
  };
}
