#!/usr/bin/env python3
"""Export the crawled library to the static website in site/ (for IPFS/Pinata).

Usage:  python3 build_site.py        # regenerates site/library.json from data/library.db

Everything else in site/ (index.html, app.js, style.css) is static. To publish,
upload the whole site/ folder to Pinata (or `ipfs add -r site`) and open the CID
through any IPFS gateway. Watch history is stored in each visitor's browser.
"""
from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import time

from topics import FIELD_OF, FIELDS

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "data", "library.db")
OUT = os.path.join(HERE, "site", "library.json")

# must match app.py
VIEW_REF = {"youtube": 5_000_000, "archive": 100_000}


def view_score(views, source) -> float:
    if not views:
        return 0.0
    ref = VIEW_REF.get(source, 1_000_000)
    return max(0.0, min(100.0, 100.0 * math.log10(views + 1) / math.log10(ref + 1)))


def main():
    with open(os.path.join(HERE, "institutions.json"), encoding="utf-8") as f:
        cfg = json.load(f)
    compiled = [(i["name"], [re.compile(p, re.I) for p in i["patterns"]], i["score"]) for i in cfg["institutions"]]
    unknown = cfg.get("unknown_score", 25)

    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    # reputation overrides made in the app's Institutions tab apply to the export too
    try:
        overrides = {r["name"]: r["score"] for r in con.execute("SELECT * FROM inst_override")}
    except sqlite3.OperationalError:
        overrides = {}
    scores = {name: overrides.get(name, score) for name, _, score in compiled}

    videos, inst_count, cache = [], {}, {}
    for r in con.execute("SELECT * FROM videos"):
        ch = r["channel"] or ""
        if ch not in cache:
            cache[ch] = next((n for n, pats, _ in compiled if any(p.search(ch) for p in pats)), None)
        inst = cache[ch]
        if inst:
            inst_count[inst] = inst_count.get(inst, 0) + 1
        videos.append({
            "id": r["id"], "source": r["source"], "sid": r["source_id"],
            "title": r["title"], "channel": ch, "url": r["url"], "embed": r["embed_url"],
            "thumb": r["thumbnail"], "duration": r["duration"], "views": r["views"],
            "desc": (r["description"] or "")[:280],
            "topics": [t for t in (r["topics"] or "").split(",") if t],
            "inst": inst, "rep": scores[inst] if inst else unknown,
            "vs": round(view_score(r["views"], r["source"]), 1),
            "emb": r["embeddable"], "da": r["discovered_at"],
        })
    con.close()

    topics_seen = {t for v in videos for t in v["topics"]}
    field_counts: dict[str, int] = {}
    for v in videos:
        for fl in {FIELD_OF.get(t) for t in v["topics"]} - {None}:
            field_counts[fl] = field_counts.get(fl, 0) + 1
    out = {
        "generated": time.strftime("%Y-%m-%d"),
        "institutions": sorted(inst_count.items(), key=lambda x: (-scores.get(x[0], 0), x[0])),
        "topic_fields": {t: FIELD_OF.get(t) for t in topics_seen},
        "fields": [[k, label, field_counts.get(k, 0)] for k, label in FIELDS.items()],
        "videos": videos,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
    print(f"site/library.json: {len(videos)} videos, {os.path.getsize(OUT) // 1024} KB")


if __name__ == "__main__":
    main()
