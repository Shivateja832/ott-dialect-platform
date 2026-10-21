import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { appendFile, rename, writeFile } from "node:fs/promises";

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
    this.decisions = readJsonl(join(root, "decisions.jsonl"));
    for (const row of this.decisions) {
      if (row.trigger?.id && row.viewer_id) {
        this.triggerIds.add(this.triggerKey(row.viewer_id, row.trigger.id));
      }
    }
    this.actions = readJsonl(join(root, "actions.jsonl"));
    this.outcomes = readJsonl(join(root, "outcomes.jsonl"));
    this.viewerStates = new Map();
    this.logTails = new Map();
  }

  statePath(viewerId) {
    const safeId = Buffer.from(String(viewerId), "utf8").toString("hex");
    return join(this.stateDir, `${safeId}.json`);
  }

  getViewerState(viewerId) {
    const cached = this.viewerStates.get(viewerId);
    if (cached) return structuredClone(cached);
    const path = this.statePath(viewerId);
    if (existsSync(path)) {
      const state = JSON.parse(readFileSync(path, "utf8"));
      this.viewerStates.set(viewerId, state);
      return structuredClone(state);
    }
    const state = {
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
    this.viewerStates.set(viewerId, state);
    return structuredClone(state);
  }

  async saveViewerState(viewerId, state) {
    const path = this.statePath(viewerId);
    const tempPath = `${path}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
    this.viewerStates.set(viewerId, state);
  }

  triggerKey(viewerId, triggerId) {
    return `${viewerId}\0${triggerId}`;
  }

  hasTrigger(viewerId, triggerId) {
    return this.triggerIds.has(this.triggerKey(viewerId, triggerId));
  }

  append(file, value) {
    const path = join(this.root, file);
    const previous = this.logTails.get(file) ?? Promise.resolve();
    const pending = previous.then(() => appendFile(path, `${JSON.stringify(value)}\n`, "utf8"));
    this.logTails.set(file, pending);
    return pending;
  }

  async appendDecision(value) {
    await this.append("decisions.jsonl", value);
    if (value.trigger?.id && value.viewer_id) {
      this.triggerIds.add(this.triggerKey(value.viewer_id, value.trigger.id));
    }
    this.decisions.push(value);
  }

  async appendAction(value) {
    await this.append("actions.jsonl", value);
    this.actions.push(value);
  }

  async appendOutcome(value) {
    await this.append("outcomes.jsonl", value);
    this.outcomes.push(value);
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
    return this.outcomes;
  }

  allActions() {
    return this.actions;
  }
}
