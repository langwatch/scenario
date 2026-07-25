/**
 * Browser tab reuse, exercised against a real HTTP server.
 *
 * Covers specs/browser-tab-reuse.feature. The LangWatch side is a real
 * `node:http` server answering the browser-tab handoff endpoint, and the state
 * files are real files in a temp directory, so requests, headers, timeouts and
 * on-disk formats are the genuine article. The only injected seam is the
 * opener: tests need to know which URL would have been opened without spawning
 * twenty browsers on the machine running them.
 */

import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveBrowserPolicy,
  scenarioTabKey,
  showBatchRun,
  type BatchRunLocation,
} from "../tab-handoff";

const BROWSER_ENV_VARS = [
  "SCENARIO_BROWSER",
  "SCENARIO_BROWSER_REOPEN_SECONDS",
  "SCENARIO_HEADLESS",
  "CI",
  "LANGWATCH_STATE_DIR",
] as const;

interface RecordedRequest {
  path: string;
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

/** A real HTTP server standing in for a LangWatch instance. */
class FakeLangWatch {
  private constructor(
    private readonly server: http.Server,
    readonly endpoint: string,
    readonly requests: RecordedRequest[]
  ) {}

  static async start(options: {
    delivered?: boolean;
    status?: number;
    delayMs?: number;
  }): Promise<FakeLangWatch> {
    const { delivered = false, status = 200, delayMs = 0 } = options;
    const requests: RecordedRequest[] = [];

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8") || "{}";
        requests.push({
          path: req.url ?? "",
          body: JSON.parse(raw) as Record<string, unknown>,
          headers: req.headers,
        });

        const respond = () => {
          if (status !== 200) {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "nope" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ delivered, url: "http://example.test/batch" })
          );
        };

        if (delayMs) setTimeout(respond, delayMs);
        else respond();
      });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );

    const address = server.address();
    if (typeof address === "string" || address === null) {
      throw new Error("expected a TCP address");
    }

    return new FakeLangWatch(
      server,
      `http://127.0.0.1:${address.port}`,
      requests
    );
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function makeLocation(scenarioSetId = "checkout-flow"): BatchRunLocation {
  return {
    batchUrl:
      "https://app.langwatch.test/proj/simulations/checkout-flow/batch-1",
    batchRunId: "batch-1",
    scenarioSetId,
  };
}

