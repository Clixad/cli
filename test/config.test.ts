/**
 * CLI config: env precedence and file permissions.
 *
 * `loadConfig` used to fold the env vars into its defaults and then spread the
 * stored file *over* them. Because `saveConfig` writes the whole object,
 * `gatewayUrl` was present in config.json from the first login onwards and always
 * won — so `CLIXAD_GATEWAY_URL` silently did nothing, despite `.env.example`
 * advertising it as the way to point the CLI at a different gateway.
 *
 * The file also holds the bearer token that spends real credits, so it is written
 * 0600 rather than at whatever the umask allows.
 */
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `homedir()` is mocked rather than steered with $HOME: libuv reads the real OS
// environment, which does not see `process.env` writes made inside a vitest worker
// thread, so setting HOME here would silently leave CONFIG_PATH on the real
// ~/.clixad — and these tests would then read and overwrite the user's own config.
const hoisted = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => hoisted.home };
});

let home: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "adg-config-"));
  hoisted.home = home;
  delete process.env.CLIXAD_GATEWAY_URL;
  delete process.env.CLIXAD_DASHBOARD_URL;
  vi.resetModules(); // CONFIG_PATH is resolved at module load
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

/** Import a fresh copy of the module so CONFIG_PATH picks up the temp HOME. */
async function freshConfig() {
  vi.resetModules();
  return import("../src/config.ts");
}

/** Write a config.json as a previous login would have left it. */
function storedConfig(contents: Record<string, unknown>): void {
  mkdirSync(join(home, ".clixad"), { recursive: true });
  writeFileSync(join(home, ".clixad", "config.json"), JSON.stringify(contents), "utf8");
}

