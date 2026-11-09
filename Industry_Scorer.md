# Industry Scorer

A Claude artifact page that analyzes one US industry at a time, or every industry in a sector with one click (§1a). It scores the industry's 50 largest companies from 0 to 100 for four kinds of investor, and a team of AI analysts writes a detailed report on the industry.

- **Where it runs:** inside Claude, as a published artifact page.
- **Data:** the viewer's own **FMP** (Financial Modeling Prep) and **EODHD** connectors.
- **Analysis:** Claude, run on the viewer's own Claude account.
- **Background and saving:** there's no server-side database, cache or built-in list. Everything is fetched and generated when the viewer clicks an industry. A run keeps going at full speed in a background tab or behind another window. Each run is saved in the viewer's own browser (IndexedDB) after every finished step. If the page is closed mid-run, reopening it brings the run back and **continues by itself**, redoing only what wasn't finished. A web page can't run while it's closed. **Run again** rebuilds everything fresh. The 12 most recent industries are kept; another browser or device starts empty.
---

## 1. How a run works

Clicking an industry starts one full run, in this order:

| Stage | What happens | Who does it |
|---|---|---|
| 1. Industry list | Read from FMP (`available-industries`) when the page opens | Code |
| 2. Universe | Top 50 companies by market cap, plus companies that relisted under a new ticker (see §3) | Code |
| 3. Market data | Prices, statements, earnings and key metrics for every company; SPY and Treasury rates | Code |
| 4. Metrics and scores | Returns, risk, fundamentals, valuation, earnings and health, then a 0–100 score per investor type | Code |
| 5. Research | News, press releases, SEC M&A filings, analyst ratings, revenue segments, earnings-call transcripts, sentiment, macro catalog, world news wire | Code |
| 6. Analyst team | KPI analyst, macro planner and indicator analysts, macro strategist, world-events scout and situation analysts, trade-relations analysts, regulation analyst | Claude |
| 7. Regulatory rule books | One body at a time, then an overall regulatory verdict | Claude, plus a fact-check |
| 8. Lead strategist | Runs **last**. Synthesis, then verdicts, then an investment-committee review | Claude |

Agents run at most two at a time. Every Claude call asks for a fresh answer, never a cached one. Progress is saved in the browser after every step (§1 above); an interrupted run can be resumed, and **Run again** rebuilds everything from scratch.

---

## 1a. Sector runs: every industry with one click

Opening a sector shows **Analyze all N industries**. It runs every industry in the sector, and each one gets the same report it would get on its own. The rule is: **share the fact-finding, never the judgment.**

| Phase | What happens | Shared or per industry |
|---|---|---|
| A | SPY and rates, the sector pull, the macro catalog and the world news wire | Shared (code) |
| B | Market data, metrics, scores and research | Each industry (code) |
| C | One macro planner picks the series for every industry and tags each series with the industries it matters to; the series are fetched once | Shared |
| D | KPI analyst and earnings-call analyst, each with its own macro rows | Each industry |
| E | One world-events scout finds the live situations and says which industries each reaches, how strongly and in which direction | Shared |
| F | Trade map, customers and suppliers, regulation analyst | Each industry |
| G1 | Each situation: its facts once (now, trigger, developments, scenarios), then its transmission into each industry's earnings, three industries per call | Facts shared, impacts per industry |
| G2 | Each country named by any trade map: the US relationship, risks, invasion threats, policy and developments, three countries per call | Shared |
| G3 | Indicator analysts: what drives each series once, then relevance, effect and why it matters for each tagged industry. Quotes are verified per citation | Driver shared, reads per industry |
| G4 | Each regulator: one list with a top five per industry; each instrument's legal facts and events written once, its impact and company examples per industry (three per call); one fact-check per regulator, where a claim shared by several books is checked once | Facts shared, impacts per industry |
| H | Each industry's world, trade (what it depends on in each country, exposed tickers, supply-chain verdict) and macro write-ups from the shared facts, then its regulatory verdict and the full lead strategist (red team and review included) | Each industry |

- **Evidence IDs.** Company-news IDs (N, P, E, W, M, T) are numbered per industry, so in multi-industry prompts each industry's are shown as aliases (QA12, QB3, …) and mapped back. Wire and search items (G, X) are shared by the whole sector. Company news from every industry's research joins the indicator coverage pool, and whatever is used is copied into the shared store so every industry can cite it.
- **Same shapes.** Every multi-industry answer is split back into exactly the per-industry shapes the single pipeline produces, so scores, reports, rule books and the lead strategist read the same thing.
- **Calls.** About 18 per industry plus the shared work. Ten industries take roughly 400 calls instead of roughly 700 one at a time; 20 take roughly 770 instead of 1,400. The panel shows the live count.
- **Saving and resuming.** Progress is saved in the browser after every step (`sector:<slug>` plus its parts and the shared news store). If the page closes mid-run, reopening it carries on by itself. If the run stops (a usage limit, or **Stop**), **Resume** finishes only what's left. An industry whose data can't be pulled is left out and listed; a failed step is listed and can be finished from that industry's own page.
- **Overview.** A sortable table of every industry: score per investor type, best fit, the opportunity call, expected 12-month return, 1M/3M/6M/12M calls, forward P/E, 30-day revisions, positioning, 1-year return and market cap. Each row opens the industry's full saved report.

---

## 1b. The overnight job (your own API keys)

`runner/` runs sector runs on GitHub Actions instead of in the browser: on demand or nightly, on your own Anthropic API key, with no Claude plan limits. Setup and use: `runner/README.md`.

