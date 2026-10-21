import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { AgentEngine, buildImpactReport } from "./core.js";
import { createDemoPack, demoTriggerSequence, seedSimulatedOutcomes } from "./fixtures.js";
import { FileStore } from "./store.js";

const root = dirname(fileURLToPath(import.meta.url));

function parseArgs(args) {
  const [command = "replay", ...rest] = args;
  const options = { command, out: "sample_run", pack: null };
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] === "--out") options.out = rest[++index];
    else if (rest[index] === "--pack") options.pack = rest[++index];
    else throw new Error(`Unknown argument: ${rest[index]}`);
  }
  if (rest.includes("--pack") && !options.pack) throw new Error("--pack requires a JSON pack path.");
  if (rest.includes("--out") && !options.out) throw new Error("--out requires a directory path.");
  if (command !== "replay") throw new Error(`Unknown command: ${command}`);
  return options;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function jsonl(value) {
  return value.map((row) => JSON.stringify(row)).join("\n") + (value.length ? "\n" : "");
}

function markdownImpact(report) {
  const treatment = report.groups.treatment;
  const holdout = report.groups.holdout;
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  return `# Replay impact report

## Result

- Design: ${report.method}
- Treatment: ${treatment.successes}/${treatment.judged} judged outcomes succeeded (${percent(treatment.rate)}); ${treatment.pending} pending, ${treatment.inconclusive} inconclusive
- Randomized holdout: ${holdout.successes}/${holdout.judged} judged outcomes succeeded (${percent(holdout.rate)}); ${holdout.pending} pending, ${holdout.inconclusive} inconclusive
- Absolute difference: ${percent(report.absolute_uplift)}
- Approximate 95% interval: ${percent(report.approximate_95pct_interval[0])} to ${percent(report.approximate_95pct_interval[1])}

The primary comparison follows stable randomized assignment, regardless of whether an intervention was served. This avoids the selection bias in comparing served viewers with everyone else. Rates use terminal outcomes for the initially assigned goal; pending and inconclusive viewers are disclosed rather than silently counted as failures.

## Limitations

${report.caveats.map((item) => `- ${item}`).join("\n")}
`;
}

function loadPack(path) {
  const pack = JSON.parse(readFileSync(resolve(path), "utf8"));
  for (const field of ["events", "eventTypes", "profiles", "appSettings", "campaignLinks", "catalogue", "triggers"]) {
    if (!Array.isArray(pack[field])) throw new Error(`Pack field "${field}" must be an array.`);
  }
  if (!pack.goalRules || typeof pack.goalRules !== "object" || Array.isArray(pack.goalRules)) {
    throw new Error('Pack field "goalRules" must be an object keyed by goal ID.');
  }
  pack.consents ??= [];
  if (!Array.isArray(pack.consents)) throw new Error('Pack field "consents" must be an array.');
  pack.interventionCatalogue ??= { templates: [] };
  if (!pack.interventionCatalogue || typeof pack.interventionCatalogue !== "object" ||
      !Array.isArray(pack.interventionCatalogue.templates)) {
    throw new Error('Pack field "interventionCatalogue.templates" must be an array.');
  }
  if (pack.eventTypes.some((type) => typeof type !== "string" || !type.trim())) {
    throw new Error('Pack field "eventTypes" must contain non-empty strings.');
  }
  if (pack.interventionCatalogue.channelPriority !== undefined &&
      (!Array.isArray(pack.interventionCatalogue.channelPriority) ||
        pack.interventionCatalogue.channelPriority.some((channel) =>
          !["PUSH", "WHATSAPP", "IN_APP"].includes(channel)))) {
    throw new Error('Pack field "interventionCatalogue.channelPriority" contains an unsupported channel.');
  }
  if (pack.interventionCatalogue.heroSlot?.enabled !== undefined &&
      typeof pack.interventionCatalogue.heroSlot.enabled !== "boolean") {
    throw new Error('Pack field "interventionCatalogue.heroSlot.enabled" must be a boolean.');
  }
  for (const consent of pack.consents) {
    if (!consent || typeof consent.id !== "string" || !consent.id ||
        typeof consent.viewer_id !== "string" || !consent.viewer_id ||
        !["PUSH", "WHATSAPP", "IN_APP"].includes(consent.channel) ||
        typeof consent.granted !== "boolean" ||
        !Number.isFinite(Date.parse(consent.received_at))) {
      throw new Error("Every consent record needs id, viewer_id, a supported channel, granted boolean, and valid received_at.");
    }
  }
  for (const template of pack.interventionCatalogue.templates) {
    if (!template || typeof template.id !== "string" || !template.id ||
        !["PUSH", "WHATSAPP", "IN_APP"].includes(template.channel) ||
        typeof template.language !== "string" || !template.language ||
        typeof template.approved !== "boolean" || typeof template.body !== "string") {
      throw new Error("Every message template needs id, supported channel, language, approved boolean, and body.");
    }
  }
  if (pack.simulator &&
      (!Number.isFinite(pack.simulator.baseRate) || pack.simulator.baseRate < 0 || pack.simulator.baseRate > 1 ||
       !Number.isFinite(pack.simulator.treatmentLift) ||
       pack.simulator.baseRate + pack.simulator.treatmentLift < 0 ||
       pack.simulator.baseRate + pack.simulator.treatmentLift > 1 ||
       typeof pack.simulator.salt !== "string" || !pack.simulator.salt)) {
    throw new Error("Pack simulator requires valid rates in [0, 1] and a non-empty salt.");
  }
  const knownEventTypes = new Set(pack.eventTypes);
  for (const rule of Object.values(pack.goalRules)) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      throw new Error("Each goalRules value must be an object.");
    }
    if (rule.underspecified === true) rule.enabled = false;
    const signal = rule.evidence ?? rule.success_signal;
    if (typeof signal === "string" && !knownEventTypes.has(signal)) {
      rule.signal_available = false;
    }
  }
  return pack;
}

