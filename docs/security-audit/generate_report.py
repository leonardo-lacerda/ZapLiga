# -*- coding: utf-8 -*-
"""Gerador do relatorio de auditoria de seguranca (ZapLiga / ZapCall).

Uso:
    .venv/Scripts/python generate_report.py

Regenera docs/security-audit/relatorio-auditoria-seguranca.pdf a partir dos
achados descritos neste arquivo. Nao acessa a rede; usa reportlab + matplotlib
instalados no venv local (.venv).
"""
import io
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table, TableStyle,
    Image, PageBreak, KeepTogether, HRFlowable, ListFlowable, ListItem,
)
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_PDF = os.path.join(HERE, "relatorio-auditoria-seguranca.pdf")

# ---------------------------------------------------------------------------
# Paleta
# ---------------------------------------------------------------------------
COLOR_CRITICA = "#B91C1C"
COLOR_ALTA = "#EA580C"
COLOR_MEDIA = "#D97706"
COLOR_BAIXA = "#2563EB"
COLOR_PONTO_FORTE = "#059669"
COLOR_INFO = "#6B7280"
COLOR_TEXT = "#1F2937"
COLOR_MUTED = "#6B7280"
COLOR_BORDER = "#D1D5DB"
COLOR_BG_SOFT = "#F3F4F6"

SEV_COLOR = {
    "Critica": COLOR_CRITICA,
    "Alta": COLOR_ALTA,
    "Media": COLOR_MEDIA,
    "Baixa": COLOR_BAIXA,
    "Informativa": COLOR_INFO,
}
SEV_LABEL = {
    "Critica": "CRÍTICA",
    "Alta": "ALTA",
    "Media": "MÉDIA",
    "Baixa": "BAIXA",
    "Informativa": "INFORMATIVA",
}

# ---------------------------------------------------------------------------
# Dados da auditoria
# ---------------------------------------------------------------------------
REPORT_TITLE = "Relatório de Auditoria de Segurança — ZapLiga (ZapCall)"
REPORT_DATE = "29 de agosto de 2026"
REPO_SCOPE = "Monorepo apps/api (NestJS + TypeScript + pg + Redis + NATS), " \
    "apps/web (React + Vite), infraestrutura Docker Compose e CI/CD (GitHub Actions)"

STACK_NOTES = [
    ("Backend", "NestJS 11 / TypeScript, acesso a dados via SQL parametrizado cru "
                "com o driver `pg` (sem ORM), autenticação JWT (access token curto "
                "+ refresh token rotativo em cookie httpOnly)."),
    ("Isolamento multi-tenant", "Não há RLS (não é Supabase/Postgres RLS) nem "
                "middleware automático de tenant. O isolamento é feito manualmente "
                "por um par de guards NestJS (`AuthGuard` + `TenantMembershipGuard`) "
                "que resolve `request.tenantId` a partir da rota/cabeçalho "
                "`x-tenant-id` e valida contra `tenant_memberships`; cada consulta "
                "SQL then precisa filtrar explicitamente por `tenant_id`. A auditoria "
                "de item 1 mapeou esse mecanismo e verificou, controller a "
                "controller e serviço a serviço, se o filtro é aplicado."),
    ("Permissão/autorização", "RBAC via decorator `@Roles(...)` + `RolesGuard`, "
                "aplicado no servidor em toda rota; o item 2 cruzou cada gate visual "
                "do frontend (React) com o guard correspondente no backend."),
    ("IDOR", "Item 3 percorreu todos os 15 controllers e os serviços por trás "
                "deles, checando se toda busca/alteração/remoção por `:id` também "
                "filtra por `tenant_id` (ou por posse explícita, nos casos sem "
                "tenant, como visualizações salvas)."),
    ("Segredos", "Item 4 cobriu código-fonte, `docker-compose.yml`, `.env.example`, "
                "scripts de bootstrap, workflow de CI/CD e histórico do Git."),
    ("Frontend / XSS", "React + Vite, sem framework SSR. Item 5 verificou uso de "
                "`dangerouslySetInnerHTML`/`innerHTML`/`eval`, URLs controladas por "
                "usuário e, no backend, geração de e-mails HTML."),
]

