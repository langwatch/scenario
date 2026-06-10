/**
 * TwilioTunnel e2e — binds the @e2e @ts-bound @ts-twilio-tunnel scenario
 * in `specs/voice-agents.feature`.
 *
 * **Env-gated**: skipped when `NGROK_AUTHTOKEN` is not set. CI does not
 * provide a token, so the scenario is effectively bound at parse time but
 * its assertions only execute when a maintainer is exercising tunnels
 * locally.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, describe, expect, it } from "vitest";

import { TwilioAgentAdapter } from "../twilio";
import { TwilioRESTHelper } from "../twilio-shared";
import { openTwilioTunnel, type OpenedTunnel } from "../twilio-tunnel";

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURE_PATH = resolve(HERE, "..", "..", "..", "..", "..", "specs", "voice-agents.feature");

const feature = await loadFeature(FEATURE_PATH);

const TUNNEL_ENABLED = !!process.env.NGROK_AUTHTOKEN;

function stubRest(sid: string): TwilioRESTHelper {
  const stub = new TwilioRESTHelper("ACtest", "secret");
  stub.resolvePhoneNumberSid = async () => sid;
  stub.readVoiceUrl = async () => null;
  stub.writeVoiceUrl = async () => undefined;
  stub.placeCall = async () => "CAtest";
  stub.sendDtmfOnCall = async () => undefined;
  return stub;
}

let openedTunnel: OpenedTunnel | null = null;
let openedAdapter: TwilioAgentAdapter | null = null;

afterAll(async () => {
  if (openedTunnel) {
    try {
      await openedTunnel.close();
    } catch {
      // Best-effort.
    }
  }
  if (openedAdapter) {
    try {
      await openedAdapter.disconnect();
    } catch {
      // Best-effort.
    }
  }
});

if (TUNNEL_ENABLED) {
  describeFeature(
    feature,
    ({ Scenario }) => {
      Scenario(
        "Tunnel exposes the local Twilio server over a public URL",
        ({ Given, And, When, Then }) => {
          let adapter: TwilioAgentAdapter;
          let tunnel: OpenedTunnel;
          let probedBody: string;

          Given("NGROK_AUTHTOKEN is set in the environment (otherwise skip)", () => {
            expect(process.env.NGROK_AUTHTOKEN).toBeTruthy();
          });

          And("the local TwilioWebhookServer is running on an ephemeral port", async () => {
            adapter = new TwilioAgentAdapter({
              accountSid: "ACtest",
              authToken: "secret",
              phoneNumber: "+14155551234",
              publicBaseUrl: "https://placeholder.example",
              validateSignature: false,
              rest: stubRest("PNxxxx"),
            });
            await adapter.connect();
            openedAdapter = adapter;
          });

          When("a TwilioTunnel is opened against the bound port", async () => {
            const port = Number(new URL(adapter.localBaseUrl).port);
            tunnel = await openTwilioTunnel({ port });
            openedTunnel = tunnel;
            // Rebind the adapter's publicBaseUrl so the TwiML response points
            // to the live URL — a sanity check that the wiring is end-to-end.
            adapter.publicBaseUrl = tunnel.url;
          });

          Then("the tunnel reports an HTTPS URL", () => {
            expect(tunnel.url).toMatch(/^https:\/\//);
          });

          And("the URL proxies a GET request through to the local server", async () => {
            // The local server returns 404 for GET / — that's enough proof that
            // the proxy reaches it (vs. a tunnel-side 502/timeout).
            const probed = await fetch(tunnel.url + "/this-path-404s");
            probedBody = await probed.text();
            expect(probed.status).toBe(404);
            expect(probedBody).toContain("not found");
          });
        },
      );
    },
    { includeTags: [["e2e", "ts-twilio-tunnel"]] },
  );
} else {
  describe.skip("Twilio tunnel scenario (set NGROK_AUTHTOKEN to enable)", () => {
    it("env-gated — not exercised in CI", () => {
      // Placeholder so the runner reports a single skipped block instead of
      // five vacuous green steps. The cucumber binding above only registers
      // when NGROK_AUTHTOKEN is set.
    });
  });
}
