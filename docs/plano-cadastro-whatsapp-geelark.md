# Plano — cadastro de WhatsApp em cloud phones GeeLark pelo ZapLiga

Status: proposta (2026-11-17). Recurso **interno** da operação, ligado por feature flag;
não é oferecido a clientes.

## Objetivo

Cadastrar um número de WhatsApp num cloud phone do GeeLark sem sair do ZapLiga. A parte
humana se resume a digitar o **SMS** recebido e escolher **nome e foto**. Opcionalmente, a
linha já entra no ZapLiga pareada por **telefone + código**, sem QR Code.

## Fluxo na tela (assistente em `/app/numeros/cadastrar`)

| Passo | O que o usuário vê/faz | O que o sistema faz |
|---|---|---|
| 0. Rede (IP) | Lista dos PCs dos atendentes (Admin → Saídas de internet). O do admin logado vem selecionado; dá para escolher o de outra pessoa que esteja online. PC offline aparece desabilitado | `GET .../provisioning/egress` → PCs de `egress_pcs` com vaga |
| 1. Telefone | Grade com os cloud phones do GeeLark: nome, status, Android, rede, apps instalados | `GET .../provisioning/phones` → worker → API GeeLark |
| 2. App | WhatsApp ou WhatsApp Business (desabilita o que já tem conta) | — |
| 3. Número | Código do país (+55) e número | Liga o phone, ADB + glogin, testa a internet, instala o app se faltar, abre e digita o número |
| 4. SMS | Linha do tempo do progresso; quando chegar a vez, um campo para o código | Worker para em `waiting_sms`; o código vai pela API até ele |
| 5. Perfil | Nome e foto | Worker envia a foto ao phone (`adb push`) e preenche o perfil |
| 6. Conexão | Chave "Conectar ao ZapLiga por telefone + código" | Cria a linha (NumbersService) → abre "Conectar com número" no phone → `POST /pair` no Waxum → digita o código → espera `connected` |
| Fim | Linha pronta, com link para **Números** | Desliga o phone se essa opção estiver marcada (padrão: sim) |

Em qualquer passo: **Cancelar**, que interrompe o job e desliga o phone. Em caso de falha, o
erro aparece com um screenshot da tela do phone.

## Arquitetura

```
web (assistente) ──HTTP──► api-a/api-b ──HTTP interno──► geelark-worker (Python)
                              │  provisioning_jobs (Postgres)     │ adb + uiautomator2 ──► cloud phone (ADB público do GeeLark)
                              └─ Waxum: POST /sessions/:id/pair   └ API GeeLark (token da plataforma)
```

### `services/geelark-worker` (novo container)

- Python 3.12 + FastAPI + `adb` + `uiautomator2`. Reaproveita `geelark_api.py`, `device.py`
  e `whatsapp.py` do projeto `whatsapp-geelark`, que passam a viver aqui como fonte única.
- **Sem porta pública**: só a rede interna do Compose. A API se autentica com o header
  `x-worker-token` (`GEELARK_WORKER_TOKEN`).
- O token do GeeLark (`GEELARK_API_TOKEN`) fica **só no worker**.
- Um job por phone (lock) e no máximo 2 jobs simultâneos. O rate limit da API GeeLark
  (200 req/min, bloqueio de 2 h) é controlado aqui, num lugar só.
- Rotas internas: `GET /phones`, `POST /jobs`, `GET /jobs/:id`, `POST /jobs/:id/input`
  (sms | profile | pair_code), `POST /jobs/:id/cancel`, `GET /jobs/:id/screenshot`.
- Estado do job persistido no Redis, para sobreviver a um restart do worker. Ao reiniciar,
  jobs pela metade viram `failed` e o phone é desligado.

### Rede do cadastro: IP do admin pelo túnel Tailscale

**Regra:** o cadastro sempre sai pelo IP residencial de uma pessoa da operação, por padrão o
do admin que está cadastrando, pela **saída pelo PC do atendente** que já existe
([`saida-pelo-pc-do-atendente.md`](saida-pelo-pc-do-atendente.md)). **Sem o PC escolhido
online, o cadastro não começa.** O modo "Minha internet" do app GeeLark não é usado.

Como o cadastro usa isso (detalhes no [contrato, seção 4](provisioning-contract.md)):

1. **Listar PCs:** os PCs de `egress_pcs` com vaga `edge-N`, com a mesma regra de "online" do
   Admin → Saídas de internet. Cada PC pode ser ligado a uma pessoa
   (`provisioning_egress_nodes`); o do usuário logado vem pré-selecionado.
2. **Apontar o phone:** o worker troca a rede do phone pela API GeeLark (`phone/detail/update`,
   SOCKS5) para o `socks-gateway` da VPS com usuário = vaga. O gateway repassa ao
   `socks-edge-N`, que roda na rede da vaga e só aceita conexão enquanto ela sai pelo PC.
3. **Conferir antes de tudo:** o worker descobre o IP do PC pelo próprio proxy e, com o phone
   ligado, exige que o IP visto de dentro do phone seja o mesmo. Se não for, o job para e
   **não abre o WhatsApp**.
4. **Se o PC cair no meio:** o proxy recusa novas conexões e o job falha, em vez de seguir pela
   VPS.
5. **Depois de conectada,** a linha vai para a vaga do mesmo PC (`moveToWaxumNode`), mantendo o
   IP do cadastro.

