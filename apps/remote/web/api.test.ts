import { describe, expect, test } from "bun:test";
import { API } from "../server/api";

describe("shared API routes",()=>{
  test("encodes client paths and query values",()=>{
    expect(API.sessionFiles.path({sessionId:"a/b"},{path:"/tmp/a b.md"})).toBe("/v1/sessions/a%2Fb/files?path=%2Ftmp%2Fa+b.md");
    expect(()=>API.session.path()).toThrow("Missing API path parameter sessionId");
  });

  test("matches the same dynamic routes on the server",()=>{
    expect(API.queueSteer.match("POST","/v1/sessions/session-1/queue/work%2F2/steer")).toEqual({sessionId:"session-1",workId:"work/2"});
    expect(API.queueSteer.match("DELETE","/v1/sessions/session-1/queue/work-2/steer")).toBeNull();
    expect(API.queueHardSteer.match("POST","/v1/sessions/session-1/queue/work%2F2/hard-steer")).toEqual({sessionId:"session-1",workId:"work/2"});
    expect(API.sessionFork.match("POST","/v1/sessions/session-1/fork")).toEqual({sessionId:"session-1"});
    expect(API.session.match("GET","/v1/sessions/session-1/more")).toBeNull();
  });
});
