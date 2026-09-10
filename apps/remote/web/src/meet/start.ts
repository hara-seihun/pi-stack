import { API } from "../../../server/api";
import { meetPath, type MeetJoined } from "../../../server/meet/protocol";
import { meetRequest, post } from "./room";

type Request = <T>(path: string, owner: string, init?: RequestInit) => Promise<T>;

export class MeetingStart {
  private pending: { threadRequestId: string; sessionId: string; meetingId: string; threadCreated: boolean } | null = null;
  private starting: Promise<MeetJoined> | null = null;
  constructor(private readonly owner: string, private readonly request: Request = meetRequest) {}

  start(name: string): Promise<MeetJoined> {
    this.starting ??= this.create(name).finally(() => { this.starting = null; });
    return this.starting;
  }

  private async create(name: string): Promise<MeetJoined> {
    const pending = this.pending ??= {
      threadRequestId: crypto.randomUUID(), sessionId: crypto.randomUUID(), meetingId: crypto.randomUUID(), threadCreated: false,
    };
    if (!pending.threadCreated) {
      const { session } = await this.request<{ session: { id: string } }>(API.createSession.path(), this.owner, post({
        requestId: pending.threadRequestId, sessionId: pending.sessionId,
        meetingId: pending.meetingId, model: "astra",
      }));
      if (session.id !== pending.sessionId) throw new Error("Meeting thread creation returned an unexpected identity");
      pending.threadCreated = true;
    }
    const joined = await this.request<MeetJoined>(meetPath(), this.owner, post({
      requestId: pending.meetingId, sessionId: pending.sessionId, name,
    }));
    this.pending = null;
    return joined;
  }
}
