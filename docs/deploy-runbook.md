# Runbook de deploy e recuperação

## Como o deploy automático funciona hoje

Todo push em `main` dispara `.github/workflows/deploy.yml`:

1. **`validate`**: `npm ci` → `typecheck` → `test -- --runInBand` → `build`. Qualquer falha aqui impede o deploy.
2. **`deploy`**: envia o repositório para `/opt/zapliga` no servidor via SSH e roda o script remoto, que:
   - sobe `postgres`, `postgres-backup`, `redis`, `nats`, `waxum` (infraestrutura compartilhada);
   - só prossegue quando o Waxum confirma simultaneamente `/livez` e uma conexão Rust ativa no NATS; o container aguarda o NATS antes do boot e seu healthcheck encerra o processo após três falhas consecutivas dessa integração, permitindo que a política de restart o reconecte;
   - builda as imagens de `api-a`, `api-b` e `web`;
   - **antes de buildar**, marca a imagem atualmente rodando de cada instância com a tag `:rollback` (é o alvo do rollback automático abaixo);
   - sobe **`api-a` sozinho**, espera `http://127.0.0.1:3000/health` responder (até 60s); só então sobe **`api-b`** e espera `:3001/health`;
   - se uma instância ficar saudável, sua imagem também recebe a tag do commit (`:<sha curto>`) — histórico dos últimos 5 builds fica disponível para rollback manual;
   - sobe `web` e recarrega o nginx do ICP com `infra/nginx/api.zapliga.com.conf`.

O nginx já roteia por `ip_hash` com `max_fails=3 fail_timeout=10s` (`infra/nginx/api.zapliga.com.conf`), então enquanto uma instância está sendo trocada a outra continua atendendo — o deploy nunca derruba as duas ao mesmo tempo de propósito.

## Rollback automático (já embutido no deploy)

Se `api-a` não ficar saudável em até 60s:
- o script reverte **só `api-a`** para a imagem `:rollback` (a que estava rodando antes desse deploy) e recria o container a partir dela;
- **`api-b` nunca chega a receber a imagem quebrada** — o job falha ali, antes de tocar em `api-b`.

Se `api-a` passou mas `api-b` não fica saudável, o mesmo acontece só com `api-b`: ele volta pra imagem anterior, `api-a` fica na versão nova. O job termina com falha (fica visível no GitHub Actions) — é esperado que as duas instâncias fiquem temporariamente em versões diferentes até o problema ser corrigido e um novo deploy rodar.

**Limite conhecido:** no primeiro deploy de sempre (ou depois de limpar as imagens do host manualmente) não existe tag `:rollback` ainda — se esse deploy falhar, não há para onde reverter automaticamente; é preciso corrigir o código e rodar de novo.

## Rollback manual

Se o automático não for suficiente (ex.: o problema só aparece depois que o tráfego real chega, passando do healthcheck), no servidor:

```bash
cd /opt/zapliga

# ver as tags disponíveis (rollback = a versão anterior a este deploy; <sha> = builds anteriores, até 5)
docker images "zapliga-api-a"
docker images "zapliga-api-b"

# reverter uma instância para uma tag específica
docker tag zapliga-api-a:<sha-ou-rollback> zapliga-api-a:latest
docker compose up -d --no-deps --no-build api-a

# repita para api-b se necessário
docker tag zapliga-api-b:<sha-ou-rollback> zapliga-api-b:latest
docker compose up -d --no-deps --no-build api-b

# confirme
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3001/health
```

Isso reverte só o código da API. Se o deploy problemático também trouxe uma migration nova, reverter a imagem sozinho não desfaz o schema — veja a seção seguinte.

## Recuperação de uma migration ruim

As migrations (`apps/api/src/database/migrations/*.sql`) são **só de ida** — não existe `down.sql`, e não vamos criar um sistema de reversão retroativo para elas (é um projeto grande e desproporcional ao problema; a rota real de recuperação é o backup).

`DatabaseService.migrate()` roda automaticamente no boot de cada instância da API (`api-a`/`api-b`), aplica os arquivos `.sql` ainda não aplicados em ordem alfabética, cada um na sua própria transação, e registra o progresso em `schema_migrations`. Uma migration que falha faz a API não subir (o healthcheck falha, e o rollback automático acima entra em ação — mas isso só reverte a **imagem**, não o banco).

Se uma migration chegou a rodar e corrompeu dados ou schema:

1. **Pare as duas instâncias da API** para não deixar nada mais escrever no banco:
   ```bash
   docker compose stop api-a api-b
   ```
