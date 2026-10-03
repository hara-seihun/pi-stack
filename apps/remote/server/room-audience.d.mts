export function roomAudienceResolver(path: string, custodian?: string): (person: string, threadId: string) => { roomId: string; people: string[] } | undefined;
