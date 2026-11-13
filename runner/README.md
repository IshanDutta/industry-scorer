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
- **Models (chosen for you, `model: auto`, the default):** the lead strategist, the most important work (the
  synthesis and thesis, the bull/base/bear scenarios, the 1M-12M calls, the red team and the investor verdicts), runs
  on Claude Opus 5.5 (`CLAUDE_MODEL_LEAD`); every analyst and data step runs on Sonnet 5.5. About $2.50-2.85 per
  industry at batch prices. `model: opus` puts Opus on the analysts' complex steps too (about $5.50 per industry);
  `model: sonnet` runs everything on Sonnet (about $2.75 per industry).
- **Several sectors at once:** Actions → **Sector run** → type sectors separated by commas, or `all`.
- If a run needs more than one GitHub session (about 5.5 hours), it saves a checkpoint and continues in a new run
  by itself; nothing finished is paid for twice.

## A monthly budget for the daily updates (default about $500 a month)

The daily update runs Monday to Saturday (Saturday only for real news events; Sunday is off) on a budget that
covers **everything** it spends: the repository variable `DAILY_MONTHLY_BUDGET_USD` (default **500**) is split across
sectors by their number of industries, and each day spends its share of what's left this month, so an expensive day
is paid back by cheaper ones and the month lands on the budget. Within the day's money:

- **Real events** (a move of 1.5+ normal moves, a top company's earnings or 8-K, a big company moving 8%+, a scheduled
  high-importance event, a market alarm) get the whole analysis brought up to date by the lead model (Opus, at medium
  effort), biggest first.
- **Smaller news** (other triggers, or the triage calls the day material) gets the same update from the balanced model
  (Sonnet), next.
- **Quiet days** get code only: prices, numbers, Times like this and the calls held to them; no Claude.
- What doesn't fit waits for a later day. Section rewrites get what's left, at most a fifth of the day (none at the
  weekend); only a big market day may borrow ahead. The rolling rewrite of the oldest analysis happens on Mondays.
- Calls that disagree are repaired by Sonnet; the outlook is remade only when a call changes level, the analysis was
  rewritten, or it's a week old.
- A slow batch gets 2.5 hours at half price before anything is re-sent at full price, and sectors start three
  minutes apart. Each run's summary shows its cost by step.

Each day, per industry:

1. **Data, no Claude:** prices, estimates, positioning, macro values, news, and one shared list of the SEC's 8-K
   filings (a top company filing one with financial statements is usually results: a hard trigger).
2. **Triage (Haiku):** reads the day and names every section it touches, with how important. When the industry moved
   1.5+ normal moves but Haiku saw nothing, **Sonnet gives a second opinion**.
