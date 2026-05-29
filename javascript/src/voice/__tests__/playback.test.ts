/**
 * Unit tests for AudioPlaybackSink (#585).
 *
 * The subprocess is mocked via vi.mock so these tests run offline and on
 * headless CI without any audio device. Two suites:
 *
 * 1. AudioPlaybackSink — subprocess-level: assert chunks get written to stdin
 *    and that the sink degrades gracefully when the subprocess errors.
 *
 * 2. Executor wiring — when audioPlayback: true, sink is constructed + fed;
 *    when audioPlayback: false, sink is NOT constructed.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// Mock child_process.spawn so no real subprocess is spawned.
// ---------------------------------------------------------------------------

import type { ChildProcessWithoutNullStreams } from "node:child_process";

const mockStdin = {
  write: vi.fn().mockReturnValue(true),
  // Auto-emit 'exit' on the proc when stdin.end() is called so close()
  // resolves without hanging in unit tests.
  end: vi.fn().mockImplementation(() => {
    Promise.resolve().then(() => {
      mockProc.emit("exit", 0);
    });
  }),
};

let mockProcEventHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};

const mockProc: Partial<ChildProcessWithoutNullStreams> & {
  stdin: typeof mockStdin;
  on: Mock;
  emit: (event: string, ...args: unknown[]) => boolean;
} = {
  stdin: mockStdin,
  on: vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
    if (!mockProcEventHandlers[event]) {
      mockProcEventHandlers[event] = [];
    }
    mockProcEventHandlers[event].push(handler);
    return mockProc;
  }),
  emit: (event: string, ...args: unknown[]): boolean => {
    const handlers = mockProcEventHandlers[event] ?? [];
    handlers.forEach((h) => h(...args));
    return handlers.length > 0;
  },
};

vi.mock("node:child_process", () => ({
  spawn: vi.fn().mockReturnValue(mockProc),
}));

// ---------------------------------------------------------------------------
// Imports after mock declaration (vitest hoists vi.mock to module-scope).
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { AudioPlaybackSink } from "../playback";
import { AudioChunk } from "../audio-chunk";

// Minimal real PCM16 chunk: 4 bytes = two int16 samples = valid PCM16.
function makeChunk(): AudioChunk {
  return new AudioChunk({ data: new Uint8Array([0, 0, 0, 0]) });
}

// ---------------------------------------------------------------------------
// Suite 1: AudioPlaybackSink behaviour
// ---------------------------------------------------------------------------

function restoreMockProcHandlers() {
  mockProcEventHandlers = {};
  mockStdin.write.mockReturnValue(true);
  mockStdin.end.mockImplementation(() => {
    Promise.resolve().then(() => {
      mockProc.emit("exit", 0);
    });
  });
  mockProc.on.mockImplementation(
    (event: string, handler: (...args: unknown[]) => void) => {
      if (!mockProcEventHandlers[event]) {
        mockProcEventHandlers[event] = [];
      }
      mockProcEventHandlers[event]!.push(handler);
      return mockProc;
    },
  );
}

describe("AudioPlaybackSink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreMockProcHandlers();
    (spawn as Mock).mockReturnValue(mockProc);
  });

  it("open() spawns an ffmpeg subprocess", () => {
    const sink = new AudioPlaybackSink();
    sink.open();
    expect(spawn).toHaveBeenCalledOnce();
    const [cmd] = (spawn as Mock).mock.calls[0]!;
    expect(typeof cmd).toBe("string"); // the ffmpeg binary path
  });

  it("sendChunk() writes PCM bytes to subprocess stdin after open()", () => {
    const sink = new AudioPlaybackSink();
    sink.open();

    const chunk = makeChunk();
    sink.sendChunk(chunk);

    expect(mockStdin.write).toHaveBeenCalledOnce();
    const written = (mockStdin.write as Mock).mock.calls[0]![0] as Buffer;
    expect(written).toBeInstanceOf(Buffer);
    expect(written.length).toBe(4);
  });

  it("sendChunk() is a no-op before open() is called", () => {
    const sink = new AudioPlaybackSink();
    sink.sendChunk(makeChunk()); // no open()
    expect(mockStdin.write).not.toHaveBeenCalled();
  });

  it("is active after a successful open()", () => {
    const sink = new AudioPlaybackSink();
    sink.open();
    expect(sink.active).toBe(true);
  });

  it("becomes inactive and no-ops sendChunk when the subprocess emits error", () => {
    const sink = new AudioPlaybackSink();
    sink.open();

    // Simulate the subprocess failing to open the audio device.
    mockProc.emit("error", new Error("ENOENT: no such device"));

    expect(sink.active).toBe(false);
    sink.sendChunk(makeChunk());
    expect(mockStdin.write).not.toHaveBeenCalled();
  });

  it("becomes inactive when the subprocess exits with non-zero code", () => {
    const sink = new AudioPlaybackSink();
    sink.open();

    mockProc.emit("exit", 1);

    expect(sink.active).toBe(false);
  });

  it("close() ends stdin and resolves when exit fires", async () => {
    const sink = new AudioPlaybackSink();
    sink.open();

    const closePromise = sink.close();
    // Simulate the subprocess exiting after stdin is closed.
    mockProc.emit("exit", 0);
    await closePromise;

    expect(mockStdin.end).toHaveBeenCalledOnce();
    expect(sink.active).toBe(false);
  });

  it("close() resolves immediately when sink was never opened", async () => {
    const sink = new AudioPlaybackSink();
    // Not open — close should resolve without hanging.
    await expect(sink.close()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 2: executor wiring (via ScenarioExecution)
// ---------------------------------------------------------------------------

import {
  AgentRole,
  type AgentInput,
  type AgentReturnTypes,
  JudgeAgentAdapter,
  UserSimulatorAgentAdapter,
} from "../../domain";
import { ScenarioExecution } from "../../execution/scenario-execution";
import { VoiceAgentAdapter } from "../adapter";
import { AdapterCapabilities } from "../capabilities";
import { configure } from "../../config/configure";

// Minimal fake adapters for the executor wiring tests.
class FakeVoiceAgent extends VoiceAgentAdapter {
  override role = AgentRole.AGENT;
  readonly capabilities = new AdapterCapabilities({
    interruption: false,
    inputFormats: ["pcm16/24000"],
    outputFormats: ["pcm16/24000"],
  });
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async sendAudio(): Promise<void> {}
  async receiveAudio(): Promise<AudioChunk> {
    return new AudioChunk({ data: new Uint8Array(0) });
  }
}

class FakeUserSim extends UserSimulatorAgentAdapter {
  role = AgentRole.USER;
  async call(_i: AgentInput): Promise<AgentReturnTypes> {
    return "user turn";
  }
}

class ImmediateJudge extends JudgeAgentAdapter {
  criteria = ["ok"];
  async call(input: AgentInput) {
    if (!input.judgmentRequest) return null;
    return { success: true, reasoning: "done", metCriteria: ["ok"], unmetCriteria: [] };
  }
}

describe("executor wiring: audioPlayback flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreMockProcHandlers();
    (spawn as Mock).mockReturnValue(mockProc);
    // Reset global settings between tests.
    configure({ audioPlayback: false });
  });

  it("constructs the AudioPlaybackSink when audioPlayback: true is in voice config", async () => {
    const exec = new ScenarioExecution(
      {
        name: "audioPlayback wiring / enabled",
        description: "sink must be constructed when audioPlayback: true",
        agents: [new FakeVoiceAgent(), new FakeUserSim(), new ImmediateJudge()],
        voice: { audioPlayback: true },
      },
      [
        async (_state, executor) => {
          await executor.succeed("done");
        },
      ],
      "test-batch-id",
    );

    await exec.execute();

    // spawn() was called once — the playback subprocess was opened.
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("does NOT construct the AudioPlaybackSink when audioPlayback is absent", async () => {
    const exec = new ScenarioExecution(
      {
        name: "audioPlayback wiring / disabled",
        description: "sink must NOT be constructed when audioPlayback is absent/false",
        agents: [new FakeVoiceAgent(), new FakeUserSim(), new ImmediateJudge()],
        // No voice config at all → audioPlayback defaults to false.
      },
      [
        async (_state, executor) => {
          await executor.succeed("done");
        },
      ],
      "test-batch-id",
    );

    await exec.execute();

    expect(spawn).not.toHaveBeenCalled();
  });
});
