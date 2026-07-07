import express from "express";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, jest } from "@jest/globals";

const axiosGetMock = jest.fn();
const axiosPostMock = jest.fn();

const authMock = jest.fn((req, _res, next) => {
  req.auth = { role: "patient", id: "patient-1" };
  req.user = { _id: "patient-1" };
  next();
});

await jest.unstable_mockModule("axios", () => ({
  default: { get: axiosGetMock, post: axiosPostMock },
}));

await jest.unstable_mockModule("../middleware/auth.js", () => ({
  auth: authMock,
}));

const { default: nearbyRouter } = await import("./nearby.js");

const app = express();
app.use(express.json());
app.use("/api/nearby", nearbyRouter);

const originalEnv = { GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY };

const hospitalResult = (overrides = {}) => ({
  place_id: "place-hospital-1",
  name: "City Care Hospital",
  vicinity: "MG Road, Nashik",
  rating: 4.4,
  user_ratings_total: 128,
  opening_hours: { open_now: true },
  geometry: { location: { lat: 20.0005, lng: 73.7901 } },
  ...overrides,
});

// Route each Google legacy URL to a per-type status/results.
const mockGoogle = (byUrl) => {
  axiosGetMock.mockImplementation((url) => {
    const entry = byUrl(url);
    return Promise.resolve({ data: entry });
  });
};

describe("nearby services route (Google Places legacy)", () => {
  beforeEach(() => {
    axiosGetMock.mockReset();
    axiosPostMock.mockReset();
    process.env.GOOGLE_MAPS_API_KEY = "maps-test-key";
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("uses the legacy Web Service (nearbysearch) and never Places API New", async () => {
    mockGoogle(() => ({ status: "OK", results: [hospitalResult()] }));

    const res = await request(app)
      .get("/api/nearby/services")
      .query({ lat: 19.9975, lng: 73.7898, radiusKm: 3, type: "hospital" });

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("google_places_legacy");
    // Legacy GET endpoint with km→m radius.
    expect(axiosGetMock).toHaveBeenCalledWith(
      "https://maps.googleapis.com/maps/api/place/nearbysearch/json",
      expect.objectContaining({
        timeout: 5000,
        params: expect.objectContaining({
          location: "19.9975,73.7898",
          radius: 3000,
          type: "hospital",
          key: "maps-test-key",
        }),
      }),
    );
    // Places API (New) must not be called.
    expect(axiosPostMock).not.toHaveBeenCalled();
    for (const call of axiosGetMock.mock.calls) {
      expect(call[0]).not.toMatch(/places\.googleapis\.com/);
      expect(call[0]).not.toMatch(/overpass/i);
    }
  });

  it("handles comma-separated types and maps OK results to normalized shape", async () => {
    mockGoogle((url) =>
      url.includes("textsearch")
        ? { status: "ZERO_RESULTS", results: [] }
        : { status: "OK", results: [hospitalResult()] },
    );

    const res = await request(app)
      .get("/api/nearby/services")
      .query({
        lat: 19.9975,
        lng: 73.7898,
        radiusKm: 10,
        type: "hospital,clinic,doctor,pharmacy,ambulance",
      });

    expect(res.status).toBe(200);
    // hospital + doctor + pharmacy => nearbysearch; clinic + ambulance => textsearch.
    const urls = axiosGetMock.mock.calls.map((c) => c[0]);
    expect(urls.filter((u) => u.includes("nearbysearch")).length).toBe(3);
    expect(urls.filter((u) => u.includes("textsearch")).length).toBe(2);
    expect(res.body.services[0]).toEqual(
      expect.objectContaining({
        id: "place-hospital-1",
        placeId: "place-hospital-1",
        name: "City Care Hospital",
        type: "hospital",
        address: "MG Road, Nashik",
        phone: null,
        lat: 20.0005,
        lng: 73.7901,
        rating: 4.4,
        openNow: true,
        source: "google_places_legacy",
      }),
    );
  });

  it("returns clean empty state + fallback on ZERO_RESULTS", async () => {
    mockGoogle(() => ({ status: "ZERO_RESULTS", results: [] }));

    const res = await request(app)
      .get("/api/nearby/services")
      .query({ lat: 19.9975, lng: 73.7898, radiusKm: 5, type: "hospital" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.services).toEqual([]);
    expect(res.body.fallback.length).toBeGreaterThan(0);
    expect(res.body.criticalServices.length).toBeGreaterThan(0);
  });

  it("returns GOOGLE_MAPS_REQUEST_DENIED + fallback when the key is not allowed", async () => {
    mockGoogle(() => ({
      status: "REQUEST_DENIED",
      error_message: "You're calling a legacy API, which is not enabled for your project.",
      results: [],
    }));

    const res = await request(app)
      .get("/api/nearby/services")
      .query({ lat: 19.9975, lng: 73.7898, radiusKm: 5, type: "hospital,clinic" });

    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("GOOGLE_MAPS_REQUEST_DENIED");
    expect(res.body.message).toMatch(/not allowed to access Places API/i);
    expect(res.body.fallback.length).toBeGreaterThan(0);
    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it("provides ambulance fallback contacts even when Google returns none", async () => {
    mockGoogle(() => ({ status: "ZERO_RESULTS", results: [] }));

    const res = await request(app)
      .get("/api/nearby/services")
      .query({ lat: 19.9975, lng: 73.7898, radiusKm: 5, type: "ambulance" });

    expect(res.status).toBe(200);
    expect(res.body.fallback.some((f) => f.phone === "108")).toBe(true);
  });

  it("deduplicates the same place returned across types", async () => {
    mockGoogle(() => ({ status: "OK", results: [hospitalResult()] }));

    const res = await request(app)
      .get("/api/nearby/services")
      .query({ lat: 19.9975, lng: 73.7898, radiusKm: 5, type: "hospital,doctor,pharmacy" });

    // Same place_id from 3 type queries collapses to one.
    expect(res.body.services).toHaveLength(1);
  });

  it("converts radiusKm to meters and clamps to the max", async () => {
    mockGoogle(() => ({ status: "OK", results: [] }));

    const res = await request(app)
      .get("/api/nearby/services")
      .query({ lat: 19.9975, lng: 73.7898, radiusKm: 100, type: "hospital" });

    expect(res.body.radiusKm).toBe(25); // clamped to MAX_RADIUS_KM
    expect(axiosGetMock.mock.calls[0][1].params.radius).toBe(25000);
  });

  it("returns a degraded response with fallback when the key is missing", async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;

    const res = await request(app)
      .get("/api/nearby/services")
      .query({ lat: 19.9975, lng: 73.7898, radiusKm: 5, type: "hospital" });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("GOOGLE_MAPS_API_KEY_MISSING");
    expect(res.body.fallback.length).toBeGreaterThan(0);
    expect(axiosGetMock).not.toHaveBeenCalled();
  });
});
