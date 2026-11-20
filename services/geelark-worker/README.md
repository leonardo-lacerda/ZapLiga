# geelark-worker

Serviço interno (Python 3.12 + FastAPI) que cadastra números de WhatsApp em cloud phones do
GeeLark: aplica o proxy do nó escolhido, liga o phone, conecta por ADB (+ `glogin`), confere o
IP de saída de dentro do phone, instala/abre o app, digita o número, espera o SMS, preenche o
perfil e, se pedido, abre "Conectar com número de telefone" e digita o código de pareamento.

- Contrato (estados, erros, rotas): [`docs/provisioning-contract.md`](../../docs/provisioning-contract.md)
- Motivação: [`docs/plano-cadastro-whatsapp-geelark.md`](../../docs/plano-cadastro-whatsapp-geelark.md)
- Sem porta pública: só a API do ZapLiga fala com ele, com o header `x-worker-token`.

## Variáveis de ambiente

| Variável | Uso |
|---|---|
| `GEELARK_API_TOKEN` | token da OpenAPI do GeeLark (só o worker conhece) |
| `GEELARK_WORKER_TOKEN` | valor exigido no header `x-worker-token` (vazio = tudo responde 401, menos `/health`) |
| `WORKER_MAX_JOBS` | jobs simultâneos (padrão 2) |
| `ADBUTILS_ADB_PATH` | caminho do `adb` (na imagem: `/usr/bin/adb`) |
| `WORKER_DEBUG_DIR` | onde gravar o XML de telas desconhecidas, sem o texto dos campos (padrão `/tmp/geelark-worker-debug`) |
| `WORKER_DATA_DIR` | onde fica `learned_screens.json`, a memória de telas aprendidas; precisa de volume para sobreviver ao deploy (padrão `/tmp/geelark-worker-data`) |
| `ANTHROPIC_API_KEY` | liga o copiloto de IA para telas desconhecidas (lida pelo SDK; sem ela, só a memória e o operador) |
| `WORKER_COPILOT` | `off` desliga o copiloto mesmo com a chave |
| `WORKER_COPILOT_MODEL` / `WORKER_COPILOT_EFFORT` | modelo e esforço do copiloto (padrão `claude-opus-5-5` / `low`) |

### IP esperado (`probeProxy`)