# Achados (apenas os que sobreviveram a verificação manual linha a linha)
FINDINGS = [
    {
        "id": "F1",
        "severity": "Alta",
        "category": "Chaves expostas (hardcode)",
        "title": "NODE_ENV padrão \"development\" desativa toda a validação de "
                 "segredos e as proteções de produção",
        "files": [
            (".env.example", 1),
            ("docker-compose.yml", 97),
            ("apps/api/src/main.ts", 15),
            ("apps/api/src/modules/auth/auth.service.ts", 214),
        ],
        "description": (
            "O template de ambiente e o docker-compose.yml só ligam a validação de "
            "segredos, o redirecionamento HTTPS obrigatório e o cookie de refresh "
            "`Secure` quando `NODE_ENV === 'production'` (main.ts:15-22 e "
            "auth.service.ts:214). Só que o próprio template deixa `NODE_ENV` sem "
            "valor forte: `.env.example:1` traz `NODE_ENV=development`, e "
            "`docker-compose.yml:97` usa `NODE_ENV: ${NODE_ENV:-development}` — ou "
            "seja, se o operador criar o `.env` de produção copiando o exemplo (o "
            "fluxo descrito no próprio `.github/workflows/deploy.yml`, que apenas "
            "exige \"crie /opt/zapliga/.env antes do primeiro deploy\") e esquecer "
            "de sobrescrever `NODE_ENV=production`, a API roda em produção real com "
            "todas as proteções de produção desligadas."
        ),
        "why_exploitable": (
            "Com `NODE_ENV` diferente de `production`, o bloco de main.ts:15-22 "
            "nunca executa — logo os segredos padrão públicos (visíveis neste "
            "próprio repositório) `JWT_ACCESS_SECRET=change-this-access-secret`, "
            "`WAXUM_API_KEY=zapcall-local-waxum-token` e "
            "`WAXUM_JWT_SECRET=change-this-local-secret` continuam válidos e "
            "**sem checagem alguma que rejeite o valor de exemplo**. Qualquer pessoa "
            "que conheça esses defaults (públicos no histórico do projeto) pode "
            "assinar um JWT de acesso válido com `jsonwebtoken` usando o segredo "
            "padrão, definindo `sub` como o UUID de qualquer usuário existente — "
            "`AuthGuard` (auth.guards.ts:30-35) apenas verifica a assinatura e busca "
            "o usuário por esse `sub`, sem nenhum vínculo adicional ao segredo real "
            "do ambiente. O resultado é personificação completa de qualquer conta, "
            "incluindo um `super_admin` cujo UUID tenha vazado por qualquer canal "
            "(ex.: listagem de membros de um tenant, logs, etc.). Adicionalmente, o "
            "cookie de refresh deixa de ser `Secure` (auth.service.ts:214), podendo "
            "trafegar em texto claro se a borda TLS não repassar `x-forwarded-proto` "
            "corretamente."
        ),
        "condition": (
            "Requer que o operador não sobrescreva `NODE_ENV=production` no `.env` "
            "real do servidor — um erro plausível porque o próprio arquivo de "
            "exemplo do projeto já vem com `NODE_ENV=development`. Não requer "
            "nenhuma outra falha de configuração."
        ),
    },
    {
        "id": "F2",
        "severity": "Baixa",
        "category": "Chaves expostas (hardcode)",
        "title": "Credencial padrão do PostgreSQL não faz parte da validação de "
                 "segredos de produção",
        "files": [
            ("docker-compose.yml", 6),
            ("docker-compose.yml", 30),
            ("apps/api/src/main.ts", 16),
        ],
        "description": (
            "`docker-compose.yml:6-8` e `:30-32` definem `POSTGRES_USER`/"
            "`POSTGRES_PASSWORD` com fallback `zapcall`/`zapcall` "
            "(`${POSTGRES_USER:-zapcall}`, `${POSTGRES_PASSWORD:-zapcall}`). "
            "Diferente de `JWT_ACCESS_SECRET`/`WAXUM_API_KEY`/`WAXUM_JWT_SECRET`, "
            "esse par não está no conjunto `unsafeDefaults` verificado em "
            "`main.ts:16` — não existe nenhuma checagem de startup que rejeite a "
            "senha de exemplo do banco em produção."
        ),
        "why_exploitable": (
            "Hoje o risco é mitigado porque `docker-compose.yml:10` publica a porta "
            "do Postgres apenas em `127.0.0.1:5432`, não acessível externamente por "
            "padrão. O achado é a ausência de defesa em profundidade: uma mudança "
            "futura no compose (ex.: trocar o bind para `0.0.0.0` para depuração "
            "remota) ou uma rede Docker mal configurada exporia um banco protegido "
            "apenas por `zapcall:zapcall`, com acesso completo a dados de todos os "
            "tenants."
        ),
        "condition": (
            "Só é explorável se a porta 5432 for exposta além de `127.0.0.1` "
            "(configuração adicional além do padrão do repositório)."
        ),
    },
    {
        "id": "F3",
        "severity": "Informativa",
        "category": "Chaves expostas (hardcode)",
        "title": "Redis roda sem autenticação (sem `requirepass`)",
        "files": [
            ("docker-compose.yml", 40),
        ],
        "description": (
            "O serviço `redis` em `docker-compose.yml:40-51` não define "
            "`requirepass`/`--requirepass`, então qualquer processo capaz de "
            "alcançar `127.0.0.1:6379` tem acesso irrestrito — inclusive às chaves "
            "de reserva de chamadas e ao cache de LID do WhatsApp (dialer.service.ts) "
            "usados pelo discador."
        ),
        "why_exploitable": (
            "Mitigado da mesma forma que o achado F2: a porta só é publicada em "
            "`127.0.0.1:6379`. Registrado para reforçar a defesa em profundidade, "
            "sobretudo se o Redis um dia precisar ser compartilhado entre hosts."
        ),
        "condition": "Só é explorável se a porta 6379 for exposta além de localhost.",
    },
]

CATEGORIES = [
    ("1. Isolamento de tenant (banco sem tranca)", "Sem achados"),
    ("2. Permissão definida no navegador", "Sem achados"),
    ("3. IDOR", "Sem achados"),
    ("4. Chaves expostas (hardcode)", "3 achados (F1, F2, F3)"),
    ("5. Inputs sem tratamento (XSS)", "Sem achados"),
]

