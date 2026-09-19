#!/usr/bin/env python3
"""Collect the topic word lists from signbsl.com and fill in any missing words.

Reads the category pages (/categories/...) and the three syllabus pages, writes
the slug lists to data/topic-lists.json, then fetches any sign page named by
those lists that the main crawl never reached, so every topic is complete.

Run it from the repository root:

    python3 tools/topics.py

It reuses the fetching and parsing in crawl.py, so it is equally slow and
polite. Fewer than about three hundred pages, so it finishes in minutes.
"""

import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import crawl

SITE = crawl.SITE
DATA = "data"
OUT = os.path.join(DATA, "topic-lists.json")

SYLLABUS = [
    ("gcse", "GCSE Vocabulary", "/gcse-vocabulary"),
    ("signature-1", "Signature Level 1", "/signature-level-1-vocabulary"),
    ("signature-2", "Signature Level 2", "/signature-level-2-vocabulary"),
]

# Categories signbsl publishes but which read better merged or renamed here.
RENAME = {
    "people": "Family & People",
    "astronomy": "Astronomy & Space",
    "school": "School & Education",
    "jobs": "Jobs & Professions",
    "weather": "Weather & Seasons",
    "transport": "Transport & Travel",
    "countries": "Countries & Places",
    "emotions": "Emotions & Feelings",
}
MERGE = {"drinks": "food"}          # drinks folded into Food & Drink
MERGED_NAME = {"food": "Food & Drink"}

# Everyday words signbsl does not group anywhere. Edit these lists to taste and
# re-run; anything not in the dictionary is dropped with a note.
GREETINGS = """hello hi goodbye bye good-morning good-afternoon good-evening
good-night please thank-you thanks sorry excuse-me welcome fine well
nice-to-meet-you see-you-later see-you yes no ok pardon congratulations
happy-birthday good-luck take-care name nice pleased polite introduce
how-are-you morning afternoon evening night""".split()

VERBS = """go come want need like know have get make do say tell ask give take
see look watch hear listen eat drink sleep wake work play learn teach read
write help find lose buy sell pay live stay leave arrive start stop finish
open close sit stand walk run think feel remember forget understand speak
talk meet wait try use put bring send show move carry hold keep let""".split()

HAND = [("greetings", "Greetings & Politeness", GREETINGS),
        ("everyday-verbs", "Everyday Verbs", VERBS)]


def slugs_on(path):
    html = crawl.get(SITE + path)
    time.sleep(0.4)
    if not html:
        print("  could not read %s" % path, flush=True)
        return []
    found = []
    for href in re.findall(r'href="(/sign/[^"]+)"', html):
        s = crawl.slug_of(href)
        if s and s not in found:
            found.append(s)
    return found


def category_ids():
    html = crawl.get(SITE + "/categories")
    time.sleep(0.4)
    if not html:
        return []
    ids = []
    for href in re.findall(r'href="/categories/([^"/]+)"', html):
        if href not in ids:
            ids.append(href)
    return ids


def main():
    print("Reading the category index...", flush=True)
    ids = category_ids()
    if not ids:
        print("No categories found -- the page layout may have changed.")
        return 1
    print("  %d categories: %s" % (len(ids), ", ".join(ids)), flush=True)

    topics = {}

    for cid in ids:
        target = MERGE.get(cid, cid)
        words = slugs_on("/categories/" + cid)
        name = MERGED_NAME.get(target) or RENAME.get(target) or target.title()
        entry = topics.setdefault(target, {"name": name, "words": []})
        for s in words:
            if s not in entry["words"]:
                entry["words"].append(s)
        print("  %-14s %4d" % (cid, len(words)), flush=True)

    for sid, name, path in SYLLABUS:
        words = slugs_on(path)
        topics[sid] = {"name": name, "words": words}
        print("  %-14s %4d" % (sid, len(words)), flush=True)

    for hid, name, words in HAND:
        topics[hid] = {"name": name, "words": list(words)}
        print("  %-14s %4d  (hand-written)" % (hid, len(words)), flush=True)

    # Which of these words do we not hold yet?
    shards = crawl.load_shards()
    have = set()
    for entries in shards.values():
        have |= set(entries)
    wanted = set()
    for t in topics.values():
        wanted |= set(t["words"])
    missing = sorted(wanted - have)
    print("\n%d words named by topics, %d already in the dictionary, %d missing."
          % (len(wanted), len(wanted & have), len(missing)), flush=True)

    if missing:
        print("Fetching the missing ones...", flush=True)
        added = 0
        for i, slug in enumerate(missing, 1):
            html = crawl.get(SITE + "/sign/" + slug)
            time.sleep(0.35)
            if not html:
                continue
            try:
                rec = crawl.parse_sign_page(html, slug)
            except Exception as exc:
                print("  parse failed for %s: %s" % (slug, exc), flush=True)
                continue
            if rec:
                shards.setdefault(crawl.letter_of(slug), {})[slug] = rec
                added += 1
            if i % 50 == 0:
                print("  %d/%d, %d with videos" % (i, len(missing), added), flush=True)
        total = crawl.save_all(shards)
        print("  added %d words; dictionary now holds %d." % (added, total), flush=True)
        have |= {s for letter in shards.values() for s in letter}

    # Drop anything still absent, so the lists only name words we can show.
    out = {"version": 1,
           "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "topics": []}
    for tid, t in topics.items():
        kept = [s for s in t["words"] if s in have]
        dropped = len(t["words"]) - len(kept)
        out["topics"].append({"id": tid, "name": t["name"], "words": sorted(kept)})
        print("  %-14s %4d kept%s" % (tid, len(kept),
                                      (", %d not in dictionary" % dropped) if dropped else ""))
    out["topics"].sort(key=lambda t: t["name"])

    crawl.write_json(OUT, out)
    print("\nWrote %s with %d topics." % (OUT, len(out["topics"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
