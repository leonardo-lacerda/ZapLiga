# Saída por proxy residencial

Uma linha pode sair por uma **proxy SOCKS5 residencial própria** em vez do PC de um atendente.
Assim ela tem um IP só dela, inclusive nas ligações (UDP), e o consumo de rede fica medido.

## Como funciona

```
Waxum da vaga proxy-1 ──► túnel (tun2socks, proxy-edge-1) ──► proxy SOCKS5 ──► internet (IP residencial)
```

- A vaga `proxy-1` tem dois contêineres: `proxy-edge-1` (o túnel, imagem `xjasonlyu/tun2socks`) e
  `waxum-proxy-edge-1`, que divide a rede com ele. Script: `infra/egress/proxy-entrypoint.sh`.
- A proxy é cadastrada em **Admin → Saídas de internet → Proxies** (`host:porta:usuário:senha`, o
  formato que a Roundproxies copia, ou `socks5://…`). Fica cifrada no banco; o servidor não guarda nada.
  A API entrega a proxy à vaga com o host já resolvido em IP.
- **Trava contra vazamento:** pela rede da VPS a vaga só alcança a rede interna e o servidor da proxy.
  Sem proxy, ou com ela fora do ar, a linha fica sem internet; nunca sai pelo IP da VPS. Testado
  derrubando o túnel: nada saiu.
- A linha só liga quando a vaga está online **e** o UDP passa (`slotOnlineSql`, `pc-network.ts`).
- A redistribuição entre PCs (`EgressPoolService`) não mexe em linhas de vaga de proxy. Para pôr uma
  linha na proxy: Admin → Empresas → Números → saída "Proxy: …" (sem QR).

## Monitoramento

A cada minuto a vaga manda à API (`POST /api/internal/egress/proxy-slots/:slot/report`):

- bytes enviados e recebidos pelo túnel desde o último relatório, total e UDP (a mídia das ligações);
- a cada 5 minutos: IP de saída, teste de UDP (STUN) e latência.

A API guarda:

- `egress_proxy_usage`: bytes por vaga, linha e dia (horário de São Paulo). O painel mostra hoje, mês,
  ligações (UDP) e a **projeção do mês**; o cartão da linha mostra "Rede da proxy: hoje · mês".
- `egress_proxy_events`: troca de IP de saída, proxy caiu e voltou.
- `egress_proxies`: estado atual (online, IP, UDP, latência, último erro).

Os bytes contados são os do túnel. O provedor cobra um pouco mais (cabeçalhos SOCKS e TCP):
conte uns 5 % a mais ao dimensionar o plano.

## Mais vagas de proxy

Cada vaga é um par `proxy-edge-N` + `waxum-proxy-edge-N` no `docker-compose.yml`, mais
`proxy-N=http://proxy-edge-N:3451` em `WAXUM_EDGE_NODES`. Uma linha por vaga: com mais de uma, o
consumo fica na vaga, sem separar por linha.