2. **Localize o dump anterior à migration ruim** no volume `postgres_backups` (serviço `postgres-backup`, retenção diária 7 dias / semanal 4 semanas / mensal 6 meses):
   ```bash
   docker run --rm -v zapliga_postgres_backups:/backups alpine ls -la /backups/postgres/daily
   ```
3. **Restaure o dump** num Postgres — idealmente teste primeiro num Postgres descartável (`docker run --rm -d -e POSTGRES_USER=zapcall -e POSTGRES_PASSWORD=zapcall -e POSTGRES_DB=zapcall -p 55432:5432 postgres:16-alpine`) antes de aplicar no volume real, para confirmar que o dump restaura limpo. Para restaurar no volume real:
   ```bash
   docker compose exec -T postgres pg_restore -U zapcall -d zapcall --clean --if-exists < /caminho/do/dump.sql.gz
   ```
   (ajuste o comando conforme o formato do dump gerado pelo `postgres-backup-local` — plain SQL ou custom format).
4. **Confira `schema_migrations`** para ver em que ponto o banco ficou:
   ```sql
   SELECT * FROM schema_migrations ORDER BY version DESC LIMIT 5;
   ```
5. **Remova ou corrija o arquivo de migration problemático** no repositório (ele nunca deve ser editado depois de já ter rodado em produção com sucesso — só faz sentido remover/corrigir aqui porque acabamos de reverter o banco para antes dele ter rodado).
6. Redeploy normal (`git push` em `main`, ou `workflow_dispatch`).

## Diagnóstico manual

```bash
ssh <usuario>@<host>
cd /opt/zapliga
docker compose ps
docker compose logs --tail=100 api-a api-b
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3001/health
npm --workspace apps/api run db:migrate:status
```

Para validar especificamente a proteção de áudio e sinalização:

```bash
docker compose ps nats waxum
docker compose logs --tail=100 waxum | grep -E 'NATS|Waxum pronto'
curl -fsS http://127.0.0.1:8222/connz | grep -Eq '"lang"[[:space:]]*:[[:space:]]*"rust"'
```

O Waxum só fica `healthy` depois de registrar sua conexão no NATS. Se essa
conexão falhar três vezes consecutivas durante a execução, o healthcheck encerra
o processo e a política `restart: unless-stopped` recria o serviço. Além disso, a
jornada E2E 8 omite propositalmente o evento `Accept`, envia PCM não silencioso
e exige que esse áudio chegue ao WebSocket do SDR; remover o fallback volta a
bloquear o CI antes do deploy.

## Imagem do Waxum

O servico `waxum` roda uma imagem **construida localmente** (`zapliga-waxum:<tag>`),
nao a `fdciabdul/waxum` publicada: ela carrega correcoes no `whatsapp-rust`
vendorizado que a imagem stock nao tem (ver comentario no `docker-compose.yml`).
A tag em uso e definida **somente** em `docker-compose.yml`, e a imagem precisa
existir no host antes do deploy (`docker save` na maquina de build →
`docker load` na VPS; o compose usa a imagem local e nao tenta pull).

Para trocar a versao do Waxum:

1. Buildar a imagem fora da VPS e carregar com `docker load`.
2. `docker tag <imagem atual> zapliga-waxum:0.12.6-rollback` para ter retorno rapido.
3. Alterar `image:` do `waxum` no `docker-compose.yml`, commitar e fazer deploy
   (ou `docker compose up -d --no-deps --no-build waxum` para uma troca manual —
   e commitar em seguida, senao o proximo push reverte).
4. Validar com uma chamada real olhando o "Diagnostico de reproducao" no log do
   discador: `cliente→servidor pico` precisa ser > 0.

**Nao criar `*.override.yml` no host para pinar a imagem.** Em 2026-09-04 um
`waxum-encfix.override.yml` remanescente do hotfix anterior fez o deploy
automatico recriar o Waxum com a imagem antiga por cima da correcao ja validada;
o `deploy.yml` agora falha explicitamente se esse arquivo existir.

## Regra operacional: nao compilar em producao

Builds pesados (especialmente Rust/Waxum) devem rodar no GitHub Actions ou em
uma maquina de build separada. A VPS de producao recebe apenas a imagem pronta
(`docker load`/pull) e faz a troca controlada do container.

Em 2026-09-02, um `cargo build --release` executado dentro da VPS causou
pressao de memoria, carga acima de 25 em 4 CPUs, timeouts de healthcheck e
indisponibilidade de SSH/HTTP. Nao repetir esse procedimento; se for
necessario gerar uma imagem customizada, compile fora da VPS e preserve o
volume de dados ao atualizar o servico.
