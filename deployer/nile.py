# Brief: Nile validation for /deploy: syntax (Lark) first, then what this deployer can execute

import ipaddress
import os
import re

from lark import Lark
from lark.exceptions import UnexpectedCharacters, UnexpectedInput
from lark.lexer import PatternStr

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "nile.lark")) as f:
    GRAMMAR = f.read()
_parser = Lark(GRAMMAR, parser="lalr")

# Brief: What Onos.compile() executes, looked up from the most to the least specific key:
# "<op> <function>('<first arg>')", "<op> <function>", "<op>". "chat" marks what the
# profiler may offer; "scope" is the target form compile() needs for that operation.
CLIENT = "for endpoint('<client ip>')"
CAPABILITIES = {
    "add service('cdn-qoe')":    {"executable": True, "chat": True, "scope": CLIENT,
                                  "reason": "picks the best CDN server for the client and installs the path"},
    "remove service('cdn-qoe')": {"executable": True, "chat": True, "scope": CLIENT, "reason": "removes the client's path"},
    "add service":               {"executable": False, "reason": "unknown service; see the executable ones in /capabilities"},
    "remove service":            {"executable": False, "reason": "unknown service; see the executable ones in /capabilities"},
    "add middlebox":             {"executable": False, "reason": "no middlebox exists in this testbed"},
    "remove middlebox":          {"executable": False, "reason": "no middlebox exists in this testbed"},
    "set bandwidth('max')":      {"executable": True, "chat": True, "scope": CLIENT,
                                  "reason": "caps what reaches the client: bandwidth('max', '<number>', 'bps|kbps|mbps|gbps')"},
    "unset bandwidth('max')":    {"executable": True, "chat": True, "scope": CLIENT, "reason": "lifts the client's cap"},
    "set bandwidth":             {"executable": False, "reason": "a minimum needs queues; only a 'max' bandwidth is enforced"},
    "unset bandwidth":           {"executable": False, "reason": "only a 'max' bandwidth is enforced"},
    "set quota":                 {"executable": False, "reason": "quotas are not implemented"},
    "unset quota":               {"executable": False, "reason": "quotas are not implemented"},
    "block protocol":            {"executable": True, "chat": True, "scope": CLIENT,
                                  "reason": "drops it to and from the client: protocol('tcp|udp|icmp|ssh|http|https')"},
    "allow protocol":            {"executable": True, "chat": True, "scope": CLIENT, "reason": "lifts a block on the protocol"},
    "block":                     {"executable": False, "reason": "only protocol(...) is enforced: traffic and service names need DPI"},
    "allow":                     {"executable": False, "reason": "only protocol(...) is enforced: traffic and service names need DPI"},
    "start":                     {"executable": False, "reason": "time windows (start/end) are ignored by compile()"},
}
# The protocols block/allow enforce: IP protocol number, and a TCP port for the ones known by name
PROTOCOLS = {"tcp": (6, None), "udp": (17, None), "icmp": (1, None), "ssh": (6, 22), "http": (6, 80), "https": (6, 443)}
UNITS = {"bps": 0.001, "kbps": 1, "mbps": 1000, "gbps": 1000000}   # to kbit/s, the unit of ONOS meters


# Brief: Checks an intent before parse_nile ever sees it
# Params:
#   String intent: Nile intent in one line
# Return:
#   None when it can be deployed; otherwise tuple (int status, dict body): 400 for a syntax
#   error, 422 for valid Nile this deployer cannot execute
def validate(intent: str):
    try:
        tree = _parser.parse(intent)
    except UnexpectedInput as e:
        return 400, _syntax_error(intent, e)

    _, scope, action, *window = tree.children
    if window:
        start, end = (f"{t.children[0]}({t.children[1]})" for t in window[0].children)
        return _unsupported(f"start {start} end {end}", CAPABILITIES["start"]["reason"])

    for op, fn, args in _items(action):
        label = f"{op} {fn}({', '.join(args)})"
        keys = (f"{op} {fn}({args[0]})", f"{op} {fn}", op)
        cap = next((CAPABILITIES[k] for k in keys if k in CAPABILITIES), {"executable": False, "reason": "not supported"})
        if not cap["executable"]:
            return _unsupported(label, cap["reason"])
        if cap.get("scope") and not _client_endpoint(scope):
            return _unsupported(label, f"needs {cap['scope']}")
        if fn == "protocol" and args[0].strip("'").lower() not in PROTOCOLS:
            return _unsupported(label, f"unknown protocol; one of {', '.join(PROTOCOLS)}")
        if (op, fn) == ("set", "bandwidth") and not rate_kbps(args):
            return _unsupported(label, f"needs a rate of at least 1 kbps, in {', '.join(UNITS)}")
    return None


# Brief: The kbit/s of bandwidth('max', '<number>', '<unit>'), None when it is not a rate
def rate_kbps(args: list):
    value, unit = (a.strip("'").lower() for a in args[1:])
    if unit not in UNITS or not re.fullmatch(r"\d+(\.\d+)?", value):
        return None
    return round(float(value) * UNITS[unit]) or None


# Brief: A valid intent's client and action items
# Params:
#   String intent: Nile intent that passed validate()
# Return:
#   (String client ip or None, list of (op, function, [values without quotes]))
def actions(intent: str) -> tuple:
    _, scope, action, *_ = _parser.parse(intent).children
    return _client_endpoint(scope), [(op, fn, [a.strip("'") for a in args]) for op, fn, args in _items(action)]


# Brief: (op, function, [args]) per action item; acl/chain items carry their function as a token,
# qos items are named by the rule
def _items(action):
    op = str(action.children[0])
    for item in action.children[1:]:
        if item.data in ("acl", "chain"):
            yield op, str(item.children[0]), [str(a) for a in item.children[1:]]
        else:
            yield op, str(item.data), [str(a) for a in item.children]


# Brief: The client IP of a for endpoint('<ipv4>') scope, else None
def _client_endpoint(scope):
    if scope.data != "for_target":
        return None
    fn, value = (str(t) for t in scope.children[0].children)
    try:
        return str(ipaddress.IPv4Address(value.strip("'"))) if fn == "endpoint" else None
    except ValueError:
        return None


def _unsupported(operation: str, reason: str):
    return 422, {"error": "unsupported", "operation": operation, "reason": reason}


def _syntax_error(intent: str, e: UnexpectedInput) -> dict:
    token = getattr(e, "token", None)
    if isinstance(e, UnexpectedCharacters):
        found = repr(intent[e.pos_in_stream])
    elif token is None or token.type in ("$END", "<EOF>"):
        found = "end of input"
    else:
        found = repr(str(token))
    expected = getattr(e, "allowed", None) or getattr(e, "expected", None) or ()
    return {"error": "syntax", "line": e.line, "column": e.column,
            "expected": sorted(_readable(t) for t in expected),
            "detail": f"unexpected {found}\n{e.get_context(intent).rstrip()}"}


# Brief: Terminal name -> what the user would type ("DEFINE" -> "define", "SET_OP" -> "unset|set")
def _readable(name: str) -> str:
    try:
        pattern = _parser.get_terminal(name).pattern
    except KeyError:
        return "end of input" if name == "$END" else name
    if isinstance(pattern, PatternStr):
        return pattern.value
    alternation = re.fullmatch(r"\(\?:([\w|-]+)\)", pattern.value)
    return alternation.group(1) if alternation else name
