"""Bind worker clients to declared own-UID Core ingress; never select an ambient bearer."""
import re

FIELDS = ('PI_CORE_URL', 'PI_CORE_GATEWAY_SOCKET', 'PI_CORE_GATEWAY_UID')


def bind_worker_gateways(config, core_uid):
    if not isinstance(core_uid, int) or isinstance(core_uid, bool) or core_uid < 0:
        raise ValueError('worker gateway requires the declared Core Unix UID')
    transport = config['gatewayTransport']
    if transport['kind'] != 'unix':
        if any(any(key in scope['environment'] for key in FIELDS) for scope in config['scopes']):
            raise ValueError('worker gateway environment has no declared Unix transport')
        return
    socket_dir = transport['socketDir']
    if not isinstance(socket_dir, str) or not socket_dir.startswith('/') or socket_dir.endswith('/') or any(atom in ('.', '..') for atom in socket_dir.split('/')):
        raise ValueError('worker gateway socket directory must be canonical and absolute')
    host, port = config['host'], config['port']
    if host not in ('127.0.0.1', '::1') or not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise ValueError('worker gateway requires the declared private Core origin')
    origin = 'http://' + ('[::1]' if host == '::1' else host) + ':' + str(port)
    for scope in config['scopes']:
        if scope['availability']['kind'] == 'unavailable':
            continue
        candidates = [row for row in config['gatewayBindings'] if row['purpose'] == 'core-ingress'
                      and scope['id'] in row['scopeIds']]
        if not candidates:
            if any(key in scope['environment'] for key in FIELDS):
                raise ValueError('worker gateway environment has no admitted scope binding: ' + scope['id'])
            # An internal scope with no client adapter stays explicitly unbound.
            continue
        if len(candidates) != 1:
            raise ValueError('worker gateway scope has ambiguous ingress: ' + scope['id'])
        row = candidates[0]
        if row['principalId'] != scope['principalId'] or row['peerUid'] != scope['custody']['uid']:
            raise ValueError('worker gateway crosses scope Unix/principal authority: ' + scope['id'])
        if not isinstance(row['gatewayId'], str) or not re.fullmatch(r'[a-zA-Z0-9_.:-]+', row['gatewayId']):
            raise ValueError('worker gateway identity is invalid')
        scope['environment'].update({
            'PI_CORE_URL': origin,
            'PI_CORE_GATEWAY_SOCKET': socket_dir + '/' + row['gatewayId'] + '.sock',
            'PI_CORE_GATEWAY_UID': str(core_uid),
        })
