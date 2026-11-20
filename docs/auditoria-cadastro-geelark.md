# Auditoria do cadastro de WhatsApp no GeeLark

Data: 20/11/2026. Escopo: `services/geelark-worker`, o módulo `whatsapp-provisioning` da API e a
tela `features/provisioning` do web.

**Como ler:** "conferido" = vi no código nesta auditoria. "observado" = aconteceu em produção
nesta semana. "hipótese" = plausível, mas sem prova. A leitura independente do código por
outros agentes foi interrompida antes de terminar; os achados abaixo vêm da minha leitura e
de conferências pontuais, não de uma varredura linha a linha.

## Resumo

O sistema funciona, mas foi construído resolvendo um problema de cada vez. Os três defeitos
que mais pesam contra "escalável e profissional":

1. **O cadastro mora na memória de um processo.** Qualquer deploy ou queda mata os cadastros
   em andamento.
2. **O robô reconhece telas por expressões de texto escritas à mão**, sem telas reais
   gravadas para testar. Cada mudança do WhatsApp vira um incidente.
3. **Não há medição.** Não sabemos a taxa de sucesso por etapa, por IP ou por versão do
   WhatsApp. Toda investigação é manual, olhando print.

Nenhum deles pede trocar de fornecedor ou reescrever tudo. Pedem uma base: estado durável,
telas gravadas e métricas.

## Achados

### 1. Estado e durabilidade (crítico)

| Achado | Evidência |
|---|---|
| Os jobs ficam só na memória do worker. Reiniciou, perdeu. | conferido: `README.md` do worker ("Estado dos jobs só em memória"); a API marca `worker_lost` (`whatsapp-provisioning.service.ts:545`) |
| Todo push no `main` faz deploy e reinicia o worker. | observado: o cadastro do 98155-4290 foi interrompido pelo deploy de 19/11 |
| A memória de telas aprendidas é um arquivo JSON no disco do contêiner. | conferido: `screen_learning.py`; sem volume, some a cada deploy |
| Um job é uma thread parada em `sleep`/`wait`. Não dá para retomar de onde parou. | conferido: `jobs.py` (`_wait_input`, `_run`) |

**Consequência:** não dá para ter mais de um worker, nem fazer deploy em horário de uso.

### 2. Reconhecimento de telas (crítico)

| Achado | Evidência |
|---|---|
| Telas identificadas por regex de texto, em ordem; a primeira que casa ganha. | conferido: `whatsapp.py` `detect_screen` |
| `WAIT_LIMIT_TEXT` casa com "Receber SMS: Tente novamente em 3 horas" na tela de escolher o método. O robô trata como espera em vez de escolher a ligação. | conferido: `whatsapp.py:127` (`tente novamente (em|daqui a) \d` com `.*` dos dois lados); observado em 18/11 |
| Os testes usam telas inventadas (listas de textos), não dumps reais do WhatsApp. | conferido: `tests/test_whatsapp.py` `FakeDevice` |
| Tempos e tentativas fixos espalhados (`timeout=180`, `unknown_grace=20`, `repeats >= 4`, pausas aleatórias). | conferido: `device_automation.py` `_drive` |
| Diálogo de permissão do Android ainda falha o cadastro com `internal`. | conferido: `PERMISSION_TODO_MESSAGE` em `device_automation.py:155` |
| Sem controle de versão do WhatsApp: não sabemos em qual versão cada tela foi vista. | conferido: nada grava a versão do app |

### 3. Escala (alto)

| Achado | Evidência |
|---|---|
| Limite de 2 cadastros simultâneos, uma thread por job, um processo. | conferido: `config.py` `max_jobs: int = 2` |
| Chamadas ao GeeLark em fila única, 350 ms entre elas. | conferido: README do worker |
| A tela ao vivo é um print PNG novo a cada 4 s, pedido pelo navegador, passando pela API e pelo worker. | conferido: `LiveScreen.tsx:6` (`LIVE_SCREEN_REFRESH_MS = 4_000`) |
| Tudo por polling: o navegador pergunta à API, que pergunta ao worker. | conferido: `setInterval` em `LiveScreen.tsx`, `PhonesPanel.tsx`, `useProvisioningJob` |
| Os telefones do GeeLark não têm dono: `listPhones()` devolve todos para qualquer empresa com acesso ao módulo. | conferido: `whatsapp-provisioning.service.ts:195`; aceitável enquanto o recurso for só interno |

### 4. Operação e medição (alto)

