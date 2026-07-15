import http from "node:http";
import WebSocket from "ws";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

// Isolates the typing-indicator authorization + TTL behavior added to
// services/chatPresenceRealtime.js. This boots a real ephemeral HTTP
// server with the actual WebSocketServer attached (the raw `ws` upgrade
// handling can't be meaningfully unit-tested without a real socket pair),
// and connects real `ws` clients against it — the same pattern used for
// integration coverage elsewhere in this repo, just via a live loopback
// socket instead of supertest since this endpoint isn't a REST route.

process.env.JWT_SECRET =
  process.env.JWT_SECRET || "test-jwt-secret-at-least-32-chars-long!!";

const isDoctorPatientLinkedMock = jest.fn();

await jest.unstable_mockModule("./doctorPatientLink.js", () => ({
  isDoctorPatientLinked: isDoctorPatientLinkedMock,
  resolveDoctorPatientLink: jest.fn(),
}));

const { initChatPresenceRealtime } = await import("./chatPresenceRealtime.js");
const { signAccessToken } = await import("./tokenService.js");

const DOCTOR_ID = "507f1f77bcf86cd799439012";
const PATIENT_ID = "507f1f77bcf86cd799439011";
const STRANGER_ID = "507f1f77bcf86cd799439099";

let server;
let baseWsUrl;

// Every inbound message is buffered onto the socket from the moment it
// opens (not from whenever a test happens to call waitForMessage), so a
// message that arrives immediately after connect — like the server's
// "connected" handshake, sent synchronously inside the upgrade callback —
// can never be missed by a listener that gets attached a tick later.
const attachMessageBuffer = (ws) => {
  ws.__messageBuffer = [];
  ws.__pendingWaiters = [];
  ws.on("message", (raw) => {
    const data = JSON.parse(raw.toString());
    const waiterIndex = ws.__pendingWaiters.findIndex((w) => w.predicate(data));
    if (waiterIndex !== -1) {
      const [waiter] = ws.__pendingWaiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(data);
      return;
    }
    ws.__messageBuffer.push(data);
  });
};

const waitForMessage = (ws, predicate, timeoutMs = 2000) => {
  const bufferedIndex = ws.__messageBuffer.findIndex(predicate);
  if (bufferedIndex !== -1) {
    const [data] = ws.__messageBuffer.splice(bufferedIndex, 1);
    return Promise.resolve(data);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = ws.__pendingWaiters.findIndex((w) => w.resolve === resolve);
      if (idx !== -1) ws.__pendingWaiters.splice(idx, 1);
      reject(new Error(`Timed out waiting for message matching predicate`));
    }, timeoutMs);
    ws.__pendingWaiters.push({ predicate, resolve, timer });
  });
};

const connect = (principalId, role) =>
  new Promise((resolve, reject) => {
    const token = signAccessToken({ principalId, role });
    const ws = new WebSocket(`${baseWsUrl}?token=${token}`);
    attachMessageBuffer(ws);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });

beforeAll(async () => {
  server = http.createServer((_req, res) => res.end());
  initChatPresenceRealtime(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  baseWsUrl = `ws://127.0.0.1:${port}/api/sessions/chat/ws`;
});

afterEach(() => {
  isDoctorPatientLinkedMock.mockReset();
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("chat presence realtime — typing authorization", () => {
  it("relays typing to the counterpart when a doctor-patient link exists", async () => {
    isDoctorPatientLinkedMock.mockImplementation(async ({ doctorId, patientId }) => {
      return doctorId === DOCTOR_ID && patientId === PATIENT_ID;
    });

    const doctorWs = await connect(DOCTOR_ID, "doctor");
    const patientWs = await connect(PATIENT_ID, "patient");

    await waitForMessage(doctorWs, (m) => m.type === "connected");
    await waitForMessage(patientWs, (m) => m.type === "connected");

    doctorWs.send(JSON.stringify({ type: "typing", counterpartId: PATIENT_ID }));

    const received = await waitForMessage(patientWs, (m) => m.type === "typing");
    expect(received.from).toBe(DOCTOR_ID);

    doctorWs.close();
    patientWs.close();
  });

  it("does not relay typing when no doctor-patient link exists (authorization gap fix)", async () => {
    isDoctorPatientLinkedMock.mockResolvedValue(false);

    const strangerWs = await connect(STRANGER_ID, "patient");
    const patientWs = await connect(PATIENT_ID, "patient");

    await waitForMessage(strangerWs, (m) => m.type === "connected");
    await waitForMessage(patientWs, (m) => m.type === "connected");

    strangerWs.send(JSON.stringify({ type: "typing", counterpartId: PATIENT_ID }));

    await expect(
      waitForMessage(patientWs, (m) => m.type === "typing", 500)
    ).rejects.toThrow(/Timed out/);

    strangerWs.close();
    patientWs.close();
  });

  it("auto-expires a typing indicator via server-side TTL if typing_stop is never sent", async () => {
    isDoctorPatientLinkedMock.mockResolvedValue(true);

    const doctorWs = await connect(DOCTOR_ID, "doctor");
    const patientWs = await connect(PATIENT_ID, "patient");
    await waitForMessage(doctorWs, (m) => m.type === "connected");
    await waitForMessage(patientWs, (m) => m.type === "connected");

    doctorWs.send(JSON.stringify({ type: "typing", counterpartId: PATIENT_ID }));
    await waitForMessage(patientWs, (m) => m.type === "typing");

    // Simulate the doctor's app being killed mid-typing — no typing_stop
    // is ever sent. The server's TTL (5s) must force-expire the indicator.
    const expired = await waitForMessage(
      patientWs,
      (m) => m.type === "typing_stop",
      7000
    );
    expect(expired.from).toBe(DOCTOR_ID);

    doctorWs.close();
    patientWs.close();
  }, 10000);
});
