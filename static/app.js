/* CS Lecture Finder - front end (no build step, no dependencies). */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const PAGE = 48;

const state = {
  view: "recommended", q: "", topic: "", institution: "", source: "", field: "", sort: "quality",
  known: true, weight: 0.6, offset: 0, items: [], total: 0, lastJobDone: -1,
  open: {}, // which catalogs are expanded in the sidebar tree; all start collapsed
};
try { // per-browser UI preferences only; watch history lives in the server's SQLite DB
  const saved = JSON.parse(localStorage.getItem("csvf-prefs") || "{}");
  Object.assign(state, saved);
} catch (_) {}
const savePrefs = () => {
  try { localStorage.setItem("csvf-prefs", JSON.stringify({ weight: state.weight, known: state.known, sort: state.sort, field: state.field })); } catch (_) {}
};

const api = async (path, body) => {
  const r = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};

const toTop = () => window.scrollTo({ top: 0 });

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

/* ---------------- list rendering ---------------- */
function qs(extra = {}) {
  const p = new URLSearchParams({
    view: state.view, q: state.q, topic: state.topic, institution: state.institution, source: state.source,
    field: state.field,
    sort: state.view === "watched" ? "watched_at" : state.view === "progress" ? "updated" : state.sort,
    known: state.known ? "1" : "0", w: state.weight, limit: PAGE, offset: state.offset, ...extra,
  });
  return p.toString();
}

async function load(reset = true) {
  if (state.view === "institutions") return renderInstitutions();
  $("#instTable").classList.add("hidden"); $("#grid").classList.remove("hidden");
  if (reset) state.offset = 0;
  const data = await api("/api/videos?" + qs());
  state.items = reset ? data.items : state.items.concat(data.items);
  state.total = data.total;
  renderGrid();
}

