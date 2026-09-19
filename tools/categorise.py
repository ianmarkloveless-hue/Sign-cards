#!/usr/bin/env python3
"""Give every word in the dictionary one or more categories.

Writes data/categories.json, which the app reads to offer category filters and
the Explore screen. Two sets of categories are produced:

  Everyday topics     the curated lists in data/topic-lists.json (see topics.py)
  Every word by type  derived from WordNet, so that no word is ever unreachable

signbsl's definitions come from WordNet, so most words can be matched back to
the exact sense they were defined from, and that sense's WordNet lexicographer
file becomes the category. A word with two senses gets two categories.

Needs the WordNet corpus, which is not shipped to the app -- this runs offline
and only its output is committed:

    pip install nltk
    python3 -c "import nltk; nltk.download('wordnet')"
    python3 tools/categorise.py

Run it from the repository root.
"""

import json
import os
import re
import sys
import time
from collections import Counter, defaultdict

try:
    from nltk.corpus import wordnet as wn
    wn.synsets("test")
except Exception as exc:  # noqa: BLE001 - any nltk/corpus problem is the same story
    sys.stderr.write(
        "Could not load WordNet (%s).\n"
        "Install it with:\n"
        "    pip install nltk\n"
        "    python3 -c \"import nltk; nltk.download('wordnet')\"\n" % exc)
    sys.exit(1)

DATA = "data"
INDEX_DIR = os.path.join(DATA, "index")
TOPICS_FILE = os.path.join(DATA, "topic-lists.json")
OUT = os.path.join(DATA, "categories.json")

# WordNet groups every sense into one of 45 lexicographer files. These are far
# more granular than a learner wants, so several map onto one plain-English name.
MAP = {
    "noun.person": "People & Family",
    "noun.animal": "Animals",
    "noun.plant": "Plants & Nature",
    "noun.object": "Plants & Nature",
    "noun.substance": "Plants & Nature",
    "noun.food": "Food & Drink",
    "verb.consumption": "Food & Drink",
    "noun.body": "Body, Health & Senses",
    "verb.body": "Body, Health & Senses",
    "verb.perception": "Body, Health & Senses",
    "noun.location": "Places & Countries",
    "noun.artifact": "Objects & Things",
    "noun.shape": "Objects & Things",
    "noun.phenomenon": "Weather & Nature Events",
    "verb.weather": "Weather & Nature Events",
    "noun.communication": "Talking & Language",
    "verb.communication": "Talking & Language",
    "noun.cognition": "Thinking & Knowing",
    "verb.cognition": "Thinking & Knowing",
    "noun.feeling": "Feelings",
    "verb.emotion": "Feelings",
    "noun.motive": "Feelings",
    "noun.act": "Actions & Doing",
    "verb.contact": "Actions & Doing",
    "verb.motion": "Actions & Doing",
    "verb.change": "Actions & Doing",
    "verb.creation": "Actions & Doing",
    "verb.competition": "Actions & Doing",
    "verb.social": "Social & Everyday Life",
    "noun.event": "Social & Everyday Life",
    "noun.process": "Social & Everyday Life",
    "adj.all": "Describing Words",
    "adj.pert": "Describing Words",
    "adj.ppl": "Describing Words",
    "noun.attribute": "Describing Words",
    "adv.all": "How, When & Where",
    "noun.relation": "How, When & Where",
    "noun.time": "Time & Dates",
    "noun.quantity": "Amounts & Numbers",
    "noun.group": "Groups & Organisations",
    "noun.possession": "Money & Owning",
    "verb.possession": "Money & Owning",
    "noun.state": "States & Being",
    "verb.stative": "States & Being",
    "noun.Tops": "States & Being",
}

FUNCTION = set("""a an the and or but if because although though while when where
who whom whose which that this these those there here then than as so such
of to in on at by for with from into onto up down out off over under again
about above across after against along among around before behind below
beneath beside between beyond during except inside near outside since
through throughout till until upon within without not no nor yes yeah ok okay
is am are was were be been being do does did done have has had having
will would shall should can could may might must
i me my mine you your yours he him his she her hers it its we us our ours
they them their theirs myself yourself himself herself itself ourselves
themselves what how why whether either neither both each every any some
anybody anyone anything someone somebody something everyone everybody
everything nobody none nothing somewhere anywhere everywhere nowhere
""".split())

FINGER = re.compile(r"^(?:[A-Za-z]-){1,}[A-Za-z]$")
NUMBER = re.compile(r"^(a |one |two |three )?(billion|million|thousand|hundred"
                    r"|dozen|half|quarter|zero|one|two|three|four|five|six|seven"
                    r"|eight|nine|ten)\b", re.I)

