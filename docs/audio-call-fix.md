# Correção do áudio bidirecional

## Sintoma

A chamada WhatsApp era estabelecida e o áudio do telefone chegava ao navegador,
mas a voz do SDR não chegava ao telefone. Em alguns testes o telefone também
ficava mostrando “Reconectando...” após o atendimento.

## Causa encontrada

1. O navegador podia iniciar a chamada sem ter um dispositivo de entrada
   disponível. O `getUserMedia` falhava com `NotFoundError` e o frontend
   classificava qualquer erro como `microphone_denied`, encerrando a chamada.
2. O `AudioContext` só era criado depois que o microfone abria. Quando a
   captura falhava, os frames recebidos do telefone também eram descartados.
3. O `ScriptProcessorNode` produzia blocos de 4096 amostras, mas o Waxum/
   `whatsapp-rust` exige frames PCM mono de 16 kHz com exatamente 960 amostras
   (60 ms, 1920 bytes).

## Solução aplicada

- O microfone é preparado quando o SDR ativa “Disponível”.
- O erro real do navegador é exibido, incluindo a quantidade de microfones
  detectados.
- A captura é reamostrada para 16 kHz e acumulada até formar frames exatos de
  960 amostras.
- O áudio recebido usa PCM little-endian e continua sendo reproduzido pelo
  navegador durante a chamada.
- O atendimento é sinalizado ao SDR assim que o evento `Accept` é confirmado
  pelo Waxum/NATS.
- O timeout de toque não encerra uma chamada que já foi atendida, mesmo se o
  primeiro frame de áudio recebido atrasar.

## Validação realizada

- Microfone USB detectado pelo Chrome.
- API e frontend compilados sem erros de TypeScript.
- 9 testes unitários passaram.
- Chamada real para `5511957632036` foi estabelecida.
- A chamada permaneceu 51 segundos em `media_active`.
- O log confirmou frames de microfone com 1920 bytes.
- Resultado final: `completed / remote_hangup`.

## Requisitos para novos testes

- O Windows precisa mostrar um dispositivo de gravação ativo.
- O Chrome deve listar pelo menos um `audioinput` em `enumerateDevices()`.
- O SDR deve clicar em “Ficar disponível” e permitir o microfone.
- O Waxum permanece fixado na versão descrita em `docs/waxum-version.md`.

## Proteção contra regressão de transporte

O healthcheck HTTP/NATS confirma que o processo está vivo, mas não prova que o
RTP de entrada de uma chamada está chegando. Em 2026-09-03 uma sessão
reconectada automaticamente continuou autenticada e fazendo chamadas, porém o
Waxum entregava somente PCM zerado e registrava `AudioReceptionStalled`.

A API agora trata como falha de infraestrutura uma chamada atendida que, por
10 segundos e pelo menos 120 mil amostras, recebe somente zero digital enquanto
o microfone do SDR está ativo. Nesse caso ela:

- não contabiliza a chamada como concluída nem consome a tentativa do lead;
- encerra a chamada explicitamente para não deixar o telefone reconectando;
- aplica cooldown na linha;
- usa uma trava distribuída para desconectar e reconectar a sessão Waxum sem
  apagar o pareamento/QR;
- só devolve a linha ao estado conectado depois que o Waxum confirma login.

Os limites podem ser ajustados por
`WHATSAPP_INBOUND_AUDIO_STALL_MS`,
`WHATSAPP_INBOUND_AUDIO_STALL_SAMPLES` e
`WHATSAPP_INBOUND_AUDIO_RECOVERY_BACKOFF_SECONDS`.
