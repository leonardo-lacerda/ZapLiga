# Plano de implementação — prontidão das features de usuário para lançamento

## 1. Objetivo

Levar o ZapLiga do estado atual, adequado a um piloto acompanhado, até um produto
seguro para lançamento público, sem interromper a operação existente de líderes,
SDRs e administradores da plataforma.

O plano cobre:

- supressão de contatos, opt-out e rastreabilidade de consentimento;
- horários permitidos de discagem;
- recuperação, alteração e verificação de contas;
- aceite versionado de documentos legais;
- retornos agendados com responsável e acompanhamento;
- autonomia para líderes e usuários com múltiplas empresas;
- configuração do discador pelo painel;
- convites automáticos, onboarding e perfil do usuário;
- solicitações LGPD;
- revogação imediata e gestão de sessões;
- testes frontend, E2E e validação operacional de lançamento;
- cobrança, apenas se o lançamento for pago e self-service.

Não fazem parte deste plano: CRM completo, gravação de chamadas, aplicativo móvel,
IA, MFA obrigatório ou reformulação visual ampla.

## 2. Premissas e decisões de produto

### 2.1 Premissas adotadas

- O lançamento público continuará usando os papéis `leader`, `sdr` e
  `super_admin`.
- O telefone continuará único por tenant.
- O timezone oficial continuará em `tenants.timezone`.
- E-mails transacionais usarão a integração Resend já existente.
- O access token continuará curto e o refresh token continuará rotativo em cookie
  HttpOnly.
- As migrations continuarão sendo incrementais, idempotentes e somente de ida.
- A API continuará protegendo permissões; esconder controles no frontend não será
  considerado autorização suficiente.

### 2.2 Decisões que precisam ser registradas antes da implementação

Estas decisões não bloqueiam o planejamento, mas devem ser fechadas na Fase 0:

1. O lançamento será fechado, público gratuito ou público pago?
2. Quais documentos e versões de Termos/Privacidade estarão vigentes?
3. Qual política comercial permite criar uma operação: cadastro público, lista de
   espera ou convite?
4. Quais horários e dias serão o padrão de novas empresas?
5. Um retorno deve pertencer ao mesmo SDR por padrão? Este plano assume que sim.
6. Quem pode retirar um telefone da lista de supressão? Este plano assume líder e
   super admin, sempre com justificativa auditada.
7. Quais dados podem ser anonimizados e quais precisam ser retidos por obrigação
   legal? Validar com assessoria jurídica antes da Fase 6.

## 3. Estado de referência

O núcleo que deve ser preservado já contém:

- autenticação com access token e refresh token rotativo;
- isolamento por `tenant_id` e guards por papel;
- cadastro de empresa e convites;
- números WhatsApp, QR Code, reconexão e quarentena;
- pastas, cadastro e importação CSV de leads;
- discagem automática e manual;
- estação do SDR, áudio, disponibilidade e pós-atendimento;
- callbacks armazenados hoje como `leads.next_eligible_at`;
- métricas, metas, visualizações e exportações;
- auditoria e administração global.

Baseline validada em 30/08/2026:

Estado da implementacao (validacao final em 31/08/2026): as Fases 0-7 foram
implementadas no codigo, banco, interface, observabilidade, documentacao e CI.

- 26 suites backend / 155 testes aprovados;
- 8 arquivos frontend / 11 testes aprovados;
- typecheck, build de producao e verificacao estrutural aprovados;
- smoke test multitenant aprovado (autenticacao, isolamento, quotas, IDOR,
  DTOs, tickets e refresh rotativo);
- 12/12 jornadas E2E do Gate B aprovadas com fake deterministico do Waxum;
- configuracao Docker de desenvolvimento/E2E validada.

A Fase 8 continua condicional: o lancamento atual usa cobranca assistida/manual,
conforme ADR 004, e portanto nao bloqueia o Gate B. O smoke test real contra o
Waxum de staging e a operacao assistida do primeiro piloto sao atividades de
rollout, nao pendencias de implementacao local.

