import { API } from "../../server/api";
import { resourceUrl } from "./resource-url";

/** The picture URL for a Signal contact, sender or group, or undefined when the backend has none. */
export function messagingAvatarUrl(backendId: string, id: string, version: number | null | undefined): string | undefined {
  return backendId && id && version ? resourceUrl(API.messagingAvatar.path({ backendId, avatarId: id }, { v: version })) : undefined;
}
