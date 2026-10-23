/* CS Lecture Finder - static build (for IPFS). All state lives in localStorage. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const PAGE = 48;

/* ---------------- persistent state (this browser only) ---------------- */
const LS_KEY = "csvf-static";
const store = { watched: {}, hidden: {}, pos: {}, noembed: {}, prefs: {} };
try { Object.assign(store, JSON.parse(localStorage.getItem(LS_KEY) || "{}")); } catch (_) {}
const persist = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch (_) {} };

const state = {
  view: "recommended", q: "", topic: "", institution: "", source: "", field: "", sort: "quality",
  known: true, weight: 0.6, offset: 0, items: [], total: 0,
};
Object.assign(state, store.prefs || {});
const savePrefs = () => { store.prefs = { weight: state.weight, known: state.known, sort: state.sort }; persist(); };

let LIB = { generated: "", institutions: [], videos: [] };

function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

const fmtViews = (n) => n == null ? "views n/a" :
  n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M views" :
  n >= 1e3 ? Math.round(n / 1e3) + "K views" : n + " views";
const fmtDur = (s) => {
  if (!s) return "";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};
const views = (v) => v.source === "archive" ? (v.views == null ? "" : fmtViews(v.views).replace("views", "plays")) : fmtViews(v.views);

const ICON = {
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  ext: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  hide: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10 10 0 0 1 12 5c5 0 9 4.5 10 7a13 13 0 0 1-3 4.1M6.6 6.6A13 13 0 0 0 2 12c1 2.5 5 7 10 7a10 10 0 0 0 4.4-1"/></svg>',
  show: '<svg viewBox="0 0 24 24"><path d="M2 12c1-2.5 5-7 10-7s9 4.5 10 7c-1 2.5-5 7-10 7S3 14.5 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  play: '<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="rgba(0,0,0,.6)"/><path d="M26 20l18 12-18 12z" fill="#fff"/></svg>',
};

/* ---------------- query / recommendation logic ---------------- */
function decorate(v) {
  const pos = store.pos[v.id];
  return {
    ...v,
    institution: v.inst, reputation: v.rep, view_score: v.vs,
    watched: store.watched[v.id] ? 1 : 0, watched_at: store.watched[v.id] || 0,
    hidden: store.hidden[v.id] ? 1 : 0,
    position: pos ? pos[0] : 0, length: pos ? pos[1] : null, updated_at: pos ? pos[2] : 0,
    embeddable: store.noembed[v.id] ? 0 : v.emb,
    quality: Math.round((state.weight * v.rep + (1 - state.weight) * v.vs) * 10) / 10,
  };
}

function natKey(s) {
  return String(s || "").toLowerCase().replace(/\d+/g, (d) => d.padStart(8, "0"));
}

function diversify(rows, perChannel = 3, window = 24) {
  const out = []; let pool = rows;
  while (pool.length) {
    const counts = {}, chunk = [], rest = [];
    for (const r of pool) {
      const c = r.channel || "";
      if (chunk.length < window && (counts[c] || 0) < perChannel) { counts[c] = (counts[c] || 0) + 1; chunk.push(r); }
      else rest.push(r);
    }
    if (!chunk.length) break;
    out.push(...chunk); pool = rest;
  }
  return out;
}

function listVideos() {
  let rows = LIB.videos.map(decorate);
  const v = state.view;
  if (v === "recommended" || v === "all") rows = rows.filter((r) => !r.watched);
  if (v === "recommended") rows = rows.filter((r) => !r.hidden);
  if (v === "watched") rows = rows.filter((r) => r.watched);
  if (v === "progress") rows = rows.filter((r) => !r.watched && r.position > 30);
  if (v === "hidden") rows = rows.filter((r) => r.hidden);
  if (state.q.trim()) {
    for (const word of state.q.trim().toLowerCase().split(/\s+/)) {
      rows = rows.filter((r) =>
        r.title.toLowerCase().includes(word) || r.channel.toLowerCase().includes(word) ||
        (r.desc || "").toLowerCase().includes(word) || r.topics.join(",").toLowerCase().includes(word));
    }
  }
  if (state.topic) rows = rows.filter((r) => r.topics.includes(state.topic));
  if (state.field) { // topics without a field ("Other") show under every field
    const tf = LIB.topic_fields || {};
    rows = rows.filter((r) => r.topics.some((t) => !tf[t] || tf[t] === state.field));
  }
  if (state.source) rows = rows.filter((r) => r.source === state.source);
  if (state.known && (v === "recommended" || v === "all")) rows = rows.filter((r) => r.institution);
  if (state.institution) rows = rows.filter((r) => r.institution === state.institution);

  const sort = v === "watched" ? "watched_at" : v === "progress" ? "updated" : state.sort;
  const keyf = {
    quality: (r) => r.quality,
    views: (r) => r.views || 0,
    reputation: (r) => r.reputation * 1e12 + (r.views || 0),
    recent: (r) => r.da || 0,
    watched_at: (r) => r.watched_at || 0,
    updated: (r) => r.updated_at || 0,
  }[sort] || ((r) => r.quality);
  rows.sort((a, b) => keyf(b) - keyf(a));

  if (v === "recommended" && state.sort === "quality" && !state.institution) rows = diversify(rows);
  return rows;
}

