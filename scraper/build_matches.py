"""Scrape every game (picks, bans, sides, winner) from Liquipedia tournament pages
into site/data/matches.json.

Usage:  python build_matches.py            # default tournament list below
        python build_matches.py --all-mpl  # every MPL season since 2023 (slower)
"""
import json
import os
import re
import sys
import urllib.parse
from collections import Counter
from datetime import datetime

import liquipedia as lp

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "site", "data")
LOGOS = os.path.join(ROOT, "site", "assets", "teams")

# (tournament root page, region label). Every subpage (Regular Season, Playoffs, ...) is scanned.
TOURNAMENTS = [
    *[(f"MPL/Indonesia/Season {s}", "MPL ID") for s in range(14, 19)],
    *[(f"MPL/Philippines/Season {s}", "MPL PH") for s in range(14, 19)],
    *[(f"MPL/Malaysia/Season {s}", "MPL MY") for s in range(14, 19)],
    *[(f"MPL/Cambodia/Season {s}", "MPL KH") for s in range(8, 13)],
    *[(f"MPL/MENA/Season {s}", "MPL MENA") for s in range(7, 12)],
    ("MSC/2025", "MSC"), ("MSC/2026", "MSC"),
    ("M6 World Championship", "M-Series"), ("M7 World Championship", "M-Series"),
    ("M8 World Championship", "M-Series"),
]
ALL_MPL_EXTRA = [
    *[(f"MPL/Indonesia/Season {s}", "MPL ID") for s in range(11, 14)],
    *[(f"MPL/Philippines/Season {s}", "MPL PH") for s in range(11, 14)],
    *[(f"MPL/Malaysia/Season {s}", "MPL MY") for s in range(11, 14)],
    ("MSC/2023", "MSC"), ("MSC/2024", "MSC"), ("M5 World Championship", "M-Series"),
]
LANES = ["exp", "jungle", "mid", "gold", "roam"]  # Liquipedia convention for h1..h5


def blocks(text, opener):
    """Yield balanced {{...}} blocks whose text starts with opener (e.g. '{{Match')."""
    for m in re.finditer(re.escape(opener) + r"(?=[\s|])", text):
        depth, i = 0, m.start()
        while i < len(text) - 1:
            two = text[i:i + 2]
            if two == "{{":
                depth += 1
                i += 2
            elif two == "}}":
                depth -= 1
                i += 2
                if depth == 0:
                    yield text[m.start():i]
                    break
            else:
                i += 1


def params(block):
    """Top-level |key=value params of a template block."""
    inner = block[2:-2]
    out, depth, cur = {}, 0, ""
    parts = []
    i = 0
    while i < len(inner):
        two = inner[i:i + 2]
        if two in ("{{", "[["):
            depth += 1
            cur += two
            i += 2
            continue
        if two in ("}}", "]]"):
            depth -= 1
            cur += two
            i += 2
            continue
        if inner[i] == "|" and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += inner[i]
        i += 1
    parts.append(cur)
    for p in parts[1:]:
        if "=" in p:
            k, v = p.split("=", 1)
            out[k.strip()] = re.sub(r"<!--.*?-->", "", v, flags=re.S).strip()
    return out


def team_name(opp):
    m = re.search(r"\{\{\s*TeamOpponent\s*\|\s*([^|}]+)", opp or "", re.I)
    if m:
        return m.group(1).strip()
    m = re.search(r"template\s*=\s*([^|}]+)", opp or "")
    return m.group(1).strip() if m else None


def parse_date(s):
    s = re.sub(r"\{\{.*?\}\}", "", s or "")
    m = re.search(r"(\d{4}-\d{2}-\d{2})", s)
    if m:
        return m.group(1)
    m = re.search(r"([A-Za-z]+)\.?\s+(\d{1,2})\s*,\s*(\d{4})", s)
    if m:
        for fmt in ("%B %d %Y", "%b %d %Y"):
            try:
                return datetime.strptime(" ".join(m.groups()), fmt).strftime("%Y-%m-%d")
            except ValueError:
                pass
    m = re.search(r"(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})", s)  # "17th October 2024"
    if m:
        for fmt in ("%B %d %Y", "%b %d %Y"):
            try:
                return datetime.strptime(f"{m.group(2)} {m.group(1)} {m.group(3)}", fmt).strftime("%Y-%m-%d")
            except ValueError:
                pass
    return None


def resolve_teams(names):
    """Map raw team-template names to {name, logo} by expanding {{Team|...}} (one request per 150 names)."""
    out = {}
    names = sorted(set(names))
    for i in range(0, len(names), 150):
        chunk = names[i:i + 150]
        text = "\n".join(f"@@{n}@@{{{{Team|{n}}}}}" for n in chunk)
        res = json.loads(lp._get(lp.API, post={"action": "expandtemplates", "text": text,
                                                "prop": "wikitext", "format": "json"}))["expandtemplates"]["wikitext"]
        for line in res.split("\n"):
            m = re.match(r"@@(.*?)@@(.*)", line)
            if not m:
                continue
            raw, body = m.groups()
            disp = re.search(r'data-highlighting-class="([^"]+)"', body)
            logo = re.search(r"\[\[File:([^|\]]+)", body)
            out[raw] = {"name": disp.group(1) if disp else raw,
                        "logo": logo.group(1).strip() if logo else None}
    return out


