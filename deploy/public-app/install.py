#!/usr/bin/python3 -I
# Trusted additive provisioning; never executes submitted application code as root.
import os,pwd,subprocess,pathlib,json,shutil,sys
P=pathlib.Path
assert os.geteuid()==0
base=P(__file__).parent
remote='--remote' in sys.argv
user='pi-stack-public-martine'
try: pw=pwd.getpwnam(user)
except KeyError:
 subprocess.run(['useradd','--system','--no-create-home','--home-dir','/nonexistent','--shell','/usr/sbin/nologin',user],check=True);pw=pwd.getpwnam(user)
root=P('/srv/pi-public/martine');root.mkdir(parents=True,exist_ok=True)
os.chown(root.parent,0,0);os.chmod(root.parent,0o755)
os.chown(root,0,0);os.chmod(root,0o755)
for d in ['application','state','ingress','releases']:
 p=root/d;p.mkdir(exist_ok=True);os.chown(p,pw.pw_uid,pw.pw_gid);os.chmod(p,0o700 if d=='ingress' else 0o750)
if not remote:
 subprocess.run(['setfacl','-m','u:martine:--x',str(root)],check=True)
 for d in ['application','state','releases']:
  subprocess.run(['setfacl','-m','u:martine:rwx,d:u:martine:rwx,d:u:'+user+':rwx',str(root/d)],check=True)
for name,dest,mode in [
 ('sandbox.py','/usr/local/libexec/pi-stack-public-sandbox',0o755),
 ('gateway.py','/usr/local/libexec/pi-stack-public-gateway',0o755),
 ('check.py','/usr/local/libexec/pi-stack-public-check',0o755),
 ('remote.py','/usr/local/sbin/pi-stack-public-remote',0o755),
 ('control.py','/usr/local/sbin/pi-stack-public',0o755),
]:
 p=P(dest);p.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(base/name,p);os.chown(p,0,0);os.chmod(p,mode)
c={'version':1,'user':user,'uid':pw.pw_uid,'workspace':str(root),'port':8899,'remote':remote,'origin':'http://127.0.0.1:8899','authority':'Hara shared PiStack grant request61f4d9d1; follow-through 2026-10-10','publicationOwner':'cc4604c2-3a9b-4f0a-baab-97ad326678ba','scope':'mutable public-only live application; no private UI, sessions, data, keys or owner execution','privatePlaneUnchanged':True}
P('/etc/pi-stack/delegations').mkdir(parents=True,exist_ok=True)
P('/etc/pi-stack/delegations/martine-public.json').write_text(json.dumps(c,indent=2)+'\n')
os.chmod('/etc/pi-stack/delegations/martine-public.json',0o644)
os.chmod('/etc/pi-stack/delegations',0o755)
P('/etc/sudoers.d/zz-pi-stack-public-deny').write_text(user+' ALL=(ALL:ALL) !ALL\n')
os.chmod('/etc/sudoers.d/zz-pi-stack-public-deny',0o440)
if not remote:
 P('/etc/sudoers.d/pi-stack-martine-public').write_text('martine ALL=(root) NOPASSWD: /usr/local/sbin/pi-stack-public *\n');os.chmod('/etc/sudoers.d/pi-stack-martine-public',0o440)
# Aggregate bounds also cover concurrent delegated CLI/build invocations.
P('/etc/systemd/system/pi-stack-public-martine.slice').write_text('[Unit]\nDescription=Aggregate resource boundary for Martine public application and operations\n[Slice]\nMemoryMax=2G\nTasksMax=256\nCPUQuota=200%\n')
# Private network namespace, public libraries, own workspace and single fixed ingress.
unit='''[Unit]
Description=Martine public-only mutable PiStack application (NOT private Remote)
After=local-fs.target
[Service]
User=pi-stack-public-martine
Group=pi-stack-public-martine
Slice=pi-stack-public-martine.slice
ExecStart=/usr/local/libexec/pi-stack-public-sandbox
Restart=on-failure
RestartSec=2
KillMode=control-group
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/srv/pi-public/martine
PrivateTmp=yes
UMask=0077
MemoryMax=1G
TasksMax=128
CPUQuota=100%
TimeoutStopSec=5
[Install]
WantedBy=multi-user.target
'''
P('/etc/systemd/system/pi-stack-martine-public.service').write_text(unit)
# Same UID is intentionally confined by a distinct bubblewrap gateway view.
gateway='''[Unit]
Description=Immutable credential-free ingress for Martine public-only application
After=pi-stack-martine-public.service
Requires=pi-stack-martine-public-gateway.socket
[Service]
User=pi-stack-public-martine
Group=pi-stack-public-martine
Slice=pi-stack-public-martine.slice
ExecStart=/usr/local/libexec/pi-stack-public-sandbox --gateway
Restart=on-failure
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
MemoryMax=128M
TasksMax=32
CPUQuota=50%
TimeoutStopSec=5
UMask=0077
'''
P('/etc/systemd/system/pi-stack-martine-public-gateway.service').write_text(gateway)
P('/etc/systemd/system/pi-stack-martine-public-gateway.socket').write_text('''[Unit]
Description=Loopback public-only application ingress (distinct from private Remote)
[Socket]
ListenStream=127.0.0.1:8899
NoDelay=true
[Install]
WantedBy=sockets.target
''')
# Seed a genuinely served public documentation application; do not replace later edits.
if not (root/'application/run').exists():
 shutil.copyfile(base/'app.py',root/'application/app.py')
 (root/'application/run').write_text('#!/bin/sh\nexec /usr/bin/python3 -I /work/state/current/app.py\n')
 for p in [root/'application/app.py',root/'application/run']:
  os.chown(p,pw.pw_uid,pw.pw_gid);os.chmod(p,0o750)
 if not remote:
  subprocess.run(['setfacl','-R','-m','u:martine:rwX',str(root/'application')],check=True)
if not (root/'state/current').exists():
 (root/'state/current').symlink_to('../application')
if (base/'docs').exists() and not (root/'application/docs').exists():
 shutil.copytree(base/'docs',root/'application/docs')
 for p in (root/'application/docs').rglob('*'):
  os.chown(p,pw.pw_uid,pw.pw_gid);os.chmod(p,0o750 if p.is_dir() else 0o640)
 if not remote:subprocess.run(['setfacl','-R','-m','u:martine:rwX',str(root/'application/docs')],check=True)
(root/'README.md').write_text((base/'README.md').read_text());os.chmod(root/'README.md',0o644)
subprocess.run(['visudo','-c'],check=True,stdout=subprocess.DEVNULL)
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','enable','--now','pi-stack-martine-public.service','pi-stack-martine-public-gateway.socket'],check=True)
print(json.dumps({'installed':True,'remote':remote,'runtimeUid':pw.pw_uid,'port':8899}))