describe("loadConfig", () => {
  it("falls back to defaults with no file and no env", async () => {
    const { loadConfig } = await freshConfig();
    const config = loadConfig();
    expect(config.gatewayUrl).toBe("https://clixad.onrender.com");
    expect(config.dashboardUrl).toBe("https://app.clixad.io");
    expect(config.model).toBe("gemini-2.5-flash-lite");
  });

  it("reads a stored config", async () => {
    storedConfig({ gatewayUrl: "http://stored:1234", token: "adg_stored", model: "gpt-5-nano" });
    const { loadConfig } = await freshConfig();
    const config = loadConfig();
    expect(config.gatewayUrl).toBe("http://stored:1234");
    expect(config.token).toBe("adg_stored");
    expect(config.model).toBe("gpt-5-nano");
  });

  // The actual bug: a stored gatewayUrl (always present after a login) beat the
  // env var, so there was no way to redirect the CLI without editing config.json.
  it("lets an explicit env var override the stored gateway URL", async () => {
    storedConfig({ gatewayUrl: "http://stored:1234", dashboardUrl: "http://stored:5678" });
    process.env.CLIXAD_GATEWAY_URL = "https://gateway.example.com";
    process.env.CLIXAD_DASHBOARD_URL = "https://dash.example.com";
    const { loadConfig } = await freshConfig();
    const config = loadConfig();
    expect(config.gatewayUrl).toBe("https://gateway.example.com");
    expect(config.dashboardUrl).toBe("https://dash.example.com");
  });

  it("keeps the stored value when the env var is unset or empty", async () => {
    storedConfig({ gatewayUrl: "http://stored:1234" });
    process.env.CLIXAD_GATEWAY_URL = ""; // set-but-empty must not blank the URL
    const { loadConfig } = await freshConfig();
    expect(loadConfig().gatewayUrl).toBe("http://stored:1234");
  });

  it("does not let the env clobber unrelated stored fields", async () => {
    storedConfig({ token: "adg_keepme", model: "gpt-5-nano" });
    process.env.CLIXAD_GATEWAY_URL = "https://gateway.example.com";
    const { loadConfig } = await freshConfig();
    const config = loadConfig();
    expect(config.token).toBe("adg_keepme");
    expect(config.model).toBe("gpt-5-nano");
  });

  // `saveConfig` writes the whole object, so both endpoints are pinned into
  // config.json from the first login. Every install that logged in before the
  // gateway was deployed carries `http://127.0.0.1:8787` and `:8788`, and nothing
  // is listening on either anymore. The dashboard one is not cosmetic: the ad
  // wall is how you earn credits, so a stale value dead-ends the product.
  it("migrates the pre-deployment localhost endpoints onto the hosted one", async () => {
    storedConfig({
      gatewayUrl: "http://127.0.0.1:8787",
      dashboardUrl: "http://127.0.0.1:8788",
      token: "adg_stored",
    });
    const { loadConfig } = await freshConfig();
    const config = loadConfig();
    expect(config.gatewayUrl).toBe("https://clixad.onrender.com");
    expect(config.dashboardUrl).toBe("https://app.clixad.io");
  });

  // The migration above used to carry the identity across, and that is a broken
  // install rather than a convenience: the token was minted by a local dev
  // gateway, production answers `401 {"error":"invalid token"}` to it forever,
  // and the CLI reads that as "not logged in" and tells you to run a command it
  // then refuses to accept. Moving the gateway means the account moved too.
  it("drops the identity when the gateway is migrated out from under it", async () => {
    storedConfig({
      gatewayUrl: "http://127.0.0.1:8787",
      token: "adg_local",
      userId: "u_local",
      email: "dev@local",
      login: "FlosGit",
      model: "gpt-5-nano",
    });
    const { loadConfig } = await freshConfig();
    const config = loadConfig();
    expect(config.token).toBeUndefined();
    expect(config.userId).toBeUndefined();
    expect(config.email).toBeUndefined();
    expect(config.login).toBeUndefined();
    expect(config.model).toBe("gpt-5-nano"); // a preference, not an identity
  });

  // The dashboard does not issue tokens, so its own migration must not sign
  // anyone out — only `gatewayUrl` carries the identity.
  it("keeps the identity when only the dashboard URL is migrated", async () => {
    storedConfig({
      gatewayUrl: "https://clixad.onrender.com",
      dashboardUrl: "http://127.0.0.1:8788",
      token: "adg_hosted",
    });
    const { loadConfig } = await freshConfig();
    const config = loadConfig();
    expect(config.dashboardUrl).toBe("https://app.clixad.io");
    expect(config.token).toBe("adg_hosted");
  });

  // Migrated *back* onto the same server by an env var: nothing moved, so the
  // token is still the right token. `localhost` and `127.0.0.1` are one host.
  it("keeps the identity when the env var points back at the same gateway", async () => {
    storedConfig({ gatewayUrl: "http://localhost:8787", token: "adg_local" });
    process.env.CLIXAD_GATEWAY_URL = "http://127.0.0.1:8787";
    const { loadConfig } = await freshConfig();
    const config = loadConfig();
    expect(config.gatewayUrl).toBe("http://127.0.0.1:8787");
    expect(config.token).toBe("adg_local");
  });

  // A URL the user chose is never migrated, so nothing about the identity is
  // in question either — an env var redirect is a detour, not a move, and
  // clearing here would let one exported variable destroy a real token at the
  // next saveConfig.
  it("never drops the identity for a gateway the user chose themselves", async () => {
    storedConfig({ gatewayUrl: "https://clixad.onrender.com", token: "adg_hosted" });
    process.env.CLIXAD_GATEWAY_URL = "http://127.0.0.1:8787";
    const { loadConfig } = await freshConfig();
    expect(loadConfig().token).toBe("adg_hosted");
  });

  it("leaves the identity alone when there is no stored gateway at all", async () => {
    storedConfig({ token: "adg_hosted" });
    const { loadConfig } = await freshConfig();
    expect(loadConfig().token).toBe("adg_hosted");
  });

  it("drops a stored endpoint that is only an inherited old default", async () => {
    storedConfig({ gatewayUrl: "http://localhost:8787", dashboardUrl: "http://localhost:8788" });
    const { loadConfig } = await freshConfig();
    const config = loadConfig();
    expect(config.gatewayUrl).toBe("https://clixad.onrender.com");
    expect(config.dashboardUrl).toBe("https://app.clixad.io");
  });

  // The `!== DEFAULTS[key]` guard, from the other side: an already-migrated
  // config must be a fixed point, not something that gets rewritten on every
  // load. (Both endpoints have now moved, so there is no longer a stored value
  // that is simultaneously listed and current — this is what remains testable,
  // and it is the property that actually matters.)
  it("leaves an already-migrated config alone", async () => {
    storedConfig({
      gatewayUrl: "https://clixad.onrender.com",
      dashboardUrl: "https://app.clixad.io",
    });
    const { loadConfig } = await freshConfig();
    const config = loadConfig();
    expect(config.gatewayUrl).toBe("https://clixad.onrender.com");
    expect(config.dashboardUrl).toBe("https://app.clixad.io");
  });

  // 2026-10-20: the earn page's address became app.clixad.io. A config written
  // whole before 2026-09-09 carries the old one; it moves, and since the
  // dashboard issues no token, nobody is signed out and the gateway stays.
  it("moves an inherited clixad.onrender.com earn page to app.clixad.io, and nothing else", async () => {
    storedConfig({
      gatewayUrl: "https://clixad.onrender.com",
      dashboardUrl: "https://clixad.onrender.com",
      token: "adg_hosted",
    });
    const { loadConfig } = await freshConfig();
    const config = loadConfig();
    expect(config.dashboardUrl).toBe("https://app.clixad.io");
    expect(config.gatewayUrl).toBe("https://clixad.onrender.com");
    expect(config.token).toBe("adg_hosted");
  });

  it("never migrates a URL the user chose themselves", async () => {
    storedConfig({ gatewayUrl: "http://127.0.0.1:9999", dashboardUrl: "https://dash.example.com" });
    const { loadConfig } = await freshConfig();
    const config = loadConfig();
    expect(config.gatewayUrl).toBe("http://127.0.0.1:9999");
    expect(config.dashboardUrl).toBe("https://dash.example.com");
  });

  it("still lets the env var win over a migrated endpoint", async () => {
    storedConfig({ gatewayUrl: "http://localhost:8787" });
    process.env.CLIXAD_GATEWAY_URL = "http://127.0.0.1:8787"; // deliberate local gateway
    const { loadConfig } = await freshConfig();
    expect(loadConfig().gatewayUrl).toBe("http://127.0.0.1:8787");
  });

  it("survives a corrupt config file", async () => {
    mkdirSync(join(home, ".clixad"), { recursive: true });
    writeFileSync(join(home, ".clixad", "config.json"), "{ not json", "utf8");
    const { loadConfig } = await freshConfig();
    expect(loadConfig().gatewayUrl).toBe("https://clixad.onrender.com");
  });
});

