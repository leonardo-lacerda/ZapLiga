# Verificação de WhatsApp e linha só para verificação

## Para que serve

Quando o Franco manda um modelo pela API oficial e recebe o erro 131026, não dá para saber se o número não tem WhatsApp ou se a pessoa bloqueou a empresa. O Franco então pergunta ao ZapLiga, que consulta o número por uma linha de WhatsApp Web.

## Como usar

```
POST https://api.zapliga.com/api/v1/integrations/whatsapp-check
Authorization: Bearer zpl_crm_...
{ "phone": "+5531989739997" }
```

Resposta: `{ "phone": "5531989739997", "on_whatsapp": true, "jid": "...@s.whatsapp.net" }`

| Resposta | O que quer dizer |
|---|---|
| `200` com `on_whatsapp: true` | Tem WhatsApp |
| `200` com `on_whatsapp: false` | Não tem WhatsApp (verificado) |
| `422 invalid_phone` | Telefone inválido |
| `409 no_connected_number` | Nenhuma linha conectada |
| `409 verification_line_unavailable` | A linha de verificação está desconectada |
| `429 rate_limited` | Passou de 10 consultas por minuto |
| `502 check_failed` | Não deu para verificar agora. **Não** quer dizer "sem WhatsApp" |

## Chave só para verificação

Para usar a verificação fora do Franco (por exemplo, num formulário), gere uma chave que só serve para isso:

1. No ZapLiga, abra **Integrações → Ligações pelo Franco**.
2. Dê um nome (ex.: "Formulário") e, em **Permissões da chave**, escolha **"Só verificar se o telefone tem WhatsApp"**.
3. Clique em **Gerar chave** e copie na hora: ela aparece uma vez só.

Essa chave não faz ligações, não mexe em linhas nem em agentes e não recebe eventos. Mesmo assim, ela gasta o limite de consultas da empresa:
- guarde no servidor (variável de ambiente), nunca no navegador ou no código do formulário;
- se vazar, clique em **Revogar** no card dela e gere outra.

## Linha só para verificação

Você pode separar uma linha só para essas consultas, para não arriscar as linhas que fazem ligação.

**Como marcar:** no painel, vá em **Números** e marque **"Só para verificação de WhatsApp"** no card da linha. Para desfazer, desmarque.

Quando existe linha marcada:
- as consultas usam **só** as linhas marcadas;
- se todas estiverem desconectadas, a resposta é `409 verification_line_unavailable` (nunca usa as linhas de ligação no lugar);
- a linha marcada **não faz ligações**: sai do discador automático e manual, e o Franco recebe `409 line_verification_only` se tentar ligar por ela.

Sem nenhuma linha marcada, as consultas usam qualquer linha conectada, de preferência uma fora de ligação e fora de quarentena.

## Proteções

- **Cache de 24 h:** o mesmo número não é consultado de novo por um dia.
- **Limite:** 10 consultas por minuto por empresa. Respostas do cache não contam.
- Linhas de WhatsApp Web podem ser banidas se consultarem números em volume. Use a verificação só quando precisar, como no caso do erro 131026.

Detalhes técnicos estão em [integracao-franco.md](integracao-franco.md).
