# Industry Scorer overnight job

Analyzes every industry in a sector on **your own API keys**, without your Claude plan's limits, at about half the
API price (Message Batches) with prompt caching on multi-step calls. It runs on GitHub Actions, on demand or every night.

It doesn't re-implement anything: it opens the real Industry Scorer page in a headless browser and presses
"Analyze all", so the analysis, prompts, models' instructions, fact-checks and reports are exactly the page's.
Only the connections change:

| In the claude.ai page | In the job |
|---|---|
| Claude, on your Claude plan | Claude Opus 5.5 / Sonnet 5.5 on your Anthropic API key (half-price batches, or standard price) |
| Your FMP and EODHD connectors | The same FMP and EODHD MCP servers, at their URLs |
| One industry at a time, two agents at once | 10 industries, 8 agents and 12 regulators at once |

## Set up (once, about 15 minutes)

1. **Anthropic API key.** At console.anthropic.com: add credit (Billing), set a monthly spend limit, and create an API
   key. This is billed separately from your Claude plan.
2. **Your MCP server URLs.** In claude.ai → Settings → Connectors, open your FMP and EODHD custom connectors and copy
   their URLs. If the API key is part of the URL, that's all you need; if the server needs a header instead, you'll
   add it as JSON (see below).
3. **A private GitHub repository** with this project in it (the `web/`, `runner/` and `.github/` folders).
4. **Secrets.** In the repository: Settings → Secrets and variables → Actions → New repository secret:
   - `ANTHROPIC_API_KEY`
   - `FMP_MCP_URL`
   - `EODHD_MCP_URL`
   - only if needed: `FMP_MCP_HEADERS` / `EODHD_MCP_HEADERS`, e.g. `{"Authorization":"Bearer YOUR_KEY"}`

   Secrets are encrypted by GitHub and never appear in logs. Never paste keys into chats or files.

## Run it

