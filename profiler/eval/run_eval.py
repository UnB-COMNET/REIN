# Brief: Evaluation: models x {zero-shot, fixed few-shot, RAG, RAG + constrained decoding, RAG + regenerate}
# on held-out NEAT pairs and the REIN phrases, scored with the deployer's own validator.
# Usage: python eval/run_eval.py [--models qwen3.6,llama,gemma] [--n 200] [--workers 4]

import argparse
import collections
import csv
import datetime
import os
import random
import re
import statistics
import sys
from concurrent.futures import ThreadPoolExecutor

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.append(os.path.join(ROOT, "..", "deployer"))  # after ROOT: deployer/app.py must not shadow app/
import nile  # noqa: E402  (the deployer's validator: syntax -> 400, not executable -> 422)
from app import graph, inventory, llm, rag  # noqa: E402

MODES = ["zero", "few", "rag", "rag_constrained", "rag_regen"]
# Fixed few-shot: the same 8 examples for every request (4 REIN seeds, 4 NEAT action families)
FIXED_SEEDS = ["Quero a melhor qualidade de vídeo para o cliente 192.168.0.2",
               "Enable the CDN QoE service for host 192.168.0.3", "Melhore o vídeo", "Limite a banda dos alunos a 10 Mbps"]
FIXED_NEAT = [r"set bandwidth\(.*quota\(", r"allow .* start ", r"add middlebox\(", r"^define intent i1: from .* to .* block "]


# Brief: n held-out NEAT pairs (seeded sample of data/test.tsv) plus every REIN phrase
def load_items(n: int, seed: int) -> list:
    with open(os.path.join(ROOT, "data", "test.tsv"), encoding="utf-8") as f:
        test = [line.rstrip("\n").split("\t") for line in f]
    with open(os.path.join(ROOT, "eval", "rein_eval.tsv"), encoding="utf-8") as f:
        rein = [line.rstrip("\n").split("\t") for line in f]
    return ([{"set": "neat", "text": t, "gold": g} for t, g in random.Random(seed).sample(test, n)]
            + [{"set": "rein", "text": t, "gold": g} for t, g in rein])


def fixed_examples() -> list:
    _, meta = rag._load()
    seeds = [next(m for m in meta if m["text"] == t) for t in FIXED_SEEDS]
    neat = [next(m for m in meta if m["source"] == "neat" and re.search(p, m["nile"])) for p in FIXED_NEAT]
    return seeds + neat


# Brief: Comparable form: intent name blanked, lowercase, action items sorted (their order means nothing)
def canon(out: str) -> str:
    if out.startswith("ASK:"):
        return "ASK"
    s = re.sub(r"^define intent \w+:", "define intent _:", rag.normalize_nile(out)).lower()
    m = re.match(r"(.*? (?:unset|set|allow|block|add|remove) )(.*?)((?: start .*)?)$", s)
    return m.group(1) + ", ".join(sorted(re.findall(r"\w+\([^)]*\)", m.group(2)))) + m.group(3) if m else s


# Brief: Intent shape with names and values blanked, e.g. "define intent _: for group('') block protocol('')"
def skeleton(nile: str) -> str:
    return re.sub(r"'[^']*'", "''", nile)


# Brief: Slots as (function, argument index, value) for the slot F1
def slots(out: str) -> collections.Counter:
    if out.startswith("ASK:"):
        return collections.Counter({("ASK",): 1})
    return collections.Counter((fn, i, v.lower()) for fn, args in re.findall(r"(\w+)\(([^)]*)\)", out)
                               for i, v in enumerate(re.findall(r"'([^']*)'", args)))


def f1(pred: collections.Counter, gold: collections.Counter) -> float:
    hit = sum((pred & gold).values())
    return 0.0 if not hit else 2 * hit / (sum(pred.values()) + sum(gold.values()))


# Brief: What the deployer would answer before any ONOS call: None (deployable), 400 or 422 body
def verdict(out: str):
    return None if out.startswith("ASK:") else nile.validate(out)


# Brief: One result row with every metric
def score(item: dict, out: str, seconds: float, calls: int) -> dict:
    v = verdict(out)
    return {**item, "output": out, "seconds": round(seconds, 3), "calls": calls,
            "syntax_ok": v is None or v[0] != 400, "executable": v is None and not out.startswith("ASK:"),
            "exact": canon(out) == canon(item["gold"]), "skeleton": skeleton(canon(out)) == skeleton(canon(item["gold"])),
            "slot_f1": round(f1(slots(out), slots(item["gold"])), 3)}


def reachable(model_id: str) -> bool:
    try:
        return requests.get(llm.MODELS[model_id]["base_url"] + "/models", timeout=5).ok
    except requests.RequestException:
        return False


