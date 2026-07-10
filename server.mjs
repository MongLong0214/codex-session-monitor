import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDashboardSnapshot } from "./lib/session-data.mjs";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(projectRoot, "public");
const host = "127.0.0.1";
const port = Number(process.env.PORT || 4177);
const staticFiles = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
]);

function send(response, status, body, headers = {}) {
  response.writeHead(status, {
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(body);
}

function isLocalHost(request) {
  const address = server.address();
  const activePort = typeof address === "object" && address ? address.port : port;
  return request.headers.host === `${host}:${activePort}`;
}

async function readSnapshot() {
  const fixturePath = process.env.CODEX_SESSION_MONITOR_FIXTURE;
  if (!fixturePath) {
    return getDashboardSnapshot();
  }

  return JSON.parse(await readFile(fixturePath, "utf8"));
}

const server = createServer(async (request, response) => {
  if (!isLocalHost(request)) {
    send(response, 403, "허용되지 않은 로컬 호스트입니다.", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  const url = new URL(request.url || "/", `http://${host}`);

  if (request.method === "GET" && url.pathname === "/api/sessions") {
    try {
      const snapshot = await readSnapshot();
      send(response, 200, JSON.stringify(snapshot), { "Content-Type": "application/json; charset=utf-8" });
    } catch (error) {
      console.error("세션 상태를 읽지 못했습니다:", error instanceof Error ? error.message : error);
      send(
        response,
        500,
        JSON.stringify({ error: "로컬 Codex 상태를 읽지 못했습니다. 터미널 로그를 확인해 주세요." }),
        { "Content-Type": "application/json; charset=utf-8" },
      );
    }
    return;
  }

  const staticFile = request.method === "GET" ? staticFiles.get(url.pathname) : null;
  if (!staticFile) {
    send(response, 404, "찾을 수 없는 경로입니다.", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  try {
    const body = await readFile(path.join(publicRoot, staticFile.file));
    send(response, 200, body, { "Content-Type": staticFile.type });
  } catch {
    send(response, 500, "화면 파일을 읽지 못했습니다.", { "Content-Type": "text/plain; charset=utf-8" });
  }
});

server.listen(port, host, () => {
  const address = server.address();
  const activePort = typeof address === "object" && address ? address.port : port;
  console.log(`Codex Session Monitor: http://${host}:${activePort}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
