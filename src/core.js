import { createHash } from "node:crypto";
import { isMessageChannel, selectMessageAction, verifyMessageAction } from "./interventions.js";

export const CURRENT_GOAL_RULES = {
  first_full_episode_3d: {
    id: "first_full_episode_3d",
    version: 2,
    evidence: "episode_completed",
    windowHours: 72,
    condition: { minimum_duration_seconds: 1200 },
    eligibility: {
      requiresSignup: true,
      excludeEvents: [{
        type: "episode_completed",
        afterSignup: true,
        condition: { duration_seconds: { gte: 1200 } }
      }]
    },
    priority: 1,
    description: "Complete a first full episode within 3 days of sign-up."
  },
  first_paid_plan_7d: {
    id: "first_paid_plan_7d",
    version: 1,
    evidence: "purchase",
    windowHours: 168,
    eligibility: {
      requiresSignup: true,
      excludeEventTypes: ["purchase"],
      profileNotEquals: { subscription_status: "paid" }
    },
    priority: 2,
    description: "Start a first paid plan within 7 days of sign-up."
  }
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DECISION_MS = 60_000;
const DEPENDENCY_TIMEOUT_MS = 5_000;
function isoMs(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function digest(input) {
  return createHash("sha256").update(String(input)).digest();
}

function validateTrigger(trigger) {
  if (!trigger || typeof trigger !== "object") throw new Error("Trigger must be an object.");
  for (const field of ["id", "viewer_id"]) {
    if (typeof trigger[field] !== "string" || !trigger[field].trim()) {
      throw new Error(`Trigger ${field} must be a non-empty string.`);
    }
  }
  if (trigger.type !== "app_open") throw new Error(`Unsupported trigger type: ${trigger.type}`);
  for (const field of ["occurred_at", "received_at"]) {
    if (isoMs(trigger[field]) === null) throw new Error(`Trigger ${field} must be a valid ISO timestamp.`);
  }
}

function validateRuleSet(rules) {
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) {
    throw new Error("Goal rules must be provided as an object.");
  }
  for (const [id, rule] of Object.entries(rules)) {
    const signal = rule?.evidence ?? rule?.success_signal;
    if (rule?.id !== id || typeof signal !== "string" || !signal.trim()) {
      throw new Error(`Goal ${id} must have a matching id and a non-empty event success signal.`);
    }
    if (!Number.isInteger(rule.version) || rule.version < 1 ||
        !Number.isFinite(rule.windowHours) || rule.windowHours <= 0 || rule.windowHours > 720 ||
        !Number.isFinite(rule.priority)) {
      throw new Error(`Goal ${id} has invalid version, window, or priority settings.`);
    }
    if (rule.enabled !== undefined && typeof rule.enabled !== "boolean") {
      throw new Error(`Goal ${id} enabled must be a boolean.`);
    }
    if (rule.signal_available !== undefined && typeof rule.signal_available !== "boolean") {
      throw new Error(`Goal ${id} signal_available must be a boolean.`);
    }
    if (rule.condition !== undefined &&
        (!rule.condition || typeof rule.condition !== "object" || Array.isArray(rule.condition))) {
      throw new Error(`Goal ${id} condition must be an object.`);
    }
    validateCondition(rule.condition, `Goal ${id} condition`);
    const eligibility = rule.eligibility ?? {};
    if (!eligibility || typeof eligibility !== "object" || Array.isArray(eligibility)) {
      throw new Error(`Goal ${id} eligibility must be an object.`);
    }
    for (const key of ["requireEventTypes", "excludeEventTypes", "excludeEvents"]) {
      if (eligibility[key] !== undefined && !Array.isArray(eligibility[key])) {
        throw new Error(`Goal ${id} eligibility.${key} must be an array.`);
      }
    }
    if (eligibility.requiresSignup !== undefined && typeof eligibility.requiresSignup !== "boolean") {
      throw new Error(`Goal ${id} eligibility.requiresSignup must be a boolean.`);
    }
    for (const key of ["requireEventTypes", "excludeEventTypes"]) {
      if ((eligibility[key] ?? []).some((type) => typeof type !== "string" || !type.trim())) {
        throw new Error(`Goal ${id} eligibility.${key} must contain non-empty event type names.`);
      }
    }
    if ((eligibility.excludeEvents ?? []).some((item) =>
      !item || typeof item.type !== "string" || !item.type.trim() ||
      (item.afterSignup !== undefined && typeof item.afterSignup !== "boolean"))) {
      throw new Error(`Goal ${id} eligibility.excludeEvents entries need a type and optional afterSignup boolean.`);
    }
    for (const item of eligibility.excludeEvents ?? []) {
      validateCondition(item.condition, `Goal ${id} excluded-event condition`);
    }
    for (const key of ["profileEquals", "profileNotEquals"]) {
      if (eligibility[key] !== undefined &&
          (!eligibility[key] || typeof eligibility[key] !== "object" || Array.isArray(eligibility[key]))) {
        throw new Error(`Goal ${id} eligibility.${key} must be an object.`);
      }
    }
  }
}

function validateCondition(condition, label) {
  if (condition === undefined) return;
  const supportedOperators = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "in"]);
  for (const [field, expected] of Object.entries(condition)) {
    if (field === "minimum_duration_seconds" &&
        (!Number.isFinite(expected) || expected < 1 || expected > 86_400)) {
      throw new Error(`${label}.${field} must be from 1 through 86400.`);
    }
    if (expected && typeof expected === "object") {
      if (Array.isArray(expected) || Object.keys(expected).length === 0 ||
          Object.keys(expected).some((operator) => !supportedOperators.has(operator))) {
        throw new Error(`${label}.${field} uses an unsupported condition operator.`);
      }
      for (const [operator, value] of Object.entries(expected)) {
        if (["gt", "gte", "lt", "lte"].includes(operator) &&
            (typeof value !== "number" || !Number.isFinite(value))) {
          throw new Error(`${label}.${field}.${operator} must be a finite number.`);
        }
        if (operator === "in" && (!Array.isArray(value) || value.length === 0)) {
          throw new Error(`${label}.${field}.in must be a non-empty array.`);
        }
      }
    } else if (!["string", "number", "boolean"].includes(typeof expected) && expected !== null) {
      throw new Error(`${label}.${field} must be a scalar or supported comparison object.`);
    }
  }
}

