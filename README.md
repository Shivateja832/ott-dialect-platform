# OTT Dialect Platform — one-viewer lifecycle agent

A runnable decision-and-measurement demo for the supplied engineering challenge. The default replay uses generated synthetic data. It is not connected to a live OTT audience or messaging service.

## Included

- Per-viewer goal selection and durable decision, action, outcome, and evidence records.
- Data-driven goal rules. The engine accepts any number of goal rules in the normalized pack format; it does not invent missing definitions. Rules marked `underspecified: true` or whose success signal is absent from `eventTypes` are disabled safely.
- Home-page rows, hero slots, and push, WhatsApp, and in-app message actions in replay mode.
- Independent checks for dialect, language, catalogue availability, minimum row size, explicit channel consent, local timezone, 22:00–08:00 quiet hours, approved matching templates, one message per local day, duplicate triggers, and action caps.
- Explicit mock delivery: no live messages or OTT changes are sent.
- Dependency timeout and configurable per-decision budgets (maximum 8 model calls and 20 tool calls). The default engine uses no model.
- A dashboard and read-only API for the latest replay artifacts.

## Requirements and local run

- Node.js 20 or newer
- No npm packages, external model, API key, or database server required

```powershell
npm test
npm run replay
npm start
```

Open `http://localhost:3000`. `npm run replay` regenerates the sample in `sample_run\`. It replaces only app-managed files in a directory with a matching manifest and refuses to overwrite unrelated or differently sourced data.

Run a synthetic concurrent-open benchmark:

```powershell
npm run load-test
```

The benchmark defaults to 1,000 unique viewer opens in one burst and prints throughput and decision latency. This is a local synthetic benchmark, not a Render or production capacity guarantee. To change the viewer count, run `node scripts\benchmark.mjs 2000`.

## Replaying a supplied pack

The challenge data files and timed replay script were not present in this workspace. To replay the supplied files, normalize them to one JSON document and run:

```powershell
node src\cli.js replay --pack .\normalized-pack.json --out .\pack_run
```

The normalized JSON requires arrays named `events`, `eventTypes`, `profiles`, `appSettings`, `campaignLinks`, `consents`, `catalogue`, and `triggers`, plus a `goalRules` object keyed by goal ID. `interventionCatalogue` should contain a `templates` array and may define `channelPriority` and `heroSlot.enabled`. A trigger sequence may include `{ "type": "rule_correction", "correction": { ... } }` entries. Optional `judgment_at` sets the outcome judgment time. An optional `simulator` is used only when explicitly included.

Each goal rule needs `id`, `version`, `evidence` (the success event type), `windowHours`, and `priority`. It may also include `condition`, `eligibility`, and `enabled`. Eligibility supports `requiresSignup`, `requireEventTypes`, `excludeEventTypes`, `excludeEvents`, `profileEquals`, and `profileNotEquals`. Unsupported signals and explicitly underspecified rules fail closed. A provided-pack output is tied to the input file's SHA-256; use a new output directory when the input changes.

To serve a separate replay output in the dashboard, set `REPLAY_DIR` before starting the server, for example: `$env:REPLAY_DIR='.\pack_run'; npm start` in PowerShell.

Message consent records use `{ id, viewer_id, channel, granted, received_at }`, where `channel` is `PUSH`, `WHATSAPP`, or `IN_APP`. Templates must be explicitly approved and match the viewer's resolved dialect and language. The replay only records simulated delivery; live providers, credentials, approved vendor templates, and a production action sink are not included.

## Deployment status

`render.yaml` configures a Node web service and `/api/health` check. The application source is published at [github.com/Shivateja832/ott-dialect-platform](https://github.com/Shivateja832/ott-dialect-platform) and the Render service is live at [ott-dialect-platform-demo.onrender.com](https://ott-dialect-platform-demo.onrender.com). The public health check was verified and returned `status: ok`, `mode: generated_mock`. This is a hosted synthetic demo, not a live OTT integration or certification against the unavailable challenge pack.

## Requirement verification

See [REQUIREMENTS_CHECKLIST.md](./REQUIREMENTS_CHECKLIST.md) for the challenge-by-challenge status and remaining external blockers. See [ARCHITECTURE.md](./ARCHITECTURE.md), [AI_COLLABORATION.md](./AI_COLLABORATION.md), and [KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md) for design, validation, and scope.