describe("saveConfig", () => {
  it("round-trips through loadConfig", async () => {
    const { loadConfig, saveConfig } = await freshConfig();
    saveConfig({ ...loadConfig(), token: "adg_secret", model: "gpt-5-nano" });
    expect(loadConfig().token).toBe("adg_secret");
    expect(loadConfig().model).toBe("gpt-5-nano");
  });

  it.skipIf(process.platform === "win32")(
    "writes the token file owner-only (0600) in a 0700 directory",
    async () => {
      const { loadConfig, saveConfig, configPath } = await freshConfig();
      saveConfig({ ...loadConfig(), token: "adg_secret" });
      // eslint-disable-next-line no-bitwise
      expect(statSync(configPath()).mode & 0o777).toBe(0o600);
      // eslint-disable-next-line no-bitwise
      expect(statSync(join(home, ".clixad")).mode & 0o777).toBe(0o700);
    },
  );

  it.skipIf(process.platform === "win32")("tightens permissions on an existing loose file", async () => {
    storedConfig({ token: "adg_old" }); // written 0644 by the helper
    const { loadConfig, saveConfig, configPath } = await freshConfig();
    saveConfig({ ...loadConfig(), token: "adg_new" });
    // eslint-disable-next-line no-bitwise
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });
});

/** config.json as it actually sits on disk, with no defaults layered over it. */
function onDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, ".clixad", "config.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

