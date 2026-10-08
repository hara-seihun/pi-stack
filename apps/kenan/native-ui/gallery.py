#!/usr/bin/env python3
"""Present the captured Android bitmaps without redrawing the native UI."""
import html
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
manifest = json.loads((root / 'manifest.json').read_text())
figures = ''.join(
    f'<figure id="{html.escape(state["id"])}"><h2>{html.escape(state["id"])}</h2>'
    f'<img src="{html.escape(state["image"])}" style="width:360px;height:auto">'
    f'<figcaption>{html.escape(state["scope"])}</figcaption></figure>'
    for state in manifest['states']
)
(root / 'index.html').write_text(
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Native Android actual-view captures</title>'
    '<style>body{font:14px system-ui;background:#17191e;color:#eee;margin:24px}'
    'main{display:flex;flex-wrap:wrap;gap:24px}figure{margin:0;width:360px}h2{font-size:16px}'
    'img{display:block;border:1px solid #596174}figcaption{margin:8px 0}</style>'
    '<h1>Native Android actual-view captures</h1>'
    f'<p>{html.escape(manifest["renderer"])} · WebView content and system-owned windows are unviewed.</p>'
    f'<main>{figures}</main></html>'
)
print(root / 'index.html')
