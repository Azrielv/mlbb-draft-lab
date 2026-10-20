# MLBB Draft Lab

A draft-pick assistant for Mobile Legends: Bang Bang, built from pro match data scraped from Liquipedia
(MPL ID / PH / MY / KH / MENA, MSC, M-Series World Championships).

## Run it
Double-click `start.bat` (or run `python serve.py`), then open http://localhost:8000.
It has to be served over HTTP. Opening `site/index.html` directly won't load the data.

## Update the data
Double-click `update_data.bat` (or `cd scraper && python build_heroes.py && python build_matches.py`).
- Requests are rate-limited to Liquipedia's API rules (1 request per 2 s) and cached in `scraper/cache/` for 12 h.
- `python build_matches.py --all-mpl` also pulls older seasons (MPL S11-13, MSC 2023-24, M5).
- To add tournaments, edit the `TOURNAMENTS` list in `scraper/build_matches.py`.
- A new hero is picked up automatically from Liquipedia's hero portal. For better composition analysis,
  add a line for it in `site/js/kb.js`.

## Features
- **Draft board**: Tournament (MPL, 10 bans, 3-3 / 1-2-2-1 / 2-2 / 1-2-1), Ranked Mythic (10 bans) and Ranked Legend (6 bans).
  Hover to preview, click to lock, Ctrl+Z to undo. Includes an optional AI opponent.
  The URL updates as you draft, so you can share a link to the board.
- **Suggestions** for every pick and ban, with reasons: pro priority and win rate, lane fit, synergy with your picks
  (pro win rate together plus known combos), counters to enemy picks, damage/frontline/CC needs,
  your team's comfort picks and denying the enemy's.
- **Enemy outlook**: what the other side is most likely to pick or ban next (tailored to the selected team).
- **Composition panels**: damage split, CC, frontline, burst, mobility, power curve, open lanes, good/bad matchups.
- **Meta** tier table, **Team scouting** (picks, bans, bans received, hero pool by lane, recent drafts),
  **Hero lookup** (best teammates, best/worst matchups, teams that play it), and a **Matches** browser
  ("Open in draft" loads any pro game onto the board).

## Notes and limits
- Stats are recency-weighted (120-day half-life) and smoothed, so small samples don't dominate.
  Filter by region and time window in the top bar (shift-click a region to show only that region).
- Liquipedia records each team's picks in lane order (EXP, Jungle, Mid, Gold, Roam), not pick order.
  That gives accurate lane data, but "Open in draft" can't replay the real pick order.
- Ranked (non-pro) data isn't included. Moonton's official stats API needs signed requests,
  and the community proxy was offline when this was built.
- The win estimate is a rough indicator from pro win rates. It isn't a prediction.
