import {expect,test} from "bun:test";
import {RuntimeCapacityQueue} from "./runtime-capacity-queue";

test("waiting threads stay dormant and resume FIFO only up to reported capacity",async()=>{
  let slots=0, probes=0;const resumed:string[]=[];
  const queue=new RuntimeCapacityQueue(async()=>{probes++;return slots;},60_000);
  try {
    for(let i=0;i<150;i++)queue.block(String(i),()=>resumed.push(String(i)));
    await queue.check();await queue.check();
    expect(probes).toBe(2);expect(resumed).toEqual([]);
    slots=2;await queue.check();expect(resumed).toEqual(["0","1"]);
    queue.cancel("2");slots=1;await queue.check();expect(resumed).toEqual(["0","1","3"]);
    expect(queue.has("4")).toBe(true);
  }finally{queue.stop();}
});

test("overlapping probes and a slow control channel cannot restart waiting work",async()=>{
  let resolve!:(slots:number)=>void;let probes=0,resumed=0;
  const queue=new RuntimeCapacityQueue(()=>{probes++;return new Promise<number>(r=>{resolve=r;});},60_000);
  queue.block("one",()=>resumed++);
  const check=queue.check();await queue.check();expect(probes).toBe(1);
  queue.stop();resolve(1);await check;expect(resumed).toBe(0);
});
