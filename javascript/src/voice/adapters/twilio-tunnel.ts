/**
 * TwilioTunnel — wraps a local server with a publicly-reachable tunnel so
 * Twilio's webhooks can reach a dev machine.
 *
 * Two providers, picked at runtime:
 * - `@ngrok/ngrok` (preferred when `NGROK_AUTHTOKEN` is set) — stable URLs,
 *   per-account quota, native binary ~20 MB.
 * - `localtunnel` (fallback) — no auth required, less reliable, public
 *   subdomain.
 *
 * Both packages are **optional peer dependencies**. The tunnel is only used
 * by the env-gated e2e test; runtime callers who don't need a tunnel never
 * pull these into the bundle. We dynamic-import inside `open()` so the
 * module is importable on machines that don't have them installed.
 */

export type TunnelProvider = "ngrok" | "localtunnel";

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
  return openLocaltunnelTunnel(opts.port);
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
