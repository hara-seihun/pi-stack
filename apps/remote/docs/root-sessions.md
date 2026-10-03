# Root sessions and confidence

A person's Kenan is fully transparent: the person can see every thought, tool argument, tool result,
file view, and delegated prompt their own agent sees. Rooms follow the same rule. `ask_kenan` shows
the request and Root Kenan's chosen reply like any other tool; it never imports Root Kenan's context.

Root sessions run separately, with access to shared memory and private information about several
people. They are invisible to ordinary people because their traces reveal information Kenan holds
in confidence. The reply is the only channel out. Root sessions are never registered as owners in
a person's `ThreadDirectory`, included in inbox/worker lists, or exposed through normal history,
context, transcript-item, image, file, SSE, notification, Voice or export routes. Knowing a root
session ID does not grant access. Normal user and room traces have no withholding, redaction or
buffering.

## Administrator debugging

The machine administrator may inspect root sessions through two explicit router routes:

- `GET /v1/admin/root-sessions`
- `GET /v1/admin/root-sessions/:uuid/transcript`

The router first authenticates its person session, then checks the root-owned person registry for
`machineAdministrator: true` on that authenticated user. Neither a user/name header, a process UID,
nor a person's thread capability grants this authority. The administrator already has raw access
to everything a root trace could reveal. Debugging never merges root sessions into her ordinary
thread directory.

The router constructs a fresh loopback request with a separate root-admin capability; it forwards
no person credential, client admin header, cookie or query parameters. Root verifies that capability
before listing or reading anything. Responses are `no-store`, and upstream redirects are not
followed. Ordinary refusals are independent of whether a named root session exists.

## Configuration and ownership

This is available only with host `oneKenan: true`. The person registry mark is administrator
configuration, not a client preference. Root sessions and keys remain in the root runtime's private
store; never symlink or mount that store into a person-visible directory.

`PI_KENAN_CONFIG` (default `/etc/pi-stack/one-kenan.json`) may set `rootPort` (default `19886`) and
`rootAdminCapabilityFile` (default `/var/lib/pi-kenan/root-admin-capability`). The router's
`PI_KENAN_ROOT_ADMIN_CAPABILITY_FILE` overrides that file path. The capability is 32 random bytes
encoded as 64 hex characters. Provision it readable only by the root router and Root Kenan service,
never person processes/runners; no secret value belongs in docs, command arguments or commits.
Root runtime provisioning owns generating the file and supplying it to the service.

`packages/kenan-root/src/visibility.ts` owns the named administrator predicate, root-admin route
admission, and reply-only response projection. The root service must call `rootAdminAdmission`
before either debug route and return its refusal before any store read. It must not mount an
ordinary thread HTTP server or a generic file/static-server handler. `server/root-debug.ts` owns
the router proxy and `server/router.ts` calls it only after authenticating the person. The root
service's ask boundary authenticates the ordinary person independently and returns only `{reply}`.

Absent the flag, no root service is contacted and today's person routes behave unchanged.

Focused proof:

```
bun test apps/remote/server/root-debug.test.ts apps/remote/server/router.integration.test.ts apps/remote/server/context-display.test.ts apps/remote/server/transcript-items.test.ts
```

These cover forged person/admin/thread claims, root list/history/context/items/images/files/SSE/
exports, explicit authenticated administrator inspection, fixed-route proxying, no-store replies,
and unchanged fully transparent person and room context including `ask_kenan`.