function card(v) {
  const pct = v.length && v.position ? Math.min(100, (v.position / v.length) * 100) : 0;
  const tip = `Quality ${v.quality} = origin ${v.reputation} × ${Math.round(state.weight * 100)}% + views ${v.view_score} × ${Math.round((1 - state.weight) * 100)}%`;
  return `<article class="card" data-id="${esc(v.id)}">
    <div class="thumb" data-act="play">
      <div class="ph">${esc(v.institution || v.channel || "")}</div>
      ${v.thumbnail ? `<img loading="lazy" src="${esc(v.thumbnail)}" alt="" onerror="this.remove()">` : ""}
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

function renderGrid() {
  const g = $("#grid");
  if (!state.items.length) {
    const job = lastStatus?.job;
    let msg = "Nothing here yet.";
    if (state.view === "recommended" || state.view === "all")
      msg = job?.running ? "Discovering lectures… results appear here as they come in." :
        (state.q ? `No matches in your library. Click <b>Find more online</b> to search for “${esc(state.q)}”.` :
          "Your library is empty. Click <b>Refresh catalog</b> to discover lectures.");
    if (state.view === "progress") msg = "Videos you started but didn't finish show up here.";
    if (state.view === "watched") msg = "Videos you finish (or mark with ✓) show up here.";
    g.innerHTML = `<div class="empty">${msg}</div>`;
  } else {
    g.innerHTML = state.items.map(card).join("");
  }
  $("#moreBtn").classList.toggle("hidden", state.items.length >= state.total);
}

$("#grid").addEventListener("click", async (e) => {
  const actEl = e.target.closest("[data-act]"); if (!actEl) return;
  const id = e.target.closest(".card").dataset.id;
  const v = state.items.find((x) => x.id === id);
  const act = actEl.dataset.act;
  if (act === "play") return openPlayer(v);
  if (act === "ext") { setTimeout(() => toast("Opened on source — tick ✓ when you've watched it"), 300); return; }
  e.preventDefault();
  if (act === "watch") { await setWatched(v, !v.watched); }
  if (act === "hide") { await api("/api/hide", { id, hidden: !v.hidden }); toast(v.hidden ? "Unhidden" : "Hidden from recommendations"); }
  await refreshAll(false);
});

$("#moreBtn").onclick = () => { state.offset += PAGE; load(false); };

async function setWatched(v, watched) {
  await api("/api/watch", { id: v.id, watched });
  v.watched = watched ? 1 : 0;
  toast(watched ? "Marked as watched" : "Marked as unwatched");
}

/* ---------------- facets / sidebar ---------------- */
async function loadFacets() {
  const f = await api("/api/facets");
  loadFacets._f = f;
  $("#cWatched").textContent = f.watched || "";
  $("#cProgress").textContent = f.in_progress || "";
  $("#cHidden").textContent = f.hidden || "";
  renderTree();
  const sel = $("#instSel"), cur = state.institution;
  sel.innerHTML = `<option value="">All institutions</option>` +
    f.institutions.map(([i, n]) => `<option value="${esc(i)}">${esc(i)} (${n})</option>`).join("");
  sel.value = cur;
  const ia = f.sources.archive || 0, yt = f.sources.youtube || 0;
  $("#libStats").textContent = `${f.total} videos in library · ${yt} YouTube · ${ia} Internet Archive`;
}
/* one tree for catalogs (fields) and their topics: a catalog header expands/collapses its
   group (whole button), the "All <catalog>" row inside filters to the whole field, an
   indented topic filters to that topic. All catalogs start collapsed for a clean overview. */
function topicTree(topicCounts, tf, fields, total) {
  const groups = Object.fromEntries(fields.map(([k]) => [k, []]));
  const other = [];
  for (const [t, n] of topicCounts) (groups[tf[t]] || other).push([t, n]);
  let html = `<button data-topic="" data-field="" class="${!state.topic && !state.field ? "active" : ""}">All catalogs <small>${total}</small></button>`;
  for (const [k, label, n] of fields) {
    if (!groups[k].length) continue;
    const open = !!state.open[k];
    html += `<button class="group ${state.field === k && !state.topic ? "active" : ""}" data-toggle="${k}" title="${open ? "Collapse" : "Expand"}">` +
      `<span class="tw">${open ? "▾" : "▸"}</span>${esc(label)} <small>${n}</small></button>`;
    if (open) {
      html += `<button class="sub" data-field="${k}" data-topic="">All ${esc(label)} <small>${n}</small></button>`;
      html += groups[k].map(([t, c]) => `<button class="sub ${state.topic === t ? "active" : ""}" data-topic="${esc(t)}" data-field="">${esc(t)} <small>${c}</small></button>`).join("");
    }
  }
  html += other.map(([t, c]) => `<button class="group other ${state.topic === t ? "active" : ""}" data-topic="${esc(t)}" data-field="">${esc(t)} <small>${c}</small></button>`).join("");
  return html;
}

function renderTree() {
  const f = loadFacets._f; if (!f) return;
  const tree = topicTree(f.topics, f.topic_fields || {}, f.fields || [], f.total);
  if (tree !== renderTree._last) { renderTree._last = tree; $("#topicList").innerHTML = tree; }
  updateCatalogChip();
}

function updateCatalogChip() {
  const f = (loadFacets._f?.fields || []).find(([k]) => k === state.field);
  $("#catalogBtn").textContent = f ? f[1] : "All catalogs";
}
$("#catalogBtn").onclick = () => { // jump to the catalog tree (opens the sidebar on mobile)
  $("#side").classList.add("open");
  $("#topicList").scrollIntoView({ behavior: "smooth", block: "center" });
};

$("#topicList").addEventListener("click", (e) => {
  const g = e.target.closest("[data-toggle]");
  if (g) { const k = g.dataset.toggle; state.open[k] = !state.open[k]; renderTree(); return; }
  const b = e.target.closest("button"); if (!b) return;
  state.topic = b.dataset.topic;
  state.field = b.dataset.field;
  savePrefs(); renderTree(); loadFacets(); load();
});
$("#instSel").onchange = (e) => { state.institution = e.target.value; load(); };
$("#sourceSel").onchange = (e) => { state.source = e.target.value; load(); };
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
$("#webSearchBtn").onclick = async () => {
  const q = $("#q").value.trim();
  if (!q) { $("#q").focus(); return toast("Type a topic first, e.g. “compilers”"); }
  try { const r = await api("/api/search", { q }); toast(r.started ? `Searching online for “${q}”…` : "A search is already running"); pollSoon(); }
  catch (err) { toast(err.message); }
};

/* ---------------- tabs ---------------- */
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]"); if (!b) return;
  [...$("#tabs").children].forEach((x) => x.classList.toggle("active", x === b));
  state.view = b.dataset.view;
  $("#side").classList.toggle("hidden", state.view === "institutions");
  $("#layout").classList.toggle("wide", state.view === "institutions");
  load(); toTop();
});

$("#filtersBtn").onclick = () => $("#side").classList.toggle("open");

/* ---------------- institutions tab ---------------- */
async function renderInstitutions() {
  $("#grid").classList.add("hidden"); $("#moreBtn").classList.add("hidden");
  const [rows, f] = await Promise.all([api("/api/institutions"), api("/api/facets")]);
  const counts = Object.fromEntries(f.institutions);
  rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const t = $("#instTable"); t.classList.remove("hidden");
  t.innerHTML = `<div class="banner"><h3>Institution reputation</h3><p>The “origin” half of the quality score. Adjust any score (0–100); changes apply instantly. Channels that match none of these get the default “unknown” score. To add institutions or channel patterns, edit <code>institutions.json</code> and restart.</p></div>
  <table class="inst-t"><thead><tr><th>Institution</th><th>Score</th><th>Default</th><th>Videos</th><th>Matches channel names like</th><th></th></tr></thead><tbody>
  ${rows.map((r) => `<tr data-name="${esc(r.name)}"><td><b>${esc(r.name)}</b></td>
    <td><input type="number" min="0" max="100" value="${r.score}"></td>
    <td class="${r.score !== r.default ? "mod" : ""}">${r.default}</td><td>${counts[r.name] || 0}</td>
    <td><code>${esc(r.patterns.join("  ·  "))}</code></td>
    <td>${r.score !== r.default ? `<button class="btn ghost" data-reset>Reset</button>` : ""}</td></tr>`).join("")}
  </tbody></table>`;
}
$("#instTable").addEventListener("change", async (e) => {
  const tr = e.target.closest("tr"); if (!tr || e.target.tagName !== "INPUT") return;
  await api("/api/institutions", { name: tr.dataset.name, score: Number(e.target.value) });
  toast(`${tr.dataset.name}: ${e.target.value}`); renderInstitutions();
});
$("#instTable").addEventListener("click", async (e) => {
  if (!e.target.matches("[data-reset]")) return;
  await api("/api/institutions", { name: e.target.closest("tr").dataset.name, score: null });
  renderInstitutions();
});

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
  $("#stage").innerHTML = `<div class="fallback" style="background-image:url('${esc(v.thumbnail)}')"><div>
    <h3>${reason || "This video can't be played here"}</h3>
    <p>The uploader doesn't allow embedded playback. You can still watch it for free on ${host}.</p>
    <div class="row2"><a class="btn" href="${esc(v.url)}" target="_blank" rel="noopener">${ICON.ext} Watch on ${host}</a>
    <button class="btn ghost" id="tryEmbed">Try embedded anyway</button></div></div></div>`;
  $("#tryEmbed").onclick = () => mountPlayer(v, true);
}

async function saveProgress(force) {
  if (!ytPlayer || !current || typeof ytPlayer.getCurrentTime !== "function") return;
  const pos = ytPlayer.getCurrentTime(), len = ytPlayer.getDuration();
  if (!len) return;
  const now = Date.now();
  if (force || now - lastSaved > 10000) {
    lastSaved = now;
    api("/api/progress", { id: current.id, position: pos, length: len }).catch(() => {});
  }
  if (!autoMarked && !current.watched && pos / len >= 0.9) {
    autoMarked = true; current.watched = 1;
    await api("/api/watch", { id: current.id, watched: true });
    updateWatchedBtn(); toast("Marked as watched (90% reached)");
  }
}

async function mountPlayer(v, force = false) {
  stopPlayer();
  autoMarked = false;
  if (v.source === "archive") {
    $("#stage").innerHTML = `<iframe src="${esc(v.embed_url)}" allow="autoplay; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
    return;
  }
  if (!v.embeddable && !force) return showFallback(v);
  $("#stage").innerHTML = `<div id="ytmount"></div>`;
  let YT;
  try { YT = await loadYTApi(); } catch (_) {
    // IFrame API unavailable - plain iframe (no progress tracking)
    $("#stage").innerHTML = `<iframe src="${esc(v.embed_url)}?autoplay=1&rel=0&start=${Math.floor(v.position || 0)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
    return;
  }
  if (current !== v) return; // user switched video while loading
  const start = v.watched ? 0 : Math.max(0, Math.floor((v.position || 0) - 3));
  ytPlayer = new YT.Player("ytmount", {
    videoId: v.source_id, host: "https://www.youtube-nocookie.com",
    playerVars: { autoplay: 1, rel: 0, modestbranding: 1, start, origin: location.origin, playsinline: 1 },
    events: {
      onReady: () => { progTimer = setInterval(() => saveProgress(false), 3000); },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.PAUSED) saveProgress(true);
        if (e.data === YT.PlayerState.ENDED) saveProgress(true);
        if (e.data === YT.PlayerState.PLAYING && !v.embeddable) { v.embeddable = 1; api("/api/embeddable", { id: v.id, ok: true }); }
      },
      onError: (e) => {
        if ([101, 150, 153, 100].includes(e.data)) {
          if (e.data !== 100) api("/api/embeddable", { id: v.id, ok: false }).catch(() => {});
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

async function openPlayer(v) {
  current = v;
  $("#player").classList.remove("hidden");
  $("#player").scrollTop = 0;
  document.body.style.overflow = "hidden";
  $("#pTitle").textContent = v.title;
  $("#pMeta").innerHTML = `<span class="inst ${v.institution ? "" : "unknown"}">${esc(v.institution || "Unverified origin")}</span>
    <span>${esc(v.channel)}</span><span>·</span><span>${views(v)}</span>${v.duration ? `<span>·</span><span>${fmtDur(v.duration)}</span>` : ""}`;
  const w = Math.round(state.weight * 100);
  $("#pScore").innerHTML = `<span>Quality <b>${Math.round(v.quality)}</b></span>
    <span>Origin <b>${v.reputation}</b> × ${w}%</span><span>Popularity <b>${Math.round(v.view_score)}</b> × ${100 - w}%</span>
    ${v.topics.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}`;
  $("#pDesc").textContent = v.description || "";
  const ext = $("#pExternal");
  ext.href = v.url; ext.innerHTML = `${ICON.ext} Open on ${v.source === "archive" ? "archive.org" : "YouTube"}`;
  updateWatchedBtn();
  mountPlayer(v);
  renderUpNext();
}

async function nextCandidates() {
  // 1) the next lectures of the same series/channel (natural title order), 2) top recommendations
  const p = new URLSearchParams({ view: "recommended", known: state.known ? "1" : "0", w: state.weight, limit: 12 });
  const rec = (await api("/api/videos?" + p)).items;
  let series = [];
  if (current.channel) {
    const all = (await api("/api/videos?" + new URLSearchParams({
      view: "all", known: "0", w: state.weight, limit: 500, sort: "title", channel: current.channel }))).items;
    const key = (t) => t.toLowerCase().replace(/\d+/g, (d) => d.padStart(6, "0"));
    const cur = key(current.title);
    series = all.filter((x) => key(x.title) > cur).slice(0, 3);
  }
  const seen = new Set([current.id]);
  return [...series, ...rec].filter((x) => !seen.has(x.id) && !x.watched && seen.add(x.id)).slice(0, 8);
}

async function renderUpNext() {
  const list = await nextCandidates();
  renderUpNext.list = list;
  $("#upnext").innerHTML = list.map((v, i) => `<div class="mini" data-i="${i}">
    <div class="thumb"><div class="ph">${esc(v.institution || "")}</div>${v.thumbnail ? `<img loading="lazy" src="${esc(v.thumbnail)}" alt="" onerror="this.remove()">` : ""}
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
  if (e.key === "Escape") { if (!$("#player").classList.contains("hidden")) closePlayer(); $("#importDlg").classList.add("hidden"); }
  if (e.key === "/" && !e.metaKey && !e.ctrlKey && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || "")) {
    e.preventDefault(); $("#q").focus();
  }
});
$("#pWatched").onclick = async () => { await setWatched(current, !current.watched); updateWatchedBtn(); };
$("#pHide").onclick = async () => { await api("/api/hide", { id: current.id, hidden: true }); toast("Hidden from recommendations"); $("#pNext").click(); };
$("#pNext").onclick = () => { const n = renderUpNext.list?.[0]; if (n) openPlayer(n); else closePlayer(); };
$("#pExternal").addEventListener("click", () => { if (ytPlayer?.pauseVideo) ytPlayer.pauseVideo(); });

