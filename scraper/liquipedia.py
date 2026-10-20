"""Small, polite Liquipedia MediaWiki API client with on-disk caching.

Liquipedia's API terms: identify yourself with a User-Agent, use gzip,
max 1 request / 2 s (action=parse: 1 / 30 s). We only use action=query.
"""
import gzip
import hashlib
import json
import os
import time
import urllib.parse
import urllib.request

API = "https://liquipedia.net/mobilelegends/api.php"
UA = "MLBBDraftTool/1.0 (personal draft analysis tool)"
CACHE_DIR = os.path.join(os.path.dirname(__file__), "cache")
MIN_INTERVAL = 2.1

_last_call = 0.0


def _get(url, binary=False, post=None):
    global _last_call
    wait = MIN_INTERVAL - (time.time() - _last_call)
    if wait > 0:
        time.sleep(wait)
    body = urllib.parse.urlencode(post).encode() if post else None
    req = urllib.request.Request(url, data=body, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    data = gzip.decompress(data)
            _last_call = time.time()
            return data if binary else data.decode("utf-8")
        except Exception as e:  # noqa: BLE001
            _last_call = time.time()
            if getattr(e, "code", None) in (403, 404):
                raise RuntimeError(f"{e} for {url}") from e
            print(f"  ! request failed ({e}), retry {attempt + 1}")
            time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"giving up on {url}")


def query(params, max_age_hours=12):
    """Run an action=query call, cached on disk for max_age_hours."""
    params = {"action": "query", "format": "json", "formatversion": "2", **params}
    url = API + "?" + urllib.parse.urlencode(params)
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, hashlib.sha1(url.encode()).hexdigest() + ".json")
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < max_age_hours * 3600:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    data = json.loads(_get(url))
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)
    return data


def wikitext(titles, max_age_hours=12):
    """Return {title: wikitext} for up to 50 titles per request (redirects followed)."""
    out = {}
    for i in range(0, len(titles), 50):
        chunk = titles[i:i + 50]
        data = query({"prop": "revisions", "rvprop": "content", "rvslots": "main",
                      "redirects": "1", "titles": "|".join(chunk)}, max_age_hours)
        for p in data.get("query", {}).get("pages", []):
            if "revisions" in p:
                out[p["title"]] = p["revisions"][0]["slots"]["main"]["content"]
    return out


def all_pages(prefix, max_age_hours=12):
    """All page titles in the main namespace starting with prefix."""
    titles, cont = [], {}
    while True:
        data = query({"list": "allpages", "apprefix": prefix, "aplimit": "500", **cont}, max_age_hours)
        titles += [p["title"] for p in data["query"]["allpages"]]
        if "continue" not in data:
            return titles
        cont = {"apcontinue": data["continue"]["apcontinue"]}


def download(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return False
    data = _get(url, binary=True)
    with open(dest, "wb") as f:
        f.write(data)
    return True
