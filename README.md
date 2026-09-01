# ZapLiga

Plataforma de operação SDR para chamadas de voz pelo WhatsApp. O ZapLiga centraliza discagem, leads, equipe, números, histórico e métricas em um painel multiempresa.

> A integração de voz utiliza o Waxum como gateway não oficial. Use somente números e leads autorizados, respeite a legislação aplicável e considere os riscos operacionais desse tipo de integração.

## O que o ZapLiga oferece

| Área | Recursos |
| --- | --- |
| Operação | Dashboard, fila de discagem, chamadas manuais, disponibilidade de SDRs, pausas pós-atendimento e acompanhamento em tempo real |
| Leads | Pastas, cadastro individual, importação CSV, etapas do funil, tentativas e reset de contato |
| Números | Cadastro, QR Code, reconexão, status e configurações dos números do WhatsApp |
| Equipe | SDRs, memberships, permissões, convites por link e gestão de acesso por empresa |
| Métricas | Resumo operacional, tendências, funil, rankings por SDR/pasta/número, metas, alertas, visualizações salvas e exportações CSV/PDF |
| Plataforma | Login, refresh token rotativo, isolamento por `tenant_id`, auditoria, Redis, NATS JetStream e suporte a múltiplas instâncias da API |

## Stack e arquitetura

- **Frontend:** React, TypeScript e Vite em `apps/web`.
- **Backend:** NestJS, TypeScript e WebSocket em `apps/api`.
- **Persistência:** PostgreSQL 16, com migrations versionadas em `apps/api/src/database/migrations`.
- **Coordenação e cache:** Redis 7.
- **Eventos:** NATS 2.10 com JetStream.
- **Telefonia:** Waxum 0.12.4, com imagem fixada por digest no Compose.
- **Execução:** Docker Compose para desenvolvimento e produção; Nginx faz o roteamento externo no deploy.

No ambiente de produção, o Compose mantém duas instâncias da API (`api-a` e `api-b`), além dos serviços compartilhados, backups diários do PostgreSQL e o painel web.

## Desenvolvimento local

### Pré-requisitos

- Node.js 20 ou superior
- Docker e Docker Compose
- Um navegador com permissão para microfone, caso vá realizar chamadas

### Subir o ambiente

```powershell
Copy-Item .env.example .env
npm install
docker compose up -d postgres redis waxum
npm run dev
```

O comando do Waxum inicia também o NATS, que é uma dependência do gateway. As migrations do banco são aplicadas automaticamente quando a API inicia.

| Serviço | Endereço local |
| --- | --- |
| Painel de desenvolvimento | http://localhost:5173 |
| API | http://localhost:3000 |
| Health check | http://localhost:3000/health |
| PostgreSQL | `localhost:5432` |
| Redis | `localhost:6379` |
| Waxum | `localhost:3451` |

Para subir o stack completo em containers, incluindo `api-a`, `api-b` e `web`:

```powershell
docker compose up -d --build
```

Nesse modo, o painel continua disponível em http://localhost:5173 e a API principal em http://localhost:3000.

## Primeiro acesso

1. Abra `/app/cadastro` — também disponível em `/cadastro` — e crie a empresa e o primeiro organizador (`leader`).
2. Entre no painel e cadastre um número do WhatsApp.
3. Abra o QR Code e escaneie-o no telefone controlado.
4. Na área **SDRs**, convide os operadores e envie manualmente o link gerado.
5. Crie uma pasta de leads e importe um CSV com as colunas `name,phone`, ou cadastre os contatos individualmente.
6. Entre como SDR, conecte a linha, ative **Disponível** e aceite a chamada no navegador.
7. Inicie o discador pela visão geral da operação.

O áudio PCM mono em 16 kHz é encaminhado ao WebSocket de mídia do Waxum durante a chamada.

## Usuários e permissões

| Perfil | Responsabilidade |
| --- | --- |
| `leader` | Administra a empresa, números, leads, SDRs, discador, métricas e convites |
| `sdr` | Opera a fila, recebe chamadas, registra o resultado e conclui a pausa pós-atendimento |
| `super_admin` | Administra a plataforma, empresas, usuários, sessões, saúde operacional e auditoria global |

O cadastro público não cria SDRs nem administradores. SDRs entram por convite; o primeiro `super_admin` de desenvolvimento é criado pela rotina abaixo:

```powershell
$env:SUPERADMIN_EMAIL = "admin@example.com"
$env:SUPERADMIN_PASSWORD = "troque-esta-senha"
$env:SUPERADMIN_NAME = "Admin"
npm --workspace apps/api run bootstrap:admin
```

### Convites

Convites de líder e SDR usam o mesmo fluxo transacional, tentam entrega pelo Resend três vezes e mantêm um link copiável como contingência. O painel mostra envio, falha, abertura, aceite, expiração e revogação, e permite reenvio sem criar convites concorrentes. A validade usa `INVITATION_TTL_SECONDS` (48 horas por padrão).

## Configuração

Comece sempre por `.env.example`. As variáveis mais importantes são:

| Variável | Finalidade |
| --- | --- |
| `DATABASE_URL` | Conexão com o PostgreSQL |
| `REDIS_URL` | Conexão com o Redis |
| `WAXUM_URL` | Endereço do gateway Waxum |
| `WAXUM_API_KEY` / `WAXUM_JWT_SECRET` | Autenticação entre a API e o Waxum |
| `JWT_ACCESS_SECRET` | Assinatura das sessões de acesso |
| `WEB_ORIGIN` | Origem pública usada nos links e cookies do painel |
| `AUTH_COOKIE_SECURE` | Use `true` quando o painel estiver atrás de HTTPS |
| `INVITATION_TTL_SECONDS` | Validade dos convites |
| `RESEND_API_KEY` / `RESEND_FROM` | E-mails de convite, verificação e recuperação |
| `DATA_PROTECTION_SECRET` | Criptografia/HMAC das solicitações LGPD |
| `METRICS_TOKEN` | Bearer token de coleta em `/internal/metrics` |
| `PUBLIC_REGISTRATION_ENABLED` | Libera cadastro público somente após Gate B |
| `SENTRY_DSN` / `SENTRY_ENVIRONMENT` | Monitoramento opcional de erros |

