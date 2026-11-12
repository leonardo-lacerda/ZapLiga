# Plano: gravação e transcrição de chamadas

## Objetivo

Guardar o áudio das chamadas atendidas e gerar a transcrição com quem falou cada frase (SDR ou lead), usando o Whisper do Groq.

## Como o áudio passa hoje

```
navegador ⇄ (WS, PCM16 LE mono 16 kHz) ⇄ API (api-a / api-b) ⇄ (WS, mesmo PCM) ⇄ Waxum ⇄ WhatsApp
```

- Os dois lados passam pela API em `DialerService.attachMedia` (`apps/api/src/modules/dialer/dialer.service.ts`):
  - lead → SDR: `media.on('message')`;
  - SDR → lead: `resource.browserMessageHandler`.
- O formato já é o que o Whisper usa (16 kHz mono), então não é preciso mexer no Waxum.
- Os lados chegam em fluxos separados e sem timestamp comum. O alinhamento é feito pelo relógio de chegada.
- O estado da chamada vive em memória na instância dona da chamada (nginx `ip_hash`). O fim passa sempre por `finishCall`.

## Groq Whisper

| Item | Valor |
|---|---|
| Endpoint | `POST https://api.groq.com/openai/v1/audio/transcriptions` (compatível com OpenAI) |
| Modelos | `whisper-large-v3` (WER 10,3%, US$ 0,111/h no pago) · `whisper-large-v3-turbo` (WER 12%, US$ 0,04/h) |
| Formatos | flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm |
| Arquivo máximo | 25 MB (free) · 100 MB (dev) |
| Cobrança mínima | 10 s por requisição |
| Parâmetros úteis | `language=pt`, `prompt` (≤ 224 tokens de vocabulário), `response_format=verbose_json` (segmentos com tempo, `no_speech_prob`) |

Limites do plano free:
- Os números abaixo valem para os dois modelos. Confira os da conta em console.groq.com/settings/limits.
- O que aperta é a cota de áudio por dia, que conta a duração do arquivo, inclusive silêncio.

| Limite | Valor |
|---|---|
| Requisições por minuto (RPM) | 20 |
| Requisições por dia (RPD) | 2.000 |
| Áudio por hora (ASH) | 7.200 s (2 h) |
| Áudio por dia (ASD) | 28.800 s (8 h) |

Exemplo para chamadas atendidas de 3 min com um arquivo por lado:
- cada chamada gasta 6 min de cota → cerca de 80 chamadas por dia;
- cortando os silêncios de cada lado → cerca de 160 chamadas por dia.

## Decisão: transcrever depois da chamada, não por partes

- O Whisper do Groq não faz streaming. Mandar pedaços multiplica requisições (20 RPM, mínimo de 10 s cobrados por requisição), corta palavras na emenda e perde contexto.
- O Groq processa cerca de 190× o tempo real. Uma chamada de 10 min fica pronta em segundos depois de encerrada.
- Transcrição ao vivo (assistente para o SDR durante a ligação) seria outro produto e pediria um serviço de streaming.
- Divisão em partes só como proteção para arquivos acima de 25 MB. Em Opus 32 kbps isso dá mais de 1h40 por lado.

## Fases

### Fase 1 — gravação e transcrição (esta entrega)

1. **Liga/desliga por empresa:** feature flag `call_recording`, desligada por padrão.
2. **Durante a chamada:**
   - A partir do atendimento (primeiro frame ativo), cada lado é gravado em PCM bruto em `CALL_RECORDING_DIR/spool`. Não fica na memória.
   - Cada lado é posicionado pelo relógio desde o atendimento. Lacunas maiores que 200 ms viram silêncio, para os dois lados ficarem alinhados.
3. **No `finishCall`:** os arquivos são fechados e igualados em duração, e uma linha `call_recordings` é criada com status `pending`.
4. **Worker** (qualquer instância; o volume `call_recordings` é compartilhado por api-a e api-b):
   - **Guardar:** junta os dois lados num Ogg/Opus estéreo (esquerdo = SDR, direito = lead, 32 kbps, ≈ 240 KB/min) em `CALL_RECORDING_DIR/<tenant>/<AAAA-MM>/<call>.ogg` e apaga o spool. Nada vai para a nuvem.
   - **Transcrever:** só chamadas com pelo menos `CALL_TRANSCRIPTION_MIN_SECONDS` (15 s).
     - Cada lado é separado e só os trechos com voz vão ao Groq. Numa chamada de 20 s com 7 s de fala, o Groq recebe cerca de 11 s em vez de 40 s.
     - Parâmetros: `whisper-large-v3`, `language=pt`, `verbose_json`.
     - Segmentos com `no_speech_prob > 0,6` são descartados.
     - Os tempos voltam para a linha do tempo da chamada e os dois lados viram um diálogo.
   - **Limites:** um `429` respeita o `retry-after` sem gastar tentativa. Outras falhas tentam de novo com backoff (até 1 h) e viram `failed` depois de 10 tentativas.
5. **CRM:** chamadas feitas por uma integração recebem o evento `call.transcribed`, e o áudio sai em `GET /api/v1/integrations/calls/:id/recording`.

### Fase 2 — produto no ZapLiga

- Player e transcrição na tela da chamada do ZapLiga.
- Retenção: apagar áudio e transcrição depois de N dias e na anonimização (`privacy.service.ts`).
- Resumo e próximos passos por LLM, opcional.

### No Franco (integração "zapcall")

- **Na conversa:** o evento `call.transcribed` grava a transcrição em `calls.transcript` e cria uma nota privada com o texto e o áudio anexado.
  - Vai na conversa de onde a ligação foi feita, senão na do lead, senão na da caixa ZapLiga.
- **No HubSpot:** onde o HubSpot é a fonte da verdade, a transcrição vira uma nota no contato e no negócio/lead.
  - Usa a opção nova "Transcrições das ligações" (`push.call_transcripts`, ligada por padrão).
  - Essa nota não é reenviada como nota interna.

## Pendências de decisão

- **Disco:** os áudios ficam no volume `call_recordings` da VPS (≈ 240 KB por minuto de ligação). Uma política de retenção evita que o disco encha.
- **LGPD:**
  - Base legal e aviso ao lead.
  - Retenção, por exemplo 90 dias.
  - Incluir gravações e transcrições no fluxo de acesso e anonimização (`privacy.service.ts`).
  - Envio do áudio a um provedor nos EUA (transferência internacional).
  - Até isso ser resolvido, a flag `call_recording` fica desligada.
- **Plano Groq:** o free serve para validar. Em produção com vários clientes, as 8 h por dia acabam rápido.

## Configuração

| Variável | Uso |
|---|---|
| `CALL_RECORDING_DIR` | Pasta dos áudios e do spool (padrão `/var/lib/zapliga/recordings`, volume `call_recordings`) |
| `GROQ_API_KEY` | Chave do Groq (console.groq.com) |
| `GROQ_TRANSCRIPTION_MODEL` | `whisper-large-v3` (padrão) ou `whisper-large-v3-turbo` |
| `GROQ_TRANSCRIPTION_PROMPT` | Vocabulário da operação: nomes de produtos, da empresa (até 224 tokens) |
| `CALL_TRANSCRIPTION_MIN_SECONDS` | Duração mínima para transcrever (padrão 15) |