STRENGTHS = [
    ("Isolamento multi-tenant consistente",
     "Os 15 controllers do backend (`admin`, `tenants`, `users`, `memberships`, "
     "`leads`, `lead-folders`, `numbers`, `sdrs`, `calls`, `dialer`, "
     "`invitations`, `metrics`, `audit`) foram lidos por completo. Todas as "
     "rotas que expõem dados de um tenant usam `AuthGuard` + "
     "`TenantMembershipGuard` (auth.guards.ts:40-80), que resolve `tenantId` a "
     "partir da rota/cabeçalho e valida contra `tenant_memberships` antes de "
     "popular `request.tenantId`. Toda consulta SQL revisada nos serviços "
     "(`leads.controller.ts`, `lead-folders.service.ts`, `numbers.controller.ts`, "
     "`dialer.service.ts` — 990 linhas —, `metrics.repository.ts` — 516 linhas —, "
     "entre outros) inclui `WHERE tenant_id = $1` (ou join equivalente por "
     "`tenant_id`) antes de filtrar por qualquer `id` vindo do cliente."),
    ("RBAC reforçado no servidor, não só na UI",
     "O frontend (`App.tsx`, `AccessPage.tsx`, `AdminPage.tsx`) esconde telas "
     "administrativas com flags como `isSdr`, `isSuperAdmin`, `canManageNumbers`, "
     "mas cada ação correspondente tem um `@Roles(...)` no controller do NestJS, "
     "verificado pelo `RolesGuard` (auth.guards.ts:82-95): `AdminController` e "
     "`TenantsController` (rotas de criação/limite) exigem `@Roles('super_admin')`; "
     "`MembershipsController` restringe promoção a líder e mudança de papel a "
     "`super_admin`; `NumbersController`, `SdrsController`, `LeadsController` e "
     "`CallsController` exigem `leader`/`super_admin` com exceções pontuais e "
     "explícitas para `sdr` (ex.: `SdrsController.own()`, `finishPause()` com "
     "checagem extra de posse em memberships.controller.ts:34-42 e "
     "sdrs.controller.ts:66-69). Chamar a API diretamente sem passar pela UI não "
     "contorna nenhuma dessas permissões."),
    ("Nenhum IDOR sobrevivendo à revisão",
     "Todas as rotas que recebem `:id` (leads, pastas, números, SDRs, chamadas, "
     "convites, metas de métricas, visualizações salvas, exportações) foram "
     "conferidas: o `id` do recurso é sempre combinado com `tenant_id = $1 AND "
     "id = $2` na query (ex.: `numbers.controller.ts:94-98`, "
     "`lead-folders.service.ts:32-47`, `metrics-export.repository.ts:43-54`). "
     "Nos dois casos sem tenant (visualizações salvas em `metrics-views.service.ts`), "
     "a posse é checada explicitamente por `owner_user_id !== userId` antes de "
     "editar/remover."),
    ("SQL parametrizado de ponta a ponta",
     "Não há ORM, mas o padrão do projeto é disciplinado: nomes de coluna "
     "interpolados nas queries vêm sempre de listas fixas no código (nunca de "
     "entrada do usuário) e todo valor de filtro é passado como parâmetro "
     "posicional (`$1`, `$2`, `ANY($n::text[])`), inclusive em filtros dinâmicos "
     "de métricas com múltiplos arrays (`metrics.repository.ts:380-460`) e na "
     "busca textual da auditoria (`audit.service.ts:35`, usa `ILIKE $n` com o "
     "termo passado como parâmetro, não concatenado)."),
    ("Segurança de autenticação e sessão",
     "Login com bloqueio progressivo por tentativa (`auth.service.ts:26-37`), "
     "hashes bcrypt com custo configurável, refresh tokens rotativos com detecção "
     "de reuso e revogação em cascata da família de sessão "
     "(`auth.service.ts:104-125`), tickets de WebSocket de uso único e curta "
     "duração (`auth.service.ts:159-183`), e validação de posse do SDR antes de "
     "anexar o socket de mídia (`sdr.gateway.ts:133-138`)."),
    ("Nenhum segredo real commitado",
     "Buscas em todo o código-fonte e no histórico completo do Git (28 commits) "
     "não encontraram nenhuma chave de API, senha ou token real; apenas o "
     "`.env.example` com valores de exemplo foi versionado. `.gitignore` exclui "
     "`.env` e `backups/`, e o workflow de deploy exclui `.env` do pacote "
     "enviado ao servidor (`deploy.yml:80`)."),
    ("Mass assignment bloqueado globalmente",
     "`main.ts:26` registra `ValidationPipe({ whitelist: true, "
     "forbidNonWhitelisted: true })` de forma global, e todo DTO revisado usa "
     "`class-validator` com listas fechadas (`@IsIn(['leader','sdr'])` em "
     "`update-membership-role.dto.ts`, `@IsIn(['user','super_admin'])` em "
     "`update-platform-role.dto.ts`), impedindo que um cliente injete papéis ou "
     "campos não previstos."),
    ("Nenhum vetor de XSS encontrado no frontend",
     "Busca completa em `apps/web/src` (44 arquivos) por "
     "`dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `eval` e `new "
     "Function` não retornou nenhuma ocorrência; toda renderização passa pelo "
     "escape automático do React. Não há HTML/Markdown de usuário renderizado "
     "sem sanitização."),
    ("E-mails HTML escapados no backend",
     "`invitation-mailer.ts:6-11,31-39` escapa manualmente `tenantName`, `role` "
     "e a URL do convite antes de interpolá-los no corpo HTML do e-mail — "
     "trata corretamente a única superfície de geração de HTML a partir de "
     "dados controlados por usuário (nome da empresa) encontrada no backend."),
    ("Token de acesso fora do localStorage",
     "`apps/web/src/services/api.ts:2-16` mantém o access token apenas em "
     "memória (variável de módulo) e sincroniza entre abas via "
     "`BroadcastChannel`, evitando persistência em `localStorage`/`sessionStorage` "
     "— reduz a superfície de roubo de token mesmo na ausência de um XSS "
     "conhecido."),
]

