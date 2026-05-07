import logging
import re
from abc import ABC, abstractmethod
from typing import override

from classes.target import DeployTarget
from deployer import merlin as merlin_deployer
from utils import topology


class Merlin(DeployTarget):

    def __init__(self):
        super().__init__()
        
    # overriding abstract method
    @override
    def compile(self):
        """ Given parsed operation targets, builds a Merlin intent """
        merlin_intent = ""
        origin_ip, destination_ip = "", ""
        targets_ips = []
        src_services = []
        dst_services = []
        traffics = []
        protocols = []
        middleboxes = []
        rates = []

        if 'origin' in self:
            origin = self['origin']
            if origin['function'] == 'endpoint':
                origin_ip = origin['value'].replace("('", "").replace("')", "")
            else:  # service
                src_services.append(topology.get_service(origin['value'].replace("('", "").replace("')", "")))

        if 'destination' in self:
            destination = self['destination']
            if destination['function'] == 'endpoint':
                destination_ip = destination['value'].replace("('", "").replace("')", "")
            else:  # service
                dst_services.append(topology.get_service(destination['value'].replace("('", "").replace("')", "")))

        if 'targets' in self:
            for target in self['targets']:
                if target['function'] == 'endpoint':
                    targets_ips.append(target['value'].replace("('", "").replace("')", ""))
                elif target['function'] == 'group':
                    targets_ips.append(topology.get_ip_by_handle(target['value'].replace("('", "").replace("')", "")))
                elif target['function'] == 'service':
                    src_services.append(topology.get_service(target['value'].replace("('", "").replace("')", "")))
                elif target['function'] == 'traffic':
                    traffics.append(topology.get_traffic_flow(target['value'].replace("('", "").replace("')", "")))

        for op in self['operations']:
            if op['type'] == 'set':
                if op['function'] == 'bandwidth':
                    params = op['value'].replace("('", "").replace("')", "").split(',')
                    rates.append(params)
                else:
                    middleboxes.append('quota')
            elif op['type'] == 'add':
                param = op['value'].replace("('", "").replace("')", "")
                middleboxes.append(param)
            elif op['type'] == 'allow':
                if op['function'] == 'protocol':
                    param = op['value'].replace("('", "").replace("')", "")
                    protocols.append(param)
                elif op['function'] == 'traffic':
                    middleboxes.append('quota')
                elif op['function'] == 'service':
                    src_services.append(topology.get_service(op['value'].replace("('", "").replace("')", "")))

        merlin_path = ""
        if origin_ip:
            merlin_path += "ipSrc = {} and ".format(origin_ip)
        if destination_ip:
            merlin_path += "ipDst = {}".format(destination_ip)
        merlin_path = merlin_path.rstrip('and ')

        merlin_targets = ""
        for target_ip in targets_ips:
            merlin_targets += "ipDst = {} and".format(target_ip)
        merlin_targets = merlin_targets.rstrip('and')

        merlin_traffic = ""
        for traffic in traffics:
            merlin_traffic += "{}.dst = {} and".format(traffic[0], traffic[1])
        merlin_traffic = merlin_traffic.rstrip('and')

        merlin_protocols = ""
        for protocol in protocols:
            merlin_protocols += "{} = * and".format(protocol)
        merlin_protocols = merlin_protocols.rstrip('and')

        merlin_services = ""
        for srv in src_services:
            merlin_services += " and ".join(["ipSrc = {}".format(srv_ip) for srv_ip in srv[0]])
            merlin_services += " and tcpSrcPort = {}".format(srv[2])
        for srv in dst_services:
            merlin_services += " and ".join(["ipDst = {}".format(srv_ip) for srv_ip in srv[0]])
            merlin_services += " and tcpDstPort = {}".format(srv[2])

        merlin_predicate = ""
        for merlin_op in [merlin_path, merlin_targets, merlin_traffic, merlin_protocols, merlin_services, merlin_protocols]:
            if merlin_op:
                merlin_predicate += " {} and".format(merlin_op)
        merlin_predicate = merlin_predicate.rstrip('and')

        merlin_rates = ""
        for rate in rates:
            merlin_rates = "{}(x, {}{}) and".format(rate[0], rate[1], rate[2])
        merlin_rates = merlin_rates.rstrip('and')

        merlin_mbs = ""

        middleboxes = filter(None, middleboxes)

        for mb in middleboxes:
            merlin_mbs += "{} .* ".format(mb)

        if merlin_rates:
            merlin_rates = ',\n' + merlin_rates.rstrip(',')

        merlin_intent = """
            [
                x : ({}) -> {}
            ]{}
        """.format(merlin_predicate, merlin_mbs, merlin_rates)
        return merlin_intent

    # overriding abstract method
    @override
    def handle_request(self, request):
        """ handles requests """
        status = {
            'code': 200,
            'details': 'Deployment success.'
        }

        intent = request.get('intent')
        policy = None
        try:
            policy, elapsed_time = self.compile(intent)
            merlin_deployer.deploy(policy)
        except ValueError as err:
            logging.error('Error: {}'.format(err))
            logging.info(intent)
            status = {
                'code': 404,
                'details': str(err)
            }

        return {
            'status': status,
            'input': {
                'type': 'nile',
                'intent': intent
            },
            'output': {
                'type': 'merlin program',
                'policy': policy
            }
        }