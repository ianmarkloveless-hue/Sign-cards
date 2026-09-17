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