RECOMMENDATIONS = [
    ("P1", "Tornar a validação de segredos de produção independente de "
           "`NODE_ENV`", "Corrige F1: mover a checagem de `unsafeDefaults` em "
           "`main.ts:15-22` para rodar sempre (ou definir `NODE_ENV=production` "
           "como padrão explícito no `docker-compose.yml` de implantação, exigindo "
           "opt-in para `development`). Aplicar o mesmo padrão ao "
           "`AUTH_COOKIE_SECURE` em `auth.service.ts:214`, para que o cookie de "
           "refresh só saia sem `Secure` com uma flag explícita, nunca por "
           "omissão de `NODE_ENV`."),
    ("P2", "Incluir a credencial do PostgreSQL na validação de segredos e evitar "
           "expor a porta além de localhost", "Corrige F2: adicionar "
           "`POSTGRES_PASSWORD` (e o mesmo para `SUPERADMIN_PASSWORD`, já checado "
           "apenas no script `bootstrap-admin.ts`) ao conjunto de defaults "
           "rejeitados em produção, e manter o bind de rede restrito a "
           "`127.0.0.1` em qualquer mudança futura no `docker-compose.yml`."),
    ("P3", "Habilitar autenticação no Redis (`requirepass`)", "Corrige F3: "
           "definir uma senha para o Redis via variável de ambiente e propagá-la "
           "para `REDIS_URL` nos serviços que o consomem, mantendo o bind em "
           "localhost como camada adicional."),
    ("P4", "Formalizar este relatório como checklist de release",
           "Nenhuma correção de código é necessária para os itens 1, 2, 3 e 5 "
           "desta auditoria — o recomendado é adicionar uma checagem automatizada "
           "(ex.: `scripts/verify-multitenant.mjs`, já existente no projeto) que "
           "rode em CI e falhe se uma nova rota for adicionada sem "
           "`TenantMembershipGuard`/`RolesGuard`, preservando a consistência "
           "encontrada nesta revisão."),
]

GITHUB_ISSUES = [
    {
        "title": "[Segurança] NODE_ENV padrão \"development\" desativa a validação "
                 "de segredos e o hardening de produção",
        "labels": "security, alta",
        "body": (
            "## Problema\n"
            "`apps/api/src/main.ts:15-22` só valida se `JWT_ACCESS_SECRET`, "
            "`WAXUM_API_KEY` e `WAXUM_JWT_SECRET` ainda estão com o valor de "
            "exemplo, força HTTPS e ativa `trust proxy` **apenas quando** "
            "`process.env.NODE_ENV === 'production'`. O mesmo vale para o cookie "
            "de refresh ser `Secure` (`apps/api/src/modules/auth/auth.service.ts:214`).\n\n"
            "Só que `.env.example:1` traz `NODE_ENV=development` e "
            "`docker-compose.yml:97` usa `NODE_ENV: ${NODE_ENV:-development}` como "
            "fallback. O fluxo de deploy documentado em "
            "`.github/workflows/deploy.yml` só pede para o operador criar um "
            "`.env` em `/opt/zapliga/.env` — se esse arquivo for baseado no "
            "exemplo e não sobrescrever `NODE_ENV`, a API de produção roda com o "
            "hardening inteiro desligado.\n\n"
            "## Por que é explorável\n"
            "Sem o bloco de `main.ts:15-22` rodando, os segredos padrão "
            "(`change-this-access-secret`, `zapcall-local-waxum-token`, "
            "`change-this-local-secret`) continuam ativos sem nenhuma checagem. "
            "Esses valores são públicos (estão neste repositório). Quem os conhece "
            "pode assinar um JWT válido com `jsonwebtoken`, definindo `sub` como o "
            "UUID de qualquer usuário — `AuthGuard` "
            "(`apps/api/src/modules/auth/auth.guards.ts:22-38`) apenas verifica a "
            "assinatura e busca o usuário por esse `sub`, concedendo a sessão "
            "completa daquela conta (inclusive `super_admin`, se o UUID for "
            "conhecido).\n\n"
            "## Evidência\n"
            "```\n"
            "// .env.example:1\n"
            "NODE_ENV=development\n\n"
            "// docker-compose.yml:97\n"
            "NODE_ENV: ${NODE_ENV:-development}\n\n"
            "// apps/api/src/main.ts:15-17\n"
            "if (process.env.NODE_ENV === 'production') {\n"
            "  const unsafeDefaults = new Set([...]);\n"
            "  if (!process.env.JWT_ACCESS_SECRET || ... ) throw new Error(...);\n"
            "  ...\n"
            "}\n"
            "```\n\n"
            "## Impacto\n"
            "Personificação completa de qualquer usuário (incluindo administradores "
            "da plataforma) caso a implantação de produção não defina "
            "explicitamente `NODE_ENV=production`. Também expõe o cookie de "
            "refresh sem a flag `Secure`.\n\n"
            "## Sugestão de correção\n"
            "- Executar a validação de `unsafeDefaults` sempre, independentemente "
            "de `NODE_ENV` (ela só falha se o valor realmente for um dos defaults "
            "conhecidos — não deveria depender do ambiente).\n"
            "- Trocar o fallback do `docker-compose.yml` de produção para "
            "`NODE_ENV: ${NODE_ENV:?defina NODE_ENV}` ou `production`, exigindo "
            "opt-in explícito para rodar em modo `development`.\n"
            "- Aplicar a mesma independência de `NODE_ENV` ao cálculo de "
            "`cookieSecure` em `auth.service.ts`.\n\n"
            "## Critérios de aceite\n"
            "- [ ] A API recusa subir (ou loga erro crítico) se algum dos segredos "
            "estiver com valor de exemplo, **mesmo com `NODE_ENV` não definido "
            "como `production`**.\n"
            "- [ ] O cookie de refresh só sai sem `Secure` mediante flag explícita, "
            "nunca por omissão de `NODE_ENV`.\n"
            "- [ ] `docker-compose.yml` de produção não sobe com `NODE_ENV` "
            "implícito.\n"
            "- [ ] Teste automatizado cobrindo a rejeição dos defaults "
            "independente de `NODE_ENV`.\n"
        ),
    },
    {
        "title": "[Segurança] Defaults de credenciais de infraestrutura (Postgres, "
                 "Redis) sem validação de startup nem autenticação",
        "labels": "security, baixa",
        "body": (
            "## Problema\n"
            "Dois pontos relacionados de \"default público vira segredo real se "
            "não for sobrescrito\":\n\n"
            "1. `docker-compose.yml:6-8` e `:30-32` definem "
            "`POSTGRES_USER`/`POSTGRES_PASSWORD` com fallback `zapcall`/`zapcall`. "
            "Diferente de `JWT_ACCESS_SECRET` e `WAXUM_*`, essa credencial **não "
            "está** no conjunto `unsafeDefaults` validado em "
            "`apps/api/src/main.ts:16`.\n"
            "2. O serviço `redis` em `docker-compose.yml:40-51` não define "
            "`requirepass` — qualquer processo que alcance a porta tem acesso "
            "total, sem senha alguma.\n\n"
            "## Por que é explorável\n"
            "Hoje ambos os serviços publicam a porta apenas em `127.0.0.1` "
            "(`docker-compose.yml:10` e `:43-44`), então não há exposição externa "
            "por padrão. O risco é a ausência de defesa em profundidade: uma "
            "mudança futura no bind de rede, ou uma rede Docker mal configurada, "
            "exporia o banco (com a senha de exemplo `zapcall`) ou o Redis (sem "
            "senha nenhuma) a qualquer host que alcance a máquina.\n\n"
            "## Evidência\n"
            "```yaml\n"
            "# docker-compose.yml:6-10\n"
            "POSTGRES_DB: ${POSTGRES_DB:-zapcall}\n"
            "POSTGRES_USER: ${POSTGRES_USER:-zapcall}\n"
            "POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-zapcall}\n"
            "ports:\n"
            "  - \"127.0.0.1:5432:5432\"\n\n"
            "# docker-compose.yml:40-44 (sem requirepass)\n"
            "redis:\n"
            "  image: redis:7-alpine\n"
            "  ports:\n"
            "    - \"127.0.0.1:6379:6379\"\n"
            "```\n\n"
            "## Impacto\n"
            "Acesso total ao banco de dados (todos os tenants) ou ao Redis "
            "(reservas de chamada, cache de LID do WhatsApp) caso a porta seja "
            "exposta além de localhost em qualquer momento futuro.\n\n"
            "## Sugestão de correção\n"
            "- Adicionar `POSTGRES_PASSWORD` (e `SUPERADMIN_PASSWORD`) ao conjunto "
            "`unsafeDefaults` validado em produção.\n"
            "- Definir `requirepass` no Redis via variável de ambiente e propagar "
            "a senha em `REDIS_URL`.\n"
            "- Manter o bind em `127.0.0.1` documentado como requisito de "
            "segurança, não apenas como configuração padrão incidental.\n\n"
            "## Critérios de aceite\n"
            "- [ ] Subir a API em modo produção com `POSTGRES_PASSWORD` de exemplo "
            "falha no boot com mensagem clara.\n"
            "- [ ] Redis exige autenticação (`AUTH`) para qualquer comando.\n"
            "- [ ] Documentação do deploy menciona explicitamente por que as "
            "portas de Postgres/Redis não devem ser expostas além de localhost.\n"
        ),
    },
]

