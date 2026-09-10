/**
 * Unit coverage for `TwilioRESTHelper.placeCall`'s `record` option: when
 * `record: true`, the REST body sent to `Calls.json` carries `Record=true`;
 * omitted/false leaves it off the wire entirely (byte-identical to before).
 */

import { describe, expect, it } from "vitest";

import { TwilioRESTHelper } from "../twilio-shared";

/** Fake `fetch` that records the last request body and returns a fixed sid. */
function fakeFetch(): {
  fetchImpl: typeof fetch;
  lastBody: () => URLSearchParams;
} {
  let last = "";
  const fetchImpl = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    last = typeof init?.body === "string" ? init.body : "";
    return new Response(JSON.stringify({ sid: "CAtest" }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, lastBody: () => new URLSearchParams(last) };
}

describe("TwilioRESTHelper.placeCall record option", () => {
  it("sends Record=true when record: true", async () => {
    const { fetchImpl, lastBody } = fakeFetch();
    const rest = new TwilioRESTHelper("ACtest", "secret", fetchImpl);
    await rest.placeCall({
      to: "+14155557777",
      from: "+14155551234",
      twiml: "<Response/>",
      record: true,
    });
    expect(lastBody().get("Record")).toBe("true");
  });

  it("omits Record entirely when record is false or unset", async () => {
    const { fetchImpl, lastBody } = fakeFetch();
    const rest = new TwilioRESTHelper("ACtest", "secret", fetchImpl);
    await rest.placeCall({
      to: "+14155557777",
      from: "+14155551234",
      twiml: "<Response/>",
    });
    expect(lastBody().has("Record")).toBe(false);
  });
});
