import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEngine } from "../src/core.js";
import { createDemoPack } from "../src/fixtures.js";
import { FileStore } from "../src/store.js";

const viewerCount = Number(process.argv[2] ?? 1000);
if (!Number.isInteger(viewerCount) || viewerCount < 1 || viewerCount > 5000) {
  console.error("Usage: node scripts/benchmark.mjs [unique-viewers: 1-5000]");
  process.exitCode = 1;
} else {
  const output = mkdtempSync(join(tmpdir(), "ott-load-test-"));
  try {
    const pack = createDemoPack({ viewerCount });
    const engine = new AgentEngine({ pack, store: new FileStore(output) });
    const triggers = pack.triggers.slice(0, viewerCount);
    const burstAt = new Date(Date.parse(triggers.at(-1).received_at) + 1_000).toISOString();
    for (const trigger of triggers) {
      trigger.occurred_at = burstAt;
      trigger.received_at = burstAt;
    }
    const started = performance.now();
    const decisions = await Promise.all(triggers.map((trigger) => engine.processTrigger(trigger)));
    const elapsedMs = Math.round(performance.now() - started);
    const latencies = decisions.map((decision) => decision.decided_in_ms).sort((a, b) => a - b);
    const report = {
      scenario: "unique_viewers_concurrent_app_opens",
      viewers: viewerCount,
      decisions: decisions.length,
      trigger_window_seconds: 0,
      elapsed_ms: elapsedMs,
      throughput_per_second: Number((decisions.length / (elapsedMs / 1000)).toFixed(2)),
      max_decision_ms: latencies.at(-1) ?? 0,
      p95_decision_ms: latencies[Math.floor((latencies.length - 1) * 0.95)] ?? 0,
      budget_ms: 60_000,
      burst_completed_within_minute: elapsedMs < 60_000,
      all_decisions_within_budget: elapsedMs < 60_000 &&
        decisions.length === viewerCount &&
        latencies.every((latency) => latency < 60_000),
      mode: "generated_synthetic_data"
    };
    console.log(JSON.stringify(report, null, 2));
    if (!report.all_decisions_within_budget) process.exitCode = 1;
  } catch (error) {
    console.error(`Load test failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}
