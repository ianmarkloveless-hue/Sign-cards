#!/usr/bin/env python3
"""Build the Sign Cards dictionary index from signbsl.com.

Walks the public sign pages, records the word, its definitions and the video
URLs (which stay on signbsl's servers -- nothing is downloaded or re-hosted),
and writes:

    data/words.json          every headword, for searching
    data/index/<letter>.json the videos for each word
    data/crawl-state.json    where it got to, so a later run carries on

Run it from the repository root:

    python3 tools/crawl.py --minutes 300

It is deliberately slow and polite, it obeys robots.txt, and it can be stopped
and restarted at any time.
"""

import argparse
import json
import os
import re
import sys
import time
import threading
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser

import requests
from bs4 import BeautifulSoup

SITE = "https://www.signbsl.com"
HOSTS = {"www.signbsl.com", "signbsl.com"}
MEDIA_PREFIX = "https://media.signbsl.com/videos/bsl/"
UA = ("SignCardsIndexer/1.0 (personal BSL flashcard app; "
      "builds an offline word list; contact via GitHub)")

DATA = "data"
INDEX_DIR = os.path.join(DATA, "index")
STATE_FILE = os.path.join(DATA, "crawl-state.json")

LETTERS = "abcdefghijklmnopqrstuvwxyz"
ANCHOR_ID = re.compile(r"^#([A-Za-z0-9]{6,})$")
NOISE = ("Link to video", "Embed this video", "More details", "Link to this video")

lock = threading.Lock()
session = requests.Session()
session.headers.update({"User-Agent": UA, "Accept-Language": "en-GB,en"})


# ----------------------------------------------------------------- fetching

def get(url, tries=3):
    for attempt in range(tries):
        try:
            r = session.get(url, timeout=25)
            if r.status_code == 200:
                return r.text
            if r.status_code in (404, 410):
                return None
            if r.status_code in (429, 503):
                time.sleep(8 * (attempt + 1))
                continue
            return None
        except requests.RequestException:
            time.sleep(3 * (attempt + 1))
    return None


def slug_of(href, base=SITE):
    try:
        u = urlparse(urljoin(base, href))
    except ValueError:
        return None
    if u.netloc and u.netloc not in HOSTS:
        return None
    if not u.path.startswith("/sign/"):
        return None
    s = u.path[len("/sign/"):].strip("/")
    if not s or "/" in s:
        return None
    return s


# ----------------------------------------------------------------- parsing

def tidy(text):
    text = re.sub(r"\s+", " ", text or "").strip()
    for n in NOISE:
        text = text.replace(n, " ")
    return re.sub(r"\s+", " ", text).strip(" -\u2013\u2014\u00b7")


def video_meta(tag):
    """Pull the source URL, anchor id, label and contributor out of a <video>."""
    src = tag.get("src") or tag.get("data-src") or ""
    if not src:
        for s in tag.find_all("source"):
            if s.get("src"):
                src = s["src"]
                break
    if not src or ".mp4" not in src.lower():
        return None
    src = urljoin(SITE, src)

    vid = ""
    nxt = tag
    for _ in range(8):
        nxt = nxt.find_next("a", href=True)
        if nxt is None:
            break
        m = ANCHOR_ID.match(nxt["href"].strip())
        if m and m.group(1) != "modalEmbedCode":
            vid = m.group(1)
            break

    label, credit = "", ""
    em = tag.find_next("em")
    if em is not None:
        label = tidy(em.get_text(" ", strip=True))
        holder = em.parent
        if holder is not None:
            whole = tidy(holder.get_text(" ", strip=True))
            if label and whole.lower().startswith(label.lower()):
                credit = tidy(whole[len(label):])
            else:
                credit = ""

    u = src[len(MEDIA_PREFIX):] if src.startswith(MEDIA_PREFIX) else src
    return {"id": vid or u, "u": u, "label": label, "credit": credit}