function prepareOutput(output, mode, packSha256) {
  mkdirSync(output, { recursive: true });
  const manifest = join(output, "fixture_manifest.json");
  const generatedFiles = [
    "decisions.jsonl", "actions.jsonl", "outcomes.jsonl", "latency_report.json",
    "impact_report.json", "impact_report.md", "final_report.md", "rule_correction.json"
  ];
  if (existsSync(manifest)) {
    const existing = JSON.parse(readFileSync(manifest, "utf8"));
    if (existing.mode !== mode) {
      throw new Error(`Refusing to overwrite output directory with mode ${existing.mode}.`);
    }
    if (mode === "provided_pack" && existing.pack_sha256 !== packSha256) {
      throw new Error("Refusing to replace replay output produced from a different input pack.");
    }
    for (const name of generatedFiles) {
      const path = join(output, name);
      if (existsSync(path)) unlinkSync(path);
    }
    const stateDir = join(output, "viewer_state");
    if (existsSync(stateDir)) {
      for (const name of readdirSync(stateDir)) {
        if (name.endsWith(".json")) unlinkSync(join(stateDir, name));
      }
    }
  } else if (generatedFiles.some((name) => existsSync(join(output, name)))) {
    throw new Error("Refusing to overwrite replay files without a generated-mock manifest.");
  }
}

