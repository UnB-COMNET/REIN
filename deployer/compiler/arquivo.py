""" Nile compiler """
import time


from deployer import merlin as merlin_deployer




def handle_request(request):
    """ handles requests """
    status = {
        'code': 200,
        'details': 'Deployment success.'
    }

    intent = request.get('intent')
    print(intent)
    policy = None
    try:
        policy = compile(intent)
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



