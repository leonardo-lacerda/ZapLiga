# Saída de internet pelo PC do atendente

Objetivo: o WhatsApp ver os números saindo do IP residencial de um atendente,
e não do IP de datacenter da VPS. A sessão do WhatsApp continua na VPS; o PC só
serve de porta de saída para a internet. Tudo é configurado em
**Admin → Saídas de internet**, sem mexer no servidor.

```
                        VPS
 ┌──────────────────────────────────────────────────────┐
 │ api-a / api-b ──► waxum (main) ──► internet da VPS
 │        │                                             │
 │        └────────► waxum-edge-N ─► tailscale-edge-N ══╪══► PC do atendente ──► internet dele
 └──────────────────────────────────────────────────────┘
```

## Usar

1. **Uma vez:** em Admin → Saídas de internet, siga os 4 passos da tela: criar a
   conta na Tailscale, colar a política, criar a credencial OAuth e colar o
   Client ID e o secret.
2. **Por PC:** "Mostrar comando de instalação" mostra um comando, o mesmo para
   todos os PCs. No PC (Windows), abra o Terminal como administrador, cole e
   aperte Enter. O PC aparece sozinho na lista e ocupa uma vaga. O comando
   instala a Tailscale, liga o PC como saída, mantém a Tailscale rodando com o
   Windows bloqueado e desliga a suspensão. Guarde o comando só com quem
   instala: ele coloca qualquer PC na rede.
3. **Por número:** leia o QR na VPS, como sempre. Com a distribuição automática
   ligada, a plataforma leva o número para o PC online com menos números (até
   o limite por PC). Também dá para escolher a saída à mão em Empresas →
   Detalhes → Números. Em nenhum dos casos é preciso ler o QR de novo.

## Distribuição automática

A cada 30 s, uma instância da API (`EgressPoolService`):

- leva os números conectados que estão na VPS para o PC online com menos
  números, até "Números por PC";
- tira os números de um PC que está fora há mais que o tempo configurado e os
  leva para outro PC online com vaga. Sem PC com vaga, eles vão para a VPS se o
  modo do PC for "saem pela VPS", e esperam o PC voltar se for "números param";
- move no máximo 2 números por rodada e nunca um número em ligação;
- não devolve um número ao PC de onde ele saiu, para o IP dele não ficar
  mudando.

Remover um PC passa os números dele para a VPS e tira o PC da Tailscale.

## Quando o PC desliga

A vaga testa o PC a cada 10 s e só considera que ele caiu depois de 3 falhas
seguidas (cerca de 30 s). Até a distribuição tirar os números de lá, vale o
modo do PC:

| Modo | PC fora | PC volta |
|---|---|---|
| Números param (padrão) | A Tailscale bloqueia o tráfego; os números ficam sem internet. | Reconectam sozinhos pelo PC. |
| Saem pela VPS | O tráfego sai pela VPS; os números continuam funcionando. | O tráfego volta para o PC. |

A troca de rota derruba uma ligação em andamento.

Status na lista: **Online**; **PC sem resposta** (PC desligado ou sem
internet); **Vaga parada na VPS** (o contêiner da vaga não está respondendo:
veja os logs); **Sem vaga livre** (todas as vagas ocupadas).

## Como funciona por dentro

- `docker-compose.yml` tem 10 vagas, cada uma um par:
  - `tailscale-edge-N` roda a Tailscale e o vigia `infra/egress/edge-entrypoint.sh`.
    A cada 10 s ele pergunta à API (`/api/internal/egress/slots/edge-N`, com a
    `WAXUM_API_KEY`) qual PC atende a vaga, entra na Tailscale com uma chave
    criada pela API e ajusta o *exit node*;
  - `waxum-edge-N` roda dentro da rede do `tailscale-edge-N`. Ele só sobe depois
    que a vaga tem um PC (`infra/egress/waxum-edge-guard.sh`), para nunca sair
    pela VPS por engano.
