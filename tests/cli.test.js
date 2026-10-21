import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createDemoPack } from "../src/fixtures.js";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("CLI replays a normalized external pack and protects outputs from pack changes", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ott-pack-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pack = createDemoPack({ viewerCount: 3 });
  pack.goalRules = {
    missing_signal_goal: {
      id: "missing_signal_goal",
      version: 1,
      evidence: "not_in_event_types",
      windowHours: 48,
      priority: 1,
      eligibility: { requiresSignup: true }
    }
  };
  const packPath = join(directory, "pack.json");
  const output = join(directory, "output");
  writeFileSync(packPath, JSON.stringify(pack));

  const first = spawnSync(process.execPath, [
    join(projectRoot, "src", "cli.js"),
    "replay",
    "--pack",
    packPath,
    "--out",
    output
  ], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  const manifest = JSON.parse(readFileSync(join(output, "fixture_manifest.json"), "utf8"));
  assert.equal(manifest.mode, "provided_pack");
  assert.equal(manifest.viewer_count, 3);
  const firstDecision = readFileSync(join(output, "decisions.jsonl"), "utf8")
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))[0];
  assert.equal(firstDecision.goal, null);
  assert.equal(firstDecision.reason, "no_evidence_backed_eligible_goal");

  writeFileSync(packPath, JSON.stringify({ ...pack, extra_operator_annotation: true }));
  const changedPack = spawnSync(process.execPath, [
    join(projectRoot, "src", "cli.js"),
    "replay",
    "--pack",
    packPath,
    "--out",
    output
  ], { cwd: projectRoot, encoding: "utf8" });
  assert.notEqual(changedPack.status, 0);
  assert.match(changedPack.stderr, /different input pack/);
});
