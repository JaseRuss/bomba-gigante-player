"use strict";

const $ = (id) => document.getElementById(id);
const PAGE = 24;
const KEY_STORE = "gb_api_key";

let apiKey = "";
try { apiKey = localStorage.getItem(KEY_STORE) || ""; } catch {}

// Settings page values. Audio-only content (podcasts, .mp3 episodes) is hidden unless switched on.
// hiddenShows: show ids removed from the show list (they still appear in Browse all and search).
// hiddenFromHome: show ids whose videos are left out of the home page feed (Browse all).
let settings = { includeAudio: false, hiddenShows: [], hiddenFromHome: [], showSort: "recent", hideWatched: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem("gb_settings") || "{}")); } catch {}
function saveSettings() { try { localStorage.setItem("gb_settings", JSON.stringify(settings)); } catch {} }
const showsById = new Map();

let page = 1;
let hasNext = false;
let query = "";
let showId = "";
let typeFilter = "";
let hls = null;
let current = null;
let needsKey = false; // the current video had no playable source
let playlists = [];
let activePl = "";
let plVideos = [];

// ---------- Platform layer ----------
// In the Android app, window.GBNative exists: API calls go through a hidden WebView on
// giantbomb.com (real Chromium, so Cloudflare lets it through) and data lives in localStorage.
// In a desktop browser, the same calls go to the local Python server instead.
const NATIVE = typeof window.GBNative !== "undefined";
const API_ORIGIN = "https://giantbomb.com";

const nativePending = new Map();
let nativeSeq = 0;
window.__gbDone = (id, status, body) => {
  const done = nativePending.get(id);
  if (done) { nativePending.delete(id); done({ status, body }); }
};
function nativeFetch(pathAndQuery) {
  return new Promise((resolve) => {
    const id = String(++nativeSeq);
    const timer = setTimeout(() => { nativePending.delete(id); resolve({ status: 0, body: "Timed out waiting for Giant Bomb" }); }, 60000);
    nativePending.set(id, (r) => { clearTimeout(timer); resolve(r); });
    GBNative.fetch(id, pathAndQuery, apiKey);
  });
}

const store = {
  async get(name, empty) {
    if (NATIVE) { try { return JSON.parse(localStorage.getItem("gb_store_" + name)) ?? empty; } catch { return empty; } }
    try { return await (await fetch("/" + name)).json(); } catch { return empty; }
  },
  async put(name, data) {
    if (NATIVE) { try { localStorage.setItem("gb_store_" + name, JSON.stringify(data)); } catch {} return; }
    await fetch("/" + name, { method: "PUT", body: JSON.stringify(data), keepalive: true });
  },
};

// Which build is running (the Android build number, or "web" in a browser).
try { $("ver").textContent = NATIVE ? "build " + String(GBNative.version()).split(".").pop() : "web"; } catch {}

// ---------- API ----------
async function api(path, params = {}) {
  const qs = new URLSearchParams(params);
  let status, text;
  if (NATIVE) {
    ({ status, body: text } = await nativeFetch(`${path}?${qs}`));
  } else {
    if (apiKey) qs.set("api_key", apiKey);
    const res = await fetch(`/api/${path}?${qs}`);
    status = res.status;
    text = await res.text();
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`HTTP ${status}: ${String(text).slice(0, 120)}`); }
  if (status < 200 || status >= 300) throw new Error(data.errors?.[0]?.message || data.message || data.error || `HTTP ${status}`);
  return data;
}

