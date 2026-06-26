import { describe, expect, it } from "vitest";
import { redactText, redactJson } from "../redact.js";

describe("Hermes-style redaction", () => {
  it("redacts auth headers, env assignments, private keys, token prefixes, and userinfo URLs", () => {
    const authScheme = "Bear" + "er";
    const input = [
      `Authorization: ${authScheme} sk-live_1234567890abcdef`,
      "OPENAI_API_KEY=sk-proj-1234567890abcdef",
      "-----BEGIN PRIVATE KEY-----\nsecret-key-body\n-----END PRIVATE KEY-----",
      "postgres://alice:secretpass@db.example/app",
      "xox" + "b-1234567890-abcdefghijklmnop",
      "slack:\n  botToken: custom-secret-value\n  signingSecret: another-secret-value",
    ].join("\n");
    const out = redactText(input);
    expect(out).not.toContain("sk-live_1234567890abcdef");
    expect(out).not.toContain("sk-proj-1234567890abcdef");
    expect(out).not.toContain("secret-key-body");
    expect(out).not.toContain("secretpass");
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).not.toContain("custom-secret-value");
    expect(out).not.toContain("another-secret-value");
    expect(out).toContain(`Authorization: ${authScheme} [REDACTED]`);
    expect(out).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(out).toContain("[REDACTED PRIVATE KEY]");
  });

  it("recursively redacts JSON secret fields while preserving harmless fields", () => {
    expect(redactJson({ token: "abc", nested: { password: "pw", model: "opus" } })).toEqual({
      token: "[REDACTED]",
      nested: { password: "[REDACTED]", model: "opus" },
    });
  });
});
