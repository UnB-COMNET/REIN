# Brief: Policies on a client's own switch, as OpenFlow rules installed through ONOS's REST API. They sit
# above the cdn-qoe paths (priority 40000), so they hold whatever path the client's traffic takes:
#   set bandwidth('max', n, unit)   a DROP meter on what reaches the client, then out of its port
#   unset bandwidth('max', ...)     removes that meter
#   block protocol(p)               drops p to and from the client (nile.PROTOCOLS)
#   allow protocol(p)               lifts that block
# A client's rules are kept by policy, so a new one replaces the previous and allow/unset find them.

import urllib.parse

import nile

PRIORITY = 45000
OPERATIONS = {("set", "bandwidth"), ("unset", "bandwidth"), ("block", "protocol"), ("allow", "protocol")}
_rules = {}   # (client ip, policy) -> {"intent": Nile text, "paths": ONOS paths of its flows and meter}


# Brief: Applies an intent's action items to a client
# Params:
#   onos: The deployer's Onos (for _make_request)
#   dict hosts: The hosts ONOS knows, by IP (Topology.nodes["hosts"], just refreshed)
#   String client: The client's IP
#   list items: nile.actions() items, all in OPERATIONS
#   String intent: The Nile text, kept for GET /intents
# Return:
#   list of the ONOS paths of the rules installed
def apply(onos, hosts, client: str, items: list, intent: str) -> list:
    location = hosts[client]["locations"][0]
    device, port = location["elementId"], location["port"]
    installed = []
    for op, fn, args in items:
        policy = "bandwidth" if fn == "bandwidth" else f"block {args[0].lower()}"
        clear(onos, client, policy)
        if op not in ("set", "block"):   # unset, allow: clearing it was all
            continue
        paths = []   # filled as ONOS creates them, so a failure halfway clears what exists
        _rules[(client, policy)] = {"intent": intent, "paths": paths}
        try:
            if op == "set":
                band = {"type": "DROP", "rate": nile.rate_kbps(args), "burstSize": 0}   # KB_PER_SEC is kbit/s
                paths.append(_path(onos._make_request("POST", f"/meters/{_quote(device)}", data={
                    "deviceId": device, "unit": "KB_PER_SEC", "burst": False, "bands": [band]})))
                meter_id = paths[0].rsplit("/", 1)[1]
                paths.insert(0, _flow(onos, device, [{"type": "METER", "meterId": meter_id}, {"type": "OUTPUT", "port": port}],
                                      [_address("IPV4_DST", client)]))   # removed before its meter
            else:
                number, tcp_port = nile.PROTOCOLS[args[0].lower()]
                match = [{"type": "IP_PROTO", "protocol": number}] + ([{"type": "TCP_DST", "tcpPort": tcp_port}] if tcp_port else [])
                for side in ("IPV4_SRC", "IPV4_DST"):
                    paths.append(_flow(onos, device, [], [_address(side, client)] + match))
        except Exception:
            clear(onos, client, policy)
            raise
        installed += paths
    return installed


# Brief: Removes a client's policy ("bandwidth" or "block <protocol>"), if it has one
def clear(onos, client: str, policy: str) -> None:
    for path in _rules.pop((client, policy), {}).get("paths", []):
        try:
            onos._make_request("DELETE", path)
        except Exception:   # already gone, e.g. the testbed was rebuilt
            pass


def clear_all(onos) -> None:
    for client, policy in list(_rules):
        clear(onos, client, policy)


# Brief: The policies in place, as GET /intents lists them
def listing() -> list:
    return [{"client_ip": client, "intent": rule["intent"], "server_ip": None, "path": None} for (client, _), rule in _rules.items()]


def _flow(onos, device: str, instructions: list, criteria: list) -> str:
    body = {"priority": PRIORITY, "timeout": 0, "isPermanent": True, "deviceId": device,
            "treatment": {"instructions": instructions},   # none: drop
            "selector": {"criteria": [{"type": "ETH_TYPE", "ethType": "0x0800"}] + criteria}}
    return _path(onos._make_request("POST", f"/flows/{_quote(device)}", data=body))


def _address(kind: str, ip: str) -> dict:
    return {"type": kind, "ip": f"{ip}/32"}


def _quote(device: str) -> str:
    return urllib.parse.quote(device, safe="")


# Brief: The ONOS path of a created flow or meter, from its Location header: /flows/of%3A.../<id>
def _path(response: dict) -> str:
    kind, device, number = response["location"].split("/onos/v1/", 1)[1].split("/")
    return f"/{kind}/{_quote(device)}/{number}"
