""" Disjoint Set Union """

class DisjointSetUnion:

    def __init__(self, num_nodes):
        self.sets = num_nodes
        self.parent = [i for i in range(num_nodes)]
        self.card = [1 for _ in range(num_nodes)]

    
    def find_set(self, node):
        if node == self.parent[node]:
            return node
        self.parent[node] = self.find_set(self.parent[node])
        return self.parent[node]
    

    def same_set(self, node1, node2):
        return self.find_set(node1) == self.find_set(node2)
    

    def join_set(self, node1, node2):
        # no need to join nodes that are already in the same set
        if self.same_set(node1, node2):
            return
        
        self.sets -= 1
        if self.card[node1] < self.card[node2]:
            node1, node2 = node2, node1

        self.parent[node2] = node1
        self.card[node1] += self.card[node2]