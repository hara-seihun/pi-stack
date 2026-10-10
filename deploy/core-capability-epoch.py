"""Resource-only capability retirement proof. Never accepts or resumes model work."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
from core_namespace import absolute, enter, publish, trusted

SNAPSHOT = r'''
import hashlib,json,os,sqlite3,sys
from pathlib import Path
v=json.loads(sys.argv[1]);p=Path(v['databasePath']);s=p.stat()
d=sqlite3.connect('file:'+str(p)+'?mode=ro',uri=True,timeout=1);d.execute('BEGIN')
e=[{'id':r[0],'threadId':r[1],'endedAt':r[2],'outcome':r[3]} for r in d.execute('SELECT id,thread_id,ended_at,outcome FROM thread_execution ORDER BY id')]
if any(r['endedAt'] is None or r['outcome'] not in ['complete','error','cancelled','failed'] for r in e):raise ValueError('original execution has not settled')
t=[{'id':r[0],'reference':json.loads(r[1]).get('runnerReference')} for r in d.execute('SELECT id,metadata FROM thread ORDER BY id')]
d.close()
print(json.dumps({'databaseIdentity':{'dev':str(s.st_dev),'ino':str(s.st_ino)},'executions':e,'threads':t}))
'''

# This program runs in the registered old resource namespace, after its controller detached.
RELEASE = r'''
import fcntl,hashlib,json,os,re,socket,sys
from pathlib import Path
v=json.loads(sys.argv[1]);base=Path(v['socketDir']);controls=base/'thread-runners';sessions=base/'thread-sockets';key=Path(v['keyPath'])
if key.exists() or key.is_symlink():raise ValueError('prior capability key exists; preserve that epoch')
def request(path,value):
 with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
  s.settimeout(5);s.connect(str(path));s.sendall((json.dumps(value)+'\n').encode());b=b''
  while b'\n' not in b:
   chunk=s.recv(65536)
   if not chunk or len(b)>1048576:raise ValueError('native control acknowledgement unavailable')
   b+=chunk
  r=json.loads(b.split(b'\n',1)[0])
  if r.get('ok') is not True:raise ValueError('native control rejected retirement')
  return r
names=set();refs={}
for item in v['threads']:
 ref=item['reference']
 if ref is not None:
  control=Path(ref['control']);session=Path(ref['socketPath'])
  if control.parent!=controls or session.parent!=sessions or not re.fullmatch('[a-f0-9]{16}\\.sock',control.name) or not re.fullmatch('[a-f0-9]{16}\\.[a-f0-9]{16}\\.sock',session.name):raise ValueError('native reference escapes registered boundary')
  names.add(control.name[:16]);refs.setdefault(control.name[:16],set()).add(str(session))
for directory,pattern in [(controls,r'([a-f0-9]{16})\.sock(?:\.lock)?'),(sessions,r'([a-f0-9]{16})\.[a-f0-9]{16}\.sock(?:\.events)?')]:
 if directory.exists():
  for p in directory.iterdir():
   m=re.fullmatch(pattern,p.name)
   if not m:raise ValueError('unrecognized original native resource')
   names.add(m[1])
receipts=[];locks=[]
try:
 for name in sorted(names):
  control=controls/(name+'.sock');lock=Path(str(control)+'.lock')
  try:before=request(control,{'type':'status'})
  except (ConnectionRefusedError,FileNotFoundError):
   fd=os.open(lock,os.O_RDWR|os.O_NOFOLLOW);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);locks.append(fd);s=os.fstat(fd)
   if any(p.name.startswith(name+'.') for p in sessions.iterdir()) if sessions.exists() else False:raise ValueError('native session artifacts remain without an acknowledged control')
   receipts.append({'control':str(control),'kind':'kernel-owner-lease','identity':{'dev':str(s.st_dev),'ino':str(s.st_ino)}});continue
  if type(before.get('pid')) is not int or before.get('activeSessions')!=0 or not isinstance(before.get('threadIds'),list) or before.get('sessions')!=len(before['threadIds']):raise ValueError('native accepted execution still owns capability')
  if set(before['threadIds'])-{t['id'] for t in v['threads']}:raise ValueError('native host owns an undeclared original thread')
  expected={str(sessions/(name+'.'+hashlib.sha256(t.encode()).hexdigest()[:16]+'.sock')) for t in before['threadIds']}|refs.get(name,set())
  if v.get('inspectOnly') and before['sessions']!=0:raise ValueError('native capabilities appeared after retirement proof')
  closes=[]
  for path in sorted([] if v.get('inspectOnly') else expected):
   ack=request(control,{'type':'close','socketPath':path})
   if ack.get('pid')!=before['pid']:raise ValueError('native host identity changed during close')
   closes.append({'socketPath':path,'acknowledgement':ack})
  # Do not request host drain: retain the positive zero-session control as proof.
  after=request(control,{'type':'status'})
  if after.get('pid')!=before['pid'] or after.get('sessions')!=0 or after.get('activeSessions')!=0 or after.get('threadIds')!=[]:raise ValueError('native host has not released all capabilities')
  receipts.append({'control':str(control),'kind':'acknowledged-empty','before':before,'closed':closes,'after':after})
 print(json.dumps({'state':'released','socketDir':str(base),'generations':receipts,'emptyInventory':not names}))
finally:
 for fd in locks:os.close(fd)
'''


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def certify(plan):
    if plan.get('version') != 1 or plan.get('priorCapability') != 'absent-after-drain' or type(plan.get('uid')) is not int or type(plan.get('gid')) is not int or min(plan['uid'], plan['gid']) < 0 or not isinstance(plan.get('owners'), list) or not plan['owners']:
        raise ValueError('explicit missing-key epoch and all original owners required')
    key = absolute(plan['keyPath'])
    source = absolute(plan['nativeCloseSource']['path'])
    code = source.read_text()
    if digest(source) != plan['nativeCloseSource']['sha256'] or not all(word in code for word in ['Cannot close active Pi execution', 'backgroundCommands.size', 'runtime.session.isBashRunning']):
        raise ValueError('original native close must positively refuse active and background work')
    seen = set(); owners = []
    for owner in plan['owners']:
        scope_id = owner['scopeId']
        if not isinstance(scope_id, str) or scope_id in seen:
            raise ValueError('original owner scopes must be unique')
        seen.add(scope_id)
        receipt_path = absolute(owner['detachmentReceiptPath']); receipt = trusted(receipt_path)
        if receipt.get('scopeId') != scope_id or receipt.get('state') != 'detached' or receipt.get('databasePath') != owner['databasePath'] or receipt.get('detachmentEvidence', {}).get('protocol') != 'pi-core-owner-drain-v1' or receipt['detachmentEvidence'].get('exitCode') != 0:
            raise ValueError('positive original controller detachment is required before native retirement')
        observed = json.loads(enter(owner['namespace'], ['/usr/bin/python3', '-c', SNAPSHOT, json.dumps(owner)], plan['uid'], plan['gid']))
        if observed['databaseIdentity'] != receipt['databaseIdentity']:
            raise ValueError('epoch proof must retain exact original database identity')
        released = json.loads(enter(owner['namespace'], ['/usr/bin/python3', '-c', RELEASE, json.dumps({**owner, 'keyPath': str(key), 'threads': observed['threads']})], plan['uid'], plan['gid'], timeout=30))
        owners.append({'scopeId': scope_id, 'detachmentReceipt': {'path': str(receipt_path), 'sha256': digest(receipt_path)}, 'namespace': owner['namespace'], 'databasePath': owner['databasePath'], **observed, 'native': released})
    proof = {'version': 1, 'protocol': 'pi-core-capability-epoch-drained-v1', 'state': 'drained', 'uid': plan['uid'], 'gid': plan['gid'], 'priorKeyPath': str(key), 'owners': owners, 'nativeCloseSource': plan['nativeCloseSource']}
    output = absolute(plan['proofPath']); publish(output, proof)
    return {'ok': True, 'path': str(output), 'sha256': digest(output), 'owners': len(owners)}


def validate(proof, plan):
    if proof.get('version') != 1 or proof.get('protocol') != 'pi-core-capability-epoch-drained-v1' or proof.get('state') != 'drained' or any(proof.get(k) != plan[k] for k in ['uid', 'gid']) or proof.get('priorKeyPath') != plan['keyPath']:
        raise ValueError('capability epoch proof belongs to another identity or key')
    actual = [owner['scopeId'] for owner in proof.get('owners', [])]
    if not actual or sorted(actual) != sorted(plan['ownerScopeIds']) or len(set(actual)) != len(actual):
        raise ValueError('capability epoch must cover every declared original owner')
    source = absolute(proof['nativeCloseSource']['path'])
    if digest(source) != proof['nativeCloseSource']['sha256']:
        raise ValueError('original native close source changed after certification')
    for owner in proof['owners']:
        path = absolute(owner['detachmentReceipt']['path']); receipt = trusted(path)
        if digest(path) != owner['detachmentReceipt']['sha256'] or receipt.get('state') != 'detached' or receipt.get('scopeId') != owner['scopeId']:
            raise ValueError('original owner detachment custody changed')
        current = json.loads(enter(owner['namespace'], ['/usr/bin/python3', '-c', SNAPSHOT, json.dumps(owner)], plan['uid'], plan['gid']))
        if any(current[k] != owner[k] for k in ['databaseIdentity', 'executions', 'threads']):
            raise ValueError('old capability owner changed after retirement proof')
        if owner.get('native', {}).get('state') != 'released':
            raise ValueError('native capability retirement is unconfirmed')
        json.loads(enter(owner['namespace'], ['/usr/bin/python3', '-c', RELEASE, json.dumps({**owner, 'keyPath': plan['keyPath'], 'inspectOnly': True})], plan['uid'], plan['gid'], timeout=30))
    return proof


if __name__ == '__main__':
    import sys
    try:
        if os.geteuid() != 0 or len(sys.argv) != 2:
            raise ValueError('usage: root core-capability-epoch.py ABSOLUTE_ROOT_PLAN')
        print(json.dumps(certify(trusted(absolute(sys.argv[1])))))
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error, __import__('subprocess').SubprocessError) as error:
        print(json.dumps({'ok': False, 'error': {'code': 'capability-epoch-unconfirmed', 'message': str(error)}})); sys.exit(75)