Quando o job chega com `expectedEgressIps` vazio e um `probeProxy` (o `socks-gateway` pela rede
interna, usuário = vaga), o worker consulta `https://api.ipify.org` **por esse proxy** antes de
mexer no phone (até ~15 s). Sem resposta, o job falha com `egress_offline` ("O PC escolhido não
está saindo para a internet agora."); com resposta, esse IP vira o esperado e o IP visto de
dentro do phone precisa ser igual (`egress_mismatch`). Cliente SOCKS5 só com stdlib
(`app/egress_probe.py`); a senha não vai para log, `repr` nem mensagem de erro.

## Proxy SOCKS5 do cadastro (`app/socks5.py`)

A mesma imagem roda o proxy que leva o phone até o PC do atendente
(contrato, seção 4; operação em
[`docs/saida-pelo-pc-do-atendente.md`](../../docs/saida-pelo-pc-do-atendente.md)):

```
cloud phone ──SOCKS5──► socks-gateway:1080 ──► socks-edge-N:1080 (rede do tailscale-edge-N) ──► PC ──► internet
```

- `python -m app.socks5 gateway` — usuário/senha (RFC 1929): usuário `edge-N` (precisa estar em
  `EGRESS_SLOTS`), senha `EGRESS_SOCKS_PASSWORD` (comparação em tempo constante; vazia recusa
  todo mundo). Repassa o CONNECT ao edge da vaga (`EGRESS_UPSTREAM_TEMPLATE`).
- `python -m app.socks5 edge` — sem senha, só alcançável pela rede do Compose. A cada conexão
  lê `EGRESS_ROUTE_FILE` e só aceita se for exatamente `pc` (`offline`/`vps`/`idle`/sem arquivo
  → recusa; se a rota sair de `pc`, as conexões abertas caem). Resolve os nomes dentro da rede
  da vaga e só conecta em IPs públicos (nada de rede do Compose, Tailscale ou loopback).
- Só CONNECT (sem BIND/UDP). Uma linha de log por conexão: vaga, destino, resultado, bytes.

| Variável | Modo | Uso |
|---|---|---|
| `EGRESS_SOCKS_PASSWORD` | gateway | senha do usuário `edge-N` (vazia = recusa tudo) |
| `EGRESS_SLOTS` | gateway | vagas aceitas (padrão `edge-1,…,edge-10`) |
| `EGRESS_UPSTREAM_TEMPLATE` | gateway | onde está o edge da vaga (padrão `tailscale-edge-{n}:1080`) |
| `EGRESS_ROUTE_FILE` | edge | arquivo de rota da vaga (padrão `/egress/route`) |
| `EGRESS_SLOT` | edge | nome da vaga, só para o log |
| `SOCKS_LISTEN_HOST` / `SOCKS_LISTEN_PORT` | ambos | padrão `0.0.0.0:1080` |
| `SOCKS_CONNECT_TIMEOUT` | ambos | segundos para conectar (padrão 15) |
| `SOCKS_IDLE_TIMEOUT` | ambos | segundos sem tráfego até fechar o túnel (padrão 300) |
| `SOCKS_MAX_CONNECTIONS` | ambos | conexões simultâneas (padrão 256) |

## Estrutura

- `app/geelark_api.py` — cliente da API do GeeLark (chamadas serializadas, ≥ 350 ms entre elas).
- `app/jobs.py` — máquina de estados; cada job numa thread; entradas e cancelamento por eventos.
- `app/automation.py` — interface `PhoneAutomation` usada pela máquina de estados.
- `app/device_automation.py` — implementação real (GeeLark + adb + uiautomator2).
- `app/egress_probe.py` — IP do PC pelo `probeProxy` (cliente SOCKS5 mínimo).
- `app/socks5.py` — proxy SOCKS5 do cadastro (`edge` e `gateway`).
- `app/screen_learning.py` — memória de telas: impressão digital da tela, ação gravada, quando confiar nela.
- `app/copilot.py` — copiloto de IA (Claude): uma ação por chamada, de um conjunto fechado; nunca digita.
- `app/screen_resolver.py` — tela desconhecida: memória → IA → operador; aprende com a IA e com o toque do operador.
- `app/whatsapp.py` — seletores das telas (inglês e português). `handle_permission` é um
  `TODO(human)`: enquanto não for implementado, o job falha com `internal` ao ver um diálogo
  de permissão do Android.

Estado dos jobs só em memória: se o worker reiniciar, `GET /jobs/{id}` devolve 404 e a API
marca `worker_lost`. `GET /phones` informa os apps instalados só para phones em que o worker
já rodou um job desde que subiu (senão `null`).

## Tela desconhecida: memória, IA e operador

Quando o `_drive` vê uma tela que `whatsapp.py` não conhece:

1. **Memória** (`learned_screens.json`): se a impressão digital da tela (ids e textos, números
   trocados por `#`) já tem uma ação confiável (`is_trusted`), o robô repete a ação na hora.
2. **Copiloto** (com `ANTHROPIC_API_KEY`): depois de 8 s na tela, pergunta ao Claude uma ação
   por vez (tocar num elemento, voltar, rolar, esperar, desistir), até 8 seguidas e 25 por
   cadastro. Toque em botão bloqueado ("reenviar SMS", "me ligue", "excluir"...) é recusado no
   código. Cada ação que faz a tela andar é gravada na memória.
3. **Operador**: se nada resolveu, o job pede ajuda como antes. O toque dele numa tela
   desconhecida também é gravado na memória (`source: operator`).

Com o tempo, as telas novas viram ações confiáveis e a IA deixa de ser chamada para elas.
`GET /learned-screens` lista o que foi aprendido.

## Rodar e testar

```bash
cd services/geelark-worker
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements-dev.txt   # Linux/macOS: .venv/bin/python
.venv/Scripts/python -m pytest
.venv/Scripts/python -m uvicorn app.main:create_app --factory --port 8080
```

Os testes não falam com o GeeLark nem com nenhum phone (API mockada e automação falsa).
Os testes do proxy sobem gateway, edge e um servidor de eco em processo (asyncio).

Docker: o deploy (`.github/workflows/deploy.yml`) builda a imagem `zapliga-geelark-worker:latest`
antes de subir as vagas (os `socks-edge-N` usam a mesma imagem) e, depois do `web`, sobe
`geelark-worker` e `socks-gateway`. À mão: `docker compose build geelark-worker` e
`docker compose up -d --no-deps geelark-worker socks-gateway`.
