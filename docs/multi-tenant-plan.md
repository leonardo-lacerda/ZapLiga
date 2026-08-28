# Plano de implementação: multi-tenant e perfis de acesso

## Objetivo

Transformar o ZapLiga em uma aplicação SaaS multi-tenant, onde cada empresa possui dados e operação isolados, com três perfis:

1. `SDR`: recebe e opera chamadas.
2. `Líder`: administra a equipe e os dados da própria empresa.
3. `Admin supremo`: administra todas as empresas e usuários.

Este plano considera três tipos de usuário, não apenas três contas. Cada empresa poderá ter vários SDRs e um ou mais líderes.

## Diagnóstico atual

O sistema ainda funciona como uma única operação global:

- Não existe login ou autenticação.
- Leads, SDRs, números, chamadas e configurações não possuem `tenant_id`.
- O telefone do lead é único globalmente, e não por empresa.
- Existe apenas uma configuração global do discador.
- O WebSocket identifica o SDR apenas pelo nome, sem autenticação.
- O discador seleciona recursos sem considerar empresas.
- Os endpoints atuais aceitam e retornam dados globais, sem autorização.

## Modelo de dados proposto

Criar estas entidades:

```text
users
  Usuários de login

tenants
  Empresas/clientes

tenant_memberships
  Relação usuário ↔ empresa ↔ papel

invitations
  Convites para entrar em uma empresa

sessions
  Sessões de login e refresh tokens

audit_logs
  Registro de ações importantes
```

Adicionar `tenant_id` às tabelas atuais:

```text
sdrs
leads
whatsapp_numbers
calls
dialer_settings
```

Também serão adicionados:

- `sdrs.user_id`, ligando o SDR ao usuário autenticado.
- Índices compostos por `tenant_id`.
- Unicidade de telefone por empresa: `UNIQUE (tenant_id, phone)`.
- Unicidade de nome de SDR por empresa: `UNIQUE (tenant_id, name)`.
- Chaves estrangeiras compostas para impedir que uma chamada misture lead, SDR e número de empresas diferentes.
- `waxum_session_id` continuará globalmente único.
- O `waxum_session_id` não será exposto diretamente ao frontend.

## Permissões

| Recurso | SDR | Líder | Admin supremo |
|---|---:|---:|---:|
| Receber chamadas | Sim | Opcional | Opcional |
| Alterar disponibilidade própria | Sim | Não | Não |
| Ver dados completos dos leads | Não | Sim | Sim |
| Importar/remover leads | Não | Sim | Sim |
| Gerenciar números WhatsApp | Não | Sim | Sim |
| Iniciar/pausar discador | Não | Sim | Sim |
| Ver chamadas da empresa | Apenas próprias | Sim | Sim |
| Criar/desativar SDRs | Não | Sim | Sim |
| Criar empresas | Não | Não | Sim |
| Criar líderes | Não | Não | Sim |
| Acessar outras empresas | Não | Não | Sim |
| Consultar auditoria global | Não | Apenas própria empresa | Sim |

O frontend esconderá funcionalidades proibidas, mas a proteção real será feita na API.

## Plano de implementação

### Fase 1 — Fundação de autenticação

Criar os módulos:

```text
apps/api/src/modules/auth
apps/api/src/modules/users
apps/api/src/modules/tenants
apps/api/src/modules/memberships
apps/api/src/modules/invitations
apps/api/src/modules/audit
```

Implementar:

- Login por e-mail e senha.
- Senhas com hash seguro usando Argon2 ou bcrypt.
- Access token curto.
- Refresh token rotativo em cookie HttpOnly.
- Logout e revogação de sessões.
- Endpoint `/api/auth/me`.
- Convite de usuário para empresa.
- Aceite de convite e criação de senha.
- Bloqueio/desativação de usuário.
- Validação real de DTOs; o `ValidationPipe` deverá usar whitelist.

O Admin supremo será identificado por um papel global em `users`, enquanto `leader` e `sdr` serão papéis dentro de `tenant_memberships`.

### Fase 2 — Migração segura do banco

Substituir a inicialização automática atual por migrations versionadas:

```text
apps/api/src/database/migrations/
  001_auth_and_tenants.sql
  002_add_tenant_to_domain.sql
  003_constraints_and_indexes.sql
```

Procedimento:

1. Criar backup do banco.
2. Criar uma empresa inicial, por exemplo `Operação legada`.
3. Criar ou configurar o primeiro Admin supremo por variável de ambiente ou comando CLI.
4. Associar todos os dados existentes à empresa inicial.
5. Adicionar `tenant_id` nas tabelas atuais.
6. Converter índices únicos globais em índices por empresa.
7. Transformar `dialer_settings` de uma linha global em uma linha por empresa.
8. Tornar `tenant_id` obrigatório.
9. Remover a dependência de executar o `schema.sql` inteiro a cada inicialização.

Essa etapa preserva os dados existentes e evita que uma nova inicialização misture informações.

### Fase 3 — Contexto de empresa e autorização

Criar:

- `AuthGuard`.
- `TenantGuard`.
- `RolesGuard`.
- Decorators como `@CurrentUser()`, `@CurrentTenant()` e `@Roles()`.

As rotas operacionais deverão usar explicitamente o tenant:

```text
/api/tenants/:tenantId/leads
/api/tenants/:tenantId/numbers
/api/tenants/:tenantId/sdrs
/api/tenants/:tenantId/calls
/api/tenants/:tenantId/dialer
```

O `tenantId` da URL nunca será aceito automaticamente. O backend deverá confirmar que:

- O usuário pertence à empresa.
- O papel dele permite aquela ação.
- O recurso solicitado pertence à mesma empresa.

Para o Admin supremo, a troca de empresa será explícita e auditada.

### Fase 4 — Refatoração do domínio atual

Atualizar todos os módulos atuais:

- Leads.
- SDRs.
- Números WhatsApp.
- Chamadas.
- Discador.
- Dashboard.
- Histórico.

Todas as consultas deverão filtrar por tenant, incluindo `SELECT`, `INSERT`, `UPDATE`, `DELETE`, buscas por ID, imports CSV, QR Code, reconexão de número e reset de lead.

O ideal é criar um repositório ou helper que obrigue o `tenantId` a ser informado, reduzindo o risco de uma consulta esquecer o isolamento.

### Fase 5 — Refatoração do discador e Redis

O discador atual é global. Ele deverá passar a trabalhar por empresa:

- `getSettings(tenantId)`.
- `start(tenantId)`.
- `pause(tenantId)`.
- `manualCall(tenantId, leadId)`.
- `tickTenant(tenantId)`.
- Logs separados por empresa.
- Estado de chamadas contendo `tenantId`.
- Recuperação de chamadas interrompidas por tenant.

As chaves Redis devem incluir a empresa:

```text
zapcall:tenant:{tenantId}:active:global
zapcall:tenant:{tenantId}:active:number:{numberId}
zapcall:tenant:{tenantId}:lock:lead:{leadId}
zapcall:tenant:{tenantId}:lock:sdr:{sdrId}
```

Para produção, o `tick` deverá usar lock distribuído no Redis ou ser executado por um worker único, evitando que múltiplas instâncias da API processem a mesma fila.

### Fase 6 — WebSocket seguro para SDRs

O fluxo baseado em nome deverá ser removido.

Novo fluxo:

1. O SDR faz login.
2. O frontend solicita um ticket temporário para WebSocket.
3. O backend valida usuário, tenant e perfil.
4. O frontend conecta em `/ws/tenants/:tenantId/sdr?ticket=...`.
5. O servidor associa o socket ao `user_id` e `sdr_id`.
6. Mensagens de chamada são enviadas somente ao SDR correto.
7. O ticket expira e só pode ser usado uma vez.

Também serão protegidos `availability`, `hangup`, `outcome`, conexão de áudio e acesso ao `callId`.

O broadcast de logs deverá ser limitado ao tenant correto.

### Fase 7 — Frontend por papel

#### SDR

- Dashboard mínimo.
- Status online/disponível.
- Chamada ativa.
- Resultado da chamada.
- Histórico próprio, se necessário.
- Sem acesso à importação, números, configurações ou dados completos.

#### Líder