# Brief: All modes for one model; grounding and retrieval run once, LLM calls in parallel
def run(model_id: str, items: list, workers: int) -> list:
    fixed = fixed_examples()
    for it in items:  # grounding and retrieval once, before the parallel LLM calls
        it["_g"] = graph.ground(it["text"], REIN_INVENTORY) if it["set"] == "rein" else None
        it["_rag"] = rag.retrieve(it["text"])
    public = lambda it: {k: v for k, v in it.items() if not k.startswith("_")}

    def one(mode, it, first=None):
        examples = {"zero": [], "few": fixed}.get(mode, it["_rag"])
        if mode == "rag_regen":
            out, seconds = first["output"], first["seconds"]
            v = verdict(out)
            # Regenerate on what the deployer reports without knowing the gold: a syntax error,
            # or an executable operation written with the wrong scope
            if v and (v[1]["error"] == "syntax" or v[1].get("reason", "").startswith("needs ")):
                out2, s2, _ = graph.generate(model_id, it["text"], it["_g"], examples, graph.rejection(out, v[1]))
                return score(public(it), out2, seconds + s2, 2)
            return score(public(it), out, seconds, 1)
        out, seconds, _ = graph.generate(model_id, it["text"], it["_g"], examples,
                                         constrained=(mode == "rag_constrained"))
        return score(public(it), out, seconds, 1)

    rows = []
    with ThreadPoolExecutor(workers) as pool:
        for mode in MODES:
            if mode == "rag_constrained" and llm.MODELS[model_id].get("shared"):
                print(f"  {model_id} {mode}: skipped (shared server, grammars are never sent to it)")
                continue
            if mode == "rag_regen":
                firsts = {(r["set"], r["text"]): r for r in rows if r["mode"] == "rag"}
                done = list(pool.map(lambda it: one(mode, it, firsts[(it["set"], it["text"])]), items))
            else:
                done = list(pool.map(lambda it: one(mode, it), items))
            rows += [{"model": model_id, "mode": mode, **r} for r in done]
            print(f"  {model_id} {mode}: {len(done)} items")
    return rows


# Brief: Markdown table per (model, mode, set)
def summarize(rows: list) -> str:
    lines = ["| model | mode | set | n | syntax ok | executable* | exact | skeleton | slot F1 | ASK recall | false ASK | latency mean / p95 (s) |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    groups = collections.defaultdict(list)
    for r in rows:
        groups[(r["model"], r["mode"], r["set"])].append(r)
    pct = lambda xs: f"{100 * sum(xs) / len(xs):.1f}%" if xs else "–"
    for (model, mode, s), rs in groups.items():
        asks = [r["output"].startswith("ASK:") for r in rs if r["gold"].startswith("ASK:")]
        false_asks = [r["output"].startswith("ASK:") for r in rs if not r["gold"].startswith("ASK:")]
        secs = sorted(r["seconds"] for r in rs)
        lines.append(f"| {model} | {mode} | {s} | {len(rs)} | {pct([r['syntax_ok'] for r in rs])} | "
                     f"{pct([r['executable'] for r in rs if verdict(r['gold']) is None and not r['gold'].startswith('ASK:')]) if s == 'rein' else '–'} | {pct([r['exact'] for r in rs])} | "
                     f"{pct([r['skeleton'] for r in rs])} | {statistics.mean(r['slot_f1'] for r in rs):.3f} | "
                     f"{pct(asks) if s == 'rein' else '–'} | {pct(false_asks)} | "
                     f"{statistics.mean(secs):.2f} / {secs[int(0.95 * (len(secs) - 1))]:.2f} |")
    return "\n".join(lines)


REIN_INVENTORY = {**inventory.load(os.path.join(ROOT, "eval", "inventory.json")),
                  "capabilities": [{"operation": k, **v} for k, v in nile.CAPABILITIES.items()]}

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", default=",".join(llm.MODELS))
    parser.add_argument("--n", type=int, default=200, help="held-out NEAT pairs (the ~50 REIN phrases are always added)")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    items = load_items(args.n, args.seed)
    out_dir = os.path.join(ROOT, "eval", "results", datetime.datetime.now().strftime("%Y%m%d-%H%M"))
    os.makedirs(out_dir, exist_ok=True)
    rows, not_run = [], []
    for model_id in args.models.split(","):
        if not reachable(model_id):
            not_run.append(model_id)
            print(f"{model_id}: not reachable at {llm.MODELS[model_id]['base_url']}, skipped")
            continue
        print(f"{model_id}: {len(items)} items x {len(MODES)} modes")
        rows += run(model_id, items, args.workers)

    with open(os.path.join(out_dir, "rows.csv"), "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    report = (f"# Profiler evaluation ({datetime.date.today()})\n\n"
              f"NEAT: {args.n} held-out pairs (seed {args.seed}); REIN: {len(items) - args.n} phrases, "
              f"fixed inventory in eval/inventory.json. Syntax and executability come from the deployer's validator.\n\n"
              + summarize(rows) + "\n\n"
              "exact and skeleton ignore the intent name, letter case and the order of action items. "
              "*executable: among REIN phrases whose gold the deployer executes, share of outputs it accepts. "
              "ASK recall: gold ASK answered with ASK; false ASK: gold intent answered with ASK. "
              "rag_constrained is never sent to shared models (qwen3.6).\n")
    if not_run:
        report += f"\nNot run (server unreachable): {', '.join(not_run)}\n"
    with open(os.path.join(out_dir, "summary.md"), "w", encoding="utf-8") as f:
        f.write(report)
    print(report)
    print("rows and summary in", out_dir)
