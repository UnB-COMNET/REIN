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

Everything runs on one Linux machine: the [LFT](https://github.com/UnB-COMNET/lft) testbed (ONOS and Open vSwitch in Docker), the REIN services, the language model and the console.

### What the machine needs

- Ubuntu 24.04 or Debian 13, with `sudo`, `git` and Python 3.
- About 6 GB of disk for the images of the testbed and of the services.
- For requests in plain language, an NVIDIA GPU with 4 GB of VRAM or more and its driver installed (`nvidia-smi` answers). The model is a 10 GB image plus about 2 GB of weights. Without a GPU REIN runs all the same, and the chat takes the intents written in Nile.

### From zero

```bash
git clone https://github.com/UnB-COMNET/REIN.git
cd REIN
./rein setup     # once per machine
rein up
```

`./rein setup` installs what is missing, through `sudo`:

- LFT, cloned next to REIN, with its `dependencies.sh`: Docker, Open vSwitch, the `lft` command and the ONOS and switch images
- the video images of the testbed and the images of the REIN services
- `deployer/.env`, with ONOS's default credentials
- the NVIDIA Container Toolkit, when the machine has an NVIDIA GPU (this restarts Docker)
- `sudo` without a password for `lft` and `docker`, the console's service and the `rein` command

`rein up` builds the testbed, starts the services, the model that fits the machine and the console, which is then at http://localhost:4180 (it listens on 127.0.0.1 only: from another machine, `ssh -L 4180:127.0.0.1:4180 <user>@<machine>`). The first `rein up` on a machine with a GPU downloads vLLM's image and the model's weights, so it takes several minutes.

```bash
rein status      # what is up
rein model       # the models and the one in use
rein logs <service>
rein down        # stops everything, --keep-testbed leaves the testbed running
```

`rein up --topology <preset or file>` builds another testbed. Monitoramento reads what the collector module stores (`collector/`, with its OpenTelemetry collector and ClickHouse on 127.0.0.1) when the checkout has it.

### The model that translates the requests

The models run on the machine itself, with vLLM ([`llm/compose.yml`](./llm/compose.yml)). `rein up` picks one from [`llm/models.yaml`](./llm/models.yaml), largest first: one whose server already answers, else the largest that fits the free memory of the GPU, which it starts.

| Model | Takes | For |
|-------|-------|-----|
| `llama` (Llama 3.2 3B, AWQ 4-bit) | 4 GB | cards with more than 4 GB |
| `lite` (Qwen2.5 1.5B, AWQ 4-bit) | 3 GB | 4 GB cards (ultra-lite) |

With less than 3 GB of VRAM free, or no NVIDIA GPU, no model runs. The chat then takes the intent written in Nile, which it accepts on any machine: a request that starts with `define intent` goes to approval as written, with no model.

`rein model lite` puts another model in use, as the console's model menu does: the model REIN started is stopped, so its memory counts as free. One that does not fit is refused. The menu's **Nile direto** sends the intents as written, with no model.

A model that another machine on the network serves is declared in `llm/models.local.yaml`, a file of the machine that stays out of git ([`llm/models.local.example.yaml`](./llm/models.local.example.yaml)). It is used wherever its server answers, and REIN never starts or stops it.

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
