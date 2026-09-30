# Brief: RAG over NEAT + REIN seeds: numpy matrix + JSON, multilingual e5 embeddings, one example per skeleton

import json
import os
import re

import numpy as np

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
EMBED_MODEL = "intfloat/multilingual-e5-small"
K = int(os.environ.get("RAG_K", "8"))
SEED_BONUS = 0.03   # REIN seeds win near-ties against NEAT, so REIN vocabulary comes first
PER_SKELETON = 1    # diversity: one example per intent shape (best skeleton recall offline)

_model = None
_index = None


# Brief: Canonical Nile: single spaces, ", " between items, qos numbers without leading zeros
# Params:
#   String nile: Nile intent as written
# Return:
#   String with the canonical intent
def normalize_nile(nile: str) -> str:
    nile = re.sub(r"\s*,\s*", ", ", re.sub(r"\s+", " ", nile)).strip()
    return re.sub(r"((?:bandwidth|quota)\('[^']*', ')0*(\d)", r"\1\2", nile)


# Brief: Intent shape with names and values blanked, used for diversity and scoring
# Params:
#   String nile: Nile intent, or an "ASK: ..." answer
# Return:
#   String such as "define intent _: for group('') block protocol('')", or "ASK"
def skeleton(nile: str) -> str:
    if nile.startswith("ASK:"):
        return "ASK"
    return re.sub(r"'[^']*'", "''", re.sub(r"^define intent \w+:", "define intent _:", normalize_nile(nile)))


# Brief: Embeds texts with multilingual-e5-small (ONNX, CPU); loads the model on first use
# Params:
#   list texts: Strings to embed
#   bool query: True for a request, False for an indexed example (e5 uses different prefixes)
# Return:
#   numpy float32 matrix, one normalized row per text
def embed(texts, query=False) -> np.ndarray:
    global _model
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
        matrix = np.load(os.path.join(DATA, "index.npy"))
        with open(os.path.join(DATA, "index.json"), encoding="utf-8") as f:
            meta = json.load(f)
        bonus = SEED_BONUS * np.array([m["source"] == "rein" for m in meta], dtype=np.float32)
        _index = (matrix, meta, bonus)
    return _index


# Brief: Top-k examples for a request, most relevant first, at most PER_SKELETON per shape
# Params:
#   String text: The operator's request
#   int k: Number of examples
# Return:
#   list of dicts {text, nile, skeleton, source ("neat" or "rein"), score}
def retrieve(text: str, k: int = K) -> list:
    matrix, meta, bonus = _load()
    scores = matrix @ embed([text], query=True)[0] + bonus
    picked, per_skeleton = [], {}
    for i in np.argsort(-scores):
        shape = meta[i]["skeleton"]
        if per_skeleton.get(shape, 0) < PER_SKELETON:
            per_skeleton[shape] = per_skeleton.get(shape, 0) + 1
            picked.append({**meta[i], "score": round(float(scores[i]), 3)})
            if len(picked) == k:
                break
    return picked
