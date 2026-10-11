from importlib.machinery import SourceFileLoader
from pathlib import Path
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'deploy'))
owner=SourceFileLoader('core_adopt_batch_test',str(Path(__file__).resolve().parents[1]/'deploy/core-adopt-batch')).load_module()

@unittest.skipUnless(os.geteuid()==0,'root-owned migration custody fixture')
class BatchCustody(unittest.TestCase):
    def test_completed_receipt_resumes_without_repeating_transfer_and_detects_mutation(self):
        with tempfile.TemporaryDirectory() as folder:
            b=Path(folder);receipt=b/'receipt.json';item=b/'item.json';plan=b/'plan.json'
            owner.publish(item,{'scopeId':'fixture','adoptionReceiptPath':str(receipt)})
            owner.publish(plan,{'version':1,'statePath':str(b/'state.json'),'entries':[{'operation':'rebind','planPath':str(item)}]})
            calls=[]
            def adopt(value):calls.append(value['scopeId']);owner.publish(receipt,{'state':'detached'});return {'ok':True}
            with patch.object(owner.runpy,'run_path',return_value={'rebind':adopt}):
                self.assertEqual(owner.batch(plan)['receiptCount'],1)
                self.assertEqual(owner.batch(plan)['receiptCount'],1)
                self.assertEqual(calls,['fixture'])
                owner.publish(receipt,{'state':'another-owner'})
                with self.assertRaises(ValueError):owner.batch(plan)

if __name__=='__main__':unittest.main()
