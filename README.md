# Pixa Tower

Pixa Tower scans every irreversible block of the Pixa chain into Cloudflare D1, computes about 120 metrics, raises governance and economy alerts, and serves everything through a read-only JSON API (`/v1`). It runs entirely on Cloudflare Workers: no server to operate.

Every figure comes from hived operations, never from Hivemind, because Hivemind on Pixa scales old rshares by a million and reports reputation 0. Hivemind is used for one thing only: community titles and subscriber counts.

## Architecture

```
 Pixa API nodes ──irreversible blocks──▶ Scanner (Durable Object, alarm loop) ──events + cursor, one batch──▶ D1 tower-db
        │                                                                                                      │
        └──chain state every 5 min──▶ Snapshotter (cron) ──snapshots, gauges──▶ D1  ──▶ KV (overview)            │
                                                                                                               ▼
                         Rollup (cron, hourly + daily) ◀── events ──  D1  ── rollups ──▶ API Worker /v1 ──▶ dashboard, apps
                         Alerts (cron, 5 min) ──▶ Discord / Telegram / webhook                ▲
                         Queue tower-jobs (replay, recompute) ◀── admin routes ───────────────┘
```

| Worker | Contents | Public? |
| --- | --- | --- |
| `tower-core` | Scanner Durable Object, the three crons (5 min, hourly, daily), the `tower-jobs` queue consumer, RPC methods for admin calls | No route; reached only through the API's service binding |
| `tower-api` | `/v1` public routes, `/v1/admin/*` behind Cloudflare Access, OpenAPI document | Yes (`tower.pixa.org` in production) |

The spec listed the snapshotter, rollup and alerts as separate Workers. Here they share `tower-core`, one deploy unit with the same separation of duties: only the scanner writes chain events, and the API only reads.

| Cloudflare product | Name (production) | Use |
| --- | --- | --- |
| D1 | `tower-db` | Events, state, snapshots, rollups, thresholds, alerts, actions |
| KV | `tower-cache` | The current overview, rewritten every 5 minutes |
| R2 | `tower-archive` | Raw blocks as gzipped JSON per scanned range (optional, `ARCHIVE_RAW`) |
| Queues | `tower-jobs` | Replays and recomputes, so long work never runs inside a request |
| Durable Objects | `Scanner` | The single writer and its alarm loop |

Staging uses the same names with a `-staging` suffix.

## Repository

```
packages/core/src/     shared logic, no Worker APIs: parser, assets, RPC client, ingest loop, snapshot,
                       metric catalogue, rollup engine, alerts, formulas, governance arithmetic
apps/core/             tower-core Worker (scanner, crons, queue) + wrangler.jsonc
apps/api/              tower-api Worker (routes, Access verification, OpenAPI) + wrangler.jsonc
migrations/            D1 schema (0001) and seed thresholds (0002)
scripts/               setup, deploy, migrate, secrets, admin CLI, fixture fetcher, docs generator
test/                  vitest suites on real Pixa blocks (test/fixtures) and a D1 stand-in on node:sqlite
docs/METRICS.md        every metric with its definition (generated)
deploy.sh              one-command deployment
```

## Requirements

- Node 22.13 or newer (the tests use `node:sqlite`).
- A Cloudflare account on the **Workers Paid** plan. The free plan caps D1 at 500 MB and 50 queries per invocation, and has no Queues.
- `npx wrangler login`, or `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`) in CI. The token needs Workers Scripts, D1, Workers KV, R2, Queues and Workers Routes edit permissions.

## Run it locally

```bash
npm ci
npm test                                   # parser, rollups, alerts on real blocks
LIVE=1 npm test                            # also snapshot and ingest against the live chain

npm run migrate:local
npx wrangler dev -c apps/core/wrangler.jsonc --persist-to .wrangler/state --port 8787 --test-scheduled \
  --var START_BLOCK:1000000                # start near the head for a quick look
npx wrangler dev -c apps/api/wrangler.jsonc --persist-to .wrangler/state --port 8788 --var ADMIN_TOKEN:dev

curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"   # local crons do not fire by themselves
curl http://localhost:8788/v1/status
ADMIN_TOKEN=dev node scripts/admin.mjs scanner
```

Both dev servers share `.wrangler/state`, so the API reads what the scanner writes. Local crons must be triggered with `/__scheduled`; the scanner's alarm loop runs on its own once kicked.

## Deploy

```bash
./deploy.sh staging
./deploy.sh production --access-team <team>.cloudflareaccess.com --access-aud <AUD tag>
```

