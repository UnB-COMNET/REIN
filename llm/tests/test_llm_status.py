# Brief: Tests for llm-status's rule: one model awake at a time besides the pinned ones
# Run: cd llm && python -m unittest discover -s tests

import os
import sys
import unittest
from unittest import mock

LLM = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, LLM)
os.environ.setdefault("MODELS_CONFIG", os.path.join(LLM, "models.yaml"))

import llm_status


class OneAtATimeTest(unittest.TestCase):

    def setUp(self):
        self.client = llm_status.app.test_client()
        self.posted = mock.patch.object(llm_status.requests, "post").start()
        self.addCleanup(mock.patch.stopall)

    # Brief: A GPU with this free memory and the models in these states (the others are down)
    def gpu(self, free_gb, **states):
        mock.patch.object(llm_status, "gpu", lambda: {"total_gb": 32, "used_gb": 32 - free_gb, "free_gb": free_gb}).start()
        mock.patch.object(llm_status, "state", lambda m: next(states.get(i, "down") for i, x in llm_status.MODELS.items() if x is m)).start()

    def models(self):
        return self.client.get("/status").json["models"]

    def test_the_model_awake_gives_its_memory_back_to_the_one_chosen(self):
        self.gpu(0.5, llama="awake", lite="sleeping")
        self.assertTrue(self.models()["lite"]["fits"])   # 3 GB in the 0.5 free plus llama's 4
        self.gpu(0.5, lite="awake", llama="sleeping")
        self.assertEqual(self.models()["llama"]["reason"], "needs 4 GB, 3.5 GB free")

    def test_a_pinned_model_keeps_its_memory(self):
        self.gpu(1, **{"qwen3.6": "awake"}, llama="sleeping")
        self.assertEqual(self.models()["llama"]["reason"], "needs 4 GB, 1 GB free")

    def test_a_model_that_is_not_running_cannot_be_chosen(self):
        self.gpu(20, **{"qwen3.6": "awake"})
        self.assertEqual((self.models()["lite"]["fits"], self.models()["lite"]["reason"]), (False, "not running on the GPU VM"))

    def test_loading_a_model_sleeps_the_others_but_the_pinned(self):
        self.gpu(0.5, **{"qwen3.6": "awake"}, llama="awake", lite="sleeping")
        self.assertEqual(self.client.post("/models/lite/load").status_code, 200)
        self.assertEqual([call.args[0].rsplit(":", 1)[1] for call in self.posted.call_args_list], ["8001/sleep", "8002/wake_up"])


if __name__ == "__main__":
    unittest.main()