- Dashboard da própria empresa.
- Leads e importação CSV.
- Números WhatsApp.
- SDRs.
- Histórico.
- Configurações do discador.
- Convites para SDRs.

#### Admin supremo

- Empresas.
- Líderes.
- Usuários.
- Status das empresas.
- Acesso controlado a uma empresa.
- Auditoria.
- Bloqueio/desbloqueio.
- Limites e configurações globais, se necessários.

O seletor atual de operação será substituído por um seletor real de empresa, conforme as memberships do usuário.

### Fase 8 — Auditoria, segurança e operação

Registrar em `audit_logs`:

- Login e logout.
- Convite e aceite.
- Criação/desativação de usuário.
- Troca de papel.
- Criação/remoção de número.
- Importação e exclusão de leads.
- Início e pausa do discador.
- Alterações de configuração.
- Acesso administrativo a uma empresa.

Adicionar:

- Rate limit no login.
- Expiração de convites.
- Expiração e rotação de refresh tokens.
- HTTPS obrigatório em produção.
- Segredos fora do código.
- Paginação em listas.
- Limites por empresa.
- Backup e restauração testados.
- Sanitização de logs para não registrar tokens ou dados sensíveis.

## Testes obrigatórios

- Testes de login, logout, convite e expiração de sessão.
- Testes da matriz de papéis.
- Testes de isolamento entre duas empresas.
- Testes de IDOR usando IDs de outra empresa.
- Testes de unicidade por tenant.
- Testes de migração com dados legados.
- Testes de WebSocket sem autenticação e com ticket inválido.
- Testes de chamadas entre dois tenants.
- Testes das chaves Redis com tenant.
- Testes de permissões no frontend.
- Regressão do áudio, discador e Waxum.

## Critérios de aceite

A implementação será considerada concluída quando:

- Um usuário de uma empresa não conseguir consultar ou alterar dados de outra.
- O mesmo telefone puder existir em duas empresas diferentes.
- Cada empresa tiver seu próprio discador, fila, números, SDRs e configurações.
- Um SDR só conseguir receber chamadas da empresa vinculada a ele.
- Um WebSocket sem autenticação ou com ticket inválido for rejeitado.
- O líder não conseguir criar outro líder ou acessar o painel administrativo global.
- O Admin supremo conseguir gerenciar empresas e usuários.
- O acesso administrativo a uma empresa ficar registrado em auditoria.
- Os dados atuais forem migrados para uma empresa inicial sem perda.
- Os testes cobrirem autorização, isolamento, WebSocket, Redis e migração.
- `npm run typecheck`, `npm test` e `npm run build` continuarem funcionando.

## Ordem recomendada

1. Banco e modelo de tenants.
2. Autenticação e convites.
3. Guards e autorização.
4. Migração dos endpoints existentes.
5. Discador e Redis por tenant.
6. WebSocket autenticado.
7. Frontend por papel.
8. Auditoria, testes e rollout.

O isolamento precisa estar garantido no banco, nas consultas, no Redis, no discador e no WebSocket simultaneamente.

## Status de implementação

As fases de fundação, migração, autorização, domínio, discador, WebSocket, frontend e hardening foram implementadas no workspace.

- O banco é atualizado exclusivamente pelo executor de migrations versionadas e mantém backup pré-migração em `backups/`.
- O tenant é obrigatório nas tabelas operacionais e o banco impede relações cruzadas entre empresa, lead, número, SDR e chamada.
- As rotas novas de gestão e operação usam `/api/tenants/:tenantId/...`; aliases legados continuam disponíveis somente para compatibilidade e exigem `x-tenant-id`, validado contra a URL e a associação do usuário.
- O WebSocket aceita somente ticket temporário de uso único, vinculado a usuário, empresa e papel SDR.
- O frontend possui seletor real de empresa, telas de equipe/convites e administração global por papel.
- Ações sensíveis são registradas em `audit_logs`; login possui limitação de tentativas e refresh tokens são rotativos e revogáveis.

Comandos de operação:

```bash
npm --workspace apps/api run db:migrate
npm --workspace apps/api run db:migrate:status
npm --workspace apps/api run bootstrap:admin
```
