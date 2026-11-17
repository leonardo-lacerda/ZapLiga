# Contrato — cadastro de WhatsApp em cloud phones (provisioning)

Fonte única dos formatos trocados entre **web ↔ API ↔ geelark-worker**. Plano e motivação:
[`plano-cadastro-whatsapp-geelark.md`](plano-cadastro-whatsapp-geelark.md).

Todos os JSON usam camelCase. Datas em ISO-8601 UTC. O código SMS e o código de pareamento
**nunca** são gravados em banco, log ou auditoria.

## 1. Estados do job

`status`: `running` | `waiting_input` | `done` | `failed` | `cancelled`

`step` (ordem normal):

| step | quem | significado |
|---|---|---|
| `queued` | worker | aceito, aguardando vaga (máx. 2 jobs; 1 por phone) |
| `setting_network` | worker | desliga o phone se estiver ligado e aplica o proxy do nó escolhido (GeeLark `phone/detail/update`) |
| `starting_phone` | worker | `phone/start` + espera status 0 |
| `connecting_adb` | worker | `adb/setStatus` + `adb/getData` + `adb connect` + `glogin` |
| `checking_network` | worker | IP público consultado **de dentro do phone**; precisa estar em `expectedEgressIps` (se a lista vier vazia, só exige internet) |
| `installing_app` | worker | só se o app escolhido não estiver instalado |
| `opening_app` | worker | abre o app e passa as telas iniciais |
| `entering_number` | worker | país + número, confirma |
| `waiting_sms` | worker | `status=waiting_input`, `awaiting=sms` |
| `verifying` | worker | digitou o código, aguardando o WhatsApp aceitar (código errado volta para `waiting_sms` com `message`) |
| `waiting_profile` | worker | `status=waiting_input`, `awaiting=profile` (tela "Profile info") |
| `saving_profile` | worker | nome + foto |
| `registered` | worker | `status=waiting_input`, `awaiting=link_decision` |
| `opening_link_screen` | worker | ⋮ → Aparelhos conectados → Conectar aparelho → Conectar com número de telefone |
| `waiting_pair_code` | worker | `status=waiting_input`, `awaiting=pair_code` (quem responde é a API, não o usuário) |
| `entering_pair_code` | worker | digitou o código de 8 caracteres |
| `linking` | API | worker terminou; a API espera a sessão Waxum ficar `connected` (máx. 120 s) |
| `done` | ambos | fim. `linked=true/false` diz se a linha foi conectada ao ZapLiga |

`awaiting`: `null` | `sms` | `profile` | `link_decision` | `pair_code`

Erros: `status=failed`, `errorCode` (abaixo), `message` em português para o usuário e
`hasScreenshot=true` quando houver print da tela do phone.

`errorCode`: `egress_offline`, `egress_mismatch`, `no_internet`, `phone_start_failed`,
`adb_failed`, `install_failed`, `unknown_screen`, `number_banned`, `sms_rejected`,
`timeout`, `pair_failed`, `link_timeout`, `worker_lost`, `cancelled`, `internal`.

Ao terminar (`done`, `failed`, `cancelled`), o worker desliga o phone se `powerOffWhenDone`
for `true` (padrão). **Exceção:** quando termina em `status=done, step=linking` (código de
pareamento digitado), o worker deixa o phone ligado, porque o aparelho principal precisa estar
online até o Waxum confirmar a conexão. Nesse caso é a API que desliga (`POST
/phones/{id}/stop`) quando a conexão é confirmada, expira (`link_timeout`) ou é cancelada. Teto de duração do job: 20 min. Espera por entrada humana: 10 min.

## 2. geelark-worker (HTTP interno, sem porta pública)

Base: `GEELARK_WORKER_URL` (ex.: `http://geelark-worker:8080`). Toda rota exige o header
`x-worker-token: <GEELARK_WORKER_TOKEN>` (exceto `GET /health`). Respostas de erro:
`{ "error": "<code>", "message": "..." }`.

