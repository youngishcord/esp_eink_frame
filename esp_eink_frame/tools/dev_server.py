"""Local stand-in for the frame's HTTP API.

Serves web/ and implements the same endpoints as src/web/WebServerApp.cpp,
storing uploaded frames in ./dev_store with the same sidecar metadata file the
firmware uses. Handy for working on the web UI without a board:

    python tools/dev_server.py [port]      # default 8123

This file is a development tool; it is not part of the firmware.
"""

import json
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(PROJECT_DIR, "web")
STORE_DIR = os.path.join(PROJECT_DIR, "dev_store")

DISPLAY_W, DISPLAY_H = 800, 480
FRAME_BYTES = DISPLAY_W * DISPLAY_H // 2
EXT = ".e6"
META = "meta.tsv"
MAX_NAME = 40
MAX_TITLE = 80

STATE = {"current": None}


def sanitize(raw):
    """Mirror of ImageRepository::sanitize()."""
    name = (raw or "").strip()
    if "." in name and name.rindex(".") > 0:
        name = name[: name.rindex(".")]
    out = []
    for ch in name:
        if re.match(r"[A-Za-z0-9_-]", ch):
            out.append(ch)
        elif ch == " ":
            out.append("_")
    return "".join(out)[:MAX_NAME]


def sanitize_title(raw):
    """Mirror of ImageRepository::sanitizeTitle()."""
    text = (raw or "").replace("\t", " ").replace("\r", " ").replace("\n", " ")
    text = re.sub(r" +", " ", text).strip()
    return text[:MAX_TITLE]


def path_for(name):
    return os.path.join(STORE_DIR, name + EXT)


def read_meta():
    path = os.path.join(STORE_DIR, META)
    rows = {}
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            for line in handle.read().split("\n"):
                if "\t" not in line:
                    continue
                key, title = line.split("\t", 1)
                if key and title.strip():
                    rows[key] = title.strip()
    return rows


