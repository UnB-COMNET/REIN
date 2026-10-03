# Brief: RAG over NEAT and the REIN seeds: the k indexed examples whose text is closest to the request,
# by cosine similarity of multilingual-e5-small embeddings (data/index.npy, built by scripts/build_index.py)

import json
import os
import re
import threading

import numpy as np

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
EMBED_MODEL = "intfloat/multilingual-e5-small"
K = int(os.environ.get("RAG_K", "8"))

_model = None
_model_lock = threading.Lock()
_index = None


# Brief: Canonical Nile: single spaces, ", " between items, qos numbers without leading zeros
# Params:
#   String nile: Nile intent as written
# Return:
#   String with the canonical intent
def normalize_nile(nile: str) -> str:
    nile = re.sub(r"\s*,\s*", ", ", re.sub(r"\s+", " ", nile)).strip()
    return re.sub(r"((?:bandwidth|quota)\('[^']*', ')0*(\d)", r"\1\2", nile)


# Brief: Embeds texts with multilingual-e5-small (ONNX, CPU); loads the model on first use
# Params:
#   list texts: Strings to embed
#   bool query: True for a request, False for an indexed example (e5 uses different prefixes)
# Return:
#   numpy float32 matrix, one normalized row per text
def embed(texts, query=False) -> np.ndarray:
    global _model
    with _model_lock:  # concurrent first requests would register the model twice
        if _model is None:
            from fastembed import TextEmbedding
            from fastembed.common.model_description import ModelSource, PoolingType
            TextEmbedding.add_custom_model(model=EMBED_MODEL, pooling=PoolingType.MEAN, normalization=True,
                                           sources=ModelSource(hf=EMBED_MODEL), dim=384, model_file="onnx/model.onnx")
            _model = TextEmbedding(EMBED_MODEL)
    prefix = "query: " if query else "passage: "  # e5 is trained with these prefixes
    return np.array(list(_model.embed([prefix + t for t in texts])), dtype=np.float32)


def _load():
    global _index
    if _index is None:
        with open(os.path.join(DATA, "index.json"), encoding="utf-8") as f:
            _index = (np.load(os.path.join(DATA, "index.npy")), json.load(f))
    return _index


# Brief: The k indexed examples closest to a request, most similar first
# Params:
#   String text: The operator's request
#   int k: Number of examples
# Return:
#   list of dicts {text, nile, source ("neat" or "rein"), score (cosine similarity)}
def retrieve(text: str, k: int = K) -> list:
    matrix, meta = _load()
    scores = matrix @ embed([text], query=True)[0]
    return [{**meta[i], "score": round(float(scores[i]), 3)} for i in np.argsort(-scores)[:k]]