- typecheck de API e frontend aprovado;
- 19 suítes e 130 testes backend aprovados;
- build de produção aprovado;
- verificador de estrutura aprovado;
- verificação multitenant de integração não executada porque API e Docker não
  estavam ativos.

## 4. Estratégia de entrega

O trabalho será entregue verticalmente. Cada fase deve incluir banco, backend,
frontend, auditoria, testes e documentação antes de iniciar a fase seguinte.

| Ordem | Fase | Resultado | Estimativa* |
| --- | --- | --- | ---: |
| 0 | Contratos e baseline | Regras fechadas e ambiente de teste confiável | 2–3 dias |
| 1 | Supressão e compliance de chamadas | Nenhum contato suprimido pode ser chamado | 5–7 dias |
| 2 | Horários e configurações do discador | Discagem somente dentro da política da empresa | 4–6 dias |
| 3 | Ciclo de vida da conta | Usuário controla e recupera o próprio acesso | 6–8 dias |
| 4 | Retornos confiáveis | Callback tem responsável, agenda e estado | 5–7 dias |
| 5 | Autonomia e onboarding | Empresa opera sem depender do super admin | 5–7 dias |
| 6 | LGPD e ciclo de dados | Solicitações de titulares são executáveis e auditadas | 4–6 dias |
| 7 | E2E, rollout e observabilidade | Release validada em ambiente real | 5–7 dias |

\* Estimativa para uma pessoa full-stack familiarizada com o repositório. Total:
36–51 dias úteis. Duas pessoas podem paralelizar frontend e backend depois da Fase
0, mas migrations, contratos e testes E2E continuam no caminho crítico.

Cobrança self-service, se necessária, é uma Fase 8 separada, estimada em 8–12 dias
após a escolha do provedor e das regras comerciais.

## 5. Fase 0 — contratos, métricas e baseline

### Objetivo

Eliminar ambiguidades de produto e criar uma referência reproduzível antes de
alterar jornadas sensíveis.

### Entregas

- Criar ADRs curtos para:
  - política de supressão e retirada de supressão;
  - janela de chamadas e timezone;
  - propriedade e expiração de callbacks;
  - política de cadastro público;
  - retenção e anonimização de dados.
- Definir catálogo oficial dos novos eventos de auditoria.
- Definir textos finais dos e-mails e telas de conta.
- Criar massa de teste com dois tenants, dois líderes e três SDRs.
- Documentar uma chamada de teste autorizada que possa ser repetida em staging.
- Registrar métricas de baseline:
  - sucesso/falha de login;
  - chamadas iniciadas e bloqueadas;
  - callbacks criados e vencidos;
  - e-mails enviados/falhos;
  - tempo até primeira chamada da empresa.

### Critérios de aceite

- Todas as decisões da seção 2.2 têm responsável e resposta registrada.
- `npm run typecheck`, `npm test` e `npm run build` passam.
- `npm run verify:multitenant` passa com o stack local ativo.
- Existe staging com e-mail transacional e uma linha de teste autorizada.

## 6. Fase 1 — supressão, opt-out e consentimento

### 6.1 Modelo de dados

Criar a migration `027_contact_compliance.sql` com:

#### `contact_suppressions`

- `id`;
- `tenant_id`;
- `phone` normalizado;
- `reason` com catálogo inicial:
  - `requested_opt_out`;
  - `invalid_number`;
  - `legal_restriction`;
  - `internal_policy`;
  - `other`;
- `source`: `post_call`, `lead_action`, `import`, `admin` ou `api`;
- `notes`;
- `created_by` e `created_at`;
- `lifted_by`, `lifted_at` e `lift_reason`;
- índice único parcial para uma supressão ativa por `(tenant_id, phone)`;
- índices por tenant, telefone e data.

#### `contact_compliance_events`

Histórico imutável de consentimento, opt-out e mudanças de preferência:

