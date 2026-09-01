// @ts-check

export function initialRemoteState(){return{
  sessions:[],archivedSessions:[],archivedOlder:[],archivedTotal:0,archivedLoading:false,
  drawerTab:"threads",archiveSupported:false,home:"/",
  selectedId:null,selectedName:"Agent",selectedCwd:"/",selectedState:"STOPPED",selectedActivity:"IDLE",selectedTool:"",
  steeringQueued:0,followUpQueued:0,queuedMessages:[],selectedRevision:0,
  selectionEpoch:0,actionEpoch:0,pendingActions:new Map(),
  lastSeq:0,contextCapturedAt:0,contextEntries:[],pollBusy:false,pollAgain:false,pollController:null,settingsOpen:false,
  syncSeq:0,syncEpoch:"",contextDocument:null,contextSessionId:null,threadViews:new Map(),
  sessionLiveTextDocument:null,sessionLiveThinkingDocument:null,sessionLiveDocumentId:null,
  agentLiveTextDocument:null,agentLiveThinkingDocument:null,agentDocumentRunId:null,
  toolCards:new Map(),userMessageLabels:new Map(),followTail:true,attachments:[],attachmentGeneration:0,
  slashCommands:[],slashCommandsLoading:false,planCards:[],agentModelCounts:new Map(),
  agents:[],agentHosts:[],agentRunning:0,agentRunId:null,agentRun:null,agentError:"",agentHostFailing:false,
  agentExpandedGroups:new Set(),
  machineUsageText:"CPU — · GPU — · RAM — · DISK —",machineUsageColor:"var(--muted)",machineUsageDescription:"CPU — · GPU — · RAM — · DISK —",
  machineControlPending:new Set(),governors:{openai:{},anthropic:{}},threadStarts:[],
};}

/** @param {ReturnType<typeof initialRemoteState>} current @param {any} event */
export function reduceRemoteState(current,event){
  switch(event.type){
    case "patch":return{...current,...event.value};
    case "increment":return{...current,[event.key]:Number(current[event.key]??0)+Number(event.by??1)};
    case "map-set":{const value=new Map(current[event.key]);value.set(event.entry,event.value);return{...current,[event.key]:value};}
    case "map-delete":{const value=new Map(current[event.key]);value.delete(event.entry);return{...current,[event.key]:value};}
    case "map-clear":return{...current,[event.key]:new Map()};
    case "set-add":{const value=new Set(current[event.key]);value.add(event.value);return{...current,[event.key]:value};}
    case "set-delete":{const value=new Set(current[event.key]);value.delete(event.value);return{...current,[event.key]:value};}
    default:throw new Error(`Unknown remote state event ${event.type}`);
  }
}

/** @param {ReturnType<typeof initialRemoteState>} initial @param {Record<string,(payload:any)=>void|Promise<void>>} effects */
export function createRemoteStore(initial,effects={}){
  let current=initial;
  return{
    get state(){return current;},
    dispatch(event){
      current=reduceRemoteState(current,event);
      for(const effect of event.effects??[]){const run=effects[effect.type];if(!run)throw new Error(`Unknown remote effect ${effect.type}`);void run(effect.payload);}
      return current;
    },
  };
}
