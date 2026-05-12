# REIN - REdes de INtenções

REIN (REdes de INtenções, Portuguese for "Intent Network") is an Intent-Based Networking (IBN) system designed to simplify network management. Instead of manually configuring low-level network rules, REIN allows users to express desired network behaviors (intents) and automatically translates them into actionable configurations within the network infrastructure.

REIN was developed to operate on top of the ONOS (Open Network Operating System) controller.

## Modules

- **[Deployer](./deployer)** - The engine responsible for processing Nile intents, computing optimal paths, and actively installing flow rules on the ONOS controller.

- **[Supervisor](./supervisor)** - An assurance component responsible for triggering route recalculation whenever service degradation is detected.

> Each module directory also contains its own README file with more detailed documentation, usage instructions, and information for running modules individually.

## Prerequisites

Before running REIN, make sure you have the following installed:

- Docker
- Docker Compose

## Running REIN

### First-time setup (build and start)

```bash
docker-compose up --build
````

This command builds all required images and starts the entire environment.

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