- `tenant_id`, `phone`, `event_type`, `source`, `evidence`, `actor_user_id` e
  `created_at`;
- `event_type`: `consent_recorded`, `opt_out_recorded`, `suppression_lifted` e
  `data_corrected`.

`contact_suppressions` será a fonte canônica. O campo atual `leads.do_not_call`
continuará temporariamente como projeção para compatibilidade e performance.

### 6.2 Backend

Criar um módulo `contact-compliance` com:

- `GET /api/tenants/:tenantId/contact-suppressions`;
- `POST /api/tenants/:tenantId/contact-suppressions`;
- `DELETE /api/tenants/:tenantId/contact-suppressions/:id`, exigindo justificativa;
- `GET /api/tenants/:tenantId/leads/:leadId/compliance`;
- importação CSV de supressões;
- exportação CSV das supressões ativas.

Regras obrigatórias:

- toda criação/importação de lead verifica a supressão pelo telefone;
- toda reserva automática e chamada manual verifica a tabela canônica dentro da
  transação, e não apenas na consulta preliminar;
- exclusão e reimportação de lead não removem a supressão;
- reset de tentativas nunca remove a supressão;
- criar uma supressão durante chamada encerra a elegibilidade futura;
- adicionar `nao_ligar_novamente` ao catálogo de resultados do pós-atendimento;
- `numero_invalido` pode sugerir supressão, mas a política final deve seguir a ADR;
- todas as mutações geram auditoria sem armazenar dados sensíveis desnecessários.

### 6.3 Frontend

- Adicionar ação “Não ligar novamente” no lead e no pós-atendimento.
- Mostrar estado e motivo da supressão na lista/detalhe do lead.
- Adicionar página de “Lista de não contato” para líderes.
- Permitir busca por telefone, importação, exportação e retirada controlada.
- Remover do botão “Resetar” qualquer efeito sobre `do_not_call`.
- Exibir contagem de bloqueados nas métricas da pasta.

### 6.4 Testes

- Unidade: normalização de telefone e regras do catálogo.
- Integração: supressão sobrevive a reset, exclusão e reimportação.
- Concorrência: uma supressão criada durante o tick impede a reserva.
- Autorização: SDR pode registrar opt-out no pós-atendimento, mas não pode retirar
  supressão.
- Multitenant: a supressão de um tenant não afeta outro.
- E2E: tentativa manual e automática de chamar telefone suprimido são bloqueadas.

### Critérios de aceite

- Não existe caminho de API ou WebSocket que inicie chamada para telefone suprimido.
- Toda retirada de supressão contém justificativa e auditoria.
- Reset de lead não altera a preferência de contato.
- Líder consegue consultar e exportar a lista.

## 7. Fase 2 — horários e configurações do discador

### 7.1 Modelo de dados

Criar `028_dialer_schedules.sql`:

#### `dialer_schedule_windows`

- `tenant_id`;
- `day_of_week` de 0 a 6;
- `start_local_time` e `end_local_time`;
- suporte a mais de uma janela no mesmo dia;
- unicidade e validação contra intervalos inválidos.

#### `dialer_schedule_exceptions`

- `tenant_id`, `local_date`, `is_closed`;
- janela opcional de exceção;
- `reason`.

O fuso será lido de `tenants.timezone`. Novos tenants receberão uma grade padrão
definida na Fase 0.

### 7.2 Backend

- Criar `DialerScheduleService` puro e testável.
- Adicionar endpoints de leitura e atualização da agenda.
- Validar a janela:
  - ao iniciar o discador;
  - em cada tick, antes de reservar recursos;
  - antes de uma chamada manual;
  - imediatamente antes da chamada externa, como última barreira.
- Retornar em `/api/dialer/status`:
  - `schedule_state`;
  - `next_open_at`;
  - `timezone`;
  - motivo de bloqueio.
- Ao fechar a janela, não interromper chamadas em andamento; impedir somente novas
  chamadas.
