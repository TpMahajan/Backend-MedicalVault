import { WebSocketServer } from "ws";
import { verifyAccessToken } from "./tokenService.js";
import { isDoctorPatientLinked } from "./doctorPatientLink.js";

const WS_OPEN = 1;
const HEARTBEAT_INTERVAL_MS = 30_000;
const WS_PATH = "/api/sessions/chat/ws";
// A dropped "typing_stop" (app killed mid-typing, connection lost) must
// never leave the recipient's indicator stuck forever — auto-expire it
// server-side.
const TYPING_TTL_MS = 5_000;

// principalId -> Set<client>
const principalClients = new Map();
// "fromPrincipalId:toPrincipalId" -> Timeout, so a stale typing signal is
// force-expired even if the sender never sends typing_stop.
const typingExpiryTimers = new Map();

const asText = (value) => (value == null ? "" : String(value).trim());

const toJson = (payload) =>
  JSON.stringify({
    ...payload,
    timestamp: new Date().toISOString(),
  });

const addClient = (principalId, client) => {
  if (!principalId) return;
  const set = principalClients.get(principalId) || new Set();
  set.add(client);
  principalClients.set(principalId, set);
};

const removeClient = (principalId, client) => {
  if (!principalId) return;
  const set = principalClients.get(principalId);
  if (!set) return;
  set.delete(client);
  if (set.size === 0) {
    principalClients.delete(principalId);
  }
};

const sendToPrincipal = (principalId, payload) => {
  const set = principalClients.get(asText(principalId));
  if (!set || set.size === 0) return 0;

  const message = toJson(payload);
  let sent = 0;
  for (const client of Array.from(set)) {
    const ws = client.ws;
    if (!ws || ws.readyState !== WS_OPEN) {
      removeClient(client.principalId, client);
      continue;
    }
    try {
      ws.send(message);
      sent += 1;
    } catch {
      removeClient(client.principalId, client);
      try {
        ws.terminate();
      } catch {
        // Ignore terminate errors.
      }
    }
  }
  return sent;
};

export function emitTypingEvent({ toPrincipalId, fromPrincipalId, typing }) {
  const timerKey = `${asText(fromPrincipalId)}:${asText(toPrincipalId)}`;
  const existingTimer = typingExpiryTimers.get(timerKey);
  if (existingTimer) {
    clearTimeout(existingTimer);
    typingExpiryTimers.delete(timerKey);
  }

  const sent = sendToPrincipal(toPrincipalId, {
    type: typing ? "typing" : "typing_stop",
    from: asText(fromPrincipalId),
  });

  if (typing) {
    const timer = setTimeout(() => {
      typingExpiryTimers.delete(timerKey);
      sendToPrincipal(toPrincipalId, {
        type: "typing_stop",
        from: asText(fromPrincipalId),
      });
    }, TYPING_TTL_MS);
    if (typeof timer.unref === "function") timer.unref();
    typingExpiryTimers.set(timerKey, timer);
  }

  return sent;
}

export function emitNewDirectMessage({ recipientId, message }) {
  return sendToPrincipal(recipientId, {
    type: "new_message",
    message,
  });
}

export function initChatPresenceRealtime(server) {
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
      if (!token) {
        ws.close(4401, "missing_token");
        return;
      }

      let principalId = "";
      try {
        const payload = verifyAccessToken(token);
        principalId = asText(payload?.sub || payload?.userId);
        if (!principalId) {
          ws.close(4401, "missing_principal_id");
          return;
        }
      } catch {
        ws.close(4401, "invalid_token");
        return;
      }

      const client = { ws, principalId };
      addClient(principalId, client);
      ws.send(toJson({ type: "connected", principalId }));

      ws.on("message", async (raw) => {
        let payload;
        try {
          payload = JSON.parse(raw.toString());
        } catch {
          return;
        }
        const counterpartId = asText(payload?.counterpartId);
        if (!counterpartId) return;
        if (payload?.type !== "typing" && payload?.type !== "typing_stop") return;

        // The raw WS layer carries no role claim, unlike the REST routes
        // (which derive doctorId/patientId from req.auth.role). Try both
        // orderings and require an authorized link either way before
        // relaying a typing signal — a connected user must not be able to
        // trigger a typing indicator for an arbitrary counterpartId with no
        // relationship to them.
        let authorized = false;
        try {
          authorized =
            (await isDoctorPatientLinked({
              doctorId: principalId,
              patientId: counterpartId,
            })) ||
            (await isDoctorPatientLinked({
              doctorId: counterpartId,
              patientId: principalId,
            }));
        } catch {
          authorized = false;
        }
        if (!authorized) return;

        emitTypingEvent({
          toPrincipalId: counterpartId,
          fromPrincipalId: principalId,
          typing: payload.type === "typing",
        });
      });

      ws.on("close", () => removeClient(principalId, client));
      ws.on("error", () => removeClient(principalId, client));
    });
  });

  const heartbeat = setInterval(() => {
    const allClients = Array.from(principalClients.values()).flatMap((set) =>
      Array.from(set)
    );
    for (const client of allClients) {
      const ws = client.ws;
      if (!ws || ws.readyState !== WS_OPEN) {
        removeClient(client.principalId, client);
        continue;
      }
      if (ws.isAlive === false) {
        removeClient(client.principalId, client);
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