| Método e rota | Corpo | Resposta |
|---|---|---|
| `GET /health` | — | `{ "ok": true }` |
| `GET /phones` | — | `{ "items": [Phone] }` |
| `POST /phones` | `CreateWorkerPhone` | `201 Phone` · `409 egress_offline` (o GeeLark testou o proxy e ele não respondeu) · `502 geelark_error` |
| `POST /phones/{phoneId}/stop` | — | `{ "ok": true }` |
| `POST /jobs` | `CreateWorkerJob` | `201 WorkerJob` · `409 phone_busy` · `429 worker_full` |
| `GET /jobs/{jobId}` | — | `WorkerJob` · `404 not_found` (ex.: worker reiniciou) |
| `POST /jobs/{jobId}/input` | `JobInput` | `WorkerJob` · `409 not_awaiting` |
| `POST /jobs/{jobId}/cancel` | — | `WorkerJob` |
| `GET /jobs/{jobId}/screenshot` | — | `image/png` · `404` |

```ts
type Phone = {
  id: string; name: string; status: 'on' | 'starting' | 'off' | 'expired' | 'unknown';
  android: string;            // "Android 12"
  proxy: string | null;       // "socks5 host:port" ou null
  apps: { whatsapp: boolean | null; business: boolean | null }; // null = desconhecido (phone desligado)
  busyJobId: string | null;
};

// phone/addNew do GeeLark: nasce desligado (cobrança por minuto) e já com o proxy, em
// proxyInformation = "socks5://usuario:senha@host:porta"; Android 12+ ganha netType 1 (dados móveis).
type CreateWorkerPhone = {
  name: string;               // 1–60
  androidVersion: 'Android 11' | 'Android 12' | 'Android 13' | 'Android 14' | 'Android 15' | 'Android 16';
  proxy: { typeId: 1 | 2 | 3; server: string; port: number; username: string; password: string };
};

type CreateWorkerJob = {
  jobId: string;              // UUID gerado pela API (mesmo id nos dois lados)
  phoneId: string;
  // network_check: setting_network → starting_phone → connecting_adb → checking_network e termina
  // `done` / step `network_ok` (ou `egress_mismatch`), sempre desligando o phone. Sem app nem número.
  mode?: 'register' | 'network_check'; // padrão register
  app?: 'whatsapp' | 'business';       // obrigatório no register
  countryCode?: string;       // só dígitos, ex.: "55" (register)
  number?: string;            // só dígitos, sem o país (register)
  proxy: { typeId: 1 | 2 | 3; server: string; port: number; username: string; password: string };
  // Endereço interno do mesmo proxy, para o worker descobrir o IP de saída (seção 4). Opcional.
  probeProxy?: { server: string; port: number; username: string; password: string };
  expectedEgressIps: string[];
  powerOffWhenDone: boolean;
};

type JobInput =
  | { type: 'sms'; code: string }                                   // 6 dígitos
  | { type: 'profile'; name: string; photoBase64?: string; photoMime?: 'image/jpeg' | 'image/png' }
  | { type: 'link' }                                                 // usuário quer conectar ao ZapLiga
  | { type: 'finish' }                                               // usuário não quer conectar
  | { type: 'pair_code'; code: string };                             // "ABCD-EFGH" ou "ABCDEFGH"

type WorkerJob = {
  jobId: string; phoneId: string; mode: 'register' | 'network_check';
  app: 'whatsapp' | 'business' | null; number: string | null; // número completo, só dígitos; null no network_check
  status: 'running' | 'waiting_input' | 'done' | 'failed' | 'cancelled';
  step: string; awaiting: null | 'sms' | 'profile' | 'link_decision' | 'pair_code';
  message: string | null; errorCode: string | null; hasScreenshot: boolean;
  egressIp: string | null;    // IP visto de dentro do phone
  history: { step: string; at: string; message: string | null }[];
  createdAt: string; updatedAt: string;
};
```

## 3. API pública (`/api/tenants/:tenantId/provisioning/...`)

Guardas: `AuthGuard, TenantMembershipGuard, RolesGuard, FeatureFlagGuard`,
`@RequiresFeature('whatsapp_provisioning')`, `@Roles('leader', 'super_admin')`. Escrita também
passa por `entitlement.assertAction(tenantId, 'write', userId)`.

