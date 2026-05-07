""" Merlin deployer """

import os
import re
import time
import socket
import struct
import json

from utils import config
PATTERN_SWITCH = '[\\s]*On switch [0-9]+\\s\\('
PATTERN_ATTR = '\w+\s*=\s*\w+'
PATTERN_ACTION_OUT = '\sOutput\(\d+\)'


def int2ip(addr):
    return socket.inet_ntoa(struct.pack("!I", addr))


def get_attr(match_list):
    attributes = []
    for attr in match_list:
        match_expr = re.match(PATTERN_ATTR, attr)
        if match_expr:
            attr_string = match_expr.group(0)
            parts = attr_string.split('=')
            key = parts[0].strip()
            value = parts[1].strip()
            attributes.append({'attr': key, 'value': value})
    return attributes


def parse_openflow_match(match_str):
    match_expr = re.split('[\(\)]*', match_str.split('\t')[1])
    attributes = get_attr(match_expr)
    return attributes


def parse_openflow_action(action_str):
    actions = []
    expr_output = re.match(PATTERN_ACTION_OUT, action_str)
    if expr_output:
        action = {'action': 'output'}
        expr_out_port = re.search('\d', expr_output.group(0))
        out_port = expr_out_port.group(0)
        action['port'] = out_port
        actions.append(action)
    return actions


def parse_openflow(lines):
    rule_set = {}
    rules = lines.split('->')
    
    for i in range(int(len(rules) / 2)):
        index = i * 2
       
        switch_expr = re.search(PATTERN_SWITCH, rules[index], re.MULTILINE).group(0)
        switch_expr = str(switch_expr)
        switch_number = re.search('\d+', switch_expr).group(0)
        switch_number = str(switch_number)
        match = parse_openflow_match(rules[index])
        action = parse_openflow_action(rules[index + 1])
        rule_set[switch_number] = {
            'match': match,
            'action': action
        }
    print(rule_set)
    return rule_set


def parse_tc_commands(lines):
    result = {}
    tc_target = filter(lambda x: x.startswith('F'), lines.split('\n'))
    
    for target in tc_target:
        exp = re.search('(\d{1,3}.){3}\d{1,3}', target)
        target_ip = exp.group(0)
        rules = map(lambda x: x.strip(), filter(lambda x: x.startswith('tc'), lines.split('\n')))
        result[target_ip] = rules
  
    return result


def generate_openflow_rules(openflow_commands, output_file):
    print("openflow_commands")
    file = open(output_file, 'w')
    file.write(json.dumps(openflow_commands))


def generate_tc_commands(tc_commands, output_file):
    print("tc_commands")
    file = open(output_file, 'w')
    file.write(json.dumps(tc_commands))


def parse_merlin_output(filename):
    file = open(filename, 'r')
    lines = file.read()
    parts = lines.split('\n')

    tc_conf = parts[4]
    tc_commands = parse_tc_commands(tc_conf)
    openflow_rules = parse_openflow(parts[3])
    
    generate_tc_commands(tc_commands, '/home/heitor/mininet/merlin/res/tc_rules.json')
    generate_openflow_rules(openflow_rules,'/home/heitor/mininet/merlin/res/openflow_rules.json' )

def deploy(merlin_intent):
    """ Magic """
    print("Merlin", merlin_intent)
    start = time.time()

    working_dir = os.getcwd()

    with open('/home/heitor/mininet/merlin/res/merlin_output.txt', 'w') as f:
        f.write(merlin_intent)

    os.chdir(config.MERLIN_WORKKING_PATH)
    full_topology_path = working_dir.split('/nile')[0] + config.TOPOLOGY_DOT_PATH[2:]
    full_output_path = '/home/heitor/mininet/merlin/res/merlin_output.txt'
    
    command = './{} -topo {} {} -verbose >> {}'.format(config.MERLIN_EXEC,
                                                       '/home/heitor/mininet/merlin/res/topology.dot', "/home/heitor/mininet/merlin/generated_merlin.mln", full_output_path)
    os.system(command)

    os.chdir(working_dir)

    with open(full_output_path) as f:
        output = f.read()
        if not re.search('(E|e)rror', output):
            
            parse_merlin_output(full_output_path)
        else:
           
            raise 'Execution error!'

    os.remove(full_output_path)

    elapsed_time = time.time() - start
    return elapsed_time