/**
 * An environment override is a detour, and a detour must not be written down.
 *
 * `saveConfig` wrote the whole in-memory object, so one run with
 * `CLIXAD_GATEWAY_URL` pointed at a local gateway pinned that URL into
 * config.json for good. The next plain run then read it as a superseded default,
 * the identity migration deleted the account with it, and the save after that
 * made the sign-out permanent. Reproducible in three steps, which is what these
 * tests are.
 */
describe("saveConfig — an env override is never persisted", () => {
  it("leaves the stored gateway alone when the env points elsewhere", async () => {
    storedConfig({ gatewayUrl: "https://clixad.onrender.com", token: "adg_prod" });
    process.env.CLIXAD_GATEWAY_URL = "http://127.0.0.1:8787";
    const { loadConfig, saveConfig } = await freshConfig();
    const config = loadConfig();
    expect(config.gatewayUrl).toBe("http://127.0.0.1:8787"); // still wins for this run
    config.turns = 1; // the ordinary save: one finished turn
    saveConfig(config);
    expect(onDisk().gatewayUrl).toBe("https://clixad.onrender.com");
    expect(onDisk().turns).toBe(1);
  });

  it("keeps the next plain run signed in after a run against a local gateway", async () => {
    storedConfig({ gatewayUrl: "https://clixad.onrender.com", token: "adg_prod" });

    // A dev run against a local gateway that saves anything at all.
    process.env.CLIXAD_GATEWAY_URL = "http://127.0.0.1:8787";
    const dev = await freshConfig();
    const devConfig = dev.loadConfig();
    devConfig.turns = 1;
    dev.saveConfig(devConfig);

    // Back to normal, no variable in the environment.
    delete process.env.CLIXAD_GATEWAY_URL;
    const plain = await freshConfig();
    const config = plain.loadConfig();
    expect(config.gatewayUrl).toBe("https://clixad.onrender.com");
    expect(config.token).toBe("adg_prod");
  });

  // The binding that makes the rule above safe. Without `tokenGateway`, not
  // writing the env value would leave a token minted by a local gateway with
  // nothing recording where it came from — and production answers it
  // `401 invalid token` forever.
  it("still signs out a token minted against a gateway this run is not talking to", async () => {
    storedConfig({ token: "adg_local", tokenGateway: "http://127.0.0.1:8787" });
    const { loadConfig } = await freshConfig();
    const config = loadConfig();
    expect(config.gatewayUrl).toBe("https://clixad.onrender.com");
    expect(config.token).toBeUndefined();
    expect(config.tokenGateway).toBeUndefined();
  });

  it("keeps that token when the env points back at the gateway that minted it", async () => {
    storedConfig({ token: "adg_local", tokenGateway: "http://localhost:8787" });
    process.env.CLIXAD_GATEWAY_URL = "http://127.0.0.1:8787";
    const { loadConfig } = await freshConfig();
    expect(loadConfig().token).toBe("adg_local");
  });
});

/**
 * The config is read once at startup and the object is held for the life of the
 * process, so a second session writing its own startup snapshot restored
 * whatever the first had replaced. Every finished turn writes `turns`, so this
 * fired constantly rather than rarely.
 */