| Método e rota | Corpo | Resposta |
|---|---|---|
| `GET egress` | — | `{ items: EgressNode[], configured: boolean }` |
| `PUT egress/{node}` | `{ userId: string \| null }` | `EgressNode` (liga o nó a uma pessoa) |
| `GET phones` | — | `{ items: Phone[] }` (repasse do worker) |
| `POST phones` | `{ name, androidVersion, egressNode }` | `201 Phone` (criado já saindo pelo PC `egressNode`) · `409 egress_offline` |
| `POST jobs` | `CreateJob` | `201 Job` |
| `GET jobs` | `?limit=20` | `{ items: Job[] }` (mais recentes primeiro) |
| `GET jobs/{id}` | — | `Job` |
| `POST jobs/{id}/sms` | `{ code: string }` | `Job` |
| `POST jobs/{id}/profile` | multipart: `name` (texto) + `photo` (arquivo opcional, JPEG/PNG ≤ 2 MB) | `Job` |
| `POST jobs/{id}/link` | `{ connect: boolean }` | `Job` (com `connect=true` a API conduz o pareamento) |
| `POST jobs/{id}/cancel` | — | `Job` |
| `GET jobs/{id}/screenshot` | — | `image/png` |

```ts
type EgressNode = {
  node: string;               // id do PC em egress_pcs (a vaga edge-N é resolvida na criação do job)
  pcName: string;             // nome do PC
  label: string;              // nome da pessoa ligada ao nó, ou o hostname
  online: boolean;
  publicIps: string[];
  userId: string | null; userName: string | null;
  isMine: boolean;            // ligado ao usuário logado
};

type CreateJob = {
  egressNode: string; geelarkPhoneId: string;
  mode?: 'register' | 'network_check';  // network_check = "Testar internet" (sempre desliga no fim)
  app?: 'whatsapp' | 'business'; countryCode?: string; number?: string; // obrigatórios no register
  powerOffWhenDone?: boolean; // padrão true
};

type Job = WorkerJob-like & {
  id: string; egressNode: string; geelarkPhoneId: string; phoneName: string | null;
  linked: boolean; numberId: string | null; createdBy: string; createdAt: string; updatedAt: string;
};
```

Regras da API:

- `POST jobs` recusa (`409 egress_offline`) se o nó não estiver online agora, e
  (`400`) se `number`/`countryCode` não forem dígitos válidos (só no `register`).
- `POST phones` também exige o PC online e grava `provisioning.phone_created` na auditoria. A
  cobrança do GeeLark começa só quando o phone liga (no teste de internet ou no cadastro).
- `GET jobs/{id}` consulta o worker, atualiza a cópia no banco e devolve. Se o worker
  responder `404` para um job que não terminou, marca `failed` / `worker_lost` e pede ao
  worker `POST /phones/{id}/stop`.
- `POST jobs/{id}/link` com `connect=true`: manda `{type:'link'}` ao worker, espera (até 90 s)
  ele chegar em `awaiting=pair_code`, cria a linha com `NumbersService.create` (label =
  `phoneName` ou o número; phone = número completo), pede o código com o
  **`NumbersService.pairCode(tenantId, userId, numberId, número)`** que já existe na main e
  repassa `{type:'pair_code', code}` ao worker. Depois os `GET` acompanham a sessão Waxum até
  `connected` → `linked=true`, `step=done`; após 120 s → `failed` / `link_timeout` (a linha
  criada continua, para tentar pelo QR).
- Conectada a linha, a API a leva para a **mesma vaga do PC usado no cadastro**
  (`NumbersService.moveToWaxumNode(tenantId, userId, numberId, slot)`), para o número manter o
  mesmo IP. É melhor esforço: se o PC estiver offline ou a troca falhar, a linha fica na VPS, o
  job continua `done` e a `message` avisa.
- `connect=false` manda `{type:'finish'}`.

## 4. Túnel (IP de saída)

Reaproveita a **saída pelo PC do atendente** que já existe
([`saida-pelo-pc-do-atendente.md`](saida-pelo-pc-do-atendente.md)): cada PC (`egress_pcs`) ocupa
uma vaga `edge-N`, e tudo o que roda na rede do contêiner `tailscale-edge-N` sai pelo PC.