TYPE_ORDER = [
    "People & Family", "Animals", "Food & Drink", "Body, Health & Senses",
    "Places & Countries", "Objects & Things", "Plants & Nature",
    "Weather & Nature Events", "Talking & Language", "Thinking & Knowing",
    "Feelings", "Actions & Doing", "Social & Everyday Life", "Describing Words",
    "How, When & Where", "Time & Dates", "Amounts & Numbers",
    "Groups & Organisations", "Money & Owning", "States & Being",
    "Names & Proper Nouns", "Fingerspelling", "Grammar Words", "Other",
]


def norm(text):
    text = re.sub(r"\s+", " ", (text or "").lower()).strip()
    return re.sub(r"[^a-z0-9 ]", "", text)


def slugify(name):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", name.lower())).strip("-")


def read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def categories_for(word, senses, stats):
    """Return the set of type-categories for one dictionary entry."""
    syns = wn.synsets(word.replace(" ", "_"))
    gloss_index = {norm(s.definition()): s for s in syns}

    lexnames = set()
    for sense in senses:
        d = sense.get("def")
        if d and norm(d) in gloss_index:
            lexnames.add(gloss_index[norm(d)].lexname())
    if lexnames:
        stats["gloss (exact sense)"] += 1
    elif syns:
        for s in syns[:3]:
            lexnames.add(s.lexname())
        stats["wordnet senses"] += 1
    else:
        base = re.sub(r"\([^)]*\)", "", word).strip()
        alt = wn.synsets(base.replace(" ", "_")) if base and base.lower() != word.lower() else []
        if alt:
            lexnames.add(alt[0].lexname())
            stats["parenthetical"] += 1
        else:
            for tok in reversed([t for t in re.split(r"[\s\-]+", word.lower())
                                 if t and t not in FUNCTION]):
                ss = wn.synsets(tok)
                if ss:
                    lexnames.add(ss[0].lexname())
                    stats["head word"] += 1
                    break

    cats = {MAP[l] for l in lexnames if l in MAP}
    if cats:
        return cats

    w = word.strip()
    if FINGER.match(w):
        stats["rule: fingerspelling"] += 1
        return {"Fingerspelling"}
    if NUMBER.match(w):
        stats["rule: number"] += 1
        return {"Amounts & Numbers"}
    if w.lower() in FUNCTION:
        stats["rule: grammar word"] += 1
        return {"Grammar Words"}
    if w[:1].isupper():
        stats["rule: proper noun"] += 1
        return {"Names & Proper Nouns"}
    stats["no match"] += 1
    return {"Other"}


def main():
    words = read_json(os.path.join(DATA, "words.json"))["words"]
    position = {slug: i for i, (_, slug) in enumerate(words)}

    entries = {}
    for letter in sorted(os.listdir(INDEX_DIR)):
        if letter.endswith(".json"):
            entries.update(read_json(os.path.join(INDEX_DIR, letter)))

    stats = Counter()
    by_type = defaultdict(set)
    multi = 0
    for slug, entry in entries.items():
        if slug not in position:
            continue
        cats = categories_for(entry["word"], entry.get("senses", []), stats)
        if len(cats) > 1:
            multi += 1
        for c in cats:
            by_type[c].add(position[slug])

    out = {
        "version": 1,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "groups": [
            {"id": "topics", "name": "Everyday topics"},
            {"id": "types", "name": "Every word by type"},
        ],
        "categories": [],
    }

    topics = read_json(TOPICS_FILE)["topics"] if os.path.exists(TOPICS_FILE) else []
    if not topics:
        print("No %s found -- run tools/topics.py first for the everyday topics."
              % TOPICS_FILE)
    for t in topics:
        idx = sorted(position[s] for s in t["words"] if s in position)
        if idx:
            out["categories"].append({"id": "t-" + t["id"], "name": t["name"],
                                      "group": "topics", "idx": idx})

    for name in TYPE_ORDER:
        if by_type.get(name):
            out["categories"].append({"id": "y-" + slugify(name), "name": name,
                                      "group": "types", "idx": sorted(by_type[name])})

    write_json(OUT, out)

    total = len(entries)
    print("=" * 58)
    print("%d dictionary words" % total)
    print("=" * 58)
    print("\nHow each word was categorised")
    for k, v in stats.most_common():
        print("  %-22s %6d  (%.1f%%)" % (k, v, 100.0 * v / total))
    print("\n  in more than one category: %d (%.1f%%)" % (multi, 100.0 * multi / total))

    print("\nEveryday topics")
    for c in out["categories"]:
        if c["group"] == "topics":
            print("  %-26s %5d" % (c["name"], len(c["idx"])))
    print("\nEvery word by type")
    for c in out["categories"]:
        if c["group"] == "types":
            print("  %-26s %5d" % (c["name"], len(c["idx"])))

    covered = len({i for c in out["categories"] if c["group"] == "types" for i in c["idx"]})
    print("\n  categories: %d" % len(out["categories"]))
    print("  words with a type category: %d of %d (%.1f%%)"
          % (covered, total, 100.0 * covered / total))
    print("  wrote %s (%.0f KB)" % (OUT, os.path.getsize(OUT) / 1024.0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
