import http from "node:http";

const port = Number(process.env.PRISM_STUDIO_STORY_HEALTH_PORT || "8080");
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, worker: "story" }));
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "0.0.0.0", () => resolve());
});
try {
  await import("./story-worker.mts");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
