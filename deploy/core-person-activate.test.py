#!/usr/bin/python3 -B
import json, os, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
from importlib.machinery import SourceFileLoader
sys.path.insert(0,str(Path(__file__).parent))
owner=SourceFileLoader('person_activation',str(Path(__file__).with_name('core-person-activate'))).load_module()

@unittest.skipUnless(os.geteuid()==0,'protected root metadata fixture')
class AlreadyAdopted(unittest.TestCase):
    def test_unencrypted_projection_preserves_existing_core_without_rewrite_or_reload(self):
        with tempfile.TemporaryDirectory(prefix='core-person-activation-') as tmp:
            root=Path(tmp);os.chmod(root,0o700);folder=root/'users/root';folder.mkdir(parents=True)
            def save(path,value):path.write_text(json.dumps(value));os.chmod(path,0o600)
            namespace={'kind':'pinned','path':str(root/'namespace'),'mountNamespaceInode':'1'}
            config=root/'core.json';runtime=root/'runtime.json'
            save(config,{'scopes':[{'id':'remote:root','custody':{'uid':0,'namespace':namespace},'availability':{'kind':'adopt'}}]})
            save(runtime,{'namespace':namespace});save(folder/'core-binding.json',{'user':'root','scopeId':'remote:root'})
            before=config.read_bytes();calls=[]
            original_trusted=owner.trusted
            def trusted(path):
                if str(path)=='/var/lib/pi-remote/persons/root.json':return {'user':'root','environment':{}}
                return original_trusted(path)
            with patch.object(owner,'CONFIG',config),patch.object(owner,'RUNTIME',runtime),patch.object(owner,'trusted',trusted),patch.object(owner,'Path',side_effect=lambda *args: folder.parent if args==('/etc/pi-stack/users',) else Path(*args)),patch.object(owner,'mounted_source',side_effect=AssertionError('unencrypted view must not mount/pin')),patch.object(owner,'publish',side_effect=AssertionError('equal adopted projection must not rewrite')),patch.object(owner,'host',side_effect=lambda *args:calls.append(args) or {}),patch.object(owner,'unit_pid',return_value=42),patch.object(owner.os,'kill',side_effect=AssertionError('equal adopted projection must not reload')):
                result=owner.activate('root')
            self.assertEqual(result['state'],'prepared');self.assertEqual(config.read_bytes(),before)
            self.assertEqual([c[1] for c in calls],['bind-person','check'])

if __name__=='__main__':unittest.main()
