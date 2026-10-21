import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEngine } from "../src/core.js";
import { createDemoPack } from "../src/fixtures.js";
import { FileStore } from "../src/store.js";

function readOptions(args) {
  const options = {
    baselineOpensPerSecond: 10,
    durationSeconds: 600,
    viewerCount: 1200
  };
  for (const argument of args) {
    const match = argument.match(/^--(baseline-opens-per-second|duration-seconds|viewer-count)=(\d+)$/);
    if (!match) throw new Error(`Unsupported option: ${argument}`);
    const key = {
      "baseline-opens-per-second": "baselineOpensPerSecond",
      "duration-seconds": "durationSeconds",
      "viewer-count": "viewerCount"
    }[match[1]];
    options[key] = Number(match[2]);
  }
  if (!Number.isInteger(options.baselineOpensPerSecond) || options.baselineOpensPerSecond < 1 ||
      !Number.isInteger(options.durationSeconds) || options.durationSeconds < 1 ||
      !Number.isInteger(options.viewerCount) || options.viewerCount < 1 || options.viewerCount > 5000) {
    throw new Error("Rate, duration, and viewer count must be positive integers; viewer count cannot exceed 5000.");
  }
  return options;
}

async function run() {
  const options = readOptions(process.argv.slice(2));
  const targetRate = options.baselineOpensPerSecond * 3;
  const targetOpens = targetRate * options.durationSeconds;
  const output = mkdtempSync(join(tmpdir(), "ott-sustained-load-"));
  let timer;
  try {
    const pack = createDemoPack({ viewerCount: options.viewerCount });
    const engine = new AgentEngine({ pack, store: new FileStore(output) });
    const inFlight = new Set();
    const latencies = [];
    let issued = 0;
    let failures = 0;
    const started = performance.now();
    const intervalMs = 1000 / targetRate;
    const issueOpen = () => {
      if (issued >= targetOpens) {
        clearInterval(timer);
        return;
      }
      const sequence = issued++;
      const viewerId = pack.viewerIds[sequence % pack.viewerIds.length];
      const timestamp = new Date().toISOString();
      const trigger = {
        id: `SUSTAINED-${sequence}`,
        viewer_id: viewerId,
        type: "app_open",
        occurred_at: timestamp,
        received_at: timestamp
      };
      const decisionStarted = performance.now();
      const operation = engine.processTrigger(trigger).then((decision) => {
        latencies.push(performance.now() - decisionStarted);
      }).catch((error) => {
        failures++;
        console.error(`Decision ${sequence} failed: ${error.message}`);
      }).finally(() => inFlight.delete(operation));
      inFlight.add(operation);
    };
    const issueDueOpens = () => {
      const dueCount = Math.min(targetOpens, Math.floor((performance.now() - started) / intervalMs) + 1);
      while (issued < dueCount) issueOpen();
    };
    issueDueOpens();
    timer = setInterval(issueDueOpens, intervalMs);
    await new Promise((resolve) => setTimeout(resolve, options.durationSeconds * 1000 + intervalMs + 10));
    clearInterval(timer);
    await Promise.all(inFlight);
    const elapsedSeconds = (performance.now() - started) / 1000;
    latencies.sort((a, b) => a - b);
    const report = {
      scenario: "sustained_triple_baseline_app_opens",
      baseline_opens_per_second: options.baselineOpensPerSecond,
      target_opens_per_second: targetRate,
      target_duration_seconds: options.durationSeconds,
      observed_duration_seconds: Number(elapsedSeconds.toFixed(2)),
      target_opens: targetOpens,
      decisions_issued: issued,
      decisions_completed: latencies.length,
      failures,
      achieved_opens_per_second: Number((issued / options.durationSeconds).toFixed(2)),
      max_decision_ms: latencies.at(-1) ?? 0,
      p95_decision_ms: latencies[Math.floor((latencies.length - 1) * 0.95)] ?? 0,
      decision_budget_ms: 60_000,
      sustained_target_met: issued === targetOpens &&
        latencies.length === targetOpens &&
        failures === 0 &&
        latencies.every((latency) => latency < 60_000),
      mode: "generated_synthetic_data",
      persistence: "single-process local FileStore; not a cloud capacity certification"
    };
    console.log(JSON.stringify(report, null, 2));
    if (!report.sustained_target_met) process.exitCode = 1;
  } finally {
    clearInterval(timer);
    rmSync(output, { recursive: true, force: true });
  }
}

try {
  await run();
} catch (error) {
  console.error(`Sustained load test failed: ${error.message}`);
  process.exitCode = 1;
}
