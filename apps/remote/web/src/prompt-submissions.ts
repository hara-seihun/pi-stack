export class PromptSubmissions {
  private readonly owners = new WeakMap<object, Map<string, Promise<void>>>();

  run(owner: object, requestId: string, operation: () => Promise<void>): Promise<void> {
    let submissions = this.owners.get(owner);
    if (!submissions) {
      submissions = new Map();
      this.owners.set(owner, submissions);
    }
    const previous = submissions.get(requestId);
    if (previous) return previous;
    const pending = Promise.resolve().then(operation).finally(() => { submissions.delete(requestId); });
    submissions.set(requestId, pending);
    return pending;
  }
}
