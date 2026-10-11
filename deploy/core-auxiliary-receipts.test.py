#!/usr/bin/python3 -B
import hashlib, json, os, sqlite3, tempfile, unittest
from pathlib import Path
from importlib.machinery import SourceFileLoader
owner=SourceFileLoader('auxiliary_receipts',str(Path(__file__).with_name('core-auxiliary-receipts'))).load_module()

@unittest.skipUnless(os.geteuid()==0,'protected metadata fixtures require root')
class Projection(unittest.TestCase):
    def test_immutable_claim_projection_without_store_writes(self):
        with tempfile.TemporaryDirectory(prefix='core-aux-receipts-') as tmp:
            root=Path(tmp);os.chmod(root,0o700)
            def save(name,value):
                p=root/name;p.write_text(json.dumps(value));os.chmod(p,0o600);return str(p)
            def database(name,tables):
                p=root/name;d=sqlite3.connect(p)
                for t in tables:d.execute('CREATE TABLE '+t+'(id TEXT PRIMARY KEY)')
                d.commit();d.close();return str(p)
            image=database('images.sqlite3',owner.IMAGE_TABLES[:3]);watch=database('threads.sqlite3',owner.WATCH_TABLES[:5])
            def detached(scope,path):
                s=Path(path).stat();return {'version':1,'state':'detached','scopeId':scope,'databasePath':path,'databaseIdentity':{'dev':str(s.st_dev),'ino':str(s.st_ino)},'previousOwner':{'identity':'fixture-owner','detachedAt':'2026-10-10T00:00:00Z'}}
            scope_id='fixture:first';parent=save('parent.json',detached(scope_id,watch));parent_ref={'path':parent,'sha256':owner.digest(parent)}
            aux=save('aux.json',{'phase':'detached','evidence':[{'id':scope_id,'state':'detached','imageTableNames':owner.IMAGE_TABLES,'detached':parent_ref}]})
            image_receipt=detached(scope_id+':images',image);image_receipt['imageAuxiliary']={'path':aux,'sha256':owner.digest(aux)};ip=save('images.json',image_receipt)
            wr=detached(scope_id+':watch',watch);wr['tableSubdivision']={'version':1,'ownerScopeId':scope_id,'ownerAdoptionReceiptPath':parent,'ownerAdoptionReceiptSha256':owner.digest(parent)};wp=save('watch.json',wr)
            config=save('config.json',{'scopes':[{'id':scope_id,'availability':{'kind':'adopt'},'storage':{'adoptionReceiptPath':parent},'resources':[]}],'images':{'registries':[{'scopeId':scope_id,'databasePath':image,'adoptionReceiptPath':ip}]},'duties':{'entries':[{'scopeId':scope_id,'watch':{'kind':'existing','databasePath':watch,'adoptionReceiptPath':wp}}]}})
            before={p:owner.digest(p) for p in [image,watch,ip,wp,parent,aux]}
            directory=root/'claims';output=root/'projected.json'
            result=owner.project(config,str(directory),str(output));self.assertEqual(result['receipts'],2);self.assertFalse(result['storesMutated'])
            self.assertEqual(json.loads((directory/(scope_id+'.images.json')).read_text())['tableNames'],owner.IMAGE_TABLES)
            self.assertEqual(json.loads((directory/(scope_id+'.watch.json')).read_text())['tableNames'],owner.WATCH_TABLES)
            self.assertEqual(owner.project(config,str(directory),str(output)),result)
            self.assertEqual({p:owner.digest(p) for p in before},before)
            Path(aux).write_text('{}')
            with self.assertRaisesRegex(ValueError,'auxiliary hash changed'):owner.project(config,str(directory),str(output))

if __name__=='__main__':unittest.main()
