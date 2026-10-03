# Brief: Tests for the policies at the client's switch (edge.py) and their /deploy, /intents and /delete_all

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as deployer
import edge

CLIENT = "192.168.0.2"
HOSTS = {CLIENT: {"locations": [{"elementId": "of:0000000000000004", "port": "3"}]}}


# Stands in for Onos._make_request: records the calls and answers with ONOS's Location headers
class FakeOnos:
    def __init__(self, fail_on=None):
        self.calls, self.fail_on, self.ids = [], fail_on, iter(range(1, 100))

    def _make_request(self, method, path, data=None):
        self.calls.append((method, path, data))
        if path.split("/")[1] == self.fail_on:
            raise Exception("ONOS said no")
        if method == "POST":
            return {"status": 201, "location": f"http://127.0.0.1:8181/onos/v1{path.replace('%3A', ':')}/{next(self.ids)}"}
        return {"status": 204}

    def posted(self, kind):
        return [data for method, path, data in self.calls if method == "POST" and path.startswith(f"/{kind}/")]

    def deleted(self):
        return [path for method, path, _ in self.calls if method == "DELETE"]


class EdgeTest(unittest.TestCase):

    def setUp(self):
        edge._rules.clear()
        self.onos = FakeOnos()

    def apply(self, *items):
        return edge.apply(self.onos, HOSTS, CLIENT, list(items), "intent")

    def test_a_max_bandwidth_is_a_meter_the_client_traffic_goes_through(self):
        rules = self.apply(("set", "bandwidth", ["max", "5", "mbps"]))
        meter, = self.onos.posted("meters")
        flow, = self.onos.posted("flows")
        self.assertEqual(meter["bands"], [{"type": "DROP", "rate": 5000, "burstSize": 0}])
        self.assertEqual(flow["treatment"]["instructions"], [{"type": "METER", "meterId": "1"}, {"type": "OUTPUT", "port": "3"}])
        self.assertIn({"type": "IPV4_DST", "ip": f"{CLIENT}/32"}, flow["selector"]["criteria"])
        self.assertEqual(rules, ["/flows/of%3A0000000000000004/2", "/meters/of%3A0000000000000004/1"])   # the flow first

    def test_a_new_limit_replaces_the_previous_and_unset_removes_it(self):
        first = self.apply(("set", "bandwidth", ["max", "5", "mbps"]))
        self.apply(("set", "bandwidth", ["max", "500", "kbps"]))
        self.assertEqual(self.onos.deleted(), first)
        self.apply(("unset", "bandwidth", ["max", "500", "kbps"]))
        self.assertEqual(len(self.onos.deleted()), 4)
        self.assertEqual(edge.listing(), [])

    def test_a_blocked_protocol_is_dropped_both_ways_until_allowed(self):
        rules = self.apply(("block", "protocol", ["ssh"]))
        for flow in self.onos.posted("flows"):
            self.assertEqual(flow["treatment"]["instructions"], [])
            self.assertIn({"type": "TCP_DST", "tcpPort": 22}, flow["selector"]["criteria"])
        sides = [c["type"] for flow in self.onos.posted("flows") for c in flow["selector"]["criteria"] if c["type"].startswith("IPV4")]
        self.assertEqual(sides, ["IPV4_SRC", "IPV4_DST"])
        self.apply(("allow", "protocol", ["SSH"]))
        self.assertEqual(self.onos.deleted(), rules)

    def test_a_failure_halfway_removes_what_was_installed(self):
        self.onos.fail_on = "flows"
        with self.assertRaises(Exception):
            self.apply(("set", "bandwidth", ["max", "5", "mbps"]))
        self.assertEqual(self.onos.deleted(), ["/meters/of%3A0000000000000004/1"])
        self.assertEqual(edge._rules, {})


class DeployTest(unittest.TestCase):

    def setUp(self):
        edge._rules.clear()
        self.onos = FakeOnos()
        self.client = deployer.app.test_client()
        refresh = mock.patch.object(deployer.topo, "make_network_graph",
                                    side_effect=lambda: deployer.topo.nodes.__setitem__("hosts", HOSTS))
        for patch in (mock.patch.object(deployer, "onos", self.onos), refresh, mock.patch.object(deployer.requests, "delete")):
            patch.start()
            self.addCleanup(patch.stop)

    def deploy(self, action):
        return self.client.post("/deploy", json={"intent": f"define intent q1: for endpoint('{CLIENT}') {action}"})

    def test_a_block_is_listed_until_it_is_allowed(self):
        self.assertEqual(self.deploy("block protocol('udp')").status_code, 200)
        self.assertEqual([i["client_ip"] for i in self.client.get("/intents").json["intents"]], [CLIENT])
        self.assertEqual(self.deploy("allow protocol('udp')").status_code, 200)
        self.assertEqual(self.client.get("/intents").json["intents"], [])

    def test_an_unknown_protocol_or_rate_is_422(self):
        for action in ("block protocol('quic')", "set bandwidth('max', '5', 'mb')", "set bandwidth('max', '0.1', 'bps')"):
            self.assertEqual(self.deploy(action).status_code, 422, action)

    def test_removing_cdn_qoe_forgets_the_client(self):
        deployer._intents_by_client[CLIENT] = {"intent": "add"}
        deployer._server_by_client[CLIENT] = "192.168.0.1"
        with mock.patch.object(deployer.cdn_qoe_installer, "remove_old_flows") as remove:
            r = self.deploy("remove service('cdn-qoe')")
        self.assertEqual((r.status_code, r.json["server_ip"]), (200, "192.168.0.1"))
        remove.assert_called_once_with(self.onos, CLIENT, "192.168.0.1", deployer.cdn_qoe.DEVICE_MAP)
        deployer.requests.delete.assert_called_once_with(f"{deployer.SUPERVISOR_URL}/supervise/{CLIENT}", timeout=3)
        # the supervisor asking again gets nothing, not another client's intent
        self.assertEqual(self.client.post("/deploy/recalculate", json={"client_ip": CLIENT}).status_code, 400)

    def test_delete_all_clears_the_policies(self):
        self.assertEqual(self.deploy("set bandwidth('max', '2', 'mbps')").status_code, 200)
        self.assertEqual(self.client.delete("/delete_all").status_code, 200)
        self.assertEqual(len(self.onos.deleted()), 2)


if __name__ == "__main__":
    unittest.main()
