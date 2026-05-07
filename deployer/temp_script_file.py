"""
    Script test - Getting topology information from ONOS automatically and testing the compile function.
"""

# Imports
# -- Local Imports --
from classes.onos import Onos
from classes.topology import Topology

if __name__ == "__main__":
    topo = Topology()
    onos = Onos(base_url="http://127.0.0.1:8181/onos/v1", ip="172.17.0.3", is_main=True)
    topo.add_controller(onos)
    topo.make_network_graph()
    print("Printing network nodes\n")
    topo.print_nodes()

    print(topo.controllers)
    """
    ACL Intents
    """
    #intent = "define intent stnIntent: for group('professors') block service('netflix')"
    #intent = "define intent stnIntent: for group('professors'), group('students') block service('netflix')"
    #intent = "define intent stnIntent: for group('users') block service('netflix')"
    #intent = "define intent stnIntent: for group('users'), group('students') block service('netflix')"    
    # Test with protocols
    # Endpoint
    intent = "define intent stnIntent: from endpoint('192.168.0.3') to endpoint('192.168.1.3') block protocol('icmp')"  # "define intent stnIntent: from endpoint('19.16.1.1') to endpoint('172.16.22.95') allow service('vimeo'), service('youtube')"
    # Group
    #intent = "define intent stnIntent: for group('professors') block protocol('tcp')"
    """
    QoS Intents
    """
    #intent = ""


    # This will change after the modifications in the topology and onos class.
    #onos.compile(intent, topo.nodes)

    