describe("saveConfig — only what this process changed", () => {
  it("does not restore a stale token over another session's login", async () => {
    storedConfig({ gatewayUrl: "https://clixad.onrender.com", model: "gpt-5-nano" });

    // Session A opens, signed out, and holds its snapshot.
    const a = await freshConfig();
    const configA = a.loadConfig();
    expect(configA.token).toBeUndefined();

    // Session B logs in, in another terminal.
    const b = await freshConfig();
    const configB = b.loadConfig();
    configB.token = "adg_from_B";
    configB.tokenGateway = configB.gatewayUrl;
    b.saveConfig(configB);

    // Session A finishes a turn.
    configA.turns = 1;
    a.saveConfig(configA);

    expect(onDisk().token).toBe("adg_from_B");
    expect(onDisk().turns).toBe(1);
  });

  it("writes a deletion, so logout still signs out", async () => {
    storedConfig({ token: "adg_old", userId: "u1", email: "a@b.c", model: "gpt-5-nano" });
    const { loadConfig, saveConfig } = await freshConfig();
    const config = loadConfig();
    delete config.token;
    delete config.userId;
    delete config.email;
    saveConfig(config);
    expect(onDisk().token).toBeUndefined();
    expect(onDisk().userId).toBeUndefined();
    expect(onDisk().model).toBe("gpt-5-nano"); // a preference, not an identity
  });
});

/**
 * `writeFileSync` truncates before it writes, so an interrupted save leaves a
 * file `JSON.parse` rejects — and the old `catch {}` turned that into "no
 * token", silently, with the next save making it permanent.
 */
describe("a config file that cannot be read", () => {
  const corrupt = (contents: string) => {
    mkdirSync(join(home, ".clixad"), { recursive: true });
    writeFileSync(join(home, ".clixad", "config.json"), contents, "utf8");
  };

  it("says so instead of starting silently signed out", async () => {
    corrupt('{ "token": "adg_real", "gatew');
    const { loadConfig, takeConfigNotices } = await freshConfig();
    expect(loadConfig().token).toBeUndefined();
    const said = takeConfigNotices().join("\n");
    expect(said).toMatch(/is not valid JSON/);
    expect(said).toMatch(/config\.json/);
  });

  // Zero bytes is what the truncate window actually leaves, and it must not be
  // reported as a parse error pointing at the wrong cause.
  it("tells an empty file apart from a broken one", async () => {
    corrupt("");
    const { loadConfig, takeConfigNotices } = await freshConfig();
    expect(loadConfig().token).toBeUndefined();
    expect(takeConfigNotices().join("\n")).toMatch(/was empty/);
  });

  it("says nothing at all when there is simply no config yet", async () => {
    const { loadConfig, takeConfigNotices } = await freshConfig();
    loadConfig();
    expect(takeConfigNotices()).toEqual([]);
  });

  // The token in it may be the only copy, so the next save moves it aside
  // rather than overwriting it.
  it("quarantines the unreadable file instead of destroying it", async () => {
    corrupt('{ "token": "adg_real", "gatew');
    const { loadConfig, saveConfig, configPath } = await freshConfig();
    const config = loadConfig();
    config.token = "adg_new";
    saveConfig(config);
    expect(readFileSync(`${configPath()}.corrupt`, "utf8")).toContain("adg_real");
    expect(onDisk().token).toBe("adg_new");
  });

  it("drains its notices, so two surfaces cannot both print them", async () => {
    corrupt("");
    const { loadConfig, takeConfigNotices } = await freshConfig();
    loadConfig();
    expect(takeConfigNotices().length).toBe(1);
    expect(takeConfigNotices()).toEqual([]);
  });
});

describe("saveConfig — the write itself", () => {
  it("leaves no temp file behind", async () => {
    const { loadConfig, saveConfig } = await freshConfig();
    saveConfig({ ...loadConfig(), token: "adg_secret" });
    const stray = readdirSync(join(home, ".clixad")).filter((f) => f.endsWith(".tmp"));
    expect(stray).toEqual([]);
  });

  it("never leaves the file unparseable at rest", async () => {
    const { loadConfig, saveConfig, configPath } = await freshConfig();
    saveConfig({ ...loadConfig(), token: "adg_secret" });
    expect(existsSync(configPath())).toBe(true);
    expect(() => JSON.parse(readFileSync(configPath(), "utf8"))).not.toThrow();
  });
});
