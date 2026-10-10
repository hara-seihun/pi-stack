#!/usr/bin/python3 -I
import subprocess,json,pathlib,http.client,os,time,sys
P=pathlib.Path
results={}
def run(*args,input=None,check=True):
 p=subprocess.run(args,input=input,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=45)
 if check and p.returncode:raise RuntimeError('check command failed: '+str(args[:5])+' exit '+str(p.returncode)+' '+p.stderr.decode()[:300])
 return p
helper=['sudo','-n','-u','martine','sudo','-n','/usr/local/sbin/pi-stack-public']
def op(host,verb,*args):return run(*helper,host,verb,*args)
def remote(command):return run('sudo','-n','-u','kenan','-H','ssh','-o','ControlMaster=no','-o','ControlPath=none','converge-kenan',command)
def request(path='/health',headers={}):
 c=http.client.HTTPConnection('127.0.0.1',8899,timeout=10);c.request('GET',path,headers=headers);r=c.getresponse();body=r.read(8*1024*1024);h=dict(r.getheaders());status=r.status;c.close();return status,h,body
# Tests use only public app content and synthetic headers. Restore on every exit.
app=P('/srv/pi-public/martine/application/app.py');backup=app.read_bytes()
assert backup==P('/var/lib/pi-stack/kenan-actions/martine-production-20261010/app.py').read_bytes(),'Application changed since provisioning; do not overwrite another writer'
fixture=backup.decode().replace("self.send_response(200);self.send_header('Content-Type',kind);", "self.send_response(200);self.send_header('Set-Cookie','test=synthetic');self.send_header('Location','http://127.0.0.1:2460/');self.send_header('Access-Control-Allow-Origin','*');self.send_header('Content-Security-Policy','unsafe');self.send_header('Content-Type',kind);")
try:
 # Actual delegated writer, not a root-only write masquerading as delegation.
 run('sudo','-n','-u','martine','/usr/bin/python3','-I','-c','import pathlib,sys;pathlib.Path("/srv/pi-public/martine/application/app.py").write_bytes(sys.stdin.buffer.read())',input=fixture.encode())
 results['martine-application-write']=app.read_bytes()==fixture.encode()
 op('gmktec','deploy');op('converge','sync')
 for host in ['gmktec','converge']:
  q=json.loads(op(host,'check').stdout);results[host+'-sandbox']=all(q.values())
  results[host+'-exec']=bool(op(host,'exec','/usr/local/bin/node','--version').stdout.strip())
 s,h,b=request();results['local-live-health']=s==200 and json.loads(b)['privateRemote'] is False
 results['response-credentials-redirect-cors-stripped']=all(k not in h for k in ['Set-Cookie','Location','Access-Control-Allow-Origin'])
 results['immutable-csp']='sandbox allow-scripts' in h.get('Content-Security-Policy','') and "connect-src 'none'" in h.get('Content-Security-Policy','')
 for name,headers,expected in [('cookie',{'Cookie':'test=synthetic'},400),('auth',{'Authorization':'synthetic'},400),('origin',{'Origin':'http://private.invalid'},403),('host',{'Host':'private.invalid'},400),('fetch',{'Sec-Fetch-Site':'cross-site'},403),('upgrade',{'Upgrade':'websocket'},400)]:
  results['local-reject-'+name]=request(headers=headers)[0]==expected
 remote_test=r'''python3 - <<'PY'
import http.client,json
checks={}
for name,headers,expected in [('ok',{},200),('cookie',{'Cookie':'test=synthetic'},400),('auth',{'Authorization':'synthetic'},400),('origin',{'Origin':'http://private.invalid'},403),('host',{'Host':'private.invalid'},400),('fetch',{'Sec-Fetch-Site':'cross-site'},403),('upgrade',{'Upgrade':'websocket'},400)]:
 c=http.client.HTTPConnection('127.0.0.1',8899,timeout=10);c.request('GET','/health',headers=headers);r=c.getresponse();h=dict(r.getheaders());b=r.read();checks[name]=r.status==expected
 if name=='ok':checks['stripped']=all(x not in h for x in ['Set-Cookie','Location','Access-Control-Allow-Origin']);checks['csp']='sandbox allow-scripts' in h.get('Content-Security-Policy','');checks['privateRemote']=json.loads(b)['privateRemote'] is False
 c.close()
print(json.dumps(checks))
PY'''
 results['remote-live-and-ingress-negative']=all(json.loads(remote(remote_test).stdout).values())
 for host in ['gmktec','converge']:
  op(host,'stop');op(host,'start');op(host,'restart');op(host,'rollback');op(host,'restart');results[host+'-lifecycle-and-rollback']=True
 for target in [('gmktec','status','--all'),('other','status'),('gmktec','exec','--gateway')]:
  results['reject-'+str(target)]=run(*helper,*target,check=False).returncode!=0
 results['runtime-sudo-denied-local']=run('sudo','-n','-u','pi-stack-public-martine','sudo','-n','/usr/bin/true',check=False).returncode!=0
 results['runtime-sudo-denied-remote']=remote('sudo -n -u pi-stack-public-martine sudo -n /usr/bin/true >/dev/null 2>&1; test $? -ne 0').returncode==0
 code='import os,json;print(json.dumps({p:not os.access(p,os.W_OK) for p in ["/usr/local/sbin/pi-stack-public","/usr/local/libexec/pi-stack-public-sandbox","/usr/local/libexec/pi-stack-public-gateway","/etc/pi-stack/delegations/martine-public.json","/srv/pi/pi-remote","/srv/pi/runtime"]}))'
 results['martine-immutable-and-private-production-writes-denied']=all(json.loads(run('sudo','-n','-u','martine','python3','-I','-c',code).stdout).values())
finally:
 run('sudo','-n','-u','martine','/usr/bin/python3','-I','-c','import pathlib,sys;pathlib.Path("/srv/pi-public/martine/application/app.py").write_bytes(sys.stdin.buffer.read())',input=backup)
 op('gmktec','deploy');op('converge','sync')
results['final-live-public-docs']=request('/')[0]==200 and b'PiStack public documentation' in request('/')[2]
results['final-source-restored']=app.read_bytes()==backup
for host in ['gmktec','converge']:
 results[host+'-credential-free-fetch']=json.loads(op(host,'fetch','/health').stdout)['privateRemote'] is False
 # A fresh cgroup namespace intentionally hides host membership in /proc.
 proc=subprocess.Popen([*helper,host,'exec','/bin/sleep','5'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 witness="units=$(systemctl list-units 'pi-stack-public-op-*.service' --plain --no-legend | awk '{print $1}'); for unit in $units; do systemctl show \"$unit\" --property=Slice --value; done; systemctl show pi-stack-martine-public.service pi-stack-martine-public-gateway.service --property=Slice --value"
 saw=False
 for attempt in range(15):
  time.sleep(.2)
  output=(run('sudo','-n','/bin/sh','-c',witness).stdout if host=='gmktec' else remote('sudo -n /bin/sh -c '+__import__('shlex').quote(witness)).stdout).decode().strip().splitlines()
  output=[x.strip() for x in output if x.strip()]
  if len(output)>=3 and all(x=='pi-stack-public-martine.slice' for x in output):saw=True;break
 proc.communicate(timeout=10)
 results[host+'-aggregate-resource-membership']=saw and proc.returncode==0
results['fetch-host-injection-denied']=run(*helper,'converge','fetch','http://127.0.0.1:2460',check=False).returncode!=0
print(json.dumps(results,indent=2,sort_keys=True));raise SystemExit(0 if all(results.values()) else 1)
