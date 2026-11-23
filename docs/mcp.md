# MCP do ZapLiga

O Claude Code opera os telefones do GeeLark, os cadastros de WhatsApp e as linhas do ZapLiga
por MCP, em nome de quem criou a chave. Plano e decisões: [plano-mcp-zapliga.md](plano-mcp-zapliga.md).

## Conectar

1. Em **Números → Cadastrar número → Chave para o Claude (MCP)**, crie uma chave (líder ou super
   admin, com o recurso de cadastro ligado). Ela aparece **uma vez**, com o comando pronto.
2. No terminal:

   ```
   claude mcp add --transport http zapliga https://<api>/api/mcp --header "Authorization: Bearer zpl_mcp_..."
   ```

3. Numa conversa do Claude Code: "liste os telefones do ZapLiga".

Claude Desktop e claude.ai exigem login OAuth para conectores remotos: ainda não suportado.
Revogar a chave no mesmo painel corta o acesso na hora.

## Como funciona

- `POST /api/mcp`, transporte Streamable HTTP **sem estado**: cada requisição monta o servidor
  com as ferramentas que a chave permite e fecha no fim. Funciona igual em api-a e api-b.
- A chave decide empresa, usuário e ferramentas (`McpKeyGuard`); a empresa precisa do recurso
  `whatsapp_provisioning`. Limite: `MCP_RATE_LIMIT_PER_MINUTE` (padrão 240).
- As ferramentas chamam os mesmos serviços dos botões da tela (`WhatsappProvisioningService`,
  `NumbersService`): as mesmas regras, travas e auditoria. Cada operação grava também
  `mcp.<ferramenta>` na auditoria, com a chave usada.
- Erros voltam como erro da ferramenta, com a mensagem em português que a tela mostraria.

## Escopos

| Escopo | Ferramentas |
|---|---|
| `mcp:read` | `list_phones`, `list_pcs`, `list_registrations`, `registration_status`, `screen_elements`, `view_screen`, `provisioning_stats`, `list_numbers`, `number_details` |
| `mcp:operate` | `open_phone`, `stop_phone`, `rename_phone`, `tap`, `type_text`, `press_key`, `end_session`, `start_registration`, `send_sms_code`, `request_code`, `send_profile`, `take_over`, `resume_robot`, `link_to_zapliga`, `cancel_registration`, `reconnect_number` |
| `mcp:destructive` | `new_device_phone`, `delete_phone` (exigem `confirm_name` igual ao nome do telefone) |

Chave nova: `mcp:read` + `mcp:operate`; `mcp:destructive` só marcando no painel.

## Travas

- **Custo:** `list_phones` mostra o custo por hora de quem está ligado. A sessão de `open_phone`
  encerra sozinha com 10 min sem toque ou 30 min no total, e o telefone desliga.
- **Toques bloqueados:** `tap` recusa elementos como "Reenviar SMS", "Me ligue", "Número errado",
  "Excluir", "Sair" (pelo número do elemento ou pela coordenada).
- **Código SMS:** o Claude só envia o código que o usuário passar na conversa; nunca vai para
  log nem auditoria.
- **Texto da tela é dado:** as instruções do servidor e as descrições das ferramentas dizem ao
  Claude que o texto do aplicativo não é instrução.
- **Aprovação:** o Claude Code pede aprovação a cada ferramenta, salvo as que você liberar.

## Tela

- `screen_elements`: lista de elementos (`n`, texto, id, clicável, posição, `blocked`) do worker
  (`GET /jobs/{id}/elements`). Preferido para tocar: `tap` com `element: n`.
- `view_screen`: print em JPEG de 540 px de largura (`GET /jobs/{id}/screen?format=jpeg&w=540`).
- Mexer na tela só com o robô parado: sessão de `open_phone`, cadastro esperando alguém ou
  depois de `take_over`.

## Testes

- `apps/api/src/modules/mcp/mcp.spec.ts`: cliente MCP oficial do SDK por HTTP contra o servidor,
  com os serviços simulados (escopos, custo, toques bloqueados, imagem, erros, chaves).
- E2E jornada 15: cria a chave pela API, `initialize`, `tools/list`, `tools/call list_numbers`
  no Postgres real, chave inválida e revogada recusadas.
