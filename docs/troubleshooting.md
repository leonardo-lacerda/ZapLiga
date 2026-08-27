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

