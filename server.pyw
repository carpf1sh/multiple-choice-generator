"""Serves this folder on 127.0.0.1 without a console window (run with pythonw).

http.server writes a log line for every request to stderr. Under pythonw there
is no stderr, so that write fails and the request is dropped. This handler
keeps quiet instead.
"""
import functools
import http.server
import os
import sys


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass


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
