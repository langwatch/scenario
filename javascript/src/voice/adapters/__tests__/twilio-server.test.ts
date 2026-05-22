/**
 * TwilioWebhookServer integration tests — binds the two @integration
 * @ts-bound scenarios tagged @ts-twilio-server in
 * `specs/voice-agents.feature`.
 *
 * Spins the real HTTP+WS server on an OS-assigned port so the TwiML
 * response shape and signature gate behavior are exercised end-to-end at
 * the transport level (no real Twilio account, no tunnel).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, expect } from "vitest";

import { TwilioAgentAdapter } from "../twilio";
import { TwilioRESTHelper } from "../twilio-shared";

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURE_PATH = resolve(HERE, "..", "..", "..", "..", "..", "specs", "voice-agents.feature");

const feature = await loadFeature(FEATURE_PATH);

const trackedAdapters: TwilioAgentAdapter[] = [];

function stubRest(sid: string): TwilioRESTHelper {
  const stub = new TwilioRESTHelper("ACtest", "secret");
  stub.resolvePhoneNumberSid = async () => sid;
  stub.readVoiceUrl = async () => null;
  stub.writeVoiceUrl = async () => undefined;
  stub.placeCall = async () => "CAtest";
  stub.sendDtmfOnCall = async () => undefined;
  return stub;
}

async function startAdapter(opts: {
  publicBaseUrl: string;
  validateSignature: boolean;
}): Promise<TwilioAgentAdapter> {
  const adapter = new TwilioAgentAdapter({
    accountSid: "ACtest",
    authToken: "secret",
    phoneNumber: "+14155551234",
    publicBaseUrl: opts.publicBaseUrl,
    validateSignature: opts.validateSignature,
    rest: stubRest("PNxxxx"),
  });
  await adapter.connect();
  trackedAdapters.push(adapter);
  return adapter;
}

afterAll(async () => {
  for (const adapter of trackedAdapters) {
    try {
      await adapter.disconnect();
    } catch {
      // Best-effort teardown.
    }
  }
});

describeFeature(
  feature,
  ({ Scenario }) => {
    Scenario(
      "TwiML voice endpoint serves Connect+Stream with an XML-escaped WSS URL",
      ({ Given, And, When, Then }) => {
        let adapter: TwilioAgentAdapter;
        let response: Response;
        let body: string;

        Given("the TwilioWebhookServer is bound on an OS-assigned port", async () => {
          // The publicBaseUrl is what shows up in the TwiML; the local server
          // binds 127.0.0.1:<ephemeral>. Use a URL that requires XML escaping
          // (ampersand in the query string) so the escape assertion is real.
          adapter = await startAdapter({
            publicBaseUrl: "https://example.test/voice?room=a&peer=b",
            validateSignature: false,
          });
        });

        And("the parent adapter has a publicBaseUrl configured", () => {
          expect(adapter.publicBaseUrl).toContain("https://example.test");
        });

        When("a Twilio webhook POSTs valid form data to /twilio/voice", async () => {
          const form = new URLSearchParams({
            From: "+14155557777",
            To: "+14155551234",
            CallSid: "CAabc",
          });
          response = await fetch(`${adapter.localBaseUrl}/twilio/voice`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: form.toString(),
          });
          body = await response.text();
        });

        Then("the response Content-Type is application/xml", () => {
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toContain("application/xml");
        });

        And('the body contains <Connect><Stream url="wss://..."/></Connect>', () => {
          expect(body).toContain("<Connect><Stream url=");
          expect(body).toContain("wss://example.test");
          expect(body).toContain("/twilio/stream");
          expect(body).toContain("</Connect>");
        });

        And(
          "the stream URL is XML-escaped (no unescaped &, <, >, or quotes)",
          () => {
            // The publicBaseUrl includes a literal `&peer=` — the response
            // must escape it as `&amp;peer=` inside the attribute value.
            expect(body).toContain("&amp;peer=b");
            expect(body).not.toMatch(/url="[^"]*&[^a]/); // bare `&` not allowed in attr
          },
        );
      },
    );

    Scenario(
      "TwiML voice endpoint rejects webhooks with a missing X-Twilio-Signature",
      ({ Given, When, Then, And }) => {
        let adapter: TwilioAgentAdapter;
        let response: Response;

        Given("a TwilioWebhookServer with validateSignature true", async () => {
          adapter = await startAdapter({
            publicBaseUrl: "https://example.test",
            validateSignature: true,
          });
          expect(adapter.rejectedCount).toBe(0);
        });

        When(
          "a POST to /twilio/voice arrives without an X-Twilio-Signature header",
          async () => {
            const form = new URLSearchParams({
              From: "+14155557777",
              CallSid: "CAabc",
            });
            response = await fetch(`${adapter.localBaseUrl}/twilio/voice`, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: form.toString(),
            });
            await response.text();
          },
        );

        Then("the response status is 403", () => {
          expect(response.status).toBe(403);
        });

        And(
          "the adapter records the rejection without opening a media stream",
          () => {
            expect(adapter.rejectedCount).toBe(1);
          },
        );
      },
    );
  },
  { includeTags: [["integration", "ts-twilio-server"]] },
);
