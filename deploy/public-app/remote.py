#!/usr/bin/python3 -I
"""Root-owned fixed remote operation bridge; no submitted code before UID drop."""
import os,pwd,sys,json,subprocess,uuid
from pathlib import Path
USER='pi-stack-public-martine';UNIT='pi-stack-martine-public.service'
SNAPSHOT=r'''
import pathlib,os,shutil,uuid,json
p=pathlib.Path('/work');source=p/'application';target=p/'releases'/('release-'+uuid.uuid4().hex)
target.mkdir()
count=0;total=0
for root,dirs,files in os.walk(source,followlinks=False):
 for n in dirs+files:
  x=pathlib.Path(root)/n
  if x.is_symlink():raise SystemExit('symlinks not accepted for deployment')
 for n in dirs:(target/(pathlib.Path(root)/n).relative_to(source)).mkdir()
 for n in files:
  x=pathlib.Path(root)/n
  if not x.is_file():raise SystemExit('only regular files accepted')
  count+=1;total+=x.stat().st_size
  if count>20000 or total>256*1024*1024:raise SystemExit('deployment size limit')
  shutil.copyfile(x,target/x.relative_to(source))
if not (target/'run').is_file():raise SystemExit('run entrypoint missing')
state=p/'state';current=state/'current';previous=state/'previous'
if current.is_symlink():
 tmp=state/('previous-'+uuid.uuid4().hex);tmp.symlink_to(os.readlink(current));os.replace(tmp,previous)
tmp=state/('current-'+uuid.uuid4().hex);tmp.symlink_to('../releases/'+target.name);os.replace(tmp,current)
print(json.dumps({'deployed':target.name,'scope':'public-only'}))
'''
ROLLBACK=r'''
import pathlib,os,uuid,json
p=pathlib.Path('/work/state');prev=p/'previous';cur=p/'current'
if not prev.is_symlink():raise SystemExit('no previous deployment')
old=os.readlink(cur);new=os.readlink(prev)
for name,value in [('current',new),('previous',old)]:
 tmp=p/(name+'-'+uuid.uuid4().hex);tmp.symlink_to(value);os.replace(tmp,p/name)
print(json.dumps({'rolledBack':True,'scope':'public-only'}))
'''
UPLOAD=r'''
import pathlib,tarfile,sys,uuid,os,json
p=pathlib.Path('/work');target=p/'releases'/('release-'+uuid.uuid4().hex);target.mkdir();count=0;total=0;complete=False
with tarfile.open(fileobj=sys.stdin.buffer,mode='r|') as tar:
 for m in tar:
  path=pathlib.PurePosixPath(m.name)
  if path.is_absolute() or '..' in path.parts or not path.parts or len(m.name)>512:raise SystemExit('invalid deployment path')
  if complete:raise SystemExit('unexpected data after completion marker')
  if not (m.isdir() or m.isfile()) or m.size<0:raise SystemExit('links/devices not admitted')
  if m.name=='.pi-public-deployment-complete':
   if not m.isfile() or m.size>1024:raise SystemExit('invalid completion marker')
   marker=json.loads(tar.extractfile(m).read());assert marker=={'files':count,'bytes':total};complete=True;continue
  if m.isdir():raise SystemExit('archive contains unexpected directory records')
  count+=1;total+=m.size
  if count>20000 or total>256*1024*1024:raise SystemExit('deployment size limit')
  dest=target.joinpath(*path.parts)
  if m.isdir():dest.mkdir(parents=True,exist_ok=True);continue
  dest.parent.mkdir(parents=True,exist_ok=True)
  with dest.open('xb') as out:
   src=tar.extractfile(m);left=m.size
   while left:
    chunk=src.read(min(left,65536))
    if not chunk:raise SystemExit('incomplete deployment')
    out.write(chunk);left-=len(chunk)
if not complete or not (target/'run').is_file():raise SystemExit('incomplete deployment or run entrypoint missing')
state=p/'state';current=state/'current'
if current.is_symlink():
 tmp=state/('previous-'+uuid.uuid4().hex);tmp.symlink_to(os.readlink(current));os.replace(tmp,state/'previous')
tmp=state/('current-'+uuid.uuid4().hex);tmp.symlink_to('../releases/'+target.name);os.replace(tmp,current)
print(json.dumps({'deployed':target.name,'scope':'public-only'}))
'''
def bounded_command(command):
 return ['/usr/bin/systemd-run','--unit=pi-stack-public-op-'+uuid.uuid4().hex,'--quiet','--wait','--pipe','--collect','--service-type=exec','--uid='+USER,'--gid='+USER,
  '--property=NoNewPrivileges=yes','--property=CapabilityBoundingSet=', '--property=AmbientCapabilities=',
  '--property=Slice=pi-stack-public-martine.slice','--property=MemoryMax=1G','--property=TasksMax=128','--property=CPUQuota=100%','--property=RuntimeMaxSec=900',
  '--property=KillMode=control-group','--property=TimeoutStopSec=5','--','/usr/local/libexec/pi-stack-public-sandbox',*command]
