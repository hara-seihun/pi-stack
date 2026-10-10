#!/usr/bin/python3 -I
import os,pwd,sys,ctypes,json
from pathlib import Path
c=json.loads(Path('/etc/pi-stack/delegations/martine-public.json').read_text());assert os.getuid()==pwd.getpwnam('pi-stack-public-martine').pw_uid==c['uid']
assert c['workspace']=='/srv/pi-public/martine' and c['port']==8899
assert ctypes.CDLL(None).prctl(38,1,0,0,0)==0
args=['/usr/bin/bwrap','--unshare-all','--new-session','--die-with-parent','--cap-drop','ALL','--clearenv',
'--ro-bind','/usr/bin','/usr/bin','--ro-bind','/usr/lib','/usr/lib','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib',
'--tmpfs','/etc','--tmpfs','/tmp','--tmpfs','/run','--proc','/proc','--dev','/dev',
'--setenv','PATH','/usr/local/bin:/usr/bin:/bin','--setenv','LANG','C.UTF-8']
if os.path.isdir('/usr/lib64'):args+=['--ro-bind','/usr/lib64','/usr/lib64','--symlink','usr/lib64','/lib64']
if sys.argv[1:]==['--gateway']:
 # Only systemd supplies the listening socket. No submitted code in this view.
 assert int(os.environ.get('LISTEN_FDS','0'))==1 and int(os.environ.get('LISTEN_PID','0'))==os.getpid()
 os.dup2(3,0,inheritable=True);os.close(3) # bwrap keeps stdin; the sole public listener is not a credential
 args+=['--ro-bind',c['workspace']+'/ingress','/upstream','--ro-bind','/usr/local/libexec/pi-stack-public-gateway','/gateway.py','--chdir','/','--setenv','HOME','/tmp']
 command=['/usr/bin/python3','-I','/gateway.py']
else:
 args+=['--dir','/usr/local/bin','--ro-bind',os.path.realpath('/usr/local/bin/node'),'/usr/local/bin/node',
 '--ro-bind',os.path.realpath('/usr/local/bin/bun'),'/usr/local/bin/bun',
 '--bind',c['workspace'],'/work','--ro-bind','/usr/local/libexec/pi-stack-public-check','/check.py',
 '--chdir','/work/application','--setenv','HOME','/work/state','--setenv','USER','pi-stack-public-martine']
 command=sys.argv[1:] or ['/bin/sh','/work/state/current/run']
os.execve(args[0],args+['--']+command,{'PATH':'/usr/bin:/bin'})