def parse_sign_page(html, slug):
    soup = BeautifulSoup(html, "html.parser")
    root = soup.find("main") or soup.body or soup

    h1 = soup.find("h1")
    word = tidy(h1.get_text(" ", strip=True)) if h1 else slug.replace("-", " ")
    if not word:
        word = slug.replace("-", " ")

    senses, cur, seen = [], None, set()

    for el in root.find_all(["h1", "h2", "p", "video"]):
        if el.name in ("h1", "h2"):
            cur = {"def": "", "videos": []}
            senses.append(cur)
        elif el.name == "p":
            txt = el.get_text(" ", strip=True)
            if "How to sign" in txt and cur is not None and not cur["def"]:
                d = tidy(txt.split("How to sign:", 1)[-1])
                if '"' in d:
                    head = d.split('"', 1)[0].strip(" ;,")
                    if len(head) > 8:
                        d = head
                cur["def"] = d
        else:
            if cur is None:
                cur = {"def": "", "videos": []}
                senses.append(cur)
            try:
                meta = video_meta(el)
            except Exception:
                meta = None
            if meta and meta["u"] not in seen:
                seen.add(meta["u"])
                cur["videos"].append(meta)

    # Fallback: if the markup was not what we expected, at least keep the videos.
    if not seen:
        for u in re.findall(r"https?://media\.signbsl\.com/videos/[^\s\"'<>\\]+\.mp4", html):
            if u in seen:
                continue
            seen.add(u)
            senses.append({"def": "", "videos": [
                {"id": u, "u": u[len(MEDIA_PREFIX):] if u.startswith(MEDIA_PREFIX) else u,
                 "label": "", "credit": ""}]})

    senses = [s for s in senses if s["videos"]]
    if not senses:
        return None
    return {"word": word, "senses": senses}


def links_on(html, base):
    soup = BeautifulSoup(html, "html.parser")
    signs, dicts = set(), set()
    for a in soup.find_all("a", href=True):
        s = slug_of(a["href"], base)
        if s:
            signs.add(s)
            continue
        try:
            u = urlparse(urljoin(base, a["href"]))
        except ValueError:
            continue
        if (not u.netloc or u.netloc in HOSTS) and u.path.startswith("/dictionary/"):
            dicts.add(urljoin(SITE, u.path + (("?" + u.query) if u.query else "")))
    return signs, dicts


# ----------------------------------------------------------------- storage

def read_json(path, fallback):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return fallback


def write_json(path, obj):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def letter_of(slug):
    c = slug[:1].lower()
    return c if c in LETTERS else "0"


def load_shards():
    shards = {}
    for letter in list(LETTERS) + ["0"]:
        path = os.path.join(INDEX_DIR, letter + ".json")
        if os.path.exists(path):
            shards[letter] = read_json(path, {})
    return shards


def save_all(shards):
    os.makedirs(INDEX_DIR, exist_ok=True)
    words = []
    for letter, entries in shards.items():
        if not entries:
            continue
        write_json(os.path.join(INDEX_DIR, letter + ".json"), entries)
        for slug, rec in entries.items():
            words.append([rec.get("word") or slug.replace("-", " "), slug])
    words.sort(key=lambda p: p[0].lower())
    write_json(os.path.join(DATA, "words.json"), {
        "version": 1,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "count": len(words),
        "words": words,
    })
    return len(words)


# ----------------------------------------------------------------- seeding

def seed_from_sitemap(limit=60):
    found = set()
    roots = [SITE + "/sitemap.xml", SITE + "/sitemap_index.xml"]
    seen_maps = set()
    while roots and len(seen_maps) < limit:
        url = roots.pop(0)
        if url in seen_maps:
            continue
        seen_maps.add(url)
        xml = get(url, tries=1)
        if not xml:
            continue
        for loc in re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", xml):
            if loc.endswith(".xml"):
                roots.append(loc)
            else:
                s = slug_of(loc)
                if s:
                    found.add(s)
        time.sleep(0.5)
    return found


