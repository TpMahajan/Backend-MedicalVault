import { WebSocketServer } from "ws";

export const PUBLIC_AD_SURFACES = ["APP_DASHBOARD", "WEB_LANDING", "QR_PAGE"];
export const PUBLIC_ALERT_PLATFORMS = ["APP", "WEB"];

const ALL_TOKEN = "ALL";
const HEARTBEAT_INTERVAL_MS = 30_000;
const WS_OPEN = 1;
const activeClients = new Map();

function toUpperString(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function toList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeValues(rawValues, allowList) {
  const normalized = toList(rawValues)
    .map(toUpperString)
    .filter((entry) => allowList.includes(entry) || entry === ALL_TOKEN);

  if (normalized.includes(ALL_TOKEN)) {
    return [...allowList];
  }

  return [...new Set(normalized)];
}

function hasIntersection(left, right) {
  if (!left || left.size === 0 || !right || right.size === 0) return true;
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function serializeEvent(payload) {
  return JSON.stringify({
    ...payload,
    timestamp: new Date().toISOString(),
  });
}

export function initPublicConfigRealtime(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url || "", `http://${request.headers.host}`);
      if (url.pathname !== "/api/public/ws") {
        return;
      }
      request.__wsHandled = true;

      wss.handleUpgrade(request, socket, head, (ws) => {
        const platforms = normalizeValues(
          [url.searchParams.get("platform"), url.searchParams.get("platforms")],
          PUBLIC_ALERT_PLATFORMS
        );
        const surfaces = normalizeValues(
          [url.searchParams.get("surface"), url.searchParams.get("surfaces")],
          PUBLIC_AD_SURFACES
        );

        const clientId = `${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        activeClients.set(clientId, {
          ws,
          platforms: new Set(platforms),
          surfaces: new Set(surfaces),
        });

        ws.isAlive = true;
        ws.on("pong", () => {
          ws.isAlive = true;
        });

        ws.on("close", () => {
          activeClients.delete(clientId);
        });

        ws.on("error", () => {
          activeClients.delete(clientId);
        });

        ws.send(
          serializeEvent({
            type: "connected",
            message: "Public config realtime connected",
            platforms,
            surfaces,
          })
        );
      });
    } catch {
      socket.destroy();
    }
  });

  const heartbeat = setInterval(() => {
    for (const [clientId, client] of activeClients.entries()) {
      const { ws } = client;
      if (ws.readyState !== WS_OPEN) {
        activeClients.delete(clientId);
        continue;
      }
      if (ws.isAlive === false) {
        ws.terminate();
        activeClients.delete(clientId);
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

export function broadcastPublicConfigEvent(payload) {
  const type = toUpperString(payload?.type).toLowerCase();
  if (!type) return;

  const platforms = normalizeValues(payload?.platforms, PUBLIC_ALERT_PLATFORMS);
  const surfaces = normalizeValues(payload?.surfaces, PUBLIC_AD_SURFACES);

  const event = serializeEvent({
    type,
    platforms,
    surfaces,
    reason: String(payload?.reason || "").trim(),
  });

  const eventPlatforms = new Set(platforms);
  const eventSurfaces = new Set(surfaces);

  for (const [clientId, client] of activeClients.entries()) {
    const { ws, platforms: clientPlatforms, surfaces: clientSurfaces } = client;
    if (ws.readyState !== WS_OPEN) {
      activeClients.delete(clientId);
      continue;
    }

    const platformMatch = hasIntersection(eventPlatforms, clientPlatforms);
    const surfaceMatch = hasIntersection(eventSurfaces, clientSurfaces);
    if (!platformMatch || !surfaceMatch) continue;

    try {
      ws.send(event);
    } catch {
      activeClients.delete(clientId);
      try {
        ws.terminate();
      } catch {
        // Ignore close errors.
      }
    }
  }
}
