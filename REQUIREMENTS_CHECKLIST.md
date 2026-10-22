# Requirements and evidence checklist

This checklist maps the requirements explicitly supplied for the application: submission artifacts, evaluation categories, and technical discussion topics. Items not listed as deliverables are not counted as missing repository requirements.

## Submission requirements

| Requirement from the brief | Status | Evidence and boundary |
|---|---|---|
| Runnable CLI or API with setup instructions and a replay command | **Met** | `README.md`; `npm run replay` runs the sample, and the CLI accepts a normalized pack. |
| Durable per-viewer state, evidence references, and decision outputs | **Met for the replay implementation** | `src/store.js`, `sample_run/viewer_state/`, and decision logs. Persistence is single-process file storage, not a distributed production datastore. |
| Provider abstraction or mock mode without evaluator API keys | **Met** | The generated replay uses mock/simulated actions and no personal API key. |
| Automated tests for late/duplicate triggers, conflicting sources, tool failure, and a corrected goal rule | **Met for implemented cases** | `tests/`; latest `npm test` passed 41 tests, including assignment balance, injected catalogue content, and restart persistence. |
| Sample replay with decisions, actions, reasons for no action, outcome judgments, and impact report | **Met with synthetic replay data** | `sample_run/`. The synthetic impact result is not historical pilot evidence. |
| Architecture note covering ownership, planning, memory, verification, latency, recovery, and trust boundaries | **Met** | `ARCHITECTURE.md`. |
| AI collaboration log | **Met** | `AI_COLLABORATION.md`. |
| Known-limitations note | **Met** | `KNOWN_LIMITATIONS.md`. |

## Evaluation evidence

The challenge supplies category weights, but no point-by-point scoring rubric or formula. These are evidence notes, not numeric score claims.

| Evaluation area | Weight | Evidence in this application | Boundary to keep explicit |
|---|---:|---|---|
| Goal and decision quality | 20% | Evidence-backed configurable goal rules, deadlines, abstention, and tests for twelve configured rules. |
| Evidence and state | 15% | Source and freshness references, visible conflicts, per-viewer state snapshots, and audit logs. The store is single-process file persistence. |
| Real-time reliability | 15% | Duplicate, stale, out-of-order, and dependency-failure tests; replay latency report and local load scripts. |
| Verification and safety | 15% | Independent action checks for eligibility, dialect/language, catalogue availability, consent, quiet hours, templates, and caps; a regression test excludes catalogue items flagged with prompt-injection content. Replay delivery is simulated. |
| Measurement and learning | 15% | Outcome attribution, randomized-assignment comparison with all assignments in the primary denominator, and per-viewer lessons. Tests verify assignment balance and incomplete-follow-up reporting. Sample outcomes are synthetic. |
| Engineering quality | 10% | Runnable CLI/API, automated tests, reproducible sample, and technical documentation. |
| Use of AI tools | 10% | `AI_COLLABORATION.md` records how AI-assisted analysis and implementation were checked and where the user corrected the assistant's scope or conclusions. |

## Technical discussion preparation

| Discussion topic from the brief | Where the implementation supports the explanation |
|---|---|
| How the agent decides whether viewer information is current | `ARCHITECTURE.md` describes timestamp filtering, source precedence, and freshness. |
| When the agent does nothing | Rule eligibility, evidence checks, stale-trigger handling, and policy failures produce recorded abstentions; see `tests/core.test.js`. |
| How to distinguish impact from selection | Stable randomized assignment and the intention-to-treat sample report; outcomes are synthetic. |
| What happens during a burst of opens | `npm run load-test` exercises 1,000 synthetic opens; `ARCHITECTURE.md` documents current single-process limits and a production scaling approach. |
| Which decisions should not be automated | Actions are simulated; the independent verifier enforces consent and safety policy before recording an action. |
| How to scale to 10 million viewers and 40 dialects | `ARCHITECTURE.md` describes partitioning and durable queues as a production design; this scale is not implemented or claimed by the demo. |
| What AI-generated work was challenged or rejected | `AI_COLLABORATION.md` records the user's correction to the assistant's earlier scoring scope and the resulting evidence-based revision. |

## Current verification record

- Automated tests: **41 passed, 0 failed** on the latest run.
- Sample replay: **121 decisions and 115 outcomes**.
- Synthetic burst: **1,000/1,000 opens** completed in **11.9 seconds**, with **83.78 decisions/second** and **7.92-second p95**; this is a local result, not hosted capacity certification.
- The generated impact report uses all randomized assignments as its primary denominator. Its treatment/holdout result is synthetic and is not a production causal estimate.
- The hosted health endpoint and live summary were checked after the latest published measurement change and responded successfully.
