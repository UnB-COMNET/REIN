""" The path the deployer installed """

from app import cdn_qoe


class DeployedPath:
    """
    Hops arrive as indices, so they only mean something next to the state list
    they were solved against:

        edges    = [[0, 1], [1, 2]]
        estados  = ["AM", "BA", "CE"]     ONOS's device order at deploy time
        names()   -> [("AM", "BA"), ("BA", "CE")]

    ONOS can reorder /devices afterwards, so a live index has to be re-derived
    from the name. With cdn_qoe.ESTADOS now ["CE", "AM", "BA"]:

        remapped() -> [(1, 2), (2, 0)]    same two hops, current indices
    """

    __slots__ = ("edges", "estados")

    def __init__(self, edges: list, estados: list):
        self.edges = [(int(i), int(j)) for i, j in edges]
        self.estados = estados

    def names(self) -> list:
        return [(self.estados[i], self.estados[j]) for i, j in self.edges]

    def remapped(self) -> list:
        return [(cdn_qoe.ESTADOS.index(a), cdn_qoe.ESTADOS.index(b)) for a, b in self.names()]

    def latency_ms(self) -> float:
        return edges_latency_ms(self.remapped())


# Brief: Summed link latency of edges already indexed into the CURRENT ESTADOS:
# [(1, 2), (2, 0)] -> RTT_MATRIX[1][2] + RTT_MATRIX[2][0]. Ranks paths exactly as
# the solver's objective does, which normalises by a single max and offsets by a
# per-target term equal for every server.
def edges_latency_ms(edges) -> float:
    return sum(cdn_qoe.RTT_MATRIX[i][j] for i, j in edges)
