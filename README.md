# ZapLiga — MVP local

Discador local para chamadas de voz do WhatsApp usando Waxum como gateway não oficial. O projeto é um protótipo técnico: use somente números e leads autorizados, respeite a legislação aplicável e aceite o risco operacional de contas não oficiais.

## Rodar

Pré-requisitos: Node.js 20+, Docker e Docker Compose.

```powershell
Copy-Item .env.example .env
npm install
docker compose up -d postgres redis waxum
npm run dev
```

Painel: http://localhost:5173  
API: http://localhost:3000  
Health check: http://localhost:3000/health

O serviço Waxum é parametrizado por `WAXUM_IMAGE`. Para produção de testes, fixe essa variável em uma tag ou digest validado por sua equipe, em vez de usar `latest`.
O Compose usa `WAXUM_API_KEY` para autenticar a API do Waxum; altere o valor no `.env` antes de qualquer ambiente compartilhado.

## Fluxo rápido

1. Cadastre um número no painel e abra o QR Code.
2. Escaneie o QR no WhatsApp do telefone controlado.
3. Cadastre um SDR, entre como SDR e ative “Disponível”.
4. Importe um CSV com `name,phone` ou cadastre um lead.
5. Inicie o discador.
6. Aceite a oferta no navegador; o áudio PCM 16 kHz mono é encaminhado ao WebSocket de mídia do Waxum.

## API

O cadastro publico do ZapLiga fica em `/app/cadastro` (tambem disponivel em `/cadastro`) e cria somente a empresa e seu organizador (`leader`). Nao existe cadastro publico para SDR ou Admin; o organizador convida SDRs pelo painel.

As rotas operacionais legadas continuam descritas no plano do MVP. A fundação de autenticação agora inclui login, refresh token rotativo, empresas, memberships, convites e auditoria.

Para criar o primeiro Admin supremo em desenvolvimento:

```powershell
$env:SUPERADMIN_EMAIL = "admin@example.com"
$env:SUPERADMIN_PASSWORD = "troque-esta-senha"
$env:SUPERADMIN_NAME = "Admin"
npm --workspace apps/api run bootstrap:admin
```

O fluxo de login usa `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout` e `GET /api/auth/me`. Empresas são criadas por `super_admin`; líderes e SDRs entram por convite. Os endpoints operacionais são escopados por `tenant_id`; as rotas explícitas usam `/api/tenants/:tenantId/...` e aliases antigos exigem `x-tenant-id` compatível.

## Convite de SDR por link

Na página de SDR, o organizador informa o nome e o e-mail do operador e gera um link de cadastro. O link deve ser copiado e enviado manualmente ao SDR; nenhum e-mail automático é disparado por esse fluxo. O convite expira conforme `INVITATION_TTL_SECONDS` (48 horas por padrão), e gerar um novo link revoga o anterior.

O `WEB_ORIGIN` deve apontar para o endereço público do painel para que o link funcione fora do ambiente local. `RESEND_API_KEY`/`RESEND_FROM` continuam sendo necessários apenas para os convites genéricos de líder usados na área de acesso.

## Limitações deliberadas do MVP

- Sem gravação ou CRM no escopo atual; multi-tenant e autenticação fazem parte da base implementada.
- A detecção de atendimento usa o primeiro áudio recebido pelo WebSocket do Waxum.
- A criação da sessão, QR e reconexão dependem do contrato do Waxum instalado.
- O navegador precisa permitir microfone e permanecer conectado durante a chamada.
