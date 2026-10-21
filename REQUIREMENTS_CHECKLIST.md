# Challenge requirements verification

This check uses the supplied 279-line challenge brief and the files currently in this project. The brief specifies evaluation category weights, but does not provide a scoring formula or objective thresholds for assigning points within each category. “Implemented” describes code exercised with generated or normalized test data; it does not imply certification against unavailable challenge data.

## Challenge capabilities

| Requirement | Status | Evidence and remaining gap |
|---|---|---|
| One owner per viewer; one active measurable goal and plan | Implemented for single-process replay | `AgentEngine` serializes same-viewer triggers, keeps one active plan, applies rule corrections at the next viewer trigger, and records per-viewer state. It is not a distributed multi-worker service. |
| Evidence provenance, freshness, conflict resolution | Implemented for the normalized input contract | Decisions preserve source references, observed timestamps and freshness; current app setting takes precedence for dialect while conflicts remain visible. Actual feed schema mapping is unverified because exports were not supplied. |
| Choose among twelve candidate goals or abstain | **Implemented for any supplied valid goal catalogue; tested with twelve configurable rules. Challenge-specific catalogue verification unavailable.** | The engine selects the highest-priority eligible rule, records its evidence signal and deadline, and abstains when evidence is insufficient. Tests independently select each of twelve configured rules and verify that unsupported signals fail closed. The brief does not include the exact twelve definitions, so those specific rule semantics cannot be certified; this is missing-input verification, not a known missing engine feature. |
| Home page, hero slot, push, WhatsApp, in-app message, or no action | Implemented in replay mode | Rows, hero slots, and all three message-channel action types are supported. Channel actions are simulated, as allowed by the challenge's mock/replay requirement. |
| Respect actual dialect and language; avoid duplicate language variants | Implemented for normalized catalogue records | Titles and templates are independently checked; rows require three distinct works, using `work_id`/`canonical_title_id` when present. Actual catalogue mapping is unverified. |
| Consent, local quiet hours, message caps, approved templates | Implemented and policy-tested in replay mode | Requires explicit latest consent, valid timezone, local time outside 22:00–08:00, one message per local day across channels, and an approved dialect/language template. Generated consent/template records are synthetic, not actual approvals. |
| 60-second decision budget and 8-model/20-tool-call maxima | Verified locally for tested scenarios | Call-budget configuration is validated (up to 8/20); provider hooks time out and fail closed. The default path makes zero model calls. The 1,000-open burst passed locally. `npm run load-test:sustained` now measures a ten-minute synthetic run at three times its stated baseline. Neither test certifies hosted Render capacity. |
| Duplicate, stale, out-of-order, and dependency-failure handling | Implemented for tested scenarios | Regression tests cover idempotency, stale and out-of-order triggers, provider timeout, and explicit abstention. Slow/unavailable external file storage is not certified. |
| Close goals from attributable signals and record learning | Implemented for generated replay | Success requires matching signal, goal window, condition, and observation before judgment. Synthetic data does not validate the actual replay simulator. |
| Measure against randomized holdout | **Implemented and tested for replay assignments and outcomes; actual historical-pilot verification unavailable.** | Stable randomized assignment and intention-to-treat comparison report assigned, judged, pending, and inconclusive viewers. The report does not use served-versus-unserved as its causal comparison. The supplied brief describes a past pilot but does not include its assignment/outcome records or internal report; generated uplift is not actual pilot evidence. |
| Machine-readable decision evidence, assumptions, confidence, checks, timing, and no-action reason | Implemented | JSONL decisions include goal/signal/deadline, source provenance, confidence reason, assumptions, checks, latency, assignment and explicit no-action reasons. |
| Surprise-event behavior | Verified against implemented synthetic cases; supplied replay unavailable | Generated tests cover duplicate/stale/offline, purchase/profile conflict, dialect conflict, corrected rule, provider failure and untrusted catalogue text. The original timed replay script and its injected viewer/title/timing fixtures were not supplied, so exact replay certification is unavailable. |

## Technical submission

