#!/usr/bin/python3
"""Fixture-only deployment proofs. All service/broker invocations are recorded stubs."""
import json
import os
import pathlib
import subprocess
import tempfile
import unittest

REPO=pathlib.Path(__file__).resolve().parent.parent

class Deployment(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='pi-root-deploy-fixture-')
        self.root=pathlib.Path(self.temp.name)
        self.host=self.root/'host.json'; self.host.write_text('{"fleetUser":"operator","environments":[{"id":"fixture"}]}\n')
        self.old_host=self.host.read_bytes()
        self.people=self.root/'persons'; self.people.mkdir()
        for index,name in enumerate(('alice','bob')):
            home=self.root/name; cipher=home/'cipher'; private=home/'private'; cipher.mkdir(parents=True); private.mkdir()
            (cipher/'original').write_text('owner data')
            person={'version':1,'user':name,'displayName':name,'port':19890+index,'fixtureUid':64000+index,
                'unlock':{'cipherDir':str(cipher),'mountpoint':str(private)},'environment':{}}
            (self.people/f'{name}.json').write_text(json.dumps(person))
        self.broker=self.root/'broker.json'
        self.broker.write_text(json.dumps({'ledgerPath':str(self.root/'ledger.sqlite3'),'authPath':str(self.root/'auth.json'),
            'listeners':[{'principal':'alice','port':19870,'accounts':['account-a'],'models':['openai-codex/model'],'maxInFlight':20}]}))
        self.old_broker=self.broker.read_bytes()
        self.prompt=self.root/'prompt.md'; self.prompt.write_text('Fixed private root prompt')
        self.catalog=self.root/'models.json'; self.catalog.write_text('{"providers":{}}')
        self.bin=self.root/'bin'; self.bin.mkdir(); self.log=self.root/'calls.jsonl'
        stub='''#!/usr/bin/python3
import json,os,sys
with open(os.environ['FIXTURE_CALLS'],'a') as f: f.write(json.dumps([os.path.basename(sys.argv[0]),*sys.argv[1:]])+'\\n')
if os.environ.get('FIXTURE_FAIL') and sys.argv[1:]==['enable','--now',os.environ['FIXTURE_FAIL']]: sys.exit(1)
if os.environ.get('FIXTURE_STOP_FAIL') and sys.argv[1:]==['disable','--now',os.environ['FIXTURE_STOP_FAIL']]: sys.exit(1)
'''
        for name in ('systemctl','node'):
            path=self.bin/name; path.write_text(stub); path.chmod(0o755)
        self.config=self.root/'config.json'
        self.values={'version':1,'hostFile':str(self.host),'personsDir':str(self.people),'brokerSource':str(self.broker),
            'memoryPort':19883,'rootPort':19886,'roomsPort':19884,'rootBrokerPort':19880,'roomsBrokerPort':19882,
            'fixtureUids':{'pi-kenan':65010,'pi-rooms':65011},'node':str(self.bin/'node'),'modelCatalog':str(self.catalog),
            'root':{'provider':'openai-codex','model':'model','thinkingLevel':'high','promptFile':str(self.prompt)}}
        self.config.write_text(json.dumps(self.values))
        self.state=self.root/'transaction'
        self.env={**os.environ,'PATH':str(self.bin)+':'+os.environ['PATH'],'FIXTURE_CALLS':str(self.log)}
    def tearDown(self): self.temp.cleanup()
    def command(self,action,ok=True,**env):
        result=subprocess.run([str(REPO/'deploy/one-kenan'),action,'--fixture','--root',str(self.root),'--config',str(self.config),'--state',str(self.state)],
            env={**self.env,**env},text=True,capture_output=True,timeout=10)
        self.assertEqual(result.returncode==0,ok,result.stderr)
        return result
    def calls(self): return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
    def test_prepare_has_no_host_effects_and_cutover_never_hands_off_user_services(self):
        self.command('prepare')
        self.assertEqual(self.calls(),[]); self.assertEqual(self.host.read_bytes(),self.old_host)
        self.assertFalse((self.root/'etc').exists()); self.assertFalse((self.root/'var').exists())
        self.command('cutover')
        self.assertIs(json.loads(self.host.read_text())['oneKenan'],True)
        self.assertEqual(self.broker.read_bytes(),self.old_broker)
        calls=self.calls()
        self.assertFalse(any(any('pi-remote@' in arg or 'pi-orchestrator@' in arg or 'router.service' in arg for arg in call) for call in calls))
        self.assertFalse(any(call[0] in ('useradd','usermod','chown','nft') for call in calls))
        units=self.root/'etc/systemd/system'
        self.assertIn('User=root',(units/'pi-kenan-custody.service').read_text())
        self.assertIn('User=pi-kenan',(units/'pi-kenan-root.service').read_text())
        room=(units/'pi-rooms.service').read_text()
        self.assertNotIn('JoinsNamespaceOf',room); self.assertNotIn('LoadCredential=kenan-memory-root',room)
        self.assertIn('NoNewPrivileges=yes',room)
        self.assertTrue((units/'pi-remote@alice.service.d/one-kenan.conf').exists())
        broker=json.loads((self.root/'etc/pi-stack/one-kenan-broker.json').read_text())
        self.assertEqual(broker['grantOwner'],'one-kenan'); self.assertEqual([row['principal'] for row in broker['listeners']],['pi-kenan','pi-rooms'])
        auth=json.loads((self.root/'etc/pi-stack/kenan-memory-auth.json').read_text())
        self.assertEqual(auth['uidPersons']['64000'],'alice'); self.assertNotIn('65010',auth['uidPersons'])
        self.assertEqual(len(auth['rootToken']),43)
        self.assertRegex((self.root/'var/lib/pi-kenan/root-admin-capability').read_text().strip(),r'^[a-f0-9]{64}$')
        self.assertIn('/srv/pi/pi-remote/kenan-root/src/main.ts',(units/'pi-kenan-root.service').read_text())
        self.assertIn('/srv/pi/runtime/node_modules/kenan-memory/src/main.ts',(units/'pi-kenan-memory.service').read_text())
        self.assertIn('PI_KENAN_MEMORY_ROOT_TOKEN_FILE=%d/kenan-memory-root',(units/'pi-kenan-root.service').read_text())
        self.assertIn('default:user:65010:r-x',subprocess.check_output(['getfacl','-cpn',str(self.root/'var/lib/pi-remote/one-kenan')],text=True))
        self.assertTrue(all(len(item['token'])>=32 for item in auth['supervisors']))
        self.assertEqual({item['person'] for item in auth['supervisors']},{'alice','bob','pi-rooms'})
        for person in ('alice','bob'):
            self.assertEqual((self.root/person/'cipher/original').read_text(),'owner data')
    def test_rollback_preserves_cipher_and_restores_flag_acl_and_only_additive_services(self):
        before=subprocess.check_output(['getfacl','-cpn',str(self.root/'alice/cipher')],text=True)
        self.command('prepare'); self.command('cutover')
        private=self.root/'var/lib/pi-kenan/custody/keys.json'; private.write_text('encrypted custody fixture')
        self.command('rollback')
        self.assertEqual(self.host.read_bytes(),self.old_host); self.assertEqual(self.broker.read_bytes(),self.old_broker)
        self.assertEqual(private.read_text(),'encrypted custody fixture')
        self.assertTrue((self.root/'var/lib/pi-kenan/root-memory-token').exists())
        self.assertEqual(subprocess.check_output(['getfacl','-cpn',str(self.root/'alice/cipher')],text=True),before)
        self.assertFalse((self.root/'etc/systemd/system/pi-kenan-root.service').exists())
        self.assertEqual(json.loads((self.state/'transaction.json').read_text())['phase'],'rolled-back')
        self.assertTrue(any(call[0]=='node' and 'publishBrokerGrants' in ' '.join(call) and 'one-kenan' in ' '.join(call) for call in self.calls()))
        self.assertFalse(any('pi-remote@' in ' '.join(call) or 'pi-model-broker.service' in call for call in self.calls()))
    def test_partial_failure_rolls_back_before_reporting_failure(self):
        self.command('prepare'); self.command('cutover',ok=False,FIXTURE_FAIL='pi-kenan-root.service')
        self.assertEqual(self.host.read_bytes(),self.old_host)
        self.assertEqual(json.loads((self.state/'transaction.json').read_text())['phase'],'rolled-back')
    def test_failed_stop_retains_privileged_listener_gates_and_config_for_repair(self):
        self.command('prepare'); self.command('cutover')
        self.command('rollback',ok=False,FIXTURE_STOP_FAIL='pi-kenan-root.service')
        self.assertEqual(self.host.read_bytes(),self.old_host)
        self.assertTrue((self.root/'etc/systemd/system/pi-kenan-access.service').exists())
        self.assertNotIn(['systemctl','disable','--now','pi-kenan-access.service'],self.calls())
        self.assertEqual(json.loads((self.state/'transaction.json').read_text())['phase'],'rollback-failed')
        self.command('rollback')
        self.assertEqual(json.loads((self.state/'transaction.json').read_text())['phase'],'rolled-back')
    def test_prompt_is_installed_from_fixed_runtime_when_absent(self):
        source=self.root/'instructions.md'; source.write_text('Trusted published prompt')
        self.prompt.unlink(); self.values['rootPromptSource']=str(source); self.config.write_text(json.dumps(self.values))
        self.command('prepare'); self.command('cutover')
        self.assertEqual(self.prompt.read_text(),'Trusted published prompt')
        self.command('rollback'); self.assertFalse(self.prompt.exists())
    def test_old_switch_schema_and_fixture_escape_are_refused(self):
        self.values['ports']={'alice':19880}; self.config.write_text(json.dumps(self.values))
        self.command('prepare',ok=False); self.assertEqual(self.calls(),[])
        del self.values['ports']; self.values['hostFile']='/etc/pi-stack/host.json'; self.config.write_text(json.dumps(self.values))
        self.command('prepare',ok=False); self.assertEqual(self.calls(),[])
    def test_additive_firewall_never_widens_old_ports(self):
        self.command('prepare'); self.command('cutover')
        config=self.root/'etc/pi-stack/one-kenan-access.json'
        result=subprocess.check_output([str(REPO/'deploy/one-kenan-access'),'apply','--config',str(config),'--print'],text=True)
        self.assertIn('table inet pi_one_kenan',result); self.assertNotIn('pi_user_access',result)
        self.assertIn('tcp dport 19880 meta skuid != { 0, 65010 }',result)
        self.assertIn('tcp dport 19882 meta skuid != { 0, 65011 }',result)
        self.assertIn('tcp dport 19884 meta skuid != { 0 }',result)
        self.assertIn('tcp dport 19886 meta skuid != { 0, 64000, 64001, 65010, 65011 }',result)
        self.assertNotIn('19870',result); self.assertNotIn('19890',result)
    def test_acl_mask_expansion_does_not_reactivate_other_people(self):
        directory=self.root/'alice/cipher'
        subprocess.run(['setfacl','-m','u:62000:rwx,m::r-x',str(directory)],check=True,timeout=2)
        self.command('prepare'); self.command('cutover')
        acl=subprocess.check_output(['getfacl','-cpn',str(directory)],text=True)
        self.assertIn('user:62000:r-x',acl); self.assertIn('user:65010:rwx',acl)

if __name__=='__main__': unittest.main()
