# Brief: Profiler workflow: ground -> retrieve -> generate -> confirm (human) -> deploy.
# The LLM only translates or asks; nothing reaches the deployer without the operator's approval

import argparse
import glob
import json
import os
import re
import sys
import unicodedata
from typing import TypedDict

import requests
import yaml
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app import inventory, llm, rag  # noqa: E402

# System prompt; {guidance} holds the selected static skills
PROMPT = """You translate network operator requests into ONE Nile intent for the REIN intent-based networking system.
The user may write in Portuguese or English.

Answer with exactly one line: a Nile intent, or "ASK: <one short question in the user's language>"
when a required entity is missing or ambiguous. Never invent IPs, PoPs or services.

{guidance}

Network inventory (only these values exist):
{inventory}

Services this network executes:
{capabilities}

Examples (most relevant first):
{examples}
{deployer_error}"""

UF_NAMES = {
    "AC": "Acre", "AL": "Alagoas", "AM": "Amazonas", "AP": "Amapá", "BA": "Bahia", "CE": "Ceará",
    "DF": "Distrito Federal", "ES": "Espírito Santo", "GO": "Goiás", "MA": "Maranhão", "MG": "Minas Gerais",
    "MS": "Mato Grosso do Sul", "MT": "Mato Grosso", "PA": "Pará", "PB": "Paraíba", "PE": "Pernambuco",
    "PI": "Piauí", "PR": "Paraná", "RJ": "Rio de Janeiro", "RN": "Rio Grande do Norte", "RO": "Rondônia",
    "RR": "Roraima", "RS": "Rio Grande do Sul", "SC": "Santa Catarina", "SE": "Sergipe", "SP": "São Paulo",
    "TO": "Tocantins",
}
# "para" is left out: it is the Portuguese word for "for"; Pará is matched by its code PA
UF_ALIASES = {**{n: uf for uf, n in UF_NAMES.items() if uf != "PA"},
              "Rio": "RJ", "Minas": "MG", "Brasília": "DF", "Sampa": "SP", "paulista": "SP", "carioca": "RJ",
              "fluminense": "RJ", "mineiro": "MG", "mineira": "MG", "baiano": "BA", "baiana": "BA",
              "capixaba": "ES", "gaúcho": "RS", "gaúcha": "RS"}
# Off by default: vLLM constrained decoding with nile.gbnf, for the evaluation (never for shared models)
CONSTRAINED = os.environ.get("CONSTRAINED_DECODING", "false").lower() == "true"
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "nile.gbnf")) as f:
    GRAMMAR = f.read()
VIDEO = re.compile(r"v[ií]deo|stream|qoe|cdn|buffer|trav|congel|resolu|pixel|\b(?:4k|[0-9]{3,4}p|hd)\b", re.I)
IP = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")


def _load_skills() -> dict:
    skills = {}
    for path in sorted(glob.glob(os.path.join(os.path.dirname(os.path.abspath(__file__)), "skills", "*", "SKILL.md"))):
        with open(path, encoding="utf-8") as f:
            _, front, body = f.read().split("---", 2)
        skills[yaml.safe_load(front)["name"]] = body.strip()
    return skills


SKILLS = _load_skills()