# ---------------------------------------------------------------------------
# Charts
# ---------------------------------------------------------------------------

def make_donut_chart():
    order = ["Critica", "Alta", "Media", "Baixa", "Informativa"]
    counts = {k: 0 for k in order}
    for f in FINDINGS:
        counts[f["severity"]] += 1
    labels = [SEV_LABEL[k] for k in order if counts[k] > 0]
    sizes = [counts[k] for k in order if counts[k] > 0]
    chart_colors = [SEV_COLOR[k] for k in order if counts[k] > 0]

    fig, ax = plt.subplots(figsize=(4.6, 4.0), dpi=200)
    wedges, _ = ax.pie(
        sizes, colors=chart_colors, startangle=90, counterclock=False,
        wedgeprops=dict(width=0.42, edgecolor="white", linewidth=2),
    )
    total = sum(sizes)
    ax.text(0, 0.08, str(total), ha="center", va="center", fontsize=26, fontweight="bold", color=COLOR_TEXT)
    ax.text(0, -0.18, "achados", ha="center", va="center", fontsize=11, color=COLOR_MUTED)
    ax.legend(
        wedges, [f"{l} ({s})" for l, s in zip(labels, sizes)],
        loc="upper center", bbox_to_anchor=(0.5, -0.02), ncol=2, frameon=False, fontsize=9.5,
    )
    ax.set_aspect("equal")
    fig.tight_layout()
    buf = io.BytesIO()
    fig.savefig(buf, format="png", transparent=True, bbox_inches="tight")
    plt.close(fig)
    buf.seek(0)
    return buf


def make_category_bar_chart():
    cats = [c[0].split(". ", 1)[1] for c in CATEGORIES]
    counts_by_cat = {c[0].split(". ", 1)[1]: 0 for c in CATEGORIES}
    for f in FINDINGS:
        counts_by_cat[f["category"]] += 1
    values = [counts_by_cat[c] for c in cats]
    bar_colors = [COLOR_PONTO_FORTE if v == 0 else COLOR_ALTA for v in values]

    fig, ax = plt.subplots(figsize=(7.6, 4.0), dpi=200)
    y_pos = range(len(cats))
    bars = ax.barh(y_pos, values, color=bar_colors, height=0.55)
    wrapped = ["\n".join(_wrap_label(c, 26)) for c in cats]
    ax.set_yticks(list(y_pos))
    ax.set_yticklabels(wrapped, fontsize=9.5, color=COLOR_TEXT)
    ax.invert_yaxis()
    max_val = max(values + [1])
    ax.set_xlim(0, max_val + 1)
    ax.set_xticks(range(0, max_val + 2))
    for spine in ["top", "right", "left"]:
        ax.spines[spine].set_visible(False)
    ax.spines["bottom"].set_color(COLOR_BORDER)
    ax.tick_params(axis="x", colors=COLOR_MUTED, labelsize=9)
    ax.set_xlabel("Nº de achados", fontsize=9.5, color=COLOR_MUTED)
    for bar, v in zip(bars, values):
        ax.text(bar.get_width() + 0.06, bar.get_y() + bar.get_height() / 2, str(v),
                va="center", fontsize=9.5, color=COLOR_TEXT, fontweight="bold")
    fig.tight_layout()
    buf = io.BytesIO()
    fig.savefig(buf, format="png", transparent=True, bbox_inches="tight")
    plt.close(fig)
    buf.seek(0)
    return buf


