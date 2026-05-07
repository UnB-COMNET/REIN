""" Nile compiler """
import time
import re
from manager import  storage
from deployer import merlin as merlin_deployer

def to_sonata(op_targets):
    """ Given parsed operation targets, builds a SONATA-NFV intent """
    sonata_intent = ''

    middleboxes = []
    src_targets = []
    dest_targets = []

    ip = 2
    # creating middleboxes
    for mb in middleboxes:
        mb_start = 'firewall' if mb == 'firewall' else 'snort'  # support only firewall and ids middleboxes
        mb_start_cmd = '"./start_{}.sh 100 100 100 100 \'128KB\' 0 &"'.format(mb_start)
        mb_sh = 'echo {}\nvim-emu compute start -d vnfs_dc -n {} -i rjpfitscher/genic-vnf --net "(id=input,ip=10.0.0.{}0/24),(id=output,ip=10.0.0.{}1/24)" -c {}\n'.format(
            mb, mb, ip, ip, mb_start_cmd)
        ip += 1
        sonata_intent += mb_sh

    # chaining middleboxes
    for idx, mb in enumerate(middleboxes):
        if idx == 0:
            src = src_targets[0]
            src_sh = 'echo {}\nvim-emu network add -b -src {}:client-eth0 -dst {}:input\n'.format(
                src + '-' + mb, src, mb)
            sonata_intent += src_sh
        elif idx == len(middleboxes) - 1:
            dest = dest_targets[0]
            dest_sh = 'echo {}\nvim-emu network add -b -src {}:output -dst {}:server-eth0\n'.format(
                mb + '-' + dest, mb, dest)
            sonata_intent += dest_sh

        if idx != len(middleboxes) - 1:
            next_mb = middleboxes[idx + 1]
            chain_mb_sh = 'echo {}\nvim-emu network add -b -src {}:output -dst {}:input\n'.format(
                mb + '-' + next_mb, mb, next_mb)
            sonata_intent += chain_mb_sh

    return sonata_intent


def compile(nile, target="Onos"):
    """ Compiles Nile intent into target language. By default, the target language is Merlin. """
    
    start = time.time()
    if target != "Merlin" and target != "Sonata" and target !="Onos":
        raise ValueError("Target language not yet support. Please contact the repo admin.")

    if target == "Merlin":
        #compiled = to_merlin(parse(nile))
        
        compiled = DeployTarget.Merlin.compile(DeployTarget.Merlin.parseNile(nile))
        #R.compile()
 
    elif target == "Sonata":
        compiled = to_sonata(parse(nile))
    elif target == "Onos":
        compiled = to_onos(parse(nile))

    elapsed_time = time.time() - start
    storage.insert(nile, compiled)

    return compiled, elapsed_time


def handle_request(request):
    """ handles requests """
    status = {
        'code': 200,
        'details': 'Deployment success.'
    }

    intent = request.get('intent')
    policy = None
    try:
        policy, elapsed_time = compile(intent)
        merlin_deployer.deploy(policy)
    except ValueError as err:
        print('Error: {}'.format(err))
        print(intent)
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


if __name__ == "__main__":
    test_intent = "define intent uniIntent: from endpoint('19.16.1.1') to service('netflix') add middlebox('loadbalancer'), middlebox('firewall') start hour('10:00') end hour('10:00')"
    merlin, compile_time = compile(test_intent)
    deploy_time = merlin_deployer.deploy(merlin)
    print("Deploy time: ", deploy_time)
