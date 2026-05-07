from abc import ABC, abstractmethod
import re

from classes.controller import Controller

class DeployTarget(Controller, ABC):
 
    def __init__(self):
        self.controller_ip_addresses = []

   
    def parse_nile(self, intent):
        """ Parses a Nile intent from text and return dictionary with intent operation targets """
        from_pattern = re.compile(r".*from (endpoint|service)(\(\'.*?\'\)).*")
        to_pattern = re.compile(r".*to (endpoint|service)(\(\'.*?\'\)).*")
        target_pattern = re.compile(r".*for ((endpoint|service|group|traffic)(\(\'.*?\'\))(, (endpoint|service|group|traffic)(\(\'.*?\'\)))*).*")
        set_unset_pattern = re.compile(r".*(set|unset) ((quota|bandwidth)(\(\'.*?\'\))(, (quota|bandwidth)(\(\'.*?\'\)))*).*")
        allow_block_pattern = re.compile(r".*(allow|block) ((traffic|service|protocol)(\(\'.*?\'\))(, (traffic|service|protocol)(\(\'.*?\'\)))*).*")
        add_remove_pattern = re.compile(r".*(add|remove) ((middlebox)(\(\'.*?\'\))(, (middlebox)(\(\'.*?\'\)))*).*")
        start_pattern = re.compile(r".*start (hour|datetime|timestamp)(\(\'.*?\'\)).*")
        end_pattern = re.compile(r".*end (hour|datetime|timestamp)(\(\'.*?\'\)).*")
        add_remove_service_pattern = re.compile(r".*(add|remove) ((service)\s*(\(\'.*?\'\))(, (service)\s*(\(\'.*?\'\)))*).*")
        group_ws_pattern = re.compile(r".*for\s+group\s*(\(\'.*?\'\)).*")
        
        op_targets = {
            'operations': [],
            'targets': []
        }

        result = from_pattern.search(intent)
        if result:
            op_targets['origin'] = {
                'function': result.group(1),
                'value': result.group(2)
            }

        result = to_pattern.search(intent)
        if result:
            op_targets['destination'] = {
                'function': result.group(1),
                'value': result.group(2)
            }

        result = group_ws_pattern.search(intent)
        if result:
            has_group = False
            for t in op_targets['targets']:
                if t.get('function') == 'group':
                    has_group = True
                    break
            if not has_group:
                op_targets['targets'].append({
                    'function': 'group',
                    'value': result.group(1)
                })

        results = re.findall(target_pattern, intent)
        if results:
            result = results[0]
            aux = 0
            for idx, match in enumerate(result):
                if idx != 0 and match:
                    if aux == 1:
                        aux = 2
                        continue
                    elif aux == 2:
                        aux = 0
                        continue
                    else:
                        val = result[idx + 1] if idx + 1 < len(result) else ""
                        val = val.rstrip(',')
                        op_targets['targets'].append({
                            'function': match,
                            'value': val
                        })
                        aux += 1

        results = re.findall(set_unset_pattern, intent)
        if results:
            result = results[0]
            operation = ''
            for idx, match in enumerate(result):
                if idx == 0:
                    operation = match
                else:
                    if idx != 1 and idx % 2 == 0 and match:
                        val = result[idx + 1] if idx + 1 < len(result) else ""
                        val = val.rstrip(',')
                        op_targets['operations'].append({
                            'type': operation,
                            'function': match,
                            'value': val
                        })

        results = re.findall(allow_block_pattern, intent)
        if results:
            result = results[0]
            operation = ''
            aux = 0
            for idx, match in enumerate(result):
                if idx == 0:
                    operation = match
                else:
                    if idx != 1 and match:
                        if aux == 1:
                            aux = 2
                            continue
                        elif aux == 2:
                            aux = 0
                            continue
                        else:
                            val = result[idx + 1] if idx + 1 < len(result) else ""
                            val = val.rstrip(',')
                            op_targets['operations'].append({
                                'type': operation,
                                'function': match,
                                'value': val
                            })
                            aux += 1

        results = re.findall(add_remove_pattern, intent)
        if results:
            result = results[0]
            operation = ''
            for idx, match in enumerate(result):
                if idx == 0:
                    operation = match
                elif 'middlebox' not in match and match:
                    op_targets['operations'].append({
                        'type': operation,
                        'value': match
                    })

        results = re.findall(add_remove_service_pattern, intent)
        if results:
            result = results[0]
            operation = ''
            for idx, match in enumerate(result):
                if idx == 0:
                    operation = match
                elif match and 'service' not in match:
                    op_targets['operations'].append({
                        'type': operation,
                        'function': 'service',
                        'value': match
                    })

        result = start_pattern.search(intent)
        if result:
            op_targets['start'] = {
                'function': result.group(1),
                'value': result.group(2)
            }

        result = end_pattern.search(intent)
        if result:
            op_targets['end'] = {
                'function': result.group(1),
                'value': result.group(2)
            }

        return op_targets
    
    
    @abstractmethod
    def compile(self):
        pass
