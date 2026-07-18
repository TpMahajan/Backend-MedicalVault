import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const doctorFind = jest.fn();

await jest.unstable_mockModule("../middleware/auth.js", () => ({
  auth: (req, _res, next) => {
    req.user = { _id: "patient-1" };
    next();
  },
  requirePatient: (_req, _res, next) => next(),
}));
await jest.unstable_mockModule("../models/Appointment.js", () => ({
  Appointment: {},
}));
await jest.unstable_mockModule("../models/File.js", () => ({ Document: {} }));
await jest.unstable_mockModule("../models/DoctorUser.js", () => ({
  DoctorUser: { find: doctorFind },
}));
await jest.unstable_mockModule("../config/s3.js", () => ({
  BUCKET_NAME: "test-bucket",
}));
await jest.unstable_mockModule("../utils/s3Utils.js", () => ({
  generateSignedUrl: jest.fn(),
}));

const { default: patientAppointmentsRouter } =
    await import("./patientAppointments.js");
const app = express();
app.use(express.json());
app.use("/api/patient", patientAppointmentsRouter);

beforeEach(() => {
  doctorFind.mockReset();
  doctorFind.mockReturnValue({
    select: () => ({
      sort: () => ({
        limit: () => ({
          lean: async () => [
            {
              _id: "doctor-1",
              name: "Dr. Ada Lovelace",
              specialty: "Cardiology",
              location: "Central Clinic",
              mobile: "+15550000000",
              email: "ada@example.test",
              bio: "Heart-health specialist",
              yearsOfExperience: 12,
              languages: ["English", "Hindi"],
              isActive: true,
            },
          ],
        }),
      }),
    }),
  });
});

describe("GET /api/patient/appointments/doctors", () => {
  it("returns only directory-safe details for active doctors", async () => {
    const res = await request(app).get("/api/patient/appointments/doctors");

    expect(res.status).toBe(200);
    expect(doctorFind).toHaveBeenCalledWith({ isActive: true });
    expect(res.body).toEqual({
      success: true,
      count: 1,
      doctors: [
        {
          id: "doctor-1",
          name: "Dr. Ada Lovelace",
          specialization: "Cardiology",
          location: "Central Clinic",
          profilePictureUrl: null,
          yearsOfExperience: 12,
          languages: ["English", "Hindi"],
          bio: "Heart-health specialist",
        },
      ],
    });
    expect(res.body.doctors[0]).not.toHaveProperty("email");
    expect(res.body.doctors[0]).not.toHaveProperty("mobile");
  });
});