### Máquina de estados do job

```
queued → checking_tunnel → setting_network → starting_phone → connecting_adb → checking_network → installing_app?
→ opening_app → entering_number → waiting_sms ⇄ (código errado: waiting_sms)
→ verifying → waiting_profile → saving_profile → registered
→ [linking: creating_line → opening_link_screen → waiting_pair_code → entering_pair_code → linked]
→ done | failed | cancelled
```

Cada transição grava `step`, `message` e `updated_at`. A página consulta a cada 2 s, sem
WebSocket novo.

### API — `apps/api/src/modules/whatsapp-provisioning`

- Guardas: `RequiresFeature('whatsapp_provisioning')` + papel `leader`/`super_admin` +
  `entitlement.assertAction('write')`.
- Rotas (`/api/tenants/:tenantId/provisioning/...`): `GET phones`, `POST jobs`,
  `GET jobs/:id`, `POST jobs/:id/sms`, `POST jobs/:id/profile` (multipart, foto ≤ 2 MB,
  JPEG/PNG), `POST jobs/:id/link`, `POST jobs/:id/cancel`.
- Migration `067_whatsapp_provisioning.sql`: tabela `provisioning_jobs` (tenant_id,
  geelark_phone_id, app, phone, status, step, message, number_id, created_by, timestamps) e
  a coluna da feature flag em `tenant_feature_flags`.
- Auditoria: `provisioning.started`, `.sms_submitted`, `.registered`, `.linked`,
  `.failed`, `.cancelled`. **O código SMS nunca é gravado** em log, banco ou auditoria.
- `WaxumClient.pair(sessionId, phone)` → `POST /api/v1/sessions/:id/pair`
  `{ phone_number }` → `{ code, timeout_seconds }`.

### Pareamento por código (sem QR)

O código do Waxum vale **60 s**. Por isso a ordem é:

1. O worker deixa o phone parado em *Aparelhos conectados → Conectar aparelho → Conectar com
   número de telefone* e avisa `waiting_pair_code`.
2. Só então a API cria a linha (`NumbersService.create`), pede `POST /pair` e entrega o
   código ao worker.
3. O worker digita o código. A API acompanha `GET /status` da sessão até `connected` e
   atualiza `whatsapp_numbers`.

Não muda nada no Waxum (o endpoint já existe na base `imtaqin/waxum`), então **não há build
de Rust**. Confirmar na fase 0 que a imagem `zapliga-waxum:0.12.6-multirelay-v3` responde
nessa rota.

### Web — `apps/web/src/features/provisioning`

- `ProvisioningWizard.tsx` (passos acima), `PhonePicker.tsx`, `JobTimeline.tsx` e
  `SmsCodeInput.tsx` (6 dígitos, cola com/sem traço).
- Entrada pelo botão **Cadastrar número no GeeLark** em `NumbersPage`, visível só com a flag.
- Testes Vitest/RTL/MSW para cada passo e para os estados de erro.

## Fases

| Fase | Entrega | Como validar |
|---|---|---|
| 0. Túnel | Entender como o `zapliga-edge-1` expõe um proxy por nó; um cloud phone apontado para ele sai com o IP de um PC escolhido | IP de saída consultado de dentro do phone = IP do PC |
| 0. Prova | Motor registra um número de ponta a ponta no Phone 2 (completar `handle_permission`, telas novas: seletor de número do Google, "Couldn't connect", captcha, idioma). `POST /pair` testado no Waxum local | Registro real com SMS; código de pareamento aceito por um WhatsApp de teste |
| 1. Worker | `services/geelark-worker` + serviço no `docker-compose.yml` + testes (API GeeLark mockada, telas por XML salvo) | `pytest` + job real contra o Phone 2 |
| 2. API | Módulo, migration, flag, auditoria, cliente do worker, `WaxumClient.pair` | `npm test`, `verify:multitenant` |
| 3. Web | Assistente completo | `npm run test:web`, teste manual |
| 4. Pareamento | Passo 6 ponta a ponta | Linha nova chega a `connected` sem QR |
| 5. Deploy | Seguindo o `deploy-runbook.md`; secrets `GEELARK_API_TOKEN` e `GEELARK_WORKER_TOKEN` no servidor | Health do worker; um cadastro em produção |

Trabalho num branch (`feat/whatsapp-provisioning`). Push em `main` dispara deploy.

## Riscos e cuidados

- **Rede do phone**: o cadastro depende do PC escolhido ligado e online em Admin → Saídas de internet. O
  worker confere o IP de saída antes de abrir o WhatsApp e para se não bater. Use sempre o
  mesmo nó para o mesmo número: trocar de IP logo após o cadastro aumenta o risco de bloqueio.
- **Custo**: phone ligado é cobrado por minuto. Cada passo tem timeout, o job tem teto de
  20 min, e desliga ao terminar, falhar ou cancelar.
- **Mudanças de tela do WhatsApp** quebram o motor. Telas desconhecidas param o job com
  screenshot + XML salvos, para ajustar os seletores.
- **Banimento**: números novos + gateway não oficial + cloud phone = risco alto. Aquecer antes
  de discar e respeitar os limites de chamadas por número.
- **Dados sensíveis**: SMS e código de pareamento só trafegam em memória. A foto do perfil é
  apagada do phone e do worker depois do uso.
