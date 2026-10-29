import { describe, expect, it } from "vitest";
import { buildKimiConfig } from "../src/kimi.ts";

describe("buildKimiConfig", () => {
  const toml = buildKimiConfig({
    gatewayUrl: "http://127.0.0.1:8787",
    token: "adg_deadbeef",
    modelId: "gemini-2.5-flash-lite",
  });

  it("declares a single openai_legacy provider pointing at the gateway /v1", () => {
    expect(toml).toContain("[providers.clixad]");
    expect(toml).toContain('type = "openai_legacy"');
    expect(toml).toContain('base_url = "http://127.0.0.1:8787/v1"');
    expect(toml).toContain('api_key = "adg_deadbeef"');
  });

  it("registers the model under the provider and sets it as default", () => {
    expect(toml).toContain('default_model = "gemini-2.5-flash-lite"');
    expect(toml).toContain('[models."gemini-2.5-flash-lite"]');
    expect(toml).toContain('provider = "clixad"');
    expect(toml).toContain('model = "gemini-2.5-flash-lite"');
    // Known model → its real context window, not the fallback.
    expect(toml).toContain("max_context_size = 1048576");
  });

  it("normalizes a trailing slash on the gateway URL", () => {
    const t = buildKimiConfig({ gatewayUrl: "http://127.0.0.1:8787/", token: "adg_x", modelId: "gpt-5-nano" });
    expect(t).toContain('base_url = "http://127.0.0.1:8787/v1"');
    expect(t).not.toContain("8787//v1");
  });

  it("falls back to a default context size for unknown models", () => {
    const t = buildKimiConfig({ gatewayUrl: "http://127.0.0.1:8787", token: "adg_x", modelId: "some-future-model" });
    expect(t).toContain("max_context_size = 256000");
  });
});