// ---------- Key handling ----------
function updateKeyButton() {
  $("key-btn").textContent = apiKey ? "API key ✓" : "Add API key";
  $("key-btn").classList.toggle("primary", !apiKey);
  $("key-banner").hidden = !!apiKey;
}
let pendingPlay = 0; // a locked video the user clicked; played once a key is saved
function applyHideLocked() {
  let on = false;
  try { on = localStorage.getItem("gb_hide_locked") === "1"; } catch {}
  $("hide-locked").checked = on;
  $("grid").classList.toggle("hide-locked", on);
}
$("hide-locked").onchange = (e) => {
  try { localStorage.setItem("gb_hide_locked", e.target.checked ? "1" : "0"); } catch {}
  $("grid").classList.toggle("hide-locked", e.target.checked);
};
$("banner-key").onclick = () => askKey();
function askKey() {
  $("key-input").value = apiKey;
  $("key-remember").checked = apiKey ? !!localStorage.getItem(KEY_STORE) : true;
  if (!$("key-dialog").open) $("key-dialog").showModal();
}
$("key-btn").onclick = askKey;
$("key-form").addEventListener("submit", () => {
  apiKey = $("key-input").value.trim();
  try {
    if ($("key-remember").checked) localStorage.setItem(KEY_STORE, apiKey);
    else localStorage.removeItem(KEY_STORE);
  } catch {}
  updateKeyButton();
  reload();
  if (pendingPlay) { play(pendingPlay); pendingPlay = 0; }
  else if (current && needsKey) play(current.id); // retry the video that needed the key
});
$("key-forget").onclick = () => {
  apiKey = "";
  try { localStorage.removeItem(KEY_STORE); } catch {}
  updateKeyButton();
  $("key-dialog").close();
};
updateKeyButton();
applyHideLocked();

