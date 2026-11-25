/**
 * TwilioTunnel — wraps a local server with a publicly-reachable tunnel so
 * Twilio's webhooks can reach a dev machine.
 *
 * Three providers, picked at runtime:
 * - `@ngrok/ngrok` (preferred when `NGROK_AUTHTOKEN` is set) — stable URLs,
 *   per-account quota, native binary ~20 MB.
 * - `localtunnel` (default fallback) — no auth required, less reliable, public
 *   subdomain.
 * - `cloudflared` (explicit opt-in) — no npm dep and no account: shells out to
 *   the `cloudflared` binary for a `*.trycloudflare.com` quick tunnel. This is
 *   the direct twin of Python's `scenario.voice.testing.CloudflareTunnel`, so
 *   the JS a-leg live e2e (#762 AC11) can open the same kind of tunnel the
 *   Python one does. Only selected when `provider: "cloudflared"` is passed,
 *   so it never changes the default ngrok/localtunnel selection.
 *
 * The two npm packages are **optional peer dependencies**. The tunnel is only
 * used by the env-gated e2e test; runtime callers who don't need a tunnel never
 * pull these into the bundle. We dynamic-import inside `open()` so the
 * module is importable on machines that don't have them installed.
 */

import { spawn } from "node:child_process";

export type TunnelProvider = "ngrok" | "localtunnel" | "cloudflared";

export interface OpenedTunnel {
  /** Public HTTPS URL that proxies to the local port. */
  url: string;
  provider: TunnelProvider;
  close(): Promise<void>;
}

export interface OpenTunnelOptions {
  /** Local port to expose. */
  port: number;
  /**
   * Force a specific provider. Defaults to `ngrok` when `NGROK_AUTHTOKEN` is
   * set, otherwise `localtunnel`.
   */
  provider?: TunnelProvider;
  /** ngrok authtoken; defaults to `process.env.NGROK_AUTHTOKEN`. */
  authToken?: string;
  /** Region passed through to ngrok (e.g. "us", "eu"). */
  region?: string;
}

/**
 * Open a tunnel. Throws with a helpful message if neither package is
 * installed and the caller hasn't supplied an external URL elsewhere.
 */
export async function openTwilioTunnel(opts: OpenTunnelOptions): Promise<OpenedTunnel> {
  const authToken = opts.authToken ?? process.env.NGROK_AUTHTOKEN ?? "";
  const provider: TunnelProvider =
    opts.provider ?? (authToken ? "ngrok" : "localtunnel");

  if (provider === "ngrok") {
    return openNgrokTunnel(opts.port, authToken, opts.region);
  }
  if (provider === "cloudflared") {
    return openCloudflaredTunnel(opts.port);
  }
  return openLocaltunnelTunnel(opts.port);
}

/** How long to wait for cloudflared to announce its quick-tunnel hostname. */
const CLOUDFLARED_STARTUP_TIMEOUT_MS = 30_000;
/** The trycloudflare hostname cloudflared prints on stdout/stderr at startup. */
const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/**
 * Spawn a `cloudflared` quick tunnel and resolve once it announces its public
 * `*.trycloudflare.com` URL. Twin of Python's `CloudflareTunnel.__aenter__`:
 * read the child's merged stdout/stderr for the hostname, fail fast if the
 * binary is missing or exits before printing one.
 *
 * The announced URL is reachable only after Cloudflare's edge has propagated
 * it, so a-leg callers must still gate origination on a readiness probe
 * (`TwilioAgentAdapterOptions.tunnelReadiness`) — the same contract Python's
 * harness satisfies with `wait_until_edge_reachable()`.
 */
async function openCloudflaredTunnel(port: number): Promise<OpenedTunnel> {
  const proc = spawn(
    "cloudflared",
    ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const url = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      cleanup();
      proc.kill("SIGTERM");
      reject(
        new Error(
          `TwilioTunnel: cloudflared did not announce a trycloudflare.com URL ` +
            `within ${CLOUDFLARED_STARTUP_TIMEOUT_MS / 1000}s. Check that ` +
            `cloudflared is installed and its output for errors.`,
        ),
      );
    }, CLOUDFLARED_STARTUP_TIMEOUT_MS);

    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf-8");
      const match = TRYCLOUDFLARE_RE.exec(buf);
      if (match) {
        cleanup();
        resolve(match[0]);
      }
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(
        new Error(
          `TwilioTunnel: failed to spawn cloudflared (${err.message}). Install ` +
            `it — Linux: https://developers.cloudflare.com/cloudflared/install/ ; ` +
            `macOS: brew install cloudflared.`,
        ),
      );
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(
        new Error(
          `TwilioTunnel: cloudflared exited (code ${code}) before announcing a URL.`,
        ),
      );
    };
    function cleanup(): void {
      clearTimeout(timer);
      proc.stdout?.off("data", onData);
      proc.stderr?.off("data", onData);
      proc.off("error", onError);
      proc.off("exit", onExit);
      // Keep draining the child's pipes for the tunnel's lifetime. cloudflared
      // logs continuously; a paused (undrained) pipe fills its ~64 KB buffer
      // within seconds and blocks the process, silently killing the tunnel —
      // the readiness probe then times out with "fetch failed" forever.
      proc.stdout?.resume();
      proc.stderr?.resume();
    }

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", onError);
    proc.on("exit", onExit);
  });

  return {
    url,
    provider: "cloudflared",
    async close() {
      proc.kill("SIGTERM");
    },
  };
}

interface NgrokListener {
  url(): string | null | undefined;
  close(): Promise<void>;
}
interface NgrokModule {
  forward(opts: { addr: number; authtoken?: string; region?: string }): Promise<NgrokListener>;
}
interface LocaltunnelTunnel {
  url: string;
  close(): void;
}
interface LocaltunnelModule {
  default(opts: { port: number }): Promise<LocaltunnelTunnel>;
}

async function openNgrokTunnel(
  port: number,
  authToken: string,
  region?: string,
): Promise<OpenedTunnel> {
  const ngrok = await loadOptional<NgrokModule>("@ngrok/ngrok");
  if (!ngrok) {
    throw new Error(
      "TwilioTunnel: @ngrok/ngrok is not installed. Install with " +
        "`pnpm add @ngrok/ngrok` or unset NGROK_AUTHTOKEN to fall back to localtunnel.",
    );
  }
  const listener = await ngrok.forward({
    addr: port,
    authtoken: authToken || undefined,
    region,
  });
  const url = listener.url();
  if (!url) {
    throw new Error("TwilioTunnel: ngrok forward returned no URL.");
  }
  return {
    url,
    provider: "ngrok",
    async close() {
      await listener.close();
    },
  };
}

async function openLocaltunnelTunnel(port: number): Promise<OpenedTunnel> {
  const lt = await loadOptional<LocaltunnelModule>("localtunnel");
  if (!lt) {
    throw new Error(
      "TwilioTunnel: localtunnel is not installed. Install with " +
        "`pnpm add localtunnel` or supply NGROK_AUTHTOKEN to use ngrok instead.",
    );
  }
  const tunnel = await lt.default({ port });
  return {
    url: tunnel.url,
    provider: "localtunnel",
    async close() {
      tunnel.close();
    },
  };
}

/**
 * Try to dynamic-import a module name. Returns the module on success, `null`
 * on resolution failure (the optional peer dep isn't installed). Bundlers
 * see this as a runtime dynamic import; consumers that don't take the tunnel
 * path never pull the dep.
 */
async function loadOptional<T>(name: string): Promise<T | null> {
  try {
    return (await import(/* @vite-ignore */ name)) as T;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return null;
    throw err;
  }
}
