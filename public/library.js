"use strict";

// Library index: every video's basic details, cached in IndexedDB. The first run downloads the
// whole library in pages; later runs only fetch videos changed since the last sync.
// Also holds the suggested-playlists screen and the settings page.
// Loaded after app.js and shares its globals (api, el, card, playlists, settings, ...).

// ---------- Storage ----------
const idb = {
  db: null,
  open() {
    if (!this.db) this.db = new Promise((resolve, reject) => {
      const req = indexedDB.open("gbplayer", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  },
  async get(key) {
    try {
      const db = await this.open();
      return await new Promise((res, rej) => {
        const r = db.transaction("kv").objectStore("kv").get(key);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    } catch { return undefined; }
  },
  async put(key, val) {
    try {
      const db = await this.open();
      await new Promise((res, rej) => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(val, key);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    } catch { /* the cache is optional; we just re-download next time */ }
  },
};

// ---------- Library ----------
const Library = {
  records: [],       // slim records: {i: id, t: title, s: show id, d: publishDate, th, y: youtube id, j: jw id, se: season}
  byId: new Map(),
  complete: false,   // the first full download has finished
  cursor: 0,         // highest id downloaded so far (first download is resumable)
  since: "",         // delta sync asks for anything changed after this
  syncedAt: 0,
  total: 0,
  syncing: false,
  error: "",
};

const SLIM_FIELDS = ["title", "show", "publishDate", "youtubeUrl", "jwMediaIdFree", "thumbnailUrl", "season"];

function slimRecord(v) {
  return {
    i: v.id, t: v.title || "", s: v.show, d: v.publishDate || "",
    th: v.thumbnailUrl || "", y: ytId(v.youtubeUrl) || "", j: v.jwMediaIdFree || "", se: v.season ?? null,
  };
}

function hydrate(r) {
  return {
    id: r.i, title: r.t, show: showsById.get(r.s) || { id: r.s, title: "" }, publishDate: r.d,
    thumbnailUrl: r.th, youtubeUrl: r.y ? "https://www.youtube.com/watch?v=" + r.y : "",
    jwMediaIdFree: r.j, season: r.se,
  };
}

function libraryAudio(r) {
  const s = showsById.get(r.s);
  return (s && s.podcastShow && !s.videoFeed) || /\.mp3$/i.test(r.t);
}

async function libLoad() {
  const saved = await idb.get("library");
  if (saved && Array.isArray(saved.records)) {
    Object.assign(Library, { complete: saved.complete, cursor: saved.cursor, since: saved.since, syncedAt: saved.syncedAt, total: saved.total || saved.records.length });
    Library.records = saved.records;
    Library.byId = new Map(saved.records.map((r) => [r.i, r]));
  }
  renderLibStatus();
}

async function libSave() {
  const { records, complete, cursor, since, syncedAt, total } = Library;
  await idb.put("library", { records, complete, cursor, since, syncedAt, total });
}

function slimParams(extra) {
  const p = { limit: 1000, depth: 0, sort: "id", ...extra };
  for (const f of SLIM_FIELDS) p[`select[${f}]`] = "true";
  return p;
}

// One page of the library, retried with a growing pause when Cloudflare or the network hiccups.
async function fetchPage(extra, tries = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await api("videos", slimParams(extra));
    } catch (e) {
      if (attempt >= tries || !/HTTP (0|403|429|5\d\d)/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

/** Downloads (or resumes downloading) the whole library, or just what changed since the last sync. */
async function libSync({ force = false } = {}) {
  if (Library.syncing) return;
  if (!force && Library.complete && Date.now() - Library.syncedAt < 30 * 60 * 1000) return;
  Library.syncing = true;
  Library.error = "";
  const startedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // overlap a little, to be safe
  try {
    await showsReady;
    if (Library.complete) {
      // Self-heal: if the cache is missing a lot of videos, download the library again.
      const probe = await api("videos", { limit: 1, depth: 0, "select[title]": "true" });
      if (probe.totalDocs - Library.records.length > Math.max(50, probe.totalDocs * 0.01)) {
        Library.complete = false;
        Library.cursor = 0;
      }
    }
    const delta = Library.complete;
    let cursor = delta ? 0 : Library.cursor;
    for (;;) {
      const extra = { "where[id][greater_than]": cursor };
      if (delta) extra["where[updatedAt][greater_than]"] = Library.since;
      const d = await fetchPage(extra);
      Library.total = delta ? Library.total : d.totalDocs || Library.total;
      for (const v of d.docs || []) {
        const r = slimRecord(v);
        const old = Library.byId.get(r.i);
        if (old) Object.assign(old, r);
        else { Library.records.push(r); Library.byId.set(r.i, r); }
        cursor = v.id;
      }
      if (!delta) Library.cursor = cursor;
      renderLibStatus();
      if (!delta) await libSave();
      await new Promise((r) => setTimeout(r, 300)); // be gentle: rapid-fire requests trigger Cloudflare
      // Trust the API's own paging flag: it may return smaller pages than we asked for.
      if (!(d.docs || []).length || !d.hasNextPage) break;
    }
    Library.complete = true;
    Library.since = startedAt;
    Library.syncedAt = Date.now();
    Library.total = Library.records.length;
    Library.retries = 0;
    await libSave();
    if ($("shows-dialog").open) renderShows(); // dates are now available
  } catch (e) {
    Library.error = e.message;
    // An unfinished download picks up where it stopped, a little later.
    Library.retries = (Library.retries || 0) + 1;
    if (!Library.complete && Library.retries <= 6) setTimeout(() => libSync({ force: true }), 15000 * Library.retries);
  } finally {
    Library.syncing = false;
    renderLibStatus();
  }
}

function renderLibStatus() {
  let msg;
  if (Library.syncing && !Library.complete) {
    msg = `Indexing library: ${Library.records.length.toLocaleString()}${Library.total ? " of " + Library.total.toLocaleString() : ""} videos…`;
  } else if (Library.syncing) {
    msg = `Checking for new videos… (${Library.records.length.toLocaleString()} indexed)`;
  } else if (Library.error) {
    const again = !Library.complete && Library.retries <= 6 ? " Retrying shortly." : "";
    msg = `Library sync failed (${Library.records.length.toLocaleString()} videos so far): ${String(Library.error).slice(0, 80)}.${again}`;
  } else if (Library.complete) {
    msg = `${Library.records.length.toLocaleString()} videos indexed. Last checked ${new Date(Library.syncedAt).toLocaleString()}.`;
  } else {
    msg = Library.records.length ? `Partly indexed (${Library.records.length.toLocaleString()} videos).` : "Not indexed yet.";
  }
  for (const id of ["lib-status", "sg-status"]) if ($(id)) $(id).textContent = msg;
}

// Videos for an auto-updating series playlist, straight from the cache (so new episodes just appear).
function seriesVideos(pl) {
  const s = pl.series;
  if (!s) return [];
  const stems = new Set(s.stems);
  const out = [];
  for (const r of Library.records) {
    if (r.s !== s.showId) continue;
    const p = SeriesLib.parse(r.t);
    if (p.num != null && stems.has(p.stem)) out.push(hydrate(r));
  }
  return out;
}

// ---------- Suggested playlists ----------
const dismissed = new Set(JSON.parse(localStorage.getItem("gb_dismissed") || "[]"));
function saveDismissed() { try { localStorage.setItem("gb_dismissed", JSON.stringify([...dismissed])); } catch {} }

function suggestionList() {
  const records = Library.records
    .filter((r) => settings.includeAudio || !libraryAudio(r))
    .map((r) => ({ i: r.i, t: r.t, s: r.s, d: r.d }));
  const have = (playlists || []).filter((p) => p.series);
  return SeriesLib.detect(records).filter((g) =>
    !dismissed.has(g.key) && !have.some((p) => p.series.showId === g.showId && p.series.stems.includes(g.stem)));
}

function renderSuggestions() {
  const list = $("sg-list");
  list.innerHTML = "";
  renderLibStatus();
  const items = suggestionList();
  $("sg-note").textContent = items.length ? `${items.length} suggestions` : (Library.syncing ? "" : "No new suggestions.");
  for (const g of items.slice(0, 60)) {
    const name = el("input", { className: "sg-name", value: g.name });
    const show = showsById.get(g.showId);
    const meta = [show && show.title, `${g.count} episodes (#${g.min}–${g.max})`, g.ongoing ? "ongoing" : "finished"].filter(Boolean).join(" · ");
    const create = el("button", { type: "button", className: "primary", textContent: "Create" });
    const dismiss = el("button", { type: "button", textContent: "Dismiss" });
    create.onclick = async () => {
      playlists.push({
        id: "pl" + Date.now().toString(36), name: name.value.trim() || g.name, rules: [], videos: [],
        order: "asc", auto: true, series: { showId: g.showId, stems: [g.stem] },
      });
      await savePlaylists();
      renderSuggestions();
    };
    dismiss.onclick = () => { dismissed.add(g.key); saveDismissed(); renderSuggestions(); };
    list.append(el("div", { className: "sg-item" }, name, el("div", { className: "muted" }, meta),
      el("div", { className: "sg-actions" }, create, dismiss)));
  }
}

$("sg-btn").onclick = () => { $("sg-dialog").showModal(); renderSuggestions(); libSync(); };
$("sg-close").onclick = () => $("sg-dialog").close();

// ---------- Settings ----------
$("set-btn").onclick = () => {
  $("set-audio").checked = !!settings.includeAudio;
  renderLibStatus();
  $("set-dialog").showModal();
};
$("set-close").onclick = () => $("set-dialog").close();
$("set-audio").onchange = (e) => {
  settings.includeAudio = e.target.checked;
  saveSettings();
  reload();
};
$("set-key").onclick = () => { $("set-dialog").close(); askKey(); };
$("lib-update").onclick = () => libSync({ force: true });
$("lib-rebuild").onclick = async () => {
  if (!confirm("Download the whole library again? It takes a minute or so.")) return;
  Object.assign(Library, { records: [], byId: new Map(), complete: false, cursor: 0, since: "", syncedAt: 0, total: 0 });
  await libSave();
  libSync({ force: true });
};

// ---------- Show picker ----------
const DAY_MS = 86400000;

// Newest video date per show, from the cached library (respecting the audio setting).
function showLastDates() {
  const last = new Map();
  for (const r of Library.records) {
    if (!settings.includeAudio && libraryAudio(r)) continue;
    const t = Date.parse(r.d) || 0;
    if (t > (last.get(r.s) || 0)) last.set(r.s, t);
  }
  return last;
}

function recencyClass(days) {
  if (days <= 7) return "r-hot";
  if (days <= 30) return "r-warm";
  if (days <= 90) return "r-cool";
  if (days <= 365) return "r-old";
  return "r-dead";
}

function ago(days) {
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 14) return `${Math.floor(days)} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 730) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

let showsMode = "pick"; // "pick" chooses a show; "manage" ticks which shows appear in the list

function updateShowButton() {
  const s = showId ? showsById.get(Number(showId)) : null;
  $("show-btn").textContent = (s ? s.title : "All shows") + " ▾";
}

function renderShows() {
  const list = $("shows-list");
  const manage = showsMode !== "pick";
  const key = showsMode === "home" ? "hiddenFromHome" : "hiddenShows";
  const q = $("shows-search").value.trim().toLowerCase();
  const last = showLastDates();
  const hidden = new Set(settings[key]);
  const now = Date.now();
  $("shows-title").textContent = { pick: "Shows", manage: "Manage show list", home: "Home page shows" }[showsMode];
  $("shows-hint").hidden = !manage;
  $("shows-hint").textContent = showsMode === "home"
    ? "Untick a show to leave its videos off the home page. Search and the show picker still find them."
    : "Untick a show to remove it from the show picker. Its videos still appear on the home page.";
  $("shows-manage-bar").hidden = !manage;
  $("shows-sort").value = settings.showSort;
  $("shows-status").textContent = Library.complete ? "" : "Dates fill in once the library has finished indexing.";

  let rows = [...showsById.values()].filter((s) => s.active !== false && (settings.includeAudio || !(s.podcastShow && !s.videoFeed)));
  if (Library.complete) rows = rows.filter((s) => last.has(s.id)); // shows with no videos to speak of
  if (!manage) rows = rows.filter((s) => !hidden.has(s.id));
  if (q) rows = rows.filter((s) => (s.title || "").toLowerCase().includes(q));
  rows.sort(settings.showSort === "name"
    ? (a, b) => (a.title || "").localeCompare(b.title || "")
    : (a, b) => (last.get(b.id) || 0) - (last.get(a.id) || 0) || (a.title || "").localeCompare(b.title || ""));

  list.innerHTML = "";
  const rowFor = (s, isAll) => {
    const t = last.get(s && s.id);
    const days = t ? (now - t) / DAY_MS : null;
    const cls = days == null ? "r-dead" : recencyClass(days);
    const meta = isAll ? "" : t ? `${ago(days)} · ${new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}` : "no date yet";
    const name = isAll ? "All shows" : s.title;
    const body = [el("i", { className: "dot " + (isAll ? "" : cls) }), el("span", { className: "name" }, name), el("span", { className: "meta " + (t ? cls + "-text" : "") }, meta)];
    if (manage) {
      const box = el("input", { type: "checkbox", checked: !hidden.has(s.id) });
      box.onchange = () => {
        const set = new Set(settings[key]);
        if (box.checked) set.delete(s.id); else set.add(s.id);
        settings[key] = [...set];
        saveSettings();
        row.classList.toggle("hidden-show", !box.checked);
        if (showsMode === "home") homeDirty = true;
        else if (!box.checked && String(s.id) === String(showId)) { showId = ""; updateShowButton(); reload(); }
      };
      var row = el("label", { className: "show-row" + (hidden.has(s.id) ? " hidden-show" : "") }, box, ...body);
      return row;
    }
    const btn = el("button", { type: "button", className: "show-row" + ((isAll ? !showId : String(s.id) === String(showId)) ? " selected" : "") }, ...body);
    btn.onclick = () => {
      showId = isAll ? "" : String(s.id);
      updateShowButton();
      $("shows-dialog").close();
      activePl = ""; $("playlist-select").value = "";
      $("pl-continue").hidden = true; $("pl-sort").hidden = true;
      reload();
    };
    return btn;
  };
  if (!manage && !q) list.append(rowFor(null, true));
  for (const s of rows) list.append(rowFor(s, false));
  if (!rows.length) list.append(el("p", { className: "muted", style: "padding:10px 12px;margin:0" }, q ? "No shows match." : "No shows to list."));
}

function openShows(mode) {
  showsMode = mode;
  $("shows-search").value = "";
  if (!$("shows-dialog").open) $("shows-dialog").showModal();
  renderShows();
}
let homeDirty = false; // the home-page list changed, so the feed needs refreshing when the dialog closes
$("show-btn").onclick = () => openShows("pick");
$("set-shows").onclick = () => { $("set-dialog").close(); openShows("manage"); };
$("set-home").onclick = () => { $("set-dialog").close(); openShows("home"); };
function finishShows() {
  if (homeDirty) { homeDirty = false; reload(); }
}
$("shows-close").onclick = () => { $("shows-dialog").close(); finishShows(); };
$("shows-dialog").addEventListener("close", finishShows); // Esc / tapping outside
$("shows-search").oninput = renderShows;
$("shows-sort").onchange = (e) => { settings.showSort = e.target.value; saveSettings(); renderShows(); };
$("shows-hide-old").onclick = () => {
  const last = showLastDates();
  const cutoff = Date.now() - 365 * DAY_MS;
  const key = showsMode === "home" ? "hiddenFromHome" : "hiddenShows";
  const set = new Set(settings[key]);
  for (const s of showsById.values()) if ((last.get(s.id) || 0) < cutoff) set.add(s.id);
  settings[key] = [...set];
  if (showsMode === "home") homeDirty = true;
  saveSettings();
  renderShows();
};
$("shows-show-all").onclick = () => {
  settings[showsMode === "home" ? "hiddenFromHome" : "hiddenShows"] = [];
  if (showsMode === "home") homeDirty = true;
  saveSettings();
  renderShows();
};
updateShowButton();

// ---------- Start ----------
libLoad().then(() => libSync());