// ---------- Helpers ----------
function setStatus(msg) { $("status").textContent = msg; }
function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
}
function imgUrl(v) { const u = v.thumbnailUrl || ""; return NATIVE && u.startsWith("/") ? API_ORIGIN + u : u; }
function ytId(url) {
  const m = /[?&]v=([\w-]{11})|youtu\.be\/([\w-]{11})|youtube\.com\/(?:live|shorts|embed|v)\/([\w-]{11})/.exec(url || "");
  return m && (m[1] || m[2] || m[3]);
}
// Watch progress: kept in memory, flushed to progress.json on the server.
let progress = {};
let progressDirty = false;
function getProgress(id) { return progress[id] || null; }
// "Finished" = within the last 10 seconds, which is also how saveProgress records a completed video.
function isCompleted(id) {
  const p = progress[id];
  return !!(p && p.d && p.t >= p.d - 10);
}
// When a video finishes, take its card off the home feed straight away (if that setting is on).
function hideFinishedCard(id) {
  if (!settings.hideWatched || showId || query || activePl) return;
  const card = $("grid").querySelector(`.card[data-id="${id}"]`);
  if (card) card.remove();
}
function saveProgress(id, t, d) {
  if (!id || !(t >= 0)) return;
  if (d && t >= d - 10) { progress[id] = { t: d, d, m: d, at: Date.now() }; progressDirty = true; hideFinishedCard(id); return; }
  // m = furthest point reached, so you can jump back after scrubbing around.
  progress[id] = { t, d: d || 0, m: Math.max(t, (progress[id] && progress[id].m) || 0), at: Date.now() };
  progressDirty = true;
}
function resumeAt(id) {
  const p = getProgress(id);
  return p && p.d && p.t > 5 && p.t < p.d - 10 ? p.t : 0;
}
async function flushProgress() {
  flushCurrent();
  if (!progressDirty) return;
  progressDirty = false;
  try { await store.put("progress", progress); }
  catch { progressDirty = true; }
}
async function loadProgress() {
  progress = await store.get("progress", {});
  // One-time import of positions saved by the earlier localStorage version.
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k.startsWith("gb_pos_")) continue;
      const id = k.slice(7), old = JSON.parse(localStorage.getItem(k));
      if (!progress[id] && old) { progress[id] = { t: old.t, d: old.d, at: 0 }; progressDirty = true; }
    }
  } catch {}
  flushProgress();
}
setInterval(flushProgress, 10000);
addEventListener("pagehide", flushProgress);
document.addEventListener("visibilitychange", () => { if (document.hidden) flushProgress(); });
function fmtTime(s) {
  s = Math.round(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(sec).padStart(2, "0");
}

// ---------- Listing ----------
async function loadShows() {
  // Retried (Cloudflare occasionally challenges a request), with the last good list kept as a fallback.
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const d = await api("shows", { limit: 200, sort: "title", depth: 0 });
      for (const s of d.docs || []) showsById.set(s.id, s);
      try { localStorage.setItem("gb_shows", JSON.stringify(d.docs || [])); } catch {}
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  try { for (const s of JSON.parse(localStorage.getItem("gb_shows") || "[]")) showsById.set(s.id, s); } catch {}
}

async function reload() {
  page = 1;
  $("grid").innerHTML = "";
  await loadMore();
}

async function loadMore() {
  if (activePl) return loadPlaylist();
  setStatus("Loading…");
  $("more").hidden = true;
  try {
    const params = { limit: PAGE, page, sort: "-publishDate", depth: 1 };
    if (showId) params["where[show][equals]"] = showId;
    if (query) params["where[title][like]"] = query;
    typeFilter = settings.includeAudio ? "" : "video";
    if (typeFilter === "podcast") params["where[show.podcastShow][equals]"] = "true";
    if (typeFilter === "video") {
      params["where[or][0][show.podcastShow][not_equals]"] = "true";
      params["where[or][1][show.videoFeed][equals]"] = "true";
    }
    // Shows hidden from the home page only apply to the plain feed: not when a show is picked or a search is typed.
    const homeFeed = !showId && !query;
    const homeHidden = homeFeed ? new Set(settings.hiddenFromHome) : null;
    let added = 0;
    // Filtering happens here, so keep fetching pages until there's a decent number of cards to show.
    for (let tries = 0; tries < 8; tries++) {
      const d = await api("videos", { ...params, page });
      for (const v of d.docs || []) {
        // The server-side filter drops podcast-only shows; this also drops stray audio-only (.mp3) episodes.
        if (!settings.includeAudio && isAudio(v)) continue;
        if (homeHidden && homeHidden.has(v.show?.id)) continue;
        if (homeFeed && settings.hideWatched && isCompleted(v.id)) continue;
        $("grid").append(card(v));
        added++;
      }
      hasNext = !!d.hasNextPage;
      page++;
      if (added >= 12 || !hasNext) break;
    }
    setStatus($("grid").children.length ? "" : "No videos found.");
    $("more").hidden = !hasNext;
  } catch (e) {
    setStatus("Error: " + e.message);
  }
}

// Without a key, a video with no public source (no YouTube link, no free stream) can't be played.
function isLocked(v) {
  return !apiKey && !v.youtubeUrl && !v.jwMediaIdFree;
}

function isAudio(v) {
  return (v.show?.podcastShow && !v.show?.videoFeed) || /\.mp3$/i.test(v.title || "");
}

function card(v) {
  const p = getProgress(v.id);
  const thumb = el("div", { className: "thumb" }, el("img", { src: imgUrl(v), loading: "lazy", alt: "" }));
  if (isAudio(v)) thumb.append(el("span", { className: "badge audio" }, "AUDIO"));
  if (v.show?.isPremium) thumb.append(el("span", { className: "badge" }, "PREMIUM"));
  if (p && p.d) thumb.append(el("div", { className: "progress", style: `width:${Math.min(100, p.t / p.d * 100)}%` }));
  const sub = [v.show?.title, v.publishDate?.slice(0, 10)].filter(Boolean).join(" · ");
  const c = el("button", { className: "card", type: "button" }, thumb,
    el("div", { className: "body" }, el("h3", {}, v.title || "Untitled"), el("p", {}, sub)));
  c.dataset.id = v.id;
  if (isLocked(v)) {
    c.classList.add("locked");
    thumb.append(el("span", { className: "badge key" }, "KEY NEEDED"));
  }
  c.onclick = () => {
    if (isLocked(v)) {
      pendingPlay = v.id;
      setStatus("This video needs your API key. Enter it and it will start.");
      askKey();
    } else {
      play(v.id);
    }
  };
  return c;
}

// ---------- Playback ----------
async function jwSources(mediaId) {
  const r = await fetch(`https://cdn.jwplayer.com/v2/media/${encodeURIComponent(mediaId)}`);
  if (!r.ok) throw new Error("JW Player HTTP " + r.status);
  const d = await r.json();
  const srcs = (d.playlist?.[0]?.sources || []).filter((s) => s.type !== "application/vnd.apple.mpegurl" || s.file);
  return srcs.map((s) => ({
    label: s.label || (s.type?.includes("mpegurl") ? "Auto (HLS)" : s.type || "source"),
    url: s.file, hls: /mpegurl/.test(s.type || "") || /\.m3u8/.test(s.file),
    h: s.height || 0,
  })).sort((a, b) => b.h - a.h);
}

function findMediaUrls(obj, depth = 0, out = new Set()) {
  if (depth > 4 || obj == null) return [...out];
  if (typeof obj === "string") {
    if (/^https?:\/\/\S+\.(m3u8|mp4|m4a|webm)(\?\S*)?$/i.test(obj)) out.add(obj);
  } else if (typeof obj === "object") {
    for (const val of Object.values(obj)) findMediaUrls(val, depth + 1, out);
  }
  return [...out];
}

function attach(src, startAt, autoplay = true) {
  const video = $("player");
  $("yt-wrap").hidden = true;
  if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo();
  video.hidden = false;
  if (hls) { hls.destroy(); hls = null; }
  const seek = () => { if (startAt) video.currentTime = startAt; };
  if (src.hls && window.Hls && Hls.isSupported() && (NATIVE || !video.canPlayType("application/vnd.apple.mpegurl"))) {
    hls = new Hls();
    hls.loadSource(src.url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, seek);
  } else {
    video.src = src.url;
    video.addEventListener("loadedmetadata", seek, { once: true });
  }
  if (autoplay) video.play().catch(() => {});
}

let ytPlayer = null;
let ytApi = null;
function loadYouTubeApi() {
  if (!ytApi) ytApi = new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = resolve;
    document.head.append(el("script", { src: "https://www.youtube.com/iframe_api", onerror: () => { ytApi = null; reject(new Error("YouTube API blocked")); } }));
  });
  return ytApi;
}
function ytState() { return ytPlayer && ytPlayer.getPlayerState ? ytPlayer.getPlayerState() : -1; }

