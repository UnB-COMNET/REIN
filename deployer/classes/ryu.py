from classes.target import DeployTarget

class Ryu(DeployTarget):
 
    def __init__(self):
        super().__init__()

    # overriding abstract method
    def compile(self):
        print("ok 2")