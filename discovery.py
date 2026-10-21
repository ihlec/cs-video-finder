"""Video discovery sources.

* YouTube  - via yt-dlp (no API key needed) or, if YOUTUBE_API_KEY is set,
             via the official YouTube Data API v3 (more robust, reports
             whether embedding is allowed).
* Internet Archive - public advancedsearch API, no key needed.

Every source yields plain dicts with the keys used by db.upsert_video().
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.parse
import urllib.request

from topics import classify, looks_like_lecture

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) cs-video-finder/1.0"
MIN_DURATION = 10 * 60  # seconds - lectures only, no shorts/clips


def _http_json(url: str, timeout: int = 30):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


# --------------------------------------------------------------------------
# YouTube via yt-dlp
# --------------------------------------------------------------------------
def ytdlp_available() -> bool:
    try:
        import yt_dlp  # noqa: F401
        return True
    except Exception:
        return False


def _best_thumb(entry) -> str:
    vid = entry.get("id")
    if vid:
        return f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
    thumbs = entry.get("thumbnails") or []
    return thumbs[-1]["url"] if thumbs else ""


def _yt_record(vid, title, channel, channel_id, views, duration, desc="", published=None, embeddable=1):
    return {
        "id": f"yt:{vid}",
        "source": "youtube",
        "source_id": vid,
        "title": title or "",
        "channel": channel or "",
        "channel_id": channel_id or "",
        "url": f"https://www.youtube.com/watch?v={vid}",
        "embed_url": f"https://www.youtube-nocookie.com/embed/{vid}",
        "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
        "duration": int(duration) if duration else None,
        "views": int(views) if views is not None else None,
        "published": published,
        "description": (desc or "")[:600],
        "topics": ",".join(classify(f"{title} {desc}")),
        "embeddable": embeddable,
    }


def ytdlp_search(query: str, n: int = 50):
    """Search YouTube with yt-dlp in 'flat' mode (fast, one page per ~20 hits)."""
    import yt_dlp

    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": "in_playlist",
        "ignoreerrors": False,  # surface failures in the UI's job status
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"ytsearch{n}:{query}", download=False) or {}
    for e in info.get("entries") or []:
        if not e or not e.get("id"):
            continue
        url = e.get("url") or ""
        if "/shorts/" in url or e.get("live_status") in ("is_live", "is_upcoming"):
            continue
        yield _yt_record(
            e["id"], e.get("title"), e.get("channel") or e.get("uploader"),
            e.get("channel_id"), e.get("view_count"), e.get("duration"),
            e.get("description") or "",
        )


def ytdlp_import(url: str, limit: int = 300):
    """Import a YouTube playlist / channel / single video URL.

    Playlist entries in flat mode often lack view counts, so missing values
    are filled in with one extra lookup per video (slower but accurate).
    """
    import yt_dlp

    flat = {"quiet": True, "no_warnings": True, "skip_download": True,
            "extract_flat": "in_playlist", "ignoreerrors": True, "playlistend": limit}
    full = {"quiet": True, "no_warnings": True, "skip_download": True, "ignoreerrors": True}
    with yt_dlp.YoutubeDL(flat) as ydl:
        info = ydl.extract_info(url, download=False) or {}
    entries = info.get("entries")
    if entries is None:  # single video
        entries = [info]
    pl_channel = info.get("channel") or info.get("uploader")
    pl_channel_id = info.get("channel_id")
    with yt_dlp.YoutubeDL(full) as ydl_full:
        for e in entries:
            if not e or not e.get("id"):
                continue
            if e.get("_type") == "playlist" or (e.get("ie_key") or "").startswith("YoutubeTab"):
                continue  # nested tabs/playlists - skip
            views, duration = e.get("view_count"), e.get("duration")
            desc = e.get("description") or ""
            channel = e.get("channel") or e.get("uploader") or pl_channel
            channel_id = e.get("channel_id") or pl_channel_id
            published = None
            if views is None or duration is None:
                try:
                    d = ydl_full.extract_info(f"https://www.youtube.com/watch?v={e['id']}",
                                              download=False, process=False) or {}
                    views = d.get("view_count", views)
                    duration = d.get("duration", duration)
                    desc = d.get("description") or desc
                    channel = d.get("channel") or channel
                    channel_id = d.get("channel_id") or channel_id
                    published = d.get("upload_date")
                except Exception:
                    pass
            yield _yt_record(e["id"], e.get("title"), channel, channel_id, views, duration, desc, published)


# --------------------------------------------------------------------------
# YouTube Data API v3 (optional, needs YOUTUBE_API_KEY)
# --------------------------------------------------------------------------
def _iso_duration(s: str) -> int | None:
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", s or "")
    if not m:
        return None
    d, h, mi, se = (int(x) if x else 0 for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + se


def api_search(query: str, n: int = 50, key: str | None = None):
    key = key or os.environ.get("YOUTUBE_API_KEY")
    params = {"part": "snippet", "type": "video", "maxResults": min(n, 50), "q": query,
              "videoDuration": "any", "videoEmbeddable": "any", "key": key}
    data = _http_json("https://www.googleapis.com/youtube/v3/search?" + urllib.parse.urlencode(params))
    ids = [it["id"]["videoId"] for it in data.get("items", []) if it.get("id", {}).get("videoId")]
    if not ids:
        return
    params = {"part": "snippet,contentDetails,statistics,status", "id": ",".join(ids), "key": key}
    data = _http_json("https://www.googleapis.com/youtube/v3/videos?" + urllib.parse.urlencode(params))
    for it in data.get("items", []):
        sn, st = it.get("snippet", {}), it.get("statistics", {})
        yield _yt_record(
            it["id"], sn.get("title"), sn.get("channelTitle"), sn.get("channelId"),
            st.get("viewCount"), _iso_duration(it.get("contentDetails", {}).get("duration")),
            sn.get("description", ""), (sn.get("publishedAt") or "")[:10].replace("-", ""),
            1 if it.get("status", {}).get("embeddable", True) else 0,
        )


# --------------------------------------------------------------------------
# Internet Archive
# --------------------------------------------------------------------------
def archive_search(query: str, rows: int = 100):
    q = (f'mediatype:movies AND ({query}) AND '
         '(subject:"computer science" OR subject:lecture OR subject:lectures OR title:lecture OR title:course)')
    params = [("q", q), ("rows", rows), ("page", 1), ("output", "json"), ("sort[]", "downloads desc")]
    for f in ("identifier", "title", "creator", "downloads", "date", "description", "subject"):
        params.append(("fl[]", f))
    data = _http_json("https://archive.org/advancedsearch.php?" + urllib.parse.urlencode(params))
    for d in data.get("response", {}).get("docs", []):
        ident = d.get("identifier")
        if not ident:
            continue
        creator = d.get("creator")
        if isinstance(creator, list):
            creator = ", ".join(creator)
        desc = d.get("description") or ""
        if isinstance(desc, list):
            desc = " ".join(desc)
        desc = re.sub(r"<[^>]+>", " ", desc)
        title = d.get("title") or ident
        if isinstance(title, list):
            title = title[0]
        yield {
            "id": f"ia:{ident}",
            "source": "archive",
            "source_id": ident,
            "title": title,
            "channel": creator or "Internet Archive",
            "channel_id": "",
            "url": f"https://archive.org/details/{ident}",
            "embed_url": f"https://archive.org/embed/{ident}",
            "thumbnail": f"https://archive.org/services/img/{ident}",
            "duration": None,
            "views": d.get("downloads"),
            "published": (d.get("date") or "")[:10].replace("-", ""),
            "description": desc[:600],
            "topics": ",".join(classify(f"{title} {desc}")),
            "embeddable": 1,
        }


# --------------------------------------------------------------------------
# Crawl plan
# --------------------------------------------------------------------------
TOPIC_QUERIES = [
    "introduction to computer science lecture", "algorithms lecture university course",
    "data structures lecture university", "operating systems lecture course",
    "database systems lecture course", "computer networks lecture course",
    "computer architecture lecture course", "compilers lecture course",
    "programming languages lecture course", "theory of computation lecture",
    "machine learning lecture university course", "deep learning lecture course",
    "artificial intelligence lecture course", "natural language processing lecture course",
    "computer vision lecture course", "reinforcement learning lecture course",
    "distributed systems lecture course", "computer security lecture course",
    "ipfs decentralized web lecture", "blockchain lecture university course",
    "peer to peer systems lecture course", "decentralized systems web3 lecture",
    "cryptography lecture course", "computer graphics lecture course",
    "discrete mathematics for computer science lecture", "linear algebra lecture course",
    "probability for computer science lecture", "software engineering lecture course",
    "functional programming lecture course", "quantum computing lecture course",
    "robotics lecture course", "human computer interaction lecture course",
    "parallel computing lecture course", "information theory lecture course",
]

DEEP_SUFFIXES = ["algorithms lecture", "machine learning lecture", "systems lecture",
                 "theory lecture", "programming lecture", "security lecture"]


def crawl_plan(institutions, deep: bool = False):
    """List of (source, query) pairs for a full crawl."""
    plan = [("youtube", q) for q in TOPIC_QUERIES]
    for inst in institutions:
        s = inst.get("search")
        if not s:
            continue
        plan.append(("youtube", f"{s} computer science lecture"))
        if deep:
            plan += [("youtube", f"{s} {suf}") for suf in DEEP_SUFFIXES]
    plan += [("archive", '"computer science"'), ("archive", "algorithms OR programming OR \"machine learning\"")]
    return plan


def run_query(source: str, query: str, n: int = 50):
    """Dispatch one query to the right backend and apply lecture filters."""
    if source == "archive":
        gen = archive_search(query)
    elif os.environ.get("YOUTUBE_API_KEY"):
        gen = api_search(query, n)
    else:
        gen = ytdlp_search(query, n)
    for v in gen:
        if v["duration"] is not None and v["duration"] < MIN_DURATION:
            continue
        v["_lectureish"] = looks_like_lecture(v["title"], v["description"])
        yield v
