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
CAPABILITIES = {
    "add service('cdn-qoe')": {"executable": True, "chat": True,
                               "scope": "from endpoint('<client ip>') or for endpoint('<client ip>')",
                               "reason": "picks the best CDN server for the client and installs the path"},
    "add service":            {"executable": False, "reason": "unknown service; see the executable ones in /capabilities"},
    "remove service":         {"executable": False, "reason": "removing a service is not implemented"},
    "add middlebox":          {"executable": False, "reason": "no middlebox exists in this testbed"},
    "remove middlebox":       {"executable": False, "reason": "no middlebox exists in this testbed"},
    "set bandwidth('max')":   {"executable": False, "reason": "tested on diamond: its metered flows have the priority of the "
                                                             "cdn-qoe flows, which win (the meter saw 0 bytes)"},
    "set bandwidth":          {"executable": False, "reason": "only a 'max' bandwidth has code in compile()"},
    "set quota":              {"executable": False, "reason": "quotas are not implemented"},
    "unset":                  {"executable": False, "reason": "unset is not implemented"},
    "allow":                  {"executable": False, "reason": "ACL rules are not verified on the testbed"},
    "block":                  {"executable": False, "reason": "ACL rules are not verified on the testbed"},
    "start":                  {"executable": False, "reason": "time windows (start/end) are ignored by compile()"},
}


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

    op = str(action.children[0])
    for item in action.children[1:]:
        # acl/chain items carry their function as a token; qos items are named by the rule
        if item.data in ("acl", "chain"):
            fn, args = str(item.children[0]), [str(a) for a in item.children[1:]]
        else:
            fn, args = str(item.data), [str(a) for a in item.children]
        label = f"{op} {fn}({', '.join(args)})"
        keys = (f"{op} {fn}({args[0]})", f"{op} {fn}", op)
        cap = next((CAPABILITIES[k] for k in keys if k in CAPABILITIES), {"executable": False, "reason": "not supported"})
        if not cap["executable"]:
            return _unsupported(label, cap["reason"])
        if cap.get("scope") and not _client_endpoint(scope):
            return _unsupported(label, f"needs {cap['scope']}")
    return None


# Brief: The client IP of a single-endpoint scope (from/for endpoint('<ipv4>')), else None
def _client_endpoint(scope):
    if scope.data not in ("from_only", "for_target"):
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