- **Sessões compartilhadas:** todos os waxums montam o mesmo `waxum_data`, onde
  fica a pasta de cada sessão (as chaves do aparelho conectado). Cada waxum das
  vagas tem a própria lista de sessões (`SQLITE_PATH` no volume
  `waxum_edge_N_data`). Trocar a saída de um número
  (`NumbersService.moveToWaxumNode`) é: tirar o número do discador, o waxum de
  origem soltar a sessão (`/disconnect`, sem deslogar) e o de destino abri-la
  (`POST /sessions` com o mesmo `id` e `reuse`). O id da sessão não muda e não
  há QR. Um lock no Redis impede duas trocas do mesmo número.
- Mais vagas: copie os blocos de `edge-10` e acrescente a vaga em
  `WAXUM_EDGE_NODES`.
- `whatsapp_numbers.waxum_node` diz em qual waxum cada número está (`main` ou
  `edge-N`). Um número só passa para um PC que esteja online.
- A API guarda a credencial OAuth e a chave reutilizável do comando de
  instalação criptografadas (`egress_settings`, renovada uma semana antes de
  vencer os 90 dias) e os PCs em `egress_pcs`. Todo aparelho da Tailscale com a
  tag `tag:atendente-pc` vira um PC.
- A política da Tailscale só deixa as vagas usarem os PCs como saída para a
  internet: o PC não acessa a VPS, e a VPS não acessa a rede da casa.

## Proxy do cadastro (GeeLark)

O cadastro de números em cloud phones do GeeLark
([`provisioning-contract.md`](provisioning-contract.md), seção 4) usa a mesma vaga do PC: o
phone fala SOCKS5 com a VPS e sai pela internet do PC, com o mesmo IP das linhas daquela vaga.

```
cloud phone ──SOCKS5──► socks-gateway (porta pública) ──► socks-edge-N ══► PC do atendente ──► internet
             usuário edge-N + senha                     (rede do tailscale-edge-N)
```

- `socks-edge-N` roda dentro da rede do `tailscale-edge-N` e só aceita conexão enquanto
  `/egress/route` for `pc`: com o PC fora (`offline`/`vps`) ou sem PC, recusa — o cadastro nunca
  sai pela VPS. Ele não mexe na vaga: `tailscale-edge-N` e `waxum-edge-N` continuam iguais e
  as linhas que já saem pelo PC não caem.
- `socks-gateway` pede usuário = vaga (`edge-1`…`edge-10`) e senha = `EGRESS_SOCKS_PASSWORD`, e
  repassa para o `socks-edge-N` da vaga. Senha vazia recusa todo mundo.
- Antes de ligar o phone, o `geelark-worker` pergunta o IP do PC pelo mesmo proxy (pela rede
  interna) e depois exige o mesmo IP de dentro do phone.

**A porta vem fechada.** Por padrão ela só escuta em `127.0.0.1`. Para o GeeLark alcançar, no
`.env` de produção (`/opt/zapliga/.env`):

```bash
EGRESS_SOCKS_BIND=0.0.0.0
EGRESS_SOCKS_PORT=1080                       # porta pública (o padrão)
EGRESS_SOCKS_PASSWORD=<senha longa e aleatória>   # ex.: openssl rand -base64 32 | tr -d '/+='
EGRESS_SOCKS_PUBLIC_HOST=<IP ou nome público da VPS>
```

e libere `EGRESS_SOCKS_PORT` (TCP) no firewall da VPS / do provedor. O próximo deploy recria o
`socks-gateway` com a porta aberta (ou, à mão, `docker compose up -d --no-deps socks-gateway`, e
`api-a`/`api-b` para eles lerem a senha). Nunca abra a porta com a senha vazia ou fraca: quem
tiver a senha sai pela internet dos PCs.

Testar de fora da VPS (deve imprimir o IP do PC da vaga, não o da VPS):

```bash
curl --socks5-hostname edge-1:<senha>@<host>:1080 https://api.ipify.org
```

Com o PC da vaga desligado o `curl` falha (o proxy recusa a conexão). Logs: uma
linha por conexão, com vaga, destino e resultado (sem a senha):

```bash
docker compose logs --tail=50 socks-gateway socks-edge-1
```

## Diagnóstico

```bash
docker compose logs tailscale-edge-1 | grep egress          # trocas de rota
docker compose exec tailscale-edge-1 wget -qO- https://api.ipify.org   # IP de saída
docker compose ps | grep edge
```
