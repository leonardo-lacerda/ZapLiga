# Estudo: por que o número do GeeLark caiu e os de celular real não

Data: 2026-11-18. Caso: a linha "WhatsApp 2", cadastrada num cloud phone do
GeeLark, recebeu `AccountLocked` (403) do WhatsApp 10 minutos depois de ser
vinculada ao ZapLiga, na segunda ligação. No celular apareceu "Conta em análise".
Os números vinculados a partir de celulares reais, saindo pelo mesmo PC via
Tailscale, seguem funcionando.

## Linha do tempo (UTC, dos logs do waxum, do túnel e do job de cadastro)

| Hora | Evento | IP que o WhatsApp viu |
|---|---|---|
| 14:37:35 | Job de cadastro começa no phone "WhatsApp 2" | — |
| 14:38:02 | Phone confere o IP de saída: 131.255.254.90, o mesmo do PC | PC |
| 14:38:52 → 14:40:40 | Número digitado, SMS recebido e enviado | PC |
| 14:42:02 | Automação para: "o WhatsApp não saiu da verificação do código"; o resto é feito à mão no GeeLark | PC (proxy do phone) |
| 14:48:55 | Linha criada no ZapLiga e código de vínculo gerado no **waxum main** | — |
| 14:49:16 | Aparelho vinculado conecta pela primeira vez | **VPS (datacenter)** |
| 14:49:27 | Pool leva a linha para o `waxum-edge-1` e ela reconecta | PC |
| 14:59:54 | 1ª ligação; 2 s depois o WhatsApp derruba a conexão (503) | PC |
| 15:00:02 | 2ª ligação | PC |
| 15:00:03 | `AccountLocked` (403), sessão deslogada | PC |

O túnel ficou estável o tempo todo (ping a cada 10 s, sem troca de rota).

## O que difere entre o número do GeeLark e os de celular real

| Fator | Celular real | GeeLark | Peso provável |
|---|---|---|---|
| Idade da conta | conta antiga, com histórico | **criada minutos antes** | alto |
| Aparelho principal | celular físico, sempre ligado | **cloud phone (Android virtual)**, desligado logo após o vínculo | alto |
| Primeira atividade da conta | conversa normal | **duas ligações de voz em 8 s, 10 min após o cadastro** | alto |
| IP no 1º login do aparelho vinculado | VPS, 11 s depois PC | VPS, 11 s depois PC | médio |
| Digitação no cadastro | humana | texto injetado (`set_text`/`send_keys`) | baixo/médio |
| Fuso, GPS e modelo do aparelho | coerentes | padrões do GeeLark (só o idioma segue o IP) | desconhecido |
| UDP do phone | — | o SOCKS só leva TCP; o destino do UDP do phone não é conhecido | desconhecido |

O vazamento do IP da VPS no primeiro login também aconteceu com os números de
celular real (o pool sempre leva a linha do waxum main para o PC), e eles não
caíram. Então ele **sozinho** não explica o bloqueio. O que separa os dois casos
é a combinação conta nova + aparelho virtual + ligação imediata, que o próprio
plano do cadastro já apontava como risco alto
(`docs/plano-cadastro-whatsapp-geelark.md`: "números novos + gateway não oficial
+ cloud phone = risco alto. Aquecer antes de discar").

O WhatsApp não informa o motivo do bloqueio; a tabela é uma estimativa a partir
das diferenças observadas.

## Desvios do que o plano do cadastro prometia

1. **"Use sempre o mesmo nó para o mesmo número"**: o código cria a linha e gera
   o código de vínculo no waxum main (IP da VPS) e só depois move para o PC
   (`NumbersService.create` fixa `MAIN_WAXUM_NODE`; o cadastro chama
   `moveLineToJobPc` após conectar). O mesmo vale para "Conectar" na página de
   Números.
2. **"Aquecer antes de discar"**: não existe no código. Uma linha recém-vinculada
   entra no discador assim que fica `connected`.
3. O IP do phone é conferido uma vez, antes de abrir o WhatsApp, e não de novo.

## Plano

### Feito nesta entrega

1. **O vínculo nasce no PC.** A linha é criada e o código de vínculo é gerado
   direto no `waxum-edge` do PC:
   - no cadastro do GeeLark, no PC escolhido para o job; se ele estiver offline
     na hora do vínculo, o vínculo é recusado em vez de cair para a VPS;
   - em Números (QR ou código), no PC online com menos linhas, pela mesma regra
     da distribuição automática; sem PC livre (ou com a distribuição desligada),
     a linha nasce na VPS como antes.
   Assim o WhatsApp vê só o IP do PC desde o primeiro login.
2. **Aquecimento de número novo.** Uma linha vinculada pelo cadastro do GeeLark
   fica fora do discador (automático e manual) por 72 horas, usando a mesma
   quarentena que já protege linhas com sinais de bloqueio. Nesse período, use o
   número como uma pessoa usaria (mensagens, status, contatos). O botão
   "Destravar" em Admin libera antes, se for preciso.

### Próximos passos (não feitos)

3. **Ligar o aparelho principal de tempos em tempos.** O cloud phone fica
   desligado depois do vínculo; aparelhos vinculados são deslogados se o
   principal ficar ~14 dias offline. Um job semanal que liga o phone por alguns
   minutos resolve.
4. **Conferir o UDP do phone.** O proxy só leva TCP. Testar se o phone manda UDP
   (STUN, QUIC, DNS) pela rede do GeeLark; se mandar, bloquear UDP no phone ou
   implementar `UDP ASSOCIATE` no socks-edge.
5. **Coerência do aparelho.** Alinhar fuso horário e localização do phone com o
   PC (a API do GeeLark e as opções disponíveis precisam ser conferidas).
6. **Digitação mais humana** no cadastro: teclar caractere a caractere em vez de
   injetar o texto.
