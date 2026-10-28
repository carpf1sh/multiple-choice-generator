"""Serves this folder on 127.0.0.1 without a console window (run with pythonw).

http.server writes a log line for every request to stderr. Under pythonw there
is no stderr, so that write fails and the request is dropped. This handler
keeps quiet instead.

Binding to 127.0.0.1 keeps other machines out, but a web page can still reach
the server through DNS rebinding. So requests must name localhost in their
Host header, dotfiles such as .git are never served, and folders aren't listed.

The test manager saves through POST /api/files. Besides the Host check, a write
needs a same-site Origin and a JSON body (so a plain cross-site form can't send
one), and may only touch .json files in the registries, samples/, private/ or
the folder of a registered manifest.
"""
import functools
import http.server
import json
import os
import posixpath
import re
import sys
import tempfile
import urllib.parse

ALLOWED_HOSTS = {"localhost", "127.0.0.1"}
REGISTRIES = ("exams.json", "exams.local.json")
WRITABLE_FOLDERS = ("samples/", "private/")
MAX_BODY = 5 * 1024 * 1024
MAX_PATH = 400
# Names Windows treats as devices, with or without an extension.
WINDOWS_DEVICES = re.compile(r"^(con|prn|aux|nul|com\d|lpt\d)(\.|$)", re.IGNORECASE)
FORBIDDEN_CHARS = set('<>:"|?*\\%')
DOMAIN_KEY = re.compile(r"^D\d+$")


