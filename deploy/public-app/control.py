#!/usr/bin/python3 -I
"""Martine's fixed two-host public-only operations bridge."""
import os,pwd,sys,json,subprocess,importlib.util
assert os.geteuid()==0 and pwd.getpwnam('martine').pw_uid==1004 and os.environ.get('SUDO_UID')=='1004'
a=sys.argv[1:]
if len(a)<2 or a[0] not in ['gmktec','converge']:raise SystemExit('Usage: pi-stack-public gmktec|converge exec COMMAND...|fetch /PATH|check|deploy|rollback|start|stop|restart|status|sync')
target,op=a[:2];args=a[2:]
if op not in ['exec','fetch','check','deploy','rollback','start','stop','restart','status','sync']:raise SystemExit('operation not admitted')
if (op not in ['exec','fetch'] and args) or (op=='fetch' and (len(args)!=1 or not args[0].startswith('/') or args[0].startswith('//'))) or (op=='exec' and (not args or args[0].startswith('-'))) or len(args)>128 or any(len(x)>4096 for x in args):raise SystemExit('invalid operation arguments')
spec=importlib.util.spec_from_file_location('fixed_public_ops','/usr/local/sbin/pi-stack-public-remote');m=importlib.util.module_from_spec(spec) if spec else None
# extensionless executable has no inferred import loader
if m is None:
 from importlib.machinery import SourceFileLoader
 spec=importlib.util.spec_from_loader('fixed_public_ops',SourceFileLoader('fixed_public_ops','/usr/local/sbin/pi-stack-public-remote'));m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
if target=='gmktec':
 if op=='sync':raise SystemExit('sync is only for converge; gmktec deploy snapshots application')
 raise SystemExit(m.operation({'op':op,'args':args}))
request={'op':'upload' if op=='sync' else op,'args':args}
ssh=['/usr/bin/sudo','-n','-u','kenan','-H','/usr/bin/ssh','-T','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ControlMaster=no','-o','ControlPath=none','-o','ControlPersist=no','converge-kenan','sudo -n /usr/local/sbin/pi-stack-public-remote']
p=subprocess.Popen(ssh,stdin=subprocess.PIPE,env={'PATH':'/usr/bin:/bin'})
p.stdin.write(json.dumps(request).encode()+b'\n');p.stdin.flush()
if op=='sync':
 code=r'''
import tarfile,pathlib,os,sys,io,json
root=pathlib.Path('/work/application');count=0;total=0
with tarfile.open(fileobj=sys.stdout.buffer,mode='w|') as tar:
 for parent,dirs,files in os.walk(root,followlinks=False):
  for n in dirs+files:
   x=pathlib.Path(parent)/n
   if x.is_symlink():raise SystemExit('symlinks not admitted')
  for n in files:
   x=pathlib.Path(parent)/n
   if not x.is_file():raise SystemExit('regular files only')
   count+=1;total+=x.stat().st_size
   if count>20000 or total>256*1024*1024:raise SystemExit('deployment size limit')
   rel=str(x.relative_to(root))
   if rel=='.pi-public-deployment-complete':raise SystemExit('reserved archive member')
   tar.add(x,arcname=rel,recursive=False)
 marker=json.dumps({'files':count,'bytes':total}).encode();m=tarfile.TarInfo('.pi-public-deployment-complete');m.size=len(marker);tar.addfile(m,io.BytesIO(marker))
'''
 try:m.sandbox_child(['/usr/bin/python3','-I','-c',code],stdin=subprocess.DEVNULL,stdout=p.stdin)
 except BaseException:
  p.stdin.close();p.wait();raise
elif op=='exec':
 try:
  while True:
   data=os.read(0,65536)
   if not data:break
   p.stdin.write(data);p.stdin.flush()
 except BrokenPipeError:pass
p.stdin.close();raise SystemExit(p.wait())
