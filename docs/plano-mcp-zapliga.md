# Plano: MCP do ZapLiga (o Claude operando telefones e números)

Data: 23/11/2026. Status: implementado (ver [mcp.md](mcp.md)). Diferença do plano: as chaves ficam numa tabela própria (`mcp_keys`), por pessoa e ligadas ao recurso de cadastro, em vez de misturadas às chaves do CRM.

## 1. Objetivo

Dar ao Claude (Claude Code, numa conversa com você) ferramentas para **ver e operar** os
telefones do GeeLark e as linhas do ZapLiga: ligar e desligar telefones, ver a tela, tocar e
digitar, conduzir um cadastro, conectar a linha e acompanhar os números. Tudo pela API do
ZapLiga, com as mesmas regras e travas da tela; nada direto no GeeLark, na VPS ou no worker.

Fora do escopo: o Claude receber o código SMS sozinho (o chip está com você), mexer em
cobrança, leads, campanhas ou usuários.

## 2. Arquitetura

```
Claude Code ──HTTPS──▶ API do ZapLiga  POST /mcp  (MCP "Streamable HTTP", sem estado)
   │  Authorization: Bearer <chave MCP>        │
   │                                           ├─▶ WhatsappProvisioningService ─▶ geelark-worker ─▶ phone
   │                                           ├─▶ NumbersService ─▶ Waxum
   │                                           └─▶ AuditService (toda chamada registrada)
```

- **Onde roda:** dentro da API (NestJS), num módulo novo `apps/api/src/modules/mcp`. Sem
  serviço novo para operar.
- **SDK:** `@modelcontextprotocol/sdk` 1.32 (atual em nov/2026; a API é CommonJS e o SDK 1.x
  publica CJS).
- **Sem estado:** cada requisição cria o servidor MCP e o transporte e fecha no fim
  (`sessionIdGenerator: undefined`, resposta JSON). Assim funciona igual em api-a e api-b, sem
  sessão grudada numa instância. O estado de verdade (jobs, telefones) já está no Postgres e
  no worker.
- **As ferramentas chamam os serviços, não as rotas HTTP:** a mesma função que o botão da tela
  chama. Correção no robô vale para a tela e para o MCP ao mesmo tempo.

## 3. Autenticação e permissões

**Chave:** reaproveita as chaves de integração (`crm_integrations`), que já têm hash, prefixo,
revogação, limite por minuto e empresa fixa pela chave. Muda:

- novo `kind = 'mcp'` e escopos novos:

| Escopo | Libera |
|---|---|
| `mcp:read` | listar telefones, PCs, números, cadastros, estatísticas; ver a tela |
| `mcp:operate` | ligar/abrir, desligar, renomear, tocar/digitar, conduzir e cancelar cadastro, conectar linha, reconectar número |
| `mcp:destructive` | apagar telefone, gerar aparelho novo (desligado por padrão) |

- guard novo `McpKeyGuard`: autentica pela chave (mesmo `authenticate` de hoje), confere o
  escopo de cada ferramenta e a flag `whatsapp_provisioning` da empresa para as ferramentas de
  telefone e cadastro. Limite próprio por minuto.
- **Quem cria a chave:** líder ou super admin, no painel de Integrações, botão "Chave para o
  Claude (MCP)". A chave aparece uma vez; o painel mostra o comando pronto para colar.
- **Ator nas ações:** os serviços pedem um usuário; usa quem criou a chave
  (`created_by`), e a auditoria ganha `metadata: { via: 'mcp', integrationId }`.

## 4. Ferramentas

Nomes em inglês (padrão de MCP), descrições em português. Toda saída é JSON curto em texto;
a tela vem como imagem.

### Telefones e PCs (`mcp:read` / `mcp:operate`)

| Ferramenta | O que faz | Serviço |
|---|---|---|
| `list_phones` | telefones, status (ligado cobra por minuto), custo/hora, se há cadastro nele | `listPhones` |
| `list_pcs` | PCs de saída online, IP, de quem é | `listEgress` |
| `open_phone` | liga o telefone saindo por um PC e abre uma sessão de controle; devolve `jobId` | `createJob(mode: control)` |
| `stop_phone` | desliga (encerra cadastro ou sessão nele) | `stopPhone` |
| `rename_phone` | renomeia | `renamePhone` |
| `new_device_phone` / `delete_phone` | aparelho novo / apagar (`mcp:destructive`) | `newDevice` / `deletePhone` |

### Tela (`mcp:read` para ver, `mcp:operate` para mexer)

| Ferramenta | O que faz |
|---|---|
| `view_screen` | print da tela do job, reduzido (JPEG ~540 px de largura) para caber no contexto |
| `screen_elements` | lista dos elementos da tela (texto, id, clicável, posição) — o mesmo `parse_elements` do copiloto |
| `tap` | toca num elemento da lista (`element`) ou num ponto (`x`, `y` de 0 a 1) |
| `type_text` | digita num campo focado |
| `press_key` | voltar, tela inicial, rolar para cima/baixo |
| `end_session` | encerra a sessão "Abrir" e desliga o phone |

Mexer na tela segue a regra de hoje: só com o robô parado (sessão de controle, ajuda manual ou
"Assumir o controle"). Com o robô andando, a ferramenta responde que ele está mexendo.

### Cadastro (`mcp:operate`)

| Ferramenta | O que faz |
|---|---|
| `start_registration` | telefone, PC, app (WhatsApp/Business), número; devolve `jobId` |
| `registration_status` | etapa, o que está esperando, mensagem, erro, histórico curto |
| `send_sms_code` | envia o código **que você passou na conversa** |
| `request_code` | pede outro SMS ou a ligação (o WhatsApp trava o número se repetir demais: a descrição avisa) |
| `send_profile` | nome do perfil (foto fica fora na primeira versão) |
| `take_over` / `resume_robot` | assumir o phone / devolver ao robô |
| `link_to_zapliga` | conecta o número ao ZapLiga (cria a linha, gera e digita o código de pareamento) ou conclui sem conectar |
| `cancel_registration` | cancela e desliga |

