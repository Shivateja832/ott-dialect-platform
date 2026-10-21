const state = {
  decisions: [],
  offset: 0,
  limit: 14,
  query: "",
  requestId: 0,
  total: 0
};

const number = new Intl.NumberFormat("en-US");

function byId(id) {
  return document.getElementById(id);
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function safeText(value, fallback = "—") {
  return typeof value === "string" && value.length ? value : fallback;
}

async function getJson(path) {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${response.status}).`);
  }
  return response.json();
}

function showToast(message) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 4500);
}

function renderSummary(data) {
  byId("metric-viewers").textContent = number.format(data.viewers);
  byId("metric-decisions").textContent = number.format(data.decisions);
  byId("metric-actions").textContent = number.format(data.actions);
  byId("metric-latency").textContent = number.format(data.latency.p95_ms);
  byId("metric-budget").textContent = number.format(data.latency.budget_ms);
  byId("metric-budget-status").textContent = data.latency.within_budget ? "WITHIN BUDGET" : "OVER BUDGET";
  byId("metric-budget-status").className = data.latency.within_budget ? "status-good" : "check-fail";
  byId("metric-duplicates").textContent = number.format(data.latency.counters.duplicateTriggers);
  byId("metric-stale").textContent = number.format(data.latency.counters.staleTriggers);
  byId("metric-failures").textContent = number.format(data.latency.counters.providerFailures);

  const treatment = data.impact.groups.treatment;
  const holdout = data.impact.groups.holdout;
  const delta = data.impact.absolute_uplift;
  byId("impact-delta").textContent = `${delta > 0 ? "+" : ""}${percent(delta)}`;
  byId("impact-delta").classList.toggle("positive", delta >= 0);
  byId("impact-delta").classList.toggle("negative", delta < 0);
  byId("treatment-count").textContent = `${treatment.successes}/${treatment.judged} · ${number.format(treatment.viewers_assigned)} assigned`;
  byId("holdout-count").textContent = `${holdout.successes}/${holdout.judged} · ${number.format(holdout.viewers_assigned)} assigned`;
  byId("treatment-rate").textContent = percent(treatment.rate);
  byId("holdout-rate").textContent = percent(holdout.rate);
  byId("treatment-bar").value = Math.max(0, Math.min(100, treatment.rate * 100));
  byId("holdout-bar").value = Math.max(0, Math.min(100, holdout.rate * 100));
  byId("impact-interval").textContent =
    `95% interval: ${percent(data.impact.approximate_95pct_interval[0])} to ${percent(data.impact.approximate_95pct_interval[1])}`;
}

function createCell(primary, secondary = "", className = "") {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  const main = document.createElement("span");
  main.className = "cell-main";
  main.textContent = primary;
  cell.append(main);
  if (secondary) {
    const sub = document.createElement("small");
    sub.className = "cell-sub";
    sub.textContent = secondary;
    cell.append(sub);
  }
  return cell;
}

function createDecisionRow(decision) {
  const row = document.createElement("tr");
  const viewer = document.createElement("td");
  const viewerText = document.createElement("span");
  viewerText.className = "viewer-tag";
  viewerText.textContent = safeText(decision.viewer_id);
  viewer.append(viewerText);
  row.append(viewer);

  row.append(createCell(
    decision.goal?.id ?? "NO ACTIVE GOAL",
    decision.goal?.deadline ? `DUE ${decision.goal.deadline.replace("T", " ").slice(0, 16)}Z` : safeText(decision.reason)
  ));

  const action = document.createElement("td");
  const badge = document.createElement("span");
  const actionLabels = {
    HOME_PAGE: "HOME PAGE",
    HERO_SLOT: "HERO SLOT",
    PUSH: "PUSH",
    WHATSAPP: "WHATSAPP",
    IN_APP: "IN-APP"
  };
  const hasAction = decision.action !== "NO_ACTION";
  badge.className = hasAction ? "action-pill" : "no-action-pill";
  badge.textContent = hasAction ? `● ${actionLabels[decision.action] ?? decision.action}` : "— NO ACTION";
  action.append(badge);
  if (decision.message_template) {
    const template = document.createElement("small");
    template.className = "cell-sub";
    template.textContent = `template ${decision.message_template} · simulated`;
    action.append(template);
  } else if (decision.reason) {
    const detail = document.createElement("small");
    detail.className = "cell-sub";
    detail.textContent = decision.reason.replaceAll("_", " ");
    action.append(detail);
  }
  row.append(action);

  row.append(createCell(`${number.format(decision.evidence.length)} refs`,
    decision.dialect?.used ? `${decision.dialect.used} · ${decision.language ?? "language unknown"}` : "insufficient fresh evidence",
    "evidence-count"));
  const check = document.createElement("td");
  const checkBadge = document.createElement("span");
  checkBadge.className = decision.checks.failed.length ? "check-fail" : "check-pass";
  checkBadge.textContent = decision.checks.failed.length
    ? `${decision.checks.failed.length} BLOCKED`
    : `${decision.checks.passed.length} PASSED`;
  check.append(checkBadge);
  row.append(check);
  row.append(createCell(`${number.format(decision.decided_in_ms)} ms`, "", "latency-cell"));

  const details = document.createElement("td");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "detail-button";
  button.textContent = "↗";
  button.setAttribute("aria-label", `Inspect decision for ${decision.viewer_id}`);
  button.addEventListener("click", () => {
    byId("dialog-title").textContent = `${decision.viewer_id} · ${decision.decision_id}`;
    byId("dialog-content").textContent = JSON.stringify(decision, null, 2);
    byId("decision-dialog").showModal();
  });
  details.append(button);
  row.append(details);
  return row;
}

function renderDecisions() {
  const body = byId("decision-rows");
  body.replaceChildren();
  if (!state.decisions.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.className = "loading-cell";
    cell.textContent = "No decisions match this filter.";
    row.append(cell);
    body.append(row);
  } else {
    for (const decision of state.decisions) body.append(createDecisionRow(decision));
  }
  byId("decision-count").textContent = `Showing ${number.format(state.decisions.length)} of ${number.format(state.total)} matching decisions`;
  byId("load-more").disabled = state.offset >= state.total;
}

async function loadDecisions(reset = false) {
  if (reset) {
    state.requestId++;
    state.offset = 0;
    state.decisions = [];
  }
  const requestId = state.requestId;
  const url = new URL("/api/decisions", window.location.origin);
  url.searchParams.set("limit", state.limit);
  url.searchParams.set("offset", state.offset);
  if (state.query) url.searchParams.set("q", state.query);
  const page = await getJson(url);
  if (requestId !== state.requestId) return;
  state.total = page.total;
  state.decisions.push(...page.items);
  state.offset += page.items.length;
  renderDecisions();
}

async function init() {
  const [health, summary] = await Promise.all([
    getJson("/api/health"),
    getJson("/api/summary")
  ]);
  if (!["generated_mock", "provided_pack"].includes(health.mode)) {
    throw new Error("Unexpected service mode.");
  }
  byId("replay-mode").textContent = health.mode === "generated_mock"
    ? "SYNTHETIC REPLAY"
    : "PROVIDED DATA REPLAY";
  byId("health-status").textContent = "REPLAY HEALTHY";
  byId("health-dot").classList.remove("health-error");
  renderSummary(summary);
  await loadDecisions(true);
}

let searchTimer;
byId("decision-search").addEventListener("input", (event) => {
  state.query = event.target.value.trim().toLowerCase();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadDecisions(true).catch((error) => showToast(error.message)), 180);
});
byId("load-more").addEventListener("click", async () => {
  try {
    await loadDecisions();
  } catch (error) {
    showToast(error.message);
  }
});
byId("dialog-close").addEventListener("click", () => byId("decision-dialog").close());
byId("decision-dialog").addEventListener("click", (event) => {
  if (event.target === byId("decision-dialog")) byId("decision-dialog").close();
});

init().catch((error) => {
  byId("health-status").textContent = "REPLAY DATA UNAVAILABLE";
  byId("health-dot").classList.add("health-error");
  byId("decision-rows").replaceChildren();
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 7;
  cell.className = "loading-cell";
  cell.textContent = `Replay could not be loaded: ${error.message}`;
  row.append(cell);
  byId("decision-rows").append(row);
  showToast(error.message);
});
