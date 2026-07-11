import { normalizeFamilyCareConfigInput } from "./familyCareConfigService.js";

describe("Family Care platform configuration", () => {
  it("allowlists fields and bounds numeric controls", () => {
    const config = normalizeFamilyCareConfigInput({
      enabled: true,
      unexpected: "ignored",
      features: { medicationV2: true, unknownFeature: true },
      limits: { maxManagedProfiles: 500, maxCaregiversPerProfile: -4 },
      invitations: { windowMinutes: 0, maxPerWindow: 5000 },
    });
    expect(config).toEqual({
      enabled: true,
      developmentAutoEntitle: false,
      features: {
        medicationV2: true,
        caregiverAlerts: false,
        insights: false,
        emergencyCardV2: false,
        vaccination: false,
        insurance: false,
      },
      limits: { maxManagedProfiles: 50, maxCaregiversPerProfile: 0 },
      invitations: { windowMinutes: 1, maxPerWindow: 1000 },
    });
    expect(config.unexpected).toBeUndefined();
  });

  it("preserves stored values when a partial payload omits them", () => {
    const config = normalizeFamilyCareConfigInput(
      { features: { insights: true } },
      {
        enabled: true,
        developmentAutoEntitle: true,
        features: { medicationV2: true, insights: false },
        limits: { maxManagedProfiles: 8, maxCaregiversPerProfile: 4 },
        invitations: { windowMinutes: 30, maxPerWindow: 12 },
      },
    );
    expect(config.enabled).toBe(true);
    expect(config.features.medicationV2).toBe(true);
    expect(config.features.insights).toBe(true);
    expect(config.limits.maxManagedProfiles).toBe(8);
    expect(config.invitations.maxPerWindow).toBe(12);
  });
});
