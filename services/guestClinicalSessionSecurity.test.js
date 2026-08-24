import { beforeEach, describe, expect, it } from "@jest/globals";

beforeEach(() => {
  process.env.GUEST_SESSION_SECRET = "a-guest-session-secret-that-is-at-least-thirty-two-bytes";
  process.env.GUEST_IP_HMAC_SECRET = "an-ip-hmac-secret-that-is-at-least-thirty-two-bytes";
});

describe("guest clinical-session security primitives", () => {
  it("generates opaque invitations and hashes human-readable codes", async () => {
    const { invitationId, joinCode, sha256 } = await import("./guestClinicalSessionSecurity.js");
    const invitation = invitationId();
    expect(Buffer.from(invitation, "base64url")).toHaveLength(32);
    const code = joinCode();
    expect(code).toMatch(/^[A-Z0-9]{12}$/);
    expect(sha256(code)).not.toBe(code);
  });

  it("correlates IP addresses with a keyed HMAC and only exposes a masked value", async () => {
    const { hmac, maskIp } = await import("./guestClinicalSessionSecurity.js");
    expect(hmac("ip:203.0.113.9")).toMatch(/^[a-f0-9]{64}$/);
    expect(hmac("ip:203.0.113.9")).toBe(hmac("ip:203.0.113.9"));
    expect(maskIp("203.0.113.9")).toBe("203.0.xxx.xxx");
  });

  it("marks email verification as unverified clinician identity", async () => {
    const { verificationLabel } = await import("./guestClinicalSessionSecurity.js");
    expect(verificationLabel("email_verified_registration_claimed")).toContain("Unverified");
    expect(verificationLabel("email_verified_unverified")).not.toContain("Doctor");
  });
});
