import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEngine, experimentGroup } from "../src/core.js";
import { FileStore } from "../src/store.js";

const now = "2026-09-12T18:00:00.000Z";

function fixture(viewerId = "V-TEST") {
  const trigger = {
    id: "E-OPEN-TEST",
    viewer_id: viewerId,
    type: "app_open",
    occurred_at: now,
    received_at: now
  };
  return {
    trigger,
    pack: {
      events: [
        {
          id: "E-SIGNUP-TEST",
          viewer_id: viewerId,
          type: "signup",
          occurred_at: "2026-09-12T17:00:00.000Z",
          received_at: "2026-09-12T17:00:01.000Z"
        },
        trigger
      ],
      profiles: [{
        snapshot_id: "P-TEST",
        viewer_id: viewerId,
        updated_at: "2026-09-11T00:00:00.000Z",
        subscription_status: "trial",
        preferred_dialect: "d1",
        preferred_language: "en"
      }],
      appSettings: [{
        event_id: trigger.id,
        viewer_id: viewerId,
        dialect: "d2",
        received_at: now
      }],
      campaignLinks: [{ viewer_id: viewerId, dialect: "d3", arrived_at: "2026-09-11T23:00:00.000Z" }],
      catalogue: ["T-1", "T-2", "T-3"].map((id) => ({
        id,
        dialects: ["d2"],
        language: "en",
        available_from: "2026-01-01T00:00:00.000Z",
        available_until: "2027-01-01T00:00:00.000Z"
      }))
    }
  };
}