def _wrap_label(text, width):
    words = text.split(" ")
    lines, cur = [], ""
    for w in words:
        if len(cur) + len(w) + 1 <= width:
            cur = (cur + " " + w).strip()
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


# ---------------------------------------------------------------------------
# Styles
# ---------------------------------------------------------------------------
styles = getSampleStyleSheet()
styles.add(ParagraphStyle("CoverTitle", fontName="Helvetica-Bold", fontSize=25, leading=31, textColor=colors.HexColor(COLOR_TEXT), spaceAfter=10))
styles.add(ParagraphStyle("CoverSub", fontName="Helvetica", fontSize=12.5, leading=18, textColor=colors.HexColor(COLOR_MUTED)))
styles.add(ParagraphStyle("H1", fontName="Helvetica-Bold", fontSize=17, leading=21, textColor=colors.HexColor(COLOR_TEXT), spaceBefore=4, spaceAfter=10))
styles.add(ParagraphStyle("H2", fontName="Helvetica-Bold", fontSize=13, leading=16, textColor=colors.HexColor(COLOR_TEXT), spaceBefore=14, spaceAfter=6))
styles.add(ParagraphStyle("H3", fontName="Helvetica-Bold", fontSize=11, leading=14, textColor=colors.HexColor(COLOR_TEXT), spaceBefore=8, spaceAfter=4))
styles.add(ParagraphStyle("Body", fontName="Helvetica", fontSize=9.6, leading=14, textColor=colors.HexColor(COLOR_TEXT), alignment=TA_LEFT))
styles.add(ParagraphStyle("BodyMuted", fontName="Helvetica", fontSize=9, leading=13, textColor=colors.HexColor(COLOR_MUTED)))
styles.add(ParagraphStyle("Small", fontName="Helvetica", fontSize=8.3, leading=11.5, textColor=colors.HexColor(COLOR_TEXT)))
styles.add(ParagraphStyle("CodeBlock", fontName="Courier", fontSize=8, leading=10.5, textColor=colors.HexColor(COLOR_TEXT), backColor=colors.HexColor(COLOR_BG_SOFT)))
styles.add(ParagraphStyle("Mono", fontName="Courier", fontSize=8.3, leading=11, textColor=colors.HexColor(COLOR_TEXT)))
styles.add(ParagraphStyle("TableCell", fontName="Helvetica", fontSize=8.4, leading=11.5, textColor=colors.HexColor(COLOR_TEXT)))
styles.add(ParagraphStyle("TableHead", fontName="Helvetica-Bold", fontSize=8.6, leading=11, textColor=colors.white))
styles.add(ParagraphStyle("Eyebrow", fontName="Helvetica-Bold", fontSize=9.5, textColor=colors.HexColor(COLOR_PONTO_FORTE), spaceAfter=6))
styles.add(ParagraphStyle("IssueTitle", fontName="Helvetica-Bold", fontSize=11.5, leading=15, textColor=colors.HexColor(COLOR_TEXT), spaceBefore=2, spaceAfter=6))
styles.add(ParagraphStyle("IssueMono", fontName="Courier", fontSize=7.6, leading=10.6, textColor=colors.HexColor(COLOR_TEXT)))


def sev_chip(sev_key, width=2.7 * cm):
    color = SEV_COLOR[sev_key]
    label = SEV_LABEL[sev_key]
    font_size = 6.6 if len(label) > 9 else 7.6
    t = Table([[label]], colWidths=[width], rowHeights=[0.5 * cm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(color)),
        ("TEXTCOLOR", (0, 0), (-1, -1), colors.white),
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), font_size),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROUNDEDCORNERS", [4, 4, 4, 4]),
    ]))
    return t


# ---------------------------------------------------------------------------
# Header / footer
# ---------------------------------------------------------------------------

def draw_header_footer(canv: canvas.Canvas, doc):
    canv.saveState()
    width, height = A4
    # header
    canv.setFont("Helvetica", 8)
    canv.setFillColor(colors.HexColor(COLOR_MUTED))
    canv.drawString(2 * cm, height - 1.3 * cm, "Relatório de Auditoria de Segurança — ZapLiga (ZapCall)")
    canv.drawRightString(width - 2 * cm, height - 1.3 * cm, REPORT_DATE)
    canv.setStrokeColor(colors.HexColor(COLOR_BORDER))
    canv.setLineWidth(0.6)
    canv.line(2 * cm, height - 1.45 * cm, width - 2 * cm, height - 1.45 * cm)
    # footer
    canv.line(2 * cm, 1.5 * cm, width - 2 * cm, 1.5 * cm)
    canv.setFont("Helvetica", 8)
    canv.drawString(2 * cm, 1.1 * cm, "Confidencial — uso interno")
    canv.drawRightString(width - 2 * cm, 1.1 * cm, f"Página {doc.page}")
    canv.restoreState()


def draw_cover(canv: canvas.Canvas, doc):
    canv.saveState()
    width, height = A4
    canv.setFillColor(colors.HexColor(COLOR_TEXT))
    canv.rect(0, height - 6.6 * cm, width, 6.6 * cm, fill=1, stroke=0)
    canv.setFillColor(colors.white)
    canv.setFont("Helvetica-Bold", 25)
    canv.drawString(2 * cm, height - 3.0 * cm, "Relatório de Auditoria")
    canv.drawString(2 * cm, height - 3.9 * cm, "de Segurança")
    canv.setFont("Helvetica", 13)
    canv.setFillColor(colors.HexColor("#D1D5DB"))
    canv.drawString(2 * cm, height - 5.1 * cm, "ZapLiga / ZapCall — plataforma de discador WhatsApp multi-tenant")
    canv.setFont("Helvetica", 8.5)
    canv.drawRightString(width - 2 * cm, 1.1 * cm, "Página 1")
    canv.restoreState()


