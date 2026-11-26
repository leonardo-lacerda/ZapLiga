# Camuflagem por linha (experimento)

Opção individual de cada linha, **desligada por padrão**, para medir se uma identidade de aparelho
coerente e própria da linha reduz as quedas (`device_removed`, `account_locked`). Só o admin do
ZapLiga liga e desliga; os clientes não veem a opção.

## Por que

Até a imagem v7 do Waxum, a identidade vinha do **contêiner**. O edge-1 registrava as linhas como
Chrome/Windows e fazia login em pt-BR (`docker-compose.yml`, `WA_DEVICE_*`/`WA_CLIENT_LOCALE`). Os
outros edges registravam como "Desktop" e faziam login em en-US. Quando o pool trocava uma linha de
PC, o login dela mudava de idioma no meio da vida do aparelho. Com a camuflagem, a identidade passa a
ser da **linha** e a acompanha em toda troca de PC e em todo restart.

## O que o perfil muda

O perfil é gerado uma vez por linha, a partir do id dela (sempre o mesmo), e fica congelado em
`whatsapp_numbers.stealth_profile` (migração 081):

```json
{ "version": 1, "surface": "WEB_BROWSER",
  "device": { "os": "Windows", "platform": "chrome" },
  "client": { "locale": "pt_BR" } }
```

- **Registro** (`DeviceProps`, só no pareamento): navegador Chrome, Edge, Firefox ou Safari, nas
  proporções de `STEALTH_PLATFORM_WEIGHTS`. O Safari sempre roda no Mac; os demais rodam no Mac em
  `STEALTH_MAC_SHARE`% das linhas. É a linha "navegador" da tabela de formatos do WA Web
  (`whatsapp-rust` `wacore/src/store/device.rs`, `DEVICE_PROPS`).
- **Login** (`ClientPayload.UserAgent`, todo login): idioma `pt_BR`. O resto continua igual ao perfil
  web da biblioteca.

## O que o perfil não muda, e por quê

| Ideia | Por que ficou fora |
|---|---|
| `phone_id` novo a cada login | O WA Web nunca manda esse campo. Quando um UUID novo foi gerado a cada login, o servidor tratou isso como fingerprint e invalidou a sessão (`device.rs`, comentário de `build_base_client_payload` e teste `phone_id_default_is_omitted_and_payload_is_deterministic`). |
| MCC 724, MNC de operadora, conexão celular | O WA Web manda `000`/`000` e `WIFI_UNKNOWN`: navegador não tem chip. |
| Formato "app do Windows" | Exige `UWP` com sincronização completa de 365 dias de histórico no pareamento. |
| Versão "realista" `2.3000.x` | Forçar essa versão fez o servidor descartar mensagens de linhas recém-pareadas (`waxum/src/device_props.rs`). |
| Lease no Redis | O Waxum já trava cada sessão com `flock` (`lock_session_storage`), e a trava vale entre contêineres do mesmo host. |
| Saída pela VPS | Já bloqueada para todas as linhas. |
| Mensagem antes da ligação para conseguir o token | O `<privacy>` da oferta é o token que **o lead** nos deu. Mandar texto entrega o nosso token a ele. Primeiro se mede o 463 (abaixo). |

## Como ligar

- **Linha nova, em Números:** marque "Camuflagem de navegador (teste)" antes de "Criar sessão".
- **Linha nova, pelo cadastro GeeLark:** marque a mesma opção na tela "Número registrado no
  WhatsApp", antes de "Conectar ao ZapLiga".
- **Linha existente:** a chave no cartão da linha (`PATCH /api/numbers/:id/stealth`
  `{ "enabled": true }`). O login passa a ser pt-BR na próxima conexão, mas o registro só muda num QR
  ou código novo. Até lá a linha aparece como **Parcial**.

Cobertura (`stealth_coverage` na lista de números):
- **FULL:** a linha foi criada ou pareada depois que o perfil foi congelado;
- **PARTIAL:** a linha foi pareada antes.

Religar a opção reaproveita o mesmo perfil. Um celular GeeLark tem no máximo uma linha com
camuflagem.

## Como funciona

- **API:** `sessionIdentity(line)` (`apps/api/src/modules/stealth/stealth-profile.ts`) vai junto em
  todo pedido que abre ou pareia a sessão: criar, `/connect` do QR, código, adoção na troca de PC e
  reconexão.
  - Linha que nunca teve a opção: nada é enviado, e os corpos ficam idênticos aos de antes
    (`waxum.client.spec.ts`).
  - Linha com a opção desligada depois de ligada: vai `client_profile: { reset: true }`.