```
cloud phone (GeeLark) ──SOCKS5 (internet)──► VPS socks-gateway:1080 ──► socks-edge-N:1080 ──► PC do atendente ──► internet
                          usuário = edge-N, senha = EGRESS_SOCKS_PASSWORD     (rede da vaga N)
```

- **`socks-edge-N`** (um por vaga, `network_mode: service:tailscale-edge-N`, imagem do
  `geelark-worker`): SOCKS5 sem senha, escutando `:1080` dentro da rede da vaga (só a rede
  interna do Compose alcança). **Só aceita conexão enquanto `/egress/route` for `pc`**
  (`offline`/`vps`/sem arquivo → recusa), para um cadastro nunca sair pela VPS.
- **`socks-gateway`** (um só): SOCKS5 com usuário/senha (RFC 1929). Usuário = nome da vaga
  (`edge-1`…), senha = `EGRESS_SOCKS_PASSWORD`; repassa a conexão ao `socks-edge-N`
  correspondente. Senha vazia → recusa tudo. Porta publicada em
  `${EGRESS_SOCKS_BIND:-127.0.0.1}:${EGRESS_SOCKS_PORT:-1080}`: fechada até a produção definir
  `EGRESS_SOCKS_BIND=0.0.0.0`.
- Nenhum contêiner `tailscale-edge-N`/`waxum-edge-N` muda: o deploy não os recria e as linhas
  que já saem pelos PCs não caem.

Configuração da API:

| Variável | Uso |
|---|---|
| `EGRESS_SOCKS_PUBLIC_HOST` | host público da VPS que o GeeLark usa (IP ou nome) |
| `EGRESS_SOCKS_PORT` | porta pública do `socks-gateway` (padrão `1080`) |
| `EGRESS_SOCKS_PASSWORD` | senha do gateway (a mesma do contêiner) |
| `EGRESS_SOCKS_INTERNAL_URL` | como o worker alcança o gateway por dentro (padrão `socks-gateway:1080`) |

- `GET egress` lista os PCs de `egress_pcs` que têm vaga: `node` = **id do PC** (estável; a vaga
  pode mudar), `label` = nome do PC (ou da pessoa ligada a ele em
  `provisioning_egress_nodes`), `online` = mesma regra do `EgressService.nodes()` (`route='pc'` e
  relatório da vaga com menos de 60 s), `publicIps` = `[]` (o IP é descoberto pelo worker, abaixo).
- `configured` = Tailscale conectada (`egress_settings` existe) **e** `EGRESS_SOCKS_PUBLIC_HOST` e
  `EGRESS_SOCKS_PASSWORD` definidos. Sem isso, `POST jobs` responde `503 egress_not_configured`.
- `POST jobs` resolve a vaga do PC **na hora** e manda ao worker:
  `proxy = { typeId: 1, server: EGRESS_SOCKS_PUBLIC_HOST, port: EGRESS_SOCKS_PORT, username: slot, password }`
  e `probeProxy = { server, port, username, password }` com o endereço interno, e
  `expectedEgressIps: []`.
- **IP esperado:** com `expectedEgressIps` vazio e `probeProxy` presente, o worker consulta
  `https://api.ipify.org` **através do `probeProxy`** antes de ligar o phone; esse é o IP do PC.
  Depois exige que o IP visto de dentro do phone seja igual (`egress_mismatch` se não for;
  `egress_offline` se o probe falhar).

## 5. Banco (migration `067_whatsapp_provisioning.sql`; 064–066 já existem na main)

- `tenant_feature_flags.whatsapp_provisioning BOOLEAN NOT NULL DEFAULT false`
- `provisioning_jobs` (id, tenant_id, created_by, egress_node, geelark_phone_id, phone_name,
  app, phone, status, step, awaiting, message, error_code, egress_ip, linked, number_id,
  link_started_at, created_at, updated_at, finished_at)
- `provisioning_egress_nodes` (tenant_id, node_name, user_id, updated_at; PK tenant_id + node_name)
- `068_provisioning_network_check.sql`: `provisioning_jobs.mode` (`register` | `network_check`,
  padrão `register`); `app` e `phone` passam a aceitar NULL, mas continuam obrigatórios no `register`.