/* ---------------- list rendering ---------------- */
function card(v) {
  const pct = v.length && v.position ? Math.min(100, (v.position / v.length) * 100) : 0;
  const tip = `Quality ${v.quality} = origin ${v.reputation} × ${Math.round(state.weight * 100)}% + views ${v.view_score} × ${Math.round((1 - state.weight) * 100)}%`;
  return `<article class="card" data-id="${esc(v.id)}">
    <div class="thumb" data-act="play">
      <div class="ph">${esc(v.institution || v.channel || "")}</div>
      ${v.thumb ? `<img loading="lazy" src="${esc(v.thumb)}" alt="" onerror="this.remove()">` : ""}
      <span class="src">${v.source === "archive" ? "ARCHIVE.ORG" : "YOUTUBE"}</span>
      ${v.duration ? `<span class="dur">${fmtDur(v.duration)}</span>` : ""}
      ${pct && !v.watched ? `<span class="prog" style="width:${pct}%"></span>` : ""}
      ${v.watched ? `<div class="done">Watched</div>` : `<div class="play">${ICON.play}</div>`}
    </div>
    <div class="body">
      <div class="title" data-act="play" title="${esc(v.title)}">${esc(v.title)}</div>
      <div class="sub">
        <span class="inst ${v.institution ? "" : "unknown"}">${esc(v.institution || "Unverified origin")}</span>
        <span>${esc(v.channel)}</span>
      </div>
      <div class="chips">${v.topics.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>
      <div class="foot">
        <div class="q" title="${esc(tip)}"><b>${Math.round(v.quality)}</b><span class="qbar"><i style="width:${v.quality}%"></i></span><span>${views(v)}</span></div>
        <div class="acts">
          <button class="icon-btn ${v.watched ? "on" : ""}" data-act="watch" title="${v.watched ? "Mark as unwatched" : "Mark as watched"}">${ICON.check}</button>
          <button class="icon-btn" data-act="hide" title="${v.hidden ? "Unhide" : "Not interested"}">${v.hidden ? ICON.show : ICON.hide}</button>
          <a class="icon-btn" data-act="ext" href="${esc(v.url)}" target="_blank" rel="noopener" title="Open on source site">${ICON.ext}</a>
        </div>
      </div>
    </div>
  </article>`;
}

function load(reset = true) {
  if (reset) state.offset = 0;
  const rows = listVideos();
  state.total = rows.length;
  state.items = rows.slice(0, state.offset + PAGE);
  renderGrid();
}

function renderGrid() {
  const g = $("#grid");
  if (!state.items.length) {
    let msg = "Nothing here yet.";
    if (state.view === "recommended" || state.view === "all") msg = state.q ? "No matches in the library." : "The library is empty.";
    if (state.view === "progress") msg = "Videos you started but didn't finish show up here.";
    if (state.view === "watched") msg = "Videos you finish (or mark with ✓) show up here.";
    g.innerHTML = `<div class="empty">${msg}</div>`;
  } else {
    g.innerHTML = state.items.map(card).join("");
  }
  $("#moreBtn").classList.toggle("hidden", state.items.length >= state.total);
}

