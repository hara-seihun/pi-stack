#!/usr/bin/python3 -B
import copy
import unittest
from core_worker_environment import bind_worker_gateways


def fixture():
    def scope(id):
        return {'id': id, 'principalId': 'kenan', 'availability': {'kind': 'adopt'},
                'custody': {'uid': 1002}, 'environment': {'PATH': '/usr/bin'}}
    return {'host': '127.0.0.1', 'port': 19181,
            'gatewayTransport': {'kind': 'unix', 'socketDir': '/run/pi-stack/gateways'},
            'gatewayBindings': [{'gatewayId': 'remote-remote:kenan', 'purpose': 'core-ingress',
                'principalId': 'kenan', 'peerUid': 1002, 'scopeIds': ['remote:kenan', 'fleet:kenan']}],
            'scopes': [scope('remote:kenan'), scope('fleet:kenan')]}


class WorkerEnvironment(unittest.TestCase):
    def test_remote_and_related_fleet_use_same_declared_adapter(self):
        config = fixture()
        bind_worker_gateways(config, 0)
        for scope in config['scopes']:
            self.assertEqual(scope['environment'], {'PATH': '/usr/bin', 'PI_CORE_URL': 'http://127.0.0.1:19181',
                'PI_CORE_GATEWAY_SOCKET': '/run/pi-stack/gateways/remote-remote:kenan.sock', 'PI_CORE_GATEWAY_UID': '0'})

    def test_mismatched_uid_or_principal_rejected(self):
        for field, value in [('peerUid', 1000), ('principalId', 'other')]:
            config = fixture(); config['gatewayBindings'][0][field] = value
            with self.assertRaisesRegex(ValueError, 'authority'):
                bind_worker_gateways(config, 0)

    def test_ambiguous_adapter_rejected(self):
        config = fixture(); config['gatewayBindings'].append(copy.deepcopy(config['gatewayBindings'][0]))
        with self.assertRaisesRegex(ValueError, 'ambiguous'):
            bind_worker_gateways(config, 0)

    def test_internal_unbound_scope_never_gets_an_invented_adapter(self):
        config = fixture(); config['gatewayBindings'] = []
        bind_worker_gateways(config, 0)
        self.assertEqual(config['scopes'][0]['environment'], {'PATH': '/usr/bin'})
        config['scopes'][0]['environment']['PI_CORE_URL'] = 'http://127.0.0.1:9'
        with self.assertRaisesRegex(ValueError, 'no admitted'):
            bind_worker_gateways(config, 0)

    def test_unavailable_scope_is_not_made_executable(self):
        config = fixture(); config['scopes'][0]['availability'] = {'kind': 'unavailable'}
        bind_worker_gateways(config, 0)
        self.assertEqual(config['scopes'][0]['environment'], {'PATH': '/usr/bin'})

    def test_ipv6_and_no_ambient_core_selection(self):
        config = fixture(); config['host'] = '::1'
        config['scopes'][0]['environment']['PI_CORE_URL'] = 'http://127.0.0.1:9'
        bind_worker_gateways(config, 0)
        self.assertEqual(config['scopes'][0]['environment']['PI_CORE_URL'], 'http://[::1]:19181')
        config = fixture(); config['host'] = '0.0.0.0'
        with self.assertRaisesRegex(ValueError, 'private Core origin'):
            bind_worker_gateways(config, 0)


if __name__ == '__main__':
    unittest.main()