class Reject(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def bad_segments(path):
    return any(part in ("", ".", "..") or part.startswith(".") for part in path.split("/"))


def bad_name(part):
    """A file or folder name that Windows would refuse or quietly change (trailing
    spaces and dots are dropped), so the file written isn't the one checked."""
    return (
        len(part) > 255
        or part != part.strip(" ").rstrip(".")
        or WINDOWS_DEVICES.match(part) is not None
        or any(c in FORBIDDEN_CHARS or ord(c) < 32 for c in part)
    )


def reject_constant(name):
    # Python reads and writes NaN and Infinity, but browsers can't parse them.
    raise Reject(400, f"{name} is not allowed in JSON")


def check_registry(rel, data):
    """A registry the practice app can load: a list of exams (bare or under
    "exams"), each with a unique id, a name, a safe manifest path and domains."""
    exams = data.get("exams") if isinstance(data, dict) else data
    if not isinstance(exams, list):
        raise Reject(400, f"{rel} must hold a list of exams")
    ids = set()
    for number, exam in enumerate(exams, 1):
        where = f"{rel}, exam {number}"
        if not isinstance(exam, dict):
            raise Reject(400, f"{where}: must be an object")
        exam_id = exam.get("id")
        if not isinstance(exam_id, str) or not exam_id.strip():
            raise Reject(400, f"{where}: needs an id")
        if exam_id in ids:
            raise Reject(400, f"{where}: duplicate id {exam_id}")
        ids.add(exam_id)
        if not isinstance(exam.get("name"), str) or not exam["name"].strip():
            raise Reject(400, f"{where}: needs a name")
        if "title" in exam and not isinstance(exam["title"], str):
            raise Reject(400, f"{where}: title must be text")
        manifest = exam.get("manifest")
        if (
            not isinstance(manifest, str)
            or not manifest.endswith(".json")
            or manifest.startswith("/")
            or bad_segments(manifest)
            or any(bad_name(part) for part in manifest.split("/"))
        ):
            raise Reject(400, f"{where}: manifest must be a relative .json path")
        domains = exam.get("domains")
        if not isinstance(domains, list) or not domains:
            raise Reject(400, f"{where}: needs at least one domain")
        keys = set()
        for domain in domains:
            key = domain.get("key") if isinstance(domain, dict) else None
            if not isinstance(key, str) or not DOMAIN_KEY.match(key) or key in keys:
                raise Reject(400, f"{where}: domain keys must be unique and look like D1")
            keys.add(key)
            if not isinstance(domain.get("name"), str) or not domain["name"].strip():
                raise Reject(400, f"{where}: domain {key} needs a name")
            weight = domain.get("weight")
            if isinstance(weight, bool) or not isinstance(weight, (int, float)) or not weight > 0:
                raise Reject(400, f"{where}: domain {key} needs a weight above 0")


def manifest_folders(root):
    """Folders of the manifests listed in the registries, as clean relative paths."""
    folders = set()
    for name in REGISTRIES:
        try:
            with open(os.path.join(root, name), encoding="utf-8") as f:
                registry = json.load(f)
        except (OSError, ValueError):
            continue
        exams = registry.get("exams") if isinstance(registry, dict) else registry
        if not isinstance(exams, list):
            continue
        for exam in exams:
            manifest = exam.get("manifest") if isinstance(exam, dict) else None
            if not isinstance(manifest, str) or "\\" in manifest or manifest.startswith("/"):
                continue
            folder = posixpath.dirname(posixpath.normpath(manifest))
            # A manifest in the root folder would open up the whole app, so it doesn't count.
            if folder and not bad_segments(folder):
                folders.add(folder + "/")
    return folders


def is_allowed_place(rel, folders):
    return rel in REGISTRIES or rel.startswith(WRITABLE_FOLDERS) or any(rel.startswith(f) for f in folders)


def check_path(root, rel, folders):
    """Returns the absolute file to write for a requested path, or raises Reject."""
    if not isinstance(rel, str) or not rel:
        raise Reject(400, "Each path must be a non-empty string")
    if len(rel) > MAX_PATH or rel.startswith("/") or bad_segments(rel) or any(bad_name(p) for p in rel.split("/")):
        raise Reject(400, f"Bad path: {rel}")
    if not rel.endswith(".json"):
        raise Reject(400, f"Only .json files can be written: {rel}")
    if not is_allowed_place(rel, folders):
        raise Reject(403, f"Not a writable place: {rel}")
    real_root = os.path.realpath(root)
    target = os.path.realpath(os.path.join(real_root, *rel.split("/")))
    if os.path.normcase(os.path.commonpath([real_root, target])) != os.path.normcase(real_root):
        raise Reject(403, f"Outside the app folder: {rel}")
    # A symlinked folder must not lead somewhere the request couldn't name directly.
    real_rel = os.path.relpath(target, real_root).replace(os.sep, "/")
    if not is_allowed_place(real_rel, folders):
        raise Reject(403, f"Not a writable place: {rel}")
    if os.path.isdir(target):
        raise Reject(400, f"Is a folder: {rel}")
    if not os.path.isdir(os.path.dirname(target)) and not rel.startswith(WRITABLE_FOLDERS):
        raise Reject(400, f"Folder does not exist: {rel}")
    return target


def registry_json(value, level=0):
    """Like json.dumps(indent=2), but a list item whose values are all plain
    (such as a domain) stays on one line, the way exams.json is written."""
    dump = functools.partial(json.dumps, ensure_ascii=False)
    pad = "  " * level
    if isinstance(value, list) and value:
        items = []
        for item in value:
            if isinstance(item, dict) and item and not any(isinstance(v, (dict, list)) for v in item.values()):
                items.append("{ " + ", ".join(f"{dump(k)}: {dump(v)}" for k, v in item.items()) + " }")
            else:
                items.append(registry_json(item, level + 1))
        return "[\n" + ",\n".join(f"{pad}  {x}" for x in items) + f"\n{pad}]"
    if isinstance(value, dict) and value:
        items = [f"{pad}  {dump(k)}: {registry_json(v, level + 1)}" for k, v in value.items()]
        return "{\n" + ",\n".join(items) + f"\n{pad}}}"
    return dump(value)


def to_text(rel, data):
    """The file contents to write, checked first. Raises Reject."""
    if rel in REGISTRIES:
        check_registry(rel, data)
    try:
        text = registry_json(data) if rel in REGISTRIES else json.dumps(data, indent=2, ensure_ascii=False)
    except (ValueError, RecursionError):
        raise Reject(400, f"Can't be written as JSON: {rel}")
    return text + "\n"


def write_json(target, text):
    folder = os.path.dirname(target)
    os.makedirs(folder, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=folder, prefix=".", suffix=".tmp")
    try:
        with open(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        os.replace(temp, target)
    except BaseException:
        try:
            os.remove(temp)
        except OSError:
            pass
        raise


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def host_ok(self):
        host = self.headers.get("Host", "").split(":")[0].lower()
        return host in ALLOWED_HOSTS

    def origin_ok(self):
        port = self.server.server_address[1]
        return self.headers.get("Origin") in (f"http://localhost:{port}", f"http://127.0.0.1:{port}")

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def route(self):
        return urllib.parse.urlsplit(self.path).path

    def do_GET(self):
        if self.route() != "/api/status":
            super().do_GET()
        elif not self.host_ok():
            self.send_json(403, {"error": "Forbidden host"})
        else:
            self.send_json(200, {"writable": True})

    def read_body(self):
        """Reads the request body before any reply. Closing a socket with unread
        data makes Windows reset the connection, and the client loses the reply."""
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.drain()
            raise Reject(411, "Content-Length required")
        if length < 0 or length > MAX_BODY:
            self.drain()
            raise Reject(400 if length < 0 else 413, "Bad Content-Length" if length < 0 else "Request too large")
        return self.rfile.read(length)

    def refuse_method(self):
        self.drain()
        self.close_connection = True
        self.send_error(501, f"Unsupported method ({self.command!r})")

    do_PUT = do_DELETE = do_PATCH = refuse_method

    def drain(self):
        """Reads whatever body has already arrived, up to MAX_BODY, without waiting
        long for more, so the refusal reaches the client before the socket closes."""
        try:
            self.connection.settimeout(0.2)
            left = MAX_BODY
            while left > 0:
                chunk = self.rfile.read1(min(left, 65536))
                if not chunk:
                    break
                left -= len(chunk)
        except OSError:
            pass

    def do_POST(self):
        try:
            raw = self.read_body()
            if self.route() != "/api/files":
                self.send_error(501, "Unsupported method ('POST')")
                return
            self.save_files(raw)
        except Reject as reject:
            # A body that wasn't read (bad or oversized length) is still on the
            # connection, so don't reuse it.
            self.close_connection = True
            self.send_json(reject.status, {"error": reject.message})
        except OSError as error:
            self.send_json(500, {"error": f"Could not save: {error}"})
        else:
            self.send_json(200, {"ok": True})

    def save_files(self, raw):
        if not self.host_ok():
            raise Reject(403, "Forbidden host")
        if not self.origin_ok():
            raise Reject(403, "Forbidden origin")
        content_type = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if content_type != "application/json":
            raise Reject(415, "Content-Type must be application/json")
        try:
            body = json.loads(raw.decode("utf-8"), parse_constant=reject_constant)
        except (ValueError, RecursionError):
            raise Reject(400, "Body is not valid JSON")
        files = body.get("files") if isinstance(body, dict) else None
        if not isinstance(files, list) or not files:
            raise Reject(400, "Expected a non-empty files list")

        folders = manifest_folders(self.directory)
        # Check and serialise every file before writing any, so a bad one leaves all untouched.
        writes = {}
        for entry in files:
            if not isinstance(entry, dict) or "data" not in entry:
                raise Reject(400, "Each file needs a path and data")
            rel = entry.get("path")
            target = check_path(self.directory, rel, folders)
            if os.path.normcase(target) in writes:
                raise Reject(400, f"Listed twice: {rel}")
            writes[os.path.normcase(target)] = (target, to_text(rel, entry["data"]))
        for target, text in writes.values():
            write_json(target, text)

    def send_head(self):
        if not self.host_ok():
            self.send_error(403, "Forbidden host")
            return None
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if any(part.startswith(".") for part in re.split(r"[\\/]", path)):
            self.send_error(404)
            return None
        return super().send_head()

    def list_directory(self, path):
        self.send_error(404)
        return None


class QuietServer(http.server.ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 47823
    root = os.path.dirname(os.path.abspath(__file__))
    handler = functools.partial(QuietHandler, directory=root)
    with QuietServer(("127.0.0.1", port), handler) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
