import { createServer as createHttpServer } from "node:http";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(projectRoot, "public");
const sampleDir = resolve(process.env.REPLAY_DIR ?? join(projectRoot, "sample_run"));
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]]
]);

function readJsonl(filename) {
  const file = join(sampleDir, filename);
  if (!existsSync(file)) throw new Error(`Replay artifact is missing: ${filename}`);
  return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function readJson(filename) {
  const file = join(sampleDir, filename);
  if (!existsSync(file)) throw new Error(`Replay artifact is missing: ${filename}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

function viewerStates() {
  const dir = join(sampleDir, "viewer_state");
  if (!existsSync(dir)) throw new Error("Replay viewer-state directory is missing.");
  return readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) =>
    JSON.parse(readFileSync(join(dir, name), "utf8"))
  );
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function parsePage(url) {
  const limitValue = Number(url.searchParams.get("limit") ?? 25);
  const offsetValue = Number(url.searchParams.get("offset") ?? 0);
  if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 100 ||
      !Number.isInteger(offsetValue) || offsetValue < 0) {
    throw new Error("limit must be 1-100 and offset must be a non-negative integer.");
  }
  return { limit: limitValue, offset: offsetValue };
}

function paginate(items, url) {
  const { limit, offset } = parsePage(url);
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    limit,
    offset
  };
}

function routeApi(url, response) {
  if (url.pathname === "/api/health") {
    try {
      const manifest = readJson("fixture_manifest.json");
      const decisions = readJsonl("decisions.jsonl");
      if (!["generated_mock", "provided_pack"].includes(manifest.mode) || !decisions.length) {
        return sendJson(response, 503, { status: "degraded", error: "Replay is unavailable." });
      }
      return sendJson(response, 200, {
        status: "ok",
        mode: manifest.mode,
        app: "OTT Dialect Platform"
      });
    } catch (error) {
      console.error(`Health check failed: ${error.message}`);
      return sendJson(response, 503, { status: "degraded", error: "Replay is unavailable." });
    }
  }
  if (url.pathname === "/api/summary") {
    const manifest = readJson("fixture_manifest.json");
    const decisions = readJsonl("decisions.jsonl");
    const actions = readJsonl("actions.jsonl");
    const outcomes = readJsonl("outcomes.jsonl");
    return sendJson(response, 200, {
      mode: manifest.mode,
      viewers: viewerStates().length,
      decisions: decisions.length,
      actions: actions.length,
      outcomes: outcomes.length,
      latency: readJson("latency_report.json"),
      impact: readJson("impact_report.json"),
      outcome_statuses: {
        succeeded: outcomes.filter((item) => item.status === "SUCCEEDED").length,
        failed: outcomes.filter((item) => item.status === "FAILED").length,
        inconclusive: outcomes.filter((item) => item.status === "INCONCLUSIVE").length
      }
    });
  }
  if (url.pathname === "/api/decisions") {
    const allDecisions = readJsonl("decisions.jsonl").reverse();
    const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const filtered = query ? allDecisions.filter((item) =>
      item.viewer_id.toLowerCase().includes(query) ||
      item.goal?.id?.toLowerCase().includes(query) ||
      item.reason?.toLowerCase().includes(query)
    ) : allDecisions;
    return sendJson(response, 200, paginate(filtered, url));
  }
  if (url.pathname === "/api/actions") {
    return sendJson(response, 200, paginate(readJsonl("actions.jsonl").reverse(), url));
  }
  if (url.pathname === "/api/outcomes") {
    return sendJson(response, 200, paginate(readJsonl("outcomes.jsonl").reverse(), url));
  }
  if (url.pathname === "/api/viewers") {
    const viewers = viewerStates().map((state) => ({
      viewer_id: state.viewer_id,
      experiment_group: state.experimentGroup,
      active_goal: state.activeGoal,
      last_trigger_at: state.last_trigger_at ?? null,
      outcomes: state.outcomes?.length ?? 0
    })).sort((a, b) => a.viewer_id.localeCompare(b.viewer_id));
    return sendJson(response, 200, paginate(viewers, url));
  }
  const viewerMatch = url.pathname.match(/^\/api\/viewers\/([^/]+)$/);
  if (viewerMatch) {
    let viewerId;
    try {
      viewerId = decodeURIComponent(viewerMatch[1]);
    } catch {
      return sendJson(response, 400, { error: "Invalid viewer ID encoding." });
    }
    const statePath = join(sampleDir, "viewer_state", `${Buffer.from(viewerId, "utf8").toString("hex")}.json`);
    if (!existsSync(statePath)) return sendJson(response, 404, { error: "Viewer state not found." });
    return sendJson(response, 200, JSON.parse(readFileSync(statePath, "utf8")));
  }
  return sendJson(response, 404, { error: "API route not found." });
}

export function createAppServer({ host = "127.0.0.1", port = 0 } = {}) {
  return createHttpServer((request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'self'; script-src 'self'; connect-src 'self'");
    response.setHeader("Cache-Control", "no-store");
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method !== "GET" && request.method !== "HEAD") {
        return sendJson(response, 405, { error: "Only GET and HEAD are supported." });
      }
      if (url.pathname.startsWith("/api/")) return routeApi(url, response);
      const asset = staticFiles.get(url.pathname);
      if (!asset) return sendJson(response, 404, { error: "Page not found." });
      const [filename, contentType] = asset;
      const body = readFileSync(join(publicDir, filename));
      response.writeHead(200, { "Content-Type": contentType });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      if (error instanceof URIError) return sendJson(response, 400, { error: "Invalid request URL." });
      if (error.message.startsWith("limit must be")) {
        return sendJson(response, 400, { error: error.message });
      }
      console.error(`Request failed: ${error.message}`);
      return sendJson(response, 500, { error: "The replay data could not be loaded." });
    }
  }).listen(port, host);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    console.error("PORT must be an integer from 1 to 65535.");
    process.exitCode = 1;
  } else {
    const server = createAppServer({ host: "0.0.0.0", port });
    server.on("listening", () => console.log(`OTT Dialect Platform demo listening on port ${port}`));
    server.on("error", (error) => {
      console.error(`Server failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
