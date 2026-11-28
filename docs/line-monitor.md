# Monitor de linhas e aprendizados

Aba **Análises → Monitor de linhas** (`/app/monitor-linhas`), para líderes e admins. O código fica em `apps/api/src/modules/line-monitor` e `apps/web/src/features/line-monitor`.

## O que fica salvo (migração 085)

| Tabela | Quem grava | O que guarda |
|---|---|---|
| `egress_pc_events` | `EgressService.slotConfig` (reporte de 10 s) e `recordSilentPcs` (tick do pool) | Quando cada PC passou a sair pela internet dele (`online`), parou (`offline`) ou deixou de responder (`silent`). Uma linha por mudança, não por reporte. |
| `line_daily_stats` | `LineDailyStatsService` (a cada 15 min) | Uma linha por número por dia, no fuso da empresa: ligações, atendidas, conversa, atendidas com menos de 10 s, 1005, falhas do Waxum, sem WhatsApp, quedas por causa, reconexões, trocas de PC, bytes do proxy e a configuração da linha no fim do dia. Na primeira execução, refaz os dias passados com `config_estimated = true`, porque a configuração copiada é a de agora. |
| `line_loss_events.detail.context` | `LineLossService.record` | Ficha da linha no momento de uma queda real: saída, camuflagem, perfil, Business, canário, idade, ligações hoje e desde o pareamento, reconexões e trocas de PC em 24 h, e as 10 últimas ligações. |
| `line_learning_runs` | `LineLearningsService.compute` (toda noite após 3h e pelo botão) | Cada cálculo dos aprendizados, com a amostra e os limites dos alertas. |
| `line_notes` | `POST /line-monitor/notes` | O que a equipe mudou e quando, para ler ao lado dos dados. |

## API (`/api/tenants/:tenantId/line-monitor`)

Todas as datas são `AAAA-MM-DD`, no fuso da empresa. Sem datas, vale hoje. O período máximo é de 366 dias.

| Rota | Retorna |
|---|---|
| `GET /now` | Linhas, saídas (PCs e proxies) e alertas |
| `GET /period?from&to` | Totais e tabelas por linha, por atendente e por hora |
| `GET /timeline?from&to&numberId` | Quedas, canário, quarentena, trocas de saída, PCs e notas |
| `GET /history?from&to` | Totais por dia e notas |
| `GET /export.csv?dataset=lines\|daily\|losses\|timeline&from&to` | CSV do conjunto escolhido |
| `POST /notes` | Cria uma nota |
| `DELETE /notes/:id` | Apaga uma nota |
| `GET /learnings` | O último cálculo dos aprendizados |
| `GET /learnings/runs` | Os cálculos salvos |
| `GET /learnings/runs/:id` | Um cálculo salvo |
| `POST /learnings/rebuild` | Calcula de novo e salva |

As mesmas leituras existem no MCP: `line_monitor_now`, `line_period` e `line_learnings`.

## Aprendizados (fórmula v1, `line-learnings.rules.ts`)

- **Queda** é quando o WhatsApp removeu, travou ou baniu temporariamente a linha (`device_removed`, `account_locked`, `temp_banned`).
- **Taxa** são quedas por 100 ligações, suavizadas com `(quedas+1)/(ligações+2)`.
- **Confiança** depende das linhas distintas por trás do número: menos de 5 é "Amostra pequena", de 5 a 9 é "Tendência inicial", 10 ou mais é "Base sólida".
- As perguntas sobre configuração (idade, saída, camuflagem, perfil, Business) só usam os dias gravados no próprio dia.

**As 10 perguntas:**
1. Com quantas ligações as linhas caem.
2. Se a idade da linha importa.
3. Se o volume do dia importa.
4. Se a saída importa: PC contra proxy, e cada saída.
5. Camuflagem, perfil de aparelho e Business.
6. Se o canário funciona.
7. O que acontece nas 10 ligações antes da queda.
8. Os sinais da oferta nas 24 h antes da queda.
9. Trocas de PC e reconexões.
10. Horário das quedas.

## Alertas do Monitor

- **Sempre aparecem:**
  - PC sem internet com linhas;
  - PC acima de "Números por PC";
  - linha que trocou de saída há menos de 60 min.
- **Vêm do último cálculo e só aparecem quando ele não é "Amostra pequena":**
  - **perto do ponto de queda:** a linha passou do 1º quartil de ligações até cair;
  - **muitas 1005:** a taxa de 1005 nas últimas 10 ligações chegou à das linhas antes de cair.
