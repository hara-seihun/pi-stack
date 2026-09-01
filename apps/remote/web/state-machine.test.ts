import { describe, expect, test } from "bun:test";
import { createRemoteStore, initialRemoteState, reduceRemoteState } from "./state-machine.js";

describe("remote reducer and effects",()=>{
  test("replaces state immutably",()=>{
    const initial=initialRemoteState();
    const selected=reduceRemoteState(initial,{type:"patch",value:{selectedId:"thread-1",selectedState:"RUNNING"}});
    expect(selected).not.toBe(initial);
    expect(initial.selectedId).toBeNull();
    expect(selected).toMatchObject({selectedId:"thread-1",selectedState:"RUNNING"});
  });

  test("clones collection state before changing it",()=>{
    const initial=initialRemoteState();
    const changed=reduceRemoteState(initial,{type:"set-add",key:"machineControlPending",value:"thunder"});
    expect(initial.machineControlPending.size).toBe(0);
    expect(changed.machineControlPending).toEqual(new Set(["thunder"]));
  });

  test("runs declared effects after the reducer publishes state",()=>{
    const observations:string[]=[];
    let store:any;
    store=createRemoteStore(initialRemoteState(),{render:()=>observations.push(store.state.drawerTab)});
    store.dispatch({type:"patch",value:{drawerTab:"agents"},effects:[{type:"render"}]});
    expect(observations).toEqual(["agents"]);
  });
});