$("#grid").addEventListener("click", (e) => {
  const actEl = e.target.closest("[data-act]"); if (!actEl) return;
  const id = e.target.closest(".card").dataset.id;
  const v = state.items.find((x) => x.id === id);
  const act = actEl.dataset.act;
  if (act === "play") return openPlayer(v);
  if (act === "ext") { setTimeout(() => toast("Opened on source — tick ✓ when you've watched it"), 300); return; }
  e.preventDefault();
  if (act === "watch") setWatched(v, !v.watched);
  if (act === "hide") {
    if (v.hidden) delete store.hidden[v.id]; else store.hidden[v.id] = Date.now();
    persist(); toast(v.hidden ? "Unhidden" : "Hidden from recommendations");
  }
  refreshAll(false);
});

$("#moreBtn").onclick = () => { state.offset += PAGE; load(false); };

function setWatched(v, watched) {
  if (watched) store.watched[v.id] = Date.now(); else delete store.watched[v.id];
  v.watched = watched ? 1 : 0;
  persist();
  toast(watched ? "Marked as watched" : "Marked as unwatched");
}

/* ---------------- facets / sidebar ---------------- */
function loadFacets() {
  const ids = new Set(LIB.videos.map((v) => v.id));
  const watched = Object.keys(store.watched).filter((id) => ids.has(id)).length;
  const progress = LIB.videos.filter((v) => !store.watched[v.id] && (store.pos[v.id]?.[0] || 0) > 30).length;
  const hidden = Object.keys(store.hidden).filter((id) => ids.has(id)).length;
  $("#cWatched").textContent = watched || "";
  $("#cProgress").textContent = progress || "";
  $("#cHidden").textContent = hidden || "";

  const topics = {};
  for (const v of LIB.videos) for (const t of v.topics) topics[t] = (topics[t] || 0) + 1;
  const tf = LIB.topic_fields || {};
  const shown = Object.entries(topics).sort((a, b) => b[1] - a[1])
    .filter(([t]) => !state.field || !tf[t] || tf[t] === state.field);
  const tl = $("#topicList");
  tl.innerHTML = `<button data-topic="" class="${state.topic ? "" : "active"}">All topics <small>${state.field ? "" : LIB.videos.length}</small></button>` +
    shown.map(([t, n]) => `<button data-topic="${esc(t)}" class="${state.topic === t ? "active" : ""}">${esc(t)} <small>${n}</small></button>`).join("");

  const sel = $("#instSel"), cur = state.institution;
  sel.innerHTML = `<option value="">All institutions</option>` +
    LIB.institutions.map(([i, n]) => `<option value="${esc(i)}">${esc(i)} (${n})</option>`).join("");
  sel.value = cur;
  const yt = LIB.videos.filter((v) => v.source === "youtube").length;
  $("#libStats").textContent = `${LIB.videos.length} videos · ${yt} YouTube · ${LIB.videos.length - yt} Internet Archive · snapshot ${LIB.generated}`;
}

$("#topicList").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  state.topic = b.dataset.topic;
  [...$("#topicList").children].forEach((x) => x.classList.toggle("active", x === b));
  load();
});
$("#instSel").onchange = (e) => { state.institution = e.target.value; load(); };
$("#sourceSel").onchange = (e) => { state.source = e.target.value; load(); };
$("#fieldSel").onchange = (e) => { state.field = e.target.value; state.topic = ""; refreshAll(true); };
$("#sort").onchange = (e) => { state.sort = e.target.value; savePrefs(); load(); };
$("#known").onchange = (e) => { state.known = e.target.checked; savePrefs(); load(); };
const weightHint = () => {
  const w = Math.round(state.weight * 100);
  $("#weightHint").textContent = `Score = ${w}% institution reputation + ${100 - w}% popularity (log of views).`;
};
let wT;
$("#weight").oninput = (e) => {
  state.weight = e.target.value / 100; weightHint(); savePrefs();
  clearTimeout(wT); wT = setTimeout(load, 200);
};

let qT;
$("#q").addEventListener("input", (e) => { state.q = e.target.value; clearTimeout(qT); qT = setTimeout(load, 250); });
$("#searchForm").addEventListener("submit", (e) => { e.preventDefault(); state.q = $("#q").value; load(); });

/* ---------------- tabs ---------------- */
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]"); if (!b) return;
  [...$("#tabs").querySelectorAll("button[data-view]")].forEach((x) => x.classList.toggle("active", x === b));
  state.view = b.dataset.view;
  load();
});
$("#filtersBtn").onclick = () => $("#side").classList.toggle("open");

