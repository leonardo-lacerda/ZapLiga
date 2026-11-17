# Extensão ZapLiga (Chrome / Edge)

Uma janelinha do ZapLiga que fica no canto de qualquer site. Por ela você entra na sua conta, digita um número, liga, fica no mudo, desliga e registra o resultado — sem abrir o painel do ZapLiga.

## Instalar (manual, sem a loja do Chrome)

1. Descompacte o arquivo `zapliga-extension-<versão>.zip` numa pasta que você não vá apagar.
2. No Chrome, abra `chrome://extensions` (no Edge, `edge://extensions`).
3. Ligue o **Modo do desenvolvedor** (canto superior direito).
4. Clique em **Carregar sem compactação** e escolha a pasta do passo 1.
5. Uma aba vai pedir o **microfone**: clique em *Permitir microfone* e depois em *Permitir* no aviso do navegador. Isso é feito uma vez só.
6. Fixe o ícone azul do ZapLiga na barra (ícone de quebra-cabeça → alfinete).

Para atualizar: troque os arquivos da pasta pela versão nova e clique no botão de recarregar da extensão em `chrome://extensions`.

## Usar

- **Login**: se você já está logado em zapliga.com, a extensão já entra sozinha. Senão, entre com o mesmo e-mail e senha do site. Sair na extensão também sai do site (é a mesma sessão).
- **Janela**: arraste pela barra azul para mudar de lugar; puxe os cantos de baixo para mudar o tamanho; **–** recolhe numa bolinha (verde e com o tempo da ligação enquanto você está falando); **×** esconde. O ícone da extensão mostra/esconde a janela. Lugar e tamanho ficam salvos.
- **Fixar na tela** (alfinete na barra azul): o ZapLiga vira uma janelinha que fica por cima de tudo, até de outros programas, e não some quando você clica fora. Você arrasta e muda o tamanho dela como qualquer janela. Ela fica aberta enquanto a aba de onde você fixou estiver aberta; ao fechar a janelinha, o ZapLiga volta para o canto da página.
- **Escolher o número**: líderes e admins escolhem em "Ligar pelo número" qual linha de WhatsApp conectada vai fazer a ligação (ou deixam no automático). A escolha fica salva. Para SDRs a linha é sempre automática.
- **Ligar**: digite DDD + número (o +55 é colocado sozinho) e clique em **Ligar**. Durante a ligação: **Mudo** e **Desligar**. "Ouvindo o cliente" acende quando chega áudio do outro lado.
- **Depois da ligação**: escolha como terminou e salve (as mesmas regras do site). A próxima ligação só sai depois disso.
- **Microfone e fone**: engrenagem ⚙ no topo.
- A ligação continua se você trocar de aba, navegar ou recolher a janela. Em páginas internas do navegador (nova aba, `chrome://`), o ícone abre a janela numa janelinha separada.
- Só uma estação por pessoa: se você conectar a estação no site, a extensão mostra "Estação aberta em outro lugar" e o botão **Usar aqui** traz de volta.

## Para desenvolvedores

Código em `apps/extension` (Manifest V3, React). Reaproveita do site o cliente da API (`apps/web/src/services/api.ts`), o áudio (`apps/web/src/audio/AudioBridge.ts`) e as opções do pós-atendimento (`apps/web/src/shared/format.ts`). A ligação roda num *offscreen document* (`src/offscreen/station.ts`), que fala o mesmo protocolo da estação do site; a janela (`src/panel`) é só o controle remoto, injetada nas páginas por `src/content.ts`.

```bash
npm --prefix apps/extension run build            # produção (api.zapliga.com) → apps/extension/dist
npm --prefix apps/extension run zip              # gera apps/extension/zapliga-extension-<versão>.zip
ZAPLIGA_API_URL=http://127.0.0.1:3000 npm --prefix apps/extension run build   # contra uma API local
```

A escolha da linha usa o campo `numberId` em `POST /api/calls/manual` (precisa da API com essa mudança). Fora isso, a extensão usa `host_permissions` para api.zapliga.com (por isso o CORS do `WEB_ORIGIN` não se aplica) e o mesmo cookie de sessão do site.