3. **Section rewrites (Sonnet):** the work worth the most goes first across the whole sector (a top company's results,
   then whatever changes a section's conclusions, then new facts, then nuance); what doesn't fit waits and comes back
   the next day, more urgent.
4. **The whole analysis brought up to date (Opus 5.5, `CLAUDE_MODEL_DAILY_LEAD`):** the strategist reads its entire
   analysis and everything that changed, and rewrites every part the day changes (headline, thesis, summary, what's
   priced in, drivers, debates, each scenario's numbers, odds and story, the opportunity, the investor verdicts, the
   1M-12M calls), leaving the rest exactly as it was. It then answers: "written from scratch today, would this be the
   same story?" Code recomputes the scenario math and its checks. Today's headlines it cites become lasting sources
   (DU-IDs).
5. **The drift guard:** a full rewrite from scratch (every section reread, the strategist's full process) is ordered
   when the industry has moved 2+ normal moves since the last one, or when the strategist says the story would be
   built differently (these go first in line and may borrow from the rest of the month), and, as upkeep, after 6
   updates that changed the core story (this one waits for room in the budget, moving up each day it waits). The industry
   analyzed longest ago also gets one as a rolling refresh.

**Big days** (the S&P 500 moving 2%+, the VIX jumping 15%+, high-importance news in 40%+ of a sector's industries, or a
midday alarm) may spend up to three days' share, never more than a quarter of what's left this month; urgent rewrites
may borrow the same way on any day. A day can't spend more than three times its share in all (a safety stop).

**The midday market alarm** (`market-alarm.yml`, no Claude): twice each weekday during trading it reads SPY and the
VIX; on a crash-sized day (SPY ±2.5%, VIX +20%; variables `SHOCK_SPY_PCT`, `SHOCK_VIX_PCT`) it starts the daily
update right away as a big day, at most once a day. Run it by hand with "force" to do that whatever the market did.

## Run everything in order (the queue) and the status page

Actions → **Queue and status** → Run workflow → action `start`, the sectors in the order to run them with each one's
spending limit (`Real Estate:6, Healthcare:8, Energy:22`), the total cap and speed (models: Opus for the strategist, Sonnet for the rest). Up to
**three sectors run at once** (`parallel`, 1-6), started in order; the next starts a minute or two after one ends.
Each reuses what the sectors finished before it researched (the shared library: world situations, countries,
regulator instruments, the news wire). A sector's limit is raised to what its waiting industries need (about $3.50
each plus $2); the total cap bounds everything. Each sector
adds only the industries it doesn't have yet. If the API runs out of credit, the queue waits and resumes by itself
within the hour of you adding credit; a sector that reaches its limit is skipped; one that fails otherwise is retried
twice. When the queue is done, a daily update of every sector runs (it also adds "Times like this" to industries that
don't have it). `stop` and `resume` do what they say.

**The 1M-12M calls on GitHub.** Action `finish` now does everything still missing in order: every waiting industry,
then Times like this (the history pass), then, once that has ended, **the calls pass**: the 1M-12M calls (where each
industry is going and why, from every component; one cheap call each, about $0.04) for every finished industry that
doesn't have its own calls yet (none, or only provisional ones read off the older calls). Industries that already have
calls are left alone. Action `calls` runs just the calls pass right away (Daily update → `lean_missing` does the same
by hand). The daily update keeps them current afterwards (remade when the calls move, the analysis is rewritten, or
they are a week old). Industry Scorer shows, for each sector, how many industries have their calls (made on GitHub
or in the page), how many are still provisional, and the last calls pass with anything that failed; each industry's
card says where its calls were made.

The same workflow runs every hour and whenever a run ends, and writes `status.json` to the `status` branch: every
industry's status, the queue, recent runs and spending. Spending is tracked by the runs themselves; add an Admin API key
as the `ANTHROPIC_ADMIN_KEY` secret for Anthropic's own cost report, and set the repository variables
`CREDIT_BALANCE_USD` (your balance on a day) and `CREDIT_BALANCE_AT` (that day, e.g. 2026-11-04) for an estimate of what's
left. (Anthropic's API doesn't report the credit balance itself.)

**Prompt caching:** the lead strategist's four to seven steps per industry all start from the same dossier, so the job
sends it first and marks it for caching (1-hour cache by default, `CLAUDE_CACHE_TTL=5m` for 5 minutes): after the first
step it costs a tenth of the input price. The run's summary says how much caching saved.

## Daily update (cheap) and weekly full run

The full analysis is expensive, so it runs weekly (list sectors in `weekly-sectors.txt`; Actions → **Sector run**
runs them every Saturday). On weekdays, Actions → **Daily update** keeps every analyzed sector current for a small
fraction of the cost:

1. **Numbers, no Claude:** prices, returns, risk, estimates and revisions, positioning, short interest, macro values,
   news and sentiment are refreshed by code, and the track records are scored with the latest prices.
2. **What changed:** code compares today with the last update and flags hard triggers: the industry moving more than
   1.5x its normal move, a top-10 company reporting, a big constituent move, a large move in a high-relevance macro
   indicator, a jump in estimate revisions or in news volume.
3. **Triage (Haiku 4.5):** a short prompt asks whether anything is material, and whether any headline makes one of
   the deeper sections out of date (it must cite the headline, and most days the answer is none).
4. **Sections rewritten for the news:** a section the news made stale is rewritten by the same analyst as the full
   run, for that industry only: KPIs and earnings calls (also whenever a top-10 company reports), world-event deep
   dives, the trade map, regulation/litigation/deals (with the regulatory verdict), a named regulator's rule book,
   or customers and suppliers. Each section then waits 4-10 days before news alone can rewrite it again, and at most
   three are rewritten per industry per day. These run on Sonnet 5.5 (repository variable
   `CLAUDE_MODEL_DAILY_COMPLEX=claude-opus-5-5` for full quality, about twice the cost).
5. **Revisions (Sonnet 5.5):** where something is material or a section was rewritten, the strategist revisits the
   1M-12M calls (and, if warranted, the scenario odds) against what changed and what the rewritten sections now say.
   Calls it leaves alone stay exactly as they were; revised ones keep where they came from, and the industry report
   shows a "Daily update" box with what changed and which sections were rewritten, and why.

It runs every weekday after the US close (all analyzed sectors, four at a time), or on demand for chosen sectors.
Settings (repository variables): `DAILY_BUDGET_USD` (default 5 per sector), `DAILY_INDUSTRIES` (industries refreshed
at once per sector, default 4), `CLAUDE_MODEL_QUICK` (default Haiku 4.5), `CLAUDE_MODEL_DAILY` (default Sonnet 5.5).
The updated sector goes back to the `exports` branch.

## Analyze a portfolio (the Portfolios tab's Analyze, on GitHub)

Actions → **Portfolio analysis** → Run workflow, with the portfolio's **id** and the **request** the page's *Analyze on GitHub* button shows (base64 of the holdings, total and goal).

The job loads every sector's saved runs from the exports branch into the headless page. It then runs the page's own analysis: the report card, the target industry distribution, the best companies, every ETF holding them, the mixes, stress tests and the strategists' write-up. It saves `portfolios/<id>.json.gz` to the exports branch.

- **Cost:** Opus for the write-up, at standard price; about $1–3, 10–20 minutes. `budget` caps it (default $15).
- **Getting it into the page:** **Update everything from GitHub** brings it in with the sector runs.
- **One click from the page:** set up the Claude task in `portfolio-task.md`. The page then starts the workflow, waits and copies the result back by itself.
- **Test it offline:** `node test/portfolio.mjs <exports dir>`.

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
