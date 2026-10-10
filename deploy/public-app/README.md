# Fixed public application deployment profile

Source custody for the installed Martine public-only lane. See
[the capability and operation contract](../../docs/public-application-delegation.md).
This directory is trusted administrative source, not delegated application input.

The eight Python files are byte-identical to the reviewed installation source at
`/srv/pi-public/delegation-source/martine-20261010`. `identity.json` binds their
bytes, installed executable destinations, configuration and unit identities.
`installation-verification.json` retains the earlier 30-check installation result;
it is not a fresh run or a browser/phone verdict. `adoption-observation.json`
records a separate read-only both-host identity/health observation.

Run the bounded source checks without privileges or dependencies:

```sh
python3 -I deploy/public-app/identity.py source
python3 -I -B -m unittest discover -s deploy/public-app -p 'test_*.py'
```

Read an installed host's identities without changing it, using trusted reviewed
source as the operator (installed unit files are root-readable):

```sh
sudo -n python3 -I deploy/public-app/identity.py installed --target gmktec
# On the remote host, from its reviewed source checkout:
sudo -n python3 -I deploy/public-app/identity.py installed --target converge
```

## Provisioning contract

`install.py` is a fixed, host-specific root provisioning entrypoint. `--remote`
selects Converge; omission selects kenan-server (target ID `gmktec`). It creates
the no-login runtime identity, installs the immutable bridges, writes the config,
sudo policy, units and resource slice, seeds `app.py` when no application exists,
and enables the public application and gateway socket. It needs Python 3,
bubblewrap, systemd, sudo, ACL tools, Node and Bun at its declared absolute paths;
the local host needs the existing `martine` account at UID 1004. The fixed local
bridge uses the existing owner-operated `converge-kenan` SSH route. This directory
neither provisions that identity nor gives its credentials to the delegate.

Only a trusted deployment owner runs this installer after exact-change review.
It is not wired into `deploy/host` or ordinary publication by this adoption.
Re-running it replaces trusted helper/config/unit bytes, but preserves existing
application/state and does not restart an already-active application. Its
`authority` config text identifies the prior installation decision; it is not
an executable approval or a reusable grant for another person or host.

The optional adjacent `docs/` seed is deliberately not copied here: installed
initial public documents came from Pi Stack `5695360c73e2d95bb873afd395dca754ed8de628`.
A new deployment owner must explicitly stage reviewed public documents if it
wants that seed. `app.py` still serves a valid empty documentation page and health
without it. Existing delegated content is never replaced by seeding.

`verify.py` is retained privileged **mutating installation verification**: it
writes a synthetic application fixture, deploys/syncs, exercises lifecycle and
rollback, then restores source. It requires the exact original retained fixture
at `/var/lib/pi-stack/kenan-actions/martine-production-20261010/app.py` and rejects
a changed live application. It is not a source test, read-only audit, routine
check, or safe command to replay over another writer. Use `identity.py` for source
adoption. Reusable future live verification must first gain an explicit
application-writer lease and an identity-bound restoration contract.
