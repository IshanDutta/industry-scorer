# Industry Scorer

Analyzes US industries (their 50 largest companies) for four investor types, with a team of Claude analysts.

- `web/` — the Industry Scorer page (published as a Claude artifact). Build: `python3 web/build.py`.
- `runner/` — the overnight job: analyzes every industry in a sector on your own API keys. **Setup and use: [runner/README.md](runner/README.md).**
- `.github/workflows/sector-run.yml` — runs the job on GitHub Actions (Actions → Sector run → Run workflow).
- `Industry_Scorer.md` — how everything works.