async function embedYouTube(id, startAt, autoplay = true) {
  $("player").pause(); $("player").hidden = true;
  $("yt-wrap").hidden = false;
  await loadYouTubeApi();
  if (ytPlayer) {
    const opts = { videoId: id, startSeconds: startAt || 0 };
    if (autoplay) ytPlayer.loadVideoById(opts); else ytPlayer.cueVideoById(opts);
    return;
  }
  ytPlayer = new YT.Player("yt", {
    host: "https://www.youtube-nocookie.com", videoId: id,
    playerVars: { autoplay: autoplay ? 1 : 0, start: Math.floor(startAt || 0), rel: 0, playsinline: 1 },
    events: {
      onStateChange: (e) => {
        if (e.data === 0 && current) { saveProgress(current.id, ytPlayer.getDuration(), ytPlayer.getDuration()); playNext(); }
        if (e.data === 2) flushCurrent();
      },
    },
  });
}

// Capture the position of whatever is playing right now.
function flushCurrent() {
  if (!current) return;
  if (!$("yt-wrap").hidden && ytPlayer && ytPlayer.getCurrentTime) {
    if (ytState() >= 0) saveProgress(current.id, ytPlayer.getCurrentTime(), ytPlayer.getDuration());
  } else if (!$("player").hidden && $("player").currentTime > 0 && $("player").duration) {
    saveProgress(current.id, $("player").currentTime, $("player").duration);
  }
}

function position() {
  if (!$("yt-wrap").hidden && ytPlayer && ytPlayer.getCurrentTime) return ytPlayer.getCurrentTime();
  return $("player").hidden ? 0 : $("player").currentTime;
}

function updateJump() {
  const p = current && getProgress(current.id);
  const btn = $("jump-btn");
  const show = p && p.m && p.d && p.m < p.d - 10 && p.m > position() + 30;
  btn.hidden = !show;
  if (show) btn.textContent = "Jump to " + fmtTime(p.m);
}
$("jump-btn").onclick = () => {
  const p = current && getProgress(current.id);
  if (!p) return;
  if (!$("yt-wrap").hidden && ytPlayer) ytPlayer.seekTo(p.m, true);
  else $("player").currentTime = p.m;
  updateJump();
};
setInterval(updateJump, 2000);

function playNext() {
  if (!activePl || !current) return;
  const i = plVideos.findIndex((v) => v.id === current.id);
  if (i >= 0 && plVideos[i + 1]) play(plVideos[i + 1].id);
}

