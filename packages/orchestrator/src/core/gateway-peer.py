#!/usr/bin/python3
"""Read Linux kernel peer credentials from one inherited Unix socket; no IO."""
import json
import socket
import struct

peer = socket.socket(fileno=3)
pid, uid, gid = struct.unpack('3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
print(json.dumps({'pid': pid, 'uid': uid, 'gid': gid}), flush=True)
