# Brief: Tests for the model the application picks (llm.status) and for intents sent in Nile (graph)
# Run: cd profiler && python -m unittest discover -s tests

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from langgraph.checkpoint.memory import MemorySaver

from app import graph, llm

NILE = "define intent q1: for endpoint('192.168.0.2') add service('cdn-qoe')"


class ModelChoiceTest(unittest.TestCase):

    # Brief: status() on a machine with this free VRAM and these servers answering
    def status(self, free_gb, awake=(), total_gb=None):
        llm._status.clear()
        with mock.patch.object(llm, "awake", lambda m: m["id"] in awake):
            return llm.status(total_gb or free_gb, free_gb)

    def test_the_largest_model_that_fits_the_vram_is_picked(self):
        self.assertEqual(self.status(8)["selected"], "llama")
        self.assertEqual(self.status(3.7)["selected"], "lite")   # a 4 GB card: only the ultra-lite fits

    def test_below_the_smallest_budget_no_model_is_picked(self):
        status = self.status(2)
        self.assertIsNone(status["selected"])
        self.assertEqual(status["models"]["lite"]["reason"], "needs 3 GB, 2 GB free")

    def test_a_server_that_answers_comes_before_starting_one(self):
        self.assertEqual(self.status(0, awake=("qwen3.6",))["selected"], "qwen3.6")
        self.assertEqual(self.status(8, awake=("lite",))["selected"], "lite")

    def test_a_running_local_model_gives_its_memory_back_on_a_switch(self):
        # a 6 GB card with llama loaded: 1.7 GB free, yet the ultra-lite can replace it
        models = self.status(1.7, awake=("llama",), total_gb=6)["models"]
        self.assertTrue(models["lite"]["fits"])
        self.assertEqual(self.status(0.5, awake=("lite",), total_gb=4)["models"]["llama"]["reason"], "needs 4 GB, 3.5 GB free")

    def test_a_machine_without_a_gpu_says_so(self):
        self.assertEqual(self.status(0, awake=("qwen3.6",))["models"]["lite"]["reason"], "needs a GPU with 3 GB")

    def test_the_shared_model_is_never_started_here(self):
        status = self.status(48)
        self.assertEqual((status["selected"], status["models"]["qwen3.6"]["fits"]), ("llama", False))


class NileDirectTest(unittest.TestCase):

    def test_only_an_intent_is_taken_as_nile(self):
        self.assertTrue(graph.is_nile("  define intent q1: for endpoint('192.168.0.2') block protocol('udp')"))
        self.assertFalse(graph.is_nile("Bloqueie UDP no cliente de SP"))

    def test_nile_reaches_the_operator_without_a_model(self):
        workflow = graph.build(MemorySaver())
        config = {"configurable": {"thread_id": "t1"}}
        with mock.patch.object(graph, "generate") as generate, mock.patch.object(graph.rag, "retrieve") as retrieve:
            updates = list(workflow.stream({"text": NILE, "model": None, "nile": NILE}, config, stream_mode="updates"))
        generate.assert_not_called()
        retrieve.assert_not_called()
        self.assertEqual(updates[-1]["__interrupt__"][0].value, {"nile": NILE, "error": None})


if __name__ == "__main__":
    unittest.main()
