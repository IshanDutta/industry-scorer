# Industry Scorer: notes for Claude Code

Read this first. It covers how the project fits together, how to build and test it, and the decisions behind the
Compare tab. `Industry_Scorer.md` explains every tab and calculation in depth; `runner/README.md` explains the GitHub jobs.

## What it is

One HTML page, published as a Claude artifact (https://claude.ai/artifact/8jxLo9AkrJ1Y6GtEQ9LTEC). It analyzes US
industries, companies, funds, portfolios and comparisons on the viewer's FMP and EODHD connectors and Claude. Heavy
work runs headless on GitHub Actions on the owner's API keys (the "runner"), and the page reads the results back.

The owner (Ishan) reads results on his phone. He wants plain wording, full text (never cut off with "..."), cards over
long lists, interactive and easy-to-navigate layouts, and comparisons that are fast (3-5 minutes) and cheap without
losing analysis.

## The shell (AdvisorMindOS)

The page is branded AdvisorMindOS: petrol canvas, one brass accent (`--accent`), Bricolage Grotesque headings,
Instrument Sans text, IBM Plex Mono numbers. The last `<script>` in `page.src.html` is the shell: it folds every
`section.panel` from its `.panel-head` (state in localStorage, `data-fold-default="closed"` starts one folded), moves
the tab indicator, runs the jump palette (Ctrl/Cmd K or /, Alt+1-5 for tabs), and animates sections the first time
they appear. It also makes pages easy to digest: lists of long points become cards (`.cardlist`), tables in macro
sections become a card per row (`.cardtable`) and every table stacks into cards on a phone (`.stackable`; nothing scrolls
sideways), long text gets light typography (`emphasize`: its first sentence leads, figures with units in bold, turns
like "but" in italics; never a "Read all": the owner doesn't want text folded), key numbers count up, and only a tab's
first section and its verdict start open (the rest start folded; `window.AMS.foldAll(false)` opens everything, which the browser test does).
Every tab starts with the snapshot (the numbers, with no prediction card), then Performance, then "Where it's going,
and why" (the full calls and reasons) on the company and fund pages, then the rest. Performance holds one chart (`ppBox`/`ppHTML`: company, fund and industry) with an S&P 500 toggle (`S.ppSpy`, remembered)
and, right under it, Times like this by window (`twBlock`, `Regimes.windowEpisodes`): the window is whatever Performance's period
buttons show (1M/3M/6M/1Y/3Y/5Y; the industry page has its own 1M-5Y buttons). For an industry the historian's notes come only
from GitHub (`runWindowsPass` saves them on the run as `twin`; the page never calls Claude for them and reuses them while the
same stretches come back); companies and funds still have them written on the viewer's Claude. The 5 past stretches most like the last one are a short
list (start and end month and year, 3M and 1Y after); tapping one opens it and lays it over the Performance chart (`S.twOver`:
the stretch from the same start, then what came after it, dashed, from today's level). Each opened stretch has "Then / What
happened next / What's different now" (one historian call per window, `Regimes.windowHistorianPrompt`, kept in localStorage
for the day; code writes the last two until it answers), every measure then vs now, and a chart with axes of the 12 months
after (`twAfterChart`). The older monthly view sits underneath. Wall Street sections show the last 12 months of ratings
(`Street` in `web/street.js`, `streetSlot`/`streetHTML`): monthly rating mix, upgrades and downgrades, target moves, and
a code-written read of the trend. Model output is saved whole (the cleaners no longer cut text); prompts keep their caps.
The sidebar order: the sidebar groups (`industryGroups`, `fundGroups`, `companyGroups`, Compare's
`groups`) set the order, and `wireSpy` puts the sections in that order and highlights from where they actually are.
Points after a label render with `ptList` (a list, never "a; b; c"), and on-screen text is never cut (`showC`);
prompts keep `trimC`. It only decorates the DOM the app renders and is skipped in the GitHub job. Motion uses the
`--t1`..`--t4` tokens (100/150/200/300ms), transform and opacity only, and honors reduced motion.

## Portfolios

- **Dashboard** (`pfDash`, maths in `web/pfx.js`, worked out once per load in `pfX`): one page with a sidebar, all code, no Claude.
  - At a glance: tiles, plus a written read (`PfX.read`).
  - Performance: value with the S&P 500 toggle, drawdowns (today's mix over 5 years), month by month, rolling 6 months, where the return came from.
  - Risk: ratios against the S&P 500 with VaR and CVaR in dollars, who carries the risk (covariance risk shares), how the holdings move together (correlations), a stress test through past crises with "if the market fell", and a range of outcomes (lognormal fan).
  - What it owns: sectors against the S&P 500 (SPY's sector weights), regions (funds' country weights), the companies inside and how much the funds overlap, the industries with our calls (from the saved runs' digests, `pfIndLoad`).
  - Income and costs; Wall Street on its biggest companies.
  - Prices are read from mid-2007 for the stress test. The old Analysis tab (`pfFundTab`, the fund pipeline) is no longer shown.
- **What to change** = the older analysis (grade, recommended mix, new ETFs). Only the first version is written (on
  GitHub or here); the others are written when picked.
- **Editor**: weights (or amounts) only; no shares, average cost or "bought on" (saving drops shares and avg cost).
- **Ticker boxes** everywhere (portfolio editor, rebalance, Companies, Compare, Funds) share one search (`bindTickerBox`,
  `cmpLive`: FMP symbol and name search plus EODHD's, which knows the mutual funds FMP doesn't). Search calls get their
  own short lane in the FMP and EODHD queues, so suggestions show while a page is still loading its data.
- **Rebalance** adds and removes holdings; a dot on Rebalance and Edit holdings marks changes not saved; leaving the
  editor with unsaved edits asks first.

## Screener

The Screener tab (`renderScreener`, `web/screener.js`) works like Kwanti's screener:
- Pick asset types (ETFs, mutual funds, stocks, in any combination) and add criteria on the left; the results refresh as you go.
- Criteria include asset class, equity style, equity sector and region (with a minimum %), fund category, provider, return over any period, yield, volatility, Sharpe, max drawdown, beta, expense ratio, net assets, holdings, sector, industry, stock style, region, exchange, market cap and P/E, P/B, P/S, EPS, margin, quick ratio and debt.
- Every percentage criterion has a slider (`scrSlider`: 0-100%, returns and net margin −100% to +100%, drawdown −100% to 0, on a
  square-root scale so small numbers get room; an end means no limit) alongside its Min and Max boxes.
- You choose the columns, sort by several at once (shift-tap a header, or "Then by…"), tick 2-4 rows to compare (Compare tab), export to CSV, and save searches (page database `screens/<id>`).
- Searching for one asset ranks the others by how alike they are (`Screener.similar`).

Data:
- The "Screener data" workflow (`runner/screener.mjs`, monthly and when the sync task finds it 25+ days old) builds every US stock, ETF and mutual fund above a size floor from FMP. It writes exports `screener/universe.json.gz`, which `pack-page.mjs` copies in as `screener.b64.txt` (index.screener).
- Until the page has that, it builds the list live from FMP for the types picked and fills in risk, fund facts and valuation for the rows on screen (kept in IndexedDB for 30 days).
- Fund category and style are our own grouping (Kwanti uses Morningstar's). Turnover, tax drag and bond duration and quality aren't available from FMP.

## Update everything from GitHub

The button fires the `SYNC_TRIGGER` task (prompt in `runner/update-task.md`; the live task needs the same prompt). It
first runs `daily-update.yml` with `windows=true`: `runWindowsPass` gives every finished industry Times like this for
every window (1M to 5Y) with the historian's notes (saved on the run as `twin`; notes reused when the same stretches come back),
direct mode so it's quick. Then it copies the updated sectors into the page. The task writes its phase (`starting`,
`github` with `run_url`, `copying`, `done`) to `sync/github`; the page's bar (`syncProgress`) moves by time inside each
phase. The page uses `twin` for an industry's Times like this when it's under 3 days old.

## Layout

- `web/page.src.html`: the page (HTML, CSS, and most of the app code; about 10,000 lines). Edit this, never
  `web/industry-scorer.html`.
- `web/*.js`: modules the page inlines (each also loads in Node for tests): `compare.js` (Compare tab engine),
  `fundmore.js` (a fund's macro/world/trade/rules from its industries: `affairs`, `affairsText`), `portfolio.js` (fund
  look-through, industry digests: `lensOf`, `digest`), `company.js` (company page inputs: `lensInputs`), `bondan.js`
  (bond funds), `sensitivity.js` (factor betas), and the rest.
- `web/build.py`: inlines the modules into `web/industry-scorer.html` (the file that gets published). Run after every change.
- `runner/`: the headless jobs (Playwright opens the real page with `window.__INDUSTRY_SCORER_JOB__` set, so the
  page's own code runs). `portfolio.mjs` runs one company, fund, portfolio or comparison; `run.mjs` runs sector
  analyses. `lib/sampler.mjs` calls the Anthropic API (prompt caching via `CACHE_MARK`, per-call token log).
- `.github/workflows/portfolio.yml`: the job for one analysis or comparison. It always runs `--ref main`, so a change only
  reaches GitHub runs once it's merged.
- Branch `exports` (data, not code): `runs/<sector>.json.gz` (every industry run), `portfolios/<id>.json.gz` (each
  job's result: `cmp-*`, `co-*`, `fd-*`), `cache/indDigest.json.gz` and `cache/runs-lite.json.gz` (caches the jobs keep).

## Build and test

```
python3 web/build.py                     # always, after editing page.src.html or web/*.js
for f in web/*_test.js; do node $f; done # unit tests; apply_test, daily_test and parity_test already fail on main
cd runner && npm install                 # once (Playwright uses the preinstalled Chromium or Chrome)
node test/compare-browser.mjs "KO, PEP, VAW"   # Compare tab in a real browser, fake connectors, screenshots in test/.tmp-browser
node test/compare.mjs <exports dir> KO,PG,XLP  # the GitHub comparison job end to end, fake Claude and FMP, real industry runs
node test/sampler_test.mjs
```

Also syntax-check the built page's inline scripts (a template-literal slip breaks the whole page). Extract each
`<script>` body from `web/industry-scorer.html` and run `node --check` on it.

For `test/compare.mjs` and `test/make-seed.mjs` you need the exports branch locally; fetch only what's needed:
`git fetch --depth=1 --filter=blob:none origin exports && git worktree add --no-checkout /tmp/exp origin/exports && (cd /tmp/exp && git sparse-checkout set --no-cone /runs/ /portfolios/ && git checkout)`.
`EXPORTS_REF=origin/exports` makes the job read sector files from git like it does on GitHub.

**Proving a change doesn't alter the analysis.** Run `test/compare.mjs` with `FULL_PROMPTS=1 PROMPTS=/tmp/a.json` on main
and again on your branch, on the same exports commit, then compare the sorted prompt lists (strip ISO timestamps
first). Use this whenever a change is meant to be "same analysis, faster or cheaper".

## How a comparison runs

1. Compare tab: the page loads each ticker itself (`cmpLoad`: `cmpStock` / `cmpFund`) and shows the code sections
   immediately (scores, fits, head to head, performance, risk, macro explorer, foreign affairs).
2. **Compare** (`cmpRun`) writes a request to the page database (`pfjobs/cmp-...`) and fires the scheduled task
   `trig_018Fgswa53erCrVMecyG5kdp` ("Industry Scorer: analyze a portfolio on GitHub") with `ANALYZE <id>`. Its
   prompt is in `runner/portfolio-task.md`. If you change that file, the live task needs the same prompt (update it
   from a claude.ai session with the scheduled-task tools). It also starts the company or fund analysis for any name
   without one (`cmpWrite`).
3. The task starts `portfolio.yml`, waits with `gh run watch`, then copies `exports/portfolios/<id>.json.gz` into the
   page database (`pfparts/<id>.N`). The page picks it up (`cmpWatch`, `jobRead`). Progress bars are time-based
   (`CMP_STAGES` in the page) because GitHub doesn't report progress back.
4. In the job (`runner/portfolio.mjs`, compare kind): load every industry run lite (from `cache/runs-lite.json.gz`; a
   whole run is opened from git only when read, via `window.__job_run` / `runGet`), load the industry digest cache,
   then the page's `cmpVerdict` runs:
   - Four desks (`Compare.DESKS`): events, macro and foreign affairs, Wall Street and sentiment, fundamentals. The two
     slow ones run as two halves at once on the same dossier (`DESK_PARTS`, merged by `mergeParts`). The dossier goes
     first and is prompt-cached, and the sampler holds the second half until the first starts, so it reads the cache.
   - The macro desk reads one combined macro/world/trade/rules text across all tickers' industries
     (`cmpCombinedAffairs`), so each row appears once with every industry's read.
   - The head of research writes the verdict (`Compare.prompt`, checked by `Compare.clean` and `reconcile`: the
     overall pick must win at least one investor type).
5. The job log prints every Claude call (`[claude] Compare macro desk (core): in ..., out ..., $..., ...s`).

Typical numbers (4 tickers, Nov 2026): GitHub setup about 34s, the desks about 75-140s, the head of research about
70s, roughly $2 in Claude calls. About half of each desk's output is thinking. Desk output is real analysis, so trimming
it would cut analysis; don't.

## Compare tab: decisions to keep

- **Every macro indicator cell has a read** (`mergeAffairs` → `codeRead`): its industry report's read, else code's
  estimate (marked `est`) from the ticker's measured factor sensitivity and its revenue by region (`expo`, from FMP
  geographic segments; a fund's US/non-US mix), else "not exposed". Bond funds read through duration (`bondRead`).
  Never show a bare dash.
- **Full text everywhere.** Industry digests keep text whole (up to 1,200 characters). `affairsText` cuts fields back to
  their old lengths only for prompts, so prompts stay stable. Desk output allows twice the asked length. Don't add
  CSS line clamps or `trimC` on content text.
- **Layout:** one card per ticker at the top of What's ahead, Macro indicators and Foreign affairs; industry calls,
  moves and flips as cards, one per industry (shared industries merged); indicators, trade and rules as tap-to-expand
  rows with filters (`cmpMiApply`, `cmpWire`); every section folds from its title. No Industry backdrop section.
- **Line-up:** every name has a one-line thesis (the verdict's `names[sym].thesis` where there's no written analysis);
  missing analyses are written automatically on Compare.
- **Rerun with no change** (same day, same reports and analyses, no price moved 2%) keeps the saved verdict.
- **Industry digest version** (`v` in `Portfolio.digest`, checked in `fundDigests`): bump it when what a digest stores
  changes, so cached ones rebuild.

## Data sources

The page declares these connector tools (Artifact capabilities). Adding a tool means republishing with the full list:
- FMP: analyst, calendar, chart, commodity, company, directory, earningsTranscript, economics, etfAndMutualFunds, forex,
  form13F, indexes, insiderTrades, marketPerformance, news, quote, search, statements.
- EODHD: get_company_news, get_sentiment_data, get_credit_corporate_hqm_yields, get_credit_corporate_cmdi,
  get_rates_reference_rates, get_ust_real_yield_rates, get_earnings_trends, get_fundamentals_data,
  get_historical_stock_prices, get_economic_events, get_stocks_from_search.
- Claude Code Remote: fire_trigger.

## Publishing the page

The live page is the built `web/industry-scorer.html`, published to the artifact URL above with the Artifact tool. If
this Claude Code session has no Artifact tool, finish with a PR and tell the owner the page needs republishing from a
claude.ai session. GitHub runs only need the merge.

## Working conventions

- One branch and PR per change; the owner merges. Never merge or push to main yourself.
- PR descriptions: what changed, why, and the checks run (with numbers where they exist).
- Before saying a change is "the same analysis", prove it with the prompt comparison above.
- Plain language in everything the owner reads (UI text, PRs, replies); no jargon without an explanation.