| Achado | Evidência |
|---|---|
| Nenhuma métrica: sucesso por etapa, tempo por etapa, bloqueios por IP, custo por cadastro. | conferido: nenhuma ocorrência de métricas no worker |
| Sem ambiente de teste: mudanças são validadas em produção, com número real. | observado: lista de itens "não testados em phone real" cresce a cada entrega |
| O E2E do projeto não cobre o cadastro. | conferido: `launch-readiness.spec.ts` não tem jornada de provisionamento |
| O IP de saída depende de um notebook; mudou de provedor sem ninguém ser avisado. | observado (docs/estudo-ip-de-saida.md) |
| Nenhum limite de cadastros por IP por dia, nem quarentena de IP depois de banimento. | conferido: não existe no código; proposto no estudo de IP |

### 5. Rastro de automação no aparelho (médio, hipótese)

- O uiautomator2 instala um app (`com.github.uiautomator`) e um teclado (`AdbKeyboard`) no
  phone. Já restauramos o teclado depois de digitar, mas o pacote continua instalado.
- **Hipótese, sem prova:** o WhatsApp consegue ver isso. Não achei fonte que confirme quais
  sinais ele lê. Vale medir (cadastros com e sem o pacote) antes de investir.

### 6. Código e contrato (médio)

| Achado | Evidência |
|---|---|
| Arquivos grandes com muitas responsabilidades. | conferido: `socks5.py` 1005 linhas, `device_automation.py` 847, `jobs.py` 805, `whatsapp-provisioning.service.ts` 711 |
| O contrato API↔worker é mantido à mão em quatro lugares (Python, TypeScript da API, tipos do web, markdown). | conferido: listas de etapas e erros repetidas em `schemas.py`, `geelark-worker.client.ts`, `provisioning.types.ts`, `docs/provisioning-contract.md` |
| Um proxy SOCKS5 próprio de mil linhas, com UDP que o GeeLark não usa. | conferido: `socks5.py`; teste de 19/11 mostrou que o cliente do GeeLark nunca pede UDP |
| A tela usa `window.prompt` e `window.confirm` para renomear, apagar e gerar aparelho novo. | conferido: 5 ocorrências em `PhonesPanel.tsx` e afins |
| `is_trusted` devolve sempre `False`: a memória aprende mas nunca age. | conferido: `screen_learning.py:162` (`TODO(human)`) |

### O que está bem feito

- O phone é desligado em todo fim de job, com vigia para o caso de a API esquecer.
- Segredos fora do log; texto de campos apagado dos dumps de diagnóstico.
- Cadastro só sai pelo PC do atendente; o proxy recusa quando a rota não é `pc`.
- Boa cobertura de testes da máquina de estados (258 testes no worker).
- O operador consegue assumir o phone em qualquer ponto.

## Alternativas pesquisadas

| Alternativa | O que resolve | Veredito |
|---|---|---|
| **API oficial do WhatsApp (Cloud API + Calling API)** | Cadastro de número por API, sem phone, sem robô, sem banimento por automação | **Não serve para prospecção fria.** Ligação iniciada pela empresa exige permissão prévia do contato, tem limite de 100 ligações conectadas por dia por número e a permissão cai depois de 4 ligações não atendidas. Vale para clientes que já têm relacionamento com o contato. |
| **Temporal** (fluxos duráveis) | Job sobrevive a deploy e queda; espera humana (SMS) sem thread parada; histórico de cada passo | **Recomendado a médio prazo.** É o padrão para "fluxo longo com gente no meio". Custo: mais um serviço para operar. Antes disso, gravar o estado no Postgres já resolve o principal. |
| **Appium / Maestro** no lugar do uiautomator2 | Esperas embutidas, fluxos declarativos | **Não troca agora.** O Appium usa o mesmo uiautomator2 por baixo. O Maestro é feito para testar app próprio com roteiro fixo, não para reagir a telas imprevisíveis. O ganho não paga a migração. |
| **Mobilerun (DroidRun) / mobile-use** | Agente de IA dirige o Android pelo ADB | **Usar como referência, não como base.** IA em todo toque é lenta, cara e arriscada (pedir SMS na hora errada trava o número). O copiloto que já fizemos usa IA só em tela desconhecida. |
| **ws-scrcpy** (tela ao vivo por vídeo) | Vídeo H.264 fluido no navegador em vez de um print a cada 4 s | **Recomendado depois da base.** Atenção: o projeto não tem criptografia nem login; tem de ficar atrás da nossa API. |
| **Outros cloud phones** (DuoPlus, VMOS, MoreLogin) | Cobrança por assinatura, mais controle de SIM/GPS | **Não é o gargalo.** Todos oferecem API + ADB parecidos. Trocar de fornecedor não resolve nenhum dos três defeitos principais. |
| **MCP / CLI do GeeLark** | Assistente de IA cria e liga phones | Não mexe dentro do WhatsApp. Sem uso aqui. |

