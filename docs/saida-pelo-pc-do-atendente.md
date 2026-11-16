# Saída de internet pelo PC do atendente

Objetivo: o WhatsApp ver os números saindo do IP residencial de um atendente,
e não do IP de datacenter da VPS. A sessão do WhatsApp continua na VPS. O PC só
serve de porta de saída para a internet.

```
                        VPS
 ┌──────────────────────────────────────────────────────┐
 │ api-a / api-b ──► waxum (main) ──► internet da VPS
 │        │                                             │
 │        └────────► waxum-edge-1 ─► tailscale-edge-1 ══╪══► PC do atendente ──► internet dele
 │                        │                             │
 │                   NATS compartilhado                 │
 └──────────────────────────────────────────────────────┘
```

## Como funciona

- **Um par de contêineres por PC** (perfil `egress` do `docker-compose.yml`):
  - `tailscale-edge-N` entra na rede Tailscale e usa o PC como *exit node*. O
    tráfego do contêiner sai pelo PC, inclusive o UDP do áudio. A rede interna
    do Docker (NATS, API) continua acessível.
  - `waxum-edge-N` usa a mesma imagem do waxum principal, com volume de sessões
    próprio. Ele roda dentro da rede do `tailscale-edge-N`, então só enxerga a
    internet pelo PC.
- **A API escolhe o waxum de cada número** pela coluna `whatsapp_numbers.waxum_node`.
  O valor `main` é o waxum da VPS; os outros nomes vêm de `WAXUM_EDGE_NODES`.
- **Trocar a saída de um número** é feito em Admin → Empresas → Detalhes →
  Números, no seletor de saída. A sessão do WhatsApp não é transferida: o número
  ganha uma sessão nova no outro waxum e **precisa ler o QR de novo**. A sessão
  antiga é apagada.

## Quando o PC desliga

Cada PC tem um modo, definido em `EDGE_N_FALLBACK`. O vigia
(`infra/egress/edge-entrypoint.sh`) testa o PC a cada 10 s e só considera que
ele caiu depois de 3 falhas seguidas (cerca de 30 s). Assim, uma oscilação
curta do Wi-Fi não troca o IP do número.

| Modo | PC fora | PC volta |
|---|---|---|
| `offline` (padrão) | A Tailscale bloqueia o tráfego. Os números ficam sem internet, e a sessão continua na VPS. | Os números reconectam sozinhos pelo PC. |
| `vps` | O tráfego passa a sair pela VPS. Os números continuam funcionando. | O tráfego volta para o PC. |

- **Ligação em andamento:** a troca de rota derruba a ligação.
- **No modo `vps`:** todos os números desse PC passam a dividir o IP da VPS
  enquanto ele estiver fora.
- **Na inicialização:** o `waxum-edge-N` só sobe depois que o vigia escolhe a
  primeira rota. Assim ele nunca sai pela VPS por acidente.

Cada troca de rota fica no log:

```bash
docker compose logs tailscale-edge-1 | grep egress
```

## Montar um PC (teste com `edge-1`)

### 1. Tailscale (uma vez)

1. Crie a conta em tailscale.com. O plano gratuito basta para o teste.
2. Em *Access controls*, troque a política padrão, que libera tudo entre
   aparelhos, por esta:

   ```json
   {
     "tagOwners": {
       "tag:zapliga-edge": ["autogroup:admin"],
       "tag:atendente-pc": ["autogroup:admin"]
     },
     "grants": [
       { "src": ["tag:zapliga-edge"], "dst": ["autogroup:internet"], "ip": ["*"] }
     ],
     "autoApprovers": { "exitNode": ["tag:atendente-pc"] }
   }
   ```

   Com ela, o contêiner da VPS só pode usar o PC como saída para a internet. O
   PC não acessa a VPS, e a VPS não acessa a rede da casa do atendente.
3. Em *Settings → Keys*, gere uma *auth key* com a tag `tag:zapliga-edge`, sem
   *reusable* e sem *ephemeral*. Ela é usada só no primeiro login: depois o
   estado fica no volume `tailscale_edge_1`.

### 2. PC do atendente (Windows)

1. Instale a Tailscale e entre na conta.
2. No painel da Tailscale, em *Machines*, abra o PC e use *Edit ACL tags* para
   colocar `tag:atendente-pc`.
3. No ícone da bandeja, ative *Exit node → Run exit node*. Com a tag, a
   aprovação é automática.
4. Ainda na bandeja, ative *Preferences → Run unattended*, para que a Tailscale
   continue rodando com o Windows bloqueado.
5. No Windows, desative a suspensão (*Energia → Suspender: Nunca*).
6. Anote o IP do PC na Tailscale, no formato `100.x.y.z`.

### 3. VPS

1. Confira que o servidor tem `/dev/net/tun`.
2. Inclua no `/opt/zapliga/.env`, sem imprimir a chave:

   ```
   COMPOSE_PROFILES=egress
   WAXUM_EDGE_NODES=edge-1=http://tailscale-edge-1:3451
   EDGE_1_TS_AUTHKEY=<auth key do passo 1>
   EDGE_1_EXIT_NODE=<IP 100.x.y.z do PC>
   EDGE_1_FALLBACK=offline
   ```

3. Rode o deploy normal. Ele sobe os serviços `*-edge-*` quando o perfil está
   ligado, e um PC desligado não bloqueia o deploy. A API é recriada e passa a
   enxergar `edge-1`.

## Validar

1. Confira o IP de saída, que precisa ser o da casa do atendente:

   ```bash
   docker compose exec tailscale-edge-1 wget -qO- https://api.ipify.org
   ```

2. `docker compose ps waxum-edge-1` mostra `healthy`.
3. Em Admin, troque a saída de um número de teste para `PC edge-1` e leia o QR.
4. Faça uma ligação real atendida e confira o áudio nos dois sentidos
   (`cliente→servidor pico > 0` no log do discador, como no
   `infra/waxum/README.md`). Compare o atraso com um número na VPS.
5. Desligue o Wi-Fi do PC:
   - em cerca de 30 s, o log mostra a troca de rota;
   - no modo `offline`, o número cai; no modo `vps`, ele continua funcionando.
6. Religue o Wi-Fi e veja o número voltar pelo PC.

## Mudar o modo, incluir PCs, desfazer

- **Mudar o modo:** altere `EDGE_1_FALLBACK` no `.env` e rode
  `docker compose up -d tailscale-edge-1 waxum-edge-1`. Os dois precisam ser
  recriados juntos, porque o waxum usa a rede do contêiner da Tailscale.
- **Incluir outro PC:**
  1. copie os blocos `tailscale-edge-1` e `waxum-edge-1` e os volumes como `-edge-2`;
  2. crie as variáveis `EDGE_2_*`;
  3. acrescente `,edge-2=http://tailscale-edge-2:3451` em `WAXUM_EDGE_NODES`.
- **Desfazer:**
  1. volte os números para `VPS` no Admin e leia o QR de novo;
  2. esvazie `COMPOSE_PROFILES` e `WAXUM_EDGE_NODES`;
  3. rode o deploy.
