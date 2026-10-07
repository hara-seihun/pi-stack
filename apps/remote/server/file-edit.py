"""Inode-preserving text edits under the supervisor's existing Unix identity."""
import errno
import fcntl
import hashlib
import json
import os
import stat
import sys

MAX_BYTES = 1_048_576


class EditError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
            info.st_ctime_ns, info.st_uid, info.st_gid, info.st_mode, info.st_nlink)


def revision(canonical, info, content):
    digest = hashlib.sha256()
    digest.update(json.dumps([canonical, fingerprint(info)]).encode())
    digest.update(content)
    return digest.hexdigest()


def read_text(fd):
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode):
        raise EditError(415, "Only regular text files can be edited")
    if before.st_mode & (stat.S_ISUID | stat.S_ISGID):
        raise EditError(403, "Files with special permission bits cannot be edited")
    if "security.capability" in os.listxattr(fd):
        raise EditError(403, "Files with executable capabilities cannot be edited")
    if before.st_size > MAX_BYTES:
        raise EditError(413, "Editing is limited to 1 MiB")
    content = os.pread(fd, MAX_BYTES + 1, 0)
    after = os.fstat(fd)
    if fingerprint(before) != fingerprint(after) or len(content) != after.st_size:
        raise EditError(409, "File changed while reading; reload before editing")
    try:
        text = content.decode("utf-8", errors="strict")
    except UnicodeError:
        raise EditError(415, "Only UTF-8 text files can be edited")
    if "\x00" in text:
        raise EditError(415, "Binary files cannot be edited")
    return after, content, text


def open_canonical(canonical):
    # Pin every canonical directory; never follow a replacement symlink during open.
    parts = canonical.split("/")
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=directory)
            os.close(directory)
            directory = child
        fd = os.open(parts[-1], os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK,
                     dir_fd=directory)
        return directory, fd, parts[-1]
    except BaseException:
        os.close(directory)
        raise


def check_target(requested, canonical, directory, name, info):
    try:
        current = os.stat(name, dir_fd=directory, follow_symlinks=False)
        visible = os.stat(requested)
        valid = (os.path.realpath(requested, strict=True) == canonical
                 and stat.S_ISREG(current.st_mode)
                 and (current.st_dev, current.st_ino) == (info.st_dev, info.st_ino)
                 and (visible.st_dev, visible.st_ino) == (info.st_dev, info.st_ino))
    except OSError:
        valid = False
    if not valid:
        raise EditError(409, "File path changed; reload before saving")


def replace_bytes(fd, content):
    offset = 0
    while offset < len(content):
        written = os.pwrite(fd, content[offset:], offset)
        if written <= 0:
            raise OSError(errno.EIO, "Short file write")
        offset += written
    os.ftruncate(fd, len(content))
    os.fsync(fd)


def backup_path(backup_dir, info):
    return os.path.join(backup_dir, f"{info.st_dev}-{info.st_ino}.json")