- **Same analysis.** It opens the real page in headless Chromium and presses "Analyze all". Only the connections change: `window.claude.use("sample")` goes to the Anthropic API (Claude Opus 5.5 on every step; effort high for the "complex" tier, medium otherwise), and `use("mcp")` goes to your FMP and EODHD MCP servers at their URLs. Results and call shapes match what the viewer gives the page.
- **Cheaper.** Requests are collected for a few seconds and sent through the Message Batches API (half price). Multi-round tool calls get a prompt-cache breakpoint so later rounds re-read the conversation at the cache price. The page runs 4 industries, 4 agents and 4 regulators at once in the job (`window.__INDUSTRY_SCORER_JOB__`), so batches are larger and the run takes hours, not days. In the browser it still runs one industry and two agents at a time.
- **Long runs.** A GitHub session lasts about 6 hours. At 5h20m the job stops the page cleanly, saves a checkpoint (the sector's saved records, the shared research and every Claude answer by request hash, including batches still running) and starts a continuation run, which re-attaches to those batches and reuses those answers. Nothing finished is paid for twice.
- **Results.** A `.json.gz` file with the sector record and each industry's saved run and track record. **Import its results file** in the picker loads it into the browser; the overview shows the job's measured API cost.
- **Failures.** A rejected API key or exhausted credit stops the run with that message and saves a checkpoint; data-tool errors are handled by the page as in the browser.

---

## 1c. Funds: ETFs and mutual funds through the industries they hold

The **Funds** tab opens any US stock ETF or mutual fund and reads it through the industries already analyzed. A fund is a weighted basket of industries, so its analysis is mostly code over the saved industry runs; Claude writes at most one piece per fund (step 3). Built in steps:

| Step | What | Who |
|---|---|---|
| 1 (built) | Facts and holdings from FMP and EODHD, each holding sorted and matched to an industry, the coverage report | Code |
| 2 (built) | Look-through roll-ups (scores, 1M-12M calls, scenarios, valuation, macro, world, trade, regulation), active weights vs the benchmark; quant-only fill for industries not analyzed | Code |
| 3 (built) | The full analysis, as deep as a company's: four analysts at once plus the outlook, rewritten only when the look-through moves | Claude |
| 4 | Compare 2-4 funds, a watchlist, funds in the GitHub job and its export | Code |
| 5 | Track record of the fund calls | Code |

- **Sources.** FMP (`etfAndMutualFunds`: `information`, `holdings`) gives every holding with its ticker and weight, refreshed daily, for ETFs and mutual funds alike. EODHD (`get_fundamentals_data`) gives the facts (expense ratio, turnover, yield, assets, category, family), the asset mix (US stock, non-US stock, cash, bonds, other), returns and volatility, and for an ETF every holding with its own sector and industry; for a mutual fund only the top 10 by name, from the last quarterly filing.
- **What each holding is.** A US-listed stock; a listing abroad (an exchange suffix: SHOP.TO, 000660.KS, BATS.L); a private company (no ticker: SpaceX, Anthropic Series F); cash (US dollar, cash central and money-market funds); a derivative (futures codes like IXRZ6, index contracts, CVRs); a bond. Only US-listed stocks are analyzed; the rest is shown with its weight.
- **Industry of each US stock.** The saved runs first (by ticker, then by name, so GOOGL maps through GOOG and BRK-B through BRK-A, the classes the runs kept), then EODHD's industry label, then an FMP profile for what's left (at most 25 per fund, each ticker looked up once and kept in `tickInd`). The runs win where sources disagree.
- **Coverage.** Every holding's weight falls in one bucket: analyzed (a saved run 14 days old or newer), stale, industry not analyzed, US stock with no industry, abroad, private, cash, derivative, bond. Per industry: weight, holdings, the share in the industry's top 50 and the run's age.
- **Cross-check.** A position in EODHD's top holdings that FMP lists at a very different weight, without a ticker, or not at all is flagged (Contrafund's SpaceX lock-up shares).
- **Benchmark.** 60%+ in one sector: that sector's SPDR; a Nasdaq fund: QQQ; anything else: SPY.
- **Look-through (step 2).** Each industry a fund holds is reduced to a small digest (`Portfolio.digest`): its scores per investor type (from the sector overview row, so every report section counts; from the page's own scoring when there's no row), the strategist's 1M-12M calls with their ranges and odds, the newer outlook, the scenario-weighted 12-month return and the bull/base/bear moves, valuation (P/E, forward P/E, EV/EBITDA, P/S, dividend yield, EPS and revenue growth, revisions), risk (beta, volatility, drawdown), the measured macro sensitivities, the world situations with their stance, the trade map's countries (stance, threat, estimated revenue share), the supply-chain rating, the regulatory verdict and its high and critical rules. Digests are kept per run version (`indDigest`), so a saved run is opened once. The fund figure is each industry's weighted by the fund's weight in it and renormalized over the industries it applies to; P/E-type ratios are weighted as shares of earnings (harmonic); each figure says how much of the fund it rests on. World situations are matched across industries by title; countries by name.
- **Against the benchmark.** The benchmark's own holdings (FMP) are matched to industries the same way. Per industry: fund weight, benchmark weight, active weight, the 12-month call and expected return. Overlap is the shared weight by industry; "what the tilts add" is the sum of active weight times expected return; "leaning with the analysis" is the share of active weight on the side the call points to.
- **Code-only fill.** Industries no saved run covers get the data step of a full run (prices, statements, estimates, metrics and scores, no Claude), saved as a digest marked code-only (`quant:<slug>`, `quantIndex`). On opening a fund, the biggest 8 uncovered industries at 0.5%+ of the fund are filled straight away; a button fills up to 20 more. Code-only scores leave out the report sections. An industry FMP doesn't know by that name is listed as not filled, with why.
- **The full analysis (step 3).** The fund page has the company page's layout: a sidebar and sections for the verdict and calls, where it's going, the analysis, fit and plans, holdings, industries, the benchmark, coverage, returns, risk, stress and boom tests, calls and scores through the industries, valuation and fundamentals, macro, world events, trade, regulation, drivers and risks, and the calendar. Code builds (`fundan.js`): the holdings joined to their industries' top-50 rows (rank, P/E, returns, yield, margin, next report, the industry's 12-month call, and the company's own saved analysis if there is one), concentration (top 10, effective number of holdings), the industries' fundamentals, what's priced in, positioning and base rates, weighted, and the dated calendar (holdings' earnings and the industries' events). From the fund's own prices since 2007 (FMP): returns against the benchmark and SPY, risk over 1, 3 and 5 years (beta, alpha, volatility, Sharpe, Sortino, tracking error, information ratio, capture, drawdown, VaR), the crisis and boom episodes, trend, and its measured macro sensitivities next to its industries'.
- **Four analysts and the outlook.** One ID'd dossier (F fund, I industries, H holdings, A benchmark, P price facts, S episodes, MF the fund's measured sensitivities, V fundamentals and valuation, E calendar, W world, C countries, M the industries' sensitivities, R rules, O outside the analysis); each analyst gets the slices its fields draw on. Core: headline, verdict, thesis, the call against the benchmark, how the fund is run, valuation, quality, risks, catalysts, watch, fit per investor type (at most 5 points from the weighted score) and panel reads. Calls: bull/base/bear scenarios, the 1M-12M calls with ranges, odds and the events in each window, plans per investor type, what would change the call. Context: drivers, a row for every industry, the macro (regime, horizons, a row for every measured factor), a row for every world event. Exposures: trade and regulation overall and row by row, and what each holding outside the analysis means. The outlook: each window's call with the case for and against. All five run at once on the complex tier; citations to unknown IDs are removed and counted; code checks the calls (probabilities add to 100, the 12M call agrees with the scenarios, ranges hold their call's direction and widen with time). Kept per fund (`fundFull:<SYM>`) and rewritten only on the step-3 rules, so reopening a fund costs no Claude call.
- **The calls, the company page's way (phase 1 of making funds match companies).** The fund's 1M-12M calls come from the same outlook engine as a company's (`outlook.js`): six levels, no neutral, each window's own direction, with no % ranges or odds anywhere. One call after the write-up weighs the fund's sixteen components (its industries' outlooks, the write-up's verdict, holdings and concentration, earnings and revisions, valuation and what's priced in, quality, Wall Street on its holdings, momentum, past setups like today, dated catalysts, macro, world events and trade, regulation, its tilt against the benchmark, coverage and blind spots, risks) up, down or mixed at weight 1-3, then makes each call with the case for, the case against and why it loses, and what would flip it. Each window starts at code's starting point (`FundAn.prior`): its industries' outlook calls weighted by the fund, moved half a notch for its own setups like today against all days, Wall Street on its holdings (6M and 12M) and an overbought or oversold month (1M); the call must say why it moves off it. Next to each call, as on the company page: the starting point and how far the call moved from it, the share of covered weight bullish and bearish, the last move against a normal one (one sigma from its volatility), how often it was higher over that span in its own history, and the holdings reporting inside the window. Code's checks and the one repair call are the company page's. Each outlook is kept with its history and the price at the time; when code's starting point moves in any window the page says the calls are out of step and "Redo the calls" makes them again (one call). The write-up's calls part now gives what drives each window and what lands in it, and scenarios as probability, story and triggers. The track record scores the six-level calls: the right direction, and whether the strength held (slightly: inside a normal move; plain: half a normal move or more the called way; strongly: a full one).
- **The rest of the company page, for funds.** Times like this (the 40 past days most like today in the fund's own history, by 1-, 3- and 12-month momentum and distance from the 200-day average, and what came next against all days); a trade plan (the fund's own levels and a plan per investor type); a track record (each window's call is logged with the day's price when the analysis is written, and scored once the window has passed: the right direction, a neutral call within ±2%, and inside the range); timeframe patterns (the company page's daily, weekly and monthly technicals and pattern match, on the fund's prices); rolling beta and correlation to the benchmark; Wall Street on the 15 biggest holdings (FMP ratings and consensus targets, each ticker kept a day and shared across funds; weighted buy share and upside from the holdings file's prices); news sentiment on the 10 biggest (one EODHD call) and their latest news (one FMP call); and the fund's distributions. These are read once a day per fund (`fundNet:<SYM>`), after the page is up and before the analysis is written, and the analysts get them as T, N, NW, D and K lines; the core analyst also says where it lands against Wall Street.
- **Search suggestions.** The fund box suggests as you type, by ticker or name: funds opened here, FMP's ETF directory (US listings, fetched once a week and kept in `etfDir`), and FMP's symbol and name search for mutual funds (one call pair per query, 250 ms after typing stops, kept for the visit; foreign listings, indexes and stocks are left out). Exact tickers first, then tickers that start with what's typed, then names whose words do; the best-known funds rank ahead of look-alikes. Arrow keys and Enter pick one; a name typed and submitted opens the best suggestion.
- **Saving.** Each fund's raw data is kept in the browser for 20 hours (`fund:<SYM>`), with a list of recent funds (`funds`).

---

## 2. Report sections

1. **Overview:** the lead strategist's verdict. See §6.
2. **Scores:** 0–100 and a letter grade for each investor type, with a breakdown by pillar.
3. **Industry deep dive:** demand and profitability KPIs, where the business cycle stands, unit economics, pricing power, demand and supply drivers, hot and cool segments, what management is saying, and upcoming triggers.
4. **Macro conditions:** the regime call by horizon (1M, 3M, 6M and 12M), "What's moving and why", and the full indicator table. See §5.
5. **World events:** live situations found in the news, each with a deep dive.
6. **Trade relations:** the countries that hold leverage over the industry, its dependencies, the exposed tickers and the supply-chain verdict.
7. **Regulation, legal & M&A:** the regulators that matter, their rule books, the regulatory verdict, policy, litigation and deals.
8. **Sentiment & news**
9. **Quant sections:** performance vs SPY, risk, fundamentals, valuation, earnings, financial health, and the table of companies.

---

## 3. Universe

You pick a **sector**, then one of its **industries**. Companies are fetched and organized in six steps (`universe.js`):

1. **Sector normalization.** A sector name or SPDR sector ETF ticker maps to FMP's taxonomy. Typing one in the search box opens that sector.

   | You type | FMP sector |
   |---|---|
   | Technology, Information Technology, XLK | Technology |
   | Financials, XLF | Financial Services |
   | Consumer Discretionary, XLY | Consumer Cyclical |
   | Consumer Staples, XLP | Consumer Defensive |
   | Materials, XLB | Basic Materials |
   | Communication Services, XLC | Communication Services |
   | Health Care, XLV · Industrials, XLI · Energy, XLE · Utilities, XLU · Real Estate, XLRE | same name |

2. **Live sector pull.** One FMP `company-screener` call for the whole sector:
   - exchanges NASDAQ, NYSE and AMEX
   - `isEtf=false`, `isFund=false`, `isActivelyTrading=true`
   - limit 5000
   
   The pull is kept in memory for 15 minutes, so opening a sector and then running one of its industries doesn't pull twice. If the sector pull fails, the same rules run on that industry's own pull.
3. **Hygiene.** These rows are dropped:
   - **symbols** that aren't 1–5 capital letters. One share-class letter is allowed (BRK-A, BRK-B), so Berkshire reaches step 4 instead of vanishing.
   - **blank industries**
   - **non-operating names** matching `/\b(etf|fund|trust|notes? due|preferred|warrant)\b/i`, plus names carrying a coupon ("4.50%"). A "Trust" that is an operating company is kept: the name also says Inc, Corp, Bank, Bancorp, Financial, Realty, Property or REIT (Northern Trust, Digital Realty Trust, Camden Property Trust). Royalty and grantor trusts are still dropped.
   - **market cap** missing or ≤ 0
4. **Share-class dedupe.** Names are normalized (Inc, Corp, Class A and punctuation removed). Where several tickers are one company (GOOGL/GOOG, FOXA/FOX, BRK-A/BRK-B), the larger market cap is kept. A listed note or preferred that carries its parent's exact market cap, and whose ticker starts like the parent's (BN → BNJ, BNH), counts as the same company too.
5. **Micro-industries pruned.** Industries with fewer than 15 companies in the sector are left out. The picker lists them with their counts.
6. **Grouping.**
   - Companies are grouped by industry, largest first.
   - Each run analyzes the industry's **50 largest**.
   - The industry's total market cap counts every company in it.
   - Industries are ranked by total market cap; the picker shows each one's rank, company count and total.
- **No market-cap floor:** the old $300M floor is gone, so the only cap rule is "more than 0".
- **US-only option:** keeps only US-headquartered companies, which leaves out foreign companies listed in the US such as TSM and ASML. Counts and rankings are recomputed when it's switched.
- **Relisted companies:** when a member of the industry stops trading under one ticker and starts trading under another, it keeps its SEC CIK (the SEC's company ID). The page uses that to bring the company back into the industry:
  1. Find the industry's members that are no longer actively traded.
  2. Look up each one's CIK.
  3. Find an actively traded ticker with the same CIK.

  For example, Paramount Skydance (PSKY, filed under "Entertainment") now trades as **Skydance Corp (SKYD)**, which FMP files under "Broadcasting". SKYD is kept in Entertainment and marked "formerly PSKY". Its prices, statements, transcripts and news from before the relisting come from PSKY. If an analyst writes the old ticker, it is shown as the new one.
- **Foreign filers:** statements reported in another currency are converted to USD at today's FMP exchange rate.

---

## 4. Quant engine (code, not opinion)

### Metrics

| Group | Metrics |
|---|---|
| Performance | Total returns over 1M, 3M, 6M and 1Y; cap-weighted and median-stock returns vs SPY; breadth (share of companies beating SPY) |
| Risk | Beta, volatility, downside volatility, maximum drawdown, Sharpe ratio (vs the 3-month T-bill), measured on a daily cap-weighted industry index |
| Fundamentals | Trailing-twelve-month aggregates (sums, not averages of ratios): revenue and earnings growth, margins, ROE, ROIC, free-cash-flow margin |
| Valuation | P/E vs its 5-year median and percentile, P/S, P/B, EV/EBITDA, dividend yield, how well free cash flow covers dividends |
| Earnings | Beat rate and median EPS and revenue surprise over the last 4 quarters; next report dates |
| Health | Debt to equity, current ratio, interest cover |
| Estimates & revisions | Consensus next-12-month EPS and forward P/E, expected EPS and revenue growth, PEG, estimate spread, and how estimates moved over 30 and 90 days with up vs down revision counts |
| What's priced in | Reverse DCF: the 10-year free-cash-flow growth today's market cap implies, at a cost of equity of the 10-year yield + beta × equity risk premium, vs the industry's 5-year revenue growth and consensus |
| Balance-sheet cycle | 12 quarters of inventory days, days sales outstanding, capex/sales, revenue growth and net debt/EBITDA by calendar quarter |
| Earnings quality | FCF conversion, stock-based pay % of revenue (and margins after it), diluted share count change, buybacks |
| Macro sensitivities | Regressions of the industry's daily returns on SPY, the 10-year yield, oil, the dollar and high-yield credit |
| Positioning | Insiders, institutions (13F), short interest and price stretch, rolled into crowded / neutral / washed out |

### Forward view (estimates, revisions, what's priced in)

- **Sources:**
  - **EODHD earnings trends** give this fiscal year's and next year's consensus, plus the estimate history 7, 30, 60 and 90 days ago and the count of analysts revising up or down. They're fetched 10 companies per call.
  - **FMP financial estimates** fill in any company EODHD doesn't cover. They have no revision history.
- **Next-twelve-month EPS:** blends this fiscal year and next by the time left in this one.
- **Growth on the same basis:** analysts' EPS is usually adjusted (non-GAAP), so growth is measured against last-twelve-month EPS on the same adjusted basis, not reported earnings.
- **Sanity check:** an estimate that is less than 0.2x or more than 8x trailing EPS is left out, because it's probably in another currency or share basis (an ADR). The page lists what was left out.
- **Scenario math basis:** the bull/base/bear math starts from the forward P/E when consensus covers at least half the industry's market cap, and the scenario EPS change is measured against consensus.
- **What's priced in:**
  - It's judged against the 5-year revenue growth the industry actually delivered.
  - **Demanding** means the price assumes more than 5 points a year above that; **undemanding** means more than 5 below.

### Balance-sheet cycle and earnings quality

Twelve quarters of balance sheets and cash flows per company are summed by calendar quarter. A quarter counts only when at least 60% of the companies report it, so a changing mix doesn't fake a trend. Inventory or receivables days rising faster than sales are the classic sign of a cycle turning.

### Measured macro sensitivities

- **Data:** one year of daily data for the industry index, SPY, the change in the 10-year Treasury yield, USO (oil), UUP (dollar) and HYG (high-yield bonds).
- **Two measures per factor:**
  - **total:** a simple regression, so it includes everything that moves with that factor
  - **beyond the other factors:** a multiple regression on all five at once
- **What's shown:** each is scaled to a typical shock (+1% market, +0.25pp yield, +10% oil, +5% dollar, −2% high yield). Each comes with a t-statistic as strong, clear, weak or not significant, and a check that the sign held in both halves of the year. A factor that never moved is left out.
- **How they're used:** the lead strategist sizes decisions and shocks with them. For example, a Fed surprise that moves the 10-year 0.25pp, or a war that lifts oil 10%.

### Positioning

For the 25 largest companies:

| Signal | Source | What's measured |
|---|---|---|
| Insiders | FMP insider statistics | Open-market purchases and sales in the last two quarters vs each company's own norm for the eight before |
| Institutions | FMP 13F summary, latest complete quarter | Ownership change, holders added or lost, new vs closed positions, the 13F put/call ratio |
| Short interest | EODHD | Short interest as a share of float |
| Price | The run's own prices | The index vs its 50- and 200-day averages, 14-day RSI, distance from the 52-week high, recent vs 1-year volatility, share of companies above their 200-day average |

Each extreme signal adds a point toward **crowded** or **washed out**. The positioning pillar is contrarian: crowded scores low and washed out scores high. Options implied volatility isn't available on the current EODHD plan (403), so the 13F put/call ratio is the options read.

### Long history, base rates and sector peers

- **Source:** FMP keeps a daily average price change for every industry since 2008 and a daily industry P/E since 2010, per exchange. It covers every listed company, including ones that later failed or were bought, so there's no survivorship bias. The exchanges are mixed by where the top 50's market cap is listed.
- **Drawdowns:** every fall of 20% or more: depth, days to the bottom, days to recover.
- **Analogs:** the 40 past days most like today on 1-month, 3-month and 12-month momentum and distance from the 200-day average, at least three weeks apart. For each, what the industry did over the next 1/3/6/12 months (median, middle half, share up) next to all days. These give the **base-rate odds** that the 1M–12M calls start from.
- **Valuation:** today's P/E percentile in its own history since 2010, and 12-month returns after similar percentiles.
- **Seasonality and rates:** average return by calendar month, and 6-month returns when 7–10 year Treasuries (IEF) were falling (yields rising) vs rising.
- **Tracking check:** the daily correlation between this equal-weighted history and the run's own top-50 index.
- **Sector peers:** the other industries in the sector (from the sector pull), with FMP's industry P/E and 1M/3M/1Y returns, and this industry's rank. Also the sector's SPDR ETF.

### Company ranking and concentration

- **Ranking:** every company gets a 0–100 percentile within the industry on value, quality, growth, momentum, estimate revisions and risk. There's also a composite per investor type, so the "best ways to express it" come from data.
- **Concentration:**
  - the top three's weight and the effective number of equal-sized companies
  - 1-year return cap-weighted, without the top three, equal-weighted and for the median company
  - P/E and forward P/E without the top three
  - the spread between the 75th and 25th percentile company

### Trade plan

For each investor type, code computes:

| Part | How it's set |
|---|---|
| Size | The share of a portfolio at which the position adds the type's volatility budget (income 1.5pp, conservative 1.2pp, growth 3pp, aggressive 5pp), scaled by fit (strong 1, moderate 0.6, weak 0.25) and conviction (high 1.2, medium 1, low 0.7), capped at 20% |
| Entry | From positioning: crowded scales in a third now and the rest on a pullback to the 50-day; washed out builds now; neutral is half now, half after the next high-importance event |
| Hedges | Short about beta × SPY to isolate the industry bet; a Treasury-duration pair when the measured rate sensitivity is significant |
| Wrong if | A 1.5-sigma one-month fall, or the verdict's "what would change it" |

Alongside:
- the index's levels (50/200-day, 52-week range, swing low)
- the largest companies' price levels
- the average two-day move around each of their last four earnings reports, the stand-in for the options market's expected move
- liquidity: names trading under $10M a day are flagged and left out of suggestions

### Credit

- **Market stress:** the NY Fed's corporate bond market distress index (overall, investment grade, high yield) from EODHD, with its 3-month change and percentile over two years.
- **Spreads:** high-yield bonds vs Treasuries over 3 months, where negative means spreads are widening.
- **Industry exposure:** companies with interest cover under 3x or net debt over 3x EBITDA, and their share of the industry. This also scores in financial health.

### Customers and suppliers

- **Who:** a value-chain analyst names the 4–8 listed companies outside the industry whose decisions most drive its demand or supply.
- **Checks:** code confirms each ticker is real, actively traded and not in the industry.
- **Their numbers, from their own filings:**
  - revenue growth
  - capital spending, trailing 12 months and latest quarter vs a year earlier
  - whether capex is accelerating
  - capex as a share of revenue
  - their share prices
- **Use:** customers' combined capex is the hard demand signal and scores in the industry-cycle pillar.

### Earnings calls: what changed

- **Coverage:** for the six largest companies, the previous quarter's transcript is fetched too.
- **What's compared:** an earnings-call analyst compares the two calls on tone, guidance, new and dropped topics, and new risks.
- **Quotes:** "now" and "then" quotes are checked word for word against each transcript, and any that don't match are removed.
- **Scoring:** tone and guidance changes score in the industry-cycle pillar.

### Red team

- **Who:** after the verdicts, an independent investor argues against the draft: a short seller if the draft is constructive, a contrarian long if it's negative.
- **What it writes:**
  - 3–6 arguments with evidence
  - a pre-mortem: 12 months on and the verdict is badly wrong, the most likely paths, their odds and the earliest warning signs
  - blind spots
  - kill criteria
- **How it's answered:** the investment-committee review must answer each argument (agreed, partly, disagreed) and revise where it agrees. The page shows each argument with the review's answer.

### Track record

- **What's logged:** every finished lead verdict, in this browser:
  - the 1M/3M/6M/12M calls
  - the scenario ranges and probabilities
  - the expected return and the opportunity call
  - the companies with their weights and prices
- **When it's scored:** each new run of the industry, or **Check how past calls did**, scores the logged calls against what actually happened. The industry's move is the cap-weighted return of the companies as they were weighted when the call was made, shown next to SPY's.
- **What's measured:**
  - direction (bullish and it rose, bearish and it fell, neutral and it stayed in range)
  - whether the move landed inside the range
  - Brier score of "chance it's higher" (0.25 = coin flip)
  - the miss vs the range's midpoint
  - after 12 months, which scenario it landed in
- **Calibration:** the strategist reads its own record and is told to calibrate its ranges and probabilities to it. **Delete saved runs** clears the record too.

### Scores

Scores take every section into account. Each investor type's score combines **21 pillars**, each 0–100:

- **13 metric pillars:**
  - momentum: returns vs SPY in every window, breadth in every window, the median stock
  - growth, including consensus expected EPS and revenue growth
  - profitability
  - valuation: P/E vs its own 5-year history and percentile, forward P/E, PEG, and growth priced in vs sustained
  - earnings
  - **estimates & revisions:** 30- and 90-day estimate changes, revision breadth, the share of companies with rising estimates
  - **earnings quality & working capital:** FCF conversion, stock-based pay, dilution, inventory and receivables days vs a year ago, net debt/EBITDA
  - financial health
  - risk, including concentration
  - risk-adjusted return
  - income
  - **positioning:** contrarian
  - **base rates & valuation history:** returns after similar setups, P/E percentile since 2010, P/E vs sector peers
  
  Two more feed existing pillars:
  - Financial health also counts the share of the industry with stretched credit.
  - The industry-cycle section pillar also counts customers' capex and the change in earnings-call tone and guidance.
- **8 report-section pillars,** scored by code from each section's ratings, probabilities and counts, never from free text:

| Pillar | Data points |
|---|---|
| Industry cycle & KPIs | Cycle position, pricing power, demand and supply drivers, management tone, hot vs cool segments, operating leverage |
| Macro backdrop | Regime call overall and by horizon; every indicator read (tailwind or headwind), weighted by relevance |
| World events | Each live situation by stance × relevance × status; the situations' scenario-weighted earnings direction |
| Supply chain & trade | Code-computed system health, the rating, cost pass-through, de-rating risk, country stances, bottlenecks |
| Regulation & legal | Regulatory verdict (stance × intensity), binding rules by severity from the rule books, policy items, litigation |
| Sentiment & perception | Measured news sentiment and its trend, investor perception |
| Sell-side consensus | Buy share and upside to price targets, cap-weighted |
| Strategist outlook | Bull vs bear scenario probability, ranked drivers, the evidence-checked landscape scorecard |

Weights per investor type (each column sums to 100):

| Pillar | Income | Conservative | Growth | Aggressive |
|---|---|---|---|---|
| Momentum vs SPY | 3 | 3 | 9 | 14 |
| Growth | 3 | 3 | 16 | 12 |
| Profitability | 9 | 8 | 7 | 3 |
| Valuation | 9 | 10 | 4 | 3 |
| Earnings | 3 | 4 | 7 | 8 |
| Estimates & revisions | 3 | 3 | 7 | 8 |
| Earnings quality & working capital | 3 | 4 | 3 | 2 |
| Financial health | 12 | 12 | 3 | 2 |
| Low risk | 7 | 12 | 2 | — |
| Risk-adjusted return | — | — | — | 6 |
| Income | 16 | 3 | — | — |
| Positioning (contrarian) | 2 | 2 | 2 | 4 |
| Base rates & valuation history | 2 | 3 | 2 | 2 |
| Industry cycle & KPIs | 4 | 5 | 12 | 8 |
| Macro backdrop | 6 | 6 | 5 | 5 |
| World events | 3 | 5 | 3 | 3 |
| Supply chain & trade | 4 | 6 | 4 | 3 |
| Regulation & legal | 5 | 5 | 3 | 2 |
| Sentiment & perception | 1 | 1 | 2 | 5 |
| Sell-side consensus | 2 | 2 | 4 | 4 |
| Strategist outlook | 3 | 3 | 5 | 6 |

A section that isn't written yet has its weight shared among the others. The lead strategist can then add at most **±5** for judgment. On the page, each pillar opens to show every data point, its value and what it scored. **Grades:** A is 80 or higher, B 65+, C 50+, D 35+, and F below 35.
---

## 5. Macro: chosen fresh each run, with every driver backed by news

1. **Catalog (code).** Lists everything the connectors offer that day:
   - the full Treasury curve
   - every economic release with a reported value in the last ~45 days, in every country
   - all commodity, index and USD currency-pair quotes
   - EODHD's SOFR, real-yield and corporate-bond series, when that connector has them
2. **Macro planner (Claude).** Picks the 30–50 series that matter for *this* industry and groups them by what they mean to it, such as "Input costs" or "Taiwan & Korea supply base". For each series it gives:
   - one line on why it was chosen
   - news phrases an article about it would use
   - topic tags to search on

   If the planner can't run, code chooses from the data: the curve, high-impact releases in the countries the companies sell in, and the day's biggest commodity moves.
3. **Coverage gathering (code).** Collects articles from the whole run that could explain each series' move:
   - the CNBC news wire
   - every article the world-events and trade teams pulled
   - market and company news, and earnings-call excerpts
   - **the market news from the day of each release and the day after**
   - currency news linked to each currency pair
   - topic-tag searches around each release date

   Articles are scored against the series: its phrases in the headline count most. A release in another country doesn't count ("UK CPI" is not US CPI).
4. **Indicator analysts (Claude, one per group).** For every series they write:
   - its **relevance** (high, medium or low) and why
   - whether it's a **tailwind or headwind**
   - **what's driving it**: actual vs consensus vs prior, the real-world cause, and whether the trend is building or fading
   - **why it matters** for revenue, costs or the valuation multiple
   - **what to watch next**

   They can search the news and read articles in full. For each article they cite, they must **quote the sentence that explains the move**. Code checks the quote is word-for-word in the article and that the article is about that series, and removes the citation otherwise.
5. **Macro strategist (Claude).** Writes the regime call (supportive, mixed, restrictive or hostile) overall and by horizon. It also writes "What's moving and why", how the world situations and the macro backdrop connect, the channels into the industry, and what would flip the call.

---

## 6. Lead strategist (the "brain")

It runs **after everything else**: every specialist report, every regulatory rule book and the regulatory verdict.

**The dossier (code).** Everything from the run is compacted into one document:
- quant metrics and scores
- KPIs
- the macro regime and every indicator read
- the world deep dives with their scenarios
- trade relations and the supply-chain verdict
- regulation, legal and deals
- every rule book and the regulatory verdict
- sell-side consensus, sentiment and news
- a source index for every ID it cites

**Six Claude calls, plus a calendar built by code** (the red team is step 6, before the review):
1. **Synthesis.** Headline and thesis; the ranked drivers across all sections; the market's key debates (bull vs bear, what settles each, which way it leans); what's priced in; where the specialist reports disagree and how that resolves; and what would change the view.
2. **Scenarios and the opportunity call.**
   - **Bull, base and bear:** each says what happens in every section, with probabilities, an EPS change, an end P/E and a price move.
   - **Opportunity call:** yes, conditional or no, with the best tickers to express it and the ones to avoid.
3. **The calendar (code).** Before the horizon calls, code gathers everything ahead from every section:
   - **Dated events (C-IDs):**
     - central-bank decisions, elections and major data for the next 12 months, from FMP's economic calendar (the US, euro area, China, Japan, the UK and the industry's top trade partners)
     - the largest companies' earnings dates
     - rule-book deadlines, rulemakings and hearings
     - policy decisions with a date
     - the KPI analyst's triggers and the macro team's watch list
     
     A recurring event shares one ID: for example, every FOMC meeting.
   - **Standing situations (S-IDs):**
     - wars and conflicts from the world-events team
     - invasion and blockade threats, the biggest country risks and critical bottlenecks from the trade team
     - high-severity rules and the regulatory verdict
     - pending policy, litigation and deals
     - the macro regime
   - Each item is marked high, medium or low importance.
4. **Calls by horizon (1M, 3M, 6M, 12M).** Each call is its own judgment, not the 12-month view scaled down. It gives:
   - the call with a conviction, the expected price move as a range, and the chance the industry is higher at the end of the window
   - **a read on every section** for that window
   - **every important decision in the window**, with what each outcome would do and which way it leans
   - **every war, conflict and threat**: what's likely to happen within that window, with a probability, and what it does to prices and earnings
   - what to do, what would make it wrong, and which sections drive it
   
   What dominates changes with the horizon:

   | Horizon | What dominates |
   |---|---|
   | 1M | Dated decisions and events, momentum, breadth, positioning |
   | 3M | Earnings season, central-bank and policy decisions, near-term regulatory and trade actions, how the conflicts develop |
   | 6M | Estimate revisions, the policy path, rule books coming into force, where wars and trade disputes are heading |
   | 12M | Earnings power and valuation; must agree with the scenarios |
5. **Verdicts.** For each investor type: how well it fits, conviction, the verdict with a read on every section, the score adjustment and why, and what would change it. The verdicts also weigh the calendar and the standing situations, and stay consistent with the horizon calls. Also the notes for each quant section, a 7-dimension landscape scorecard, catalysts, risks and dates to watch.
6. **Investment-committee review.** A skeptical reviewer checks the draft against the dossier and the calendar for:
   - missed factors, numbers that contradict the data, unsupported claims and contradictions
   - scenario and horizon numbers that don't add up
   - any horizon that leaves out a section, a high-importance decision in its window, or a war or threat
   
   Its corrections replace the affected fields. The issues it flagged can be expanded on the page.

**Horizon facts (code).** Given to the strategist and shown on each card:
- **A normal move:** one standard deviation of the industry index over the window, from its last year of daily prices.
- **Trailing return:** over the same length, vs SPY, with breadth.
- **Earnings in the window:** which of the largest companies report inside it, and their share of the industry.

**On the page:**
- Each horizon card lists its decisions and its wars, conflicts and threats.
- "Every section in each window" is a table of the section reads.
- "The calendar the calls were built on" lists every C- and S-item and which horizons used it. Citations like [C3] and [S1] link to it.

**Critic (code).**
- Citations must resolve to a retrieved source.
- Unsupported dimensions are set to neutral.
- Scenario probabilities are scaled to add to 100. Code computes the expected return, reward-to-risk and probability of loss.
- Each horizon call is checked; anything that doesn't add up, and anything it leaves out, is flagged on its card:
  - the call vs its own range and probability
  - the range vs two standard deviations
  - the 12M range vs the scenarios' expected return (within 6 points)
  - coverage: every high-importance dated event in the window, every high-importance standing situation, and a read for every section
- Score adjustments are capped and scaled by how well they're supported.

---

## 7. World events and trade relations

**World events.** There is no fixed watchlist.
- The page reads 10 days of CNBC's US feed through EODHD and follows the other CNBC desks tagged on those articles. It adds FMP's general market news.
- A scout groups the news into up to 8 live situations. Its searches only return articles whose headline or opening actually mention the topic.
- Each situation gets 30 days of coverage and a deep dive covering:
  - the transmission chain into the industry
  - revenue, cost, demand and regulatory channels
  - the impact on the financial statements
  - an exposure map and scenario map
  - winners and losers

**Trade relations.** This is about the **United States' trade relations with other countries**, so the US itself is never listed as a country.
- **Leverage ranking:** 10–14 countries other than the US, ranked by how much leverage they hold over the industry's operations. Each has:
  - its relationship with the US (allied, competitive, adversarial or sanctioned) and a trajectory (improving, deteriorating, volatile or escalating)
  - a **security threat** (none, low, elevated, high or critical), which covers the threat of invasion, blockade or war, with a one-line note
- **Share of revenue**, in this order:
  1. the companies' own geographic segment filings
  2. if a country isn't broken out, the analyst's estimate, labeled "≈ X% est." with its basis shown on hover
  3. otherwise "not broken out"
  
  Many companies report regions (Europe, Asia Pacific) rather than countries, and supplier countries aren't sales markets, which is why filings alone leave blanks. The regional split from the filings is listed under the table.
- **Country deep dives:**
  - **relationship with the United States:** alliance (treaty ally, partner, neutral, rival or adversary), the current trade terms, tension points and areas of cooperation
  - **risks:** 3–6 specific risks (tariffs, export controls, sanctions, military conflict, political instability, currency, regulation, expropriation, logistics), each with likelihood, impact, timing, how it hits earnings and the exposed tickers, worst first
  - **security:** the threat level, what the threat is (e.g. an invasion or blockade), its current status and what it would do to the industry, highlighted in red when high or critical
  - dependencies: how critical each input is, how hard it is to replace (6 months, or 3–5 years and billions in capex), and the risk of losing it
  - the policy in play
  - the exposed tickers and through which part of the income statement
- **Supply-chain verdict:** a rating of healthy, manageable, strained or critical, the bottlenecks, and the investment read (can price increases be passed through, or is there a risk of a lower valuation multiple). It weighs each country's relationship with the US, its risks and its security threat.
- **Health score:** code-computed. An invasion or war threat adds strain in proportion to the country's importance. The supply pillar of every investor score also includes "Invasion and war threats".

---

## 8. Regulation and rule books

- **Regulators.** The regulation analyst names the 4–8 regulators that actually move earnings, pricing or volumes, with each one's levers. It also sorts the headlines into regulatory and legal.
- **Rule books.** They build **automatically, one body at a time**, in two steps so no single answer is long enough to be cut off:
  1. Pick the body's 5 most material binding instruments, searching the news as it goes.
  2. Write each instrument up in its own call: what it is, the impact on the industry, the last 12 months, where things stand today, the next 12 months, company examples and the bottom line.

  An answer that is cut short anyway is repaired rather than discarded. A failed rule book gets one automatic retry.
- **Fact-check.** Every sentence with a number or a citation is labeled:
  - **verified**, with a word-for-word quote from the source
  - **corrected**
  - **legal background**, allowed only for the rule's own legal parameters
  - **unsupported**, which is removed

  Company examples must name a company that appears in the cited article.
- **Overall regulatory verdict.** Written only after every rule book is done, from all of them in full.

---

## 9. Evidence and safeguards

**Citation IDs:**

| ID | Source |
|---|---|
| N | Company news |
| P | Press release |
| W | Market news |
| M | SEC M&A filing |
| E | EODHD news with sentiment |
| T | Earnings call |
| I | Macro indicator |
| G | News wire |
| X | Searched article |
| RA, RB, … | Rule-book sources |

**Safeguards:**
- **Citations:** code removes any citation that doesn't match a retrieved item.
- **Unsourced figures:** labeled as estimates.
- **Tickers:** limited to the industry's companies, their former tickers, and the parties to retrieved M&A filings.
- **Macro drivers:** need a verified quote from the article.
- **Rule-book claims:** fact-checked as described in §8.

---

## 10. Known limitations

- **Survivorship bias:** today's top 50 companies are used for all of the history, and past index weights come from price moves, ignoring buybacks and share issuance.
- **Run time and cost:** a full run makes many Claude calls on the viewer's own usage (about 70 per industry; a sector run about 18 per industry plus the shared work). Specialists, rule books and the lead strategist together take several minutes.
- **Industry labels:** FMP's industry classification sets who is in the industry. A company FMP files elsewhere (for example Comcast, outside Entertainment) is included only if it relisted from this industry.
- **Data gaps:** news coverage depends on what FMP and EODHD carry. Some moves honestly have no coverage, and the page says so.
- **Not available:**
  - options implied volatility (not on the current EODHD plan)
  - short interest history (only the latest level)
  - market-implied odds for Fed decisions or elections
- **Track record:** it builds up only from verdicts made in this browser, so it starts empty.
- **Long history:** FMP's history is equal-weighted across every listed company, so it can differ from the cap-weighted top 50. The page shows how closely they track.
- **Customers and suppliers:** they're named by an analyst (the numbers are from filings). Filers in other currencies are left out of the dollar totals.
- **Sensitivities:** they cover one year of daily data, so they reflect this year's regime and can shift.

---

## 11. Code layout

| File | Role |
|---|---|
| `page.src.html` | Page shell, orchestration and rendering |
| `engine.js` | Universe, returns, risk and the industry index |
| `fund.js` | Fundamentals aggregation and USD conversion |
| `score.js` | Absolute scores, pillars, investor types and grades |
| `research.js` | News, filings, consensus, segments, transcripts, sentiment |
| `macro.js` | Macro catalog, fallback plan, series fetch, biggest movers |
| `coverage.js` | News coverage behind each indicator; quote verification |
| `team.js` | Specialist prompts and critics; ticker whitelist |
| `world.js` | CNBC desk discovery, wire, scout tools |
| `universe.js` | Sector normalization, hygiene, share-class dedupe, pruning, industry ranking |
| `trade.js` | Country exposure, trade prompts, health score |
| `forward.js` | Estimates parsing, NTM blend, revisions, forward aggregates, reverse DCF |
| `sensitivity.js` | Regressions on SPY, 10-year yield, oil, dollar, credit |
| `positioning.js` | Insiders, 13F, short interest, price stretch, crowding rules |
| `track.js` | Logging calls and scoring them against what happened |
| `history.js` | Long industry history, drawdowns, analogs, valuation and rate base rates, sector peers |
| `plan.js` | Company ranking, concentration, levels, earnings moves, liquidity, position plans, credit |
| `chain.js` | Customers and suppliers; earnings call-to-call changes |
| `horizon.js` | Calendar of decisions, wars and threats; horizon facts, prompt, coverage checks |
| `sector.js` | Sector runs: multi-industry prompts, ID aliases, splitting answers back into per-industry shapes, overview rows |
| `regbook.js` | Rule-book search, prompts, fact-check, verdict, JSON repair |
| `brain.js` | Lead strategist dossier, prompts, review merge, critic |
| `agent.js` | Research tools for the lead strategist (news and M&A search) |
| `fundan.js` | Funds: the full analysis: holdings joined to their industries, concentration, fundamentals and calendar through the industries, the dossier, the four analysts' and the outlook's prompts, cleaning and checks |
| `portfolio.js` | Funds: both sources' facts and holdings, what each holding is, industry matching, coverage, cross-check, benchmark, industry digests, the look-through and active weights |
| `insights.js` | Takeaways written by code from the numbers |
| `build.py` | Inlines the modules into `industry-scorer.html` |
| `runner/` | The overnight job: `run.mjs`, the viewer stand-ins (`lib/shim.js`, `lib/sampler.mjs`, `lib/mcp.mjs`), offline tests (`test/`) |
| `.github/workflows/sector-run.yml` | On-demand and nightly sector runs, continuation runs, results artifacts |
| `*_test.js` | Unit tests |
