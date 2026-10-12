// In-process stand-in for LangWatch's /api/scenario-events, the twin of
// go/fake/sink.go: reads each body, counts it, answers 200 with "{}".
import http from "node:http";

export async function startSink() {
  let events = 0;
  let bytes = 0;
  const server = http.createServer((req, res) => {
    let n = 0;
    req.on("data", (chunk) => {
      n += chunk.length;
    });
    req.on("end", () => {
      events++;
      bytes += n;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  server.keepAliveTimeout = 90_000;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    counts: () => ({ events, bytes }),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