def main():
    tournaments = TOURNAMENTS + (ALL_MPL_EXTRA if "--all-mpl" in sys.argv else [])
    with open(os.path.join(DATA, "heroes.json"), encoding="utf-8") as f:
        aliases = json.load(f)["aliases"]
    unknown = Counter()

    def hero(v):
        v = (v or "").strip().lower()
        if not v:
            return None
        h = aliases.get(v) or aliases.get(re.sub(r"[^a-z0-9]", "", v))
        if not h:
            unknown[v] += 1
        return h

    games, seen = [], set()
    team_names = Counter()
    for root, region in tournaments:
        pages = [root] + [t for t in lp.all_pages(root + "/") if "/Statistics" not in t]
        print(f"{root}: {len(pages)} pages")
        texts = lp.wikitext(pages)
        for title, text in texts.items():
            last_date = None
            for mb in blocks(text, "{{Match"):
                if mb.startswith("{{Matchlist") or mb.startswith("{{MatchSection"):
                    continue
                mp = params(mb)
                t1, t2 = team_name(mp.get("opponent1")), team_name(mp.get("opponent2"))
                if not t1 or not t2:
                    continue
                team_names[t1] += 1
                team_names[t2] += 1
                date = parse_date(mp.get("date")) or last_date
                last_date = date
                for n in range(1, 10):
                    mapb = mp.get(f"map{n}")
                    if not mapb or not mapb.startswith("{{Map"):
                        continue
                    g = params(mapb)
                    if g.get("finished") == "skip" or g.get("winner") not in ("1", "2"):
                        continue
                    picks = [[hero(g.get(f"t{t}h{i}")) for i in range(1, 6)] for t in (1, 2)]
                    bans = [[hero(g.get(f"t{t}b{i}")) for i in range(1, 6)] for t in (1, 2)]
                    if any(None in p for p in picks):
                        continue
                    key = (date, tuple(sorted([t1.lower(), t2.lower()])), tuple(sorted(picks[0] + picks[1])))
                    if key in seen:
                        continue
                    seen.add(key)
                    side1 = (g.get("team1side") or "").lower()
                    games.append({
                        "date": date, "event": title.split("/")[0] if region == "M-Series" else root,
                        "region": region, "stage": title,
                        "teams": [t1, t2],
                        "sides": [side1 or None, {"blue": "red", "red": "blue"}.get(side1)],
                        "picks": picks,  # index = lane slot: exp, jungle, mid, gold, roam
                        "bans": [[b for b in bl if b] for bl in bans],
                        "winner": int(g["winner"]) - 1,
                        "length": g.get("length") or None,
                    })

    # template aliases (btr, ae, "Aurora PH") -> canonical team names + logos
    resolved = resolve_teams([t.lower() for t in team_names])
    teams = {}
    for g in games:
        g["teams"] = [resolved.get(t.lower(), {"name": t})["name"] for t in g["teams"]]
    for raw, info in resolved.items():
        t = teams.setdefault(info["name"], {"name": info["name"], "logo": None})
        if info.get("logo") and not t["logo"]:
            t["logo"] = info["logo"]
    print(f"resolved {len(resolved)} team aliases -> {len(teams)} teams; fetching logos...")
    os.makedirs(LOGOS, exist_ok=True)
    used = {n for g in games for n in g["teams"]}
    with_logo = [t for t in teams.values() if t["logo"] and t["name"] in used]
    thumbs = {}
    for i in range(0, len(with_logo), 50):
        files = ["File:" + t["logo"] for t in with_logo[i:i + 50]]
        url = "https://liquipedia.net/commons/api.php?" + urllib.parse.urlencode(
            {"action": "query", "prop": "imageinfo", "iiprop": "url", "iiurlwidth": "120",
             "titles": "|".join(files), "format": "json", "formatversion": "2"})
        data = json.loads(lp._get(url))
        norm = {n["to"]: n["from"] for n in data["query"].get("normalized", [])}
        for p in data["query"]["pages"]:
            if p.get("imageinfo"):
                thumbs[norm.get(p["title"], p["title"])[5:]] = p["imageinfo"][0].get("thumburl") or p["imageinfo"][0]["url"]
    for t in teams.values():
        src = thumbs.get(t["logo"]) if t["logo"] else None
        t["logo"] = None
        if not src:
            continue
        fn = re.sub(r"[^A-Za-z0-9]+", "_", t["name"]).strip("_") + ".png"
        try:
            lp.download(src, os.path.join(LOGOS, fn))
            t["logo"] = "assets/teams/" + fn
        except RuntimeError:
            pass
    with open(os.path.join(DATA, "teams.json"), "w", encoding="utf-8") as f:
        json.dump(sorted((t for t in teams.values() if t["name"] in used), key=lambda t: t["name"]), f, indent=1)

    games.sort(key=lambda g: g["date"] or "")
    with open(os.path.join(DATA, "matches.json"), "w", encoding="utf-8") as f:
        json.dump({"updated": datetime.now().strftime("%Y-%m-%d %H:%M"), "lanes": LANES, "games": games},
                  f, separators=(",", ":"))
    print(f"wrote {len(games)} games")
    if unknown:
        print("unknown hero aliases:", unknown.most_common(20))


if __name__ == "__main__":
    main()
