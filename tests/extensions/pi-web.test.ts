import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { dirname } from "node:path";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";

// Mock node:fs before importing the module under test
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    chmodSync: vi.fn(),
    mkdirSync: vi.fn((path: string, options?: unknown) => {
      if (typeof path === "string" && path.includes("/.tmp-test-")) {
        return (actual as any).mkdirSync(path, options as any);
      }
      return undefined;
    }),
    writeFileSync: vi.fn((path: string, content: string, options?: unknown) => {
      const tokenEnvPath = `${homedir()}/.config/pi-web/env`;
      if (typeof path === "string" && path === tokenEnvPath) {
        (globalThis as any).__MOCK_PI_WEB_ENV_CONTENT__ = content;
        return undefined;
      }
      return (actual as any).writeFileSync(path, content, options);
    }),
    readFileSync: vi.fn((path: string, encoding: BufferEncoding) => {
      // Delegate to actual unless it's the token env file
      const tokenEnvPath = `${homedir()}/.config/pi-web/env`;
      if (typeof path === "string" && path === tokenEnvPath) {
        const content = (globalThis as any).__MOCK_PI_WEB_ENV_CONTENT__;
        if (content !== undefined) return content;
        const token = (globalThis as any).__MOCK_PI_WEB_TOKEN__;
        if (token === undefined) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        if (token === null) return "";
        return `PI_WEB_TOKEN=${token}\n`;
      }
      return (actual as any).readFileSync(path, encoding);
    }),
  };
});

import setupPiWeb, {
  isTailscaleHost,
  isSSH,
  normalizeCommandArgs,
  readPiWebToken,
  writePiWebToken,
  cleanupPiWebNpmTemps,
} from "../../.pi/extensions/pi-web.ts";

declare global {
  var __MOCK_PI_WEB_TOKEN__: string | null | undefined;
  var __MOCK_PI_WEB_ENV_CONTENT__: string | undefined;
}

// ── isSSH ───────────────────────────────────────────────────────────
describe("isSSH", () => {
  const orig = { ...process.env };

  beforeEach(() => {
    delete process.env.SSH_TTY;
    delete process.env.SSH_CONNECTION;
    delete process.env.SSH_CLIENT;
  });

  afterEach(() => {
    process.env = { ...orig };
  });

  it("returns false when no SSH env vars are set", () => {
    expect(isSSH()).toBe(false);
  });

  it("returns true when SSH_TTY is set", () => {
    process.env.SSH_TTY = "/dev/pts/0";
    expect(isSSH()).toBe(true);
  });

  it("returns true when SSH_CONNECTION is set", () => {
    process.env.SSH_CONNECTION = "192.168.1.1 1234 10.0.0.1 22";
    expect(isSSH()).toBe(true);
  });

  it("returns true when SSH_CLIENT is set", () => {
    process.env.SSH_CLIENT = "192.168.1.1 1234 22";
    expect(isSSH()).toBe(true);
  });
});

// ── isTailscaleHost ─────────────────────────────────────────────────
describe("isTailscaleHost", () => {
  it("detects Tailscale IPv4 CGNAT range", () => {
    expect(isTailscaleHost("100.64.0.1")).toBe(true);
    expect(isTailscaleHost("100.100.50.25")).toBe(true);
    expect(isTailscaleHost("100.127.255.254")).toBe(true);
  });

  it("rejects non-Tailscale IPv4 addresses", () => {
    expect(isTailscaleHost("127.0.0.1")).toBe(false);
    expect(isTailscaleHost("192.168.1.1")).toBe(false);
    expect(isTailscaleHost("10.0.0.1")).toBe(false);
    expect(isTailscaleHost("100.63.255.255")).toBe(false);
    expect(isTailscaleHost("100.128.0.0")).toBe(false);
  });

  it("rejects IPv6 addresses (only checks first : segment)", () => {
    // isTailscaleHost splits on ':' so IPv6 host:port strings like
    // '[fd7a:115c:a1e0::1]:31415' would have the '[' bracket as ip.
    // Pure IPv6 without brackets/port is not the expected input.
    expect(isTailscaleHost("::1")).toBe(false);
    expect(isTailscaleHost("fe80::1")).toBe(false);
  });
});

// ── normalizeCommandArgs ────────────────────────────────────────────
describe("normalizeCommandArgs", () => {
  it("returns empty for undefined", () => {
    expect(normalizeCommandArgs(undefined)).toEqual([]);
  });

  it("returns empty for empty string", () => {
    expect(normalizeCommandArgs("")).toEqual([]);
  });

  it("returns empty for whitespace string", () => {
    expect(normalizeCommandArgs("   ")).toEqual([]);
  });

  it("splits a string into words", () => {
    expect(normalizeCommandArgs("hello world")).toEqual(["hello", "world"]);
  });

  it("handles array input", () => {
    expect(normalizeCommandArgs(["a", "b"])).toEqual(["a", "b"]);
  });

  it("converts numbers to strings", () => {
    expect(normalizeCommandArgs([1, 2])).toEqual(["1", "2"]);
  });

  it("set-token destructure: [, token] from [subcommand, token]", () => {
    const [, token] = normalizeCommandArgs("set-token my-secret");
    expect(token).toBe("my-secret");
  });

  it("set-token destructure: token with special chars", () => {
    const [, token] = normalizeCommandArgs("set-token sec=ret&val");
    expect(token).toBe("sec=ret&val");
  });
});