async function replay(out, packPath) {
  const started = performance.now();
  const generated = !packPath;
  const pack = generated ? createDemoPack() : loadPack(packPath);
  const mode = generated ? "generated_mock" : "provided_pack";
  const packSha256 = packPath
    ? createHash("sha256").update(readFileSync(resolve(packPath))).digest("hex")
    : null;
  const viewerCount = pack.viewerIds?.length ??
    new Set(pack.triggers.map((trigger) => trigger.viewer_id)).size;
  const output = resolve(out);
  prepareOutput(output, mode, packSha256);
  writeJson(join(output, "fixture_manifest.json"), {
    mode,
    pack_sha256: packSha256,
    viewer_count: viewerCount,
    trigger_count: pack.triggers.length,
    fixture_cases: generated
      ? ["late_offline_open", "duplicate_open", "profile_conflict", "three_dialect_conflict", "purchase_after_open", "rule_correction", "dependency_failure", "prompt_injection_catalogue_text", "randomized_holdout"]
      : [],
    note: generated
      ? "Generated deterministic synthetic data; no live audience or external provider is used."
      : "Input pack provided by the operator; action delivery remains simulated and no external provider is called."
  });
  const store = new FileStore(output);
  const provider = {
    async beforeDecision({ viewerId }) {
      if (viewerId === pack.dependencyFailureViewer) throw new Error("mock_catalogue_timeout");
    }
  };
  const engine = new AgentEngine({ pack, store, provider });
  const latency = [];
  const sequence = generated ? demoTriggerSequence(pack) : (pack.replay_sequence ?? pack.triggers);
  if (!Array.isArray(sequence)) throw new Error("Pack replay_sequence or triggers must be an array.");
  for (const item of sequence) {
    if (item.type === "rule_correction") {
      const correction = item.correction ?? item;
      const result = engine.applyRuleCorrection(correction);
      writeFileSync(join(output, "rule_correction.json"), `${JSON.stringify({ ...result, applied_at: item.received_at ?? null, correction }, null, 2)}\n`, "utf8");
      continue;
    }
    const duplicatesBefore = engine.metrics.duplicateTriggers;
    const decision = await engine.processTrigger(item);
    if (engine.metrics.duplicateTriggers === duplicatesBefore) latency.push(decision.decided_in_ms ?? 0);
  }

  if (generated || pack.simulator) seedSimulatedOutcomes(pack, store.allDecisions());
  engine.refreshIndexes();
  const endAt = generated
    ? new Date(Date.parse(pack.triggers.at(-1).received_at) + 8 * 24 * 60 * 60_000).toISOString()
    : pack.judgment_at;
  if (endAt) engine.judgeOutcomes(endAt);

  const decisions = store.allDecisions();
  const outcomes = store.allOutcomes();
  const impact = buildImpactReport(decisions, outcomes, {
    synthetic: generated || Boolean(pack.simulator)
  });
  writeFileSync(join(output, "decisions.jsonl"), jsonl(decisions), "utf8");
  writeFileSync(join(output, "actions.jsonl"), jsonl(readJsonl(join(output, "actions.jsonl"))), "utf8");
  writeFileSync(join(output, "outcomes.jsonl"), jsonl(outcomes), "utf8");
  writeJson(join(output, "latency_report.json"), {
    decisions: decisions.length,
    unique_trigger_latencies: latency.length,
    trigger_attempts: sequence.length - sequence.filter((item) => item.type === "rule_correction").length,
    max_ms: latency.length ? Math.max(...latency) : 0,
    p95_ms: latency.sort((a, b) => a - b)[Math.floor((latency.length - 1) * 0.95)] ?? 0,
    budget_ms: 60_000,
    within_budget: latency.every((value) => value < 60_000),
    counters: engine.metrics,
    elapsed_ms: Math.round(performance.now() - started)
  });
  writeJson(join(output, "impact_report.json"), impact);
  writeFileSync(join(output, "impact_report.md"), markdownImpact(impact), "utf8");
  writeFileSync(join(output, "final_report.md"), `# Replay summary

- Viewers in replay: ${viewerCount}
- Decisions: ${decisions.length}
- Simulated interventions: ${readJsonl(join(output, "actions.jsonl")).length}
- Goal outcomes: ${outcomes.length}
- Duplicate triggers suppressed: ${engine.metrics.duplicateTriggers}
- Stale offline triggers abstained: ${engine.metrics.staleTriggers}
- Mock dependency failures: ${engine.metrics.providerFailures}
- All measured decision latencies under 60 seconds: ${latency.every((value) => value < 60_000)}

See [impact_report.md](./impact_report.md) for the randomized holdout comparison.

${generated
    ? "This replay uses generated synthetic fixtures and simulated outcomes."
    : "This replay uses an operator-supplied normalized JSON pack. No outcome simulator runs unless explicitly configured in the pack."}
Action delivery is simulated; this command does not send real messages or publish to an OTT application.
`, "utf8");
  console.log(`Replay complete: ${decisions.length} decisions, ${outcomes.length} outcomes, output=${output}`);
}

function readJsonl(path) {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  await replay(options.out, options.pack);
} catch (error) {
  console.error(`Replay failed: ${error.message}`);
  process.exitCode = 1;
}