// opts.restore: reopening the app on the last video, so don't autoplay, nag for a key, or show errors.
async function play(id, opts = {}) {
  flushCurrent();
  // Stop whatever was playing so a video with no source doesn't leave the old one running.
  $("player").pause();
  if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo();
  setStatus("Loading video…");
  let v;
  try { v = await api(`videos/${id}`, { depth: 1 }); }
  catch (e) { setStatus(opts.restore ? "" : "Error: " + e.message); return; }
  try { localStorage.setItem("gb_last", String(id)); } catch {}
  current = v;
  needsKey = false;
  $("player-section").hidden = false;
  $("video-title").textContent = v.title || "";
  $("video-info").textContent = [v.show?.title, v.publishDate?.slice(0, 10)].filter(Boolean).join(" · ");
  $("video-deck").textContent = v.description || "";
  $("raw").textContent = JSON.stringify(v, null, 2);
  window.scrollTo({ top: 0, behavior: "smooth" });

  const q = $("quality");
  q.innerHTML = "";
  let srcs = [];
  // Any field that looks like a JW Player media id (free first, then others a key may unlock).
  const jwIds = Object.entries(v).filter(([k, val]) => /^jwMediaId/i.test(k) && typeof val === "string" && val);
  for (const [, mid] of jwIds) {
    try { srcs = srcs.concat(await jwSources(mid)); } catch (e) { setStatus("JW Player: " + e.message); }
  }
  // Also accept direct media URLs anywhere in the response (a key may unlock fields I haven't seen).
  for (const u of findMediaUrls(v)) {
    const hlsUrl = /\.m3u8/i.test(u);
    srcs.push({ label: hlsUrl ? "Auto (HLS)" : "Direct file", url: u, hls: hlsUrl, h: hlsUrl ? 0 : 1 });
  }
  if (srcs.length) {
    setStatus("");
    srcs.forEach((s, i) => q.append(new Option(s.label, i)));
    // Desktop prefers adaptive HLS. Android's WebView is unreliable with HLS, so use the 720p MP4 there.
    const mp4 = srcs.findIndex((s) => !s.hls && s.h && s.h <= 720);
    const pref = NATIVE && mp4 >= 0 ? mp4 : Math.max(0, srcs.findIndex((s) => s.hls));
    q.value = pref;
    attach(srcs[pref], resumeAt(v.id), !opts.restore);
    q.onchange = () => attach(srcs[q.value], $("player").currentTime);
    return;
  }
  const yt = ytId(v.youtubeUrl);
  if (yt) {
    setStatus(""); q.append(new Option("YouTube", 0));
    try { await embedYouTube(yt, resumeAt(v.id), !opts.restore); } catch (e) { setStatus("Error: " + e.message); }
    return;
  }
  // Nothing to play: clear both players so the previous video doesn't linger.
  needsKey = true;
  $("player").pause();
  $("player").removeAttribute("src");
  $("player").load();
  $("player").hidden = true;
  $("yt-wrap").hidden = true;
  q.append(new Option("No source", 0));
  setStatus(apiKey
    ? "No playable source came back for this video, even with your key. Open “Raw data” below to see which fields were returned."
    : "This video needs your API key to play. Enter it and it will start.");
  if (opts.restore) { $("player-section").hidden = true; setStatus(""); }
  else if (!apiKey) askKey();
}

let lastSave = 0;
$("player").addEventListener("timeupdate", (e) => {
  if (!current || Date.now() - lastSave < 5000) return;
  lastSave = Date.now();
  saveProgress(current.id, e.target.currentTime, e.target.duration);
});
$("player").addEventListener("pause", flushCurrent);
setInterval(() => { if (ytState() === 1) flushCurrent(); }, 5000);