def write_meta(rows):
    os.makedirs(STORE_DIR, exist_ok=True)
    path = os.path.join(STORE_DIR, META)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
        for key, title in rows.items():
            handle.write("%s\t%s\n" % (key, title))
    os.replace(tmp, path)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[dev] " + fmt % args + "\n")

    # --- helpers ---------------------------------------------------------
    def send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, code, content_type, body):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    # --- routes ----------------------------------------------------------
    def do_GET(self):
        parsed = urlparse(self.path)
        route, query = parsed.path, parse_qs(parsed.query)

        if route in ("/", "/index.html"):
            return self.serve_file("index.html", "text/html; charset=utf-8")
        if route == "/app.css":
            return self.serve_file("app.css", "text/css; charset=utf-8")
        if route == "/app.js":
            return self.serve_file("app.js", "application/javascript; charset=utf-8")

        if route == "/api/status":
            files = self.list_images()
            return self.send_json(200, {
                "firmware": "esp_eink_frame",
                "version": "0.2.0-dev",
                "apMode": False,
                "connected": True,
                "ssid": "devnet",
                "ip": "127.0.0.1",
                "apSsid": "eink-frame-dev",
                "apIp": "192.168.4.1",
                "sd": True,
                "sdTotalMb": 14900,
                "sdUsedMb": len(files) * FRAME_BYTES // (1024 * 1024),
                "rtc": True,
                "busy": False,
                "image": STATE["current"] or "",
            })

        if route == "/api/images":
            return self.send_json(200, self.list_images())

        if route == "/api/file":
            name = sanitize((query.get("name") or [""])[0])
            path = path_for(name)
            if not name or not os.path.isfile(path):
                return self.send_bytes(404, "text/plain", b"not found")
            with open(path, "rb") as handle:
                return self.send_bytes(200, "application/octet-stream", handle.read())

        return self.send_bytes(404, "text/plain", b"not found")

    def do_POST(self):
        parsed = urlparse(self.path)
        route, query = parsed.path, parse_qs(parsed.query)
        body = self.read_body()

        if route == "/api/images/upload":
            filename, data = parse_upload(self.headers.get("Content-Type", ""), body)
            name = sanitize(filename or "")
            title = sanitize_title((query.get("title") or [""])[0])
            if not name:
                name = free_name("image")
            if len(data) != FRAME_BYTES:
                return self.send_json(400, {"ok": False, "error": "unexpected frame size"})
            os.makedirs(STORE_DIR, exist_ok=True)
            with open(path_for(name), "wb") as handle:
                handle.write(data)
            if title:
                rows = read_meta()
                rows[name] = title
                write_meta(rows)
            return self.send_json(200, {"ok": True, "name": name, "title": title or name})

        form = {k: v[0] for k, v in parse_qs(body.decode("utf-8", "replace")).items()}

        if route == "/api/images/rename":
            name = sanitize(form.get("name", ""))
            if not name or not os.path.isfile(path_for(name)):
                return self.send_json(404, {"ok": False, "error": "not found"})
            title = sanitize_title(form.get("title", ""))
            rows = read_meta()
            if title:
                rows[name] = title
            else:
                rows.pop(name, None)
            write_meta(rows)
            return self.send_json(200, {"ok": True, "name": name, "title": title or name})

        if route == "/api/images/delete":
            name = sanitize(form.get("name", ""))
            if not name or not os.path.isfile(path_for(name)):
                return self.send_json(404, {"ok": False, "error": "not found"})
            os.remove(path_for(name))
            rows = read_meta()
            if rows.pop(name, None) is not None:
                write_meta(rows)
            return self.send_json(200, {"ok": True})

        if route == "/api/display":
            name = sanitize(form.get("name", ""))
            if not name or not os.path.isfile(path_for(name)):
                return self.send_json(404, {"ok": False, "error": "not found"})
            STATE["current"] = name
            print("[dev] display: %s" % name)
            return self.send_json(200, {"ok": True})

        if route in ("/api/wifi", "/api/wifi/reset", "/api/status-screen",
                     "/api/autonomy-test"):
            print("[dev] %s %s" % (route, form))
            return self.send_json(200, {"ok": True})

        return self.send_bytes(404, "text/plain", b"not found")

    # --- implementation details -----------------------------------------
    def serve_file(self, name, content_type):
        path = os.path.join(WEB_DIR, name)
        if not os.path.isfile(path):
            return self.send_bytes(404, "text/plain", b"missing " + name.encode())
        with open(path, "rb") as handle:
            body = handle.read()
        # The board caches nothing; make sure a reload always picks up edits.
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def list_images(self):
        rows = read_meta()
        items = []
        if os.path.isdir(STORE_DIR):
            for entry in sorted(os.listdir(STORE_DIR)):
                if not entry.endswith(EXT):
                    continue
                name = entry[: -len(EXT)]
                full = os.path.join(STORE_DIR, entry)
                items.append({
                    "name": name,
                    "title": rows.get(name, name),
                    "size": os.path.getsize(full),
                    "mtime": int(os.path.getmtime(full)),
                    "current": name == STATE["current"],
                })
        return items


def free_name(stem):
    if not os.path.isfile(path_for(stem)):
        return stem
    i = 2
    while os.path.isfile(path_for("%s-%d" % (stem, i))) and i < 1000:
        i += 1
    return "%s-%d" % (stem, i)


def parse_upload(content_type, body):
    """Pulls the single file part out of a multipart/form-data body."""
    match = re.search(r'boundary="?([^";]+)"?', content_type)
    if not match:
        return "", b""
    boundary = ("--" + match.group(1)).encode()
    for chunk in body.split(boundary):
        if b"filename=" not in chunk[:600]:
            continue
        head, _, data = chunk.partition(b"\r\n\r\n")
        filename = ""
        found = re.search(rb'filename="([^"]*)"', head)
        if found:
            filename = unquote(found.group(1).decode("utf-8", "replace"))
        if data.endswith(b"\r\n"):
            data = data[:-2]
        return filename, data
    return "", b""


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    os.makedirs(STORE_DIR, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("esp_eink_frame dev server: http://127.0.0.1:%d  (store: %s)"
          % (port, STORE_DIR))
    print("frame size check: %d bytes per image" % FRAME_BYTES)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