function validateCallBudget(callBudget) {
  const budget = {
    modelCalls: callBudget.modelCalls ?? 8,
    toolCalls: callBudget.toolCalls ?? 20
  };
  if (!Number.isInteger(budget.modelCalls) || budget.modelCalls < 0 || budget.modelCalls > 8 ||
      !Number.isInteger(budget.toolCalls) || budget.toolCalls < 0 || budget.toolCalls > 20) {
    throw new Error("Call budget must allow 0-8 model calls and 0-20 tool calls per decision.");
  }
  return budget;
}

function validateDependencyTimeout(value) {
  if (!Number.isInteger(value) || value < 1 || value > 5_000) {
    throw new Error("dependencyTimeoutMs must be an integer from 1 to 5000.");
  }
  return value;
}

async function callWithTimeout(operation, context, timeoutMs = DEPENDENCY_TIMEOUT_MS) {
  const controller = new AbortController();
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation({ ...context, signal: controller.signal })),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("dependency_timeout"));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export function experimentGroup(viewerId) {
  return digest(`ott-dialect-holdout-v1:${viewerId}`).readUInt32BE(0) % 100 < 80
    ? "treatment"
    : "holdout";
}

function timeOf(event) {
  const receivedAt = isoMs(event.received_at);
  const occurredAt = isoMs(event.occurred_at);
  if (occurredAt !== null && receivedAt !== null && occurredAt > receivedAt) return receivedAt;
  return occurredAt ?? receivedAt ?? 0;
}

function latestByTime(events) {
  return [...events].sort((a, b) => timeOf(a) - timeOf(b));
}

function indexBy(rows, key) {
  const index = new Map();
  for (const row of rows ?? []) {
    const value = row?.[key];
    if (typeof value !== "string") continue;
    const group = index.get(value) ?? [];
    group.push(row);
    index.set(value, group);
  }
  return index;
}

function latestProfile(rows, viewerId, at) {
  return rows
    .filter((row) => row.viewer_id === viewerId &&
      isoMs(row.updated_at) !== null &&
      isoMs(row.updated_at) <= at)
    .sort((a, b) =>
      (isoMs(b.updated_at) - isoMs(a.updated_at)) ||
      ((Number(b.version) || 0) - (Number(a.version) || 0)) ||
      String(b.snapshot_id ?? "").localeCompare(String(a.snapshot_id ?? ""))
    )[0] ?? null;
}