def save_backup(backup_dir, canonical, info, content):
    try:
        os.mkdir(backup_dir, mode=0o700)
        container = os.open(os.path.dirname(backup_dir), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(container)
        finally:
            os.close(container)
    except FileExistsError:
        pass
    parent = os.open(backup_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    path = backup_path(backup_dir, info)
    name = os.path.basename(path)
    try:
        try:
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=parent)
        except FileExistsError:
            raise EditError(409, "An interrupted save needs recovery before editing: " + path)
        try:
            import base64
            payload = json.dumps({"path": canonical, "device": info.st_dev, "inode": info.st_ino,
                                  "original": base64.b64encode(content).decode("ascii")}).encode()
            replace_bytes(fd, payload)
            os.fsync(parent)
        except BaseException:
            os.unlink(name, dir_fd=parent)
            raise
        finally:
            os.close(fd)
    finally:
        os.close(parent)
    return path


def edit_file(body, backup_dir):
    requested = body.get("path")
    if not isinstance(requested, str) or not requested.startswith("/") or "\x00" in requested:
        raise EditError(400, "Valid absolute file path required")
    operation = body.get("operation")
    if operation not in ("read", "save"):
        raise EditError(400, "Invalid edit operation")
    replacement = None
    if operation == "save":
        if not isinstance(body.get("revision"), str) or len(body["revision"]) != 64:
            raise EditError(400, "An edit revision is required")
        if not isinstance(body.get("content"), str) or "\x00" in body["content"]:
            raise EditError(400, "UTF-8 text content is required")
        try:
            replacement = body["content"].encode("utf-8", errors="strict")
        except UnicodeError:
            raise EditError(400, "UTF-8 text content is required")
        if len(replacement) > MAX_BYTES:
            raise EditError(413, "Editing is limited to 1 MiB")
    canonical = os.path.realpath(requested, strict=True)
    directory, fd, name = open_canonical(canonical)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise EditError(409, "File is being edited; try again after reloading")
        pending = backup_path(backup_dir, os.fstat(fd))
        if os.path.lexists(pending):
            raise EditError(409, "An interrupted save needs recovery before editing: " + pending)
        info, original, text = read_text(fd)
        check_target(requested, canonical, directory, name, info)
        version = revision(canonical, info, original)
        if operation == "read":
            return {"path": requested, "content": text, "revision": version}
        if body["revision"] != version:
            raise EditError(409, "File changed since editing began; reload and reconcile your draft")
        if original == replacement:
            return {"path": requested, "content": text, "revision": version}
        backup = save_backup(backup_dir, canonical, info, original)
        try:
            current, content, _ = read_text(fd)
            check_target(requested, canonical, directory, name, info)
            if revision(canonical, current, content) != version:
                raise EditError(409, "File changed before saving; reload and reconcile your draft")
        except BaseException:
            os.unlink(backup)
            raise
        try:
            replace_bytes(fd, replacement)
            check_target(requested, canonical, directory, name, info)
            saved_info, saved, saved_text = read_text(fd)
            if saved != replacement:
                raise OSError(errno.EIO, "Saved content verification failed")
        except BaseException as failure:
            try:
                replace_bytes(fd, original)
                if os.pread(fd, MAX_BYTES + 1, 0) != original:
                    raise OSError(errno.EIO, "Rollback verification failed")
            except BaseException:
                raise EditError(500, "Save and rollback failed; do not retry. Original retained at " + backup) from failure
            os.unlink(backup)
            raise EditError(500, "Save failed; original content restored. Reload before retrying") from failure
        try:
            os.unlink(backup)
        except OSError:
            raise EditError(500, "Content saved, but backup cleanup failed; reload before further edits. Backup: " + backup)
        return {"path": requested, "content": saved_text,
                "revision": revision(canonical, saved_info, saved)}
    finally:
        os.close(fd)
        os.close(directory)


def main():
    try:
        body = json.loads(sys.stdin.buffer.read(MAX_BYTES * 6 + 4097))
        if not isinstance(body, dict):
            raise EditError(400, "Invalid edit request")
        value = edit_file(body, sys.argv[1])
        result = {"ok": True, "value": value}
    except EditError as failure:
        result = {"ok": False, "status": failure.status, "error": str(failure)}
    except OSError as failure:
        if failure.errno in (errno.EACCES, errno.EPERM, errno.EROFS):
            status, message = 403, "Permission denied"
        elif failure.errno in (errno.ENOENT, errno.ENOTDIR):
            status, message = 404, "File not found"
        elif failure.errno in (errno.ELOOP, errno.EISDIR, errno.ENXIO):
            status, message = 409, "File path is not an editable regular file"
        else:
            status, message = 500, "Could not edit file: " + str(failure)
        result = {"ok": False, "status": status, "error": message}
    except (ValueError, UnicodeError):
        result = {"ok": False, "status": 400, "error": "Invalid edit request"}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
