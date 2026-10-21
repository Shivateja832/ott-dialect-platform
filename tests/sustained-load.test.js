import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("sustained-load runner completes a short synthetic triple-baseline scenario", () => {
  const result = spawnSync(process.execPath, [
    join(projectRoot, "scripts", "sustained-load.mjs"),
    "--baseline-opens-per-second=1",
    "--duration-seconds=2",
    "--viewer-count=3"
  ], { cwd: projectRoot, encoding: "utf8", timeout: 10_000 });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.scenario, "sustained_triple_baseline_app_opens");
  assert.equal(report.target_opens, 6);
  assert.equal(report.decisions_completed, 6);
  assert.equal(report.sustained_target_met, true);
});