`deploy.sh` runs two scripts you can also call one by one:

1. `node scripts/setup.mjs --env <env>` creates D1, KV, R2 and the queue if they do not exist, and writes their ids into both `wrangler.jsonc` files. Commit the result.
2. `node scripts/deploy.mjs --env <env>` typechecks, runs the tests, applies D1 migrations, deploys `tower-core`, then `tower-api` (it binds `tower-core`). `--skip-tests`, `--skip-migrate` and `--dry-run` are available.

Then, optionally, `node scripts/secrets.mjs --env <env>` for the alert channels.

**After the first deploy**, the 5-minute cron kicks the scanner, which backfills from `START_BLOCK` (default 1). A local run of the whole chain (about 1,008,000 blocks on 2026-10-09) ran at about 26,000 blocks per minute with `MAX_BLOCKS_PER_TICK=4000`, roughly 40 minutes. Rollups catch up 72 hours per 5-minute run and daily metrics 10 days per hour, so history is complete about two hours after the scanner reaches the head. `GET /v1/status` shows the progress.

**CI.** `.github/workflows/ci.yml` typechecks, tests and bundles both Workers on every pull request; a push to `main` deploys staging, and production deploys only by manual dispatch. Set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repository secrets, and commit the configs after `setup.mjs` has filled the ids.

### Admin access (Cloudflare Access)

Admin routes accept only a valid Cloudflare Access JWT; the Worker verifies it itself, so a route left outside the Access policy by mistake still refuses the call.

1. Zero Trust › Access › Applications › Add a self-hosted application on `tower.pixa.org/v1/admin/*`.
2. Add a policy for the people who may change thresholds and log actions, and a Service Auth policy with a service token for scripts.
3. Copy the application's **AUD tag** and your team domain (`<team>.cloudflareaccess.com`) into `setup.mjs --access-team … --access-aud …`, or into `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` in `apps/api/wrangler.jsonc`.
4. Scripts send `CF-Access-Client-Id` and `CF-Access-Client-Secret`: `CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=… node scripts/admin.mjs --base https://tower.pixa.org scanner`.

Staging and local dev can use `ADMIN_TOKEN` (a secret) as a bearer token instead.

## Configuration

Worker vars of `tower-core` (`apps/core/wrangler.jsonc`, per environment):

| Var | Default | Meaning |
| --- | --- | --- |
| `CHAIN_NODES` | `https://api.pixagram.com` | Comma-separated nodes, tried in order with demotion on errors. List several to enable the two-node block check. |
| `START_BLOCK` | `1` | First block to scan on an empty database |
| `RESTRICTED_ACCOUNTS` | `pixa.rex,pixa.team` | Accounts that must never vote: any vote raises a red alert |
| `DPF_ACCOUNT` | `pixa.omnibus` | Excluded from liquid supply; its self-payments are excluded from DPF spending |
| `OPERATING_ACCOUNT` | `pixa` | Tagged as a system account |
| `TREASURY_SCHEDULE_ACCOUNT` | `pixa.rex` | Account tracked against the 9-to-11-year distribution path |
| `TGE_TIME` | `1788480000` | 2026-09-04 00:00 UTC, start of that path |
| `EXCHANGE_ACCOUNTS` | empty | Exchange deposit accounts for the `exchange_inflow` metric |
| `CONTROVERSY_MIN_VOTES` | `5` | Votes a post needs before it gets a controversy score |
| `LIVE_BATCH` / `BACKFILL_BATCH` | `20` / `200` | Blocks per request; backfill adapts to keep responses near 8 MB |
| `MAX_BLOCKS_PER_TICK` | `2000` | Blocks per alarm tick (each tick also stops after 20 s) |
| `VERIFY_SECOND_NODE` | `true` | With two or more nodes, the last block of every range must have the same id on a second node |
| `ARCHIVE_RAW` | `false` (staging), `true` (production) | Write raw blocks to R2 |
| `BALANCE_FULL_REFRESH_MAX` | `20000` | Below this many accounts, balances are refreshed every 5 minutes; above, once a day |
| `PUBLIC_BASE_URL` | | Used in alert links |

`tower-api` vars: `PUBLIC_BASE_URL`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `STALE_RED_BLOCKS` (default 1200: above this lag, responses carry `x-tower-stale: 1`).