// ── npm cleanup ────────────────────────────────────────────────────
describe("cleanupPiWebNpmTemps", () => {
  it("removes stale pi-web npm temp dirs only", () => {
    const root = `${process.cwd()}/.tmp-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const scope = `${root}/npm/node_modules/@yinniora`;
    const stale = `${scope}/.yugo-pi-F7YwHA7A`;
    const keep = `${scope}/yugo-pi`;
    mkdirSync(`${stale}/nested`, { recursive: true });
    mkdirSync(keep, { recursive: true });
    writeFileSync(`${stale}/nested/file`, "x");

    try {
      expect(cleanupPiWebNpmTemps(root)).toBe(1);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(keep)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Token management ──────────────────────────────────────────────
describe("token helpers", () => {
  // A developer who runs pi-web usually exports PI_WEB_TOKEN, and the helper
  // reads process.env before the env file. Without clearing it the suite picks
  // up the real token instead of the mocked one.
  const originalToken = process.env.PI_WEB_TOKEN;
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PI_WEB_TOKEN;
    delete (globalThis as any).__MOCK_PI_WEB_TOKEN__;
    delete (globalThis as any).__MOCK_PI_WEB_ENV_CONTENT__;
  });
  afterEach(() => {
    if (originalToken === undefined) delete process.env.PI_WEB_TOKEN;
    else process.env.PI_WEB_TOKEN = originalToken;
  });

  it("keeps token management out of RPC notifications", async () => {
    (globalThis as any).__MOCK_PI_WEB_TOKEN__ = "login-token-fixture";
    vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/pi-web-extension-fixture");
    try {
      const registerCommand = vi.fn();
      const notify = vi.fn();
      setupPiWeb({ registerCommand, exec: async () => ({ stdout: "" }) } as any);
      const [, command] = registerCommand.mock.calls.find(([name]) => name === "pi-web")!;
      const context = { mode: "rpc", ui: { notify } };
      await command.handler("token", context);
      await command.handler("set-token fixture-replacement", context);
      expect(notify).toHaveBeenCalledTimes(2);
      expect(notify).toHaveBeenCalledWith("Manage the login token in the local Pi terminal.", "warning");
      expect(readPiWebToken()).toBe("login-token-fixture");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reports connection URLs without the login token", async () => {
    (globalThis as any).__MOCK_PI_WEB_TOKEN__ = "login-token-fixture";
    vi.stubEnv("PI_CODING_AGENT_DIR", "/nonexistent/pi-web-extension-fixture");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null)));
    try {
      const registerCommand = vi.fn();
      const notify = vi.fn();
      const exec = vi.fn(async (_cmd, args) => ({
        stdout: args?.includes("--json")
          ? JSON.stringify({ BackendState: "Running", Self: { DNSName: "host.tailnet.test" } })
          : "",
      }));
      setupPiWeb({ registerCommand, exec } as any);
      const [, command] = registerCommand.mock.calls.find(([name]) => name === "pi-web")!;
      await command.handler("status", { mode: "rpc", ui: { notify } });
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("https://host.tailnet.test:31415"), "info");
      expect(notify.mock.calls[0][0]).not.toContain("login-token-fixture");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("readPiWebToken reads token from env file", () => {
    (globalThis as any).__MOCK_PI_WEB_TOKEN__ = "secret-123";

    expect(readPiWebToken()).toBe("secret-123");
  });

  it("readPiWebToken returns null when file does not exist", () => {
    (globalThis as any).__MOCK_PI_WEB_TOKEN__ = undefined;

    expect(readPiWebToken()).toBeNull();
  });

  it("readPiWebToken prefers process.env over env file", () => {
    process.env["PI_WEB_TOKEN"] = "from-env";
    (globalThis as any).__MOCK_PI_WEB_TOKEN__ = "from-file";

    expect(readPiWebToken()).toBe("from-env");

    delete process.env["PI_WEB_TOKEN"];
  });

  it("readPiWebToken returns token from env var even when no file exists", () => {
    process.env["PI_WEB_TOKEN"] = "env-only";
    (globalThis as any).__MOCK_PI_WEB_TOKEN__ = undefined;

    expect(readPiWebToken()).toBe("env-only");

    delete process.env["PI_WEB_TOKEN"];
  });

  it("writePiWebToken creates a private env file and directory", () => {
    const path = `${homedir()}/.config/pi-web/env`;

    writePiWebToken("secret-123");

    expect(mkdirSync).toHaveBeenCalledWith(dirname(path), { recursive: true });
    expect(chmodSync).toHaveBeenCalledWith(dirname(path), 0o700);
    expect(writeFileSync).toHaveBeenCalledWith(
      path,
      "PI_WEB_TOKEN=secret-123\n",
      {
        mode: 0o600,
      },
    );
    expect(chmodSync).toHaveBeenCalledWith(path, 0o600);
  });
});
