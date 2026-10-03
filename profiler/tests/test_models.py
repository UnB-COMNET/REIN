# Brief: Tests for the model the application picks (llm.status) and for intents sent in Nile (graph)
# Run: cd profiler && python -m unittest discover -s tests

import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from langgraph.checkpoint.memory import MemorySaver

from app import graph, llm

NILE = "define intent q1: for endpoint('192.168.0.2') add service('cdn-qoe')"
MODELS_YAML = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "llm", "models.yaml")
# A machine's own models: one that another machine serves
LOCAL = """models:
  - {id: qwen3.6, label: Qwen3.6, model: q, base_url: 'http://gpu:8000/v1', quantization: NVFP4, budget_gb: 25, shared: true}
"""


# Brief: The repo's models.yaml with LOCAL over it, as a machine with a model server on its network has
def config(local: str = LOCAL) -> dict:
    with tempfile.TemporaryDirectory() as folder:
        with open(MODELS_YAML) as source, open(os.path.join(folder, "models.yaml"), "w") as copy:
            copy.write(source.read())
        if local:
            with open(os.path.join(folder, "models.local.yaml"), "w") as own:
                own.write(local)
        return llm.load(os.path.join(folder, "models.yaml"))


class ModelsFileTest(unittest.TestCase):

    def test_the_repo_lists_only_models_rein_starts_here(self):
        self.assertTrue(all(m.get("local") and "127.0.0.1" in m["base_url"] for m in config(local="")["models"]))

    def test_a_machines_own_models_come_first_and_replace_the_same_id(self):
        self.assertEqual([m["id"] for m in config()["models"]], ["qwen3.6", "llama", "lite"])
        own = "models:\n  - {id: lite, label: Mine, model: m, base_url: 'http://gpu:8002/v1', quantization: q, budget_gb: 2}\n"
        self.assertEqual([(m["id"], m["label"]) for m in config(own)["models"]], [("lite", "Mine"), ("llama", "Llama 3.2 3B Instruct")])


class ModelChoiceTest(unittest.TestCase):

    def setUp(self):
        models = config()
        for patch in (mock.patch.object(llm, "CONFIG", models), mock.patch.object(llm, "MODELS", {m["id"]: m for m in models["models"]})):
            patch.start()
            self.addCleanup(patch.stop)

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
