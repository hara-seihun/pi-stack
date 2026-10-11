# Existing Unix listener dentry recovery

Owner: Pi Stack host custody (`docs/core-host.md`). This finite resource helper exports an O_PATH descriptor for the original filesystem dentry of an already-held AF_UNIX stream listener. It neither evaluates application code nor changes a listener or application state. `/dev/pi-stack-unix-dentry` is root0600 and ioctl `_IO('P',0x71)` additionally requires CAP_SYS_ADMIN; its integer argument is a descriptor already held by the caller, and its result is the new O_PATH descriptor.

Build exact committed source outside a source-only checkout with the running kernel's matching headers:

```
make -C /lib/modules/$(uname -r)/build M=/absolute/protected/source-directory modules
```

For a lost listener, first pin the exact registered process birth/UID and duplicate its original listening FD through pidfd_getfd. Export that duplicate's dentry, then close the device and unload `pi_stack_unix_dentry`. Connecting to `/proc/self/fd/EXPORTED_FD` reaches the original server even when its pathname has been unlinked. Verify SO_PEERCRED against the original registered PID/UID before ordinary status or release requests. Retain both original duplicate and dentry descriptors only for the bounded recovery and close them afterward.

`deploy/core-meet-dentry-drain ROOT_PLAN` captures an explicit cohort's original listening FD/inode and PID/birth/UID. It exports all dentries, connects a status and release channel as each owning UID, and unloads the module before any HTTP request. Preconnected channels prevent an old sibling's common-path cleanup from losing another owner's control. The root-owned plan names the matching kernel/module SHA, existing per-owner source-bound Meet plans, and one protected output path. A UID connector uses a finite child and SCM_RIGHTS; changing only effective UID in the root process does not establish readable own `/proc/self/fd` custody. Every original kernel exit observer is attached before the first release; existing evidence refuses replay. Per-owner proofs retain the ordinary Meet receipt contract plus dentry evidence. This finite helper is not a boot service or prepared-release mutation.

A positive own-runtime status and guarded idle-release acknowledgement still govern retirement. Descriptor recovery is not an idle proof. Do not replace the running kernel, reboot, or infer accepted-work completion from a lost pathname. Keep the source, kernel version, module hash and exported device/inode proof in protected host receipts; do not mutate an immutable prepared release to add this helper.
