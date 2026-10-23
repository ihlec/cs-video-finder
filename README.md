# Lecture Finder

**Try it:** https://bafybeia2tvfmtddkmwsap3pard3lmb3aevfgkiwmsv3agpqulh4lmikwwa.ipfs.inbrowser.link
(static snapshot on IPFS — watch history stays in your browser)

A local web UI that finds **free lecture and talk videos** in four catalogs — **Computer Science**,
**Physics**, **Economics**, and **Wisdom & Life** (philosophy in the broadest sense: life advice and
experience, psychology, history, money, meaning) — ranks them by **quality** (institution reputation + view
count), lets you **stream them inside the app**, and **remembers what you've watched**. Each visit
starts with a catalog picker; the sidebar groups every topic under its catalog.

## Start

```bash
git clone https://github.com/ihlec/cs-video-finder.git
cd cs-video-finder
bash run.sh                # opens http://localhost:8765
```

The first run creates a `.venv`, installs [yt-dlp](https://github.com/yt-dlp/yt-dlp) and starts
crawling in the background (roughly 60 searches, a few minutes). Results show up while the crawl runs.
Python 3.10+ is recommended (`brew install python`). Options: `bash run.sh --port 9000 --no-browser`.

## How it works

| | |
|---|---|
| **Sources** | YouTube (through yt-dlp, no API key needed) and the Internet Archive (public API). |
| **Quality score** | `quality = w × reputation + (1 − w) × popularity`. *Reputation* (0–100) comes from `institutions.json`. *Popularity* is `log10(views)` scaled so that 5M YouTube views (or 100K archive.org plays) = 100. Use the sidebar slider to set `w` (default 60 % origin / 40 % views). |
| **Recommendations** | Unwatched, not-hidden videos sorted by quality. The top of the list is kept varied, with at most 3 videos per channel in each block of 24. |
| **Playback** | YouTube and archive.org videos play in an embedded player. If the uploader disabled embedding, the app detects it (player errors 101/150/153), remembers it, and shows a **Watch on YouTube** button instead. Every card also has an *open on source* link. |
| **Watch history** | Saved in `data/library.db` (SQLite). Your position is saved every 10 s, so you can resume from *Continue watching*. A video is marked watched automatically at 90 %, or by hand with ✓. *Not interested* removes a video from recommendations. |
| **Up next** | The next lectures of the same course/channel (in title order), then the best recommendations. |

## Static site for IPFS (Pinata)

`site/` is a server-less build of the UI that can be pinned to IPFS:

```bash
python3 build_site.py      # export the crawled library to site/library.json
```

Then upload the whole `site/` folder on [Pinata](https://app.pinata.cloud) (Add → Folder) and open
the returned CID through any gateway, e.g. `https://gateway.pinata.cloud/ipfs/<CID>/`.
Re-run `build_site.py` and re-pin after a new crawl to publish an updated snapshot (the CID changes).

What's different from the local app: the catalog is a frozen snapshot (no crawling, searching
online, or importing playlists), and watch history / resume positions / "not interested" are stored
in each visitor's own browser (localStorage) instead of SQLite — so they survive reloads but don't
follow you across browsers. Everything else works the same: quality ranking with the origin/views
slider, topics, embedded playback with external fallback, and "up next".

To preview locally: `python3 -m http.server 8099` in the project folder, then open
http://localhost:8099/site/ (opening `index.html` from disk won't work — `file://` can't fetch the library).

## Growing the library

- **Refresh catalog** re-runs the crawl, which adds new videos and updates view counts. Shift-click it for a
  *deep crawl* (about 240 searches, institution × topic).
- **Find more online** searches YouTube and the Internet Archive for whatever you typed in the search box.
- **Import playlist** adds every video of a YouTube playlist or channel, for example a full course.

## Tuning

- **Institutions tab**: change any institution's reputation score from the UI. Changes take effect immediately.
- **`institutions.json`**: add institutions or channel-name patterns (regular expressions), and set the
  score for unknown origins. Restart after editing.
- **Known institutions only** (sidebar, on by default): turn it off to also see lecture-like videos from
  channels that aren't in the table. They get the "unknown" reputation of 25.
- **More reliable YouTube data**: set `YOUTUBE_API_KEY=<key> bash run.sh` to use the official YouTube
  Data API instead of yt-dlp. This also tells the app up front which videos can't be embedded.
  The free quota covers about 100 searches a day.

## Troubleshooting

- *Crawl finishes with "0 new" or with query errors*: YouTube probably changed something. `rm .venv/.updated && bash run.sh`
  forces a yt-dlp update. If yt-dlp asks for a JavaScript runtime, run `brew install deno`.
- *Player shows "Error 153"*: open the app at `http://localhost:8765`, not through a `file://` URL.
- *Start over*: stop the app and delete the `data/` folder. This also deletes your watch history.

## Files

```
app.py            HTTP server, SQLite, scoring, recommendation and crawl jobs (Python stdlib only)
discovery.py      YouTube (yt-dlp / Data API) and Internet Archive search
topics.py         keyword topic tagging and lecture detection
institutions.json reputation table
static/           the web UI (vanilla HTML/CSS/JS)
data/library.db   your library and watch history (created on first run)
```