// --- Media controls (S Pen button, headset/Bluetooth keys, notification shade) ---
// The S Pen button and other hardware media keys arrive as play/pause commands. The Android shell
// forwards them to __gbMedia; navigator.mediaSession covers keys Chromium handles itself.
function mediaPlaying() {
  if (!$("yt-wrap").hidden && ytPlayer) return ytState() === 1;
  return !$("player").hidden && !$("player").paused && !$("player").ended;
}
function mediaAct(action) {
  const yt = !$("yt-wrap").hidden && ytPlayer && ytPlayer.playVideo;
  const v = $("player");
  if (action === "toggle") action = mediaPlaying() ? "pause" : "play";
  if (action === "play") { if (yt) ytPlayer.playVideo(); else if (!v.hidden) v.play().catch(() => {}); }
  else if (action === "pause") { if (yt) ytPlayer.pauseVideo(); else v.pause(); }
  else if (action === "next") playNext();
}
window.__gbMedia = mediaAct;
let lastPlaying = null;
function reportPlaying() {
  const on = mediaPlaying();
  if (on === lastPlaying) return;
  lastPlaying = on;
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = on ? "playing" : "paused";
  if (NATIVE && GBNative.setPlaying) { try { GBNative.setPlaying(on); } catch {} }
}
if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => mediaAct("play"));
  navigator.mediaSession.setActionHandler("pause", () => mediaAct("pause"));
  try { navigator.mediaSession.setActionHandler("nexttrack", () => mediaAct("next")); } catch {}
}
for (const ev of ["play", "playing", "pause", "ended", "emptied"]) $("player").addEventListener(ev, reportPlaying);
setInterval(reportPlaying, 1000);
$("player").addEventListener("error", (e) => {
  const err = e.target.error;
  const src = (e.target.currentSrc || "").replace(/[?#].*/, "").split("/").pop();
  setStatus(`Playback failed (${err ? "code " + err.code + (err.message ? ": " + err.message : "") : "unknown"}) for ${src || "this source"}.`);
});

// ---------- Wiring ----------
$("search-form").addEventListener("submit", (e) => { e.preventDefault(); query = $("search").value.trim(); reload(); });
$("more").onclick = loadMore;

const showsReady = loadShows();
loadProgress().then(() => { reload(); return restoreLast(); });

// Reopening the app: go back to the last video you watched, unless you finished it.
async function restoreLast() {
  let id = 0;
  try { id = Number(localStorage.getItem("gb_last")) || 0; } catch {}
  if (id && !isCompleted(id)) await play(id, { restore: true });
}

// The app name in the header: back to the home screen with every filter cleared.
function goHome() {
  flushCurrent();
  $("player").pause();
  if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo();
  $("player-section").hidden = true;
  current = null;
  showId = ""; query = ""; activePl = "";
  $("search").value = "";
  $("playlist-select").value = "";
  $("pl-continue").hidden = true;
  $("pl-sort").hidden = true;
  updateShowButton();
  window.scrollTo({ top: 0 });
  reload();
}
$("home-link").onclick = goHome;
$("home-link").onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goHome(); } };

// ---------- Playlists ----------
async function loadPlaylists() {
  playlists = await store.get("playlists", []);
  refreshPlaylistUi();
}
async function savePlaylists() {
  await store.put("playlists", playlists);
  refreshPlaylistUi();
}
function refreshPlaylistUi() {
  for (const id of ["playlist-select", "add-to"]) {
    const sel = $(id), keep = sel.value;
    sel.length = id === "playlist-select" ? 1 : 0;
    for (const p of playlists) sel.append(new Option(p.name, p.id));
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }
  $("add-row").hidden = !playlists.length;
  $("playlist-select").hidden = !playlists.length; // nothing to pick until a playlist exists
}

async function loadPlaylist() {
  const pl = playlists.find((p) => p.id === activePl);
  $("more").hidden = true;
  if (!pl) return;
  setStatus("Loading playlist…");
  const found = new Map();
  try {
    // Auto-updating series playlists read the library cache, so new episodes appear by themselves.
    if (pl.series) {
      await showsReady;
      for (const v of seriesVideos(pl)) found.set(v.id, v);
    }
    for (const rule of pl.rules || []) {
      for (let pg = 1; pg <= 5; pg++) {
        const d = await api("videos", { limit: 100, page: pg, depth: 1, "where[title][like]": rule });
        for (const v of d.docs || []) found.set(v.id, v);
        if (!d.hasNextPage) break;
      }
    }
    const manual = (pl.videos || []).map((v) => v.id).filter((id) => !found.has(id));
    if (manual.length) {
      const d = await api("videos", { limit: 100, depth: 1, "where[id][in]": manual.join(",") });
      for (const v of d.docs || []) found.set(v.id, v);
    }
    plVideos = sortPlaylist(pl, [...found.values()].filter((v) => settings.includeAudio || !isAudio(v)));
    $("grid").innerHTML = "";
    for (const v of plVideos) $("grid").append(card(v, true));
    const indexing = pl.series && Library.syncing && !Library.complete ? " (library is still indexing)" : "";
    setStatus(plVideos.length ? `${plVideos.length} videos in “${pl.name}”${indexing}` : "No videos match this playlist yet" + indexing + ".");
  } catch (e) {
    setStatus("Error: " + e.message);
  }
}

