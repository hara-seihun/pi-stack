import hashlib
import json
from pathlib import Path
import runpy
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy'))
MODULE = runpy.run_path(str(ROOT / 'deploy/core-provider-adopt'))
G = MODULE['adopt'].__globals__


class ProviderAdoption(unittest.TestCase):
    def test_positive_closed_fleet_source_preserves_exact_ledger(self):
        with tempfile.TemporaryDirectory() as temporary:
            d = Path(temporary)
            def put(name, value):
                p=d/name;p.write_text(json.dumps(value));return str(p)
            commands=d/'commands.js';commands.write_text('const store = Store.open(ledgerPath()); const retirement = await new Daemon(store, loadConfig()).start(); store.close(); process.exit(retirement.edges.some(edge => edge.state === "error") ? 1 : 0); process.env.PI_ORCHESTRATOR_LEDGER ||')
            ledger=str(d/'ledger.sqlite3');owner={'kind':'fleet','unit':'pi-orchestrator@test.service','statePath':str(d/'state.json'),'sourceProof':{'path':str(d/'daemon.js')},'scopes':[{'receiptPath':str(d/'thread.json')}]}
            owner_path=put('owner.json',owner);seal=hashlib.sha256(json.dumps(owner,sort_keys=True,separators=(',',':')).encode()).hexdigest()
            put('state.json',{'state':'detached','planSha256':seal});put('thread.json',{'state':'detached','detachmentEvidence':{'planSha256':seal,'exitCode':0},'previousOwner':{'identity':'original:1:birth','detachedAt':'2026-10-11T00:00:00Z'}})
            binding=put('bindings.json',{'scopes':[{'id':'fleet:test','oldOwnerUnit':owner['unit'],'environmentReferences':{'PI_ORCHESTRATOR_LEDGER':ledger}}]})
            plan={'version':1,'kind':'fleet-ledger','id':'ledger-test','uid':1000,'gid':1000,'databasePath':ledger,'namespace':{'kind':'host'},'receiptPath':str(d/'receipt.json'),'ownerPlanPath':owner_path,'sourceBindingPath':binding,'ownerScopeId':'fleet:test','commandsSource':{'path':str(commands),'sha256':hashlib.sha256(commands.read_bytes()).hexdigest()}}
            path=put('plan.json',plan)
            prior={k:G[k] for k in ['trusted','identity','publish']}
            try:
                G['trusted']=lambda p:json.loads(Path(p).read_text());G['identity']=lambda p:{'dev':'1','ino':'2'};G['publish']=lambda p,r:Path(p).write_text(json.dumps(r))
                result=MODULE['adopt'](path);self.assertEqual(result['state'],'detached')
                receipt=json.loads((d/'receipt.json').read_text());self.assertEqual(receipt['databasePath'],ledger);self.assertEqual(receipt['providerAdoption']['acceptedCompletionResources'],'retained-independent')
                self.assertTrue(MODULE['adopt'](path)['reconciled'])
                changed=dict(plan,databasePath=str(d/'other.sqlite3'));put('plan.json',changed)
                with self.assertRaises(ValueError):MODULE['adopt'](path)
            finally:G.update(prior)

    def test_nonzero_original_exit_never_seals_store(self):
        with tempfile.TemporaryDirectory() as temporary:
            d=Path(temporary);owner={'kind':'broker','statePath':str(d/'state'),'scopes':[{'receiptPath':str(d/'receipt')}]};raw=json.dumps(owner,sort_keys=True,separators=(',',':'));seal=hashlib.sha256(raw.encode()).hexdigest();(d/'owner').write_text(raw);(d/'state').write_text(json.dumps({'state':'detached','planSha256':seal}));(d/'receipt').write_text(json.dumps({'state':'detached','detachmentEvidence':{'planSha256':seal,'exitCode':1}}))
            old=G['trusted'];G['trusted']=lambda p:json.loads(Path(p).read_text())
            try:
                with self.assertRaises(ValueError):MODULE['acknowledged'](str(d/'owner'),'broker')
            finally:G['trusted']=old

    def test_source_hash_without_store_close_is_not_proof(self):
        with tempfile.TemporaryDirectory() as temporary:
            p=Path(temporary)/'source';p.write_text('Store.open(config.ledgerPath)')
            with self.assertRaises(ValueError):MODULE['source']({'source':{'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}},'source',['store.close();'])

if __name__ == '__main__': unittest.main()
