import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createAppServer } from "../src/server.js";

async function startServer(t) {
  const server = createAppServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("dashboard serves its page and read-only health and replay APIs", async (t) => {
  const base = await startServer(t);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal((await page.text()).includes("ONE VIEWER. ONE AGENT."), true);

  const health = await fetch(`${base}/api/health`).then((response) => response.json());
  assert.equal(health.status, "ok");
  assert.equal(health.mode, "generated_mock");

  const summary = await fetch(`${base}/api/summary`).then((response) => response.json());
  assert.equal(summary.viewers, 120);
  assert.equal(summary.latency.within_budget, true);
  assert.equal(summary.impact.method, "intention_to_treat_randomized_holdout");
});

test("decision API paginates, searches and validates caller input", async (t) => {
  const base = await startServer(t);
  const page = await fetch(`${base}/api/decisions?limit=3&offset=0`).then((response) => response.json());
  assert.equal(page.items.length, 3);
  assert.equal(page.total, 121);

  const match = await fetch(`${base}/api/decisions?q=V-0003&limit=5`).then((response) => response.json());
  assert.equal(match.total, 1);
  assert.equal(match.items[0].viewer_id, "V-0003");

  const invalid = await fetch(`${base}/api/decisions?limit=101`);
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /limit must be/);
});

test("viewer state is addressable and mutation methods are not exposed", async (t) => {
  const base = await startServer(t);
  const viewer = await fetch(`${base}/api/viewers/V-0001`);
  assert.equal(viewer.status, 200);
  assert.equal((await viewer.json()).viewer_id, "V-0001");

  const mutation = await fetch(`${base}/api/summary`, { method: "POST" });
  assert.equal(mutation.status, 405);
});