// Series playlists order by episode number; ordinary ones by publish date.
function sortPlaylist(pl, list) {
  const dir = pl.order === "desc" ? -1 : 1;
  const num = (v) => (pl.series ? SeriesLib.parse(v.title).num ?? 0 : 0);
  const when = (v) => new Date(v.publishDate).getTime() || 0;
  return list.sort((a, b) => dir * (num(a) - num(b)) || dir * (when(a) - when(b)));
}

$("pl-continue").onclick = () => {
  const unfinished = plVideos.find((v) => {
    const p = getProgress(v.id);
    return !(p && p.d && p.t >= p.d - 10);
  });
  const next = unfinished || plVideos[0];
  if (next) play(next.id);
};

$("playlist-select").onchange = (e) => {
  activePl = e.target.value;
  const pl = playlists.find((p) => p.id === activePl);
  $("pl-continue").hidden = !pl;
  $("pl-sort").hidden = !pl;
  if (pl) $("pl-sort").value = pl.order || "asc";
  reload();
};
$("pl-sort").onchange = async (e) => {
  const pl = playlists.find((p) => p.id === activePl);
  if (!pl) return;
  pl.order = e.target.value;
  sortPlaylist(pl, plVideos);
  $("grid").innerHTML = "";
  for (const v of plVideos) $("grid").append(card(v));
  await savePlaylists();
};
$("add-btn").onclick = async () => {
  const pl = playlists.find((p) => p.id === $("add-to").value);
  if (!pl || !current) return;
  pl.videos = pl.videos || [];
  if (!pl.videos.some((v) => v.id === current.id)) pl.videos.push({ id: current.id, title: current.title });
  await savePlaylists();
  setStatus(`Added to “${pl.name}”.`);
  if (activePl === pl.id) reload();
};
$("player").addEventListener("ended", (e) => {
  if (current) saveProgress(current.id, e.target.duration, e.target.duration);
  playNext();
});

// Editor dialog
let editing = null;
function openEditor(id) {
  $("pl-dialog").open || $("pl-dialog").showModal();
  editing = playlists.find((p) => p.id === id) || null;
  $("pl-pick").length = 0;
  for (const p of playlists) $("pl-pick").append(new Option(p.name, p.id));
  if (editing) $("pl-pick").value = editing.id;
  $("pl-name").value = editing?.name || "";
  const auto = !!editing?.series;
  $("pl-rules").hidden = auto;
  $("pl-rules-label").textContent = auto
    ? "Auto-updating series: new episodes are added automatically, in episode order."
    : "Title rules, one per line. Any video whose title contains a line is included.";
  $("pl-rules").value = (editing?.rules || []).join("\n");
  $("pl-order").value = editing?.order || "asc";
  const ul = $("pl-manual");
  ul.innerHTML = "";
  for (const v of editing?.videos || []) {
    const rm = el("button", { type: "button", textContent: "×" });
    rm.onclick = () => { editing.videos = editing.videos.filter((x) => x.id !== v.id); openEditor(editing.id); };
    ul.append(el("li", {}, el("span", {}, v.title || "#" + v.id), rm));
  }
}
$("pl-btn").onclick = () => openEditor(activePl || playlists[0]?.id);
$("pl-pick").onchange = (e) => openEditor(e.target.value);
$("pl-new").onclick = () => {
  const p = { id: "pl" + Date.now().toString(36), name: "New playlist", rules: [], videos: [], order: "asc" };
  playlists.push(p);
  openEditor(p.id);
};
$("pl-save").onclick = async () => {
  if (!editing) return;
  editing.name = $("pl-name").value.trim() || "Untitled";
  if (!editing.series) editing.rules = $("pl-rules").value.split("\n").map((x) => x.trim()).filter(Boolean);
  editing.order = $("pl-order").value;
  await savePlaylists();
  if (activePl === editing.id) reload();
  openEditor(editing.id);
};
$("pl-delete").onclick = async () => {
  if (!editing || !confirm(`Delete “${editing.name}”?`)) return;
  playlists = playlists.filter((p) => p !== editing);
  if (activePl === editing.id) { activePl = ""; $("playlist-select").value = ""; reload(); }
  await savePlaylists();
  playlists.length ? openEditor(playlists[0].id) : $("pl-dialog").close();
};
$("pl-close").onclick = () => $("pl-dialog").close();

loadPlaylists();