| Submission item | Status | Evidence and remaining gap |
|---|---|---|
| Runnable CLI/API and replay command | Implemented | `npm test`, `npm run replay`, `npm start`; normalized external JSON packs can be replayed with `--pack`. The supplied raw event files and timed replay script are absent. |
| Durable per-viewer state and audit outputs | Implemented for local single process | JSONL records and atomic per-viewer snapshots are produced. Distributed transactions, multi-writer locking, encryption, retention, and backup are not provided. |
| Provider abstraction or evaluator-friendly mock mode | Implemented | The evaluator-friendly replay uses no external model or API key; action delivery is explicitly simulated. |
| Automated tests for late/duplicate, conflicts, failure, and correction | Implemented | Test suite covers these cases plus messaging policy, generic goals, hero slots, and external-pack replay. |
| Sample decisions, actions, no-action reasons, outcomes, impact | Implemented for synthetic fixture | `sample_run/` contains replay artifacts; generated outcomes are simulated. |
| Architecture, AI collaboration, limitations notes | Implemented | See the corresponding project documents. |
| Actual 30-day pack, all 12 goal rules, intervention catalogue, pilot results, live replay script | **Source assets not included; exact-data verification unavailable** | The supplied attachment is the challenge brief, which describes these assets but does not contain the source files or pilot records. The separate package attachment is npm metadata. Generic rule selection and randomized-holdout analysis are implemented; exact rule definitions, feed mappings, historical pilot results, and surprise-event behavior cannot be certified without the corresponding inputs. |
| Render blueprint | Implemented | `render.yaml` defines a web service and health check. |
| Public cloud deployment | Deployed and health-checked | GitHub repository: [ott-dialect-platform](https://github.com/Shivateja832/ott-dialect-platform). Render service: [ott-dialect-platform-demo.onrender.com](https://ott-dialect-platform-demo.onrender.com). `/api/health` returned `status: ok` in `generated_mock` mode. |

## Local verification

The latest full test run passed all 38 tests, including independent eligibility selection for each entry in a generic twelve-rule catalogue. `npm run replay` completed with 121 decisions and 115 outcomes. The synthetic 1,000-open burst and hosted health check passed. A full local ten-minute synthetic test completed 18,000/18,000 decisions at 30 opens/second (three times the configured 10 opens/second baseline), with no failures, p95 end-to-end handling latency 711 ms and max 4.38 seconds. This single-machine FileStore test does not certify Render capacity or the missing supplied replay.

## Accurate completion statement

The repository is published to GitHub and deployed to Render as a hosted synthetic replay demo. The public health check is passing. Goal selection and randomized-holdout analysis are implemented for supplied valid rules and replay inputs and have local regression coverage. The exact goal catalogue, source event/profile/catalogue data, historical pilot records/report, and timed replay were not included, so their challenge-specific results cannot be verified. This describes an unavailable-input verification boundary, not a known partial implementation of those two capabilities. Challenge-permitted replay mode is the deployed scope.

## Root cause of unverified items

The remaining verification boundary is missing challenge evidence, not an undiscovered set of application features:

| Unverified item | Root cause | What the current project does |
|---|---|---|
| Exact twelve-goal behavior | The brief names two examples and describes (but does not define) the other candidates, including underspecified rules and a missing signal. | Goal-selection capability is implemented for a supplied ruleset; regression tests exercise twelve independent configured rules. Explicitly underspecified or unavailable-signal rules fail closed. Exact rule semantics remain unverified until the definitions are supplied; no missing definitions are guessed. |
| Supplied replay acceptance | The timed replay program and its actual triggers/outcome simulator were not supplied. | Runs the normalized trigger sequence and tests representative surprise cases (late/duplicate/out-of-order, conflicts, rule correction, dependency failure, untrusted catalogue text). |
| Actual pilot impact | The pilot assignment/outcome records and internal report were not supplied. | The randomized-holdout analysis capability is implemented and produces an intention-to-treat report for replay assignments/outcomes. The generated report is explicitly synthetic; reproducing or validating the historical pilot result requires its actual records and internal report. |
| Render production capacity | A local benchmark cannot establish hosted service limits. | The public demo is health-checked; a local 10-minute synthetic run passed at 30 opens/second. The challenge does not specify an exact Render plan or numeric production baseline. |

Real provider delivery and multi-worker database storage are not required by the brief's evaluator-friendly mock/replay constraint and are not counted as challenge gaps. The brief's category weights (20%, 15%, 15%, 15%, 15%, 10%, 10%) sum to 100%, but they are not a completion formula: the brief supplies no per-category scoring rules or objective pass thresholds. This project therefore does not claim an overall completion percentage or recruiter score. Report test results separately (the latest run passed 38/38 tests); a test pass rate is not an application-completion score.
