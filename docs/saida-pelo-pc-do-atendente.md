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
   conta na Tailscale, colar a política, criar o OAuth client e colar o Client ID
   e o secret.
2. **Por PC:** "Adicionar PC" mostra um comando. No PC (Windows), abra o
   Terminal como administrador, cole e aperte Enter. Em até 1 minuto o PC
   aparece como **Online**. O comando instala a Tailscale, liga o PC como saída,
   mantém a Tailscale rodando com o Windows bloqueado e desliga a suspensão.
3. **Por número:** em Empresas → Detalhes → Números, escolha o PC em "Saída" e
   leia o QR. O QR é lido uma vez; o PC desligar e ligar não pede QR de novo.
   Trocar a saída de novo pede.

## Quando o PC desliga

Cada PC tem um modo, escolhido na lista de PCs. A vaga testa o PC a cada 10 s e
só considera que ele caiu depois de 3 falhas seguidas (cerca de 30 s).

| Modo | PC fora | PC volta |
|---|---|---|
| Números param (padrão) | A Tailscale bloqueia o tráfego; os números ficam sem internet. | Reconectam sozinhos pelo PC. |
| Saem pela VPS | O tráfego sai pela VPS; os números continuam funcionando. | O tráfego volta para o PC. |

A troca de rota derruba uma ligação em andamento.

Status na lista: **Online**; **PC sem resposta** (PC desligado ou sem
internet); **Aguardando instalação** (o comando ainda não rodou no PC);
**Vaga parada na VPS** (o contêiner da vaga não está respondendo: veja os logs).

## Como funciona por dentro

- `docker-compose.yml` tem 5 vagas, cada uma um par:
  - `tailscale-edge-N` roda a Tailscale e o vigia `infra/egress/edge-entrypoint.sh`.
    A cada 10 s ele pergunta à API (`/api/internal/egress/slots/edge-N`, com a
    `WAXUM_API_KEY`) qual PC atende a vaga, entra na Tailscale com uma chave
    criada pela API e ajusta o *exit node*;
  - `waxum-edge-N` roda dentro da rede do `tailscale-edge-N`. Ele só sobe depois
    que a vaga tem um PC (`infra/egress/waxum-edge-guard.sh`), para nunca sair
    pela VPS por engano.
- Vaga sem PC fica parada. Mais vagas: copie os blocos de `edge-5` e
  acrescente a vaga em `WAXUM_EDGE_NODES`.
- `whatsapp_numbers.waxum_node` diz em qual waxum cada número está (`main` ou
  `edge-N`). Um número só passa para um PC que esteja online.
- A API guarda o OAuth client criptografado (`egress_settings`) e os PCs em
  `egress_pcs`. Remover um PC exige tirar os números dele antes; o PC sai da
  Tailscale.
- A política da Tailscale só deixa as vagas usarem os PCs como saída para a
  internet: o PC não acessa a VPS, e a VPS não acessa a rede da casa.

## Diagnóstico

```bash
docker compose logs tailscale-edge-1 | grep egress          # trocas de rota
docker compose exec tailscale-edge-1 wget -qO- https://api.ipify.org   # IP de saída
docker compose ps | grep edge
```
