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
// vi.hoisted() ensures these variables exist at the time vi.mock() is hoisted.
// ---------------------------------------------------------------------------

const { mockStdin, mockProc } = vi.hoisted(() => {
  const stdin = {
    write: vi.fn().mockReturnValue(true),
    end: vi.fn(),
  };

  let procEventHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};

  const proc: {
    stdin: typeof stdin;
    on: Mock;
    once: Mock;
    emit: (event: string, ...args: unknown[]) => boolean;
    _handlers: () => Record<string, ((...args: unknown[]) => void)[]>;
    _resetHandlers: () => void;
  } = {
    stdin,
    on: vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (!procEventHandlers[event]) {
        procEventHandlers[event] = [];
      }
      procEventHandlers[event]!.push(handler);
      return proc;
    }),
    once: vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      // Wrap the handler so it removes itself after the first invocation.
      const wrapped = (...args: unknown[]): void => {
        const handlers = procEventHandlers[event];
        if (handlers) {
          const idx = handlers.indexOf(wrapped);
          if (idx >= 0) handlers.splice(idx, 1);
        }
        handler(...args);
      };
      if (!procEventHandlers[event]) {
        procEventHandlers[event] = [];
      }
      procEventHandlers[event]!.push(wrapped);
      return proc;
    }),
    emit: (event: string, ...args: unknown[]): boolean => {
      const handlers = procEventHandlers[event] ?? [];
      handlers.forEach((h) => h(...args));
      return handlers.length > 0;
    },
    _handlers: () => procEventHandlers,
    _resetHandlers: () => {
      procEventHandlers = {};
    },
  };

  // Wire stdin.end to auto-emit 'exit' after call so close() resolves.
  stdin.end.mockImplementation(() => {
    Promise.resolve().then(() => {
      proc.emit("exit", 0);
    });
  });

  return { mockStdin: stdin, mockProc: proc };
});

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
  mockProc._resetHandlers();
  mockStdin.write.mockReturnValue(true);
  mockStdin.end.mockImplementation(() => {
    Promise.resolve().then(() => {
      mockProc.emit("exit", 0);
    });
  });
  mockProc.on.mockImplementation(
    (event: string, handler: (...args: unknown[]) => void) => {
      const handlers = mockProc._handlers();
      if (!handlers[event]) {
        handlers[event] = [];
      }
      handlers[event]!.push(handler);
      return mockProc;
    },
  );
  mockProc.once.mockImplementation(
    (event: string, handler: (...args: unknown[]) => void) => {
      const wrapped = (...args: unknown[]): void => {
        const handlers = mockProc._handlers()[event];
        if (handlers) {
          const idx = handlers.indexOf(wrapped);
          if (idx >= 0) handlers.splice(idx, 1);
        }
        handler(...args);
      };
      const handlers = mockProc._handlers();
      if (!handlers[event]) {
        handlers[event] = [];
      }
      handlers[event]!.push(wrapped);
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

  it("close() resolves promptly when subprocess already exited early (regression: close hang fix)", async () => {
    // Simulate the scenario where ffmpeg exits early (e.g. no audio device)
    // BEFORE close() is called. Without the fix, _proc is left non-null after
    // the exit handler fires, so close() registers proc.on("exit", resolve) on
    // an already-exited subprocess → resolve never fires → close() hangs.
    // With the fix: the exit handler sets _proc = null, so close() sees
    // !this._proc and returns Promise.resolve() immediately.
    const sink = new AudioPlaybackSink();
    sink.open();

    // Simulate early exit with non-zero code (e.g. no audio device).
    mockProc.emit("exit", 1);

    // _proc must be null after early non-zero exit (the fix).
    // close() must resolve without hanging, well within 100 ms.
    const start = Date.now();
    await sink.close();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
    expect(sink.active).toBe(false);
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
