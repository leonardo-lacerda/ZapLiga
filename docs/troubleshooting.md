# Troubleshooting

## QR Code preso em "Carregando QR Code"

### Sintoma

Ao clicar em `Abrir QR`, o modal permanecia em `Carregando QR Code...` ou a API retornava `503 Client not connected`.

### Causa

Uma sessao recem-criada no Waxum pode existir com status `disconnected`. O endpoint de QR do Waxum so disponibiliza o codigo depois que a conexao da sessao e iniciada pelo endpoint `/connect`.

O frontend tambem mantinha o estado visual de carregamento quando a requisicao falhava, escondendo o erro real.

### Solucao implementada

- O endpoint `GET /api/numbers/:id/qr` detecta a resposta `503` de uma sessao desconectada.
- A API chama automaticamente `/api/v1/sessions/:sessionId/connect` no Waxum e consulta o QR novamente.

- Sessoes ausentes continuam sendo recriadas quando o Waxum retorna `404`.
- O modal renderiza tanto `qr_codes[0]` como payloads `data:`.
- Sessoes ja conectadas exibem uma mensagem informativa, sem exigir QR.
- Falhas de carregamento aparecem no modal em vez de deixar um carregamento infinito.
- O botao `Abrir QR` fica oculto para numeros com status conectado.

### Como validar

1. Crie uma nova sessao na aba `Numeros`.
2. Clique em `Abrir QR` sem clicar primeiro em `Reconectar`.
3. Confirme que o QR aparece e pode ser escaneado.
4. Para uma sessao conectada, confirme que o botao `Abrir QR` nao aparece.

### Diagnostico manual

```powershell
Invoke-RestMethod http://localhost:3000/api/numbers
Invoke-RestMethod http://localhost:3000/api/numbers/<id>/qr
docker compose logs --tail=100 api waxum
```

## Teste local de duas chamadas na mesma sessão

Para verificar experimentalmente se uma única linha/sessão Waxum consegue
manter duas chamadas simultâneas, conecte a linha pelo QR no ambiente local e
primeiro prepare os destinatários sem efetuar chamadas:

```bash
npm run test:concurrent-calls -- --line-label "Linha teste" --numbers 5511999999999 5521999999999 --prepare-only
```

Depois de conferir os dois números, execute o ensaio real:

```bash
npm run test:concurrent-calls -- --line-label "Linha teste" --numbers 5511999999999 5521999999999 --confirm-two-real-calls
```

O comando resolve previamente os dois LIDs, abre os WebSockets na mesma
barreira, envia PCM16 silencioso em frames de 960 amostras a cada 60 ms,
captura `call_id`, eventos NATS, fechamento e frames de áudio, e encerra
explicitamente as duas tentativas após 30 segundos. `Ctrl+C` também
encerra explicitamente qualquer chamada já iniciada. Por segurança, destinos
repetidos, o próprio número da linha e Waxum remoto são bloqueados. Use
`--duration-seconds` para ajustar a janela entre 5 e 120 segundos.

Este ensaio abre o endpoint do Waxum diretamente e, portanto, bypassa a
reserva Redis do discador. Ele serve para investigar o limite do transporte;
o fluxo suportado em produÃ§Ã£o continua limitando uma chamada por linha.