- **One sector:** Actions → **Run <Sector>** (e.g. "Run Technology") → **Run workflow**. Choose the speed and the
  spending cap, then Run. Each sector page in Industry Scorer also has a **Run <Sector> on GitHub** link to it.
  If that sector has an unfinished run, it continues it (only what's left is done); tick "fresh" to start over.
- **Every industry, however small:** each sector run analyzes every industry it finds, down to one company.
  (Runs before Nov 2026 left out industries with fewer than 15 companies.) To add the industries a finished
  sector doesn't have yet without redoing the rest, tick **add_new**: the industries already analyzed are kept
  as they are, and only the missing ones get the full analysis. Set `JOB_MIN_COMPANIES` to bring back a cutoff.
- **Shared library (reuse between sectors):** every run starts from what earlier sectors researched, kept in the
  `library` branch: the news wire (3 days), each world situation's facts (7 days), each country's facts (30 days)
  and each regulator instrument's facts (30 days). A later sector reuses whatever applies and writes only what is
  specific to its own industries; everything about a particular industry (KPIs, trade map, verdicts, the lead
  strategist) is always written fresh. The first sector runs exactly as before. **Run sectors one after another**
  for the most reuse: two sectors running at the same time can't share with each other.
- **Spending cap (budget):** the most this run may spend on Claude, in dollars (default 150). The job stops and
  saves before going over; run the same sector again to continue.
- **Speed:** `cheap` uses half-price batches only (slower: often several hours); `quick` uses the standard price
  (about 1–2 hours, roughly twice the cost per call).
- **Models:** like the page in claude.ai, "complex" steps run on Claude Opus 5.5 and "default" steps on Claude
  Sonnet 5.5, each at its own default thinking effort. A continued run keeps the settings it started with.
  Choose **model: sonnet** to run every step on Sonnet 5.5, about half the cost (roughly $2.75 per industry
  instead of $5.50 at batch prices, from earlier runs).
- **Several sectors at once:** Actions → **Sector run** → type sectors separated by commas, or `all`.
- If a run needs more than one GitHub session (about 5.5 hours), it saves a checkpoint and continues in a new run
  by itself; nothing finished is paid for twice.

## Daily update (cheap) and weekly full run

The full analysis is expensive, so it runs weekly (list sectors in `weekly-sectors.txt`; Actions → **Sector run**
runs them every Saturday). On weekdays, Actions → **Daily update** keeps every analyzed sector current for a small
fraction of the cost:

1. **Numbers, no Claude:** prices, returns, risk, estimates and revisions, positioning, short interest, macro values,
   news and sentiment are refreshed by code, and the track records are scored with the latest prices.
2. **What changed:** code compares today with the last update and flags hard triggers: the industry moving more than
   1.5x its normal move, a top-10 company reporting, a big constituent move, a large move in a high-relevance macro
   indicator, a jump in estimate revisions or in news volume.
3. **Triage (Haiku 4.5):** with no trigger, a short prompt asks whether anything is material.
4. **Revisions (Sonnet 5.5):** only where something is, the strategist revisits the 1M-12M calls (and, if warranted,
   the scenario odds) against what changed. Calls it leaves alone stay exactly as they were; revised ones keep where
   they came from, and the industry report shows a "Daily update" box with what changed.

It runs every weekday after the US close (all analyzed sectors, four at a time), or on demand for chosen sectors.
Settings (repository variables): `DAILY_BUDGET_USD` (default 5 per sector), `DAILY_INDUSTRIES` (industries refreshed
at once per sector, default 4), `CLAUDE_MODEL_QUICK` (default Haiku 4.5), `CLAUDE_MODEL_DAILY` (default Sonnet 5.5).
The updated sector goes back to the `exports` branch.

## Get the results into Industry Scorer

The latest run of every sector is kept in the `exports` branch (`runs/<sector>.json.gz`). In Industry Scorer, open
the sector and click **Download latest results**, then in the industry picker click **Import results files** and
choose the file. Unfinished runs import too: they open where they stopped.

## What it costs

Each run's summary (the run's page in Actions) shows the Claude requests, tokens, the **estimated cost**, a
**cost-by-step table** (rule books, world events, countries, lead strategists, ...) and what was taken from earlier
sectors. GitHub Actions: private repositories get 2,000 free minutes a month; after that standard Linux runners
cost about $0.006 a minute.

If the API credit runs out mid-run, the run stops with that message and saves a checkpoint. Add credit, then run the
workflow again for the same sector with `continue_from` set to that run's ID (from its URL).

## Settings (optional repository variables or env)

| Variable | Default | What it does |
|---|---|---|
| `CLAUDE_MODEL_COMPLEX`, `CLAUDE_MODEL_DEFAULT` | Opus 5.5, Sonnet 5.5 | Models for the page's two tiers (`CLAUDE_MODEL` sets both) |
| `CLAUDE_MODE` | `batch` | `direct` = full price, answers in seconds instead of minutes |
| `JOB_INDUSTRIES`, `JOB_POOL`, `JOB_BODIES` (repository variables) | 10, 8, 12 | Industries, agents and regulators worked on at once |
| `DIRECT_AFTER_MIN` (repository variable) | none | After this many minutes, everything left goes at the standard price |
| `STRAGGLER_MIN` (repository variable) | 0 (never) | Minutes before a slow batch is re-sent at the standard price (0 = never) |
| `STAGGER_MIN` (repository variable) | 6 | Minutes between sector starts when several run at once |
| `FMP_GAP_MS` (repository variable) | 230 | Pause between FMP calls; raise it if your FMP plan's rate limit is low |
| `JOB_MIN_COMPANIES` (env) | 1 | Leave out industries with fewer companies than this (1 = analyze every industry) |

## Test it offline

`npm install`, then `node test/e2e.mjs <mock_brain.js>` runs a whole sector against fake Anthropic and MCP servers:
one session, a session that runs out of time and continues, an API key that runs out of credit, slow batches,
a cancelled job, the spending cap, and (test 8) a second run that reuses the first one's library.
