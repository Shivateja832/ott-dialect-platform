const MESSAGE_CHANNELS = ["PUSH", "WHATSAPP", "IN_APP"];
const QUIET_HOURS_START = 22;
const QUIET_HOURS_END = 8;
const formatterCache = new Map();

function localParts(timestamp, timeZone) {
  try {
    let formatter = formatterCache.get(timeZone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        hourCycle: "h23"
      });
      formatterCache.set(timeZone, formatter);
    }
    const parts = formatter.formatToParts(new Date(timestamp));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return { date: `${values.year}-${values.month}-${values.day}`, hour: Number(values.hour) };
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function hasMessageToday(state, now, timeZone) {
  const current = localParts(now, timeZone);
  if (!current) return true;
  if (state.last_message_at) {
    const messageTime = Date.parse(state.last_message_at);
    if (!Number.isFinite(messageTime)) return true;
    const previousMessage = localParts(messageTime, timeZone);
    if (!previousMessage || previousMessage.date === current.date) return true;
  }
  return (state.actions ?? []).some((action) => {
    if (!MESSAGE_CHANNELS.includes(action.action)) return false;
    const timestamp = Date.parse(action.created_at);
    if (!Number.isFinite(timestamp)) return true;
    const previous = localParts(timestamp, timeZone);
    if (!previous) return true;
    return previous && current && previous.date === current.date;
  });
}

function matchesTemplate(template, channel, dialect, language) {
  const dialects = Array.isArray(template.dialects) ? template.dialects : [template.dialect];
  return template.channel === channel &&
    template.approved === true &&
    typeof template.id === "string" &&
    template.id.trim().length > 0 &&
    typeof template.body === "string" &&
    template.body.trim().length > 0 &&
    dialects.includes(dialect) &&
    template.language === language;
}

export function verifyMessageAction({ action, facts, state, now, interventionCatalogue }) {
  const passed = [];
  const failed = [];
  const consent = facts.consents?.[action.action];
  if (consent === true) passed.push("message_consent");
  else failed.push("message_consent");

  const local = facts.timeZone ? localParts(now, facts.timeZone) : null;
  if (local) passed.push("viewer_timezone");
  else failed.push("viewer_timezone");

  if (!local || local.hour < QUIET_HOURS_END || local.hour >= QUIET_HOURS_START) {
    failed.push("quiet_hours");
  } else {
    passed.push("quiet_hours");
  }

  if (local && !hasMessageToday(state, now, facts.timeZone)) passed.push("one_message_per_local_day");
  else failed.push("one_message_per_local_day");

  const template = interventionCatalogue?.templates?.find((item) =>
    item.id === action.template_id &&
    matchesTemplate(item, action.action, facts.dialect, facts.language)
  );
  if (template) passed.push("approved_template_dialect_language");
  else failed.push("approved_template_dialect_language");

  return { passed, failed, template: template ?? null };
}

export function selectMessageAction({ facts, state, now, interventionCatalogue }) {
  const configuredChannels = interventionCatalogue?.channelPriority;
  const channels = Array.isArray(configuredChannels)
    ? configuredChannels.filter((channel) => MESSAGE_CHANNELS.includes(channel))
    : MESSAGE_CHANNELS;

  for (const channel of channels) {
    if (facts.consents?.[channel] !== true) continue;
    const template = interventionCatalogue?.templates?.find((item) =>
      matchesTemplate(item, channel, facts.dialect, facts.language)
    );
    if (!template) continue;
    const action = { action: channel, template_id: template.id };
    const verification = verifyMessageAction({
      action,
      facts,
      state,
      now,
      interventionCatalogue
    });
    if (!verification.failed.length) {
      return { ...action, template: verification.template, checks: verification };
    }
  }
  return null;
}

export function isMessageChannel(channel) {
  return MESSAGE_CHANNELS.includes(channel);
}
