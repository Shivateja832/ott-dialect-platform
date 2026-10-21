import test from "node:test";
import assert from "node:assert/strict";
import { selectMessageAction, verifyMessageAction } from "../src/interventions.js";

const now = Date.parse("2026-09-12T18:00:00.000Z");
const template = {
  id: "TPL-PUSH-D2",
  channel: "PUSH",
  dialect: "d2",
  language: "en",
  approved: true,
  body: "A test-only approved template."
};
const interventionCatalogue = { templates: [template] };

function facts(overrides = {}) {
  return {
    dialect: "d2",
    language: "en",
    timeZone: "America/Los_Angeles",
    consents: { PUSH: true },
    ...overrides
  };
}

test("message action requires explicit consent, approved matching template, and permitted local time", () => {
  const action = selectMessageAction({
    facts: facts(),
    state: { actions: [] },
    now,
    interventionCatalogue
  });
  assert.equal(action.action, "PUSH");
  assert.deepEqual(action.checks.failed, []);

  const noConsent = verifyMessageAction({
    action,
    facts: facts({ consents: {} }),
    state: { actions: [] },
    now,
    interventionCatalogue
  });
  assert.ok(noConsent.failed.includes("message_consent"));

  const quietHours = verifyMessageAction({
    action,
    facts: facts({ timeZone: "Asia/Kolkata" }),
    state: { actions: [] },
    now,
    interventionCatalogue
  });
  assert.ok(quietHours.failed.includes("quiet_hours"));
});

test("message cap is one per viewer per local calendar day across channels", () => {
  const result = verifyMessageAction({
    action: { action: "PUSH", template_id: template.id },
    facts: facts(),
    state: {
      actions: [{
        action: "WHATSAPP",
        created_at: "2026-09-12T12:00:00.000Z"
      }]
    },
    now,
    interventionCatalogue
  });
  assert.ok(result.failed.includes("one_message_per_local_day"));
});

test("daily message cap remains enforced when the detailed action history has rolled off", () => {
  const result = verifyMessageAction({
    action: { action: "PUSH", template_id: template.id },
    facts: facts(),
    state: {
      actions: [],
      last_message_at: "2026-09-12T12:00:00.000Z"
    },
    now,
    interventionCatalogue
  });
  assert.ok(result.failed.includes("one_message_per_local_day"));
});

test("corrupt message history fails closed instead of bypassing the daily cap", () => {
  const result = verifyMessageAction({
    action: { action: "PUSH", template_id: template.id },
    facts: facts(),
    state: {
      actions: [{ action: "WHATSAPP", created_at: "not-a-timestamp" }]
    },
    now,
    interventionCatalogue
  });
  assert.ok(result.failed.includes("one_message_per_local_day"));
});

test("push, WhatsApp, and in-app channels share the verified policy path", () => {
  for (const channel of ["PUSH", "WHATSAPP", "IN_APP"]) {
    const channelTemplate = { ...template, id: `TPL-${channel}`, channel };
    const action = selectMessageAction({
      facts: facts({ consents: { [channel]: true } }),
      state: { actions: [] },
      now,
      interventionCatalogue: {
        channelPriority: [channel],
        templates: [channelTemplate]
      }
    });
    assert.equal(action.action, channel);
    assert.deepEqual(action.checks.failed, []);
  }
});

test("unapproved or wrong-dialect templates cannot be selected", () => {
  const result = selectMessageAction({
    facts: facts(),
    state: { actions: [] },
    now,
    interventionCatalogue: {
      templates: [{ ...template, approved: false, dialect: "d1" }]
    }
  });
  assert.equal(result, null);
});

test("invalid local timezone fails closed for messaging", () => {
  const result = verifyMessageAction({
    action: { action: "PUSH", template_id: template.id },
    facts: facts({ timeZone: "Invalid/Zone" }),
    state: { actions: [] },
    now,
    interventionCatalogue
  });
  assert.ok(result.failed.includes("viewer_timezone"));
  assert.ok(result.failed.includes("quiet_hours"));
});