class ReportDocTemplate(BaseDocTemplate):
    def __init__(self, filename, **kwargs):
        super().__init__(filename, pagesize=A4, **kwargs)
        margin = 2 * cm
        frame_cover = Frame(margin, margin, A4[0] - 2 * margin, A4[1] - 8.2 * cm, id="cover")
        frame_body = Frame(margin, margin, A4[0] - 2 * margin, A4[1] - margin - 2.3 * cm, id="body")
        self.addPageTemplates([
            PageTemplate(id="Cover", frames=[frame_cover], onPage=draw_cover),
            PageTemplate(id="Body", frames=[frame_body], onPage=draw_header_footer),
        ])


def p(text, style="Body"):
    return Paragraph(text, styles[style])


def build_findings_table():
    header = [p("Sev.", "TableHead"), p("Arquivo:linha", "TableHead"), p("Descrição", "TableHead")]
    rows = [header]
    for f in FINDINGS:
        files_txt = "<br/>".join(f"{fn}:{ln}" for fn, ln in f["files"])
        desc = f"<b>{f['id']} — {f['title']}</b><br/>{f['description']}"
        rows.append([sev_chip(f["severity"], width=2.05 * cm), Paragraph(files_txt, styles["Mono"]), Paragraph(desc, styles["TableCell"])])
    table = Table(rows, colWidths=[2.3 * cm, 4.0 * cm, 10.4 * cm], repeatRows=1)
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(COLOR_TEXT)),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor(COLOR_BORDER)),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]
    for i in range(1, len(rows)):
        if i % 2 == 0:
            style.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#FAFAFA")))
    table.setStyle(TableStyle(style))
    return table