## O que já foi feito (20/11/2026)

| Item do plano | Situação |
|---|---|
| 1. Bug do `WAIT_LIMIT` na tela de método | Feito: a lista de métodos é reconhecida antes da espera; SMS bloqueado → ligação de voz |
| 2. Gravar toda tela vista com a versão do app | Feito: `screen_archive.py`, em `/data/screens/{app}/{versão}/` |
| 3. Eventos por etapa | Feito com o histórico que já existia + versão do app no job; painel "Como estão os cadastros" e `GET provisioning/stats` |
| 4. Deploy que espera os cadastros | Feito: `POST /drain` + espera de até 25 min no deploy quando a imagem do worker muda |
| 5. Volume, regra `is_trusted`, copiloto | Feito: volume `geelark_worker_data`; confia após 2 acertos da IA ou 1 do operador, sem falha; copiloto liga com `ANTHROPIC_API_KEY` |
| 6. Estado do job no Postgres, retomável | Feito no essencial: a API (Postgres) recria o cadastro perdido com `resume` e o worker continua de onde o WhatsApp parou |
| 7. Memória de telas no Postgres | Não feito: com um worker só, o arquivo no volume basta. Necessário só com vários workers |
| 8. Contrato único | Feito em parte: teste que lê os códigos de erro e etapas do worker e exige rótulo na tela. Tipos ainda escritos à mão |
| 9. Limite por IP e quarentena | Feito: `blockedEgressIps` (3 por dia, 48 h depois de banimento) |
| 10. Vários workers e fila | Não feito: depende do item 7 e de decidir onde rodar os workers |
| 11. Tela ao vivo por vídeo | Não feito: projeto à parte (ws-scrcpy atrás da API) |
| 12. Modais no lugar de `prompt`/`confirm` | Feito no cadastro (`useDialog`) |
| 13. Dividir arquivos grandes; UDP | Não feito: mexer só para dividir arrisca quebrar sem ganho imediato; o UDP fica desligado sem uso |
| 14. Ambiente de teste | Não feito: precisa de um phone e um número só para teste |

## Plano por fases

**Fase 1 — Base (1 a 2 semanas).** Sem isso, o resto não se sustenta.
1. Corrigir o bug do `WAIT_LIMIT` na tela de método (escolher ligação quando o SMS está bloqueado).
2. Gravar o dump (sem texto de campos) e o print de **toda** tela vista, com a versão do WhatsApp. Vira a base de testes com telas reais.
3. Registrar eventos por etapa (início, fim, resultado, IP, phone, versão do app) numa tabela. É a medição que falta; pode ir para o ClickHouse depois.
4. Deploy que espera os cadastros em andamento terminarem antes de reiniciar o worker.
5. Volume para a memória de telas; definir a regra `is_trusted`; ligar o copiloto.

**Fase 2 — Durabilidade (2 a 4 semanas).**
6. Estado do job no Postgres, com etapas retomáveis. Avaliar o Temporal aqui.
7. Memória de telas no Postgres, compartilhada entre workers.
8. Contrato único (OpenAPI gerado do worker) com tipos gerados para a API e o web.
9. Limite de cadastros por IP por dia e quarentena de IP depois de banimento.

**Fase 3 — Escala e acabamento.**
10. Vários workers; fila de cadastros.
11. Tela ao vivo por vídeo (ws-scrcpy) atrás da API.
12. Modais de verdade no lugar de `window.prompt`/`confirm`.
13. Dividir os arquivos grandes; remover o UDP do proxy se continuar sem uso.
14. Ambiente de teste com um phone e um número de sacrifício.

## Fontes

- Meta, Cloud API Calling: https://developers.facebook.com/documentation/business-messaging/whatsapp/calling
- Meta, registro de número: https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/registration/
- Infobip, ligações iniciadas pela empresa: https://support.infobip.com/docs/whatsapp/whatsapp-business-calling/business-initiated-calling
- Temporal, humano no fluxo: https://docs.temporal.io/ai-cookbook/human-in-the-loop-python
- Temporal, versão de workers: https://docs.temporal.io/worker-versioning
- Maestro, condições: https://docs.maestro.dev/advanced/conditions
- Comparação Maestro e Appium: https://quashbugs.com/blog/maestro-vs-appium
- ws-scrcpy: https://github.com/NetrisTV/ws-scrcpy
- Mobilerun: https://github.com/droidrun/mobilerun
- mobile-use: https://github.com/minitap-ai/mobile-use
- uiautomator2: https://www.github.com/openatx/uiautomator2
- Comparação de cloud phones: https://www.coronium.io/blog/best-cloud-phone-providers
- GeeLark, API, CLI e MCP: https://www.thailand-business-news.com/?p=336309
