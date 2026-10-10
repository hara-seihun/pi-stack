#!/usr/bin/python3 -I
"""Initial live, public-only PiStack documentation service. Replace freely."""
import socketserver,http.server,os,json,html,pathlib
P=pathlib.Path
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  if self.path=='/health':
   body=json.dumps({'ok':True,'plane':'public-only','privateRemote':False}).encode();kind='application/json'
  else:
   docs=P('/work/state/current/docs')
   entries=sorted(docs.glob('*.md')) if docs.exists() else []
   body=('<!doctype html><meta charset=utf-8><title>PiStack public documentation</title><h1>PiStack public documentation</h1><p>Live mutable public application. This is not the private Remote client, login or key entry point.</p>'+''.join('<details><summary>'+html.escape(x.name)+'</summary><pre>'+html.escape(x.read_text())+'</pre></details>' for x in entries)+'<p>No personal data, sessions or credentials are admitted here.</p>').encode();kind='text/html'
  self.send_response(200);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def do_HEAD(self):self.send_response(200);self.end_headers()
class Server(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):daemon_threads=True
path='/work/ingress/app.sock'
try:os.unlink(path)
except FileNotFoundError:pass
server=Server(path,Handler);os.chmod(path,0o600);server.serve_forever()
