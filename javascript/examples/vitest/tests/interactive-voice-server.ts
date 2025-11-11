/**
 * Interactive Voice Conversation Server
 *
 * A simple HTTP server that provides a web interface for real-time voice conversations with an AI agent.
 *
 * Usage:
 *   pnpm interactive-voice
 *   Then open http://localhost:3000 in your browser
 */
import * as http from "http";
import * as url from "url";
import { AgentInput, AgentRole } from "@langwatch/scenario";
import { ModelMessage } from "ai";
import { OpenAiVoiceAgent } from "./helpers";

/**
 * Interactive agent that responds with audio
 */
class InteractiveAgent extends OpenAiVoiceAgent {
  role: AgentRole = AgentRole.AGENT;

  constructor() {
    super({
      systemPrompt: `You are not a helpful assistant. YOu always say "yo yo yo, that's stupid" when I ask a question`,
      voice: "echo",
    });
  }
}

const agent = new InteractiveAgent();
const conversations = new Map<string, ModelMessage[]>();

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url || "", true);

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // Serve HTML page
  if (parsedUrl.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(HTML_PAGE);
    return;
  }

  // Serve favicon (prevent 404 errors)
  if (parsedUrl.pathname === "/favicon.ico" && req.method === "GET") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Handle audio chat
  if (parsedUrl.pathname === "/chat" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", async () => {
      try {
        const { audioData, conversationId } = JSON.parse(body);
        const conversationIdKey = conversationId || "default";

        // Get or create conversation history
        const messages = conversations.get(conversationIdKey) || [];

        // Add user audio message
        const userMessage: ModelMessage = {
          role: "user",
          content: [
            { type: "text", text: "" },
            { type: "file", mediaType: "audio/wav", data: audioData },
          ],
        };
        messages.push(userMessage);

        // Get agent response
        console.log(
          `Processing message for conversation ${conversationIdKey}...`
        );
        const response = await agent.call({ messages } as AgentInput);

        // Add agent response to history
        if (typeof response !== "string") {
          messages.push(response);
        }
        conversations.set(conversationIdKey, messages);

        // Extract audio from response
        const content = (response as ModelMessage).content as Array<{
          type: string;
          data?: string;
          text?: string;
        }>;
        const audioPart = content?.find((p) => p.type === "file");
        const textPart = content?.find((p) => p.type === "text");

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            audioData: audioPart?.data || null,
            transcript: textPart?.text || "",
          })
        );
      } catch (error) {
        console.error("Error processing chat:", error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const HTML_PAGE = `<!DOCTYPE html>
<html>
<head>
  <title>Interactive Voice Conversation</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 700px;
      margin: 0 auto;
      padding: 40px 20px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
    }
    .container {
      background: white;
      border-radius: 20px;
      padding: 40px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    h1 {
      margin: 0 0 30px 0;
      color: #333;
      font-size: 32px;
    }
    button {
      padding: 20px 40px;
      font-size: 18px;
      cursor: pointer;
      border: none;
      border-radius: 50px;
      font-weight: 600;
      transition: all 0.3s ease;
      box-shadow: 0 4px 15px rgba(0,0,0,0.2);
      display: block;
      width: 100%;
      margin: 20px 0;
    }
    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(0,0,0,0.3);
    }
    button:active {
      transform: translateY(0);
    }
    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    #startBtn {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    #startBtn.active {
      background: linear-gradient(135deg, #ff6b6b 0%, #ee5a6f 100%);
    }
    .recording-indicator {
      display: inline-block;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #ff4444;
      margin-right: 8px;
      animation: pulse 1.5s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.6; transform: scale(0.9); }
    }
    #status {
      margin: 20px 0;
      padding: 15px;
      background: #f8f9fa;
      border-radius: 10px;
      min-height: 50px;
      color: #555;
      font-size: 16px;
      line-height: 1.5;
    }
    #status.loading:after {
      content: '...';
      animation: dots 1.5s steps(4, end) infinite;
    }
    @keyframes dots {
      0%, 20% { content: '.'; }
      40% { content: '..'; }
      60%, 100% { content: '...'; }
    }
    .info {
      background: #e7f3ff;
      padding: 15px;
      border-radius: 10px;
      margin-bottom: 20px;
      font-size: 14px;
      color: #0066cc;
    }
    .controls {
      display: flex;
      gap: 10px;
      margin-top: 10px;
    }
    .controls label {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      color: #666;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎙️ Voice Conversation</h1>
    <div class="info">
      💡 Click "Start Conversation" to begin. Speak naturally - the conversation will flow automatically!
    </div>
    <button id="startBtn">🎤 Start Conversation</button>
    <div class="controls">
      <label>
        <input type="checkbox" id="autoMode" checked>
        Auto-continue conversation
      </label>
    </div>
    <div id="status">Ready to start...</div>
  </div>

  <script>
    let audioContext;
    let mediaStream;
    let processor;
    let isRecording = false;
    let isConversationActive = false;
    let recordedChunks = [];
    let silenceTimeout;
    let hasSpeechStarted = false;

    const startBtn = document.getElementById('startBtn');
    const status = document.getElementById('status');
    const autoMode = document.getElementById('autoMode');
    const conversationId = Date.now().toString();

    // VAD configuration
    const SILENCE_THRESHOLD = 0.01; // Audio level below this is considered silence
    const SILENCE_DURATION = 1500; // Stop recording after 1.5s of silence
    const MIN_SPEECH_DURATION = 500; // Must speak for at least 0.5s

    // WAV encoding functions
    function encodeWAV(samples, sampleRate) {
      const buffer = new ArrayBuffer(44 + samples.length * 2);
      const view = new DataView(buffer);

      // WAV header
      writeString(view, 0, 'RIFF');
      view.setUint32(4, 36 + samples.length * 2, true);
      writeString(view, 8, 'WAVE');
      writeString(view, 12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeString(view, 36, 'data');
      view.setUint32(40, samples.length * 2, true);

      // Write audio data
      floatTo16BitPCM(view, 44, samples);

      return view;
    }

    function writeString(view, offset, string) {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    }

    function floatTo16BitPCM(output, offset, input) {
      for (let i = 0; i < input.length; i++, offset += 2) {
        const s = Math.max(-1, Math.min(1, input[i]));
        output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      }
    }

    async function startConversation() {
      try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: 16000
        });

        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });

        isConversationActive = true;
        startBtn.textContent = '🛑 End Conversation';
        startBtn.classList.add('active');

        startRecording();
      } catch (error) {
        status.textContent = '❌ Error: Could not access microphone';
        console.error('Microphone error:', error);
      }
    }

    function startRecording() {
      if (!isConversationActive) return;

      recordedChunks = [];
      hasSpeechStarted = false;
      const source = audioContext.createMediaStreamSource(mediaStream);
      // Note: ScriptProcessorNode is deprecated but AudioWorklet requires separate file
      // For this demo, ScriptProcessorNode is simpler and works fine
      processor = audioContext.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = (e) => {
        if (isRecording) {
          const inputData = e.inputBuffer.getChannelData(0);
          recordedChunks.push(new Float32Array(inputData));

          // Voice Activity Detection - calculate RMS (audio level)
          let sum = 0;
          for (let i = 0; i < inputData.length; i++) {
            sum += inputData[i] * inputData[i];
          }
          const rms = Math.sqrt(sum / inputData.length);

          // Detect speech vs silence
          if (rms > SILENCE_THRESHOLD) {
            // Speech detected
            if (!hasSpeechStarted) {
              hasSpeechStarted = true;
              status.innerHTML = '<span class="recording-indicator"></span>Listening... (I can hear you!)';
            }
            // Reset silence timer when speech is detected
            clearTimeout(silenceTimeout);
            silenceTimeout = setTimeout(() => {
              // Silence detected after speech - auto-send
              if (isRecording && hasSpeechStarted) {
                status.textContent = '✅ Speech detected, processing...';
                stopRecording();
              }
            }, SILENCE_DURATION);
          }
        }
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      isRecording = true;
      status.innerHTML = '<span class="recording-indicator"></span>Listening... (start speaking)';

      // Safety timeout - max 15 seconds
      setTimeout(() => {
        if (isRecording) {
          status.textContent = '⏱️ Max recording time reached';
          stopRecording();
        }
      }, 15000);
    }

    async function stopRecording() {
      if (!isRecording) return;

      isRecording = false;
      processor.disconnect();

      // Combine all chunks
      const totalLength = recordedChunks.reduce((acc, chunk) => acc + chunk.length, 0);
      const combined = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of recordedChunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }

      // Encode as WAV
      const wavData = encodeWAV(combined, audioContext.sampleRate);
      const wavBlob = new Blob([wavData], { type: 'audio/wav' });

      await sendAudio(wavBlob);
    }

    async function sendAudio(audioBlob) {
      try {
        status.textContent = '⏳ Agent is thinking';
        status.classList.add('loading');

        // Convert to base64 in chunks to avoid stack overflow
        const arrayBuffer = await audioBlob.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < uint8Array.length; i += chunkSize) {
          const chunk = uint8Array.subarray(i, i + chunkSize);
          binary += String.fromCharCode.apply(null, Array.from(chunk));
        }
        const base64 = btoa(binary);

        const response = await fetch('/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioData: base64, conversationId })
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || \`Server error: \${response.status}\`);
        }

        const { audioData, transcript } = await response.json();
        status.classList.remove('loading');

        if (audioData) {
          status.textContent = transcript ? \`🤖 "\${transcript}"\` : '🔊 Agent speaking...';

          // Play agent response
          const audioBytes = Uint8Array.from(atob(audioData), c => c.charCodeAt(0));
          const audioBlob = new Blob([audioBytes], { type: 'audio/wav' });
          const audioUrl = URL.createObjectURL(audioBlob);
          const audio = new Audio(audioUrl);

          audio.onended = () => {
            // Auto-continue if enabled and conversation still active
            if (autoMode.checked && isConversationActive) {
              setTimeout(() => startRecording(), 500);
            } else if (isConversationActive) {
              status.textContent = '✅ Click anywhere to continue...';
            }
          };

          await audio.play();
        } else {
          status.textContent = '⚠️ No response received';
        }
      } catch (error) {
        status.classList.remove('loading');
        status.textContent = \`❌ Error: \${error.message}\`;
        console.error('Send audio error:', error);
      }
    }

    function endConversation() {
      isConversationActive = false;
      isRecording = false;

      if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
      }
      if (processor) {
        processor.disconnect();
      }
      if (audioContext) {
        audioContext.close();
      }

      startBtn.textContent = '🎤 Start Conversation';
      startBtn.classList.remove('active');
      status.textContent = 'Conversation ended. Click to start a new one.';
    }

    startBtn.addEventListener('click', () => {
      if (isConversationActive) {
        endConversation();
      } else {
        startConversation();
      }
    });

    // Check microphone permission on load
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(stream => {
        stream.getTracks().forEach(track => track.stop());
        status.textContent = '✅ Ready! Click "Start Conversation" to begin.';
      })
      .catch(() => {
        status.textContent = '⚠️ Microphone permission needed.';
      });
  </script>
</body>
</html>`;

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
server.listen(PORT, () => {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🚀 Interactive Voice Server Running!`);
  console.log(`${"=".repeat(60)}`);
  console.log(
    `\n📱 Open in your browser: \x1b[36mhttp://localhost:${PORT}\x1b[0m\n`
  );
  console.log(`💡 Make sure you have OPENAI_API_KEY set in your environment\n`);
  console.log(`Press Ctrl+C to stop the server\n`);
});
