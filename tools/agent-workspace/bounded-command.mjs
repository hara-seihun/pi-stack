import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

export function boundedCommand(name,args,options) {
 if(!Number.isSafeInteger(options.timeout)||options.timeout<1||!Number.isSafeInteger(options.maxBuffer)||options.maxBuffer<1)return {status:null,error:{code:'INVALID_COMMAND_BUDGET'},stdout:'',stderr:''};
 let directory,out,err;
 try {
  directory=fs.mkdtempSync(path.join(tmpdir(),'workspace-command-'));
  out=fs.openSync(path.join(directory,'stdout'),'wx+',0o600);err=fs.openSync(path.join(directory,'stderr'),'wx+',0o600);
  // Regular output descriptors prevent a grandchild's inherited pipe from extending the parent's timeout.
  const result=spawnSync(name,args,{...options,detached:true,killSignal:'SIGKILL',stdio:['ignore',out,err]});
  if(result.error||result.signal) {
   if(result.pid>0)try{process.kill(-result.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')return {status:null,error:{code:'COMMAND_CESSATION_UNKNOWN',message:error.message},stdout:'',stderr:''};}
  }
  if([out,err].some(fd=>fs.fstatSync(fd).size>options.maxBuffer))return {status:null,error:{code:'COMMAND_OUTPUT_LIMIT'},stdout:'',stderr:''};
  return {...result,stdout:fs.readFileSync(path.join(directory,'stdout'),'utf8'),stderr:fs.readFileSync(path.join(directory,'stderr'),'utf8')};
 }catch(error){return {status:null,error:{code:error.code??'COMMAND_IO_ERROR',message:error.message},stdout:'',stderr:''};}
 finally{if(out!==undefined)fs.closeSync(out);if(err!==undefined)fs.closeSync(err);if(directory!==undefined)fs.rmSync(directory,{recursive:true,force:true});}
}
