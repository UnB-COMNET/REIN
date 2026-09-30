# Brief: Tests for /deploy validation: Nile syntax (400), executability (422) and the cdn-qoe parse

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as deployer
from classes.onos import Onos

CDN_QOE = "define intent q1: from endpoint('192.168.0.2') add service('cdn-qoe')"


class ParseNileTest(unittest.TestCase):

    def test_cdn_qoe_is_one_operation(self):
        for intent in (CDN_QOE, CDN_QOE.replace("from", "for")):
            ops = Onos(base_url="", ip="").parse_nile(intent)["operations"]
            self.assertEqual(ops, [{"type": "add", "function": "service", "value": "('cdn-qoe')"}])


class DeployValidationTest(unittest.TestCase):

    def setUp(self):
        self.client = deployer.app.test_client()

    def test_garbage_is_400(self):
        r = self.client.post("/deploy", json={"intent": "quero o melhor video"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json["error"], "syntax")
        self.assertEqual((r.json["line"], r.json["column"], r.json["expected"]), (1, 1, ["define"]))

    def test_middlebox_is_422(self):
        r = self.client.post("/deploy", json={"intent": "define intent i1: for group('students') add middlebox('dpi')"})
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.json, {"error": "unsupported", "operation": "add middlebox('dpi')",
                                  "reason": "no middlebox exists in this testbed"})

    def test_cdn_qoe_needs_a_client_endpoint(self):
        r = self.client.post("/deploy", json={"intent": "define intent q1: for group('students') add service('cdn-qoe')"})
        self.assertEqual(r.status_code, 422)

    def test_unknown_host_is_422_after_graph_refresh(self):
        def refresh():
            deployer.topo.nodes["hosts"] = {"192.168.0.3": {}}
        with mock.patch.object(deployer.topo, "make_network_graph", side_effect=refresh), \
             mock.patch.object(deployer.topo, "notify") as notify:
            r = self.client.post("/deploy", json={"intent": CDN_QOE})
        self.assertEqual(r.status_code, 422)
        notify.assert_not_called()

    def test_capabilities_and_grammar(self):
        caps = {c["operation"]: c for c in self.client.get("/capabilities").json["capabilities"]}
        self.assertTrue(caps["add service('cdn-qoe')"]["executable"])
        self.assertIn("start:", self.client.get("/nile/grammar").get_data(as_text=True))


if __name__ == "__main__":
    unittest.main()