def seed_from_az(delay):
    signs, pages = set(), deque(SITE + "/dictionary/" + c for c in LETTERS)
    done = set()
    while pages and len(done) < 3000:
        url = pages.popleft()
        if url in done:
            continue
        done.add(url)
        html = get(url)
        time.sleep(delay)
        if not html:
            continue
        s, d = links_on(html, url)
        signs |= s
        for u in d:
            if u not in done:
                pages.append(u)
        if len(done) % 25 == 0:
            print("  A-Z pages read: %d, words found: %d" % (len(done), len(signs)), flush=True)
    return signs


# ----------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, default=300, help="stop after this long")
    ap.add_argument("--pages", type=int, default=0, help="stop after this many word pages (0 = no limit)")
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--delay", type=float, default=0.35, help="pause between requests, per worker")
    ap.add_argument("--fresh", action="store_true", help="ignore saved progress and start again")
    args = ap.parse_args()

    deadline = time.time() + args.minutes * 60

    robots = RobotFileParser()
    robots.set_url(SITE + "/robots.txt")
    try:
        robots.read()
        if not robots.can_fetch(UA, SITE + "/sign/house"):
            print("robots.txt asks crawlers to stay out of /sign/. Stopping.")
            return 1
    except Exception:
        print("Could not read robots.txt; carrying on gently.")

    shards = {} if args.fresh else load_shards()
    state = {} if args.fresh else read_json(STATE_FILE, {})
    done = set(state.get("done", []))
    queue = deque(state.get("queue", []))
    known = set(done) | set(queue)

    if not queue and not done:
        print("Finding words. This first pass takes a while.", flush=True)
        found = seed_from_sitemap()
        print("  sitemap gave %d words" % len(found), flush=True)
        if len(found) < 500:
            found |= seed_from_az(args.delay)
        queue = deque(sorted(found))
        known = set(queue)
        print("  starting with %d words" % len(queue), flush=True)

    if not queue:
        print("No words found to crawl. Check the site is reachable.")
        return 1

    counters = {"ok": 0, "empty": 0}

    def fetch_one(slug):
        html = get(SITE + "/sign/" + slug)
        time.sleep(args.delay)
        if not html:
            return slug, None, set()
        try:
            rec = parse_sign_page(html, slug)
        except Exception as exc:
            print("  parse failed for %s: %s" % (slug, exc), flush=True)
            rec = None
        try:
            more, _ = links_on(html, SITE + "/sign/" + slug)
        except Exception:
            more = set()
        return slug, rec, more

    processed = 0
    try:
        while queue and time.time() < deadline:
            if args.pages and processed >= args.pages:
                break
            batch = []
            while queue and len(batch) < 40:
                s = queue.popleft()
                if s not in done:
                    batch.append(s)
            if not batch:
                break

            with ThreadPoolExecutor(max_workers=args.workers) as pool:
                for slug, rec, more in pool.map(fetch_one, batch):
                    done.add(slug)
                    processed += 1
                    if rec:
                        counters["ok"] += 1
                        shards.setdefault(letter_of(slug), {})[slug] = rec
                    else:
                        counters["empty"] += 1
                    for m in more:
                        if m not in known:
                            known.add(m)
                            queue.append(m)

            if processed % 200 < 40:
                print("  %d done, %d with videos, %d still queued (%.0f min left)"
                      % (processed, counters["ok"], len(queue),
                         max(0, deadline - time.time()) / 60), flush=True)
                save_all(shards)
                write_json(STATE_FILE, {"done": sorted(done), "queue": list(queue)})
    except KeyboardInterrupt:
        print("Interrupted; saving what we have.")

    total = save_all(shards)
    write_json(STATE_FILE, {"done": sorted(done), "queue": list(queue)})

    print("\nThis run: %d pages read, %d had videos, %d did not."
          % (processed, counters["ok"], counters["empty"]))
    print("Dictionary now holds %d words. %d still queued." % (total, len(queue)))
    if processed and counters["ok"] == 0:
        print("\nWarning: nothing was found on any page. The site's layout may have changed.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
