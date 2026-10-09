import { describe, expect, it, vi } from "vitest";
import { admissionFor, callerResolver, THREAD_TOKEN_HEADER, type ThreadCaller } from "../src/threads/caller.js";
import type { ManagerQuestionsRequest, ManagerQuestionsResponse, Result, Thread, ThreadApi } from "../src/threads/contracts.js";
import { ThreadDirectory } from "../src/threads/directory.js";
import { createThreadClient, threadHttp } from "../src/threads/http.js";
import { threadTools } from "../src/threads/pi-tools.js";

const authored = {
  question: "**Which route?**\n\nChoose for both child tasks; see [routes](https://example.com/routes).",
  suggestions: ["**North** — both tasks", "South — both tasks"],
  recommendedSuggestionIndex: 0,
};
const requests: ManagerQuestionsRequest[] = [
  { action: "list", threadId: "manager" },
  { action: "answer", threadId: "manager", requestId: "manager:answer", questionId: "child:q", selectedSuggestionIds: ["child:q:0"], text: "Take North", dismissed: false },
  { action: "forward", threadId: "manager", requestId: "manager:forward", questionIds: ["child:q", "other:q"], question: authored },
];
const responseFor = (input: ManagerQuestionsRequest): Result<ManagerQuestionsResponse> => ({ ok: true, value: input.action === "list"
  ? { action: "list", questions: [{ id: "child:q", threadId: "child", managerId: "manager", question: "Where?", suggestions: [{ id: "child:q:0", text: "North" }], createdAt: 1, deadlineAt: 1000, routing: "held" }] }
  : { action: input.action, receipt: { accepted: true, questionId: input.action === "answer" ? input.questionId : "forwarded:q" } } });

function owner(ids: string[]) {
  const calls = {
    list: vi.fn(async (input: { id?: string }) => ({ ok: true, value: { threads: ids.filter(id => id === input.id).map(id => ({ id } as Thread)) } })),
    managerQuestions: vi.fn(async (input: ManagerQuestionsRequest) => responseFor(input)),
  };
  return { api: calls as unknown as ThreadApi, calls };
}

const capability = { issue: (threadId: string) => `token:${threadId}`, verify: (token: string) => token === "token:manager" ? "manager" : undefined };

describe("manager-question transport", () => {
  it.each(requests)("round-trips $action through authorized HTTP, replaying the original identity after a lost response", async input => {
    const local = owner(["manager"]);
    const resolver = callerResolver({ capability });
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const request = new Request(url, init);
      expect(request.headers.get(THREAD_TOKEN_HEADER)).toBe("token:manager");
      const response = await threadHttp(local.api, request, "/v1/threads", admissionFor(resolver, { headers: request.headers }));
      expect(response?.status).toBe(200);
      if (fetcher.mock.calls.length === 1) throw new TypeError("lost response after acceptance");
      return response!;
    });
    const client = createThreadClient("http://owner/v1/threads", fetcher, { token: "token:manager" });
    expect(await client.managerQuestions(input)).toEqual(responseFor(input));
    expect(local.calls.managerQuestions.mock.calls).toEqual([[input], [input]]);
    expect(fetcher.mock.calls[0]![1]?.body).toBe(fetcher.mock.calls[1]![1]?.body);
  });

  it("does not replay a manager mutation without a request identity", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("lost response"));
    const client = createThreadClient("http://owner/v1/threads", fetcher);
    expect(await client.managerQuestions({ ...requests[1], requestId: "" } as ManagerQuestionsRequest)).toMatchObject({ ok: false });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(requests)("routes $action to the manager's execution owner, not the child owner", async input => {
    const childOwner = owner(["child"]), managerOwner = owner(["manager"]);
    const directory = new ThreadDirectory({ id: "local", api: childOwner.api }, [{ id: "peer", api: managerOwner.api }]);
    expect(await directory.managerQuestions(input)).toEqual(responseFor(input));
    expect(childOwner.calls.managerQuestions).not.toHaveBeenCalled();
    expect(managerOwner.calls.managerQuestions).toHaveBeenCalledWith(input);
    expect(await directory.managerQuestions({ ...input, threadId: "missing" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(managerOwner.calls.managerQuestions).toHaveBeenCalledOnce();
  });

  it("keeps local manager access independent of unavailable peer owners", async () => {
    const local = owner(["manager"]), peer = owner([]);
    peer.calls.list.mockRejectedValue(new Error("unavailable peer"));
    const directory = new ThreadDirectory({ id: "local", api: local.api }, [{ id: "peer", api: peer.api }]);
    expect(await directory.managerQuestions(requests[0]!)).toEqual(responseFor(requests[0]!));
    expect(peer.calls.list).not.toHaveBeenCalled();
  });
});

describe("manager-question caller authority", () => {
  it.each(requests)("rejects $action impersonation before calling the owner", async input => {
    const local = owner(["manager"]);
    const resolver = callerResolver({ capability });
    const request = new Request("http://owner/v1/threads/managerQuestions", { method: "POST", headers: { [THREAD_TOKEN_HEADER]: "token:manager" }, body: JSON.stringify({ ...input, threadId: "other-manager" }) });
    const response = await threadHttp(local.api, request, "/v1/threads", admissionFor(resolver, { headers: request.headers }));
    expect(response?.status).toBe(403);
    expect(local.calls.managerQuestions).not.toHaveBeenCalled();
  });

  it("rejects invalid tokens and callers without manager or runtime authority", async () => {
    const resolver = callerResolver({ capability });
    expect(await admissionFor(resolver, { headers: new Headers({ [THREAD_TOKEN_HEADER]: "forged" }) })("managerQuestions", requests[0]!)).toMatchObject({ ok: false, status: 401 });
    for (const caller of [{ kind: "process", uid: 1000 }, { kind: "person", via: "router" }] satisfies ThreadCaller[]) {
      expect(await resolver.admit("managerQuestions", requests[0]!, caller)).toMatchObject({ ok: false, status: 403 });
    }
    for (const caller of [{ kind: "thread", threadId: "manager" }, { kind: "runtime", pid: 1 }, { kind: "service", pid: 2 }] satisfies ThreadCaller[]) {
      expect(await resolver.admit("managerQuestions", requests[0]!, caller)).toEqual({ ok: true, input: requests[0] });
    }
  });
});

describe("manager-question tools", () => {
  it("binds all three tools to self and preserves authored forwarding without transport rewriting", async () => {
    const local = owner(["manager"]);
    const tools = threadTools({ threadId: "manager", cwd: "/work", sessionFile: "/work/session.jsonl", args: [], env: {}, threads: local.api });
    for (const expected of requests) {
      const { action } = expected;
      const payload = action === "list" ? {} : action === "answer"
        ? { questionId: expected.questionId, selectedSuggestionIds: expected.selectedSuggestionIds, text: expected.text, dismissed: expected.dismissed }
        : { questionIds: expected.questionIds, question: expected.question };
      const tool = tools.find(tool => tool.name === `manager_questions_${action}`)!;
      expect(tool).toBeDefined();
      expect(JSON.stringify(tool.parameters)).not.toContain('"threadId"');
      expect(JSON.stringify(tool.parameters)).not.toContain('"requestId"');
      const result = await tool.execute(action, { ...payload, threadId: "other-manager", requestId: "forged", action: "forged" }, new AbortController().signal, undefined, {} as never);
      expect(local.calls.managerQuestions).toHaveBeenLastCalledWith(expected);
      expect(result).toMatchObject({ isError: false, details: responseFor(expected) });
    }
  });
});
