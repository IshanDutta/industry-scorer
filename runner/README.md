# Industry Scorer overnight job

Analyzes every industry in a sector on **your own API keys**, without your Claude plan's limits, at about half the
API price (Message Batches) with prompt caching on multi-step calls. It runs on GitHub Actions, on demand or every night.

It doesn't re-implement anything: it opens the real Industry Scorer page in a headless browser and presses
"Analyze all", so the analysis, prompts, models' instructions, fact-checks and reports are exactly the page's.
Only the connections change:

| In the claude.ai page | In the job |
|---|---|
| Claude, on your Claude plan | Claude Opus 5.5 on your Anthropic API key, through the Message Batches API |
| Your FMP and EODHD connectors | The same FMP and EODHD MCP servers, at their URLs |
| One industry at a time, two agents at once | 4 industries, 4 agents and 4 regulators at once (so batches are large) |

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

- **On demand:** Actions → **Sector run** → **Run workflow** → type the sector (spelled as in the page's sector list,
  e.g. `Consumer Defensive`) → Run. Several at once: separate them with commas (`Energy, Utilities`).
- **Every sector at once:** type `all`. Each sector gets its own machine and they run in parallel (their starts are
  staggered 6 minutes apart so data pulls don't all hit FMP together; if FMP says to slow down, the job waits and
  retries, so no data is lost).
- **Fast:** tick **fast** to finish a sector in about 3 hours. Batches that aren't back in 5 minutes are re-sent at the
  standard price, and after 90 minutes everything left goes at the standard price. It costs more (roughly 1.3–1.6×).
- **Nightly:** list sectors in `runner/nightly-sectors.txt` (one per line). Empty the list to turn nightly runs off.
- A run takes several hours: the work has about 30–40 steps in a row, and a batch usually returns in 2–5 minutes but
  sometimes sits for an hour or more. Any batch still running after 20 minutes has its requests re-sent at the
  standard price, which keeps a sector to roughly 10–20 hours at a little extra cost.
  If it needs more than one GitHub session (about 5.5 hours), it saves a checkpoint and continues in a new run by
  itself; nothing finished is paid for twice.

## Get the results into Industry Scorer

When the run finishes, open it in Actions, download the **results-…** artifact (a zip), and unzip it. In Industry
Scorer, open the picker and click **Import results files**, then choose the `.json.gz` file (or several at once, one
per sector). The sector overview
opens, and every industry's full report is saved in that browser like any other run.

## What it costs

Each run's summary (the run's page in Actions) shows the Claude requests, tokens and the **estimated cost** for that
session, at batch prices for Claude Opus 5.5 ($2 per million input tokens, $10 per million output, cache reads $0.10).
GitHub Actions: private repositories get 2,000 free minutes a month; after that standard Linux runners cost about
$0.006 a minute (a 4-hour run is about $1.50).

If the API credit runs out mid-run, the run stops with that message and saves a checkpoint. Add credit, then run the
workflow again for the same sector with `continue_from` set to that run's ID (from its URL).

## Settings (optional repository variables or env)

| Variable | Default | What it does |
|---|---|---|
| `CLAUDE_MODEL` | `claude-opus-5-5` | The model for every step |
| `CLAUDE_MODE` | `batch` | `direct` = full price, answers in seconds instead of minutes |
| `JOB_INDUSTRIES`, `JOB_POOL`, `JOB_BODIES` (repository variables) | 10, 8, 12 | Industries, agents and regulators worked on at once |
| `DIRECT_AFTER_MIN` (repository variable) | none | After this many minutes, everything left goes at the standard price |
| `STRAGGLER_MIN` (repository variable) | 20 | Minutes before a slow batch is re-sent at the standard price (0 = never) |
| `STAGGER_MIN` (repository variable) | 6 | Minutes between sector starts when several run at once |
| `FMP_GAP_MS` (repository variable) | 230 | Pause between FMP calls; raise it if your FMP plan's rate limit is low |

## Test it offline

`npm install`, then `node test/e2e.mjs <mock_brain.js>` runs a whole sector against fake Anthropic and MCP servers:
one session, a session that runs out of time and continues, and an API key that runs out of credit.
