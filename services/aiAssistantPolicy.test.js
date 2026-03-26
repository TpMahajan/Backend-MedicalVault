import { describe, expect, it } from "@jest/globals";
import {
  buildAuthorizedScope,
  buildSafetyPayload,
  detectInputLanguage,
  estimateExtractionConfidence,
  isOperationalIntent,
  isPatientSensitiveIntent,
  normalizeLanguage,
  resolveLanguage,
  resolvePersona,
} from "./aiAssistantPolicy.js";

describe("aiAssistantPolicy", () => {
  it("resolves persona from authenticated role", () => {
    expect(resolvePersona("doctor")).toBe("doctor");
    expect(resolvePersona("patient")).toBe("patient");
    expect(resolvePersona("admin")).toBe("admin");
    expect(resolvePersona("superadmin")).toBe("superadmin");
    expect(resolvePersona("unknown")).toBe("patient");
  });

  it("normalizes languages and supports locale-style values", () => {
    expect(normalizeLanguage("en")).toBe("english");
    expect(normalizeLanguage("hi")).toBe("hindi");
    expect(normalizeLanguage("mr")).toBe("marathi");
    expect(normalizeLanguage("gu")).toBe("gujarati");
  });

  it("uses preferred language by default with per-message override", () => {
    const resolvedFromExplicitInput = resolveLanguage({
      prompt: "Explain this report",
      context: { preferredLanguage: "en", userInputLanguage: "hi" },
      principal: {},
    });
    expect(resolvedFromExplicitInput.resolvedLanguage).toBe("hindi");

    const resolvedFromDetectedScript = resolveLanguage({
      prompt: "मुझे यह रिपोर्ट समझाओ",
      context: { preferredLanguage: "en" },
      principal: {},
    });
    expect(resolvedFromDetectedScript.resolvedLanguage).toBe("hindi");
  });

  it("detects patient-sensitive intents and excludes schedule-only prompts", () => {
    expect(
      isPatientSensitiveIntent("show my patient lab report", {
        isDocumentRequest: true,
      })
    ).toBe(true);

    expect(
      isPatientSensitiveIntent("what is my schedule today", {
        isScheduleRequest: true,
      })
    ).toBe(false);
  });

  it("detects operational intent keywords for admin mode", () => {
    expect(isOperationalIntent("show compliance dashboard and security alerts")).toBe(
      true
    );
    expect(isOperationalIntent("analyze this patient report")).toBe(false);
  });

  it("builds authorized scope metadata for doctor and patient flows", () => {
    const patientScope = buildAuthorizedScope({
      role: "patient",
      requesterId: "patient-1",
    });
    expect(patientScope.mode).toBe("self");
    expect(patientScope.patientId).toBe("patient-1");

    const doctorScope = buildAuthorizedScope({
      role: "doctor",
      requesterId: "doctor-1",
      patientId: "patient-2",
    });
    expect(doctorScope.mode).toBe("patient_context");
    expect(doctorScope.patientId).toBe("patient-2");
  });

  it("returns confidence and safety warnings for low quality extraction", () => {
    const extractionConfidence = estimateExtractionConfidence({
      metadata: { fallbackUsed: true },
      text: "short text",
    });
    expect(extractionConfidence.level).toBe("low");

    const safety = buildSafetyPayload({
      prompt: "mild question",
      reply: "ok",
      extractionConfidence,
      missingData: ["Dose is missing from prescription."],
    });
    expect(safety.warnings.length).toBeGreaterThan(0);
  });

  it("detects script language quickly", () => {
    expect(detectInputLanguage("hello there")).toBe("english");
    expect(detectInputLanguage("આ રિપોર્ટ સમજાવો")).toBe("gujarati");
  });
});
