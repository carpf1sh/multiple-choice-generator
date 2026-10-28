"""Tests for the protections in server.pyw: Host checking, no dotfiles, no listings,
and the checks on the write API."""
import functools
import http.client
import importlib.machinery
import importlib.util
import json
import os
import shutil
import tempfile
import threading
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_server():
    path = os.path.join(ROOT, "server.pyw")
    loader = importlib.machinery.SourceFileLoader("server", path)
    spec = importlib.util.spec_from_loader("server", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


server = load_server()


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp()
        files = {
            "index.html": "<h1>home</h1>",
            "app.js": "ok",
            ".env": "SECRET=1",
            ".git/config": "[core]",
            "sub/.hidden/file.txt": "hidden",
            "sub/page.txt": "page",
            "folder/data.json": "{}",
        }
        for rel, text in files.items():
            full = os.path.join(cls.root, *rel.split("/"))
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w", encoding="utf-8") as f:
                f.write(text)

        handler = functools.partial(server.QuietHandler, directory=cls.root)
        cls.httpd = server.QuietServer(("127.0.0.1", 0), handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.root, ignore_errors=True)

    def get(self, path, host="localhost", method="GET"):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.putrequest(method, path, skip_host=True)
            if host is not None:
                conn.putheader("Host", host)
            conn.endheaders()
            res = conn.getresponse()
            return res.status, res.read().decode("utf-8", "replace")
        finally:
            conn.close()

    def test_serves_files(self):
        self.assertEqual(self.get("/app.js"), (200, "ok"))
        self.assertEqual(self.get("/sub/page.txt"), (200, "page"))

    def test_serves_index_for_root(self):
        self.assertEqual(self.get("/"), (200, "<h1>home</h1>"))

    def test_allowed_hosts_with_and_without_port(self):
        for host in ["localhost", f"localhost:{self.port}", "127.0.0.1", f"127.0.0.1:{self.port}", "LocalHost"]:
            with self.subTest(host=host):
                self.assertEqual(self.get("/app.js", host=host)[0], 200)

    def test_rejects_other_hosts(self):
        # DNS rebinding: the attacker's name resolves to 127.0.0.1 but keeps its own Host header.
        for host in ["evil.example", "evil.example:47823", "localhost.evil.example", "127.0.0.1.nip.io", "", None]:
            with self.subTest(host=host):
                self.assertEqual(self.get("/app.js", host=host)[0], 403)

    def test_rejects_other_hosts_for_head(self):
        self.assertEqual(self.get("/app.js", host="evil.example", method="HEAD")[0], 403)

    def test_never_serves_dotfiles(self):
        for path in [
            "/.env",
            "/.git/config",
            "/sub/.hidden/file.txt",
            "/%2eenv",
            "/%2Egit/config",
            "/sub/%2ehidden/file.txt",
            "/sub%2f.hidden/file.txt",
            "/sub%5c.hidden/file.txt",
            "/.git/config?x=1",
            "/sub/../.env",
        ]:
            with self.subTest(path=path):
                status, body = self.get(path)
                self.assertEqual(status, 404)
                self.assertNotIn("SECRET", body)
                self.assertNotIn("[core]", body)
                self.assertNotIn("hidden", body.replace(".hidden", ""))

    def test_does_not_list_folders(self):
        for path in ["/folder/", "/folder", "/sub/"]:
            with self.subTest(path=path):
                status, body = self.get(path)
                self.assertIn(status, (301, 404))
                self.assertNotIn("data.json", body)
                self.assertNotIn("page.txt", body)

    def test_stays_inside_the_root(self):
        for path in ["/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/..%2f..%2fetc/passwd"]:
            with self.subTest(path=path):
                self.assertEqual(self.get(path)[0], 404)


class WriteApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp()
        registry = {"exams": [{"id": "m", "manifest": "banks/m.json"}]}
        files = {
            "exams.json": json.dumps(registry),
            "banks/m.json": "{}",
            "samples/keep.json": "{}",
            "tests/keep.txt": "",
            "index.html": "<h1>home</h1>",
        }
        for rel, text in files.items():
            full = os.path.join(cls.root, *rel.split("/"))
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w", encoding="utf-8") as f:
                f.write(text)

        handler = functools.partial(server.QuietHandler, directory=cls.root)
        cls.httpd = server.QuietServer(("127.0.0.1", 0), handler)
        cls.port = cls.httpd.server_address[1]
        cls.origin = f"http://localhost:{cls.port}"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.root, ignore_errors=True)

    def request(self, method, path, body=b"", headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
            for name, value in (headers or {}).items():
                if value is not None:
                    conn.putheader(name, value)
            conn.endheaders(body or None)
            res = conn.getresponse()
            return res.status, res.getheader("Content-Type"), res.read().decode("utf-8", "replace")
        finally:
            conn.close()

    def post(self, files=None, body=None, **overrides):
        if body is None:
            body = json.dumps({"files": files}).encode("utf-8")
        headers = {
            "Host": "localhost",
            "Origin": self.origin,
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": str(len(body)),
        }
        headers.update(overrides)
        return self.request("POST", "/api/files", body, headers)

    def path(self, rel):
        return os.path.join(self.root, *rel.split("/"))

    def read(self, rel):
        with open(self.path(rel), "rb") as f:
            return f.read().decode("utf-8")

    def assertRejected(self, response, written=()):
        status, content_type, body = response
        self.assertGreaterEqual(status, 400)
        self.assertLess(status, 500)
        self.assertEqual(content_type, "application/json")
        self.assertIn("error", json.loads(body))
        for rel in written:
            self.assertFalse(os.path.exists(self.path(rel)), rel)

    def test_status(self):
        status, content_type, body = self.request("GET", "/api/status", headers={"Host": "localhost"})
        self.assertEqual((status, content_type), (200, "application/json"))
        self.assertEqual(json.loads(body), {"writable": True})

    def test_status_checks_host(self):
        self.assertEqual(self.request("GET", "/api/status", headers={"Host": "evil.example"})[0], 403)

    def test_writes_one_file(self):
        data = {"title": "Café", "questions": [1, 2]}
        status, _, body = self.post([{"path": "samples/one.json", "data": data}])
        self.assertEqual((status, json.loads(body)), (200, {"ok": True}))
        self.assertEqual(self.read("samples/one.json"), json.dumps(data, indent=2, ensure_ascii=False) + "\n")
        self.assertNotIn("\r", self.read("samples/one.json"))

    def test_writes_several_files_and_overwrites(self):
        files = [
            {"path": "samples/keep.json", "data": {"v": 2}},
            {"path": "samples/two.json", "data": [1, "two"]},
            {"path": "exams.local.json", "data": {"exams": []}},
        ]
        self.assertEqual(self.post(files)[0], 200)
        for entry in files:
            self.assertEqual(json.loads(self.read(entry["path"])), entry["data"])
        leftovers = [n for n in os.listdir(self.path("samples")) if n.endswith(".tmp")]
        self.assertEqual(leftovers, [])

    def test_writes_into_registered_manifest_folder(self):
        self.assertEqual(self.post([{"path": "banks/batch1.json", "data": {"q": 1}}])[0], 200)
        self.assertEqual(json.loads(self.read("banks/batch1.json")), {"q": 1})

    @staticmethod
    def exam(exam_id, manifest="banks/m.json", **over):
        exam = {"id": exam_id, "name": exam_id.upper(), "manifest": manifest,
                "domains": [{"key": "D1", "name": "One", "weight": 60}, {"key": "D2", "name": "Two", "weight": 40.5}]}
        exam.update(over)
        return exam

    def test_writes_registry(self):
        registry = {"exams": [self.exam("m"), self.exam("n", "samples/n/m.json", title="N test")]}
        self.assertEqual(self.post([{"path": "exams.json", "data": registry}])[0], 200)
        self.assertEqual(json.loads(self.read("exams.json")), registry)
        # A bare list is accepted too, as the app accepts it.
        self.assertEqual(self.post([{"path": "exams.local.json", "data": [self.exam("p")]}])[0], 200)
        os.remove(self.path("exams.local.json"))

    def test_rejects_registries_the_app_cannot_load(self):
        def domains(*items):
            return {"domains": list(items)}
        good = {"key": "D1", "name": "One", "weight": 1}
        for label, registry in [
            ("not a list", {"exams": {"m": 1}}),
            ("text", "exams"),
            ("exam not an object", [1]),
            ("missing id", [self.exam("")]),
            ("id not text", [self.exam("m", id=5)]),
            ("duplicate id", [self.exam("m"), self.exam("m")]),
            ("missing name", [self.exam("m", name=" ")]),
            ("title not text", [self.exam("m", title=3)]),
            ("manifest missing", [self.exam("m", manifest=None)]),
            ("manifest not json", [self.exam("m", manifest="banks/m.txt")]),
            ("manifest absolute", [self.exam("m", manifest="/banks/m.json")]),
            ("manifest traversal", [self.exam("m", manifest="../m.json")]),
            ("manifest dotfolder", [self.exam("m", manifest=".git/m.json")]),
            ("manifest backslash", [self.exam("m", manifest="banks\\m.json")]),
            ("no domains", [self.exam("m", domains=[])]),
            ("domains not a list", [self.exam("m", domains="D1")]),
            ("bad key", [self.exam("m", **domains({**good, "key": "X1"}))]),
            ("duplicate key", [self.exam("m", **domains(good, good))]),
            ("domain without name", [self.exam("m", **domains({**good, "name": ""}))]),
            ("zero weight", [self.exam("m", **domains({**good, "weight": 0}))]),
            ("negative weight", [self.exam("m", **domains({**good, "weight": -5}))]),
            ("text weight", [self.exam("m", **domains({**good, "weight": "5"}))]),
            ("boolean weight", [self.exam("m", **domains({**good, "weight": True}))]),
            ("null weight", [self.exam("m", **domains({**good, "weight": None}))]),
        ]:
            with self.subTest(label):
                before = self.read("exams.json")
                self.assertRejected(self.post([{"path": "exams.json", "data": registry}]))
                self.assertEqual(self.read("exams.json"), before)

    def test_rejects_nan_and_infinity(self):
        for constant in [b"NaN", b"Infinity", b"-Infinity"]:
            with self.subTest(constant=constant):
                body = b'{"files": [{"path": "samples/nan.json", "data": {"w": ' + constant + b"}}]}"
                self.assertRejected(self.post(body=body), ["samples/nan.json"])

    def test_rejects_data_too_deep_to_write(self):
        # Parses, but is too deeply nested to write back out; the first file must not be written either.
        depth = 5000
        deep = b"[" * depth + b"]" * depth
        body = b'{"files": [{"path": "samples/ok.json", "data": 1}, {"path": "samples/deep.json", "data": ' + deep + b"}]}"
        status = self.post(body=body)[0]
        self.assertEqual(status, 400)
        self.assertFalse(os.path.exists(self.path("samples/ok.json")))
        self.assertFalse(os.path.exists(self.path("samples/deep.json")))

    def test_rejects_the_same_file_twice(self):
        files = [{"path": "samples/twice.json", "data": 1}, {"path": "samples/twice.json", "data": 2}]
        self.assertRejected(self.post(files), ["samples/twice.json"])
        files = [{"path": "samples/Case.json", "data": 1}, {"path": "samples/case.json", "data": 2}]
        if os.path.normcase("A") == os.path.normcase("a"):
            self.assertRejected(self.post(files), ["samples/Case.json"])

    def test_rejects_names_windows_would_change(self):
        for path in [
            "samples/con.json",
            "samples/NUL.json",
            "samples/aux/x.json",
            "samples/com1.json",
            "samples/lpt9.data.json",
            "samples/x.json ",
            "samples/ x.json",
            "samples/dir./x.json",
            "samples/dir /x.json",
            "samples/a<b.json",
            "samples/a|b.json",
            "samples/a?b.json",
            "samples/a*b.json",
            'samples/a"b.json',
            "samples/a\tb.json",
            "samples/" + "x" * 300 + ".json",
            "samples/" + "d/" * 200 + "x.json",
        ]:
            with self.subTest(path=path):
                self.assertRejected(self.post([{"path": path, "data": 1}]))
        self.assertEqual(sorted(os.listdir(self.path("samples"))), sorted(set(os.listdir(self.path("samples")))))
        self.assertFalse(os.path.exists(self.path("samples/aux")))
        # Ordinary names with spaces, dots and Unicode inside are fine.
        for path in ["samples/my bank v1.json", "samples/bank.v2.json", "samples/console.json", "samples/préparation.json"]:
            with self.subTest(path=path):
                self.assertEqual(self.post([{"path": path, "data": 1}])[0], 200)

    def test_registries_keep_their_compact_layout(self):
        # Rewriting the real registry changes nothing, so adding a test only adds its own lines.
        with open(os.path.join(ROOT, "exams.json"), encoding="utf-8") as f:
            original = f.read().replace("\r\n", "\n")
        self.assertEqual(server.registry_json(json.loads(original)) + "\n", original)
        self.assertEqual(server.registry_json([]), "[]")
        self.assertEqual(server.registry_json({"a": {"b": [1]}}), json.dumps({"a": {"b": [1]}}, indent=2))

    def test_creates_private_folders(self):
        self.assertEqual(self.post([{"path": "private/new/x.json", "data": {"x": 1}}])[0], 200)
        self.assertEqual(json.loads(self.read("private/new/x.json")), {"x": 1})

    def test_rejects_foreign_host(self):
        self.assertRejected(self.post([{"path": "samples/h.json", "data": 1}], Host="evil.example"), ["samples/h.json"])

    def test_rejects_missing_or_foreign_origin(self):
        for origin in [None, "http://evil.example", f"http://localhost:{self.port + 1}", "null", f"https://localhost:{self.port}"]:
            with self.subTest(origin=origin):
                self.assertRejected(self.post([{"path": "samples/o.json", "data": 1}], Origin=origin), ["samples/o.json"])

    def test_accepts_loopback_origin(self):
        self.assertEqual(self.post([{"path": "samples/ip.json", "data": 1}], Origin=f"http://127.0.0.1:{self.port}")[0], 200)

    def test_rejects_wrong_content_type(self):
        for content_type in [None, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]:
            with self.subTest(content_type=content_type):
                response = self.post([{"path": "samples/ct.json", "data": 1}], **{"Content-Type": content_type})
                self.assertRejected(response, ["samples/ct.json"])

    def test_rejects_oversize_or_missing_length(self):
        self.assertRejected(self.post(body=b"{}", **{"Content-Length": str(6 * 1024 * 1024)}))
        self.assertRejected(self.post(body=b"", **{"Content-Length": None}))

    def test_rejects_bad_bodies(self):
        for body in [b"{not json", b"[]", b"{}", b'{"files": []}', b'{"files": [{"path": "samples/d.json"}]}', b"\xff\xfe"]:
            with self.subTest(body=body):
                self.assertRejected(self.post(body=body), ["samples/d.json"])

    def test_rejects_bad_paths(self):
        for path in [
            "../x.json",
            "samples/../../x.json",
            "samples/../tests/x.json",
            "samples/%2e%2e/x.json",
            "samples/%2E%2E/%2e%2e/x.json",
            "samples\\x.json",
            "samples\\..\\x.json",
            "/samples/x.json",
            "C:/x.json",
            "samples/.hidden.json",
            "samples/.git/x.json",
            "samples/./x.json",
            "samples//x.json",
            "samples/x.txt",
            "samples/x.json.bak",
            "samples/x",
            "tests/x.json",
            "foo.json",
            "index.html",
            "banks.json",
            "banksx/y.json",
            "",
            None,
            42,
        ]:
            with self.subTest(path=path):
                self.assertRejected(self.post([{"path": path, "data": {"bad": True}}]))
        self.assertFalse(os.path.exists(self.path("x.json")))
        self.assertFalse(os.path.exists(self.path("tests/x.json")))
        self.assertFalse(os.path.exists(self.path("foo.json")))
        self.assertEqual(self.read("index.html"), "<h1>home</h1>")

    def test_one_bad_path_writes_nothing(self):
        files = [
            {"path": "samples/first.json", "data": 1},
            {"path": "private/second/x.json", "data": 2},
            {"path": "tests/x.json", "data": 3},
        ]
        self.assertRejected(self.post(files), ["samples/first.json", "private/second", "tests/x.json"])

    def test_other_methods_and_routes(self):
        headers = {"Host": "localhost", "Origin": self.origin, "Content-Type": "application/json", "Content-Length": "2"}
        self.assertEqual(self.request("POST", "/api/other", b"{}", headers)[0], 501)
        self.assertEqual(self.request("PUT", "/api/files", b"{}", headers)[0], 501)
        self.assertEqual(self.request("GET", "/api/files", headers={"Host": "localhost"})[0], 404)


class MainTest(unittest.TestCase):
    def test_binds_to_loopback_only(self):
        with open(os.path.join(ROOT, "server.pyw"), encoding="utf-8") as f:
            source = f.read()
        self.assertIn('QuietServer(("127.0.0.1", port)', source)


if __name__ == "__main__":
    unittest.main()
