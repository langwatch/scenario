/**
 * Gap #11 — uniform connected-state gate (issue #372 Tier C, Task 6).
 *
 * defaultVoiceCall raises PendingTransportError when isConnected() is false —
 * one clear error across every transport leaf instead of a transport-specific
 * null-deref or silent hang. Verified with a custom VoiceAgentAdapter subclass
 * AND a real leaf (OpenAIRealtime) before connect(). Offline — no network.
 */

import { describe, it, expect } from "vitest";

import {
  AgentRole,
  type AgentInput,
} from "../../domain";
import { AudioChunk } from "../audio-chunk";
import { AdapterCapabilities } from "../capabilities";
import { VoiceAgentAdapter } from "../adapter";
import { defaultVoiceCall } from "../adapter.runtime";
import { PendingTransportError } from "../adapters/pending-transport-error";
import { OpenAIRealtimeAgentAdapter } from "../adapters/openai-realtime";

/** Adapter that flips isConnected() on connect()/disconnect(). */
class GatedAdapter extends VoiceAgentAdapter {
  override role = AgentRole.AGENT;
  readonly capabilities = new AdapterCapabilities({
    inputFormats: ["pcm16/24000"],
    outputFormats: ["pcm16/24000"],
  });
  private connected = false;
  override isConnected(): boolean {
    return this.connected;
  }
  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  async sendAudio(_c: AudioChunk): Promise<void> {}
  async receiveAudio(_t: number): Promise<AudioChunk> {
    return new AudioChunk({ data: new Uint8Array(2) });
  }
}

const input = {
  threadId: "cs",
  messages: [],
  newMessages: [],
  requestedRole: AgentRole.AGENT,
  scenarioState: {} as AgentInput["scenarioState"],
  scenarioConfig: { name: "t", description: "d" } as AgentInput["scenarioConfig"],
} as AgentInput;

describe("connected-state gate (Gap #11)", () => {
  it("defaultVoiceCall throws PendingTransportError before connect()", async () => {
    const adapter = new GatedAdapter();
    await expect(defaultVoiceCall(adapter, input)).rejects.toBeInstanceOf(
      PendingTransportError,
    );
  });

  it("defaultVoiceCall succeeds after connect()", async () => {
    const adapter = new GatedAdapter();
    await adapter.connect();
    const result = await defaultVoiceCall(adapter, input);
    expect((result as { role?: string }).role).toBe("assistant");
  });

  it("a real transport leaf (OpenAIRealtime) raises PendingTransportError via call() before connect", async () => {
    const adapter = new OpenAIRealtimeAgentAdapter({
      model: "gpt-realtime-mini",
      apiKey: "sk-test",
    });
    expect(adapter.isConnected()).toBe(false);
    await expect(adapter.call(input)).rejects.toBeInstanceOf(
      PendingTransportError,
    );
  });

  it("base VoiceAgentAdapter.isConnected() defaults to true (in-process adapters)", () => {
    const adapter = new GatedAdapter();
    // GatedAdapter overrides to false; a base adapter with no override would
    // return true — assert the default contract via a bare subclass.
    class BareAdapter extends VoiceAgentAdapter {
      readonly capabilities = new AdapterCapabilities();
      async connect(): Promise<void> {}
      async disconnect(): Promise<void> {}
      async sendAudio(): Promise<void> {}
      async receiveAudio(): Promise<AudioChunk> {
        return new AudioChunk({ data: new Uint8Array(0) });
      }
    }
    expect(new BareAdapter().isConnected()).toBe(true);
    expect(adapter.isConnected()).toBe(false);
  });
});
