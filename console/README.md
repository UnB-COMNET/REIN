# REIN Console

REIN's web interface: the topology of the LFT testbed, intents, monitoring and experiments. It is a static front end (HTML, CSS and JavaScript, with no build step and no CDN) served by `console-api`, which runs each action with LFT's CLI and shows the output. Without the API, the interface uses an emulation in the browser and says **testbed offline**.

## Running

The simple way is `rein`: `./rein setup` once, at the root of REIN, and then `rein up` starts the testbed, the services and the console (see the main README).

By hand, the console needs LFT cloned next to REIN and installed, `sudo` without a password for `lft` and `docker`, and Flask and requests in Python. `LFT_BIN` points to `lft` (default `/usr/local/bin/lft`; with LFT's `dependencies.sh`, `<lft>/.venv/bin/lft`) and `LFT_RESULTS_ROOT` to the results (default `../lft/results`, next to REIN).

```bash
python3 api/app.py
```

Open `http://localhost:4180`. As a systemd service, the unit `api/rein-console.service` is installed by `./rein setup`, with this machine's user and paths.

Only the interface, with no testbed: `python3 -m http.server 4180 --bind 127.0.0.1 --directory dist`.

## Language

The console is in English. Portuguese is an option: the button at the right of the header switches between `EN` and `PT`, and the choice is kept in the browser.

The scripts write the English text, marked with `` L`...` `` (`dist/assets/app/i18n.js`). `dist/assets/app/pt.js` holds the Portuguese of each text: a text without an entry there stays in English.

## API

`api/app.py` (Flask, `127.0.0.1:4180`) validates each request and runs `sudo lft ... --json`. LFT's generic state reaches the interface in its own model (roles, state, positions in `~/.rein-console/layout.json`). Actions that change the testbed become jobs: `POST` answers `{job}` and `GET /api/jobs/<id>/events` streams the steps, the output and the result over SSE. Topology changes run one at a time, while traffic and captures run in parallel. The profiler, the deployer and the supervisor are under `/api/profiler`, `/api/deployer` and `/api/supervisor`, and their logs under `/api/rein/logs/<service>`.

| Area | Routes | LFT |
|---|---|---|
| Testbed | `/api/testbed`, `/api/testbed/import`, `/api/testbed/export.py` | `lft topology` |
| Links, switches and hosts | `/api/testbed/links`, `/switches`, `/hosts` | `lft link`, `lft switch`, `lft host` |
| Interfaces and counters | `/api/ifaces`, `/api/stats` | `lft iface ls`, `lft link stats` |
| Traffic and captures | `/api/traffic`, `/api/capture` | `lft traffic`, `lft capture` |
| Monitoring | `/api/monitor` | (the collector module's ClickHouse) |
| Models | `/api/models` | (`rein model`) |
| Experiments and plans | `/api/experiments`, `/api/experiments/plan`, `/api/runs` | `lft experiment`, `lft timeline run`, `lft results ls` |

`dist/assets/app/api.js` connects the interface to the API: when `GET /api/testbed` answers, the real calls replace the emulation.

## Development

- `?demo=<state>` opens a fixed state for review (for example `map`, `node`, `traffic`, `xrun`), without the API. `?intro=0` skips the opening.
- API tests: `cd api && python3 -m pytest test_app.py`.
- Sample topologies to import: `dist/samples/`.

## Licenses

Map: IBGE meshes, simplified. Inter, IBM Plex Mono and Roboto Condensed fonts under the SIL Open Font License (`dist/assets/fonts/`). GSAP 3.15.0.
