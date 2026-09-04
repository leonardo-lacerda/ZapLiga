# Evidência do Lote 01 — domínio de campanhas e leitura

Data da validação: 2026-09-04  
Base do lote: `aa3ee8f`  
Escopo: implementação e validação local; nenhuma ação em produção.

## Resultado

O domínio de leitura de campanhas está disponível sob a flag tenant-scoped
`campaigns`. A aplicação antiga continua operando sem conhecer as novas tabelas. Ao
habilitar a flag, líderes e superadministradores podem listar e consultar a campanha
legada que representa a configuração anterior ao novo domínio.

Endpoints entregues:

```text
GET /api/tenants/:tenantId/campaigns
GET /api/tenants/:tenantId/campaigns/:campaignId
```

Ambos exigem autenticação, membership ativa, papel `leader`/`super_admin` e a flag
`campaigns`. Uma flag desligada retorna bloqueio seguro; um ID existente em outro
tenant retorna 404.

## Banco e compatibilidade

A migration `043_campaigns_read_model.sql` cria, de forma aditiva:

- `campaigns` e `campaign_versions`;
- `campaign_sdrs` e `campaign_numbers`;
- índices por tenant, estado, pasta e versão;
- FKs compostas que validam tenant em campanha, pasta, SDR e linha;
- ponteiro deferido da campanha para a versão atual;
- campanha legada e snapshot v1 com hash para tenants existentes e novos;
- sincronização do read model legado quando SDRs e linhas são adicionados ou uma
  linha é removida.

O snapshot registra defaults do discador, agenda, exceções, pasta, SDRs e linhas
existentes no momento do backfill. Ele é imutável por convenção neste lote; os
vínculos atuais ficam nas tabelas relacionais. Nenhuma migration altera `leads`,
`calls`, `dialer_settings` ou o algoritmo de seleção.

### Upgrade com dados legados

O comando reproduzível abaixo cria um banco temporário com nome validado, aplica as
migrations 000–042, insere lead, SDR, linha e chamada, aplica 043 e remove o banco ao
final:

```powershell
$env:DATABASE_URL='postgres://zapcall:zapcall@127.0.0.1:55432/zapcall'
npm run verify:campaign-migration
```

Resultado aprovado:

- a chamada manteve status, tentativa, lead, linha, SDR e pasta sem alteração;
- campanha legada e versão 1 foram criadas;
- o hash MD5 do JSONB canônico possui 32 caracteres;
- pasta, SDR e linha legados foram preservados no snapshot e nos vínculos;
- recursos criados depois do tenant foram associados ao read model legado;
- tentativa de associar SDR de outro tenant falhou com FK `23503`;
- o banco temporário foi removido, sem resíduos.

A migration também foi aplicada no banco E2E vazio. Foram observadas 23 constraints
de campanha validadas e a migration 043 registrada em `schema_migrations`.

## APIs e isolamento

O repositório aplica `tenant_id` tanto na contagem/listagem quanto no detalhe. A
resposta de listagem contém paginação, estado, pasta, versão/hash vigente e contagens
de leads, SDRs e linhas. O detalhe acrescenta snapshot vigente e recursos associados,
sem expor telefone ou credenciais de linha.

Coberturas específicas:

- status inválido é rejeitado antes de consultar o banco;
- paginação é limitada a 100 itens;
- tenant e ID são encaminhados juntos para o detalhe;
- recurso de outro tenant retorna `NotFound`;
- o E2E valida 409 com flag desligada, leitura com flag ligada, 404 cross-tenant e
  401 para usuário sem membership;
- o endpoint administrativo de flags, já auditado no Lote 00, habilita `campaigns`
  por tenant de teste sem reiniciar a API.

## Gates executados

- Q1 — estrutura e typecheck: aprovado;
- Q2 — backend: 31 suítes/182 testes; frontend: 12 arquivos/24 testes;
- Q3 — build completo aprovado, com 327 módulos web transformados;
- Q4 — banco vazio, upgrade anterior, smoke multitenant e FKs cross-tenant aprovados;
- Q5 adicional — Playwright 13/13 em 51,5 segundos, incluindo a jornada de campanhas.

O único aviso do build Docker foi uma vulnerabilidade npm moderada já presente. Não
foi executado `npm audit fix` automático porque alteração de dependências não faz
parte deste lote e exige avaliação própria.

## Critérios de saída

- base antiga migra sem alterar chamadas existentes: aprovado;
- campanha legada representa a operação atual: aprovado no snapshot inicial e nos
  vínculos vivos de SDR/linha;
- API antiga responde igual com a flag desligada: aprovado pelas 12 jornadas
  preexistentes preservadas dentro da suíte de 13;
- Q1 a Q4: aprovados;
- deploy/rollout em produção: não realizado.
