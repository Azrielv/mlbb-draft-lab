"""Build site/data/heroes.json and download hero icons from Liquipedia."""
import html
import json
import os
import re
import urllib.parse

import liquipedia as lp

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "site", "data")
ICONS = os.path.join(ROOT, "site", "assets", "heroes")
LANE_KEYS = {"EXP Lane": "exp", "Jungle": "jungle", "Mid Lane": "mid", "Gold Lane": "gold", "Roam": "roam"}


def slug(name):
    return re.sub(r"[^a-z0-9]", "", name.lower())


def parse_portal():
    url = lp.API + "?" + urllib.parse.urlencode(
        {"action": "parse", "page": "Portal:Heroes", "prop": "text", "format": "json"})
    path = os.path.join(lp.CACHE_DIR, "portal_heroes.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            text = json.load(f)
    else:
        text = json.loads(lp._get(url))["parse"]["text"]["*"]
        os.makedirs(lp.CACHE_DIR, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(text, f)
    return text


def sections(page_html, content_cls):
    s = page_html.find(f'class="{content_cls}"')
    e = page_html.find('class="content', s + 20)
    seg = page_html[s:e if e > 0 else None]
    parts = re.split(r'font-size:18px">([^<]+)</div>', seg)
    for i in range(1, len(parts), 2):
        title = re.sub(r"\s*\(\d+\)$", "", parts[i]).strip()
        names = [html.unescape(n) for n in re.findall(
            r'<a href="/mobilelegends/[^"]+" title="([^"]+)"><img', parts[i + 1])]
        yield title, names


def main():
    os.makedirs(DATA, exist_ok=True)
    os.makedirs(ICONS, exist_ok=True)
    page = parse_portal()

    heroes = {}
    s = page.find('class="content1"')
    e = page.find('class="content2"')
    for m in re.finditer(r'<a href="/mobilelegends/[^"]+" title="([^"]+)"><img alt="[^"]*" src="([^"]+)"[^>]*?'
                         r'srcset="([^"]+)"', page[s:e]):
        name = html.unescape(m.group(1))
        full = m.group(3).split(",")[-1].strip().split(" ")[0]
        heroes[slug(name)] = {"id": slug(name), "name": name, "lanes": [], "icon_url": "https://liquipedia.net" + full}

    for title, names in sections(page, "content2"):
        for n in names:
            if slug(n) in heroes and title in LANE_KEYS:
                heroes[slug(n)]["lanes"].append(LANE_KEYS[title])

    # alias table used by match wikitext (t1h1=yss etc.)
    mod = lp.wikitext(["Module:HeroNames"], max_age_hours=24 * 7)["Module:HeroNames"]
    aliases = {}
    for a, n in re.findall(r"\[\s*'((?:[^'\\]|\\.)*)'\s*\]\s*=\s*'((?:[^'\\]|\\.)*)'", mod):
        aliases[a.replace("\\'", "'").lower()] = slug(n.replace("\\'", "'"))
    for h in heroes.values():
        aliases.setdefault(h["name"].lower(), h["id"])
        aliases.setdefault(h["id"], h["id"])

    print(f"{len(heroes)} heroes, {len(aliases)} aliases; downloading icons...")
    for h in heroes.values():
        if lp.download(h["icon_url"], os.path.join(ICONS, h["id"] + ".png")):
            print("  icon", h["name"])
        h["icon"] = f"assets/heroes/{h['id']}.png"

    with open(os.path.join(DATA, "heroes.json"), "w", encoding="utf-8") as f:
        json.dump({"heroes": sorted(heroes.values(), key=lambda h: h["name"]), "aliases": aliases}, f, indent=1)
    print("wrote heroes.json")


if __name__ == "__main__":
    main()
