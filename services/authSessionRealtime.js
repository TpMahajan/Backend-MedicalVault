import { WebSocketServer } from "ws";
import {
  verifyAccessToken,
  verifyLoginAttemptToken,
} from "./tokenService.js";

const WS_OPEN = 1;
const HEARTBEAT_INTERVAL_MS = 30_000;
const WS_PATH = "/api/auth/session/ws";

const sessionClients = new Map();
const attemptClients = new Map();

const asText = (value) => (value == null ? "" : String(value).trim());

const toJson = (payload) =>
  JSON.stringify({
    ...payload,
    timestamp: new Date().toISOString(),
  });

const addClient = (bucket, key, client) => {
  if (!key) return;
  const set = bucket.get(key) || new Set();
  set.add(client);
  bucket.set(key, set);
};

const removeClient = (bucket, key, client) => {
  if (!key) return;
  const set = bucket.get(key);
  if (!set) return;
  set.delete(client);
  if (set.size === 0) {
    bucket.delete(key);
  }
};

const cleanupClient = (client) => {
  removeClient(sessionClients, client.sessionId, client);
  removeClient(attemptClients, client.attemptId, client);
};

const broadcast = (bucket, key, payload) => {
  const set = bucket.get(asText(key));
  if (!set || set.size === 0) return 0;

  const message = toJson(payload);
  let sent = 0;
  for (const client of Array.from(set)) {
    const ws = client.ws;
    if (!ws || ws.readyState !== WS_OPEN) {
      cleanupClient(client);
      continue;
    }

    try {
      ws.send(message);
      sent += 1;
    } catch {
      cleanupClient(client);
      try {
        ws.terminate();
      } catch {
        // Ignore terminate errors.
      }
    }
  }
  return sent;
};

const closeSessionSockets = (sessionId, code = 4001, reason = "session_invalidated") => {
  const key = asText(sessionId);
  if (!key) return;
  const set = sessionClients.get(key);
  if (!set || set.size === 0) return;

  for (const client of Array.from(set)) {
    const ws = client.ws;
    cleanupClient(client);
    if (!ws) continue;
    try {
      ws.close(code, reason);
    } catch {
      try {
        ws.terminate();
      } catch {
        // Ignore terminate errors.
      }
    }
  }
};

export function initAuthSessionRealtime(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url || "", `http://${request.headers.host}`);
    } catch {
      return;
    }

    if (url.pathname !== WS_PATH) {
      return;
    }

    request.__wsHandled = true;

    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on("pong", () => {
        ws.isAlive = true;
      });

      const token = asText(url.searchParams.get("token"));
      const attemptToken = asText(url.searchParams.get("attemptToken"));

      const client = {
        ws,
        sessionId: "",
        attemptId: "",
      };

      if (token) {
        try {
          const payload = verifyAccessToken(token);
          const sessionId = asText(payload?.sid);
          if (!sessionId) {
            ws.close(4401, "missing_session_id");
            return;
          }
          client.sessionId = sessionId;
          addClient(sessionClients, sessionId, client);
          ws.send(
            toJson({
              type: "connected",
              mode: "session",
              sessionId,
            })
          );
        } catch {
          ws.close(4401, "invalid_token");
          return;
        }
      } else if (attemptToken) {
        try {
          const payload = verifyLoginAttemptToken(attemptToken);
          if (asText(payload?.typ) !== "login_attempt") {
            ws.close(4401, "invalid_attempt_token_type");
            return;
          }

          const attemptId = asText(payload?.attemptId);
          if (!attemptId) {
            ws.close(4401, "missing_attempt_id");
            return;
          }
          client.attemptId = attemptId;
          addClient(attemptClients, attemptId, client);
          ws.send(
            toJson({
              type: "connected",
              mode: "attempt",
              attemptId,
            })
          );
        } catch {
          ws.close(4401, "invalid_attempt_token");
          return;
        }
      } else {
        ws.close(4401, "missing_token");
        return;
      }

      ws.on("close", () => cleanupClient(client));
      ws.on("error", () => cleanupClient(client));
      ws.on("message", () => {
        // Auth session socket is server-push only.
      });
    });
  });

  const heartbeat = setInterval(() => {
    const allClients = [
      ...Array.from(sessionClients.values()).flatMap((set) => Array.from(set)),
      ...Array.from(attemptClients.values()).flatMap((set) => Array.from(set)),
    ];

    for (const client of allClients) {
      const ws = client.ws;
      if (!ws || ws.readyState !== WS_OPEN) {
        cleanupClient(client);
        continue;
      }
      if (ws.isAlive === false) {
        cleanupClient(client);
        try {
          ws.terminate();
        } catch {
          // Ignore terminate errors.
        }
        continue;
      }

      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  if (typeof heartbeat.unref === "function") {
    heartbeat.unref();
  }

  return wss;
}

export function emitLoginAttemptEvent({
  sessionId,
  attemptId,
  requestedDeviceInfo = "",
  requestedIp = "",
}) {
  return broadcast(sessionClients, sessionId, {
    type: "login_attempt",
    attemptId: asText(attemptId),
    requestedDeviceInfo: asText(requestedDeviceInfo),
    requestedIp: asText(requestedIp),
    message: "Another device is trying to access your account.",
  });
}

export function emitSessionInvalidatedEvent({
  sessionId,
  reason = "new_login_approved",
}) {
  const sent = broadcast(sessionClients, sessionId, {
    type: "session_invalidated",
    reason: asText(reason) || "new_login_approved",
    message: "You have been logged out due to login from another device",
  });
  closeSessionSockets(sessionId);
  return sent;
}

export function emitLoginApprovedEvent({ attemptId, sessionId }) {
  return broadcast(attemptClients, attemptId, {
    type: "login_approved",
    attemptId: asText(attemptId),
    sessionId: asText(sessionId),
  });
}

export function emitLoginDeniedEvent({ attemptId }) {
  return broadcast(attemptClients, attemptId, {
    type: "login_denied",
    attemptId: asText(attemptId),
    message: "Login denied by active session",
  });
}
