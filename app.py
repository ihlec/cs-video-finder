#!/usr/bin/env python3
"""CS Lecture Finder - a local web UI for free computer-science lecture videos.

Run:  python3 app.py            (then open http://localhost:8765)
      python3 app.py --port 9000 --no-browser
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sqlite3
import sys
import threading
import time
import traceback
import webbrowser
from contextlib import contextmanager
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import discovery  # noqa: E402

DATA_DIR = os.environ.get("CSVF_DATA", os.path.join(HERE, "data"))
DB_PATH = os.path.join(DATA_DIR, "library.db")
STATIC = os.path.join(HERE, "static")
INST_FILE = os.path.join(HERE, "institutions.json")

# views at which the "popularity" half of the score saturates at 100
VIEW_REF = {"youtube": 5_000_000, "archive": 100_000}
DEFAULT_WEIGHT = 0.6  # share of the score that comes from the institution's reputation

SCHEMA = """
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY, source TEXT, source_id TEXT, title TEXT, channel TEXT,
  channel_id TEXT, url TEXT, embed_url TEXT, thumbnail TEXT, duration INTEGER,
  views INTEGER, published TEXT, description TEXT, topics TEXT,
  embeddable INTEGER DEFAULT 1, lectureish INTEGER DEFAULT 0,
  discovered_at REAL, query TEXT
);
CREATE TABLE IF NOT EXISTS watch (
  video_id TEXT PRIMARY KEY, watched INTEGER DEFAULT 0, watched_at REAL,
  position REAL DEFAULT 0, length REAL, updated_at REAL
);
CREATE TABLE IF NOT EXISTS hidden (video_id TEXT PRIMARY KEY, hidden_at REAL);
CREATE TABLE IF NOT EXISTS inst_override (name TEXT PRIMARY KEY, score INTEGER);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_videos_channel ON videos(channel);
"""


# --------------------------------------------------------------------------
# Database helpers
# --------------------------------------------------------------------------
def db() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    return con


@contextmanager
def dbc():
    """Connection that commits on success and is always closed."""
    con = db()
    try:
        yield con
        con.commit()
    finally:
        con.close()


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    with dbc() as con:
        con.executescript(SCHEMA)


def retag_topics():
    """Re-apply the topics.py rubrics to the whole library when they changed (e.g. a new topic)."""
    import hashlib

    from topics import TOPICS, classify

    sig = hashlib.sha1(json.dumps(TOPICS, sort_keys=True).encode()).hexdigest()
    changed = 0
    with dbc() as con:
        row = con.execute("SELECT value FROM meta WHERE key='topics_sig'").fetchone()
        if row and row[0] == sig:
            return
        for r in con.execute("SELECT id, title, description, topics FROM videos").fetchall():
            t = ",".join(classify(f"{r['title']} {r['description'] or ''}"))
            if t != (r["topics"] or ""):
                con.execute("UPDATE videos SET topics=? WHERE id=?", (t, r["id"]))
                changed += 1
        con.execute("INSERT OR REPLACE INTO meta VALUES ('topics_sig', ?)", (sig,))
    if changed:
        print(f"Topic rubrics changed - retagged {changed} videos.")


def upsert_video(con, v: dict, query: str = ""):
    """Insert a new video or refresh stats of an existing one."""
    con.execute(
        """INSERT INTO videos (id, source, source_id, title, channel, channel_id, url, embed_url,
               thumbnail, duration, views, published, description, topics, embeddable,
               lectureish, discovered_at, query)
           VALUES (:id,:source,:source_id,:title,:channel,:channel_id,:url,:embed_url,:thumbnail,
               :duration,:views,:published,:description,:topics,:embeddable,:lectureish,:now,:query)
           ON CONFLICT(id) DO UPDATE SET
               views=COALESCE(excluded.views, videos.views),
               duration=COALESCE(excluded.duration, videos.duration),
               channel=CASE WHEN excluded.channel!='' THEN excluded.channel ELSE videos.channel END,
               title=excluded.title,
               embeddable=MIN(videos.embeddable, excluded.embeddable)""",
        {**v, "lectureish": int(bool(v.get("_lectureish"))), "now": time.time(), "query": query},
    )


# --------------------------------------------------------------------------
# Institutions & scoring
# --------------------------------------------------------------------------
class Institutions:
    def __init__(self):
        self.lock = threading.Lock()
        self.reload()

    def reload(self):
        with open(INST_FILE, encoding="utf-8") as f:
            cfg = json.load(f)
        self.unknown = cfg.get("unknown_score", 25)
        self.items = cfg["institutions"]
        self.compiled = [(i["name"], [re.compile(p, re.I) for p in i["patterns"]]) for i in self.items]
        self.base = {i["name"]: i["score"] for i in self.items}
        self._cache: dict[str, str | None] = {}
        self.load_overrides()

    def load_overrides(self):
        try:
            with dbc() as con:
                self.override = {r["name"]: r["score"] for r in con.execute("SELECT * FROM inst_override")}
        except sqlite3.OperationalError:
            self.override = {}

    def match(self, channel: str) -> str | None:
        channel = channel or ""
        if channel in self._cache:
            return self._cache[channel]
        hit = None
        for name, pats in self.compiled:
            if any(p.search(channel) for p in pats):
                hit = name
                break
        with self.lock:
            self._cache[channel] = hit
        return hit

    def score(self, name: str | None) -> int:
        if not name:
            return self.unknown
        return self.override.get(name, self.base.get(name, self.unknown))

    def table(self):
        return [{"name": i["name"], "score": self.score(i["name"]), "default": i["score"],
                 "patterns": i["patterns"]} for i in self.items]


INST: Institutions | None = None


def view_score(views, source) -> float:
    if not views:
        return 0.0
    ref = VIEW_REF.get(source, 1_000_000)
    return max(0.0, min(100.0, 100.0 * math.log10(views + 1) / math.log10(ref + 1)))


def enrich(row: sqlite3.Row, weight: float) -> dict:
    d = dict(row)
    inst = INST.match(d.get("channel"))
    rep = INST.score(inst)
    vs = view_score(d.get("views"), d.get("source"))
    d.update(institution=inst, reputation=rep, view_score=round(vs, 1),
             quality=round(weight * rep + (1 - weight) * vs, 1),
             topics=[t for t in (d.get("topics") or "").split(",") if t])
    return d


def keep_video(v: dict) -> bool:
    """Only keep things that are plausibly CS lectures from a sensible origin."""
    if INST.match(v.get("channel")):
        return True
    return bool(v.get("_lectureish")) and v.get("topics") not in ("", "Other CS")


# --------------------------------------------------------------------------
# Query / recommendation logic
# --------------------------------------------------------------------------
def list_videos(params: dict) -> dict:
    g = lambda k, d=None: (params.get(k) or [d])[0]  # noqa: E731
    view = g("view", "recommended")
    weight = float(g("w", DEFAULT_WEIGHT))
    q = (g("q", "") or "").strip()
    topic = g("topic", "")
    inst_filter = g("institution", "")
    known_only = g("known", "1") == "1"
    source = g("source", "")
    channel = g("channel", "")
    sort = g("sort", "quality")
    limit = int(g("limit", 48))
    offset = int(g("offset", 0))

    where, args = [], []
    if view in ("recommended", "all"):
        where.append("COALESCE(w.watched,0)=0")
    if view == "recommended":
        where.append("h.video_id IS NULL")
    if view == "watched":
        where.append("w.watched=1")
    if view == "progress":
        where.append("COALESCE(w.watched,0)=0 AND w.position > 30")
    if view == "hidden":
        where.append("h.video_id IS NOT NULL")
    if q:
        for word in q.split():
            where.append("(v.title LIKE ? OR v.channel LIKE ? OR v.description LIKE ? OR v.topics LIKE ?)")
            args += [f"%{word}%"] * 4
    if topic:
        where.append("(',' || v.topics || ',') LIKE ?")
        args.append(f"%,{topic},%")
    if source:
        where.append("v.source=?")
        args.append(source)
    if channel:
        where.append("v.channel=?")
        args.append(channel)

    sql = ("SELECT v.*, COALESCE(w.watched,0) AS watched, w.position, w.length, w.watched_at, w.updated_at, "
           "CASE WHEN h.video_id IS NULL THEN 0 ELSE 1 END AS hidden "
           "FROM videos v LEFT JOIN watch w ON w.video_id=v.id LEFT JOIN hidden h ON h.video_id=v.id")
    if where:
        sql += " WHERE " + " AND ".join(where)
    with dbc() as con:
        rows = [enrich(r, weight) for r in con.execute(sql, args)]

    if known_only and view in ("recommended", "all"):
        rows = [r for r in rows if r["institution"]]
    if inst_filter:
        rows = [r for r in rows if r["institution"] == inst_filter]

    keyf = {
        "quality": lambda r: r["quality"],
        "views": lambda r: r["views"] or 0,
        "reputation": lambda r: (r["reputation"], r["views"] or 0),
        "recent": lambda r: r["discovered_at"] or 0,
        "watched_at": lambda r: r["watched_at"] or 0,
        "updated": lambda r: r["updated_at"] or 0,
        "title": lambda r: natural_key(r["title"]),
    }.get(sort, lambda r: r["quality"])
    rows.sort(key=keyf, reverse=(sort != "title"))

    if view == "recommended" and sort == "quality" and not inst_filter:
        rows = diversify(rows, per_channel=3, window=24)

    return {"total": len(rows), "items": rows[offset:offset + limit]}


def natural_key(s):
    """'Lecture 2' < 'Lecture 10'."""
    return [(0, int(t), "") if t.isdigit() else (1, 0, t.lower()) for t in re.split(r"(\d+)", s or "")]


def diversify(rows, per_channel=3, window=24):
    """Keep the top of the list varied: at most `per_channel` videos per channel per window."""
    out = []
    pool = list(rows)
    while pool:
        counts: dict[str, int] = {}
        chunk = []
        rest = []
        for r in pool:
            c = r.get("channel") or ""
            if len(chunk) < window and counts.get(c, 0) < per_channel:
                counts[c] = counts.get(c, 0) + 1
                chunk.append(r)
            else:
                rest.append(r)
        if not chunk:  # cannot happen, but be safe
            chunk, rest = rest, []
        out += chunk
        pool = rest
    return out


def facets() -> dict:
    with dbc() as con:
        rows = con.execute("SELECT channel, topics, source FROM videos").fetchall()
        watched = con.execute("SELECT COUNT(*) FROM watch WHERE watched=1").fetchone()[0]
        progress = con.execute("SELECT COUNT(*) FROM watch WHERE watched=0 AND position>30").fetchone()[0]
        hidden = con.execute("SELECT COUNT(*) FROM hidden").fetchone()[0]
    topics, insts, sources = {}, {}, {}
    for r in rows:
        for t in (r["topics"] or "").split(","):
            if t:
                topics[t] = topics.get(t, 0) + 1
        i = INST.match(r["channel"])
        if i:
            insts[i] = insts.get(i, 0) + 1
        sources[r["source"]] = sources.get(r["source"], 0) + 1
    return {
        "total": len(rows), "watched": watched, "in_progress": progress, "hidden": hidden,
        "topics": sorted(topics.items(), key=lambda x: -x[1]),
        "institutions": sorted(insts.items(), key=lambda x: (-INST.score(x[0]), x[0])),
        "sources": sources,
    }


# --------------------------------------------------------------------------
# Background discovery job
# --------------------------------------------------------------------------
class Job:
    def __init__(self):
        self.lock = threading.Lock()
        self.state = {"running": False, "label": "", "done": 0, "total": 0, "added": 0,
                      "errors": [], "finished_at": None}

    def snapshot(self):
        with self.lock:
            return dict(self.state, errors=self.state["errors"][-5:])

    def start(self, label, plan=None, import_url=None):
        with self.lock:
            if self.state["running"]:
                return False
            self.state = {"running": True, "label": label, "done": 0,
                          "total": len(plan) if plan else 1, "added": 0, "errors": [],
                          "finished_at": None, "current": ""}
        threading.Thread(target=self._run, args=(plan, import_url), daemon=True).start()
        return True

    def _ingest(self, con, gen, query):
        added = 0
        for v in gen:
            if not keep_video(v):
                continue
            existed = con.execute("SELECT 1 FROM videos WHERE id=?", (v["id"],)).fetchone()
            upsert_video(con, v, query)
            if not existed:
                added += 1
        con.commit()
        return added

    def _run(self, plan, import_url):
        try:
            con = db()
            if import_url:
                with self.lock:
                    self.state["current"] = import_url
                n = self._ingest_import(con, import_url)
                with self.lock:
                    self.state["added"] += n
                    self.state["done"] = 1
            for source, query in plan or []:
                with self.lock:
                    self.state["current"] = f"{source}: {query}"
                try:
                    n = self._ingest(con, discovery.run_query(source, query), query)
                    with self.lock:
                        self.state["added"] += n
                except Exception as e:  # keep crawling on individual failures
                    with self.lock:
                        self.state["errors"].append(f"{source} '{query}': {str(e)[:200]}")
                with self.lock:
                    self.state["done"] += 1
            con.execute("INSERT OR REPLACE INTO meta VALUES ('last_crawl', ?)", (str(time.time()),))
            con.commit()
            con.close()
        except Exception as e:
            traceback.print_exc()
            with self.lock:
                self.state["errors"].append(str(e)[:300])
        finally:
            with self.lock:
                self.state["running"] = False
                self.state["finished_at"] = time.time()
                self.state["current"] = ""

    def _ingest_import(self, con, url):
        added = 0
        for v in discovery.ytdlp_import(url):
            v["_lectureish"] = True
            existed = con.execute("SELECT 1 FROM videos WHERE id=?", (v["id"],)).fetchone()
            upsert_video(con, v, f"import:{url}")
            added += 0 if existed else 1
            con.commit()
        return added


JOB = Job()


def backend_name():
    if os.environ.get("YOUTUBE_API_KEY"):
        return "YouTube Data API"
    return "yt-dlp" if discovery.ytdlp_available() else None


def start_crawl(deep=False):
    plan = discovery.crawl_plan(INST.items, deep=deep)
    if not backend_name():
        plan = [p for p in plan if p[0] == "archive"]
    return JOB.start("Deep crawl" if deep else "Crawl", plan)


def start_search(q):
    plan = [("youtube", f"{q} lecture"), ("youtube", f"{q} university course"), ("archive", q)]
    if not backend_name():
        plan = [p for p in plan if p[0] == "archive"]
    return JOB.start(f'Search "{q}"', plan)


# --------------------------------------------------------------------------
# HTTP layer
# --------------------------------------------------------------------------
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC, **kw)

    def log_message(self, fmt, *args):  # quieter console
        if "/api/status" not in (args[0] if args else ""):
            sys.stderr.write("%s\n" % (fmt % args))

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def end_headers(self):
        # Needed so the YouTube embed sees a referrer (otherwise "Error 153").
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        super().end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        p = parse_qs(u.query)
        try:
            if u.path == "/api/videos":
                return self._json(list_videos(p))
            if u.path == "/api/facets":
                return self._json(facets())
            if u.path == "/api/status":
                with dbc() as con:
                    r = con.execute("SELECT value FROM meta WHERE key='last_crawl'").fetchone()
                return self._json({"job": JOB.snapshot(), "backend": backend_name(),
                                   "last_crawl": float(r[0]) if r else None})
            if u.path == "/api/institutions":
                return self._json(INST.table())
            if u.path == "/api/video":
                vid = (p.get("id") or [""])[0]
                with dbc() as con:
                    r = con.execute(
                        "SELECT v.*, COALESCE(w.watched,0) AS watched, w.position, w.length, w.watched_at, "
                        "w.updated_at, 0 AS hidden FROM videos v LEFT JOIN watch w ON w.video_id=v.id "
                        "WHERE v.id=?", (vid,)).fetchone()
                if not r:
                    return self._json({"error": "not found"}, 404)
                return self._json(enrich(r, float((p.get("w") or [DEFAULT_WEIGHT])[0])))
        except Exception as e:
            traceback.print_exc()
            return self._json({"error": str(e)}, 500)
        if u.path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        try:
            b = self._body()
            now = time.time()
            with dbc() as con:
                if u.path == "/api/watch":
                    w = 1 if b.get("watched", True) else 0
                    con.execute(
                        "INSERT INTO watch (video_id, watched, watched_at, updated_at) VALUES (?,?,?,?) "
                        "ON CONFLICT(video_id) DO UPDATE SET watched=excluded.watched, "
                        "watched_at=excluded.watched_at, updated_at=excluded.updated_at",
                        (b["id"], w, now if w else None, now))
                    return self._json({"ok": True})
                if u.path == "/api/progress":
                    con.execute(
                        "INSERT INTO watch (video_id, position, length, updated_at) VALUES (?,?,?,?) "
                        "ON CONFLICT(video_id) DO UPDATE SET position=excluded.position, "
                        "length=COALESCE(excluded.length, watch.length), updated_at=excluded.updated_at",
                        (b["id"], float(b.get("position") or 0), b.get("length"), now))
                    return self._json({"ok": True})
                if u.path == "/api/hide":
                    if b.get("hidden", True):
                        con.execute("INSERT OR REPLACE INTO hidden VALUES (?,?)", (b["id"], now))
                    else:
                        con.execute("DELETE FROM hidden WHERE video_id=?", (b["id"],))
                    return self._json({"ok": True})
                if u.path == "/api/embeddable":
                    con.execute("UPDATE videos SET embeddable=? WHERE id=?",
                                (1 if b.get("ok") else 0, b["id"]))
                    return self._json({"ok": True})
                if u.path == "/api/institutions":
                    name, score = b["name"], b.get("score")
                    if score is None:
                        con.execute("DELETE FROM inst_override WHERE name=?", (name,))
                    else:
                        con.execute("INSERT OR REPLACE INTO inst_override VALUES (?,?)",
                                    (name, max(0, min(100, int(score)))))
                    con.commit()
                    INST.load_overrides()
                    return self._json({"ok": True})
            if u.path == "/api/crawl":
                return self._json({"started": start_crawl(bool(b.get("deep")))})
            if u.path == "/api/search":
                q = (b.get("q") or "").strip()
                if not q:
                    return self._json({"error": "empty query"}, 400)
                return self._json({"started": start_search(q)})
            if u.path == "/api/import":
                url = (b.get("url") or "").strip()
                if not re.match(r"https?://(www\.|m\.)?(youtube\.com|youtu\.be)/", url):
                    return self._json({"error": "Paste a YouTube playlist, channel or video URL"}, 400)
                if not discovery.ytdlp_available():
                    return self._json({"error": "Importing needs yt-dlp (pip install yt-dlp)"}, 400)
                return self._json({"started": JOB.start("Import playlist", None, import_url=url)})
        except Exception as e:
            traceback.print_exc()
            return self._json({"error": str(e)}, 500)
        return self._json({"error": "unknown endpoint"}, HTTPStatus.NOT_FOUND)


def main():
    global INST
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8765)))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--no-crawl", action="store_true", help="don't auto-crawl on first launch")
    args = ap.parse_args()

    init_db()
    retag_topics()
    INST = Institutions()
    be = backend_name()
    print(f"Discovery backend: {be or 'none for YouTube (pip install yt-dlp) - Internet Archive only'}")

    with dbc() as con:
        empty = con.execute("SELECT COUNT(*) FROM videos").fetchone()[0] == 0
    if empty and not args.no_crawl:
        print("Library is empty - starting first crawl in the background (takes a few minutes).")
        start_crawl()

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://localhost:{args.port}/"
    print(f"CS Lecture Finder running at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nBye.")


if __name__ == "__main__":
    main()
