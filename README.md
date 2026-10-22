# Spike detector

BDK bot that triages marketplace metric anomalies. A mock observability
app (not in this repo) posts an alert. The bot decides whether the spike
matches a recent change in
[jgrace19/marketplace](https://github.com/jgrace19/marketplace).
Expected changes are logged and not paged. Bugs are investigated by a
Cursor cloud agent, filed in Linear, and held for a Slack sign-off before
the fix pull request. A GitHub wake plus a reminder watch `preview-<pr>`
until GMV and average order value are back within 10% of baseline.

Defaults chosen for this demo:

- Model `grok-4.5` with `effort=high` and `fast=true`
- Package name and deploy slug `spike-detector`
- Cloud agent `startingRef` `demo/base`, overridable at launch time. Fix pull requests target that ref.
- Slack env prefix `SPIKE_DETECTOR`
- Recovery band: 10% of `max(|baseline|, 1)`
- Explanation band in the skill: 15% of a stated target
- Linear workspace `fe-demo`. Project defaults to `Marketplace`, overridable with `LINEAR_PROJECT`
- Linear MCP is `https://mcp.linear.app/mcp` with a fe-demo personal API key (`LINEAR_TOKEN`), not the team's Cursor Linear connector
- Deploy ready: GitHub CI success on the fix pull request, or the first `preview-<pr>` metric snapshot. No deployment-host URL

## Flow

1. `POST /alert` on the `observability` channel. The same `incidentId` does
   not start a second session.
2. `list_recent_changes` reads commits and pull requests in
   `jgrace19/marketplace` with `ctx.host.github.getOctokit()`.
3. The `expected-vs-bug` skill picks expected or bug. Expected calls
   `log_expected_change` and stops. A checkout drop of about 32% in
   `freshcart.checkout.gmv_cents` and
   `freshcart.checkout.average_order_value_cents`, with orders and units
   flat, is a bug. The skill does not name a code change.
4. A bug calls `launch_triage`, which starts a cloud agent from
   `demo/base` (or `MARKETPLACE_STARTING_REF`) and must not edit code
   yet. `autoCreatePR` is on so the later fix follow-up opens a pull
   request against that same branch.
5. `page_code_owner` posts in the configured Slack channel. The incident
   record in host KV, keyed `incident:<id>`, is how the Slack thread
   resumes the incident.
6. `open_linear_issue` files the ticket in workspace `fe-demo`. The
   project is `LINEAR_PROJECT`, or `Marketplace` when that is unset.
7. After an explicit Slack sign-off, `record_signoff` wakes the incident
   session and `request_fix` tells that same cloud agent to open the PR
   against `demo/base`, or against the starting ref stored at launch.
8. The preview is ready when GitHub CI on that pull request succeeds, or
   when the first snapshot is stored for env `preview-<pr>`. The
   `preview_watch` reminder then polls `query_metrics`.
9. `close_incident` runs only when both GMV and average order value are
   within 10% of baseline. It comments on Slack and Linear, closes the
   ticket, and cancels the reminder.

`POST /metrics` stores snapshots in KV and records the first
`preview-<pr>` arrival. It does not start a turn.

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
`jgrace19/marketplace` in the Cursor dashboard. Local event pull:

```bash
npx bdk serve --dir . --mode single --cursor-events \
  --repo jgrace19/marketplace
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

Linear is a direct MCP connection to `https://mcp.linear.app/mcp`, with
header `authorization: Bearer ${LINEAR_TOKEN}`. Create `LINEAR_TOKEN` as a
personal API key in the fe-demo Linear workspace. The team's Cursor Linear
integration points at a different workspace, so this bot does not use it.
Issues still go to workspace `fe-demo`. The project name defaults to
`Marketplace`. Set `LINEAR_PROJECT` to use another project there. The
connection is `optional`, so a missing token omits Linear instead of
failing the turn. GitHub events stay on the channel's Cursor account.

### Cloud agent ref

`startingRef` defaults to `demo/base` in `bot/lib/demo.ts`. The cloud
agent extension and `launch_triage` both read `marketplaceRepo()`, so
the agent starts on that branch of `jgrace19/marketplace`. `request_fix`
tells the follow-up to open the pull request against the ref stored at
launch. A launch reads `MARKETPLACE_STARTING_REF` at call time when it
is set. On Cursor hosting, set that name with `bdk secret set` so the
value exists per request. An empty value keeps `demo/base`.

## Deploy

Deploy from a pushed git ref with an account on team
`cursor-field-eng-adm`. This repo does not deploy itself.

```bash
npx bdk login
npx bdk whoami
npx bdk validate
npx bdk deploy --dir . --slug spike-detector \
  --cursor-events-repo jgrace19/marketplace
```

Redeploy the existing slug the same way. `--cursor-events-repo` replaces
the watched repository list, so pass `jgrace19/marketplace` on every
redeploy. A deploy that omits the flag watches this bot's source
repository instead of the marketplace.

Set secrets after the first deploy. `secret set` reads the value from
stdin and does not echo it.

```bash
printf %s "$OBSERVABILITY_SHARED_SECRET" | npx bdk secret set spike-detector OBSERVABILITY_SHARED_SECRET
printf %s "$SPIKE_DETECTOR_SLACK_CHANNEL" | npx bdk secret set spike-detector SPIKE_DETECTOR_SLACK_CHANNEL
printf %s "$SPIKE_DETECTOR_CODE_OWNER_SLACK_ID" | npx bdk secret set spike-detector SPIKE_DETECTOR_CODE_OWNER_SLACK_ID
printf %s "demo/base" | npx bdk secret set spike-detector MARKETPLACE_STARTING_REF
printf %s "Marketplace" | npx bdk secret set spike-detector LINEAR_PROJECT
printf %s "$LINEAR_TOKEN" | npx bdk secret set spike-detector LINEAR_TOKEN
npx bdk secret list spike-detector
```

Slack bot tokens come from `bdk slack create`, not from this list. The
first deploy prints an alias token once. Store it outside the terminal
transcript. The stable route is `$AGENT_ALIAS_URL`.

Egress includes `mcp.linear.app` for the Linear MCP server. GitHub and
Slack go through the host clients and the Cursor backend.

## Required secrets

| Name | Required for |
| --- | --- |
| `OBSERVABILITY_SHARED_SECRET` | `POST /alert` and `POST /metrics` |
| `SPIKE_DETECTOR_SLACK_BOT_TOKEN` | Slack Socket Mode, from `slack create` |
| `SPIKE_DETECTOR_SLACK_APP_TOKEN` | Slack Socket Mode, from `slack create` |
| `SPIKE_DETECTOR_SLACK_CHANNEL` | Paging the code owner |
| `SPIKE_DETECTOR_CODE_OWNER_SLACK_ID` | The `@` mention. Empty posts without a mention |
| `MARKETPLACE_STARTING_REF` | Optional. Empty uses `demo/base` for the cloud agent and the fix PR base |
| `LINEAR_PROJECT` | Optional. Empty uses project `Marketplace` in workspace `fe-demo` |
| `LINEAR_TOKEN` | Linear personal API key created in the fe-demo workspace |

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
  -d '{"incidentId":"inc-1001","metric":"freshcart.checkout.gmv_cents","env":"prod","baseline":100000,"value":68000,"window":"30m"}'

curl -sS -D - -X POST http://127.0.0.1:3000/v1/channels/observability/metrics \
  -H "X-Observability-Token: $OBSERVABILITY_SHARED_SECRET" \
  -H 'content-type: application/json' \
  -d '{"metric":"freshcart.checkout.gmv_cents","env":"preview-42","value":100000,"baseline":100000,"window":"5m"}'
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
  -d '{"incidentId":"inc-1001","metric":"freshcart.checkout.gmv_cents","env":"prod","baseline":100000,"value":68000,"window":"30m"}'
```

Multi-agent serve mounts the same routes under `/<directory-name>/v1/...`.

Direct tool check, no model turn:

```bash
npx bdk tool call query_metrics --dir . \
  --input '{"metric":"freshcart.checkout.gmv_cents","env":"preview-42"}'
```

## Evals

```bash
npx bdk eval --dir . --list
npx bdk eval --dir . --tag smoke
```

Model turns need a Cursor credential. Eval sessions do not post to Slack,
open Linear issues, or launch cloud agents. `list_recent_changes` reads
`fixtures/changes.json` when `purpose` is `eval`.

- `expected` — `exp-planned-gmv`. `freshcart.checkout.gmv_cents` at
  108000 versus a merged promo whose target is 110000. Logs the note
  and does not page.
- `bug` — `bug-checkout-undercharge`. GMV and average order value are
  about 32% below baseline while orders and units stay flat, and the
  only commit is a README change. Records a bug and calls the page
  tools. The case does not name a code fix.

## Layout

| Path | Role |
| --- | --- |
| `bot/instructions.md` | Tool order and reply shape |
| `bot/skills/expected-vs-bug/SKILL.md` | Expected versus bug rubric |
| `bot/channels/observability.ts` | `POST /alert`, `POST /metrics` |
| `bot/channels/github.ts` | Pull request and CI wakes for `jgrace19/marketplace` |
| `bot/channels/slack.ts` | Sign-off thread |
| `bot/extensions/cloud/` | Cloud agents on marketplace. Launch and reply are disabled |
| `bot/mcp-connections/linear.ts` | Linear MCP at `mcp.linear.app` with `LINEAR_TOKEN` |
| `bot/tools/` | One tool per file |
| `bot/reminders/` | Sign-off backup wake and preview poll |
| `evals/` | Expected and bug cases |

## TODOs

- Confirm hosted auth if the secret header alone returns 401 (above).
- `close_incident` returns a TODO in the tool result when it cannot find
  a completed Linear status. Finish that close with the advertised Linear
  tools.
- Reminder handlers cannot call `query_metrics` directly. `preview_watch`
  reads the same KV records, then the woken turn calls the tool.
- Reprocessing one `incidentId` means removing KV key `incident:<id>`.
  There is no documented KV admin command for that.
