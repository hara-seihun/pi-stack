#!/usr/bin/python3 -I
"""Fixed public-only ingress. No keys, cookies, auth or private upstreams."""
import socket,http.server,http.client,urllib.parse,json
PORT=8899
MAX_BODY=1024*1024
MAX_RESPONSE=8*1024*1024
class UnixHTTP(http.client.HTTPConnection):
 def connect(self):
  self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(5);self.sock.connect('/upstream/app.sock')
class Handler(http.server.BaseHTTPRequestHandler):
 protocol_version='HTTP/1.0'
 def setup(self):
  super().setup();self.connection.settimeout(5)
 def log_message(self,*args):pass # no submitted queries/bodies in trusted logs
 def send(self,status,data,kind='text/plain; charset=utf-8'):
  self.send_response(status)
  self.send_header('Content-Type',kind)
  self.send_header('Content-Length',str(len(data)))
  self.send_header('Content-Security-Policy',"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'")
  self.send_header('X-Content-Type-Options','nosniff');self.send_header('X-Frame-Options','DENY')
  self.send_header('Cache-Control','no-store');self.send_header('Referrer-Policy','no-referrer')
  self.send_header('Permissions-Policy','camera=(), microphone=(), geolocation=(), usb=(), clipboard-read=(), clipboard-write=()')
  self.end_headers()
  if self.command!='HEAD':self.wfile.write(data)
 def handle_app(self):
  if self.headers.get_all('Host') not in [[f'127.0.0.1:{PORT}'],[f'localhost:{PORT}']]:return self.send(400,b'Public-only origin required\n')
  if any(x in self.headers for x in ['Authorization','Cookie','Proxy-Authorization','Transfer-Encoding','Upgrade']):return self.send(400,b'Credentials, chunking and upgrades are not admitted\n')
  if 'Origin' in self.headers:return self.send(403,b'Cross-origin requests are not admitted\n')
  if self.headers.get('Sec-Fetch-Site','none') not in ['none','same-origin']:return self.send(403,b'Cross-site request blocked\n')
  if self.command not in ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']:return self.send(405,b'Unsupported method\n')
  parsed=urllib.parse.urlsplit(self.path)
  if not self.path.startswith('/') or self.path.startswith('//') or parsed.scheme or parsed.netloc:return self.send(400,b'Invalid path\n')
  lengths=self.headers.get_all('Content-Length') or ['0']
  if len(lengths)!=1 or not lengths[0].isdigit():return self.send(400,b'Invalid length\n')
  size=int(lengths[0]);
  if size>MAX_BODY:return self.send(413,b'Request too large\n')
  self.connection.settimeout(5)
  body=self.rfile.read(size)
  headers={'Host':'public-application','Content-Length':str(len(body))}
  ct=self.headers.get('Content-Type','application/octet-stream')
  if len(ct)<160:headers['Content-Type']=ct
  con=UnixHTTP('public-application',timeout=5)
  try:
   con.request(self.command,self.path,body,headers);resp=con.getresponse();data=resp.read(MAX_RESPONSE+1)
   if len(data)>MAX_RESPONSE:return self.send(502,b'Application response exceeds limit\n')
   kind=resp.getheader('Content-Type','application/octet-stream').split(';')[0].strip().lower()
   if kind not in ['text/html','text/plain','text/css','application/json','application/octet-stream','image/png','image/jpeg','image/webp']:kind='application/octet-stream'
   # Never relay Set-Cookie, Location, CORS or application-supplied security headers.
   self.send(resp.status if 200<=resp.status<=599 else 502,data,kind)
  except (OSError,http.client.HTTPException,ValueError):self.send(503,b'Public application unavailable\n')
  finally:con.close()
 do_GET=do_HEAD=do_POST=do_PUT=do_PATCH=do_DELETE=do_OPTIONS=handle_app
class Server(http.server.ThreadingHTTPServer):
 daemon_threads=True
 request_queue_size=16
 def process_request(self,request,address):
  # Bound admitted threads independently of hostile response size.
  if not self.slots.acquire(False):request.close();return
  super().process_request(request,address)
 def process_request_thread(self,request,address):
  try:super().process_request_thread(request,address)
  finally:self.slots.release()
import threading
server=Server(('127.0.0.1',PORT),Handler,bind_and_activate=False)
server.socket.close();server.socket=socket.socket(fileno=0);server.server_address=('127.0.0.1',PORT);server.server_name='public-only';server.server_port=PORT
server.slots=threading.BoundedSemaphore(16)
server.serve_forever()
