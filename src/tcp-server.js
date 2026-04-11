import net from "node:net";
import { AppError } from "./http.js";

const CLIENT_ACTIONS = {
  "client.register": {
    path: "/api/client/register",
    execute: (services, reqLike, body, rawBody, meta) => services.registerClient(reqLike, body, rawBody, meta)
  },
  "client.recharge": {
    path: "/api/client/recharge",
    execute: (services, reqLike, body, rawBody, meta) => services.redeemCard(reqLike, body, rawBody, meta)
  },
  "client.bindings": {
    path: "/api/client/bindings",
    execute: (services, reqLike, body, rawBody, meta) => services.clientBindings(reqLike, body, rawBody, meta)
  },
  "client.unbind": {
    path: "/api/client/unbind",
    execute: (services, reqLike, body, rawBody, meta) => services.clientUnbind(reqLike, body, rawBody, meta)
  },
  "client.card-login": {
    path: "/api/client/card-login",
    execute: (services, reqLike, body, rawBody, meta) => services.cardLoginClient(reqLike, body, rawBody, meta)
  },
  "client.login": {
    path: "/api/client/login",
    execute: (services, reqLike, body, rawBody, meta) => services.loginClient(reqLike, body, rawBody, meta)
  },
  "client.heartbeat": {
    path: "/api/client/heartbeat",
    execute: (services, reqLike, body, rawBody, meta) =>
      services.heartbeatClient(reqLike, body, rawBody, meta)
  },
  "client.logout": {
    path: "/api/client/logout",
    execute: (services, reqLike, body, rawBody) => services.logoutClient(reqLike, body, rawBody)
  }
};

function socketMeta(socket) {
  return {
    ip: socket.remoteAddress ?? "unknown",
    userAgent: `tcp:${socket.remotePort ?? "unknown"}`
  };
}

function writeFrame(socket, frame) {
  socket.write(`${JSON.stringify(frame)}\n`);
}

function parseEnvelope(line) {
  const frame = JSON.parse(line);
  if (!frame || typeof frame !== "object") {
    throw new AppError(400, "TCP_FRAME_INVALID", "Frame must be a JSON object.");
  }

  if (!frame.action || typeof frame.action !== "string") {
    throw new AppError(400, "TCP_ACTION_REQUIRED", "Frame action is required.");
  }

  if (frame.action !== "system.ping") {
    if (typeof frame.bodyText !== "string") {
      throw new AppError(400, "TCP_BODY_REQUIRED", "Frame bodyText must be a JSON string.");
    }
    if (!frame.headers || typeof frame.headers !== "object") {
      throw new AppError(400, "TCP_HEADERS_REQUIRED", "Frame headers are required.");
    }
  }

  return frame;
}

function parseBodyText(bodyText) {
  if (!bodyText) {
    return {};
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    throw new AppError(400, "TCP_BODY_INVALID_JSON", "bodyText must contain valid JSON.");
  }
}

function errorPayload(error) {
  if (error instanceof AppError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details
    };
  }

  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "Unexpected server error."
  };
}

export function createTcpServer({ services }) {
  return net.createServer((socket) => {
    let buffer = "";

    socket.setEncoding("utf8");

    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 2 * 1024 * 1024) {
        writeFrame(socket, {
          id: null,
          ok: false,
          error: {
            status: 413,
            code: "TCP_FRAME_TOO_LARGE",
            message: "TCP frame buffer exceeded 2 MB."
          }
        });
        socket.destroy();
        return;
      }

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line) {
          continue;
        }

        let frame = null;
        try {
          frame = parseEnvelope(line);

          if (frame.action === "system.ping") {
            writeFrame(socket, {
              id: frame.id ?? null,
              ok: true,
              data: {
                status: "ok",
                time: services.health().time
              }
            });
            continue;
          }

          const action = CLIENT_ACTIONS[frame.action];
          if (!action) {
            throw new AppError(404, "TCP_ACTION_UNKNOWN", `Unsupported TCP action: ${frame.action}`);
          }

          const reqLike = {
            headers: frame.headers,
            method: "POST",
            path: action.path
          };
          const rawBody = frame.bodyText;
          const body = parseBodyText(rawBody);
          const result = action.execute(services, reqLike, body, rawBody, socketMeta(socket));

          writeFrame(socket, {
            id: frame.id ?? null,
            ok: true,
            data: result
          });
        } catch (error) {
          if (!(error instanceof AppError)) {
            console.error(error);
          }

          writeFrame(socket, {
            id: frame?.id ?? null,
            ok: false,
            error: errorPayload(error)
          });
        }
      }
    });

    socket.on("error", (error) => {
      console.error("TCP socket error", error);
    });
  });
}