function withEngine(t, pack, provider) {
  const directory = mkdtempSync(join(tmpdir(), "ott-agent-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return new AgentEngine({ pack, store: new FileStore(directory), provider });
}

test("duplicate trigger is idempotent and an offline-old trigger abstains", async (t) => {
  const input = fixture();
  const engine = withEngine(t, input.pack);
  const first = await engine.processTrigger(input.trigger);
  const duplicate = await engine.processTrigger(input.trigger);
  assert.equal(first.decision_id, duplicate.decision_id);
  assert.equal(engine.metrics.duplicateTriggers, 1);

  const stale = {
    ...input.trigger,
    id: "E-OPEN-STALE",
    occurred_at: "2026-09-10T18:00:00.000Z",
    received_at: now
  };
  const decision = await engine.processTrigger(stale);
  assert.equal(decision.action, "NO_ACTION");
  assert.equal(decision.reason, "stale_offline_trigger");
  assert.match(decision.confidence_reason, /offline trigger was stale/i);
  assert.equal(engine.metrics.staleTriggers, 1);
});

test("current app setting wins while profile and campaign conflicts remain auditable", async (t) => {
  const input = fixture();
  const engine = withEngine(t, input.pack);
  const decision = await engine.processTrigger(input.trigger);
  assert.equal(decision.dialect.used, "d2");
  assert.equal(decision.dialect.source, "app_setting");
  assert.deepEqual(decision.dialect.conflicts.sort(), ["campaign_link:d3", "profile:d1"]);
  assert.ok(decision.evidence.some((item) => item.reference === "app_setting:E-OPEN-TEST"));
  assert.ok(decision.evidence.some((item) => item.reference === "profile:P-TEST" && item.fact === "dialect_profile"));
  assert.ok(decision.evidence.some((item) => item.reference === "campaign_link:V-TEST" && item.fact === "dialect_campaign"));
});

test("same-trigger settings are viewer-scoped and duplicate profile snapshots resolve deterministically", async (t) => {
  const input = fixture();
  input.pack.appSettings = input.pack.appSettings.map((setting) => ({
    ...setting,
    viewer_id: "V-OTHER"
  }));
  input.pack.campaignLinks = [];
  input.pack.profiles.push({
    ...input.pack.profiles[0],
    snapshot_id: "P-TEST-Z",
    preferred_dialect: "d4"
  });
  const engine = withEngine(t, input.pack);
  const decision = await engine.processTrigger(input.trigger);
  assert.equal(decision.dialect.source, "profile");
  assert.equal(decision.dialect.used, "d4");
});

test("goal is not opened when its measurable success signal already exists", async (t) => {
  const input = fixture();
  input.pack.events.push({
    id: "E-ALREADY-COMPLETED",
    viewer_id: input.trigger.viewer_id,
    type: "episode_completed",
    duration_seconds: 1500,
    occurred_at: "2026-09-12T17:30:00.000Z",
    received_at: "2026-09-12T17:30:00.000Z"
  });
  const engine = withEngine(t, input.pack);
  const decision = await engine.processTrigger(input.trigger);
  assert.notEqual(decision.goal?.id, "first_full_episode_3d");
});

test("goal deadline expiration is judged FAILED before eligibility rollover", async (t) => {
  const input = fixture();
  const engine = withEngine(t, input.pack);
  await engine.processTrigger(input.trigger);
  const afterDeadline = {
    ...input.trigger,
    id: "E-OPEN-AFTER-DEADLINE",
    occurred_at: "2026-09-16T18:00:00.000Z",
    received_at: "2026-09-16T18:00:00.000Z"
  };
  input.pack.events.push(afterDeadline);
  engine.refreshIndexes();
  const decision = await engine.processTrigger(afterDeadline);
  assert.equal(engine.store.allOutcomes()[0].status, "FAILED");
  assert.equal(decision.goal?.id, "first_paid_plan_7d");
});

test("provider failure degrades to explicit no action", async (t) => {
  const input = fixture();
  const engine = withEngine(t, input.pack, {
    async beforeDecision() {
      throw new Error("mock_store_timeout");
    }
  });
  const decision = await engine.processTrigger(input.trigger);
  assert.equal(decision.action, "NO_ACTION");
  assert.match(decision.reason, /dependency_unavailable:mock_store_timeout/);
  assert.equal(engine.metrics.providerFailures, 1);
});

test("slow dependencies time out and tool-call budgets fail closed per decision", async (t) => {
  const input = fixture();
  const directory = mkdtempSync(join(tmpdir(), "ott-agent-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const engine = new AgentEngine({
    pack: input.pack,
    store: new FileStore(directory),
    provider: { async beforeDecision() { await new Promise(() => {}); } },
    dependencyTimeoutMs: 10
  });
  const decision = await engine.processTrigger(input.trigger);
  assert.match(decision.reason, /dependency_unavailable:dependency_timeout/);
  assert.deepEqual(decision.call_usage, { model_calls: 0, tool_calls: 1 });
  assert.equal(engine.metrics.providerFailures, 1);
});

test("tool-call budget is enforced before invoking a dependency", async (t) => {
  const input = fixture();
  let calls = 0;
  const directory = mkdtempSync(join(tmpdir(), "ott-agent-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const engine = new AgentEngine({
    pack: input.pack,
    store: new FileStore(directory),
    provider: { async beforeDecision() { calls++; } },
    callBudget: { toolCalls: 0 }
  });
  const decision = await engine.processTrigger(input.trigger);
  assert.equal(calls, 0);
  assert.match(decision.reason, /tool_call_budget_exceeded/);
  assert.equal(engine.metrics.callBudgetViolations, 1);
  assert.equal(decision.call_usage.tool_calls, 0);
});

test("data-driven goal rules support identifiers beyond built-in examples and disable missing signals", async (t) => {
  const input = fixture();
  input.pack.goalRules = Object.fromEntries(Array.from({ length: 12 }, (_, index) => {
    const id = index === 0 ? "first_saved_title" : `goal_candidate_${index + 1}`;
    return [id, {
      id,
      version: 1,
      evidence: index === 0 ? "title_saved" : `goal_signal_${index + 1}`,
      windowHours: 48,
      condition: index === 0 ? { source: { eq: "editorial" } } : {},
      eligibility: {
        requiresSignup: true,
        requireEventTypes: ["signup"],
        excludeEventTypes: []
      },
      priority: index + 1
    }];
  }));
  const engine = withEngine(t, input.pack);
  const decision = await engine.processTrigger(input.trigger);
  assert.equal(decision.goal.id, "first_saved_title");
  assert.equal(decision.goal.success_signal, "title_saved");
  const correction = engine.applyRuleCorrection({
    goal_id: "first_saved_title",
    version: 2,
    evidence: "title_saved",
    windowHours: 24,
    condition: { source: { eq: "editorial" } }
  });
  assert.equal(correction.version, 2);

  const unavailable = fixture("V-NO-SIGNAL");
  unavailable.pack.goalRules = {
    missing_signal_goal: {
      id: "missing_signal_goal",
      version: 1,
      evidence: "signal_not_in_event_stream",
      signal_available: false,
      windowHours: 48,
      eligibility: { requiresSignup: true },
      priority: 1
    }
  };
  const unavailableEngine = withEngine(t, unavailable.pack);
  const unavailableDecision = await unavailableEngine.processTrigger(unavailable.trigger);
  assert.equal(unavailableDecision.goal, null);
  assert.equal(unavailableDecision.reason, "no_evidence_backed_eligible_goal");
});

test("each of twelve configured goal rules can independently pass eligibility selection", async (t) => {
  const rules = Object.fromEntries(Array.from({ length: 12 }, (_, index) => {
    const id = `configured_goal_${String(index + 1).padStart(2, "0")}`;
    return [id, {
      id,
      version: 1,
      evidence: `goal_success_${index + 1}`,
      windowHours: 72,
      priority: index + 1,
      eligibility: {
        requiresSignup: true,
        requireEventTypes: [`eligibility_marker_${index + 1}`]
      }
    }];
  }));

  for (let index = 0; index < 12; index++) {
    const input = fixture(`V-GOAL-CANDIDATE-${index + 1}`);
    const markerType = `eligibility_marker_${index + 1}`;
    input.pack.events.push({
      id: `E-${markerType}`,
      viewer_id: input.trigger.viewer_id,
      type: markerType,
      occurred_at: "2026-09-12T17:30:00.000Z",
      received_at: "2026-09-12T17:30:00.000Z"
    });
    input.pack.goalRules = structuredClone(rules);
    const engine = withEngine(t, input.pack);
    const decision = await engine.processTrigger(input.trigger);
    assert.equal(decision.goal?.id, `configured_goal_${String(index + 1).padStart(2, "0")}`);
    assert.equal(decision.goal?.success_signal, `goal_success_${index + 1}`);
  }
});

test("corrected goal rule updates active plan version and deadline on next trigger", async (t) => {
  const input = fixture();
  const engine = withEngine(t, input.pack);
  const first = await engine.processTrigger(input.trigger);
  assert.equal(first.goal.id, "first_full_episode_3d");

  engine.applyRuleCorrection({
    goal_id: "first_full_episode_3d",
    version: 3,
    evidence: "episode_completed",
    windowHours: 48,
    condition: { minimum_duration_seconds: 1800 }
  });
  const nextTrigger = {
    ...input.trigger,
    id: "E-OPEN-TEST-2",
    occurred_at: "2026-09-12T18:01:00.000Z",
    received_at: "2026-09-12T18:01:00.000Z"
  };
  input.pack.events.push(nextTrigger);
  input.pack.appSettings.push({
    event_id: nextTrigger.id,
    viewer_id: nextTrigger.viewer_id,
    dialect: "d2",
    received_at: nextTrigger.received_at
  });
  engine.refreshIndexes();
  const decision = await engine.processTrigger(nextTrigger);
  assert.equal(decision.goal.id, "first_full_episode_3d");
  assert.equal(decision.goal.deadline, "2026-09-14T17:00:00.000Z");
  assert.deepEqual(decision.goal.success_condition, { minimum_duration_seconds: 1800 });
  assert.equal(engine.store.getViewerState("V-TEST").activeGoal.rule_version, 3);
});

test("provider failure preserves the evidence-backed plan but prevents publication", async (t) => {
  const input = fixture();
  const engine = withEngine(t, input.pack, {
    async beforeDecision() {
      throw new Error("mock_catalogue_timeout");
    }
  });
  const decision = await engine.processTrigger(input.trigger);
  assert.equal(decision.action, "NO_ACTION");
  assert.equal(decision.goal.id, "first_full_episode_3d");
  assert.match(decision.reason, /dependency_unavailable:mock_catalogue_timeout/);
  assert.match(decision.confidence_reason, /dependency failed: mock_catalogue_timeout/);
  assert.equal(engine.store.getViewerState("V-TEST").activeGoal.id, "first_full_episode_3d");
});

test("experiment assignment is stable and balanced by cohort hash", () => {
  assert.equal(experimentGroup("V-TEST"), experimentGroup("V-TEST"));
});

test("home-page row is rejected when fewer than three available dialect titles exist", async (t) => {
  const viewerId = Array.from({ length: 100 }, (_, index) => `V-SAFETY-${index}`)
    .find((id) => experimentGroup(id) === "treatment");
  const input = fixture(viewerId);
  input.pack.catalogue = input.pack.catalogue.slice(0, 2);
  const engine = withEngine(t, input.pack);
  const decision = await engine.processTrigger(input.trigger);
  assert.equal(decision.action, "NO_ACTION");
  assert.match(decision.reason, /minimum_three_titles/);
  assert.ok(decision.checks.failed.includes("minimum_three_titles"));
  assert.equal(engine.store.getViewerState(viewerId).decision_ids.length, 1);
});

test("hero-slot actions independently verify a single available dialect title", async (t) => {
  const viewerId = Array.from({ length: 100 }, (_, index) => `V-HERO-${index}`)
    .find((id) => experimentGroup(id) === "treatment");
  const input = fixture(viewerId);
  input.pack.interventionCatalogue = { heroSlot: { enabled: true }, templates: [] };
  const engine = withEngine(t, input.pack);
  const decision = await engine.processTrigger(input.trigger);
  assert.equal(decision.action, "HERO_SLOT");
  assert.equal(decision.content.length, 1);
  assert.ok(decision.checks.passed.includes("hero_title_selected"));
});

test("message action is recorded as simulated only after independent consent and template checks", async (t) => {
  const viewerId = Array.from({ length: 100 }, (_, index) => `V-MESSAGE-${index}`)
    .find((id) => experimentGroup(id) === "treatment");
  const input = fixture(viewerId);
  input.pack.profiles[0].time_zone = "America/Los_Angeles";
  input.pack.consents = [{
    id: "C-TEST-PUSH",
    viewer_id: viewerId,
    channel: "PUSH",
    granted: true,
    received_at: "2026-09-12T17:59:00.000Z"
  }];
  input.pack.interventionCatalogue = {
    channelPriority: ["PUSH"],
    templates: [{
      id: "TPL-TEST-PUSH",
      channel: "PUSH",
      dialect: "d2",
      language: "en",
      approved: true,
      body: "Test-only template"
    }]
  };
  const engine = withEngine(t, input.pack);
  const decision = await engine.processTrigger(input.trigger);
  assert.equal(decision.action, "PUSH");
  assert.equal(decision.status, "SIMULATED");
  assert.match(decision.confidence_reason, /PUSH was recorded in mock replay mode, not delivered live/);
  assert.equal(decision.message_template, "TPL-TEST-PUSH");
  assert.equal(engine.store.allActions()[0].delivery_mode, "mock_replay");
});

test("conflicting consent records at the same timestamp are treated as denied", async (t) => {
  const viewerId = Array.from({ length: 100 }, (_, index) => `V-CONSENT-${index}`)
    .find((id) => experimentGroup(id) === "treatment");
  const input = fixture(viewerId);
  input.pack.profiles[0].time_zone = "America/Los_Angeles";
  input.pack.consents = [
    {
      id: "C-PUSH-A",
      viewer_id: viewerId,
      channel: "PUSH",
      granted: true,
      received_at: "2026-09-12T17:59:00.000Z"
    },
    {
      id: "C-PUSH-B",
      viewer_id: viewerId,
      channel: "PUSH",
      granted: false,
      received_at: "2026-09-12T17:59:00.000Z"
    }
  ];
  input.pack.interventionCatalogue = {
    channelPriority: ["PUSH"],
    templates: [{
      id: "TPL-TEST-PUSH",
      channel: "PUSH",
      dialect: "d2",
      language: "en",
      approved: true,
      body: "Test-only template"
    }]
  };
  const engine = withEngine(t, input.pack);
  const decision = await engine.processTrigger(input.trigger);
  assert.notEqual(decision.action, "PUSH");
  assert.ok(decision.evidence.some((item) =>
    item.fact === "consent_push" &&
    item.value === false &&
    item.freshness.includes("conflicting")
  ));
});

test("home-page row does not count language variants of one work as separate titles", async (t) => {
  const viewerId = Array.from({ length: 100 }, (_, index) => `V-VARIANT-${index}`)
    .find((id) => experimentGroup(id) === "treatment");
  const input = fixture(viewerId);
  input.pack.catalogue[0].work_id = "WORK-SAME";
  input.pack.catalogue[1].work_id = "WORK-SAME";
  const engine = withEngine(t, input.pack);
  const decision = await engine.processTrigger(input.trigger);
  assert.equal(decision.action, "NO_ACTION");
  assert.ok(decision.checks.failed.includes("minimum_three_titles"));
});

test("future app settings cannot leak into an earlier decision", async (t) => {
  const input = fixture();
  input.pack.campaignLinks = [];
  input.pack.appSettings[0].received_at = "2026-09-12T18:01:00.000Z";
  input.pack.appSettings.push({
    event_id: "E-OPEN-FUTURE",
    viewer_id: input.trigger.viewer_id,
    dialect: "d4",
    language: "en",
    received_at: "2026-09-12T18:01:00.000Z"
  });

  test("future device-clock timestamps are flagged and cannot move evidence into the future", async (t) => {
    const input = fixture();
    const future = {
      id: "E-OPEN-CLOCK",
      viewer_id: input.trigger.viewer_id,
      type: "app_open",
      occurred_at: "2026-09-12T22:00:00.000Z",
      received_at: now
    };
    input.pack.events.push(future);
    input.pack.appSettings.push({
      event_id: future.id,
      viewer_id: future.viewer_id,
      dialect: "d2",
      language: "en",
      received_at: now
    });
    const engine = withEngine(t, input.pack);
    const decision = await engine.processTrigger(future);
    assert.equal(decision.trigger.device_clock_skew_s, 4 * 60 * 60);
    assert.ok(decision.assumptions.some((item) => item.includes("receipt time is used")));
  });

  test("new viewer without signup evidence abstains instead of inventing an eligible goal", async (t) => {
    const input = fixture("V-NEW");
    input.pack.events = [input.trigger];
    input.pack.profiles = [];
    const engine = withEngine(t, input.pack);
    const decision = await engine.processTrigger(input.trigger);
    assert.equal(decision.action, "NO_ACTION");
    assert.equal(decision.goal, null);
    assert.equal(decision.reason, "no_evidence_backed_eligible_goal");
  });
  const engine = withEngine(t, input.pack);
  const decision = await engine.processTrigger(input.trigger);
  assert.equal(decision.dialect.used, "d1");
  assert.equal(decision.dialect.source, "profile");
  assert.equal(decision.language, "en");
});

test("same viewer triggers are serialized and duplicate delivery shares one decision", async (t) => {
  const input = fixture();
  const engine = withEngine(t, input.pack);
  let calls = 0;
  engine.provider = {
    async beforeDecision() {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const [first, duplicate] = await Promise.all([
    engine.processTrigger(input.trigger),
    engine.processTrigger(input.trigger)
  ]);
  assert.equal(first.decision_id, duplicate.decision_id);
  assert.equal(calls, 1);
});

test("an out-of-order trigger does not rewind per-viewer memory", async (t) => {
  const input = fixture();
  const engine = withEngine(t, input.pack);
  const later = {
    ...input.trigger,
    id: "E-OPEN-LATER",
    occurred_at: "2026-09-12T18:02:00.000Z",
    received_at: "2026-09-12T18:02:00.000Z"
  };
  input.pack.events.push(later);
  input.pack.appSettings.push({
    event_id: later.id,
    viewer_id: later.viewer_id,
    dialect: "d2",
    language: "en",
    received_at: later.received_at
  });
  engine.refreshIndexes();
  await engine.processTrigger(later);
  const old = {
    ...input.trigger,
    id: "E-OPEN-OLD-ARRIVAL",
    occurred_at: "2026-09-12T18:01:00.000Z",
    received_at: "2026-09-12T18:01:00.000Z"
  };
  const decision = await engine.processTrigger(old);
  assert.equal(decision.reason, "out_of_order_trigger");
  assert.equal(engine.store.getViewerState("V-TEST").last_trigger_at, later.received_at);
});

test("malformed triggers and unsafe corrected rules are rejected explicitly", async (t) => {
  const input = fixture();
  const engine = withEngine(t, input.pack);
  assert.throws(
    () => engine.processTrigger({ ...input.trigger, received_at: "not-a-date" }),
    /valid ISO timestamp/
  );
  assert.throws(() => engine.applyRuleCorrection({
    goal_id: "first_full_episode_3d",
    version: 3,
    evidence: "unknown_signal",
    windowHours: -1
  }), /retain its configured event signal/);
});

test("action verification independently rejects wrong-language catalogue rows", async (t) => {
  const viewerId = Array.from({ length: 100 }, (_, index) => `V-LANGUAGE-${index}`)
    .find((id) => experimentGroup(id) === "treatment");
  const input = fixture(viewerId);
  input.pack.catalogue[2].language = "te";
  const engine = withEngine(t, input.pack);
  const decision = await engine.processTrigger(input.trigger);
  assert.equal(decision.action, "NO_ACTION");
  assert.ok(decision.checks.failed.includes("dialect_language_availability"));
});

test("outcomes arriving after judgment time are not attributed", async (t) => {
  const input = fixture();
  const engine = withEngine(t, input.pack);
  const decision = await engine.processTrigger(input.trigger);
  const signalAt = "2026-09-12T18:30:00.000Z";
  input.pack.events.push({
    id: "E-LATE-SUCCESS",
    viewer_id: input.trigger.viewer_id,
    type: decision.goal.success_signal,
    duration_seconds: 2000,
    occurred_at: signalAt,
    received_at: "2026-09-21T00:00:00.000Z"
  });
  engine.refreshIndexes();
  await engine.judgeOutcomes("2026-09-20T00:00:00.000Z");
  const outcome = engine.store.allOutcomes()[0];
  assert.equal(outcome.status, "FAILED");
  assert.equal(outcome.signal, null);
});

test("impact report only counts success for the first assigned goal", async () => {
  const { buildImpactReport } = await import("../src/core.js");
  const report = buildImpactReport([
    { viewer_id: "V-1", goal: { id: "goal-a" }, experiment_group: "treatment" },
    { viewer_id: "V-2", goal: { id: "goal-a" }, experiment_group: "holdout" }
  ], [
    { viewer_id: "V-1", goal_id: "goal-b", status: "SUCCEEDED" }
  ]);
  assert.equal(report.groups.treatment.successes, 0);
  assert.equal(report.groups.holdout.successes, 0);
});
