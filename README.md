# Spike detector

BDK bot that triages Budgetsphere metric anomalies. A mock observability
app (not in this repo) posts an alert. The bot decides whether the spike
matches a recent change in
[internalsphere/jg-budgetsphere](https://github.com/internalsphere/jg-budgetsphere).
Expected changes are logged and not paged. Bugs are investigated by a
Cursor cloud agent, filed in Linear, and held for a Slack sign-off before
the fix pull request. A GitHub wake plus a reminder watch the preview
environment `preview-<pr number>` until the metric returns to baseline.

Defaults chosen for this demo:

- Model `grok-4.5` with `effort=high` and `fast=true`
- Package name and deploy slug `spike-detector`
- Cloud agent `startingRef` `demo/base`, overridable at launch time. Fix pull requests target that ref.
- Slack env prefix `SPIKE_DETECTOR`
- Recovery band: 10% of `max(|baseline|, 1)`
- Explanation band in the skill: 15% of a stated target
- Linear connector name `Linear` (see the TODO in `bot/mcp-connections/account.ts`)

## Flow

1. `POST /alert` on the `observability` channel. The same `incidentId` does
   not start a second session.
2. `list_recent_changes` reads commits and pull requests with
   `ctx.host.github.getOctokit()`.
3. The `expected-vs-bug` skill picks expected or bug. Expected calls
   `log_expected_change` and stops.
4. A bug calls `launch_triage`, which starts a cloud agent from
   `demo/base` (or `BUDGETSPHERE_STARTING_REF`) and must not edit code
   yet. `autoCreatePR` is on so the later fix follow-up opens a pull
   request against that same branch.
5. `page_code_owner` posts in the configured Slack channel. The incident
   record in host KV, keyed `incident:<id>`, is how the Slack thread
   resumes the incident.
6. `open_linear_issue` files the ticket in workspace `fe-demo`, project
   `Budgetsphere`.
7. After an explicit Slack sign-off, `record_signoff` wakes the incident
   session and `request_fix` tells that same cloud agent to open the PR
   against `demo/base`, or against the starting ref stored at launch.
8. GitHub pull request events that contain `incident:<id>`, and the
   `preview_watch` reminder, poll `query_metrics` for env `preview-<pr>`.
9. `close_incident` comments on Slack and Linear, closes the ticket, and
   cancels the reminder.

`POST /metrics` only stores snapshots in KV. It does not start a turn.

## Auth

The observability channel uses `sharedSecretAuth` on header
`X-Observability-Token` and secret `OBSERVABILITY_SHARED_SECRET`.

HMAC is not the admitting policy. On Cursor hosting, `X-BDK-Session-Key`
is rejected with 400 when `hmacSignatureAuth` or `publicEndpoint` admits
the route. Send the session key so retries join one hosted session:

```text
X-BDK-Session-Key: incident:<id>
```

Local `bdk serve` ignores that header. The handler also passes
continuation token `incident:<id>`, which is what local runs join on.

Hosted custom routes answer `202` with an empty body before the handler
runs. A duplicate `incidentId` also returns `202` and does not start
another turn. Host KV has no compare-and-swap, so two deliveries that
arrive together can both pass the read. The paging tools are idempotent
on the incident record.

TODO: if a hosted call that sends only `X-Observability-Token` returns
401, also send `X-Agent-Alias-Token`. The deployment guide shows the
alias token on custom routes; the webhooks guide says `sharedSecretAuth`
is the catch policy for callers that cannot send it.

## Setup

Node 22.13 or newer. Do not use Bun.

```bash
npm install
npm run check
npx bdk validate
npx bdk info --json
```

Copy `.env.example` to `.env.local` and set `OBSERVABILITY_SHARED_SECRET`
before calling the channel locally. `bdk` loads `.env.local`.

GitHub events use the signed-in Cursor account
(`bdk login` or `CURSOR_API_KEY`). Connect GitHub for
`internalsphere/jg-budgetsphere` in the Cursor dashboard. Local event
pull:

```bash
npx bdk serve --dir . --mode single --cursor-events \
  --repo internalsphere/jg-budgetsphere
```

`--dev` does not fire schedules or reminders. Dispatch a reminder with
`POST /v1/dev/reminders/<id>`.

### Slack

The demo Slack workspace is configured later. `bot/channels/slack.ts`
uses env prefix `SPIKE_DETECTOR`. When the workspace is ready:

```bash
npx bdk login
npx bdk slack create --dir . --name "Spike Detector" --prefix SPIKE_DETECTOR
npx bdk slack doctor --prefix SPIKE_DETECTOR
```

`slack create` can rewrite `bot/channels/slack.ts` if it was missing. If
it overwrites this file, put `envPrefix: "SPIKE_DETECTOR"` back.

Then set the paging target, either in `.env.local` or as deployment
secrets:

- `SPIKE_DETECTOR_SLACK_CHANNEL` — channel id `C…` or `#name`
- `SPIKE_DETECTOR_CODE_OWNER_SLACK_ID` — member id `U…`

Until those are set, `page_code_owner` returns
`slack_channel_unconfigured` and does not post.

### Linear

Connect Linear on the Cursor account that hosts the bot. The issue goes
to workspace `fe-demo`, project `Budgetsphere`. The connection is
`optional` so the process still starts before that connector exists.

### Cloud agent ref

`startingRef` defaults to `demo/base` in `bot/lib/demo.ts`. The cloud
agent extension and `launch_triage` both read `budgetsphereRepo()`, so
the agent starts on that branch. `request_fix` tells the follow-up to
open the pull request against the ref stored at launch. A launch reads
`BUDGETSPHERE_STARTING_REF` at call time when it is set. On Cursor
hosting, set that name with `bdk secret set` so the value exists per
request. An empty value keeps `demo/base`.

## Deploy

Deploy from a pushed git ref with an account on team
`cursor-field-eng-adm`. This repo does not deploy itself.

```bash
npx bdk login
npx bdk whoami
npx bdk validate
npx bdk deploy --dir . --slug spike-detector \
  --cursor-events-repo internalsphere/jg-budgetsphere
```

Set secrets after the first deploy. `secret set` reads the value from
stdin and does not echo it.

```bash
printf %s "$OBSERVABILITY_SHARED_SECRET" | npx bdk secret set spike-detector OBSERVABILITY_SHARED_SECRET
printf %s "$SPIKE_DETECTOR_SLACK_CHANNEL" | npx bdk secret set spike-detector SPIKE_DETECTOR_SLACK_CHANNEL
printf %s "$SPIKE_DETECTOR_CODE_OWNER_SLACK_ID" | npx bdk secret set spike-detector SPIKE_DETECTOR_CODE_OWNER_SLACK_ID
printf %s "demo/base" | npx bdk secret set spike-detector BUDGETSPHERE_STARTING_REF
npx bdk secret list spike-detector
```

Slack bot tokens come from `bdk slack create`, not from this list. The
first deploy prints an alias token once. Store it outside the terminal
transcript. The stable route is `$AGENT_ALIAS_URL`.

No extra egress hosts are declared. GitHub, Slack, and account-level
Linear calls go through the host clients and the Cursor backend.

## Required secrets

| Name | Required for |
| --- | --- |
| `OBSERVABILITY_SHARED_SECRET` | `POST /alert` and `POST /metrics` |
| `SPIKE_DETECTOR_SLACK_BOT_TOKEN` | Slack Socket Mode, from `slack create` |
| `SPIKE_DETECTOR_SLACK_APP_TOKEN` | Slack Socket Mode, from `slack create` |
| `SPIKE_DETECTOR_SLACK_CHANNEL` | Paging the code owner |
| `SPIKE_DETECTOR_CODE_OWNER_SLACK_ID` | The `@` mention. Empty posts without a mention |
| `BUDGETSPHERE_STARTING_REF` | Optional. Empty uses `demo/base` for the cloud agent and the fix PR base |

The host also needs a Cursor credential (`bdk login`, `CURSOR_API_KEY`,
or `CURSOR_SERVICE_ACCOUNT_KEY`) to run model turns and cloud agents.
Do not put `CURSOR_*` in `hosting.secretNames`.

## curl

Local single-mode server (`npx bdk serve --dir . --mode single --dev`):

```bash
export OBSERVABILITY_SHARED_SECRET=dev-secret

curl -sS -D - -X POST http://127.0.0.1:3000/v1/channels/observability/alert \
  -H "X-Observability-Token: $OBSERVABILITY_SHARED_SECRET" \
  -H "X-BDK-Session-Key: incident:inc-1001" \
  -H 'content-type: application/json' \
  -d '{"incidentId":"inc-1001","metric":"budget_used","env":"prod","baseline":100,"value":180,"window":"30m"}'

curl -sS -D - -X POST http://127.0.0.1:3000/v1/channels/observability/metrics \
  -H "X-Observability-Token: $OBSERVABILITY_SHARED_SECRET" \
  -H 'content-type: application/json' \
  -d '{"metric":"budget_used","env":"preview-42","value":102,"baseline":100,"window":"5m"}'
```

A second alert with the same `incidentId` returns `202` and does not
start another turn.

Hosted, prefix the alias token when the deployment requires it:

```bash
curl -sS -D - -X POST "$AGENT_ALIAS_URL/v1/channels/observability/alert" \
  -H "X-Agent-Alias-Token: $AGENT_ALIAS_TOKEN" \
  -H "X-Observability-Token: $OBSERVABILITY_SHARED_SECRET" \
  -H "X-BDK-Session-Key: incident:inc-1001" \
  -H 'content-type: application/json' \
  -d '{"incidentId":"inc-1001","metric":"budget_used","env":"prod","baseline":100,"value":180,"window":"30m"}'
```

Multi-agent serve mounts the same routes under `/<directory-name>/v1/...`.

Direct tool check, no model turn:

```bash
npx bdk tool call query_metrics --dir . \
  --input '{"metric":"budget_used","env":"preview-42"}'
```

## Evals

```bash
npx bdk eval --dir . --list
npx bdk eval --dir . --tag smoke
```

Model turns need a Cursor credential. Eval sessions do not post to Slack,
open Linear issues, or launch cloud agents. `list_recent_changes` reads
`fixtures/changes.json` when `purpose` is `eval`.

- `expected` — `exp-budget-raise`, metric `budget_used` at 118 versus a
  merged change whose target is 120. Logs the note and does not page.
- `bug` — `bug-latency-spike`, metric `checkout_p95_ms` at 1800 with only
  a README commit. Records a bug and calls the page tools.

## Layout

| Path | Role |
| --- | --- |
| `bot/instructions.md` | Tool order and reply shape |
| `bot/skills/expected-vs-bug/SKILL.md` | Expected versus bug rubric |
| `bot/channels/observability.ts` | `POST /alert`, `POST /metrics` |
| `bot/channels/github.ts` | Preview pull request wakes |
| `bot/channels/slack.ts` | Sign-off thread |
| `bot/extensions/cloud/` | Cloud agents on Budgetsphere. Launch and reply are disabled |
| `bot/mcp-connections/account.ts` | Cursor account Linear |
| `bot/tools/` | One tool per file |
| `bot/reminders/` | Sign-off backup wake and preview poll |
| `evals/` | Expected and bug cases |

## TODOs

- Confirm hosted auth if the secret header alone returns 401 (above).
- Add connector name `Linear MCP` if `servers: ["Linear"]` does not match
  the dashboard connector.
- `close_incident` returns a TODO in the tool result when it cannot find
  a completed Linear status. Finish that close with the advertised Linear
  tools.
- Reminder handlers cannot call `query_metrics` directly. `preview_watch`
  reads the same KV records, then the woken turn calls the tool.
- Reprocessing one `incidentId` means removing KV key `incident:<id>`.
  There is no documented KV admin command for that.