### Números (`mcp:read` / `mcp:operate`)

| Ferramenta | O que faz |
|---|---|
| `list_numbers` | linhas, status (conectada, desconectada, quarentena), PC de saída |
| `number_details` | uma linha: status, últimas quedas, chamadas do dia |
| `reconnect_number` | pede a reconexão da sessão |
| `provisioning_stats` | o painel "Como estão os cadastros" |

## 5. Travas

- **Permissão por chamada:** o Claude Code pede sua aprovação a cada ferramenta, a menos que
  você libere. Recomendação: liberar as de leitura, aprovar as de operação uma a uma.
- **Custo:** sessão aberta pelo MCP usa o limite que já existe (encerra com 10 min sem toque ou
  30 min no total) e o phone desliga no fim. `list_phones` mostra o custo por hora de quem está
  ligado.
- **Destrutivas:** só com o escopo `mcp:destructive`, que nasce desligado; mesmo assim o
  Claude Code pede aprovação.
- **Código SMS e de pareamento:** nunca vão para log nem auditoria (como hoje).
- **Texto da tela é dado, não instrução:** as descrições das ferramentas dizem isso, contra um
  WhatsApp (ou golpe) que mostre texto tentando comandar o Claude.
- **Auditoria:** toda ferramenta de operação grava `mcp.<ferramenta>` com a chave usada.
- **Empresa fixa:** a chave decide a empresa; nenhuma ferramenta recebe `tenantId`.

## 6. Mudanças por parte do sistema

| Parte | Mudança |
|---|---|
| API | módulo `mcp` (controller `POST /mcp`, guard, registro das ferramentas), escopos e `kind` novos nas chaves, migration para o `kind`/escopos se houver CHECK no banco |
| Worker | `GET /jobs/{id}/elements` (lista de elementos) e `GET /jobs/{id}/screen?w=540&format=jpeg` (print reduzido) |
| Web | botão "Chave para o Claude (MCP)" no painel de Integrações, com escopos e o comando pronto |
| Docs | `docs/mcp.md`: como conectar, ferramentas, escopos; contrato do worker atualizado |

## 7. Como você conecta

```
claude mcp add --transport http zapliga https://<api>/mcp --header "Authorization: Bearer <chave>"
```

Claude Desktop e claude.ai pedem OAuth para conectores remotos: fica para uma fase futura. O
Claude Code aceita a chave no header.

## 8. Testes

- **Unitários:** cada ferramenta com os serviços simulados (entrada, escopo exigido, saída,
  erro em português, auditoria).
- **Integração:** cliente MCP do próprio SDK chamando `POST /mcp` numa API de teste: lista de
  ferramentas por escopo, chave revogada recusada, empresa isolada.
- **E2E (CI):** jornada nova: cria a chave MCP, lista ferramentas, chama `list_numbers` e
  `provisioning_stats` num Postgres real.
- **Manual:** abrir um telefone pelo Claude Code, ver a tela, tocar, encerrar (e conferir que
  desligou).

## 9. Fases

| Fase | Entrega | Estimativa |
|---|---|---|
| 1 | Base: SDK, `POST /mcp`, chave MCP e guard, ferramentas de leitura (`list_phones`, `list_pcs`, `list_numbers`, `number_details`, `provisioning_stats`) | 0,5 dia |
| 2 | Tela e sessão: `open_phone`, `view_screen`, `screen_elements`, `tap`, `type_text`, `press_key`, `end_session`, `stop_phone`, `rename_phone` + rotas novas do worker | 0,5 dia |
| 3 | Cadastro e conexão: `start_registration` até `link_to_zapliga`, `reconnect_number` | 0,5 dia |
| 4 | Painel da chave, docs, E2E, teste manual com um phone | 0,5 dia |
| Depois | Destrutivas, foto do perfil, OAuth para Claude Desktop/claude.ai | — |

Estimativas são minhas, não medições.

## 10. Decisões

| Decisão | Recomendação |
|---|---|
| Ferramentas destrutivas na primeira versão? | Não; entram depois, atrás do escopo `mcp:destructive` |
| Quem cria a chave MCP? | Líder e super admin (como o cadastro hoje) |
| Uma chave por pessoa ou por empresa? | Por pessoa: a auditoria mostra quem operou |
| Claude Desktop/claude.ai (OAuth) agora? | Não; Claude Code primeiro |

## 11. Riscos

| Risco | Mitigação |
|---|---|
| Chave vazada opera telefones | escopos mínimos, revogação no painel, limite por minuto, auditoria |
| Claude deixa phone ligado | limites de sessão já existentes + desligar no fim + custo visível |
| Claude pede código repetidamente e trava o número | `request_code` com aviso na descrição e o mesmo bloqueio de botões do copiloto para `tap` em "reenviar"/"me ligue" |
| Print grande enche o contexto | JPEG reduzido; `screen_elements` como forma principal de ler a tela |
| SDK do MCP muda de versão | versão fixa no `package.json`; o v2 renomeia classes, não o protocolo |

## Fontes

- Claude Code e MCP remoto com header: https://code.claude.com/docs/en/mcp
- SDK TypeScript do MCP (servidor, modo sem estado): https://ts.sdk.modelcontextprotocol.io/documents/server.html
- Sessões, estado e escala: https://ts.sdk.modelcontextprotocol.io/v2/serving/sessions-state-scaling.html
