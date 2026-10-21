# Architecture and trust boundaries

## Ownership and planning

`AgentEngine` is the single owner of a viewer's experiment assignment, one active goal, action timestamp and processed trigger history. A stable hash assigns each viewer to treatment or holdout. Goal choice is rule-based and evidence-bound; the model/provider is an optional dependency hook, never the authority for eligibility. The evaluator accepts rule IDs beyond the two examples in the generated fixture. Unsupported event signals and explicitly underspecified rules are disabled rather than guessed. A viewer with a current active plan keeps it until a success signal, deadline, or changed evidence causes it to close or be revised. Corrected goal rules are validated and applied to active plans on their next trigger rather than sweeping every viewer.

## Evidence and source resolution

`resolveFacts` filters events and profiles to those received/updated by decision time, retains source identifiers and timestamps, and emits freshness descriptions. For the dialect shown on a trigger, precedence is current app setting, latest campaign link received by decision time, then profile snapshot. Lower-precedence disagreements are emitted in `dialect.conflicts`, not discarded. Future-dated app settings and campaign links are excluded. Language uses the current app setting, then the profile language, and is independently checked against the catalogue. Purchase events are considered alongside the daily profile so a stale “trial” snapshot cannot override a later purchase. Missing signup evidence prevents goal eligibility.

Decision evidence refers to source event, profile snapshot, app setting, goal rule version and catalogue records. The generated data is synthetic and explicitly marked; no viewer facts are invented by a model.

## Action and independent verification

Replay actions include a home-page row, a hero slot, push, WhatsApp, in-app message, or `NO_ACTION`. Home-page rows require at least three distinct works in the resolved dialect and language and within their availability windows; variants sharing a `work_id` or `canonical_title_id` count once. A hero slot requires one independently verified title. Message actions require explicit latest consent, a resolvable viewer timezone, local send time outside 22:00–08:00, no message already logged that local day across channels, and an approved template matching dialect and language. The verifier independently re-looks up selected catalogue/template IDs and checks goal eligibility, rule version, freshness, caps, and action constraints. The replay provider records simulated actions only; it does not send a message or change a live OTT application.

Consent is resolved from the latest explicit consent event received by decision time. Unknown or invalid timezone context fails closed for message delivery. Template bodies and catalogue descriptions are untrusted data, never model instructions or proof of approval.

## Memory and audit

The file store keeps append-only JSONL decision/action/outcome logs and per-viewer JSON snapshots. A trigger ID is the idempotency key; duplicates return the original decision. Snapshot writes use a temporary file followed by rename. The sample CLI is sequential and intended for one process; distributed locks, transactional event storage, retention and encryption are production requirements.

## Latency and dependency failure

Each trigger is handled synchronously without a model call in the default path. Viewer facts and catalogue candidates are indexed when the pack is loaded so each decision does not repeatedly scan the entire feed. Provider hooks have a bounded timeout; configurable call budgets are capped at 8 model calls and 20 tool calls per decision. A failed or over-budget dependency records an explicit failure and blocks intervention. Stale buffered opens older than five minutes are explicitly recorded as no-action decisions. Calls to external models are unnecessary for the current deterministic eligibility and safety logic.

`npm run load-test` concurrently exercises 1,000 unique synthetic viewer opens and checks the 60-second decision budget. The result is local to the executing machine and does not prove sustained ten-minute surge capacity or Render performance. The replay CLI processes its normal sample sequentially. A production worker should partition by viewer, use durable queue acknowledgements and per-viewer serialization, and enforce a deadline before dispatch.

The optional web surface is a read-only Node HTTP server over the generated sample artifacts. It has no mutation or replay endpoint, exposes a health route, validates pagination, serves only a fixed asset list, and applies same-origin/security headers. It is a recruiter dashboard, not a production agent execution service.

## Outcome measurement

The replay judges success only when an event matching the active goal's success signal falls between plan start and deadline. Missing success at deadline becomes `FAILED`; stale opens without enough trustworthy context abstain. A randomized holdout is compared by assigned group (intention-to-treat), not by “served” versus “not served.” The report includes group denominators, rates, absolute difference and an approximate uncertainty interval. The simulator injects outcomes for a reproducible demo; the generated uplift is not a production causal claim.

## Trust boundaries

- Viewer, profile, app-setting, campaign, event, catalogue and model/provider inputs are untrusted data.
- The deterministic policy and verifier—not generated content—authorize actions.
- No real personal data or retaining hosted AI service is used in this mock.
- No real message is sent and no payment is initiated; the challenge pack's intervention catalogue and approved vendor templates were not supplied.
- Human review, production policy/legal review, access control, encryption, retention, observability and service-level testing remain deployment gates.