- **Waxum v8** (`infra/waxum/patches/waxum-zapliga-identity.patch`):
  - grava o pedido em `{sessão}/zapliga-identity.json`, no volume compartilhado das sessões;
  - precedência: pedido > arquivo > ambiente > padrão da biblioteca;
  - o restart (`reconnect_all_on_startup`) e as reconexões automáticas leem o arquivo, sem depender
    da API.

## Desligar

| Escopo | Como | Quando vale |
|---|---|---|
| Uma linha | Desligar a chave no cartão | Próxima conexão (o Waxum apaga o arquivo) |
| Todas, pela API | `STEALTH_KILLSWITCH=true` no `.env` da VPS | Próxima conexão de cada linha; o banco não muda e não dá para ligar linhas novas |
| Todas, pelo Waxum | `WA_SESSION_IDENTITY=off` no ambiente dos Waxums | Próximo login; o Waxum ignora os arquivos e o `client_profile` dos pedidos |
| Imagem | Voltar a tag `0.12.6-multirelay-v7-relay-unwrap` no compose | Próximo deploy |

Voltar atrás troca o login das linhas que estavam com a opção (pt-BR → en-US). É a mesma troca que
acontecia ao mudar de PC: desligue só para encerrar o experimento ou numa emergência.

## Implantação

1. Carregar a imagem `zapliga-waxum:0.12.6-multirelay-v8-identity` na VPS (workflow "Carregar imagem
   do Waxum") **antes** do deploy: o compose já aponta o edge-3 para ela.
2. Deploy normal (migração 081, só colunas novas).
3. **Enquanto só o edge-3 estiver na v8:** ligar a opção apenas em linhas do edge-3. Se o pool mover
   uma delas para um edge na v7, o login volta ao do ambiente desse edge.
4. Validar no edge-3 com uma ligação real (o canário serve) e conferir:
   - o arquivo `zapliga-identity.json` na pasta da sessão;
   - `call_ack` em `call_signal_events`.
5. Passar todos os edges para a v8.
6. Tirar `WA_DEVICE_PLATFORM`/`WA_DEVICE_OS`/`WA_CLIENT_LOCALE` do `waxum-edge-1` e do
   `waxum-proxy-edge-1`. Antes disso, ligar a opção nas linhas pareadas ali desde 26/11/2026,
   para o login delas continuar em pt-BR. O registro já feito como Chrome não muda, e elas ficam
   como Parcial, fora das coortes.

## Coortes e decisão

`GET /api/stealth/cohorts?days=28` (só admin) compara, entre as linhas pareadas na janela:
- **stealth:** opção ligada e cobertura FULL;
- **control:** nunca tiveram a opção.

Ficam fora as linhas que ligaram e desligaram, as PARTIAL e as dos slots de proxy. Cada linha conta a
partir do último pareamento.

| Campo | Fonte |
|---|---|
| `device_removed`, `account_locked`, `losses_per_100_line_days`, `losses_per_100_calls` | `number_health_events` |
| `alive_7d`/`lines_7d`, `alive_14d`/`lines_14d`, `median_hours_to_loss` | primeira perda depois do pareamento |
| `calls`, `answered` | `calls` (sem as ligações de canário) |
| `nacks_463`, `nacks_463_per_100_calls`, `call_acks` | `call_signal_events` `kind='call_ack'` (Waxum v8) |
| `logins`, `logins_per_line_day` | `number_status_history` |

Como dividir as linhas:
- alternar com e sem a opção na ordem de criação, **nos mesmos PCs**;
- não usar o edge-1 enquanto ele tiver identidade no ambiente.

Decisão, depois de **4 semanas ou 10 perdas somando as duas coortes** (o que vier por último):

| Resultado | O que fazer |
|---|---|
| Perdas por 100 linha-dias da coorte com a opção ≤ metade do controle, sem piorar 463 nem o canário | Adotar para todas as linhas |
| Coorte com a opção igual ou pior que o controle | Abandonar |
| Entre os dois | Ampliar para mais 5 linhas por coorte |

Com 3 a 5 linhas por coorte, só um efeito grande aparece.

## Variáveis

| Variável | Onde | Padrão | Efeito |
|---|---|---|---|
| `STEALTH_KILLSWITCH` | API (`docker-compose.yml`, `.env`) | `false` | `true`: toda linha se comporta como desligada |
| `WA_SESSION_IDENTITY` | Waxum | ligado | `off`: ignora a identidade salva e o `client_profile` dos pedidos |
