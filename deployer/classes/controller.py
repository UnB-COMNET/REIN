from abc import ABC, abstractmethod

# Controller Interface
class Controller(ABC):
    
    @abstractmethod
    def map_topology(self, graph: dict):
        pass

    @abstractmethod
    def revoke_policies(policies_list: list):
        pass
    
    
    # Observer pattern's update method
    @abstractmethod
    def update(self, request, subject_info):
        pass
