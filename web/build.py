"""Inline the engine modules into the page source -> industry-scorer.html (the published file)."""
from pathlib import Path
here = Path(__file__).parent
page = (here / "page.src.html").read_text()
libs = "\n".join((here / f).read_text() for f in ["engine.js", "calls.js", "universe.js", "fund.js", "forward.js", "sensitivity.js", "positioning.js", "track.js", "history.js", "regimes.js", "plan.js", "chain.js", "score.js", "research.js", "macro.js", "insights.js", "agent.js", "team.js", "regbook.js", "world.js", "trade.js", "coverage.js", "anchor.js", "anchor-model.js", "horizon.js", "sector.js", "brain.js", "sections.js", "company.js", "cofacts.js", "daily.js", "outlook.js", "episodes.js", "apply.js", "portfolio.js", "fundmore.js", "fundan.js", "pmode.js", "etfrec.js", "etfstrat.js"])
assert page.count("/*__LIBS__*/") == 1
(here / "industry-scorer.html").write_text(page.replace("/*__LIBS__*/", libs))
print("built", here / "industry-scorer.html", round(len(page) + len(libs)) // 1024, "KB")
