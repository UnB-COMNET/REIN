# Brief: Builds data/index.{npy,json} (NEAT sample + REIN seeds) and the held-out data/test.tsv.
# Run it again after editing data/seeds_rein.tsv: python scripts/build_index.py

import collections
import json
import os
import random
import re
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from app import rag  # noqa: E402

TEST_SIZE = 2000        # held out before anything is indexed, stratified by skeleton
PER_SKELETON = 8        # NEAT examples kept per skeleton in the index
SEED = 42


# Brief: NEAT lines ("Nile: ...<TAB>Text: ...") as (text, canonical Nile) with the name set to i1
def load_neat(path):
    with open(path, encoding="utf-8") as f:
        for line in f:
            nile, text = line.rstrip("\n").split("\t")
            nile = re.sub(r"^define intent \w+:", "define intent i1:", rag.normalize_nile(nile[len("Nile: "):]))
            yield text[len("Text: "):].strip().strip('"'), nile


# Brief: Texts about a university that is not in the Nile, and bandwidth/quota numbers the
# text never states (unset pairs carry random ones), teach the model to invent values
def is_noise(text, nile):
    if re.search(r"illinois|urbana", text, re.I):
        return True
    stated = {n.replace(",", "").lstrip("0") or "0" for n in re.findall(r"\d[\d,]*\d|\d", text)}
    values = re.findall(r"(?:bandwidth|quota)\('[^']*', '([^']*)'", nile)
    return any((v.lstrip("0") or "0") not in stated for v in values)


def main():
    rng = random.Random(SEED)
    pairs = list(load_neat(os.path.join(ROOT, "data", "raw", "NEAT.txt")))
    clean = [p for p in pairs if not is_noise(*p)]
    by_shape = collections.defaultdict(list)
    for text, nile in clean:
        by_shape[rag.skeleton(nile)].append((text, nile))

    # Stratified split: one test pair per shape that has spare pairs, the rest proportional
    splittable = [s for s, items in by_shape.items() if len(items) > 1]
    extra = (TEST_SIZE - len(splittable)) / sum(len(by_shape[s]) - 1 for s in splittable)
    test, index = [], []
    for shape in sorted(by_shape):
        items = by_shape[shape]
        rng.shuffle(items)
        n_test = min(len(items) - 1, 1 + round((len(items) - 1) * extra)) if len(items) > 1 else 0
        test += [(t, n, shape) for t, n in items[:n_test]]
        seen, kept = set(), []
        for text, nile in items[n_test:]:
            if text.lower() not in seen:
                seen.add(text.lower())
                kept.append((text, nile))
            if len(kept) == PER_SKELETON:
                break
        index += [{"text": t, "nile": n, "skeleton": shape, "source": "neat"} for t, n in kept]

    with open(os.path.join(ROOT, "data", "seeds_rein.tsv"), encoding="utf-8") as f:
        for line in f:
            text, nile = line.rstrip("\n").split("\t")
            index.append({"text": text, "nile": nile, "skeleton": rag.skeleton(nile), "source": "rein"})

    np.save(os.path.join(ROOT, "data", "index.npy"), rag.embed([m["text"] for m in index]))
    with open(os.path.join(ROOT, "data", "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False)
    with open(os.path.join(ROOT, "data", "test.tsv"), "w", encoding="utf-8") as f:
        f.writelines(f"{t}\t{n}\t{s}\n" for t, n, s in test)

    print(f"NEAT pairs {len(pairs)}, noise dropped {len(pairs) - len(clean)}, skeletons {len(by_shape)}")
    print(f"test {len(test)} pairs over {len({s for *_, s in test})} skeletons; "
          f"index {len(index)} ({sum(m['source'] == 'rein' for m in index)} REIN seeds)")


if __name__ == "__main__":
    main()
