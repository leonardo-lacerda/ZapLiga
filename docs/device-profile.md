# Perfil de dispositivo por linha

Cada linha do ZapLiga apresenta ao WhatsApp um **perfil de dispositivo** no handshake. O perfil é
gravado uma única vez, no telefone em nuvem (GeeLark) onde o número foi cadastrado, e nunca é
reescrito: uma reconexão apresenta o mesmo aparelho, porque o perfil faz parte da conta e não da
conexão.

Linha sem perfil continua como antes: o Waxum usa os valores do ambiente
(`WA_CLIENT_*`/`WA_DEVICE_*`), que é o comportamento anterior a esta funcionalidade.

## Por que existe

O perfil que o Waxum montava era o mesmo para toda a frota: plataforma Web, `device = "Desktop"`,
`manufacturer = ""`, `mcc`/`mnc` = `"000"`. Três problemas:

1. **Incoerência interna** — um cliente que se declara Web sem os campos de navegador preenchidos,
   e que se declara em rede celular com MCC/MNC `000` (que só existe em Wi-Fi puro, emulador ou
   servidor).
2. **Valores fixos entre linhas** — nada distingue uma linha da outra pelo perfil.
3. **Sem identidade estável** — o identificador de dispositivo não era enviado.

O perfil corrige os três: deriva do telefone onde a conta nasceu, é coerente com a plataforma
declarada e carrega o identificador estável da linha.

## Estrutura

```json
{
  "version": 1,
  "surface": "ANDROID_PHONE",
  "user_agent": {
    "platform": "ANDROID",
    "mcc": "724",
    "mnc": "006",
    "os_version": "14",
    "manufacturer": null,
    "device": null,
    "os_build_number": null,
    "phone_id": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    "release_channel": "RELEASE",
    "locale_language": "pt",
    "locale_country": "BR",
    "device_board": null,
    "device_exp_id": "8a1f...",
    "device_type": "PHONE",
    "device_model_type": null,
    "distribution_channel": null
  },
  "device_props": { "os": "Android", "platform_type": "ANDROID_PHONE", "version": null },
  "web_info": null
}
```

## Origem de cada valor

| Campo | Origem | Se faltar |
|---|---|---|
| `mcc`/`mnc` | operadora do SIM do telefone | `724`/`06` (Vivo BR) |
| `os_version` | `android` do telefone no GeeLark | `14` |
| `manufacturer`/`device` | modelo do telefone | `null` — não sobrescreve |
| `locale_*` | locale do telefone | `pt`/`BR` |
| `phone_id` | `UUID.randomUUID()` no vínculo | gerado no vínculo |
| `device_exp_id` | derivado do `geelark_phone_id` (estável) | `null` |
| `platform`/`device_type` | derivado do `surface` | `ANDROID`/`PHONE` |

## Regras de coerência

Um perfil que viole qualquer regra é **rejeitado na leitura** e a linha cai nos valores do
ambiente, em vez de enviar algo incoerente:

- `mcc` e `mnc` com três dígitos;
- `phone_id` é UUID v4;
- `locale_language` com duas letras minúsculas, `locale_country` com duas maiúsculas;
- `surface = WEB` ⇒ `platform = WEB` e `web_info` preenchido;
- `surface = ANDROID_*` ⇒ `platform = ANDROID`, `web_info = null` e `device_props` preenchido.

## Congelamento

O perfil é gravado em `whatsapp_numbers.device_profile` com `device_profile_frozen_at`, no
momento em que a linha é vinculada ao telefone. `NumbersService.freezeDeviceProfile` é
idempotente: uma linha que já tem perfil mantém o seu.

Mudar o perfil exige **re-pareamento** — o painel avisa, porque trocar o perfil de uma linha
conectada significa apresentar outro aparelho à conta.

## Ligando

A funcionalidade fica atrás de duas flags:

- **Waxum:** `ZAPLIGA_DEVICE_PROFILE=true` (padrão `false`). Com `false`, o código novo não roda e
  o handshake é exatamente o que o ambiente produz.
- **API:** as variáveis `ZAPLIGA_API_URL` e `ZAPLIGA_API_KEY` no container do Waxum, para ele
  buscar o perfil em `GET /api/internal/waxum/sessions/:sessionId/device-profile`.

Se o Waxum não alcançar a API, ele registra o aviso e usa os valores do ambiente — uma linha nunca
deixa de conectar por causa do perfil.

## Medição

Coorte: linhas com perfil congelado contra linhas sem. Por semana:

- taxa de queda por motivo (`loss_reason`);
- tempo de vida mediano da linha;
- taxa de `device_removed` por linha.

Janela mínima de 4 semanas.

## Rollback

`ZAPLIGA_DEVICE_PROFILE=false` no Waxum. O patch fica inerte; o perfil continua gravado no banco
para uma religação futura.
