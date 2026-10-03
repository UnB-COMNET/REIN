# REIN Console

Interface web do REIN: topologia do testbed LFT, intents, monitoramento e experimentos. É um front-end estático (HTML, CSS e JavaScript, sem build nem CDN) servido pelo `console-api`, que executa cada ação com a CLI do LFT e mostra a saída. Sem a API, a interface usa uma emulação no navegador e indica **testbed offline**.

## Executar

O jeito simples é o `rein`: `./rein setup` uma vez, na raiz do REIN, e depois `rein up` sobe o testbed, os serviços e o console (ver o README principal).

À mão, o console requer o LFT clonado ao lado do REIN e instalado, `sudo` sem senha para o `lft` e o `docker`, e Flask e requests no Python. `LFT_BIN` aponta para o `lft` (padrão `/usr/local/bin/lft`; com o `dependencies.sh` do LFT, `<lft>/.venv/bin/lft`) e `LFT_RESULTS_ROOT` para os resultados (padrão `../lft/results`, ao lado do REIN).

```bash
python3 api/app.py
```

Abra `http://localhost:4180`. Como serviço do systemd, a unit `api/rein-console.service` é instalada pelo `./rein setup`, com o usuário e os caminhos desta máquina.

Só a interface, sem testbed: `python3 -m http.server 4180 --bind 127.0.0.1 --directory dist`.

## API

`api/app.py` (Flask, `127.0.0.1:4180`) valida cada pedido e roda `sudo lft ... --json`; o estado genérico do LFT chega à interface no modelo dela (papéis, UF, posições em `~/.rein-console/layout.json`). Ações que mudam o testbed viram jobs: `POST` devolve `{job}` e `GET /api/jobs/<id>/events` transmite por SSE os passos, a saída e o resultado. Mudanças de topologia rodam uma por vez; tráfego e capturas, em paralelo. Profiler, deployer e supervisor ficam em `/api/profiler`, `/api/deployer` e `/api/supervisor`; seus logs, em `/api/rein/logs/<serviço>`.

| Área | Rotas | LFT |
|---|---|---|
| Testbed | `/api/testbed`, `/api/testbed/import`, `/api/testbed/export.py` | `lft topology` |
| Links, switches e hosts | `/api/testbed/links`, `/switches`, `/hosts` | `lft link`, `lft switch`, `lft host` |
| Interfaces e contadores | `/api/ifaces`, `/api/stats` | `lft iface ls`, `lft link stats` |
| Tráfego e capturas | `/api/traffic`, `/api/capture` | `lft traffic`, `lft capture` |
| Monitoramento | `/api/monitor` | (ClickHouse do módulo collector) |
| Experimentos e planos | `/api/experiments`, `/api/experiments/plan`, `/api/runs` | `lft experiment`, `lft timeline run`, `lft results ls` |

`dist/assets/app/api.js` liga a interface à API: quando `GET /api/testbed` responde, as chamadas reais substituem a emulação.

## Desenvolvimento

- `?demo=<estado>` abre um estado fixo para revisão (por exemplo `map`, `node`, `traffic`, `xrun`), sem usar a API; `?intro=0` pula a abertura.
- Testes da API: `cd api && python3 -m pytest test_app.py`.
- Topologias de exemplo para importar: `dist/samples/`.

## Licenças

Mapa: malhas do IBGE, simplificadas. Fontes Inter, IBM Plex Mono e Roboto Condensed sob SIL Open Font License (`dist/assets/fonts/`). GSAP 3.15.0.
