const selectors={single:{kind:'exactly-one',flags:['id','path']},bound:{kind:'all',flags:['id','path']}};
export const cliContracts={release:{selector:selectors.single},'retire-growth':{selector:selectors.bound},'growth-status':{selector:selectors.bound}};
export function selectorSyntax(command) {
 const s=cliContracts[command].selector,parts=s.flags.map(key=>'--'+key+' '+key.toUpperCase());
 return s.kind==='exactly-one'?'('+parts.join('|')+')':parts.join(' ');
}
export function selectedArguments(command,values) {
 const contract=cliContracts[command];if(!contract)return {ok:false,error:{code:'invalid-selector-contract',detail:command}};
 const selected=Object.fromEntries(contract.selector.flags.filter(key=>values[key]!==undefined).map(key=>[key,values[key]]));
 const valid=contract.selector.kind==='exactly-one'?Object.keys(selected).length===1:Object.keys(selected).length===contract.selector.flags.length;
 if(!valid||Object.values(selected).some(value=>typeof value!=='string'||value.length===0))return {ok:false,error:{code:'invalid-workspace-selector',detail:command+' requires '+selectorSyntax(command),nextAction:{kind:'correct-arguments',command,selector:contract.selector}}};
 return {ok:true,value:selected};
}
export function futureGrowthAction(record) {
 return {kind:'retire-future-growth-required',steps:[
  {kind:'command',argv:['agent-workspace','measure-capacity','--id',record.id,'--json']},
  {kind:'command',argv:['agent-workspace','growth-status','--id',record.id,'--path',record.path,'--json']},
  {kind:'prepare-disposition',bindingFrom:'growth-status.binding',schema:{type:'object',required:['kind','binding','retainedUse','remainingGrowthBytes','growthWriters','writingLease','reason','ownerEvidence'],properties:{kind:{const:'retire-future-growth'},binding:{type:'object'},retainedUse:{enum:['source','runtime']},remainingGrowthBytes:{const:0},growthWriters:{const:'none'},writingLease:{const:'retire'},reason:{type:'string',minLength:1},ownerEvidence:{type:'string',minLength:1}}},outputs:['dispositionFile','dispositionSha256']},
  {kind:'command-template',argv:['agent-workspace','retire-growth','--id',record.id,'--path',record.path,'--owner',record.owner,'--disposition',{input:'dispositionFile'},'--disposition-sha256',{input:'dispositionSha256'},'--json']},
  {kind:'command',argv:['agent-workspace','growth-status','--id',record.id,'--path',record.path,'--json']},
  {kind:'command-template',argv:['agent-workspace','release','--id',record.id,'--end-retention','--owner',record.owner,'--expected-plan-sha256',{from:'growth-status.binding.planSha256'},'--json']}
 ]};
}
