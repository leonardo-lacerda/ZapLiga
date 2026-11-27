# Nova camuflagem por linha (#5): a linha entra como o celular da Multilogin

## O que é

Cada linha pode escolher, no cartão da página Números, entre:

- **Como está hoje** (padrão de toda linha): nada muda. Uma linha sem camuflagem continua com o
  padrão do Waxum. Uma linha com a camuflagem de navegador ([`stealth-profile.md`](stealth-profile.md))
  continua com ela.
- **Nova camuflagem (#5)**: a linha se registra e faz login como o celular na nuvem da Multilogin em
  que o número foi registrado, ligado como um segundo celular da conta. Ela manda:
  - no registro (ao parear): um celular Android (`android_phone`, sistema `Android`);
  - em todo login: **WhatsApp ou WhatsApp Business**, como a conta for; a versão do Android, a
    marca e o modelo do celular, a operadora (MCC/MNC), o idioma `pt_BR` e um `phone_id` fixo da linha.

**WhatsApp Business:** uma conta Business só vincula um segundo celular que também diga ser
Business. Com o perfil de WhatsApp comum, o celular mostra "Your account can't link to WhatsApp.
Download WhatsApp Business on your other device", e o Waxum registra `No pair-success within 60s of
companion_finish` (Previtas 22, 27/11/2026). Por isso o admin escolhe o app do número junto com o
celular. Business faz o login dizer `SMB_ANDROID` (imagem v12). Trocar o app de uma linha só vale no
próximo pareamento e não é possível com a linha pareada com o perfil.

Só o admin do ZapLiga (`super_admin`) vê e muda a escolha, no cartão da linha ou na criação.

## Quando vale

**Só no pareamento** (QR ou código). Até o próximo pareamento, a linha segue exatamente como está.

| Situação | O que a linha manda |
|---|---|
| Nunca escolheu a nova camuflagem | O mesmo de antes, byte a byte |
| Escolheu, ainda não pareou de novo | O mesmo de antes (mais um `reset`, que não muda nada no Waxum) |
| Pareou com a nova camuflagem | O perfil do celular em todo login |
| Voltou para "Como está hoje", ainda não pareou de novo | Continua com o perfil do celular |
| Voltou e pareou de novo | O que tinha antes (o Waxum apaga o perfil Android salvo) |

Colunas em `whatsapp_numbers` (migration 083):

- `device_profile_enabled`: a escolha do admin;
- `device_profile_active`: o que o pareamento atual carrega, gravado a cada pedido de pareamento;
- `multilogin_phone_id`, `device_profile`, `device_profile_frozen_at`: o celular e a cópia
  congelada dele.

O cartão mostra o estado: **Vale no próximo pareamento**, **Ativa** ou
**Ativa até o próximo pareamento**.

## O celular da Multilogin

- A API lê os celulares com `GET https://api.multilogin.com/mobile_profiles/phone/list` e o token
  de automação em `MULTILOGIN_TOKEN` (no `/opt/zapliga/.env` do servidor).
- Formato conferido em 27/11/2026: a lista vem em `data.items` (com `data.total`). De cada celular
  vêm o nome (`serial_name`) e, em `equipment_info`, a marca (`device_brand`), o modelo
  (`device_model`), o Android (`os_version`, "Android 16") e se tem chip (`enable_sim`). Um celular
  sem marca, modelo ou Android não aparece na lista.
- **Operadora:** a Multilogin não informa. Celular **sem chip** (`enable_sim = 0`, 21 dos 22 em
  27/11) manda `000/000`, como um Android sem chip de verdade. Celular **com chip** recebe uma
  operadora brasileira (Vivo 06, Claro 05 ou TIM 02, pela participação de mercado) sorteada pelo
  id do celular, sempre a mesma para ele.
- **Modelos iguais:** em 27/11, 21 dos 22 celulares eram OPPO Find X8 Pro com Android 16. Cada linha
  manda o modelo do próprio celular, então essas linhas vão todas aparecer como esse modelo. Para
  variar, crie os próximos celulares na Multilogin com outra marca e modelo.
- **Um celular, uma linha, para sempre** (índice único em `multilogin_phone_id`): duas contas com a
  mesma identidade ficariam ligadas uma à outra. Um celular já usado aparece desabilitado na lista.
- **Trocar o celular** de uma linha só é possível com a linha fora da nova camuflagem: volte para
  "Como está hoje", pareie de novo e então escolha o outro celular.
- O `phone_id` é gerado uma vez por cópia e nunca muda. A biblioteca avisa que um `phone_id` novo
  a cada login fez o servidor derrubar sessões; este não muda.

## Desligar em emergência

- `DEVICE_PROFILE_KILLSWITCH=true` na API: toda linha passa a se comportar como se nunca tivesse
  escolhido a nova camuflagem, já no próximo pedido ao Waxum, sem mexer no banco.
- Uma linha que estava pareada com o perfil volta a logar com o padrão, mas continua registrada
  como Android até parear de novo.

## Waxum

- O perfil viaja no mesmo `client_profile` da camuflagem de navegador (`client_profile.android`),
  e o Waxum salva tudo em `{sessão}/zapliga-identity.json`. O volume das sessões é o mesmo em todos
  os Waxums, então o perfil acompanha a linha quando ela troca de PC.
- Patches: `whatsapp-rust-client-profile-carrier.patch` (MCC/MNC no `ClientProfile`; o padrão
  continua `000`) e `waxum-zapliga-device-profile.patch`. Imagem:
  `zapliga-waxum:0.12.6-multirelay-v12-business` (a v11 não conhece o Business).
- O Waxum principal (`zapliga-waxum-1`) roda a v4 e **não** entende o perfil. Hoje nenhuma linha está
  nele. Uma linha com a nova camuflagem não deve ser movida para ele.

## Como colocar em produção

1. **Imagem:** enviar uma branch `waxum-build/v11-device-profile` para o GitHub. O workflow
   "Construir imagem do Waxum" compila, roda os testes `zapliga_` e publica o release
   `waxum-0.12.6-multirelay-v11-device-profile`. Nunca compilar na VPS.
2. **Carregar** a imagem no servidor pelo workflow "Carregar imagem do Waxum".
3. **Token:** pôr `MULTILOGIN_TOKEN=...` no `/opt/zapliga/.env`.
4. **Deploy da API e do painel** (merge na `main`). A migration 083 só acrescenta colunas; nenhuma
   linha muda.
5. **Edges na v11:** trocar `image:` dos edges no `docker-compose.yml` para a v11. Para uma linha sem
   a nova camuflagem, a v11 se comporta como a v10. Voltar: v10.
6. **Canário:** um número novo, registrado num celular da Multilogin, criado com a nova camuflagem.

## Coortes

`GET /api/stealth/cohorts` agora separa três grupos: `device_profile` (pareadas com a nova
camuflagem), `stealth` (camuflagem de navegador completa) e `control` (nenhuma das duas). Linhas que
já tiveram a nova camuflagem e saíram ficam fora, porque misturam as duas coisas.

Critério de parada do canário, combinado antes de começar:

| Sinal | Janela | Ação |
|---|---|---|
| `device_removed` numa linha da coorte | 48 h depois do pareamento | parar e voltar a linha |
| `account_locked` ou `temp_banned` | a qualquer momento | parar |
| queda de sessão sem ligação | 24 h | parar |
| nenhum dos acima | 14 dias | ampliar, uma linha por vez |

Com a taxa de hoje (cerca de uma perda a cada 60 dias por linha), uma linha só por 14 dias mostra
se o perfil derruba a linha rápido. Não prova que ele é melhor que hoje: para isso, mais linhas ou
mais tempo.