function ageLabel(observedAt, decisionAt) {
  const ageMs = Math.max(0, decisionAt - (isoMs(observedAt) ?? decisionAt));
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s`;
  if (ageMs < DAY_MS) return `${Math.floor(ageMs / 60_000)}m`;
  return `${Math.floor(ageMs / DAY_MS)}d`;
}

function resolveFacts({ viewerId, trigger, events, profiles, appSettings, campaignLinks, consents = [] }) {
  const receivedAt = isoMs(trigger.received_at) ?? Date.now();
  const viewerEvents = latestByTime(events.filter((event) => event.viewer_id === viewerId &&
    (isoMs(event.received_at) ?? timeOf(event)) <= receivedAt));
  const profile = latestProfile(profiles, viewerId, receivedAt);
  const signup = viewerEvents.find((event) => event.type === "signup") ?? null;
  const purchase = viewerEvents.find((event) => event.type === "purchase") ?? null;
  const paid = Boolean(purchase || profile?.subscription_status === "paid");

  const setting = appSettings.filter((item) =>
    item.viewer_id === viewerId &&
    item.event_id === trigger.id &&
    (isoMs(item.received_at) ?? Infinity) <= receivedAt
  ).sort((a, b) =>
    (isoMs(b.received_at) ?? 0) - (isoMs(a.received_at) ?? 0)
  )[0] ??
    appSettings.filter((item) => item.viewer_id === viewerId &&
      (isoMs(item.received_at) ?? Infinity) <= receivedAt)
      .sort((a, b) => (isoMs(b.received_at) ?? 0) - (isoMs(a.received_at) ?? 0))[0] ?? null;
  const campaign = campaignLinks.filter((item) => item.viewer_id === viewerId &&
    (isoMs(item.arrived_at) ?? Infinity) <= receivedAt)
    .sort((a, b) => (isoMs(b.arrived_at) ?? 0) - (isoMs(a.arrived_at) ?? 0))[0] ?? null;
  const dialect = setting?.dialect ?? campaign?.dialect ?? profile?.preferred_dialect ?? null;
  const dialectSource = setting ? "app_setting" : campaign ? "campaign_link" : profile ? "profile" : "unknown";
  const language = setting?.language ?? profile?.preferred_language ?? null;
  const timeZone = setting?.time_zone ?? profile?.time_zone ?? null;
  const consentRows = consents.filter((item) =>
    item.viewer_id === viewerId &&
    (isoMs(item.received_at) ?? Infinity) <= receivedAt
  ).sort((a, b) =>
    ((isoMs(a.received_at) ?? 0) - (isoMs(b.received_at) ?? 0)) ||
    String(a.id ?? "").localeCompare(String(b.id ?? ""))
  );
  const resolvedConsents = {};
  const latestConsentRows = new Map();
  for (const consent of consentRows) {
    if (typeof consent.channel === "string" && typeof consent.granted === "boolean") {
      const channel = consent.channel.toUpperCase();
      const timestamp = isoMs(consent.received_at) ?? 0;
      const previous = latestConsentRows.get(channel);
      if (!previous || timestamp > previous.timestamp) {
        latestConsentRows.set(channel, { timestamp, consent, conflicted: false });
      } else if (timestamp === previous.timestamp && consent.granted !== previous.consent.granted) {
        previous.conflicted = true;
      }
    }
  }
  for (const [channel, latest] of latestConsentRows) {
    resolvedConsents[channel] = latest.conflicted ? false : latest.consent.granted;
  }
  const candidates = [
    ["app_setting", setting?.dialect],
    ["profile", profile?.preferred_dialect],
    ["campaign_link", campaign?.dialect]
  ].filter(([, value]) => value);
  const conflicts = candidates.filter(([, value]) => value !== dialect)
    .map(([source, value]) => `${source}:${value}`);

  const factRecords = [];
  if (signup) factRecords.push({
    key: "signup",
    value: signup.occurred_at,
    source: `event:${signup.id}`,
    observed_at: signup.received_at,
    freshness: ageLabel(signup.received_at, receivedAt)
  });
  if (profile) factRecords.push({
    key: "subscription_status",
    value: profile.subscription_status,
    source: `profile:${profile.snapshot_id}`,
    observed_at: profile.updated_at,
    freshness: `warehouse snapshot; observed ${ageLabel(profile.updated_at, receivedAt)} ago`
  });
  if (profile?.preferred_dialect) factRecords.push({
    key: "dialect_profile",
    value: profile.preferred_dialect,
    source: `profile:${profile.snapshot_id}`,
    observed_at: profile.updated_at,
    freshness: `warehouse snapshot; observed ${ageLabel(profile.updated_at, receivedAt)} ago`
  });
  if (campaign) factRecords.push({
    key: "dialect_campaign",
    value: campaign.dialect,
    source: `campaign_link:${campaign.id ?? viewerId}`,
    observed_at: campaign.arrived_at,
    freshness: `campaign link; observed ${ageLabel(campaign.arrived_at, receivedAt)} ago`
  });
  if (purchase) factRecords.push({
    key: "paid",
    value: true,
    source: `event:${purchase.id}`,
    observed_at: purchase.received_at,
    freshness: "event stream"
  });
  if (profile || purchase) factRecords.push({
    key: "effective_paid",
    value: paid,
    source: purchase ? `event:${purchase.id}` : `profile:${profile.snapshot_id}`,
    observed_at: purchase?.received_at ?? profile.updated_at,
    freshness: purchase ? "event stream" : `warehouse snapshot; observed ${ageLabel(profile.updated_at, receivedAt)} ago`
  });
  if (setting) factRecords.push({
    key: "dialect",
    value: dialect,
    source: `app_setting:${setting.event_id}`,
    observed_at: setting.received_at,
    freshness: "current trigger"
  });
  if (setting?.language || profile?.preferred_language) factRecords.push({
    key: "language",
    value: language,
    source: setting?.language ? `app_setting:${setting.event_id}` : `profile:${profile.snapshot_id}`,
    observed_at: setting?.received_at ?? profile.updated_at,
    freshness: setting?.language ? "current trigger" : `warehouse snapshot; observed ${ageLabel(profile.updated_at, receivedAt)} ago`
  });
  if (timeZone) factRecords.push({
    key: "time_zone",
    value: timeZone,
    source: setting?.time_zone ? `app_setting:${setting.event_id}` : `profile:${profile.snapshot_id}`,
    observed_at: setting?.time_zone ? setting.received_at : profile.updated_at,
    freshness: setting?.time_zone ? "current trigger" : `warehouse snapshot; observed ${ageLabel(profile.updated_at, receivedAt)} ago`
  });
  for (const [channel, latest] of latestConsentRows) factRecords.push({
    key: `consent_${channel.toLowerCase()}`,
    value: latest.conflicted ? false : latest.consent.granted,
    source: `consent:${latest.consent.id}`,
    observed_at: latest.consent.received_at,
    freshness: latest.conflicted
      ? "conflicting latest consent records; treated as denied"
      : "latest explicit consent state received by decision time"
  });

  return {
    events: viewerEvents,
    profile,
    signupAt: signup ? timeOf(signup) : null,
    paid,
    dialect,
    dialectSource,
    language,
    timeZone,
    consents: resolvedConsents,
    conflicts,
    facts: factRecords
  };
}

function matchesCondition(event, condition = {}) {
  for (const [key, expected] of Object.entries(condition)) {
    const field = key === "minimum_duration_seconds" ? "duration_seconds" : key;
    const actual = event[field];
    if (key === "minimum_duration_seconds") {
      if (!Number.isFinite(actual) || actual < expected) return false;
      continue;
    }
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      for (const [operator, value] of Object.entries(expected)) {
        if (operator === "eq" && actual !== value) return false;
        if (operator === "neq" && actual === value) return false;
        if (operator === "gt" && !(actual > value)) return false;
        if (operator === "gte" && !(actual >= value)) return false;
        if (operator === "lt" && !(actual < value)) return false;
        if (operator === "lte" && !(actual <= value)) return false;
        if (operator === "in" && (!Array.isArray(value) || !value.includes(actual))) return false;
      }
    } else if (actual !== expected) return false;
  }
  return true;
}

function ruleSignal(rule) {
  return rule?.evidence ?? rule?.success_signal;
}

function signalQualifies(rule, event) {
  return event.type === ruleSignal(rule) && matchesCondition(event, rule.condition);
}

function goalEligibility(rule, facts, now) {
  if (!rule || rule.enabled === false || rule.signal_available === false) return false;
  const eligibility = rule.eligibility ?? {};
  if (eligibility.requiresSignup !== false && !facts.signupAt) return false;
  const start = facts.signupAt ?? now;
  if (now < start || now > start + rule.windowHours * 60 * 60 * 1000) return false;
  if (facts.events.some((event) =>
    signalQualifies(rule, event) &&
    timeOf(event) >= start &&
    timeOf(event) <= now
  )) return false;
  if ((eligibility.requireEventTypes ?? []).some((type) =>
    !facts.events.some((event) => event.type === type && timeOf(event) <= now))) return false;
  if ((eligibility.excludeEventTypes ?? []).some((type) =>
    facts.events.some((event) => event.type === type && timeOf(event) <= now))) return false;
  if (Object.entries(eligibility.profileEquals ?? {}).some(([key, value]) =>
    facts.profile?.[key] !== value)) return false;
  if (Object.entries(eligibility.profileNotEquals ?? {}).some(([key, value]) =>
    facts.profile?.[key] === value)) return false;
  if ((eligibility.excludeEvents ?? []).some((excluded) =>
    facts.events.some((event) =>
      event.type === excluded.type &&
      (!excluded.afterSignup || timeOf(event) >= start) &&
      timeOf(event) <= now &&
      matchesCondition(event, excluded.condition)
    ))) return false;
  return true;
}

function chooseGoal(facts, rules, now) {
  return Object.values(rules)
    .filter((rule) => goalEligibility(rule, facts, now))
    .sort((a, b) => a.priority - b.priority)[0] ?? null;
}

function titleWorkKey(title) {
  return title.canonical_title_id ?? title.work_id ?? title.id;
}

function titleRowsWorkKeys(titles) {
  return titles.map(titleWorkKey);
}

function matchingTitles(catalogue, dialect, language, now) {
  if (!dialect || !language) return [];
  const matches = catalogue.filter((title) =>
    typeof title.id === "string" &&
    Array.isArray(title.dialects) &&
    title.dialects.includes(dialect) &&
    title.language === language &&
    (isoMs(title.available_from) ?? Infinity) <= now &&
    (isoMs(title.available_until) ?? -Infinity) >= now &&
    title.prompt_injection !== true
  ).sort((a, b) => a.id.localeCompare(b.id));
  return [...new Map(matches.map((title) => [
    titleWorkKey(title),
    title
  ])).values()].slice(0, 5);
}

function activeSuccessEvent(goal, facts, since, deadline, observedAt = deadline) {
  if (!goal) return null;
  return facts.events.find((event) =>
    signalQualifies({
      ...goal,
      evidence: goal.success_signal ?? goal.evidence
    }, event) &&
    timeOf(event) >= since &&
    timeOf(event) <= deadline &&
    timeOf(event) <= observedAt
  ) ?? null;
}

function validateAction({
  action,
  templateId,
  goal,
  facts,
  titles,
  catalogue,
  interventionCatalogue,
  rules,
  state,
  now,
  trigger,
  decisionElapsedMs
}) {
  const passed = [];
  const failed = [];
  const recent = trigger?.event_age_s <= 5 * 60;
  if (recent) passed.push("trigger_freshness");
  else failed.push("trigger_freshness");

  const rule = goal && rules[goal.id];
  let eligible = Boolean(goal && rule &&
    goal.rule_version === rule.version &&
    now <= Date.parse(goal.deadline) &&
    goalEligibility(rule, facts, now));
  if (eligible) passed.push("goal_eligibility");
  else failed.push("goal_eligibility");

  if (facts.dialect) passed.push("dialect_resolved");
  else failed.push("dialect_resolved");
  if (facts.language) passed.push("language_resolved");
  else failed.push("language_resolved");

  if (action === "HOME_PAGE" || action === "HERO_SLOT") {
    const selectedTitles = action === "HERO_SLOT" ? titles.slice(0, 1) : titles;
    const selected = selectedTitles.map((item) => item.id);
    if (action === "HOME_PAGE") {
      const distinctWorks = new Set(titleRowsWorkKeys(selectedTitles));
      if (new Set(selected).size >= 3 && distinctWorks.size >= 3) passed.push("minimum_three_titles");
      else failed.push("minimum_three_titles");
    } else if (selected.length === 1) passed.push("hero_title_selected");
    else failed.push("hero_title_selected");
    const titleRows = selected.map((id) => catalogue.find((item) => item.id === id));
    const allTitlesValid = titleRows.length === selected.length &&
      titleRows.every((title) =>
        title &&
        title.dialects?.includes(facts.dialect) &&
        title.language === facts.language &&
        (isoMs(title.available_from) ?? Infinity) <= now &&
        (isoMs(title.available_until) ?? -Infinity) >= now &&
        title.prompt_injection !== true
      );
    if (allTitlesValid && (action === "HERO_SLOT" || titleRows.length >= 3)) {
      passed.push("dialect_language_availability");
    }
    else failed.push("dialect_language_availability");

    if (state.last_action_at && now - Date.parse(state.last_action_at) < DAY_MS) {
      failed.push("frequency_cap");
    } else passed.push("frequency_cap");
  } else if (isMessageChannel(action)) {
    const verification = verifyMessageAction({
      action: { action, template_id: templateId },
      facts,
      state,
      now,
      interventionCatalogue
    });
    passed.push(...verification.passed);
    failed.push(...verification.failed);
  }
  if (decisionElapsedMs <= MAX_DECISION_MS) passed.push("decision_latency");
  else failed.push("decision_latency");
  return { passed, failed };
}

export class AgentEngine {
  constructor({ pack, store, provider = null, callBudget = {}, dependencyTimeoutMs = DEPENDENCY_TIMEOUT_MS }) {
    this.pack = pack;
    this.store = store;
    this.provider = provider;
    this.refreshIndexes();
    this.callBudget = validateCallBudget(callBudget);
    this.dependencyTimeoutMs = validateDependencyTimeout(dependencyTimeoutMs);
    this.rules = structuredClone(pack.goalRules ?? CURRENT_GOAL_RULES);
    validateRuleSet(this.rules);
    this.ruleVersion = 1;
    this.decisions = [];
    this.metrics = {
      duplicateTriggers: 0,
      staleTriggers: 0,
      providerFailures: 0,
      modelCalls: 0,
      toolCalls: 0,
      callBudgetViolations: 0
    };
    this.inFlight = new Map();
    this.viewerTails = new Map();
  }

  refreshIndexes() {
    this.eventsByViewer = indexBy(this.pack.events, "viewer_id");
    this.profilesByViewer = indexBy(this.pack.profiles, "viewer_id");
    this.appSettingsByViewer = indexBy(this.pack.appSettings, "viewer_id");
    this.campaignLinksByViewer = indexBy(this.pack.campaignLinks, "viewer_id");
    this.consentsByViewer = indexBy(this.pack.consents, "viewer_id");
    this.titlesByDialectLanguage = new Map();
    for (const title of this.pack.catalogue ?? []) {
      if (typeof title.language !== "string" || !Array.isArray(title.dialects)) continue;
      for (const dialect of title.dialects) {
        const key = `${dialect}\0${title.language}`;
        const titles = this.titlesByDialectLanguage.get(key) ?? [];
        titles.push(title);
        this.titlesByDialectLanguage.set(key, titles);
      }
    }
  }

  processTrigger(trigger) {
    validateTrigger(trigger);
    const key = `${trigger.viewer_id}\0${trigger.id}`;
    const duplicate = this.inFlight.get(key);
    if (duplicate) return duplicate;
    const previous = this.viewerTails.get(trigger.viewer_id) ?? Promise.resolve();
    let execution;
    execution = previous.catch(() => undefined)
      .then(() => this.processTriggerOnce(trigger))
      .finally(() => {
        if (this.inFlight.get(key) === execution) this.inFlight.delete(key);
        if (this.viewerTails.get(trigger.viewer_id) === execution) {
          this.viewerTails.delete(trigger.viewer_id);
        }
      });
    this.inFlight.set(key, execution);
    this.viewerTails.set(trigger.viewer_id, execution);
    return execution;
  }

  async processTriggerOnce(trigger) {
    const started = performance.now();
    const usage = { model_calls: 0, tool_calls: 0 };
    const receivedMs = isoMs(trigger.received_at) ?? Date.now();
    const occurredMs = isoMs(trigger.occurred_at) ?? receivedMs;
    const eventAgeS = Math.max(0, Math.floor((receivedMs - occurredMs) / 1000));
    const deviceClockSkewS = Math.max(0, Math.floor((occurredMs - receivedMs) / 1000));
    const decisionId = `D-${digest(`${trigger.viewer_id}:${trigger.id}`).toString("hex").slice(0, 12)}`;

    if (this.store.hasTrigger(trigger.viewer_id, trigger.id)) {
      this.metrics.duplicateTriggers++;
      return this.store.getDecision(decisionId) ?? {
        decision_id: decisionId, viewer_id: trigger.viewer_id, action: "NO_ACTION",
        reason: "duplicate_trigger_suppressed", status: "SUPPRESSED"
      };
    }
    const state = this.store.getViewerState(trigger.viewer_id);
    state.experimentGroup ??= experimentGroup(trigger.viewer_id);
    if (state.activeGoal) {
      const eligibilityStartedAt = isoMs(state.activeGoal.eligibility_started_at) ??
        isoMs(state.activeGoal.startedAt);
      if (eligibilityStartedAt !== null) {
        state.activeGoal.eligibility_started_at = new Date(eligibilityStartedAt).toISOString();
      }
      const correctedRule = this.rules[state.activeGoal.id];
      if (correctedRule && correctedRule.version !== state.activeGoal.rule_version) {
        state.activeGoal.rule_version = correctedRule.version;
        state.activeGoal.success_signal = ruleSignal(correctedRule);
        state.activeGoal.condition = structuredClone(correctedRule.condition ?? {});
        state.activeGoal.deadline = new Date(
          (eligibilityStartedAt ?? Date.parse(state.activeGoal.startedAt)) + correctedRule.windowHours * 60 * 60 * 1000
        ).toISOString();
      }
    }
    const triggerInfo = {
      event: trigger.type,
      received_at: trigger.received_at,
      event_age_s: eventAgeS,
      device_clock_skew_s: deviceClockSkewS
    };
    const now = receivedMs;
    const evidence = [];
    const assumptions = [];
    let checks = { passed: [], failed: [] };
    let facts;
    let goal = state.activeGoal;
    let action = "NO_ACTION";
    let reason = null;
    let titles = [];
    let messageAction = null;
    let status = "RECORDED";

    const elapsedMs = eventAgeS * 1000;
    if (elapsedMs > 5 * 60_000) {
      reason = "stale_offline_trigger";
      checks.failed.push("trigger_freshness");
      this.metrics.staleTriggers++;
    } else if (state.last_trigger_at && now < Date.parse(state.last_trigger_at)) {
      reason = "out_of_order_trigger";
      checks.failed.push("trigger_order");
    } else {
      try {
        if (this.provider?.beforeDecision) {
          if (usage.tool_calls >= this.callBudget.toolCalls) {
            this.metrics.callBudgetViolations++;
            throw new Error("tool_call_budget_exceeded");
          }
          usage.tool_calls++;
          this.metrics.toolCalls++;
          await callWithTimeout(this.provider.beforeDecision.bind(this.provider), {
            trigger,
            viewerId: trigger.viewer_id
          }, this.dependencyTimeoutMs);
        }
      } catch (error) {
        this.metrics.providerFailures++;
        reason = `dependency_unavailable:${error.message}`;
        checks.failed.push("dependency_availability");
      }
      facts = resolveFacts({
        viewerId: trigger.viewer_id,
        trigger,
        events: this.eventsByViewer.get(trigger.viewer_id) ?? [],
        profiles: this.profilesByViewer.get(trigger.viewer_id) ?? [],
        appSettings: this.appSettingsByViewer.get(trigger.viewer_id) ?? [],
        campaignLinks: this.campaignLinksByViewer.get(trigger.viewer_id) ?? [],
        consents: this.consentsByViewer.get(trigger.viewer_id) ?? []
      });
      evidence.push(...facts.facts.map((fact) => ({
        reference: fact.source,
        fact: fact.key,
        value: fact.value,
        observed_at: fact.observed_at,
        freshness: fact.freshness
      })));
      if (facts.conflicts.length) assumptions.push(
        `Dialect conflicts ${facts.conflicts.join(", ")}; current app setting wins because it is supplied with this trigger.`
      );
      if (deviceClockSkewS > 300) assumptions.push(
        `Device event time is ${deviceClockSkewS}s ahead of server receipt; receipt time is used as the trusted upper bound.`
      );
      if (!facts.signupAt) assumptions.push("No signup event is available; no goal eligibility is inferred from model output or missing profile data.");

      const dependencyFailed = reason?.startsWith("dependency_unavailable:") ?? false;
      if (!reason || dependencyFailed) {
        if (goal && activeSuccessEvent(goal, facts, Date.parse(state.activeGoal.startedAt), Date.parse(state.activeGoal.deadline))) {
          const event = activeSuccessEvent(goal, facts, Date.parse(state.activeGoal.startedAt), Date.parse(state.activeGoal.deadline));
          const outcome = {
            outcome_id: `O-${digest(`${trigger.viewer_id}:${event.id}`).toString("hex").slice(0, 12)}`,
            viewer_id: trigger.viewer_id,
            goal_id: goal.id,
            status: "SUCCEEDED",
            signal: `event:${event.id}`,
            judged_at: trigger.received_at
          };
          await this.store.appendOutcome(outcome);
          state.outcomes = [...(state.outcomes ?? []), outcome].slice(-100);
          state.lessons = [...(state.lessons ?? []), `${goal.id} succeeded from ${outcome.signal}.`].slice(-50);
          state.activeGoal = null;
          goal = null;
        } else if (goal && now > Date.parse(goal.deadline)) {
          const outcome = {
            outcome_id: `O-${digest(`${trigger.viewer_id}:${goal.id}:deadline`).toString("hex").slice(0, 12)}`,
            viewer_id: trigger.viewer_id,
            goal_id: goal.id,
            status: "FAILED",
            reason: "deadline_passed_without_attributable_signal",
            judged_at: trigger.received_at
          };
          await this.store.appendOutcome(outcome);
          state.outcomes = [...(state.outcomes ?? []), outcome].slice(-100);
          state.lessons = [...(state.lessons ?? []), `${goal.id} failed because its deadline passed without an attributable signal.`].slice(-50);
          state.activeGoal = null;
          goal = null;
        } else if (goal && !goalEligibility(this.rules[goal.id], facts, now)) {
          const outcome = {
            outcome_id: `O-${digest(`${trigger.viewer_id}:${goal.id}:rule-change:${this.ruleVersion}`).toString("hex").slice(0, 12)}`,
            viewer_id: trigger.viewer_id,
            goal_id: goal.id,
            status: "INCONCLUSIVE",
            reason: "current_evidence_no_longer_meets_goal_rule",
            judged_at: trigger.received_at
          };
          await this.store.appendOutcome(outcome);
          state.outcomes = [...(state.outcomes ?? []), outcome].slice(-100);
          state.lessons = [...(state.lessons ?? []), `${goal.id} was closed after current evidence no longer met its corrected rule.`].slice(-50);
          state.activeGoal = null;
          goal = null;
        }
        goal = goal ?? chooseGoal(facts, this.rules, now);
        if (goal && !state.activeGoal) {
          const eligibilityStartedAt = facts.signupAt ?? now;
          const deadline = new Date(eligibilityStartedAt + goal.windowHours * 60 * 60 * 1000).toISOString();
          state.activeGoal = {
            id: goal.id,
            rule_version: goal.version,
            startedAt: new Date(now).toISOString(),
            eligibility_started_at: new Date(eligibilityStartedAt).toISOString(),
            deadline,
            success_signal: ruleSignal(goal),
            condition: structuredClone(goal.condition ?? {}),
            experiment_group: state.experimentGroup
          };
          goal = state.activeGoal;
        } else if (state.activeGoal) {
          goal = state.activeGoal;
        }
        if (!goal) {
          if (!dependencyFailed) {
            reason = facts.paid ? "viewer_already_paid_or_no_eligible_goal" : "no_evidence_backed_eligible_goal";
          }
        } else {
          evidence.push({ reference: `goal_rule:${goal.id}-r${goal.rule_version}`, fact: "eligibility", observed_at: trigger.received_at, freshness: "current rule set" });
          titles = matchingTitles(
            this.titlesByDialectLanguage.get(`${facts.dialect}\0${facts.language}`) ?? [],
            facts.dialect,
            facts.language,
            now
          );
          messageAction = selectMessageAction({
            facts,
            state,
            now,
            interventionCatalogue: this.pack.interventionCatalogue
          });
          evidence.push(...titles.slice(0, 3).map((title) => ({
            reference: `catalogue:${title.id}`,
            fact: "dialect_and_availability",
            value: facts.dialect,
            observed_at: trigger.received_at,
            freshness: `available ${title.available_from} through ${title.available_until}`
          })));
          if (!dependencyFailed) {
            const candidateAction = messageAction?.action ??
              (this.pack.interventionCatalogue?.heroSlot?.enabled && titles.length ? "HERO_SLOT" : "HOME_PAGE");
            if (state.experimentGroup === "holdout") {
              action = "NO_ACTION";
              reason = "randomized_holdout";
            } else if (candidateAction) {
              action = candidateAction;
              reason = null;
            } else {
              action = "NO_ACTION";
              reason = "no_safe_intervention_available";
            }
          }
        }
      }
    }

    if (action !== "NO_ACTION") {
      checks = validateAction({
        action,
        templateId: messageAction?.template?.id,
        goal,
        facts,
        titles,
        catalogue: this.pack.catalogue,
        interventionCatalogue: this.pack.interventionCatalogue,
        rules: this.rules,
        state,
        now,
        trigger: { ...triggerInfo, event_age_s: eventAgeS },
        decisionElapsedMs: performance.now() - started
      });
      if (checks.failed.length) {
        action = "NO_ACTION";
        reason = `verification_failed:${checks.failed.join(",")}`;
      } else {
        status = "SIMULATED";
        state.last_action_at = new Date(now).toISOString();
        if (isMessageChannel(action)) state.last_message_at = new Date(now).toISOString();
        const recordedAction = {
          action_id: `A-${digest(`${trigger.viewer_id}:${trigger.id}`).toString("hex").slice(0, 12)}`,
          idempotency_key: decisionId,
          viewer_id: trigger.viewer_id,
          decision_id: decisionId,
          action,
          template_id: messageAction?.template?.id ?? null,
          content: action === "HOME_PAGE" || action === "HERO_SLOT"
            ? titles.slice(0, action === "HOME_PAGE" ? 3 : 1).map((title) => `title:${title.id}`)
            : messageAction ? [`template:${messageAction.template.id}`] : [],
          dialect: facts.dialect,
          language: facts.language,
          created_at: trigger.received_at,
          delivery_mode: "mock_replay",
          delivery_status: "SIMULATED"
        };
        await this.store.appendAction(recordedAction);
        state.actions = [...(state.actions ?? []), recordedAction].slice(-100);
      }
    }

    if (action === "NO_ACTION" && !checks.failed.length) {
      if (goal && reason === "randomized_holdout") {
        const candidateAction = messageAction?.action ??
          (this.pack.interventionCatalogue?.heroSlot?.enabled && titles.length ? "HERO_SLOT" : "HOME_PAGE");
        if (candidateAction) {
        checks = validateAction({
          action: candidateAction,
          templateId: messageAction?.template?.id,
          goal,
          facts,
          titles,
          catalogue: this.pack.catalogue,
          interventionCatalogue: this.pack.interventionCatalogue,
          rules: this.rules,
          state,
          now,
          trigger: { ...triggerInfo, event_age_s: eventAgeS },
          decisionElapsedMs: performance.now() - started
        });
        } else {
          checks.passed = ["trigger_freshness", "goal_eligibility"];
        }
      } else {
        checks.passed = facts ? ["trigger_freshness", "dialect_resolved"] : [];
        if (!goal) checks.failed.push("goal_eligibility");
      }
    }

    const elapsed = Math.round(performance.now() - started);
    const decision = {
      decision_id: decisionId,
      viewer_id: trigger.viewer_id,
      trigger: { id: trigger.id, ...triggerInfo, event_age_s: eventAgeS },
      goal: goal ? {
        id: goal.id,
        deadline: goal.deadline,
        success_signal: goal.success_signal ?? goal.evidence,
        success_condition: goal.condition ?? this.rules[goal.id]?.condition ?? {},
        rule_version: goal.rule_version ?? goal.version
      } : null,
      action,
      dialect: facts ? {
        used: facts.dialect,
        source: facts.dialectSource,
        conflicts: facts.conflicts
      } : null,
      language: facts?.language ?? null,
      content: action === "HOME_PAGE" || action === "HERO_SLOT"
        ? titles.slice(0, action === "HOME_PAGE" ? 3 : 1).map((title) => `title:${title.id}`)
        : [],
      message_template: isMessageChannel(action) ? messageAction?.template?.id ?? null : null,
      confidence: goal ? 0.78 : 0.35,
      confidence_reason: goal && reason === "randomized_holdout"
        ? "Goal eligibility has evidence support; the action is suppressed by randomized holdout assignment."
        : goal && status === "SIMULATED"
          ? `Goal eligibility and independent action checks passed; ${action} was recorded in mock replay mode, not delivered live.`
          : goal && reason?.startsWith("dependency_unavailable:")
            ? `Goal eligibility has evidence support, but the action was withheld because a dependency failed: ${reason.slice("dependency_unavailable:".length)}.`
            : goal && reason?.startsWith("verification_failed:")
              ? `Goal eligibility has evidence support, but independent action checks blocked publication: ${reason.slice("verification_failed:".length)}.`
              : goal && reason === "no_safe_intervention_available"
                ? "Goal eligibility has evidence support, but no safe intervention was available."
            : goal && reason === "stale_offline_trigger"
              ? "The goal remains evidence-backed, but this offline trigger was stale, so no intervention was published."
              : goal && reason === "out_of_order_trigger"
                ? "The goal remains evidence-backed, but this out-of-order trigger was not allowed to change viewer state."
          : goal
            ? `Goal eligibility has evidence support, but no intervention was published: ${reason ?? "no action selected"}.`
            : `No evidence-backed eligible goal was established, so the agent abstained: ${reason ?? "eligibility not established"}.`,
      evidence,
      assumptions,
      checks,
      decided_in_ms: elapsed,
      call_usage: usage,
      status,
      reason,
      experiment_group: state.experimentGroup,
      rule_version: this.ruleVersion
    };

    if (!state.last_trigger_at || now >= Date.parse(state.last_trigger_at)) {
      state.last_trigger_at = trigger.received_at;
    }
    state.decision_ids = [...(state.decision_ids ?? []), decisionId].slice(-500);
    state.fact_snapshot = facts?.facts ?? state.fact_snapshot ?? [];
    state.dialect_conflicts = facts?.conflicts ?? state.dialect_conflicts ?? [];
    state.processed_trigger_ids = [...new Set([...(state.processed_trigger_ids ?? []), trigger.id])].slice(-500);
    await this.store.saveViewerState(trigger.viewer_id, state);
    await this.store.appendDecision(decision);
    this.decisions.push(decision);
    return decision;
  }

  applyRuleCorrection(correction) {
    const rule = this.rules[correction.goal_id];
    if (!rule) throw new Error(`Unknown goal rule: ${correction.goal_id}`);
    if (!Number.isInteger(correction.version) || correction.version <= rule.version) {
      throw new Error("Corrected goal rule must have a higher integer version.");
    }
    const correctedSignal = correction.evidence ?? correction.success_signal;
    if (correctedSignal !== undefined && correctedSignal !== ruleSignal(rule)) {
      throw new Error(`Goal ${correction.goal_id} must retain its configured event signal (${ruleSignal(rule)}).`);
    }
    if (correction.windowHours !== undefined &&
        (!Number.isFinite(correction.windowHours) || correction.windowHours <= 0 || correction.windowHours > 720)) {
      throw new Error("Goal windowHours must be greater than zero and no more than 720.");
    }
    const updatedRule = {
      ...rule,
      ...correction,
      evidence: ruleSignal(rule),
      condition: correction.condition === undefined
        ? rule.condition
        : structuredClone(correction.condition),
      id: correction.goal_id
    };
    delete updatedRule.goal_id;
    validateRuleSet({ [correction.goal_id]: updatedRule });
    this.rules[correction.goal_id] = updatedRule;
    this.ruleVersion++;
    return { goal_id: correction.goal_id, version: correction.version, refresh_policy: "next_viewer_trigger" };
  }

  async judgeOutcomes(asOf) {
    const now = Date.parse(asOf);
    if (!Number.isFinite(now)) throw new Error("Outcome judgment time must be a valid timestamp.");
    for (const viewerId of this.store.listViewerIds()) {
      const state = this.store.getViewerState(viewerId);
      const goal = state.activeGoal;
      if (!goal || now < Date.parse(goal.deadline)) continue;
      const events = this.eventsByViewer.get(viewerId) ?? [];
      const signal = events.find((event) => signalQualifies({
        ...goal,
        evidence: goal.success_signal
      }, event) &&
        timeOf(event) >= Date.parse(goal.startedAt) &&
        timeOf(event) <= Date.parse(goal.deadline) &&
        (isoMs(event.received_at) ?? timeOf(event)) <= now);
      const outcome = {
        outcome_id: `O-${digest(`${viewerId}:${goal.id}:${goal.deadline}`).toString("hex").slice(0, 12)}`,
        viewer_id: viewerId,
        goal_id: goal.id,
        status: signal ? "SUCCEEDED" : "FAILED",
        signal: signal ? `event:${signal.id}` : null,
        reason: signal ? null : "deadline_passed_without_success_signal",
        judged_at: asOf
      };
      await this.store.appendOutcome(outcome);
      state.outcomes = [...(state.outcomes ?? []), outcome].slice(-100);
      state.lessons = [...(state.lessons ?? []),
        signal ? `${goal.id} succeeded from event:${signal.id}.` : `${goal.id} failed without an attributable success signal.`].slice(-50);
      state.activeGoal = null;
      await this.store.saveViewerState(viewerId, state);
    }
  }
}

export function buildImpactReport(decisions, outcomes, { synthetic = true } = {}) {
  const assigned = new Map();
  for (const decision of decisions) {
    if (!decision.goal || assigned.has(decision.viewer_id)) continue;
    assigned.set(decision.viewer_id, {
      group: decision.experiment_group,
      goal_id: decision.goal.id
    });
  }
  const metrics = {};
  for (const group of ["treatment", "holdout"]) {
    const viewers = [...assigned.entries()].filter(([, value]) => value.group === group);
    const matched = viewers.map(([id, assignment]) => outcomes.find((outcome) =>
      outcome.viewer_id === id && outcome.goal_id === assignment.goal_id
    ));
    const succeeded = matched.filter((outcome) => outcome?.status === "SUCCEEDED").length;
    const failed = matched.filter((outcome) => outcome?.status === "FAILED").length;
    const inconclusive = matched.filter((outcome) => outcome?.status === "INCONCLUSIVE").length;
    const judged = succeeded + failed;
    metrics[group] = {
      viewers_assigned: viewers.length,
      judged,
      successes: succeeded,
      failures: failed,
      inconclusive,
      pending: viewers.length - judged - inconclusive,
      rate: judged ? succeeded / judged : 0
    };
  }
  const treated = metrics.treatment;
  const control = metrics.holdout;
  const standardError = Math.sqrt(
    (treated.rate * (1 - treated.rate) / Math.max(treated.judged, 1)) +
    (control.rate * (1 - control.rate) / Math.max(control.judged, 1))
  );
  return {
    method: "intention_to_treat_randomized_holdout",
    denominator: "stable randomized assignment for viewers with an evidence-backed goal at first decision; rates use terminally judged matching-goal outcomes, with pending and inconclusive assignments reported separately",
    groups: metrics,
    absolute_uplift: treated.rate - control.rate,
    approximate_95pct_interval: [treated.rate - control.rate - 1.96 * standardError, treated.rate - control.rate + 1.96 * standardError],
    caveats: [
      synthetic
        ? "Synthetic replay only; this is not a production causal estimate."
        : "Supplied replay data only; this is not evidence of production impact.",
      "Assignment, not served-versus-unserved status, defines the comparison.",
      "Small samples and multiple goals limit precision; the interval is an approximate normal interval."
    ]
  };
}

export function makeNoopDecision(viewerId, reason) {
  return { viewer_id: viewerId, action: "NO_ACTION", reason, status: "RECORDED" };
}