/* ---------------- discovery jobs ---------------- */
$("#crawlBtn").onclick = async (e) => {
  const deep = e.shiftKey;
  const r = await api("/api/crawl", { deep });
  toast(r.started ? (deep ? "Deep crawl started (this takes a while)" : "Refreshing catalog…") : "A crawl is already running");
  pollSoon();
};
$("#importBtn").onclick = () => { $("#importDlg").classList.remove("hidden"); $("#importUrl").focus(); };
$("#importDlg").addEventListener("click", (e) => { if (e.target.id === "importDlg" || e.target.matches("[data-close]")) $("#importDlg").classList.add("hidden"); });
$("#importForm").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await api("/api/import", { url: $("#importUrl").value.trim() });
    $("#importDlg").classList.add("hidden"); $("#importUrl").value = "";
    toast(r.started ? "Importing playlist…" : "Another job is running — try again in a moment"); pollSoon();
  } catch (err) { toast(err.message, 4000); }
};

let lastStatus = null, pollT = null;
async function poll() {
  clearTimeout(pollT);
  try {
    const s = await api("/api/status"); lastStatus = s;
    const j = s.job, pill = $("#jobPill");
    pill.classList.toggle("hidden", !j.running);
    $("#crawlBtn").disabled = j.running;
    if (j.running) {
      $("#jobText").textContent = `${j.label}: ${j.done}/${j.total} · +${j.added} new`;
      pill.title = j.current || "";
      if (j.done !== state.lastJobDone) { state.lastJobDone = j.done; if (state.view !== "institutions" && $("#player").classList.contains("hidden")) refreshAll(false); }
    } else if (state.lastJobDone !== -1) {
      state.lastJobDone = -1;
      toast(`${j.label} finished: ${j.added} new videos${j.errors.length ? ` (${j.errors.length} queries failed)` : ""}`, 4500);
      if (j.errors.length) console.warn("Discovery errors:", j.errors);
      refreshAll(false);
    }
    const b = $("#banner");
    if (!s.backend) {
      b.innerHTML = `<h3>YouTube discovery is off</h3><p>Install <code>yt-dlp</code> (<code>pip install yt-dlp</code>) or set a <code>YOUTUBE_API_KEY</code>, then restart. Only Internet Archive is searched right now.</p>`;
      b.classList.remove("hidden");
    } else b.classList.add("hidden");
    pollT = setTimeout(poll, j.running ? 2500 : 15000);
  } catch (_) { pollT = setTimeout(poll, 5000); }
}
const pollSoon = () => setTimeout(poll, 400);

async function refreshAll(reset = true) {
  const keep = state.items.length;
  await loadFacets();
  if (state.view === "institutions") return renderInstitutions();
  if (reset) return load(true);
  // keep the current scroll depth
  const data = await api("/api/videos?" + qs({ offset: 0, limit: Math.max(PAGE, keep) }));
  state.items = data.items; state.total = data.total; renderGrid();
}

/* ---------------- init ---------------- */
$("#weight").value = Math.round(state.weight * 100);
$("#known").checked = state.known;
$("#sort").value = state.sort;
weightHint();
refreshAll(true).then(poll);