- Registrar auditoria em alterações da agenda e tentativas bloqueadas relevantes.

### 7.3 Frontend

Criar a tela “Configurações da operação” para líderes, contendo:

- timezone;
- agenda semanal e exceções;
- máximo de chamadas simultâneas;
- máximo de tentativas por lead;
- intervalo entre tentativas;
- timeout de toque;
- cooldown padrão dos números;
- resumo do efeito de cada configuração;
- confirmação para mudanças enquanto o discador estiver ativo.

Dashboard:

- distinguir “pausado pelo líder” de “aguardando horário permitido”;
- mostrar próxima abertura;
- alertar configurações inseguras ou incompletas.

### Testes e aceite

- Cobrir virada de dia, domingo, exceções e timezone.
- Cobrir janela que termina durante uma chamada.
- Chamada manual e automática fora da janela retornam erro de domínio consistente.
- Alteração de configuração é aplicada sem reiniciar a API.
- Líder consegue configurar tudo sem usar endpoint manual.

## 8. Fase 3 — ciclo de vida da conta e sessões

### 8.1 Modelo de dados

Criar `029_account_lifecycle.sql`:

- `users.email_verified_at`;
- `users.password_changed_at`;
- `users.force_password_change`;
- tabela `user_action_tokens` com token apenas em hash, finalidade, expiração,
  consumo e tentativas;
- finalidades `verify_email` e `reset_password`;
- tabela `legal_document_versions`;
- tabela `user_legal_acceptances` com versão, IP, user agent e data;
- índices de sessão necessários para consulta por `sid` em todo request autenticado.

### 8.2 Backend

Endpoints públicos:

- `POST /api/auth/password/forgot`;
- `POST /api/auth/password/reset`;
- `POST /api/auth/email/verify`;
- `POST /api/auth/email/resend-verification`.

Endpoints autenticados:

- `PATCH /api/me/profile`;
- `PATCH /api/me/password`;
- `GET /api/me/sessions`;
- `DELETE /api/me/sessions/:sessionId`;
- `POST /api/auth/logout-all` já existente, agora com efeito imediato.

Regras:

- respostas de recuperação não revelam se o e-mail existe;
- tokens são aleatórios, armazenados em hash, de uso único e com TTL curto;
- alterar/resetar senha revoga todas as outras sessões;
- `AuthGuard` valida `sid`, expiração e `revoked_at` da sessão;
- bloqueio de membership ou usuário invalida acesso imediatamente;
- rate limit por IP e identidade nas rotas públicas;
- contas criadas pelo reset administrativo recebem `force_password_change = true`;
- cadastro público exige aceite das versões legais vigentes;
- contas antigas recebem uma tela bloqueante de aceite ao entrar, quando necessário.

### 8.3 Frontend e e-mail

- Rotas “Esqueci minha senha”, “Redefinir senha” e “Verificar e-mail”.
- Tela “Meu perfil” com nome, senha e sessões/dispositivos.
- Cadastro com links e checkbox explícito de Termos e Privacidade.
- Estado claro para link expirado, já usado e e-mail não recebido.
- Templates de verificação, recuperação e aviso de senha alterada.

### Testes e aceite

- Testar expiração, reuso e concorrência de tokens.
- Testar que revogar sessão invalida o access token no próximo request.
- Testar enumeração de usuário e rate limit.
- Testar aceite das versões legais e migração dos usuários existentes.
- Usuário recupera o acesso sem participação do super admin.

## 9. Fase 4 — retornos agendados confiáveis

### 9.1 Modelo de dados

Criar `030_lead_callbacks.sql` com `lead_callbacks`:

- `id`, `tenant_id`, `lead_id` e `origin_call_id`;
- `requested_by_sdr_id` e `assigned_sdr_id`;
- `due_at`;
- `status`: `pending`, `due`, `completed`, `cancelled`, `missed` ou `reassigned`;
- `notes`;
- `completed_call_id`;
- timestamps e autor das mudanças;
- índice único parcial para impedir callbacks pendentes duplicados do mesmo lead;
- índices por tenant, SDR, estado e vencimento.

