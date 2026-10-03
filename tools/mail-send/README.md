# Mail send

Owned SMTP sender with durable action-journal intent and outcome receipts. `pi-mail-send` is the published command; the existing `mail-send` route is replaced only by an explicitly authorized One Kenan cutover and restored by rollback.

Run `pi-mail-send --help`. Credentials are resolved by the existing owner-held password-store route, never copied into the tool or journal. With `oneKenan` absent/false, journal capture is inert. With it enabled, an intent must commit before dispatch; missing SMTP confirmation records an uncertain outcome, not a failed send or permission to retry.

No-network proof:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 tools/mail-send/test_send.py
PYTHONDONTWRITEBYTECODE=1 python3 tools/mail-send/test_send.py --fixture
```

The fixture mocks only SMTP and credential resolution; the sender and journal transport remain real. See [the action journal](../../docs/action-journal.md) and [cutover](../../docs/one-kenan-deployment.md).