Secrets (`node scripts/secrets.mjs`): `DISCORD_WEBHOOK_URL`, `DISCORD_WEBHOOK_URL_RED`, `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, `ALERT_WEBHOOK_URL` (receives `{events}` as JSON, e.g. an email relay), and `ADMIN_TOKEN` on staging.

## API

Base: `https://tower.pixa.org/v1`. Full schema: `GET /v1/openapi.json`, generated from the route table.

Every response is `{ "data": …, "meta": { "as_of_block", "as_of_time", "generated_at", "ingest_lag_blocks" } }`; errors are `{ "error": { "code", "message" } }`. Responses carry an `ETag` and are edge-cached for the time in the table. Public routes allow 120 requests per minute per IP (Workers rate-limit binding).

| Route | Returns | Cache |
| --- | --- | --- |
| `GET /v1/status` | Cursor, last irreversible block, lag, last snapshot, rollup progress, scanner state | 5 s |
| `GET /v1/overview` | KPIs, supply, governance, open alerts (from KV) | 30 s |
| `GET /v1/metrics` | Catalogue: every metric with definition, grains and thresholds | 1 h |
| `GET /v1/metrics/{id}?grain=&from=&to=&dim=` | A series; `dim=*` for every dimension; up to 2,000 points | 60 s |
| `GET /v1/metrics/{id}/latest?grain=` | Last value per dimension | 60 s |
| `GET /v1/portals` | Each portal: title, subscribers, posts, authors, controversy 7 and 30 days, downvote share, moderation | 5 min |
| `GET /v1/posts/controversial?portal=&kind=&window=&min_votes=&limit=` | Most controversial posts | 5 min |
| `GET /v1/distribution/pxp?include_system=` | Accounts per Pixa Power bucket (own and effective), Gini, Nakamoto | 1 h |
| `GET /v1/feed?grain=&from=&to=` | Median feed history and every witness's published feed since genesis | 5 min |
| `GET /v1/rewards?window=` | Rewards by type in each asset and PIXA equivalent, pending payout | 5 min |
| `GET /v1/witnesses` | Ranked witnesses with scorecard: produced and missed blocks, feed age and deviation, version | 60 s |
| `GET /v1/witnesses/{name}/history` | Votes and rank over time, vote log with voter stake and account age, parameter changes | 5 min |
| `GET /v1/governance` | Cost of capture, free seats, bench, participation, proxies, readiness, shared keys, treasury invariant | 5 min |
| `GET /v1/dpf` | Proposals against the return proposal (id 2), runway, payouts by receiver | 5 min |
| `GET /v1/funnel?cohort=` | Onboarding funnel and retention of a weekly cohort | 1 h |
| `GET /v1/alerts?state=&severity=&metric=` · `GET /v1/alerts/{id}` | Alerts, with evidence and logged actions | 30 s |
| `GET /v1/actions` | Action log with the metric 7 and 30 days later | 5 min |
| `GET /v1/accounts/{name}` | Creation, milestones, 90-day activity, balances | 60 s |

Admin (Cloudflare Access): `PUT|DELETE /v1/admin/thresholds/{metric}`, `POST /v1/admin/actions`, `POST /v1/admin/alerts/{id}/ack`, `POST /v1/admin/recompute`, `POST /v1/admin/replay`, `GET /v1/admin/scanner`, `POST /v1/admin/scanner/{pause|resume|rewind|snapshot|hourly|daily}`.

## Metrics

[`docs/METRICS.md`](docs/METRICS.md) lists all of them. Four kinds:

- **counter**: computed per hour from event tables; day, week and month are sums of hours.
- **range**: computed over each period directly. Distinct counts (active accounts) are never summed.
- **daily**: computed once per closed day; cohort metrics (funnel, retention) are recomputed for the last 13 weeks every day, since accounts keep reaching milestones.
- **gauge**: written by the snapshotter every 5 minutes; each hour, day, week and month keeps its last value.

Changing a definition: bump its `version` in `packages/core/src/metrics.ts`, deploy, then `node scripts/admin.mjs recompute <metric> <from>`.

## How the data is built