### 9.2 Regras de negócio

- Resultado `retornar` cria callback para o mesmo SDR por padrão.
- O lead não volta silenciosamente à fila geral.
- Quando vencer:
  - se o SDR responsável estiver conectado, ele recebe prioridade;
  - se estiver offline, o callback permanece visível e vencido;
  - líder pode reatribuir ou liberar para a equipe;
  - nenhuma chamada é iniciada sem respeitar supressão e agenda.
- Nova ligação concluída pode concluir o callback de forma idempotente.
- Excluir lead exige resolver ou cancelar callbacks pendentes.
- Mudanças são auditadas.

### 9.3 Frontend

Para SDR:

- card “Próximos retornos”;
- seções “agora”, “hoje”, “próximos” e “atrasados”;
- aviso em tempo real e badge na navegação;
- ações ligar, reagendar e registrar impedimento.

Para líder:

- agenda consolidada;
- filtro por SDR e estado;
- reatribuição individual e em lote;
- indicador de retornos vencidos.

### Testes e aceite

- Callback nunca é entregue silenciosamente a outro SDR.
- Supressão criada após o agendamento bloqueia o retorno.
- Callback atrasado não desaparece.
- Reatribuição e conclusão são idempotentes e auditadas.
- Reconexão do WebSocket recupera notificações perdidas pela API.

## 10. Fase 5 — autonomia da empresa e onboarding

### 10.1 Líderes e memberships

- Permitir que líder convide e gerencie outro líder da mesma empresa.
- Impedir remoção, bloqueio ou rebaixamento do último líder ativo.
- Exigir confirmação reforçada ao remover o próprio acesso.
- Revogar imediatamente as sessões afetadas.
- Exibir claramente o escopo de cada papel.

### 10.2 Seletor de empresa

- Transformar o workspace atual em seletor acessível.
- Listar somente memberships ativas.
- Ao trocar:
  - cancelar requests e WebSockets do tenant anterior;
  - limpar estados, paginação, QR e chamada manual;
  - definir novo `activeTenantId`;
  - recarregar os dados antes de habilitar ações.
- Persistir somente o identificador, nunca credenciais.
- Se o acesso atual for removido, redirecionar para outra empresa ou para uma tela
  “sem acesso”.

### 10.3 Convites automáticos

- Unificar o mailer de convites de SDR e líder.
- Fila/retry para falha transitória do provedor.
- Mostrar `enviado`, `falhou`, `aberto` quando disponível, `aceito`, `expirado` e
  `revogado`.
- Manter copiar link como fallback e em desenvolvimento.
- Permitir reenvio sem criar convites concorrentes.

### 10.4 Onboarding

Criar checklist por tenant:

1. verificar e-mail;
2. aceitar documentos legais;
3. conectar primeiro número;
4. convidar primeiro SDR;
5. criar/importar primeira pasta;
6. testar áudio;
7. realizar chamada autorizada de teste;
8. revisar horários e tentativas;
9. iniciar a operação.

O progresso deve ser derivado dos dados quando possível. Só armazenar passos que
não possam ser inferidos.

### Critérios de aceite

- Uma empresa consegue ter dois líderes sem ação do super admin.
- Nunca fica sem líder ativo por ação acidental.
- Usuário alterna tenants sem vazamento visual ou de requests.
- Convite chega por e-mail e possui fallback copiável.
- Nova empresa chega à primeira chamada de teste guiada pelo produto.

## 11. Fase 6 — LGPD e ciclo de dados

### 11.1 Ferramentas do tenant

Criar uma área “Privacidade e dados” para líderes:

- busca de titular por telefone;
- visualização das fontes e usos do contato;
- exportação estruturada dos dados do titular;
- criação de solicitação de correção, anonimização ou exclusão;
- acompanhamento do estado e prazo da solicitação;
- retenção da supressão mínima necessária após anonimização, conforme ADR jurídica.