def drop_exec(command):
 # systemd launches the child directly as the constrained identity before exec.
 a=bounded_command(command);os.execve(a[0],a,{'PATH':'/usr/bin:/bin'})
def sandbox_child(command,stdin=None,stdout=None):
 return subprocess.run(bounded_command(command),env={'PATH':'/usr/bin:/bin'},stdin=stdin,stdout=stdout,timeout=180,check=True)
READY=r'''
import socket,time,json
for i in range(100):
 try:
  s=socket.socket(socket.AF_UNIX);s.settimeout(1);s.connect('/work/ingress/app.sock');s.sendall(b'GET /health HTTP/1.0\r\nHost: public-application\r\n\r\n');data=b''
  while len(data)<65536:
   chunk=s.recv(4096)
   if not chunk:break
   data+=chunk
  line=data.split(b'\r\n',1)[0];s.close()
  if b' 200 ' in line:print(json.dumps({'ready':True,'scope':'public-only'}));break
 except OSError:pass
 time.sleep(.1)
else:raise SystemExit('public application readiness not proven; only public unit affected')
'''
def ready():sandbox_child(['/usr/bin/python3','-I','-c',READY],stdin=subprocess.DEVNULL)
def operation(req):
 assert isinstance(req,dict) and set(req)<= {'op','args'}
 op=req.get('op');a=req.get('args',[])
 assert isinstance(a,list) and all(isinstance(x,str) and len(x)<=4096 and '\0' not in x for x in a) and len(a)<=128
 if op in ['start','stop','restart','status'] and not a:
  result=subprocess.call(['/usr/bin/systemctl','--no-pager',op,UNIT],env={'PATH':'/usr/bin:/bin','SYSTEMD_PAGER':'cat'})
  if result==0 and op in ['start','restart']:ready()
  return result
 if op=='check' and not a:drop_exec(['/usr/bin/python3','-I','/check.py'])
 if op=='fetch' and len(a)==1 and a[0].startswith('/') and not a[0].startswith('//'):
  code="import http.client,socket,sys; c=http.client.HTTPConnection('public-application',timeout=5); c.sock=socket.socket(socket.AF_UNIX); c.sock.settimeout(5); c.sock.connect('/work/ingress/app.sock'); c.request('GET',sys.argv[1],headers={'Host':'public-application'}); r=c.getresponse(); data=r.read(8*1024*1024+1); assert len(data)<=8*1024*1024; sys.stdout.buffer.write(data); c.close(); raise SystemExit(0 if r.status==200 else 1)"
  drop_exec(['/usr/bin/python3','-I','-c',code,a[0]])
 if op=='exec' and a and not a[0].startswith('-'):drop_exec(a)
 if op in ['deploy','rollback','upload'] and not a:
  code={'deploy':SNAPSHOT,'rollback':ROLLBACK,'upload':UPLOAD}[op]
  sandbox_child(['/usr/bin/python3','-I','-c',code],stdin=0 if op=='upload' else subprocess.DEVNULL)
  result=subprocess.call(['/usr/bin/systemctl','restart',UNIT],env={'PATH':'/usr/bin:/bin'})
  if result==0:ready()
  return result
 raise SystemExit('operation not admitted')
if __name__=='__main__':
 assert os.geteuid()==0 and os.environ.get('SUDO_UID')==str(pwd.getpwnam('kenan').pw_uid)
 # Unbuffered read: do not consume the binary upload following the JSON line.
 raw=b''
 while len(raw)<65536:
  x=os.read(0,1)
  if not x or x==b'\n':break
  raw+=x
 else:raise SystemExit('request too large')
 raise SystemExit(operation(json.loads(raw)))