describe("browser tab handoff", () => {
  let stateDir: string;
  let opened: string[];
  const savedEnv = new Map<string, string | undefined>();

  const opener = (url: string) => {
    opened.push(url);
  };

  beforeEach(() => {
    for (const name of BROWSER_ENV_VARS) {
      savedEnv.set(name, process.env[name]);
      delete process.env[name];
    }

    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "scenario-tab-"));
    process.env.LANGWATCH_STATE_DIR = stateDir;
    opened = [];
  });

  afterEach(() => {
    for (const [name, value] of savedEnv) {
      if (value === void 0) delete process.env[name];
      else process.env[name] = value;
    }
    savedEnv.clear();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const show = async (
    server: FakeLangWatch | null,
    overrides: Parameters<typeof showBatchRun>[1] & {
      location?: BatchRunLocation;
    } = {}
  ) => {
    const { location = makeLocation(), ...options } = overrides;
    return showBatchRun(location, {
      endpoint: server?.endpoint,
      apiKey: "sk-lw-test",
      opener,
      ...options,
    });
  };

  // -------------------------------------------------------------------------
  // The happy path: one tab, forever
  // -------------------------------------------------------------------------

  it("stamps the machine key on the tab it opens first time round", async () => {
    const server = await FakeLangWatch.start({ delivered: false });
    try {
      expect(await show(server)).toBe("opened");
    } finally {
      await server.close();
    }

    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain(`scenarioTab=${scenarioTabKey()}`);
    expect(opened[0]).toContain(
      "https://app.langwatch.test/proj/simulations/checkout-flow/batch-1"
    );
  });

  it("sends the batch and set ids with the api key", async () => {
    const server = await FakeLangWatch.start({ delivered: false });
    try {
      await show(server);
    } finally {
      await server.close();
    }

    expect(server.requests[0]?.path).toBe("/api/scenario-events/browser-tab");
    expect(server.requests[0]?.body).toEqual({
      tabKey: scenarioTabKey(),
      batchRunId: "batch-1",
      scenarioSetId: "checkout-flow",
    });
    expect(server.requests[0]?.headers.authorization).toBe("Bearer sk-lw-test");
  });

  it("opens nothing when a listening tab takes the run", async () => {
    const server = await FakeLangWatch.start({ delivered: true });
    try {
      expect(await show(server)).toBe("handed_off");
    } finally {
      await server.close();
    }

    expect(opened).toEqual([]);
  });

  it("keeps handing repeat runs to the same tab", async () => {
    const server = await FakeLangWatch.start({ delivered: true });
    try {
      for (let i = 0; i < 5; i++) {
        expect(await show(server)).toBe("handed_off");
      }
    } finally {
      await server.close();
    }

    expect(opened).toEqual([]);
    expect(server.requests).toHaveLength(5);
  });

  it("opens again once the tab is gone", async () => {
    const listening = await FakeLangWatch.start({ delivered: true });
    try {
      expect(await show(listening)).toBe("handed_off");
    } finally {
      await listening.close();
    }

    const gone = await FakeLangWatch.start({ delivered: false });
    try {
      expect(await show(gone)).toBe("opened");
    } finally {
      await gone.close();
    }

    expect(opened).toHaveLength(1);
  });

  it("lets an authoritative no-tab answer override the throttle", async () => {
    const server = await FakeLangWatch.start({ delivered: false });
    try {
      expect(await show(server)).toBe("opened");
      expect(await show(server)).toBe("opened");
    } finally {
      await server.close();
    }

    expect(opened).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Machine scoping
  // -------------------------------------------------------------------------

  it("keeps the tab key stable across calls", () => {
    expect(scenarioTabKey()).toBe(scenarioTabKey());
  });

  it("stores the tab key where the Python SDK reads it", () => {
    const key = scenarioTabKey();
    const keyFile = path.join(stateDir, "scenario-tab-key");

    expect(fs.readFileSync(keyFile, "utf-8").trim()).toBe(key);
  });

  it("reuses a key an earlier process already wrote", () => {
    fs.writeFileSync(
      path.join(stateDir, "scenario-tab-key"),
      "written-by-python"
    );

    expect(scenarioTabKey()).toBe("written-by-python");
  });

  it("only disables reuse when the state directory is unusable", async () => {
    process.env.LANGWATCH_STATE_DIR = "/proc/nonexistent/cannot-write";

    const server = await FakeLangWatch.start({ delivered: true });
    try {
      expect(await show(server)).toBe("opened");
    } finally {
      await server.close();
    }

    expect(server.requests).toEqual([]);
    expect(opened).toEqual([makeLocation().batchUrl]);
  });

  // -------------------------------------------------------------------------
  // Degrading gracefully
  // -------------------------------------------------------------------------

  it("still opens a tab against a LangWatch without the endpoint", async () => {
    const server = await FakeLangWatch.start({ status: 404 });
    try {
      expect(await show(server)).toBe("opened");
    } finally {
      await server.close();
    }

    expect(opened).toHaveLength(1);
  });

  it("stops spamming tabs when LangWatch cannot answer", async () => {
    const server = await FakeLangWatch.start({ status: 404 });
    try {
      expect(await show(server)).toBe("opened");
      expect(await show(server)).toBe("suppressed_by_throttle");
      expect(await show(server)).toBe("suppressed_by_throttle");
    } finally {
      await server.close();
    }

    expect(opened).toHaveLength(1);
  });

  it("throttles per scenario set, not globally", async () => {
    const server = await FakeLangWatch.start({ status: 404 });
    try {
      await show(server, { location: makeLocation("checkout-flow") });
      expect(await show(server, { location: makeLocation("onboarding") })).toBe(
        "opened"
      );
    } finally {
      await server.close();
    }

    expect(opened).toHaveLength(2);
  });

  it("honours a configured throttle window", async () => {
    process.env.SCENARIO_BROWSER_REOPEN_SECONDS = "0";

    const server = await FakeLangWatch.start({ status: 404 });
    try {
      expect(await show(server)).toBe("opened");
      expect(await show(server)).toBe("opened");
    } finally {
      await server.close();
    }
  });

  it("never stalls a run on a hanging LangWatch", async () => {
    const server = await FakeLangWatch.start({ delivered: true, delayMs: 5000 });
    const started = Date.now();
    try {
      expect(await show(server)).toBe("opened");
    } finally {
      await server.close();
    }

    expect(Date.now() - started).toBeLessThan(4500);
  });

  it("falls back to opening when LangWatch is unreachable", async () => {
    expect(
      await showBatchRun(makeLocation(), {
        endpoint: "http://127.0.0.1:1",
        apiKey: "sk-lw-test",
        opener,
      })
    ).toBe("opened");

    expect(opened).toHaveLength(1);
  });

  it("skips the handoff without credentials", async () => {
    const server = await FakeLangWatch.start({ delivered: true });
    try {
      expect(await show(server, { apiKey: void 0 })).toBe("opened");
    } finally {
      await server.close();
    }

    expect(server.requests).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Policy
  // -------------------------------------------------------------------------

  it.each([
    ["auto", "auto"],
    ["never", "never"],
    ["always", "always"],
    ["ALWAYS", "always"],
    ["nonsense", "auto"],
  ])("resolves SCENARIO_BROWSER=%s to %s", (value, expected) => {
    process.env.SCENARIO_BROWSER = value;
    expect(resolveBrowserPolicy()).toBe(expected);
  });

  it("suppresses the browser when the project config is headless", () => {
    expect(resolveBrowserPolicy(true)).toBe("never");
  });

  it("suppresses the browser on CI", () => {
    process.env.CI = "true";
    expect(resolveBrowserPolicy()).toBe("never");
  });

  it("treats CI=false as not CI", () => {
    process.env.CI = "false";
    expect(resolveBrowserPolicy()).toBe("auto");
  });

  it("lets an explicit policy beat headless", () => {
    process.env.SCENARIO_BROWSER = "always";
    expect(resolveBrowserPolicy(true)).toBe("always");
  });

  it("opens nothing and asks nothing under never", async () => {
    process.env.SCENARIO_BROWSER = "never";

    const server = await FakeLangWatch.start({ delivered: false });
    try {
      expect(await show(server)).toBe("suppressed_by_policy");
    } finally {
      await server.close();
    }

    expect(opened).toEqual([]);
    expect(server.requests).toEqual([]);
  });

  it("opens every time under always, without consulting the server", async () => {
    process.env.SCENARIO_BROWSER = "always";

    const server = await FakeLangWatch.start({ delivered: true });
    try {
      expect(await show(server)).toBe("opened");
      expect(await show(server)).toBe("opened");
    } finally {
      await server.close();
    }

    expect(server.requests).toEqual([]);
    expect(opened).toHaveLength(2);
  });

  it("suppresses the browser for a headless project config", async () => {
    const server = await FakeLangWatch.start({ delivered: false });
    try {
      expect(await show(server, { headless: true })).toBe(
        "suppressed_by_policy"
      );
    } finally {
      await server.close();
    }

    expect(opened).toEqual([]);
  });
});
