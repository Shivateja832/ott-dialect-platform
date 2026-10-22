# Challenge requirement and scoring-warning checklist

This checklist maps the supplied challenge brief to the implementation and current local evidence. In the warning table below, **Yes means the poor-scoring pattern is present; No means it is avoided in the stated, tested scope.** “No” does not certify against challenge source files that were not supplied.

## “What will score poorly” warnings — presence check

| Poor-scoring pattern present? (Yes = risk is present; No = avoided in tested scope) | Warning in the brief | Evidence and scope |
|---|---|---|
| **NO — avoided for the default replay** | One prompt picks titles for every viewer | Decisions are made per viewer by deterministic, evidence-backed rules. The default replay uses no model calls. |
| **NO — for configured rules and tested evidence cases** | Goals or eligibility asserted without evidence | Goal eligibility is checked against configured rules and viewer facts; insufficient evidence produces abstention. Tests cover twelve configurable rules. The exact challenge goal definitions were not supplied, so their specific semantics remain unverified. |
| **NO — in replay mode** | Messages sent in the wrong dialect, at night, or without consent | Independent policy checks cover dialect/language, consent, local quiet hours, approved templates, and daily caps. Actions are simulated, not sent. Tests use generated/normalized policy data. |
| **NO — for the implemented impact report** | Uplift reported from served versus unserved viewers | The impact report compares stable randomized assignment (intention-to-treat), not delivery status. The sample outcomes and reported effect are synthetic, not historical pilot results. |
| **NO — for tested cases** | Late or duplicate events ignored | Tests exercise stale offline triggers, duplicate idempotency, and out-of-order events; the replay summary records stale and duplicate cases. |
| **NO — no global viewer sweep** | Every viewer reprocessed after a rule change | Rule corrections are applied when that viewer next triggers. Inactive viewers are not proactively refreshed. |
| **NO — current code was run through the test suite** | AI-generated code submitted without running tests | The latest recorded local test run passed 38/38 tests. This verifies the suite, not the unavailable challenge replay or all possible inputs. |

## Evaluation categories

The challenge assigns category weights but does not define point-level scoring criteria or a formula for awarding points. This project therefore records evidence and scope rather than claiming a numeric recruiter score.

| Evaluation area | Weight | Implementation evidence | Boundary |
|---|---:|---|---|
| Goal and decision quality | 20% | Evidence-backed, data-driven goal selection; deadlines; abstention; tests exercise twelve configurable rules. | Exact challenge goal definitions are unavailable. |
| Evidence and state | 15% | Source/freshness references, visible conflicts, per-viewer snapshots and audit logs. | File persistence is single-process, not distributed production storage. |
| Real-time reliability | 15% | Decision latency measured in replay; stale/duplicate and dependency-failure cases tested; local synthetic sustained-load script. | Synthetic local performance does not certify Render capacity. |
| Verification and safety | 15% | Independent action checks for eligibility, catalogue, dialect/language, consent, quiet hours, approved templates, and message caps. | Exercised with generated/normalized policies; live delivery is intentionally not enabled. |
| Measurement and learning | 15% | Attribution to configured success signals; intention-to-treat randomized holdout reporting; lessons recorded per viewer. | Sample impact is synthetic; historical pilot records/report were not supplied. |
| Engineering quality | 10% | Runnable CLI/API, tests, sample replay, architecture, setup instructions. | Challenge-provided replay assets were unavailable for exact reproduction. |
| Use of AI tools | 10% | AI collaboration log records requirements-review scope and validation boundaries. | A numeric evaluator score cannot be inferred from the log. |

## Submission requirements

| Required item | Present? | Location / note |
|---|---|---|
| Runnable CLI/API, setup instructions, replay command | **Yes** | `README.md`; `npm run replay` runs the generated replay, and the CLI accepts a normalized pack. The challenge's own timed script was not supplied. |
| Durable per-viewer state, evidence, decisions | **Yes for single-process replay** | `src/store.js`, `sample_run/viewer_state/`, and `sample_run/decisions.jsonl`. |
| Provider abstraction or API-key-free mock mode | **Yes** | Replay mode uses simulated actions and no external API key. |
| Tests for late/duplicate trigger, conflict, dependency failure, corrected rule | **Yes** | `tests/`; run `npm test`. |
| Sample decisions, actions, no-action reasons, outcomes, impact report | **Yes** | `sample_run/`; generated synthetic data and outcomes. |
| Architecture note | **Yes** | `ARCHITECTURE.md`. |
| AI collaboration log | **Yes** | `AI_COLLABORATION.md`. |
| Known limitations note | **Yes** | `KNOWN_LIMITATIONS.md`. |

## Latest local verification recorded

The latest test run passed 38/38 tests. The generated replay completed with 121 decisions and 115 outcomes. `sample_run/latency_report.json` reports 121 decisions, p95 33 ms, maximum 76 ms, and all measured decisions within the 60-second budget. Sample impact results are synthetic. These results are not a challenge-wide completion score.
