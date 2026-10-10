#!/usr/bin/python3 -I
import os,socket,json,pathlib
P=pathlib.Path
checks={}
for p in ['/home','/root','/run/pi-remote-keys','/var/lib/pi-kenan','/var/lib/pi-remote','/etc/pi-stack','/srv/pi','/run/systemd/private','/run/dbus/system_bus_socket']:
 checks['hidden:'+p]=not os.path.lexists(p)
status=P('/proc/self/status').read_text()
checks['no-new-privileges']='NoNewPrivs:\t1' in status
checks['no-capabilities']='CapEff:\t0000000000000000' in status
checks['private-network']={line.split(':')[0].strip() for line in P('/proc/net/dev').read_text().splitlines()[2:]}=={'lo'}
for port in [2460,8788,8899]:
 try:s=socket.create_connection(('127.0.0.1',port),timeout=1);s.close();checks['no-host-network:'+str(port)]=False
 except OSError:checks['no-host-network:'+str(port)]=True
p=P('/work/state/.probe');p.write_text('public-only');checks['own-state-write']=p.read_text()=='public-only';p.unlink()
checks['no-inherited-control-fds']=all(int(x.name)<3 for x in P('/proc/self/fd').iterdir() if x.name.isdigit() and os.path.exists(x))
print(json.dumps(checks,sort_keys=True));raise SystemExit(0 if all(checks.values()) else 1)
