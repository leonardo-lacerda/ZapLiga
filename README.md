# ZapCall — MVP local

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

As rotas públicas implementadas estão descritas no plano do MVP. O backend inicializa o schema PostgreSQL automaticamente. Não há login: mantenha-o acessível apenas na rede local.

## Limitações deliberadas do MVP

- Sem gravação, CRM, multi-tenant ou autenticação.
- A detecção de atendimento usa o primeiro áudio recebido pelo WebSocket do Waxum.
- A criação da sessão, QR e reconexão dependem do contrato do Waxum instalado.
- O navegador precisa permitir microfone e permanecer conectado durante a chamada.