/* ---------------- player ---------------- */
let current = null, ytPlayer = null, progTimer = null, lastSaved = 0, autoMarked = false;
let ytApiReady = null;
function loadYTApi() {
  if (ytApiReady) return ytApiReady;
  ytApiReady = new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api"; s.onerror = reject;
    document.head.appendChild(s);
    setTimeout(() => reject(new Error("timeout")), 8000);
  });
  return ytApiReady;
}

function stopPlayer() {
  clearInterval(progTimer); progTimer = null;
  if (ytPlayer) { try { saveProgress(true); ytPlayer.destroy(); } catch (_) {} ytPlayer = null; }
  $("#stage").innerHTML = "";
}

function showFallback(v, reason) {
  const host = v.source === "archive" ? "Internet Archive" : "YouTube";
  $("#stage").innerHTML = `<div class="fallback" style="background-image:url('${esc(v.thumb)}')"><div>
    <h3>${reason || "This video can't be played here"}</h3>
    <p>The uploader doesn't allow embedded playback. You can still watch it for free on ${host}.</p>
    <div class="row2"><a class="btn" href="${esc(v.url)}" target="_blank" rel="noopener">${ICON.ext} Watch on ${host}</a>
    <button class="btn ghost" id="tryEmbed">Try embedded anyway</button></div></div></div>`;
  $("#tryEmbed").onclick = () => mountPlayer(v, true);
}

function saveProgress(force) {
  if (!ytPlayer || !current || typeof ytPlayer.getCurrentTime !== "function") return;
  const pos = ytPlayer.getCurrentTime(), len = ytPlayer.getDuration();
  if (!len) return;
  const now = Date.now();
  if (force || now - lastSaved > 10000) {
    lastSaved = now;
    store.pos[current.id] = [pos, len, now]; persist();
  }
  if (!autoMarked && !current.watched && pos / len >= 0.9) {
    autoMarked = true; current.watched = 1;
    store.watched[current.id] = Date.now(); persist();
    updateWatchedBtn(); toast("Marked as watched (90% reached)");
  }
}

async function mountPlayer(v, force = false) {
  stopPlayer();
  autoMarked = false;
  if (v.source === "archive") {
    $("#stage").innerHTML = `<iframe src="${esc(v.embed)}" allow="autoplay; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
    return;
  }
  if (!v.embeddable && !force) return showFallback(v);
  $("#stage").innerHTML = `<div id="ytmount"></div>`;
  let YT;
  try { YT = await loadYTApi(); } catch (_) {
    // IFrame API unavailable - plain iframe (no progress tracking)
    $("#stage").innerHTML = `<iframe src="${esc(v.embed)}?autoplay=1&rel=0&start=${Math.floor(v.position || 0)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
    return;
  }
  if (current !== v) return; // user switched video while loading
  const start = v.watched ? 0 : Math.max(0, Math.floor((v.position || 0) - 3));
  ytPlayer = new YT.Player("ytmount", {
    videoId: v.sid, host: "https://www.youtube-nocookie.com",
    playerVars: { autoplay: 1, rel: 0, modestbranding: 1, start, origin: location.origin, playsinline: 1 },
    events: {
      onReady: () => { progTimer = setInterval(() => saveProgress(false), 3000); },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.PAUSED) saveProgress(true);
        if (e.data === YT.PlayerState.ENDED) saveProgress(true);
        if (e.data === YT.PlayerState.PLAYING && !v.embeddable) { v.embeddable = 1; delete store.noembed[v.id]; persist(); }
      },
      onError: (e) => {
        if ([101, 150, 153, 100].includes(e.data)) {
          if (e.data !== 100) { store.noembed[v.id] = 1; persist(); }
          v.embeddable = 0; stopPlayer();
          showFallback(v, e.data === 100 ? "This video is no longer available" : "Embedding is disabled for this video");
        }
      },
    },
  });
}

function updateWatchedBtn() {
  const b = $("#pWatched");
  b.textContent = current.watched ? "✓ Watched" : "Mark as watched";
  b.classList.toggle("watched", !!current.watched);
}

