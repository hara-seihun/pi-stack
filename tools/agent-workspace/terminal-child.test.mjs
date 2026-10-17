import {test} from 'node:test';import assert from 'node:assert/strict';
const {settledToolOperationIds}=await import(process.env.WORKSPACE_QUEUE_MODULE||'./cache-queue.mjs');
function evidence(){
 const owner={unit:'runtime.service',invocationId:'agent-invocation'},absence={kind:'absent',owner,proof:{kind:'service-invocation-ended',...owner}},original={kind:'execution-interrupted',jobId:'agent',observation:absence};
 const nativeOwner={unit:'bash.service',invocationId:'native-invocation'},ceased={kind:'cgroup-empty',owner:nativeOwner,result:'success',exitCode:0};
 const result={exitCode:0,output:'retained proof',processOutcome:{state:'recorded',cause:'exit',exit:{kind:'exited',code:0},startedAt:100,exitedAt:200}};
 const child={id:'bash',state:'completed',kind:'tool-bash',operation_id:'operation',parent_run:'agent',provider_call:'provider',result,ownership_receipt:nativeOwner,cessation_evidence:ceased};
 const declared={jobId:'bash',state:'completed',kind:'tool-bash',result,ownershipReceipt:nativeOwner,cessationEvidence:ceased};
 const details={phase:'recovered-tool-terminal-observation',error:{code:'outcome_uncertain',retry:'never',resourceId:'operation'},operationId:'operation',originalRunId:'agent',originalOperation:original,children:[declared],knownMaterial:{kind:'completed-original-bash-child',jobId:'bash',exitCode:0,result},replay:false};
 return {candidates:[{id:'operation',state:'uncertain',command_type:'agent.tool',run_id:'agent',provider_call_id:'provider',request_body:{name:'bash'},owner_state:'interrupted',ownership_receipt:owner,cessation_evidence:absence,operation_result:structuredClone(original),tool_result:{isError:true,terminate:false,details}}],children:[structuredClone(child)]};
}
test('exact completed declared Bash child consumes truthful terminal evidence without erasing uncertainty or identity',()=>{const e=evidence(),before=JSON.stringify(e);assert.deepEqual([...settledToolOperationIds(e)],['operation']);assert.equal(JSON.stringify(e),before);});
const paths={
 'undeclared actual child':e=>e.candidates[0].tool_result.details.children=[],
 'missing actual child':e=>e.children=[],
 'extra unknown child':e=>e.children.push({id:'unknown',parent_run:'agent'}),
 'duplicate declaration':e=>e.candidates[0].tool_result.details.children.push(e.candidates[0].tool_result.details.children[0]),
 'live child':e=>e.children[0].state='running',
 'unknown child state':e=>e.children[0].state='unreachable',
 'failed child':e=>e.children[0].state='failed',
 'different provider':e=>e.children[0].provider_call='other',
 'missing provider':e=>e.children[0].provider_call=null,
 'different operation':e=>e.children[0].operation_id='other',
 'different parent':e=>e.children[0].parent_run='other',
 'different canonical assignment':e=>{e.candidates[0].assignment_id='parent';e.children[0].assignment_id='foreign';},
 'different canonical conversation':e=>{e.candidates[0].conversation_id='parent';e.children[0].conversation_id='foreign';},
 'unknown native kind':e=>e.children[0].kind='unknown',
 'missing canonical result':e=>delete e.children[0].result,
 'changed canonical result':e=>e.children[0].result.output='changed',
 'missing canonical owner':e=>delete e.children[0].ownership_receipt,
 'changed canonical owner':e=>e.children[0].ownership_receipt.invocationId='other',
 'missing canonical cessation':e=>delete e.children[0].cessation_evidence,
 'unknown cessation':e=>e.children[0].cessation_evidence.kind='unknown',
 'changed declared owner':e=>e.candidates[0].tool_result.details.children[0].ownershipReceipt.invocationId='other',
 'changed declared result':e=>e.candidates[0].tool_result.details.children[0].result.output='changed',
 'wrong material kind':e=>e.candidates[0].tool_result.details.knownMaterial.kind='unknown',
 'wrong material identity':e=>e.candidates[0].tool_result.details.knownMaterial.jobId='other',
 'wrong material status':e=>e.candidates[0].tool_result.details.knownMaterial.exitCode=1,
 'missing material':e=>delete e.candidates[0].tool_result.details.knownMaterial,
 'unknown terminal phase':e=>e.candidates[0].tool_result.details.phase='unknown',
 'replay':e=>e.candidates[0].tool_result.details.replay=true,
 'original success promoted':e=>e.candidates[0].state='completed',
 'other tool':e=>e.candidates[0].request_body.name='write',
 'terminating tool':e=>e.candidates[0].tool_result.terminate=true,
 'wrong resource':e=>e.candidates[0].tool_result.details.error.resourceId='other',
};
for(const [name,mutate] of Object.entries(paths))test('terminal child protects '+name,()=>{const e=evidence();mutate(e);assert.equal(settledToolOperationIds(e).size,0);});

function referenceEvidence(){const e=evidence(),c=e.candidates[0],d=c.tool_result.details,child=e.children[0];d.toolCallId=c.provider_call_id;delete d.knownMaterial;d.children=[{jobId:child.id,kind:child.kind,state:child.state,cessation:structuredClone(child.cessation_evidence),resultReference:{kind:'bash_job',jobId:child.id}}];return e;}
test('canonical result-reference terminal child is resolved against exact canonical completed native proof',()=>{const e=referenceEvidence(),before=JSON.stringify(e);assert.deepEqual([...settledToolOperationIds(e)],['operation']);assert.equal(JSON.stringify(e),before);});
for(const [name,mutate] of Object.entries(paths).filter(([n])=>!['changed canonical result','changed declared owner','changed declared result','wrong material kind','wrong material identity','wrong material status','missing material'].includes(n)))test('reference child protects '+name,()=>{const e=referenceEvidence();mutate(e);assert.equal(settledToolOperationIds(e).size,0);});
const refChanges={toolCall:d=>d.toolCallId='other',kind:d=>d.children[0].resultReference.kind='product_snapshot',job:d=>d.children[0].resultReference.jobId='other',extraRef:d=>d.children[0].resultReference.unknown=true,missingRef:d=>delete d.children[0].resultReference,cessation:d=>d.children[0].cessation.owner.invocationId='other',mixedResult:d=>d.children[0].result={},mixedOwner:d=>d.children[0].ownershipReceipt={},mixedCessation:d=>d.children[0].cessationEvidence={},mixedMaterial:d=>d.knownMaterial={kind:'completed-original-bash-child'}};
for(const [name,mutate] of Object.entries(refChanges))test('reference child rejects '+name,()=>{const e=referenceEvidence();mutate(e.candidates[0].tool_result.details);assert.equal(settledToolOperationIds(e).size,0);});
for(const change of [r=>r.exitCode=1,r=>r.processOutcome.exit.code=1,r=>r.processOutcome.exitedAt=0,r=>delete r.processOutcome])test('reference still needs canonical successful process '+String(change),()=>{const e=referenceEvidence();change(e.children[0].result);assert.equal(settledToolOperationIds(e).size,0);});
