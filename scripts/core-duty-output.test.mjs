import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflightResource } from '../deploy/core-host.mjs';

test('only exact declared duty outputs may use unchanged registered parent custody', () => {
  const root=mkdtempSync(join(tmpdir(),'duty-output-'));
  try {
    const output=join(root,'duties.md'), resources={directory:path=>path};
    assert.equal(preflightResource({path:output,kind:'file'},resources,[output]).value.state,'declared-output');
    assert.throws(()=>preflightResource({path:join(root,'key'),kind:'file'},resources,[output]),{code:'ENOENT'});
    const other=join(root,'other');mkdirSync(other);
    assert.equal(preflightResource({path:output,kind:'file'},{directory:()=>other},[output]).ok,false);
    assert.throws(()=>preflightResource({path:output,kind:'directory'},resources,[output]),{code:'ENOENT'});
  } finally {rmSync(root,{recursive:true,force:true});}
});