function openPlayer(v) {
  current = v;
  $("#player").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  $("#pTitle").textContent = v.title;
  $("#pMeta").innerHTML = `<span class="inst ${v.institution ? "" : "unknown"}">${esc(v.institution || "Unverified origin")}</span>
    <span>${esc(v.channel)}</span><span>·</span><span>${views(v)}</span>${v.duration ? `<span>·</span><span>${fmtDur(v.duration)}</span>` : ""}`;
  const w = Math.round(state.weight * 100);
  $("#pScore").innerHTML = `<span>Quality <b>${Math.round(v.quality)}</b></span>
    <span>Origin <b>${v.reputation}</b> × ${w}%</span><span>Popularity <b>${Math.round(v.view_score)}</b> × ${100 - w}%</span>
    ${v.topics.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}`;
  $("#pDesc").textContent = v.desc || "";
  const ext = $("#pExternal");
  ext.href = v.url; ext.innerHTML = `${ICON.ext} Open on ${v.source === "archive" ? "archive.org" : "YouTube"}`;
  updateWatchedBtn();
  mountPlayer(v);
  renderUpNext();
}

function nextCandidates() {
  const rec = listVideosForUpnext();
  let series = [];
  if (current.channel) {
    const all = LIB.videos.filter((x) => x.channel === current.channel).map(decorate)
      .sort((a, b) => natKey(a.title) < natKey(b.title) ? -1 : 1);
    const cur = natKey(current.title);
    series = all.filter((x) => natKey(x.title) > cur && !x.watched).slice(0, 3);
  }
  const seen = new Set([current.id]);
  const out = [];
  for (const x of [...series, ...rec]) {
    if (seen.has(x.id) || x.watched) continue;
    seen.add(x.id); out.push(x);
    if (out.length === 8) break;
  }
  return out;
}

function listVideosForUpnext() {
  let rows = LIB.videos.map(decorate).filter((r) => !r.watched && !r.hidden);
  if (state.known) rows = rows.filter((r) => r.institution);
  rows.sort((a, b) => b.quality - a.quality);
  return diversify(rows).slice(0, 12);
}

function renderUpNext() {
  const list = nextCandidates();
  renderUpNext.list = list;
  $("#upnext").innerHTML = list.map((v, i) => `<div class="mini" data-i="${i}">
    <div class="thumb"><div class="ph">${esc(v.institution || "")}</div>${v.thumb ? `<img loading="lazy" src="${esc(v.thumb)}" alt="" onerror="this.remove()">` : ""}
    ${v.duration ? `<span class="dur">${fmtDur(v.duration)}</span>` : ""}</div>
    <span>${esc(v.title)}</span><small>${esc(v.institution || v.channel)} · quality ${Math.round(v.quality)}</small></div>`).join("");
}
$("#upnext").addEventListener("click", (e) => {
  const m = e.target.closest(".mini"); if (!m) return;
  openPlayer(renderUpNext.list[+m.dataset.i]);
});

function closePlayer() {
  stopPlayer(); current = null;
  $("#player").classList.add("hidden"); document.body.style.overflow = "";
  refreshAll(false);
}
$("#closePlayer").onclick = closePlayer;
$("#player").addEventListener("click", (e) => { if (e.target.id === "player") closePlayer(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#player").classList.contains("hidden")) closePlayer();
});
$("#pWatched").onclick = () => { setWatched(current, !current.watched); updateWatchedBtn(); };
$("#pHide").onclick = () => { store.hidden[current.id] = Date.now(); persist(); toast("Hidden from recommendations"); $("#pNext").click(); };
$("#pNext").onclick = () => { const n = renderUpNext.list?.[0]; if (n) openPlayer(n); else closePlayer(); };
$("#pExternal").addEventListener("click", () => { if (ytPlayer?.pauseVideo) ytPlayer.pauseVideo(); });

function refreshAll(reset = true) {
  loadFacets();
  if (reset) load(true);
  else { // keep current scroll depth
    const rows = listVideos();
    state.total = rows.length;
    state.items = rows.slice(0, Math.max(PAGE, state.items.length));
    renderGrid();
  }
}

/* ---------------- init ---------------- */
$("#weight").value = Math.round(state.weight * 100);
$("#known").checked = state.known;
$("#sort").value = state.sort;
weightHint();

fetch("library.json")
  .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
  .then((lib) => {
    LIB = lib;
    $("#snapshotPill").textContent = `${lib.videos.length} lectures · snapshot ${lib.generated}`;
    refreshAll(true);
  })
  .catch((e) => {
    $("#grid").innerHTML = `<div class="empty">Could not load library.json (${esc(e.message)}).
      If you opened this page from disk (file://), serve it over HTTP or an IPFS gateway instead.</div>`;
  });