def _fold(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()


# Brief: Inventory plus what the request points at: PoPs by code, state name or demonym, and IPs
# Params:
#   String text: The operator's request
#   dict inv: Inventory (inventory.get()), or None for a request outside REIN (NEAT campus)
# Return:
#   dict inventory with "mentions", e.g. ["SP (São Paulo) -> client 192.168.0.2"], or None
def ground(text: str, inv: dict) -> dict:
    if inv is None:
        return None
    folded, ufs = _fold(text), []
    for alias, uf in sorted(UF_ALIASES.items(), key=lambda a: -len(a[0])):
        pattern = rf"\b{re.escape(_fold(alias))}\b"
        if re.search(pattern, folded):
            ufs.append(uf)
            folded = re.sub(pattern, " ", folded)
    ufs += [code for code in re.findall(r"\b[A-Z]{2}\b", text) if code in UF_NAMES]
    mentions = []
    for uf in dict.fromkeys(ufs):
        at = [ip for ip, u in inv["clients"].items() if u == uf]
        mentions.append(f"{uf} ({UF_NAMES[uf]}) -> " + (f"client {', '.join(at)}" if at else "no client at this PoP"))
    for ip in dict.fromkeys(IP.findall(text)):
        role = "client" if ip in inv["clients"] else "server" if ip in inv["servers"] else None
        where = (inv["clients"] if role == "client" else inv["servers"]).get(ip)
        mentions.append(f"{ip} -> {role} at PoP {where}" if role else f"{ip} -> not in the inventory")
    return {**inv, "mentions": mentions}


# Brief: Builds the system prompt and makes one LLM call
# Params:
#   String model_id: Model id from models.yaml
#   String text: The operator's request
#   dict grounding: Output of ground()
#   list examples: Output of rag.retrieve()
#   String deployer_error: rejection() text when regenerating
#   bool constrained: Force constrained decoding on/off (default: CONSTRAINED_DECODING)
# Return:
#   tuple (String answer line: Nile or "ASK: ...", float seconds, String system prompt)
def generate(model_id: str, text: str, grounding: dict, examples: list, deployer_error: str = None,
             constrained: bool = None):
    system = PROMPT.format(
        guidance=_guidance(text, grounding),
        inventory=_inventory_text(grounding),
        capabilities=_capabilities_text(grounding),
        examples="\n\n".join(f"Request: {e['text']}\nAnswer: {e['nile']}" for e in examples) or "(none)",
        deployer_error=f"\n{deployer_error}" if deployer_error else "")
    constrained = (CONSTRAINED if constrained is None else constrained) and not llm.MODELS[model_id].get("shared")
    raw, seconds = llm.complete(model_id, system, text, GRAMMAR if constrained else None)
    return first_line(raw), seconds, system


# Brief: "The deployer rejected ..." context for a regeneration
# Params:
#   String previous: The rejected answer
#   dict error: The deployer's 400/422 body
# Return:
#   String for generate(deployer_error=...)
def rejection(previous: str, error: dict) -> str:
    return f"Your previous answer was: {previous}\nThe deployer rejected: {json.dumps(error)}. Produce a corrected intent."


# Brief: The first meaningful line of a completion, without code fences or "Answer:" prefixes
def first_line(raw: str) -> str:
    for line in raw.splitlines():
        line = line.strip().strip("`").strip()
        line = re.sub(r"^(Answer|Nile)\s*:\s*", "", line).strip().strip('"')
        if line:
            return line
    return ""


def _guidance(text: str, grounding: dict) -> str:
    parts = [SKILLS["nile-patterns"]]
    if grounding and grounding["clients"] and VIDEO.search(text):
        parts.append(SKILLS["video-qoe"])
    return "\n\n".join(parts)


def _inventory_text(g: dict) -> str:
    if g is None:
        return "Not given: a campus network. Use the entities the request names."
    fmt = lambda hosts: ", ".join(f"{ip} ({uf})" for ip, uf in sorted(hosts.items())) or "none"
    intents = "; ".join(f"{i['intent']} (server {i['server_ip']})" for i in g["intents"]) or "none"
    return SKILLS["topology-context"].format(clients=fmt(g["clients"]), servers=fmt(g["servers"]),
                                             pops=", ".join(g["pops"]) or "none", intents=intents,
                                             mentions="; ".join(g["mentions"]) or "nothing specific")


def _capabilities_text(g: dict) -> str:
    if g is None:
        return "Any Nile operation."
    lines = [f"- {c['operation']} with {c['scope']}: {c['reason']}"
             for c in g["capabilities"] if c.get("executable") and c.get("chat")]
    return SKILLS["rein-capabilities"].format(executable="\n".join(lines) or "- none")


class State(TypedDict, total=False):
    text: str           # the request, plus the operator's answers to ASK
    model: str
    grounding: dict
    examples: list
    nile: str           # proposed intent, or "ASK: ..."
    seconds: float
    error: dict         # the deployer's rejection of the last attempt (400/422/503)
    result: dict        # {server_ip, path, flows} once deployed
    status: str         # "deployed" or "cancelled" when the thread ends


def _ground_node(s: State) -> dict:
    return {"grounding": ground(s["text"], inventory.get()), "error": None}


def _retrieve_node(s: State) -> dict:
    return {"examples": rag.retrieve(s["text"])}


def _generate_node(s: State) -> dict:
    error = rejection(s["nile"], s["error"]) if s.get("error") else None
    nile, seconds, _ = generate(s["model"], s["text"], s["grounding"], s["examples"], error)
    return {"nile": nile, "seconds": seconds, "error": None}  # a new proposal has not been rejected yet


# Brief: Waits for the operator. Resume with {"action": "deploy", "nile"?: edited intent},
# {"action": "regenerate"}, {"action": "answer", "text": ...} (to an ASK) or {"action": "cancel"}
def _confirm_node(s: State) -> Command:
    decision = interrupt({"nile": s["nile"], "error": s.get("error")})
    action, nile = decision.get("action"), decision.get("nile") or s["nile"]
    if action == "deploy" and not nile.startswith("ASK:"):
        return Command(goto="deploy", update={"nile": nile})
    if action == "regenerate":
        return Command(goto="generate")
    if action == "answer":
        return Command(goto="ground", update={"text": f"{s['text']}\n{decision.get('text', '')}"})
    return Command(goto=END, update={"status": "cancelled"})


# Brief: POST /deploy; a rejection goes back to the operator with the deployer's own error
def _deploy_node(s: State) -> Command:
    try:
        r = requests.post(inventory.DEPLOYER_URL + "/deploy", json={"intent": s["nile"]}, timeout=120)
        body = r.json()
    except (requests.RequestException, ValueError) as e:
        return Command(goto="confirm", update={"error": {"status": 503, "error": "deployer", "detail": str(e)}})
    if r.status_code != 200:
        return Command(goto="confirm", update={"error": {"status": r.status_code, **body}})
    flows = sum(len(c.get("output", {}).get("responses", [])) for c in body["controller_responses"].values())
    return Command(goto=END, update={"status": "deployed", "error": None,
                                     "result": {"server_ip": body.get("server_ip"), "path": body.get("path"), "flows": flows}})


# Brief: Compiles the workflow
# Params:
#   checkpointer: LangGraph checkpointer holding each thread's state
# Return:
#   Compiled LangGraph graph
def build(checkpointer):
    g = StateGraph(State)
    for name, node in (("ground", _ground_node), ("retrieve", _retrieve_node), ("generate", _generate_node),
                       ("confirm", _confirm_node), ("deploy", _deploy_node)):
        g.add_node(name, node)
    g.add_edge(START, "ground")
    g.add_edge("ground", "retrieve")
    g.add_edge("retrieve", "generate")
    g.add_edge("generate", "confirm")
    return g.compile(checkpointer=checkpointer)


# Brief: CLI: python -m app.graph "Quero a melhor qualidade de vídeo para o cliente de SP"
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Translate one request into Nile (no deploy)")
    parser.add_argument("text")
    parser.add_argument("--model", default="qwen3.6", choices=sorted(llm.MODELS))
    parser.add_argument("--inventory", help="inventory JSON snapshot instead of the live deployer")
    parser.add_argument("-v", "--verbose", action="store_true", help="print the full system prompt")
    args = parser.parse_args()

    g = ground(args.text, inventory.load(args.inventory) if args.inventory else inventory.get())
    examples = rag.retrieve(args.text)
    answer, seconds, system = generate(args.model, args.text, g, examples)
    if args.verbose:
        print(system, "\n" + "-" * 60)
    print("grounding:", "; ".join(g["mentions"]) or "no entity mentioned")
    for e in examples:
        print(f"  example {e['score']:.3f} [{e['source']}] {e['text'][:70]}")
    print(f"{args.model} ({seconds:.2f}s): {answer}")
