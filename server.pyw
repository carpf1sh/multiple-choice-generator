"""Serves this folder on 127.0.0.1 without a console window (run with pythonw).

http.server writes a log line for every request to stderr. Under pythonw there
is no stderr, so that write fails and the request is dropped. This handler
keeps quiet instead.

Binding to 127.0.0.1 keeps other machines out, but a web page can still reach
the server through DNS rebinding. So requests must name localhost in their
Host header, dotfiles such as .git are never served, and folders aren't listed.
"""
import functools
import http.server
import os
import re
import sys
import urllib.parse

ALLOWED_HOSTS = {"localhost", "127.0.0.1"}


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def send_head(self):
        host = self.headers.get("Host", "").split(":")[0].lower()
        if host not in ALLOWED_HOSTS:
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
