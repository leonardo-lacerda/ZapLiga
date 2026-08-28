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
