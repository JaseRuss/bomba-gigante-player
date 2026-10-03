"""Local server for the Giant Bomb video player.

Serves ./public and proxies /api/* to giantbomb.com/api/ using curl_cffi
(Chrome TLS impersonation), because Cloudflare blocks plain HTTP clients and
the API sends no CORS headers. The API key is supplied by the browser per
request and is never stored or logged here.

Setup:  pip install curl_cffi
Usage:  python server.py [port]
"""

import http.server
import json
import re
import sys
import urllib.parse
from pathlib import Path

from curl_cffi import requests

API_BASE = "https://giantbomb.com/api/"
PUBLIC_DIR = Path(__file__).parent / "public"
PLAYLISTS_FILE = Path(__file__).parent / "playlists.json"
PROGRESS_FILE = Path(__file__).parent / "progress.json"
STORES = {"/playlists": (PLAYLISTS_FILE, b"[]"), "/progress": (PROGRESS_FILE, b"{}")}
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
ALLOWED = re.compile(r"^((videos|shows|seasons|games)(/\d+)?|media/file/[\w.%-]+)$")
session = requests.Session(impersonate="chrome")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write(re.sub(r"api_key=[^&\s]+", "api_key=REDACTED", fmt % args) + "\n")

    def do_GET(self):
        if self.path.startswith("/api/"):
            self.proxy()
        elif self.path in STORES:
            f, empty = STORES[self.path]
            self.reply(200, f.read_bytes() if f.exists() else empty)
        else:
            super().do_GET()

    def do_PUT(self):
        if self.path not in STORES:
            self.send_error(404)
            return
        origin = self.headers.get("Origin", "")
        if origin and origin not in (f"http://localhost:{PORT}", f"http://127.0.0.1:{PORT}"):
            self.send_error(403, "Cross-origin write refused")
            return
        n = int(self.headers.get("Content-Length", 0))
        if n > 1_000_000:
            self.send_error(413)
            return
        f, empty = STORES[self.path]
        want = list if empty == b"[]" else dict
        try:
            data = json.loads(self.rfile.read(n))
            assert isinstance(data, want)
        except Exception:
            self.send_error(400, "Unexpected JSON shape")
            return
        if want is dict and f.exists():
            # Progress merges per video; the newer 'at' timestamp wins (multiple tabs).
            for k, old in json.loads(f.read_text(encoding="utf-8")).items():
                new = data.get(k)
                if not isinstance(new, dict) or (isinstance(old, dict) and old.get("at", 0) > new.get("at", 0)):
                    data[k] = old
        f.write_text(json.dumps(data, indent=2), encoding="utf-8")
        self.reply(200, b"{}")

    def end_headers(self):
        # Static files must revalidate, or the browser keeps serving a stale app.js.
        if not (self.path.startswith("/api/") or self.path in STORES):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def reply(self, status, body, ctype="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def proxy(self):
        parsed = urllib.parse.urlsplit(self.path)
        sub = parsed.path[len("/api/"):].strip("/")
        if not ALLOWED.match(sub):
            self.send_error(404, "Path not allowed by proxy")
            return
        qs = urllib.parse.parse_qs(parsed.query)
        key = (qs.pop("api_key", [""])[0]).strip()
        headers = {"Accept": "application/json"}
        if key:
            headers["X-API-Key"] = key
        url = API_BASE + sub + ("?" + urllib.parse.urlencode(qs, doseq=True) if qs else "")
        if key:
            url += ("&" if qs else "?") + "api_key=" + urllib.parse.quote(key)
        try:
            r = session.get(url, headers=headers, timeout=20)
            status, body, ctype = r.status_code, r.content, r.headers.get("content-type", "application/json")
        except Exception as e:
            status, body, ctype = 502, f'{{"error":"Proxy error: {type(e).__name__}"}}'.encode(), "application/json"
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Giant Bomb player running at http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