def build_story():
    story = []

    # ---------------- COVER ----------------
    story.append(Spacer(1, 8.4 * cm))
    story.append(p(f"<b>Data do relatório:</b> {REPORT_DATE}", "Body"))
    story.append(Spacer(1, 4))
    story.append(p(f"<b>Escopo auditado:</b> {REPO_SCOPE}.", "Body"))
    story.append(Spacer(1, 10))
    story.append(p("<b>Nota metodológica</b>", "H3"))
    story.append(p(
        "Esta auditoria cobre cinco categorias de falha comuns em SaaS "
        "multi-tenant, mapeadas para a stack real do projeto antes de qualquer "
        "análise: (1) isolamento de tenant — aqui feito por guards NestJS "
        "manuais em vez de RLS de banco, já que o projeto usa `pg` puro sem "
        "Supabase; (2) permissão definida apenas no navegador — cruzada com "
        "`@Roles`/`RolesGuard` no servidor; (3) IDOR — verificado rota a rota "
        "nos 15 controllers do backend; (4) chaves expostas — cobrindo "
        "código-fonte, Docker Compose, `.env.example`, scripts de bootstrap, "
        "CI/CD e histórico do Git; (5) XSS — verificado no frontend React e nos "
        "e-mails HTML gerados pelo backend. Cada achado reportado foi lido e "
        "confirmado diretamente no código-fonte; nenhum item é especulativo.",
        "Body",
    ))
    story.append(Spacer(1, 10))
    for name, desc in STACK_NOTES:
        story.append(p(f"<b>{name}.</b> {desc}", "Small"))
        story.append(Spacer(1, 5))
    story.append(PageBreak())

    # ---------------- EXEC SUMMARY ----------------
    story.append(p("Resumo executivo", "H1"))
    sev_counts = {k: 0 for k in SEV_LABEL}
    for f in FINDINGS:
        sev_counts[f["severity"]] += 1
    summary_line = " · ".join(
        f"{SEV_LABEL[k]}: {v}" for k, v in sev_counts.items() if v > 0
    )
    story.append(p(f"<b>{len(FINDINGS)} achados</b> confirmados no código, nenhum classificado como crítico. {summary_line}.", "Body"))
    story.append(Spacer(1, 6))
    story.append(p(
        "Os itens 1 (isolamento de tenant), 2 (permissão no navegador), 3 (IDOR) "
        "e 5 (XSS) não apresentaram achados exploráveis após revisão completa "
        "arquivo por arquivo — ver seção de pontos fortes para a evidência "
        "detalhada de cobertura. Os três achados do item 4 (chaves expostas) "
        "dizem respeito a como os segredos padrão de desenvolvimento se "
        "comportam em uma implantação de produção mal configurada.", "Body",
    ))
    story.append(Spacer(1, 12))

    donut_buf = make_donut_chart()
    bar_buf = make_category_bar_chart()
    chart_table = Table(
        [[Image(donut_buf, width=7.0 * cm, height=6.1 * cm), Image(bar_buf, width=9.4 * cm, height=5.0 * cm)]],
        colWidths=[7.2 * cm, 9.6 * cm],
    )
    chart_table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    story.append(p("Achados por severidade", "H3"))
    story.append(Spacer(1, 2))
    story.append(chart_table)
    story.append(Spacer(1, 4))
    story.append(p("Distribuição por categoria auditada", "BodyMuted"))
    story.append(Spacer(1, 14))

    cat_rows = [[p("Categoria", "TableHead"), p("Resultado", "TableHead")]]
    for name, result in CATEGORIES:
        tone = COLOR_PONTO_FORTE if result == "Sem achados" else COLOR_ALTA
        cat_rows.append([p(name, "TableCell"), Paragraph(f'<font color="{tone}"><b>{result}</b></font>', styles["TableCell"])])
    cat_table = Table(cat_rows, colWidths=[10.5 * cm, 6.2 * cm])
    cat_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(COLOR_TEXT)),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor(COLOR_BORDER)),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(cat_table)
    story.append(PageBreak())

    # ---------------- STRENGTHS / WEAKNESSES ----------------
    story.append(p("Pontos fortes (verificados no código)", "H1"))
    for title, desc in STRENGTHS:
        story.append(p(f'<font color="{COLOR_PONTO_FORTE}">●</font> <b>{title}.</b> {desc}', "Body"))
        story.append(Spacer(1, 7))

    story.append(Spacer(1, 6))
    story.append(p("Pontos fracos (riscos centrais)", "H1"))
    story.append(p(
        "O único risco central identificado é operacional, não de código: a "
        "cadeia de defaults de ambiente (F1) pode desligar silenciosamente as "
        "proteções de produção caso o operador não sobrescreva `NODE_ENV`. Os "
        "achados F2 e F3 são camadas de defesa em profundidade ausentes, hoje "
        "mitigadas pelo bind de rede em localhost.", "Body",
    ))
    story.append(PageBreak())

    # ---------------- DETAILED FINDINGS ----------------
    story.append(p("Achados detalhados", "H1"))
    story.append(build_findings_table())
    story.append(Spacer(1, 14))

    for f in FINDINGS:
        block = []
        block.append(HRFlowable(width="100%", thickness=0.6, color=colors.HexColor(COLOR_BORDER), spaceBefore=4, spaceAfter=8))
        header_tbl = Table([[sev_chip(f["severity"], width=2.4 * cm), p(f"<b>{f['id']} — {f['title']}</b>", "H3")]], colWidths=[2.6 * cm, 14.1 * cm])
        header_tbl.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
        block.append(header_tbl)
        block.append(Spacer(1, 4))
        block.append(p(f"<b>Categoria:</b> {f['category']}", "BodyMuted"))
        files_txt = " · ".join(f"<font face='Courier'>{fn}:{ln}</font>" for fn, ln in f["files"])
        block.append(p(f"<b>Local:</b> {files_txt}", "Small"))
        block.append(Spacer(1, 5))
        block.append(p(f"<b>Descrição:</b> {f['description']}", "Body"))
        block.append(Spacer(1, 5))
        block.append(p(f"<b>Por que é explorável:</b> {f['why_exploitable']}", "Body"))
        block.append(Spacer(1, 5))
        block.append(p(f"<b>Condição de explorabilidade:</b> {f['condition']}", "BodyMuted"))
        block.append(Spacer(1, 10))
        story.append(KeepTogether(block))

    story.append(PageBreak())

    # ---------------- RECOMMENDATIONS ----------------
    story.append(p("Recomendações priorizadas", "H1"))
    rec_rows = [[p("Prior.", "TableHead"), p("Ação", "TableHead"), p("Justificativa", "TableHead")]]
    for prio, action, why in RECOMMENDATIONS:
        rec_rows.append([p(f"<b>{prio}</b>", "TableCell"), Paragraph(action, styles["TableCell"]), Paragraph(why, styles["TableCell"])])
    rec_table = Table(rec_rows, colWidths=[1.6 * cm, 6.0 * cm, 9.1 * cm], repeatRows=1)
    rec_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor(COLOR_TEXT)),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor(COLOR_BORDER)),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(rec_table)
    story.append(PageBreak())

    # ---------------- GITHUB ISSUES ----------------
    story.append(p("Issues para o GitHub", "H1"))
    story.append(p(
        "Texto completo em Markdown, pronto para copiar e colar na criação de "
        "uma issue. Achados triviais do mesmo tema (F2 e F3, ambos sobre "
        "credenciais/portas de infraestrutura) foram agrupados em uma única "
        "issue para evitar spam.", "BodyMuted",
    ))
    story.append(Spacer(1, 10))
    for idx, issue in enumerate(GITHUB_ISSUES, start=1):
        story.append(p(f"--- ISSUE {idx} ---", "Eyebrow"))
        story.append(p(issue["title"], "IssueTitle"))
        story.append(p(f"<b>Labels sugeridas:</b> {issue['labels']}", "BodyMuted"))
        story.append(Spacer(1, 6))
        body_html = _markdown_lite_to_html(issue["body"])
        story.append(Paragraph(body_html, styles["IssueMono"]))
        story.append(Spacer(1, 8))
        story.append(p(f"--- FIM ISSUE {idx} ---", "Eyebrow"))
        story.append(Spacer(1, 16))

    return story


def _markdown_lite_to_html(md_text: str) -> str:
    """Very small, safe-enough converter: escapes HTML, then re-applies the
    handful of tags we deliberately inserted (b, br) and turns markdown
    headings/code fences into readable monospace blocks for the PDF."""
    import html
    lines = md_text.split("\n")
    out = []
    in_code = False
    for line in lines:
        if line.strip().startswith("```"):
            in_code = not in_code
            out.append("&nbsp;")
            continue
        escaped = html.escape(line)
        if not in_code:
            if escaped.startswith("## "):
                escaped = f"<b>{escaped[3:]}</b>"
            elif escaped.startswith("- [ ] "):
                escaped = f"&#9744; {escaped[6:]}"
            elif escaped.startswith("- "):
                escaped = f"&#8226; {escaped[2:]}"
            escaped = escaped.replace("**", "")
            escaped = escaped.replace("`", "")
        out.append(escaped if escaped else "&nbsp;")
    return "<br/>".join(out)


def main():
    doc = ReportDocTemplate(OUT_PDF)
    story = build_story()
    # first page uses Cover template, then switch to Body for the rest
    from reportlab.platypus import NextPageTemplate
    story.insert(0, NextPageTemplate("Body"))
    doc.build(story)
    print(f"PDF gerado em: {OUT_PDF}")


if __name__ == "__main__":
    main()
