# Brief: Builds the RAG index, data/index.{npy,json}: a sample of NEAT (data/raw/NEAT.txt, not versioned)
# plus the REIN seeds, embedded with multilingual-e5-small. Also writes data/test.tsv, NEAT pairs kept
# out of the index for eval/run_eval.py. Run it again after editing data/seeds_rein.tsv:
#   python scripts/build_index.py

import json
import os
import random
import re
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from app import rag  # noqa: E402

SEED = 42
TEST_SIZE = 2000    # pairs for the evaluation, never indexed
INDEX_SIZE = 7000   # NEAT is a few hundred templates with the values swapped; a sample covers them


# Brief: NEAT lines ("Nile: ...<TAB>Text: ...") as (text, canonical Nile) with the name set to i1.
# Drops pairs whose Nile carries a number the text never states: those translations are wrong
def load_neat(path):
    with open(path, encoding="utf-8") as f:
        for line in f:
            nile, text = line.rstrip("\n").split("\t")
            nile = re.sub(r"^define intent \w+:", "define intent i1:", rag.normalize_nile(nile[len("Nile: "):]))
            text = text[len("Text: "):].strip().strip('"')
            stated = {n.replace(",", "").lstrip("0") or "0" for n in re.findall(r"\d[\d,]*\d|\d", text)}
            values = re.findall(r"(?:bandwidth|quota)\('[^']*', '([^']*)'", nile)
            if all((v.lstrip("0") or "0") in stated for v in values):
                yield text, nile


def main():
    pairs = list(load_neat(os.path.join(ROOT, "data", "raw", "NEAT.txt")))
    random.Random(SEED).shuffle(pairs)
    test, sample = pairs[:TEST_SIZE], pairs[TEST_SIZE:TEST_SIZE + INDEX_SIZE]

    index = [{"text": t, "nile": n, "source": "neat"} for t, n in sample]
    with open(os.path.join(ROOT, "data", "seeds_rein.tsv"), encoding="utf-8") as f:
        index += [dict(zip(("text", "nile"), line.rstrip("\n").split("\t")), source="rein") for line in f]

    np.save(os.path.join(ROOT, "data", "index.npy"), rag.embed([m["text"] for m in index]))
    with open(os.path.join(ROOT, "data", "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False)
    with open(os.path.join(ROOT, "data", "test.tsv"), "w", encoding="utf-8") as f:
        f.writelines(f"{t}\t{n}\n" for t, n in test)
    print(f"NEAT pairs kept {len(pairs)}; index {len(index)} ({len(index) - len(sample)} REIN seeds); test {len(test)}")


if __name__ == "__main__":
    main()
