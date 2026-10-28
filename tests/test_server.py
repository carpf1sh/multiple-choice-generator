"""Tests for the protections in server.pyw: Host checking, no dotfiles, no listings."""
import functools
import http.client
import importlib.machinery
import importlib.util
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


class MainTest(unittest.TestCase):
    def test_binds_to_loopback_only(self):
        with open(os.path.join(ROOT, "server.pyw"), encoding="utf-8") as f:
            source = f.read()
        self.assertIn('QuietServer(("127.0.0.1", port)', source)


if __name__ == "__main__":
    unittest.main()
