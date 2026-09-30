# REIN - REdes de INtenções

REIN (REdes de INtenções, Portuguese for "Intent Network") is an Intent-Based Networking (IBN) system designed to simplify network management. Instead of manually configuring low-level network rules, REIN allows users to express desired network behaviors (intents) and automatically translates them into actionable configurations within the network infrastructure.

REIN was developed to operate on top of the ONOS (Open Network Operating System) controller.

## Modules

- **[Deployer](./deployer)** - The engine responsible for processing Nile intents, computing optimal paths, and actively installing flow rules on the ONOS controller.

- **[Supervisor](./supervisor)** - An assurance component responsible for triggering route recalculation whenever service degradation is detected.

> Each module directory also contains its own README file with more detailed documentation, usage instructions, and information for running modules individually.

## Prerequisites

Before running REIN, make sure you have Docker and Docker Compose v2
installed. On a fresh Ubuntu host, one command handles that and the rest of
first-time setup:

```bash
chmod +x dependencies.sh
sudo ./dependencies.sh
```

`dependencies.sh` does everything, in order, and is idempotent (safe to
rerun). The full output also goes to `dependencies.log` (overwritten on
every run):

1. Installs Docker CE + Compose plugin (pinned versions, official Docker
   repository) and adds you to the `docker` group.
2. Creates `deployer/.env` with the default ONOS credentials, if it doesn't
   exist yet.
3. Builds the `deployer`, `supervisor`, `collector` and `gui` images via
   `docker compose build`.

If Docker is already installed, create `deployer/.env` yourself (see step 2
above) and run `docker compose build` (see below) instead.

## Running REIN

### Starting the environment

```bash
docker compose up
```

### Running in detached mode (recommended)

```bash
docker compose up -d
```

### Stopping the environment

```bash
docker compose down
```

### Rebuilding containers after changes

```bash
docker compose up --build -d
```

## Additional Notes

* Make sure Docker is running before starting the environment.
* Depending on the modules enabled, some services may take a few moments to become fully available.
* Check individual module READMEs for specific configuration details and standalone execution instructions.
