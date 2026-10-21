import { mkdirSync, readFileSync, appendFileSync, writeFileSync, renameSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export class FileStore {
  constructor(root) {
    this.root = root;
    this.stateDir = join(root, "viewer_state");
    mkdirSync(this.stateDir, { recursive: true });
    for (const name of ["decisions.jsonl", "actions.jsonl", "outcomes.jsonl"]) {
      const path = join(root, name);
      if (!existsSync(path)) writeFileSync(path, "", "utf8");
    }
    this.triggerIds = new Set();
    for (const row of readJsonl(join(root, "decisions.jsonl"))) {
      if (row.trigger?.id && row.viewer_id) {
        this.triggerIds.add(this.triggerKey(row.viewer_id, row.trigger.id));
      }
    }
    this.decisions = readJsonl(join(root, "decisions.jsonl"));
  }

  statePath(viewerId) {
    const safeId = Buffer.from(String(viewerId), "utf8").toString("hex");
    return join(this.stateDir, `${safeId}.json`);
  }

  getViewerState(viewerId) {
    const path = this.statePath(viewerId);
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
    return {
      viewer_id: viewerId,
      experimentGroup: null,
      activeGoal: null,
      last_action_at: null,
      processed_trigger_ids: [],
      decision_ids: [],
      actions: [],
      outcomes: [],
      lessons: [],
      fact_snapshot: [],
      dialect_conflicts: []
    };
  }

  saveViewerState(viewerId, state) {
    const path = this.statePath(viewerId);
    const tempPath = `${path}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
  }

  triggerKey(viewerId, triggerId) {
    return `${viewerId}\0${triggerId}`;
  }

  hasTrigger(viewerId, triggerId) {
    return this.triggerIds.has(this.triggerKey(viewerId, triggerId));
  }

  append(file, value) {
    appendFileSync(join(this.root, file), `${JSON.stringify(value)}\n`, "utf8");
  }

  appendDecision(value) {
    this.append("decisions.jsonl", value);
    if (value.trigger?.id && value.viewer_id) {
      this.triggerIds.add(this.triggerKey(value.viewer_id, value.trigger.id));
    }
    this.decisions.push(value);
  }

  appendAction(value) {
    this.append("actions.jsonl", value);
  }

  appendOutcome(value) {
    this.append("outcomes.jsonl", value);
  }

  getDecision(id) {
    return this.decisions.find((row) => row.decision_id === id) ?? null;
  }

  listViewerIds() {
    return readdirSync(this.stateDir).filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(this.stateDir, name), "utf8")).viewer_id);
  }

  allDecisions() {
    return this.decisions;
  }

  allOutcomes() {
    return readJsonl(join(this.root, "outcomes.jsonl"));
  }

  allActions() {
    return readJsonl(join(this.root, "actions.jsonl"));
  }
}
