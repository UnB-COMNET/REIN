import os
import logging
import re
import urllib.parse
import requests
import json
import time
from typing_extensions import override
import urllib
import ipaddress
import paramiko

from classes.target import DeployTarget
from classes.dsu import DisjointSetUnion
from services import cdn_qoe, cdn_qoe_installer
import metrics as _metrics

# Temp mappings
GROUP_MAP = {
    "professors": ("192.168.0.0/24", "172.17.0.2"),
    "users": ["192.168.1.3/32"], # "192.168.0.4/32"],
    "students": ("192.168.0.0/24", "172.17.0.2"),
    "developers": ("192.168.0.0/24", "172.17.0.2")
}

ENDPOINT_MAP = {
    "gateway": "192.168.0.1",
    "webserver": "192.168.1.3"
}

SERVICE_MAP = {
    "netflix": "192.168.1.4/32"
}

MIDDLEBOX_MAP = {
    "dpi": "192.168.1.4",
    "honeypot": "192.168.1.4",
    "quarantine": "192.168.1.4"
}


extract_value = re.compile(r"'(.*?)'")

class Onos(DeployTarget):
    # Class variable for controller identification.
    controller = "ONOS"

    def __init__(self, base_url, ip, credentials=(os.getenv("ONOSUSER", "onos"), os.getenv("ONOSPASS", "rocks")), is_main=False):
        super().__init__()
        self.base_url = base_url  # ONOS IP and port
        self.ip = ip
        self.credentials = credentials
        self.link_lines = ""
        self.device_lines = ""
        self.host_lines = ""
        self.is_main = is_main  # Know if controller is the main one of the cluster

    
    @override
    def update(self, request, subject_info, installed_intents):
        intent = request.get('intent')
        op_targets = super().parse_nile(intent)
        targets = []
        # Initial treatment
        if "origin" in op_targets:
            # Add origin IP for controller ip verification
            result = extract_value.search(op_targets["origin"]["value"]) # Extract text between (' and ')
            if result: 
                op_targets["origin"]["value"] = result.group(1)
                try: 
                    ipaddress.ip_address(op_targets["origin"]["value"])  # Check if it is a name or valid IP address
                    targets.append(op_targets["origin"]["value"] + "/32")
                except:
                    targets.append(ENDPOINT_MAP[op_targets["origin"]["value"]] + "/32")
            if "destination" in op_targets:
                result = extract_value.search(op_targets["destination"]["value"]) # Extract text between (' and ')
                if result: op_targets["destination"]["value"] = result.group(1)

        else: # Intent uses groups
            for target in op_targets["targets"]:
                    # Extract group names
                    result = extract_value.search(target["value"]) # Extract text between (' and ')
                    if result: 
                        target["value"] = result.group(1)
                    print(target["value"])
                    if isinstance(GROUP_MAP[target["value"]], list):
                        targets.extend(GROUP_MAP[target["value"]])
                    else:
                        targets.append(GROUP_MAP[target["value"]])
        
        # Controller verification
        print(targets)
        compile_intent = False
        for i, target in enumerate(targets):
            if isinstance(target, tuple):  # Target is a subnetwork
                if self.ip == target[1]:
                    target = target[0]  # remove tuple
                    targets[i] = target
                    if not compile_intent: compile_intent = True
            else:  # Target is not a subnetwork
                device_id = subject_info["hosts"][target.split("/")[0]]["locations"][0]["elementId"]
                if self.ip == subject_info["devices"][device_id]["controller"]:
                    if not compile_intent: compile_intent = True
            
        if compile_intent == True: return self.compile(op_targets, subject_info, targets, intent, installed_intents)
        

        #if self.is_main:
            #self.compile(intent, subject_info)


    # overriding abstract method
    @override
    def compile(self, op_targets: dict, netgraph: dict, srcip_list: list[str], intent: str, installed_intents: dict):
        # Auxiliary data structure for general request information
        request = {
        "priority": 40000,
        "appId": "",
        "action": "",
        "srcIp": "", # /32 for specific addresses
        } # 'http://127.0.0.1:8181/onos/v1/acl/rules # http://<ONOS_IP>:<ONOS_PORT>/onos/v1/acl/rules
        print(op_targets)
        gen_req = []  # List to save generated requests to the ONOS API
        responses = []  # List to track api responses
        api_count = 0

        # Meter request body template
        meter_body = {
            "deviceId": "",
            # "meterCellId": "org.onosproject.core",
            "unit": "KB_PER_SEC",  # Kilo Bits
            "burst": "false",
            "bands": [
                {
                "type": "",
                "rate": "",
                "burstSize": "0",
                "prec": "0"
                }
            ]
        }

        # Flow rule request body template
        body = {
            "appId": "org.onosproject.core",
            "priority": 40000,
            "timeout": 0,
            "isPermanent": "true",
            "deviceId": "",

            "treatment": {
                "instructions": [
                    {
                        "type": "OUTPUT",
                        "port": "NORMAL"
                    }
                ]
            },

            "selector": {
                "criteria": [
                    {
                        "type": "ETH_TYPE",
                        "ethType": "0x0800"
                    },
                    {
                        "type": "IPV4_SRC",
                        "ip": ""
                    }
                ]
            }
        }

        try:
            # Targets initial treatment
            if "origin" in op_targets and "destination" in op_targets:
                request["srcIp"] = op_targets["origin"]["value"] + "/32"

                try: 
                    ipaddress.ip_address(op_targets["origin"]["value"])  # Check if it is a name or valid IP address
                    request["dstIp"] = op_targets["destination"]["value"] + "/32"
                    # targets.append(op_targets["origin"]["value"] + "/32")
                except:
                    # targets.append(ENDPOINT_MAP[op_targets["origin"]["value"]] + "/32")
                    print("MAP ENDPOINT")
                    op_targets["destination"]["value"] = ENDPOINT_MAP[op_targets["destination"]["value"]]  # Retrieve destination IP address
                    request["dstIp"] = op_targets["destination"]["value"] + "/32"  # Save destination IP with CIDR

            for operation in op_targets["operations"]:
                print(operation)

                # Operations
                if operation["type"] == "set":
                    request["appId"] = "org.onosproject.core"
                    print("Set operation")
                    """
                        QoS intent parsing example:
                            Nile: define intent stnIntent: for group('staff') set bandwidth('min', '70', 'mbps')
                            OP_TARGETS: {
                                operations :  [{'type': 'set', 'function': 'bandwidth', 'value': "('min', '70', 'mbps')"}]

                                targets :  [{'function': 'group', 'value': "('staff')"}]
                            }

                        Whith endpoints instead of groups:
                            operations :  [{'type': 'set', 'function': 'bandwidth', 'value': "('min', '70', 'mbps')"}]

                            targets :  []

                            origin :  {'function': 'endpoint', 'value': "('19.16.1.1')"}

                            destination :  {'function': 'endpoint', 'value': "('172.16.12.59')"}

                    """
                    
                    values: tuple = eval(operation["value"])  # min/max, Rate, Unit

            # if operation["function"] == "bandwidth"
                    # If endpoints are used
                    # Add dst_ip selector criteria if the intent uses endpoints
                    if "origin" in op_targets:
                        # Add the destination address criteria using the destination endpoint
                        body["selector"]["criteria"].append({
                            "type": "IPV4_DST",
                            "ip": request["dstIp"]
                        })

                        """ # Identify the switches - Known destination
                        paths = self._make_request("GET", f"/paths/{urllib.parse.quote_plus(netgraph['hosts'][src_ip[0]]['id'])}/{urllib.parse.quote_plus(netgraph['hosts'][request['dstIp']]['id'])}")
                        for path in paths["content"]["paths"]:
                            links = path["links"]
                            affected_switches = []
                            for link in links:
                                switch_id = link["dst"] 
                        """
                    body["treatment"]["instructions"].append({})
                    body["treatment"]["instructions"][1]["type"] = "METER"
                    print(f'flow rule: {body}')

                    meter_body["bands"][0]["type"] = "DROP"
                    meter_body["bands"][0]["rate"] = values[1] + "000"

                    if values[0] == 'max':
                        for switch in netgraph["devices"].keys():
                                # Create a meter
                                meter_body["deviceId"] = switch

                                print(meter_body)
                                
                                responses.append(self._make_request("POST", f"/meters/{urllib.parse.quote_plus(switch)}", data=meter_body, headers={'Content-type': 'application/json'}))

                                print("Meter installed")
                                print(responses[-1])

                                # Install Flow rule for each target.
                                meter_id = responses[-1]["location"].split("/")[-1]  # Get meter ID
                                body["treatment"]["instructions"][1]["meterId"] = meter_id

                                body["deviceId"] = switch
                                for src_ip in srcip_list:
                                    body["selector"]["criteria"][1]["ip"] = src_ip
                                    responses.append(self._make_request("POST", f"/flows/{switch}", data=body, headers={'Content-type': 'application/json'}))


                                


                    else:
                        print("Min bandwidth")

                # add cdn-qoe
                elif operation["type"] == "add" and extract_value.search(operation["value"]).group(1) == "cdn-qoe":
                    print("ADD CDN-QoE")

                    client_ip = srcip_list[0].split("/")[0]

                    tx_by_server_uf = {
                        "ES": 500.0 
                    }

                    try:
                        source_uf = cdn_qoe.IP_TO_ESTADO_CLIENTE.get(client_ip)
                        if not source_uf:
                            raise ValueError(f"Cliente {client_ip} não mapeado no cdn_qoe.py!")

                        target_ufs = list(tx_by_server_uf.keys())
                        tx_values = list(tx_by_server_uf.values())

                        t0 = time.time()
                        source_idx, best_target_idx, best_qoe, best_path, _ = cdn_qoe.solve_shortest_path_with_constraints(
                            source_uf=source_uf,
                            target_ufs=target_ufs,
                            tx=tx_values
                        )
                        _solve_s = time.time() - t0
                        print(f" [TIMER] solve_shortest_path: {_solve_s:.3f}s")
                        _metrics.set_value("solve_time_s", _solve_s)
                        
                        if best_target_idx is None:
                            raise ValueError("O Solver não encontrou nenhum caminho possível! A matriz de latências pode estar vazia.")

                        best_server_uf = cdn_qoe.ESTADOS[best_target_idx]
                        print(f" [CDN-QoE] Optimization complete. Best server at: {best_server_uf} (QoE index: {best_qoe:.5f})")

                        server_ip = None
                        for ip, uf in cdn_qoe.IP_TO_ESTADO_SERVIDOR.items():
                            if uf == best_server_uf:
                                server_ip = ip
                                break
                        
                        if not server_ip:
                            raise ValueError(f"Não encontrei o IP do servidor para o estado {best_server_uf}!")

                        active_path = getattr(self, "_cdn_qoe_active_path", None)
                        if best_path != active_path:
                            print(f" [CDN-QoE] New path differs from active path - removing old flow rules...")
                            _t_deploy = time.time()
                            t0 = time.time()
                            cdn_qoe_installer.remove_old_flows(self, client_ip, server_ip, cdn_qoe.DEVICE_MAP)
                            print(f" [TIMER] remove_old_flows: {time.time()-t0:.3f}s")

                            print(f" [CDN-QoE] Installing flows: Client ({client_ip}) <-> Server ({server_ip})...")
                            t0 = time.time()
                            flow_resps = cdn_qoe_installer.install_bidirectional_custom_path(
                                onos=self,
                                netgraph=netgraph,
                                client_ip=client_ip,
                                server_ip=server_ip,
                                path_indices=best_path,
                                estados=cdn_qoe.ESTADOS,
                                device_map=cdn_qoe.DEVICE_MAP
                            )
                            print(f" [TIMER] install_bidirectional: {time.time()-t0:.3f}s")
                            _metrics.set_value("deploy_time_s", time.time() - _t_deploy)

                            responses.extend(flow_resps)
                            self._cdn_qoe_active_path = best_path
                            print(" [CDN-QoE] Flows successfully installed on ONOS!")
                        else:
                            print(f" [CDN-QoE] Path unchanged - skipping flow rule removal and installation.")
                            _metrics.set_value("deploy_time_s", 0.0)


                        # Notify supervisor of the deployed path (send ESTADOS so supervisor
                        # resolves path indices in the same order the deployer used)
                        try:
                            requests.post(
                                "http://127.0.0.1:5151/supervise",
                                json={
                                    "path":            best_path,
                                    "estados":         cdn_qoe.ESTADOS,
                                    "source_uf":       source_uf,
                                    "target_ufs":      target_ufs,
                                    "tx":              tx_values,
                                    "access_delay_ms": 10.0,
                                },
                                timeout=3,
                            )
                            _metrics.increment("msgs_deployer_to_observer")
                            print(" [CDN-QoE] Supervisor notified of deployed path.")
                        except Exception:
                            print(" [CDN-QoE] Could not reach supervisor - skipping notification.")

                    except Exception as e:
                        import traceback
                        print(f"\n [CRITICAL ERROR] Failure during QoE execution or flow installation:")
                        traceback.print_exc()
                        raise e

                # add llm: the model chooses both the CDN server and the path
                elif operation["type"] == "add" and extract_value.search(operation["value"]).group(1) == "llm":
                    try:
                        print(" [LLM] Starting routing via qwen3.6...")

                        client_ip = srcip_list[0].split("/")[0]
                        source_uf = cdn_qoe.IP_TO_ESTADO_CLIENTE.get(client_ip)
                        if not source_uf:
                            raise ValueError(f"Client {client_ip} not mapped in cdn_qoe.IP_TO_ESTADO_CLIENTE")

                        tx_by_server_uf = {"ES": 500.0}

                        t0 = time.time()
                        cdn_qoe.get_dynamic_latencies()  # populates globals: ESTADOS, RTT_MATRIX, ADJ_MATRIX
                        print(f" [TIMER] get_dynamic_latencies: {time.time()-t0:.3f}s")

                        print("\n" + "="*20)
                        print(cdn_qoe.RTT_MATRIX)
                        print("="*20 + "\n")

                        topo_text = ""
                        for i, s_st in enumerate(cdn_qoe.ESTADOS):
                            for j, d_st in enumerate(cdn_qoe.ESTADOS):
                                lat = cdn_qoe.RTT_MATRIX[i][j]
                                if lat > 0:
                                    topo_text += f"- {s_st} -> {d_st}: {lat}ms\n"

                        servers_text = "\n".join(
                            f"- {uf}: available throughput = {tx} Mbps"
                            for uf, tx in tx_by_server_uf.items()
                        )

                        target_ufs_str = ", ".join(tx_by_server_uf.keys())

                        prompt = f"""You are a network routing optimizer.

                Choose the best CDN server and the shortest path from the Origin to that server, minimizing total latency.
                Only use nodes and links listed in the topology. Output exactly and only a JSON object.

                ### Available CDN Servers (possible Destinations)
                {servers_text}

                ### Topology (RTT between nodes)
                \"\"\"
                {topo_text}
                \"\"\"

                ### Example

                Servers:
                - ES: available throughput = 500 Mbps
                - RJ: available throughput = 200 Mbps
                Topology:
                \"\"\"
                - SP -> RJ: 10.0ms
                - RJ -> ES: 15.0ms
                - SP -> MG: 12.0ms
                - MG -> ES: 8.0ms
                \"\"\"
                Origin: SP

                Output:
                {{
                "server": "ES",
                "path": ["SP", "MG", "ES"],
                "cost": 20.0
                }}

                ### Current Task

                Origin: {source_uf}
                Available destinations: {target_ufs_str}

                Output:
                """

                        print(f" [LLM] Calculating best path from {source_uf} to {target_ufs_str}...")
                        t0 = time.time()
                        response = requests.post(
                            "http://localhost:11434/api/chat",
                            json={
                                "model": "qwen3.6",
                                "messages": [{"role": "user", "content": prompt}],
                                "stream": False,
                                "format": "json",
                                "options": {"temperature": 0}
                            }
                        )
                        _llm_s = time.time() - t0
                        print(f" [TIMER] llm_inference: {_llm_s:.3f}s")
                        _metrics.set_value("solve_time_s", _llm_s)

                        print("\n" + "="*20)
                        print(response.text)
                        print("="*20 + "\n")

                        llm_output = json.loads(response.json()['message']['content'])
                        path_names = llm_output["path"]
                        chosen_uf  = llm_output["server"]

                        if chosen_uf not in tx_by_server_uf:
                            raise ValueError(f"LLM returned unknown server UF='{chosen_uf}'. Valid options: {target_ufs_str}")

                        server_ip = next(
                            (ip for ip, uf in cdn_qoe.IP_TO_ESTADO_SERVIDOR.items() if uf == chosen_uf),
                            None
                        )
                        if not server_ip:
                            raise ValueError(f"No IP found for server UF={chosen_uf}")

                        try:
                            path_indices_list = [cdn_qoe.ESTADOS.index(name) for name in path_names]
                            path_indices = list(zip(path_indices_list[:-1], path_indices_list[1:]))

                            print(f" [LLM] Path converted to index pairs: {path_indices}")

                            active_path = getattr(self, "_llm_active_path", None)
                            if path_indices != active_path:
                                print(f" [LLM] New path detected - removing stale flow rules...")
                                _t_deploy = time.time()
                                t0 = time.time()
                                cdn_qoe_installer.remove_old_flows(self, client_ip, server_ip, cdn_qoe.DEVICE_MAP)
                                print(f" [TIMER] remove_old_flows: {time.time()-t0:.3f}s")

                                print(f" [LLM] Installing flows: {client_ip} <-> {server_ip} via {path_names}...")
                                t0 = time.time()
                                flow_resps = cdn_qoe_installer.install_bidirectional_custom_path(
                                    onos=self,
                                    netgraph=netgraph,
                                    client_ip=client_ip,
                                    server_ip=server_ip,
                                    path_indices=path_indices,
                                    estados=cdn_qoe.ESTADOS,
                                    device_map=cdn_qoe.DEVICE_MAP
                                )
                                print(f" [TIMER] install_bidirectional: {time.time()-t0:.3f}s")
                                _metrics.set_value("deploy_time_s", time.time() - _t_deploy)
                                responses.extend(flow_resps)
                                self._llm_active_path = path_indices
                                print(" [LLM] Flows successfully installed on ONOS!")
                            else:
                                print(f" [LLM] Path unchanged - skipping flow reinstallation.")
                                _metrics.set_value("deploy_time_s", 0.0)

                            try:
                                requests.post(
                                    "http://127.0.0.1:5151/supervise",
                                    json={
                                        "path":            path_indices,
                                        "estados":         cdn_qoe.ESTADOS,
                                        "source_uf":       source_uf,
                                        "target_ufs":      [chosen_uf],
                                        "tx":              [tx_by_server_uf[chosen_uf]],
                                        "access_delay_ms": 10.0,
                                    },
                                    timeout=3,
                                )
                                _metrics.increment("msgs_deployer_to_observer")
                                print(" [LLM] Supervisor notified of deployed path.")
                            except Exception:
                                print(" [LLM] Could not reach supervisor - skipping notification.")

                        except ValueError as e:
                            print(f" [ERROR] Invalid state name from llama3:8b: {e}")

                    except Exception as e:
                        print(f" [ERROR]: {e}")
                        import traceback
                        traceback.print_exc()

                # Add Middleboxes
                elif operation["type"] == "add":
                    print("ADD Operation")
                    print(srcip_list)
                    result = extract_value.search(operation["value"])  # Extract Middlebox name
                    middlebox_ip = MIDDLEBOX_MAP[result.group(1)]  # Get middlebox IP address
                    
                    # Add dst_ip selector criteria if the intent uses endpoints
                    if "origin" in op_targets:
                        # Add the destination address criteria using the destination endpoint
                        body["selector"]["criteria"].append({
                            "type": "IPV4_DST",
                            "ip": request["dstIp"]
                        })
                    
                    # Loop through the srcIP list, creating the flow rule requests and applying them
                    for src_ip in srcip_list:
                        ip, cidr = src_ip.split("/")
                        body["selector"]["criteria"][1]["ip"] = src_ip
                        print(cidr)
                        # Checks if the src_ip is a subnetwork
                        if cidr != "32":
                            print("SUBNETWORK")
                            affected_switches = []

                            for host in netgraph["hosts"].keys():
                                # https://stackoverflow.com/questions/819355/how-can-i-check-if-an-ip-is-in-a-network-in-python
                                if ipaddress.ip_address(host) in ipaddress.ip_network(src_ip):
                                    print(host)
                                    middlebox_paths = self._make_request("GET", f"/paths/{urllib.parse.quote_plus(netgraph['hosts'][host]['id'])}/{urllib.parse.quote_plus(netgraph['hosts'][middlebox_ip]['id'])}")
                                    api_count += 1
                                    for link in middlebox_paths["content"]["paths"][0]["links"]:
                                        device_id = link["src"].get("device")
                                        if device_id in affected_switches:
                                            break
                                        if device_id:
                                            affected_switches.append(device_id)
                                            body["deviceId"] = device_id
                                            body["treatment"]["instructions"][0]["port"] = link["src"]["port"]
                                            gen_req.append(body)
                                            print(body)
                                            api_count += 1
                                            responses.append(self._make_request("POST", f"/flows/{device_id}", data=body, headers={'Content-type': 'application/json'}))
        
                        else:  # Not a subnetwork
                            """
                                Calculate shortest path to middlebox first. The shortest path to the original destination will be calculated
                                if the middlebox type is firewall, dpi, ...
                            """
                            print("NOT SUBNETWORK")
                            middlebox_paths = self._make_request("GET", f"/paths/{urllib.parse.quote_plus(netgraph['hosts'][ip]['id'])}/{urllib.parse.quote_plus(netgraph['hosts'][middlebox_ip]['id'])}")
                            api_count += 1
                            for link in middlebox_paths["content"]["paths"][0]["links"]:
                                device_id = link["src"].get("device")
                                if device_id:
                                    body["deviceId"] = device_id
                                    body["treatment"]["instructions"][0]["port"] = link["src"]["port"]
                                    gen_req.append(body)
                                    print(body)
                                    api_count += 1
                                    responses.append(self._make_request("POST", f"/flows/{device_id}", data=body, headers={'Content-type': 'application/json'}))

                            # Depending on the middlebox type and if the intent has a destination endpoint, install the necessary flow rules to allow the packets to reach the final target
                            if (result.group(1) == 'dpi' or result.group(1) == 'firewall') and request["dstIp"]:
                                # Get shortest path from middlebox to original destination host
                                host_paths = self._make_request("GET", f"/paths/{urllib.parse.quote_plus(netgraph['hosts'][middlebox_ip]['id'])}/{urllib.parse.quote_plus(netgraph['hosts'][op_targets['destination']['value']]['id'])}")
                                # Change src IP address for flow rule selector
                                body["selector"]["criteria"][1]["ip"] = middlebox_ip + "/32"
                                body["treatment"]["instructions"][0]["port"] = "CONTROLLER"  # Controller will handle it
                                for link in host_paths["content"]["paths"][0]["links"]:
                                    device_id = link["src"].get("device")
                                    if device_id:
                                        body["deviceId"] = device_id
                                        gen_req.append(body)
                                        print(body)
                                        api_count += 1
                                        responses.append(self._make_request("POST", f"/flows/{device_id}", data=body, headers={'Content-type': 'application/json'}))

                # Remove Middleboxes
                elif operation["type"] == "remove":
                    intent = intent.replace("remove", "add")  # Replace operation to check if there is a previously submitted add middlebox intent
                    print(intent)
                    print("PRINT INSTALLED INTENTS PARAMETER DICT")
                    print(installed_intents)
                    middlebox_intent = installed_intents.get(intent).get(self.ip)  # Retrieve intent and requests that were made by this controller
                    if middlebox_intent:
                        print("FOUND THE INTENT")
                        responses.extend(self.revoke_policies(middlebox_intent["output"]["responses"]))
                        api_count += len(middlebox_intent["output"]["responses"])  # One request for each flow rule to be removed.
                        installed_intents.pop(intent)
                        
                    else:
                        raise KeyError("No matching intent to remove!")

                else:  # ACL type
                    request["appId"] = "org.onosproject.acl"
                    if operation["type"] == "block": operation["type"] = "deny"  # Change operation name because of ONOS syntax
                    result = extract_value.search(operation["value"]) # Extract text between (' and ')
                    operation["value"] = result.group(1)
                    request["action"] = operation["type"]
                        
                    # Function
                    if operation["function"] == "service":
                        request["dstIp"] = SERVICE_MAP[operation["value"]]

                    elif operation["function"] == "protocol":
                        request["ipProto"] = operation["value"]
                        
                    else:
                        logging.info("Traffic operation")

                    print(srcip_list)
                    for src_ip in srcip_list:
                        # ip, cidr = src_ip.split("/")

                        request["srcIp"] = src_ip
                        print(request)
                        gen_req.append(request)
                        responses.append(self._make_request("POST", "/acl/rules", data=request, headers={'Content-Type':'application/json'}))
  
        except Exception as e:
            logging.error(f"Something went wrong. Revoking applied policies. Details: {e.args}")
            self.revoke_policies(responses)
            return {
                'status': 500,
                'details': e.args
            }
                    
        print("RESPONSES")
        print(responses)
        print(f"API REQUEST RATE = {api_count}")
        # Craft response details field
        return {
            'status': 200,
            'type': 'nile',
            'controller_ip': self.ip,
            'output': {
                'requests': gen_req,
                'responses': responses
            }
        }
        # result = re.search(r"'(.*?)'", input_string) Extract text between (' and ')
        # result.group(1)    


    # Implements interface method
    def map_topology(self, net_graph):
        logging.info("Starting topology mapping...")
        logging.info("Getting topology information")
        # Three functions to get information about the network and populate the NetworkGraph object.
        #topologyInfo()
        self._devices(net_graph)
        self._hosts(net_graph)
        logging.info("\n\nHost Lines\n")
        logging.info(self.host_lines)
        logging.info("\n\nSwitch Lines\n")
        logging.info(self.device_lines)
        logging.info("\n\nLinks\n")
        logging.info(self.link_lines)


    # Retrieves information about ONOS cluster nodes
    def cluster_nodes(self) -> list:
        logging.info("Getting information about cluster nodes")
        res = self._make_request("GET", "/cluster")
        logging.info("Adding ONOS instances to controller list")
        controller_list = []
        for node in res["content"]["nodes"]:
            if node["ip"] != self.ip:  # Add only other ONOS instances
                node_obj = Onos("", ip=node["ip"])
                controller_list.append(node_obj)
        return controller_list

    # Private methods

    # Function to make requests
    def _make_request(self, method: str, path: str, data={}, headers={}):
        _metrics.increment("msgs_deployer_to_controller")
        if method in ("POST", "DELETE") and ("/flows" in path):
            _metrics.increment("msgs_controller_to_network")

        res = {}
        if data: response = requests.request(method=method, url=self.base_url+path, auth=self.credentials, json=data, headers=headers)
        else: response = requests.request(method=method, url=self.base_url+path, auth=self.credentials, headers={"Accept": "application/json"})
            
        if response.status_code < 299:
            # Add information fields to response object
            if response.headers.get('Location'):
                res["location"] = response.headers.get('Location')
            if response.content:  
                res["content"] = response.json()
            
            return {
                'status': response.status_code,
                **res
            }
            
        else:
            logging.error(f"Error occured for request to {path}!")
            logging.error(f"Response status: {response.status_code}")
            logging.error(f"Response: {response.content}")
            # Craft an error message with request and response information
            raise Exception({
                'message': "A request to the ONOS API returned an error code.",
                'request': {
                    'method': method,
                    'path': path,
                },
                'response': response.json()
            })

    # Makes a line entry for nodes
    def _make_node_line(self, type: str, node_object):
        if type == "host":
            self.host_lines += node_object["id"] + f"[type=host,ip={node_object['ipAddresses'][0]},mac={node_object['mac']}];\n"
        elif type == "switch":
            self.device_lines += node_object["id"] + f"[type=switch,ip={node_object['annotations']['managementAddress']}];\n"

    def _make_link_line(self, type: str, node_object):
        if type == "host":
            for location in node_object["locations"]:
                self.link_lines += node_object["id"] + " -> " + location["elementId"] + f" [src_port=0,dst_port={location['port']},cost=1];\n"  # host -> switch
                self.link_lines += location["elementId"] + " -> " + node_object["id"] + f" [src_port={location['port']},dst_port=0,cost=1];\n"  # switch -> host
        elif type == "switch":
            for link in node_object["egress_links"]:
                self.link_lines += link["src"]["device"] + " -> " + link["dst"]["device"] + f" [src_port={link['src']['port']},dst_port={link['dst']['port']},cost=1];\n"


    # Revoke policies that have already been applied for an intent in case a request fails.
    def revoke_policies(self, policies_list: list):
        deleted = []
        for policy in policies_list:
            print("Deleting policy:", policy["location"])
            # URL encode the device ID string
            url = policy["location"].split("/")
            url[6] = urllib.parse.quote(url[6])
            url_s = "/" + "/".join(url[5:])
            deleted.append(self._make_request("DELETE", url_s))
        return deleted

    # Retrieves information about devices in the network
    def _devices(self, graph: dict):
        logging.info("Getting devices information")
        res = self._make_request("GET", "/devices")
        logging.info("Getting links information\n")
        graph["devices"] = {}
        for device in res["content"]["devices"]:
            logging.info(f"Getting information about {device['id']}")
            egress_links = self._make_request("GET", f"/links?device={device['id']}&direction=EGRESS")
            device["egress_links"] = egress_links["content"]["links"]
            device["controller"] = self.ip
            graph["devices"][device["id"]] = device
            self._make_node_line("switch", device)
            self._make_link_line("switch", device)
            
            
    # Retrieves information about hosts in the network
    def _hosts(self, graph: dict):
        logging.info("Getting hosts information\n")
        res = self._make_request("GET", "/hosts")
        graph["hosts"] = {}
        for host in res["content"]["hosts"]:
            graph["hosts"][host["ipAddresses"][0]] = host
            self._make_node_line("host", host)
            self._make_link_line("host", host)

    # builds an adjacency matrix based on the netgraph of the network
    def _build_adj_matrix(self, netgraph: dict):
        num_nodes = len(netgraph['devices']) + len(netgraph['hosts'])
        elem_node = {}
        node_id = 0
        graph = [[0 for _ in range(num_nodes)] for _ in range(num_nodes)]
        dsu = DisjointSetUnion(num_nodes)       # forma de verificar que um grafo bidirecionado eh conexo

        for device_id in netgraph['devices']:
            elem_node[device_id] = node_id
            node_id += 1
        for host_ip in netgraph['hosts']:
            elem_node[host_ip] = node_id
            node_id += 1

        for device_id in netgraph['devices']:
            node_id = elem_node[device_id]
            for link in netgraph['devices'][device_id]['egress_links']:
                # assumindo que o src sempre eh o meu device
                if link['state'] == 'ACTIVE':
                    graph[node_id][elem_node[link['dst']['device']]] = int(link['src']['port'])
                    dsu.join_set(node_id, elem_node[link['dst']['device']])

        for host_ip in netgraph['hosts']:
            node_id = elem_node[host_ip]
            for link in netgraph['hosts'][host_ip]['locations']:
                graph[node_id][elem_node[link['elementId']]] = int(link['port'])
                graph[elem_node[link['elementId']]][node_id] = int(link['port'])
                dsu.join_set(node_id, elem_node[link['elementId']])

        return (graph, elem_node, dsu.sets == 1)
