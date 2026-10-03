# REIN - REdes de INtenções

REIN (REdes de INtenções, Portuguese for "Intent Network") is an Intent-Based Networking (IBN) system designed to simplify network management. Instead of manually configuring low-level network rules, REIN allows users to express desired network behaviors (intents) and automatically translates them into actionable configurations within the network infrastructure.

REIN was developed to operate on top of the ONOS (Open Network Operating System) controller.

## Modules

- **[Deployer](./deployer)** - The engine responsible for processing Nile intents, computing optimal paths, and actively installing flow rules on the ONOS controller.

- **[Supervisor](./supervisor)** - An assurance component responsible for triggering route recalculation whenever service degradation is detected.

- **[Profiler](./profiler)** - Translates requests in natural language into Nile intents, which the operator approves before they reach the deployer.

- **[Console](./console)** - A web console to build and operate the testbed, write and approve intents, watch the network and run experiments.

> Each module directory also contains its own README file with more detailed documentation, usage instructions, and information for running modules individually.

## Running REIN

REIN runs on an [LFT](https://github.com/UnB-COMNET/lft) testbed (ONOS and Open vSwitch in Docker). `rein` brings up the testbed, the services and the console on one Linux machine; it needs sudo, git and Python 3, and `./rein setup` installs the rest (Docker included, through LFT's `dependencies.sh`):

```bash
./rein setup     # once, from the REIN folder: clones LFT next to REIN and installs it, builds the images,
                 # creates deployer/.env and installs the rein command
rein up          # the testbed (diamond-video unless one is running), the services and the console
rein status      # what is up
rein down        # stops everything; --keep-testbed leaves the testbed running
```

The console is then at http://localhost:4180. `rein up --topology <preset or file>` builds another testbed, and `rein logs <service>` shows a service's logs.

The services include the collector module (`collector/`), with its OpenTelemetry collector and ClickHouse, both on 127.0.0.1: the console's Monitoramento shows what it stores.

### The model that translates the requests

`rein up` picks the language model by itself, from [`llm/models.yaml`](./llm/models.yaml), largest first: one whose server already answers, else the largest that fits the free memory of this machine's NVIDIA GPU, which it starts with vLLM ([`llm/compose.yml`](./llm/compose.yml), through the NVIDIA Container Toolkit). The first start downloads vLLM's image and the model's weights.

| Model | Takes | For |
|-------|-------|-----|
| `qwen3.6` (Qwen3.6 35B-A3B) | 25 GB | the lab's shared server, used wherever it answers |
| `llama` (Llama 3.2 3B, AWQ 4-bit) | 4 GB | cards with more than 4 GB |
| `lite` (Qwen2.5 1.5B, AWQ 4-bit) | 3 GB | 4 GB cards (ultra-lite) |

With less than 3 GB of VRAM free, or no NVIDIA GPU, no model runs. The chat then takes the intent written in Nile, which it accepts on any machine: a request that starts with `define intent` goes to approval as written, with no model.

`rein model` lists the models and `rein model lite` puts another in use, as the console's model menu does: the model REIN started is stopped (or put to sleep, on a GPU machine apart), so its memory counts as free. One that does not fit is refused. The menu's **Nile direto** sends the intents as written, with no model.

## Running only the services

The deployer, supervisor and profiler also run on their own with Docker Compose, against an ONOS that is already up. `deployer/.env` holds ONOS's credentials (`ONOSUSER`, `ONOSPASS`).

### First-time setup (build and start)

```bash
docker compose up --build
```

### Starting the environment later

```bash
docker compose up
```

### Running in detached mode

```bash
docker compose up -d
```

### Stopping the environment

```bash
docker compose down
```

### Rebuilding containers after changes

```bash
docker compose up --build
```

## Additional Notes

* Make sure Docker is running before starting the environment.
* Depending on the modules enabled, some services may take a few moments to become fully available.
* Check individual module READMEs for specific configuration details and standalone execution instructions.