- **Order and atomicity.** The scanner ingests irreversible blocks only, in order, and commits each range's events together with the cursor in one D1 batch. A crash can repeat a range, never skip one.
- **Idempotency.** Event tables are keyed by `(block, pos)`; posts track their last operation, so replays never double-count an edit. A test ingests 100 real blocks twice and checks every table is unchanged.
- **Virtual operations** come from `account_history_api.enum_virtual_ops` (at most 2,000 blocks per call) and are merged with signed operations in chain order.
- **Votes** take rshares from `effective_comment_vote`; each post's up/down rshares, counts and controversy are recomputed from its votes after every change.
- **Content classification**: reply if `parent_author` is set; blog if the category is a `portal-…`; artwork if the body is an image data URI (no `<`, no line break); blog if `format` is `markdown`. Artwork dimensions are read from the WebP header; the body itself is never stored, only its size and SHA-256.
- **Amounts** are integers in the smallest unit; both the legacy string and the NAI form are read, and both Hive and Pixa field names (the gateway renames some).
- **PXP** is VESTS × `total_vesting_fund_pixa ÷ total_vesting_shares`, from the latest snapshot. Never a constant.
- **D1 limits.** Append-only inserts are merged into multi-row statements (100 bound parameters each), and per-account updates are written once per range.

## Operations

| Task | Command |
| --- | --- |
| See the scanner | `node scripts/admin.mjs scanner` |
| Pause or resume | `node scripts/admin.mjs pause` / `resume` |
| Re-ingest everything after block N (parser fix) | `node scripts/admin.mjs rewind N`, then recompute the affected metrics |
| Re-ingest a range without moving the cursor | `node scripts/admin.mjs replay FROM TO` |
| Recompute a metric | `node scripts/admin.mjs recompute <metric\|all> 2026-09-04` |
| Tune a threshold | `node scripts/admin.mjs threshold <metric> '{"grain":"day","op":"gt","amber":0.5,"red":0.8}'` |
| Log an action | `node scripts/admin.mjs action --alert 12 --lever witness_vote --description "…"` |
| Logs | `npx wrangler tail tower-core` |

Retention (daily job): `op_log` and hourly rollups 400 days; 5-minute snapshots 30 days, then hourly. When `tower-db` approaches 6 GB, move closed years of event tables to a second database and to R2; the API reads rollups only, so it is unaffected.

## Tests

```bash
npm test                 # 30 tests: parser, idempotency, payout cycle, rollups, every metric's SQL, alerts, review regressions
LIVE=1 npm test          # + 2 tests: snapshot and a 300-block ingest against the live chain
npm run fixtures -- --post author/permlink --out test/fixtures/sample.json --append
```

**Validated on the full chain.** A local run ingested blocks 1 to 1,008,867 with no parse error or unknown operation, then matched the chain's own counts: 100 accounts and 100 `account_created` events, 100 author rewards, 166 payouts, 818 votes against 817 effective votes up to block 1,007,500, and 82 community operations. That run also found the missed-block undercount fixed in `witness_missed`.

`test/fixtures/sample.json` holds 102 real blocks chosen to cover every operation type seen on chain up to block 1,007,000, plus the full life of one artwork from publication to payout.

## Check on staging first

- **D1 statements per invocation.** Cloudflare caps D1 queries per Worker invocation at 1,000 on Workers Paid, and its documentation does not say whether each statement inside `db.batch()` counts. The Tower merges inserts into multi-row statements (a busy 4,000-block tick wrote about 850 statements; a full account refresh writes about 1 statement per 4 accounts), but run the first backfill on staging and watch `npx wrangler tail tower-core-staging` for D1 errors. If they appear, lower `MAX_BLOCKS_PER_TICK` and `MAX_STATEMENTS_PER_TICK`.
- **Replays** (`/v1/admin/replay`) re-insert events only and leave current-state tables (witness votes, proxies, delegations, follows, latest votes) alone, because the later operations that changed them are not replayed. To rebuild those tables, use `rewind`, which re-applies everything up to head.

## Differences from the specification

- **Workers.** Snapshotter, rollup and alerts share `tower-core` (see Architecture).
- **Stale data.** When ingestion lag is red, the API still answers, with `x-tower-stale: 1` and a short cache, instead of HTTP 503: a dashboard keeps its last figures during a node outage, and `meta.ingest_lag_blocks` says how old they are.
- **Backfill** runs through the scanner itself, in order, instead of parallel queue ranges. On today's chain it takes under an hour, and it keeps state tables (follows, delegations, witness votes) exact. The queue handles replays and recomputes.
- **Email** alerts go through `ALERT_WEBHOOK_URL` to any relay; Discord and Telegram are built in.
- **PAPH** duplicate detection is exact (SHA-256 of the image) for now; the perceptual-hash consumer is a later milestone.
- **Tips** are transfers whose memo contains `@author/permlink`; adjust `memoRef` in the parser once the app's tip format is fixed.