### 11.2 Modelo e processamento

Criar `031_data_subject_requests.sql`:

- `data_subject_requests` com tipo, estado, solicitante, telefone em hash/forma
  protegida, prazos e conclusão;
- log imutável de etapas;
- job idempotente para exportação e anonimização;
- arquivos temporários com expiração e download autenticado.

Regras:

- não apagar registros necessários para impedir novo contato indevido;
- separar exclusão de lead, anonimização de histórico e encerramento de tenant;
- arquivos de exportação nunca ficam públicos;
- todo download, alteração e conclusão são auditados;
- documentar quais dados permanecem e por quê.

### Testes e aceite

- Busca não atravessa tenants.
- Exportação contém somente dados do titular e tenant solicitante.
- Processo pode ser repetido sem corromper dados.
- Anonimização preserva métricas agregadas sem expor identidade.
- Supressão continua efetiva após anonimização.

## 12. Fase 7 — frontend, E2E e rollout

### 12.1 Testes frontend

Adicionar Vitest, React Testing Library e MSW.

Cobrir pelo menos:

- estados de carregamento, sucesso e erro das novas páginas;
- guards e navegação por papel;
- troca de tenant;
- formulário de horários;
- recuperação de senha;
- supressão e callback;
- renovação/revogação de sessão.

### 12.2 Testes E2E

Adicionar Playwright e executar em CI contra o stack completo.

Jornadas obrigatórias:

1. cadastro, aceite legal, verificação e login;
2. recuperação e troca de senha;
3. convite de líder e SDR;
4. troca entre dois tenants sem vazamento;
5. conexão de número e leitura de estado;
6. importação de leads e supressão persistente;
7. discagem bloqueada fora do horário;
8. chamada completa com áudio simulado e pós-atendimento;
9. callback criado, vencido, reatribuído e concluído;
10. exportação/anomização LGPD;
11. revogação imediata de sessão;
12. isolamento multitenant para todas as novas rotas.

O gateway externo deve ser substituído por um fake determinístico nos testes de CI.
Uma smoke test separada em staging validará o contrato real do Waxum.

### 12.3 Observabilidade

Adicionar dashboards/alertas para:

- falha e latência de e-mails;
- tentativas de chamada bloqueadas por supressão ou agenda;
- callbacks vencidos;
- falhas de token de ação;
- sessões revogadas ainda tentando acessar;
- falhas de jobs LGPD;
- erro e latência das jornadas críticas.

Não enviar telefone, e-mail, notas ou tokens para logs/Sentry sem sanitização.

### 12.4 Rollout

- Proteger novos comportamentos com flags por tenant quando houver risco operacional.
- Aplicar migrations antes de habilitar a interface.
- Executar backfill de `leads.do_not_call` para a tabela canônica.
- Habilitar em uma empresa interna, depois duas empresas piloto e por fim todas.
- Manter rollback por flag; migrations são somente de ida.
- Não habilitar cadastro público até o Gate B.

## 13. Fase 8 condicional — cobrança self-service

Executar somente se o lançamento aceitar pagamento sem intervenção comercial.

### Escopo mínimo

- planos e preços versionados;
- checkout hospedado por provedor;
- assinatura, renovação, cancelamento e inadimplência;
- webhooks assinados e idempotentes;
- limites do tenant derivados do plano;
- portal de cobrança e notas/faturas fornecidas pelo provedor;
- período de teste e grace period;
- estado somente leitura antes de bloqueio total;
- auditoria e suporte de reconciliação.

Se a venda e cobrança forem assistidas/manual, esta fase não bloqueia o lançamento.
Nesse caso, documentar o processo operacional e quem altera limites/status do tenant.

## 14. Gates de lançamento

### Gate A — piloto fechado acompanhado

Obrigatório:

- Fases 0, 1 e 2 concluídas;
- recuperação de senha da Fase 3 concluída;
- smoke test real de uma chamada;
- contatos e linha de teste autorizados;
- suporte manual e monitoramento durante a operação.

### Gate B — lançamento público

Obrigatório:

- Fases 0 a 7 concluídas;
- verificação de e-mail e aceite legal ativos;
- callback, supressão e agenda sem pendências críticas;
- E2E verde no CI;
- teste multitenant verde;
- runbooks de suporte, incidente e solicitação LGPD publicados;
- zero defeito P0/P1 aberto nas jornadas críticas.

### Gate C — lançamento pago self-service

Obrigatório:

- Gate B aprovado;
- Fase 8 concluída;
- reconciliação de webhook e cobrança validada em sandbox e produção;
- termos comerciais e atendimento de inadimplência definidos.

## 15. Definição de pronto por entrega

Uma entrega só está pronta quando:

- migration é idempotente e validada em banco vazio e banco com dados;
- API tem DTO, autorização, isolamento e auditoria;
- UI possui loading, vazio, erro, sucesso e acessibilidade básica;
- regras puras têm testes unitários;
- mutações têm testes de integração;
- jornada crítica tem E2E;
- métricas e erros são observáveis sem expor dados sensíveis;
- README/runbook relevante foi atualizado;
- typecheck, testes, build e verificador multitenant passam;
- critérios de aceite da fase foram demonstrados em staging.

## 16. Backlog recomendado

### Épico A — contato seguro

- A1: ADR de supressão e consentimento.
- A2: migrations e backfill.
- A3: serviço e APIs de compliance.
- A4: barreiras no discador automático/manual.
- A5: UI de lead, pós-atendimento e lista de não contato.
- A6: testes concorrentes, multitenant e E2E.

### Épico B — operação dentro da política

- B1: modelo de agenda e exceções.
- B2: motor de janela por timezone.
- B3: bloqueios no start, tick, manual e chamada externa.
- B4: tela completa de configurações.
- B5: dashboard e observabilidade.

### Épico C — conta autônoma

- C1: tokens de ação e mailer.
- C2: recuperação e alteração de senha.
- C3: verificação de e-mail.
- C4: documentos legais versionados.
- C5: sessões próprias e revogação imediata.
- C6: perfil e telas públicas.

### Épico D — retornos

- D1: entidade e migração de callbacks.
- D2: criação pelo pós-atendimento.
- D3: priorização, vencimento e conclusão.
- D4: agenda do SDR.
- D5: gestão pelo líder e notificações.

### Épico E — autonomia e ativação

- E1: múltiplos líderes e proteção do último líder.
- E2: seletor de tenant seguro.
- E3: convites automáticos.
- E4: onboarding e chamada de teste.
- E5: documentação de suporte.

### Épico F — privacidade

- F1: ADR de retenção.
- F2: busca e exportação de titular.
- F3: workflow de solicitação.
- F4: anonimização idempotente.
- F5: auditoria e runbook LGPD.

### Épico G — qualidade de release

- G1: Vitest/RTL/MSW.
- G2: Playwright e fake do Waxum.
- G3: smoke test real em staging.
- G4: dashboards e alertas.
- G5: rollout progressivo e checklist dos gates.

## 17. Ordem imediata sugerida

Os primeiros dez itens a entrar no quadro são:

1. Fechar ADR de supressão e horários.
2. Subir stack e tornar `verify:multitenant` obrigatório no CI.
3. Criar `contact_suppressions` e backfill.
4. Bloquear chamadas automáticas e manuais por telefone suprimido.
5. Adicionar “Não ligar novamente” no pós-atendimento e nos leads.
6. Criar agenda semanal e barreira de horário no discador.
7. Expor configurações do discador no painel.
8. Implementar recuperação e alteração de senha.
9. Validar `sid` revogado no `AuthGuard`.
10. Criar `lead_callbacks` e a agenda de retornos do SDR.
