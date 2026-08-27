# Organização do código

## Regras

- `apps/api/src` contém somente código-fonte do backend.
- `apps/web/src` contém somente código-fonte do frontend.
- `dist` e `*.tsbuildinfo` são artefatos gerados e não devem ser editados ou versionados.
- Arquivos de domínio ficam em `apps/api/src/modules` e `apps/web/src/features`.
- Integrações externas ficam em `apps/api/src/infrastructure`.
- Componentes compartilhados do frontend ficam em `apps/web/src/components`.
- Serviços de API, WebSocket e áudio ficam fora dos componentes de tela.
- Não criar arquivos soltos na raiz sem atualizar o verificador de estrutura.

## Backend

```text
apps/api/src/
├── database/
├── infrastructure/
│   ├── redis/
│   └── waxum/
└── modules/
    ├── calls/
    ├── dialer/
    ├── leads/
    ├── numbers/
    └── sdrs/
```

## Frontend

```text
apps/web/src/
├── app/
├── audio/
├── components/
├── features/
├── services/
├── shared/
├── styles/
└── types/
```

## Comandos

```text
npm run clean
npm run check:structure
npm run typecheck
npm test
npm run build
```
