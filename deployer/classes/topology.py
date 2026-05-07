from typing import List

from classes.controller import Controller

from services import cdn_qoe

class Topology():

    def __init__(self):
        self.nodes = {}
        self.controllers: List[Controller] = []
        self.installed_intents = {}

    def print_nodes(self) -> None:
        for key, value in self.nodes.items():
            print(key, ": ", value, end="\n\n")

    
    # Similar to attach method in observer pattern 
    def add_controller(self, cm: Controller):
        self.controllers.append(cm)


    def notify(self, request) -> None:
        responses = {
            "intent": request.get('intent'),
            "status": 200,
            "controller_responses": {}
        }
        for controller in self.controllers:
            response = controller.update(request, self.nodes, self.installed_intents)
            if response is None:
                continue
            if response.get("status", 500) > 299:
                responses["status"] = response.get("status", 500)
            controller_ip = response.pop("controller_ip", "unknown-controller")
            responses["controller_responses"][controller_ip] = response  
        return responses


    def make_network_graph(self) -> None:
        for controller in self.controllers:
            if controller.controller == "ONOS" and controller.is_main:
                cluster_nodes = controller.cluster_nodes()  # Get cluster nodes objects to add to the controllers list.
                controller.map_topology(self.nodes)
                for node in cluster_nodes:
                    self.add_controller(node)


    # Adds the intent to the installed intents dictionary ["Nile Intent"] = controller_responses
    def add_intent(self, nile_intent: str, controller_responses: dict) -> None:
        self.installed_intents[nile_intent] = controller_responses

    def get_intent(self, intent: str) -> None:
        return self.installed_intents.get(intent)

    # Revoke last installed intent
    def rollback(self):
        intent_tuple = self.installed_intents[-1]
        self.controllers[0].revoke_policies(intent_tuple[1])