Antes de compartilhar ou publicar um ambiente, substitua todos os segredos padrão do `.env.example`, especialmente `WAXUM_API_KEY`, `WAXUM_JWT_SECRET`, `JWT_ACCESS_SECRET` e `SUPERADMIN_PASSWORD`.

## API e tempo real

As rotas explícitas usam `/api/tenants/:tenantId/...`. Aliases legados continuam disponíveis para compatibilidade e exigem um `x-tenant-id` compatível com a sessão autenticada.

| Grupo | Escopo |
| --- | --- |
| `/api/auth` | Login, refresh, logout, sessão atual e ticket para WebSocket |
| `/api/tenants` | Empresas e memberships |
| `/api/numbers`, `/api/leads`, `/api/lead-folders` | Números, contatos e organização da base |
| `/api/sdrs`, `/api/calls`, `/api/dialer` | Equipe, chamadas, fila, status e configurações da operação |
| `/api/metrics` | Indicadores, metas, visualizações e exportações |
| `/api/admin`, `/api/admin/audit` | Administração da plataforma e auditoria |

Endpoints centrais de autenticação:

```text
POST /api/auth/login
POST /api/auth/refresh
POST /api/auth/logout
GET  /api/auth/me
POST /api/auth/ws-ticket
POST /api/auth/operations-ws-ticket
GET  /api/dialer/operations
```

Entrada automática de leads:

```text
POST /api/v1/lead-integrations/:publicId/webhook
POST /api/v1/lead-integrations/:publicId/leads
POST /api/v1/lead-integrations/:publicId/leads/batch
```

As credenciais são geradas em Configuração > Integrações. Envie `x-zapliga-api-key` (ou `Authorization: Bearer`) e, opcionalmente, `idempotency-key`. Webhooks também podem usar `x-zapliga-timestamp` e `x-zapliga-signature` com HMAC-SHA256 do conteúdo bruto. O endpoint retorna `202` após registrar o evento; o processamento assíncrono valida, deduplica e coloca o lead na pasta configurada.

O canal operacional do SDR usa WebSocket em `/ws/tenants/:tenantId/sdr`; o ticket temporário é obtido pela API antes da conexão. Líderes e super admins observam a operação em tempo real por `/ws/tenants/:tenantId/operations`, usando o ticket de `operations-ws-ticket`. O canal de observação é somente leitura e envia um snapshot inicial seguido de eventos de invalidação.

## Comandos úteis

| Comando | Uso |
| --- | --- |
| `npm run dev` | Inicia API e frontend em modo de desenvolvimento |
| `npm run typecheck` | Verifica os tipos de API e frontend |
| `npm test` | Executa os testes do backend |
| `npm run test:web` | Executa Vitest/RTL/MSW no frontend |
| `npm run test:e2e` | Executa as 12 jornadas Playwright contra o stack |
| `npm run build` | Limpa artefatos, valida a estrutura e gera os builds |
| `npm run check:structure` | Valida a organização esperada do workspace |
| `npm run verify:multitenant` | Verifica regras de isolamento multiempresa |
| `npm --workspace apps/api run db:migrate:status` | Exibe o estado das migrations |
| `npm --workspace apps/api run db:migrate` | Executa migrations manualmente quando necessário |

Antes de abrir um pull request, rode pelo menos:

```powershell
npm run typecheck
npm test
npm run test:web
npm run build
```

## Deploy e operação

O deploy automático é disparado por push em `main` e valida `typecheck`, testes e build antes de publicar. No servidor, o fluxo:

1. mantém PostgreSQL, backups, Redis, NATS e Waxum como infraestrutura compartilhada;
2. atualiza `api-a` e `api-b` uma por vez, aguardando o health check de cada instância;
3. publica o frontend e recarrega o Nginx;
4. preserva tags de rollback e os últimos builds para recuperação.

As migrations são de ida e rodam no boot da API. Se uma migration causar problema, o rollback da imagem não desfaz alterações no banco: siga o procedimento de restauração de backup no [runbook de deploy e recuperação](docs/deploy-runbook.md).

## Limitações e cuidados operacionais

- Gravação de chamadas e CRM completo não fazem parte do escopo atual.
- A detecção de atendimento usa o primeiro áudio recebido pelo WebSocket do Waxum.
- Sessão, QR Code e reconexão dependem do contrato do Waxum 0.12.4 instalado.
- O navegador precisa permitir o microfone e permanecer conectado durante a chamada.
- A operação com gateway não oficial pode resultar em instabilidade ou bloqueio de contas; mantenha consentimento, opt-out e conformidade com a legislação aplicável.

## Documentação adicional

- [Organização e arquitetura do código](docs/architecture.md)
- [Runbook de deploy, rollback e recuperação](docs/deploy-runbook.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Versão validada do Waxum](docs/waxum-version.md)
- [Plano de prontidão das features de usuário para lançamento](docs/plano-lancamento-features-usuarios.md)
- [Runbook de lançamento, rollout, incidente e LGPD](docs/launch-runbook.md)
- [Catálogo de eventos de auditoria](docs/audit-events.md)
