"""Serve the Draft Lab website locally: python serve.py  ->  http://localhost:8000"""
import functools
import http.server
import os
import webbrowser

PORT = int(os.environ.get("PORT", 8000))
SITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "site")

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=SITE)
with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler) as httpd:
    url = f"http://localhost:{PORT}"
    print(f"MLBB Draft Lab running at {url}  (Ctrl+C to stop)")
    webbrowser.open(url)
    httpd.serve_forever()
