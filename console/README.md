# REIN Console

Interface web do REIN: topologia do testbed LFT, intents, monitoramento e experimentos. É um front-end estático (HTML, CSS e JavaScript, sem build nem CDN) servido pelo `console-api`, que executa cada ação com a CLI do LFT e mostra a saída. Sem a API, a interface usa uma emulação no navegador e indica **testbed offline**.

## Executar

Requer o LFT instalado (`lft` no PATH), `sudo` sem senha para o `lft`, e Flask e requests no Python.

```bash
python3 api/app.py
```

Abra `http://localhost:4180`.

Como serviço (ajuste `User` e os caminhos na unit):

```bash
sudo cp api/rein-console.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rein-console
```

Só a interface, sem testbed: `python3 -m http.server 4180 --bind 127.0.0.1 --directory dist`.

## API

`api/app.py` (Flask, `127.0.0.1:4180`) valida cada pedido e roda `sudo lft ... --json`. Ações que mudam o testbed viram jobs: `POST` devolve `{job}` e `GET /api/jobs/<id>/events` transmite por SSE os passos, a saída e o resultado. Mudanças de topologia rodam uma por vez; tráfego e capturas, em paralelo. Profiler, deployer e supervisor ficam em `/api/profiler`, `/api/deployer` e `/api/supervisor`.

| Área | Rotas | LFT |
|---|---|---|
| Testbed | `/api/testbed`, `/api/testbed/import`, `/api/testbed/export.py` | `lft testbed`, `lft topology` |
| Links, switches e hosts | `/api/testbed/links`, `/switches`, `/hosts` | `lft link`, `lft switch`, `lft host` |
| Interfaces e contadores | `/api/ifaces`, `/api/stats` | `lft iface ls`, `lft link stats` |
| Tráfego e capturas | `/api/traffic`, `/api/capture` | `lft traffic`, `lft capture` |
| Experimentos | `/api/experiments`, `/api/runs` | `lft experiment`, `lft results ls` |

`dist/assets/app/api.js` liga a interface à API: quando `GET /api/testbed` responde, as chamadas reais substituem a emulação.

## Desenvolvimento

- `?demo=<estado>` abre um estado fixo para revisão (por exemplo `map`, `node`, `traffic`, `xrun`), sem usar a API; `?intro=0` pula a abertura.
- Testes da API: `cd api && python3 -m pytest test_app.py`.
- Topologias de exemplo para importar: `dist/samples/`.

## Licenças

Mapa: malhas do IBGE, simplificadas. Fontes Inter, IBM Plex Mono e Roboto Condensed sob SIL Open Font License (`dist/assets/fonts/`). GSAP 3.15.0.
