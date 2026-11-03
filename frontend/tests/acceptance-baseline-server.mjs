// Serve the preserved real frontend build against the real authenticated API.
// Loopback only; no response fixtures and no request/header logging.
import { createServer, request as httpRequest } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function createBaselineServer({
  directory = "/tmp/famsun-snake-baseline-dist",
  apiOrigin = "http://127.0.0.1:8000",
  port = 0,
} = {}) {
  const root = path.resolve(directory);
  const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm", ".woff2": "font/woff2" };
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/api/")) {
      const upstream = new URL(request.url, apiOrigin);
      const proxy = httpRequest(upstream, { method: request.method, headers: { ...request.headers, host: upstream.host } }, (result) => {
        response.writeHead(result.statusCode ?? 502, result.headers);
        result.pipe(response);
      });
      proxy.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end("Upstream unavailable"); });
      request.pipe(proxy);
      return;
    }
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      let filename = path.resolve(root, `.${pathname}`);
      if (filename !== root && !filename.startsWith(root + path.sep)) { response.writeHead(404); response.end(); return; }
      try { if (!(await stat(filename)).isFile()) filename = path.join(root, "index.html"); }
      catch { filename = path.join(root, "index.html"); }
      const bytes = await readFile(filename);
      response.writeHead(200, { "Content-Type": mime[path.extname(filename)] ?? "application/octet-stream", "Cache-Control": "no-store" });
      response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await createBaselineServer({ port: Number(process.env.FAMSUN_BASELINE_PORT || 9081) });
  console.log(`BASELINE_ORIGIN ${server.origin}`);
}
