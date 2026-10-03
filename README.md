# Bomba Gigante Player

A personal video player for [Giant Bomb](https://www.giantbomb.com). It runs in a desktop browser (served by a small
local Python server) and as an Android app (a WebView wrapper around the same web app).

Not affiliated with Giant Bomb. You supply your own API key at runtime; it is stored only on your device.

## Features

- Browse, search and filter by show. The show picker is colour-coded by how recently each show posted.
- Plays free videos (YouTube or JW Player streams) and premium videos when you enter your API key.
- Remembers where you stopped in each video, with a button to jump back to your furthest point.
- Playlists built from title rules, plus **suggested playlists**: numbered series are detected automatically
  (including renamed series) and auto-update as new episodes appear.
- A cached index of the whole library, downloaded once and then refreshed with small delta updates.
- Settings: include/exclude audio-only content (hidden by default), choose which shows appear in the picker,
  and which shows' videos appear on the home page.

## Run in a browser

```
pip install -r requirements.txt
python server.py
```

Then open http://localhost:8765 and add your API key with the button in the header.

`curl_cffi` is used because Cloudflare blocks plain HTTP clients. The server also adds the CORS handling the API
lacks, and stores `playlists.json` and `progress.json` next to the script (both ignored by git).

## Android app

The Android project in `android/` bundles the contents of `public/` and makes API calls from a hidden WebView on
giantbomb.com, which is a real Chromium and so passes Cloudflare. Playlists, progress and the library cache live in
the app's own storage.

`build-apk.ps1` builds a debug APK using a JDK 17, Gradle 8.7 and the Android SDK (platform 34, build-tools 34.0.0)
placed under `android-tools/` (`jdk/`, `gradle-8.7/`, `sdk/`). Each build gets an incrementing build number, shown
under the logo in the app. To also copy the APK somewhere (for example a synced folder), put that folder's path in
a file named `apk-output-dir.txt`.

## Layout

| Path | What it is |
|---|---|
| `public/app.js` | Browsing, playback, playlists, progress, settings plumbing |
| `public/library.js` | Library index and delta sync, suggestions screen, settings, show picker |
| `public/series.js` | Series detection from titles |
| `server.py` | Local server and API proxy for the browser version |
| `android/` | Android wrapper (WebView, API bridge) |
