# Plano 03 — Central de comando e recomendações

## Resultado desejado

Transformar a visão geral do líder em uma central que prioriza o que exige atenção,
explica a evidência e permite agir sem navegar por várias telas.

## Base existente

`OrganizerOverview` já possui “Próxima decisão” e “Atenção necessária”. A área de
métricas já calcula alertas determinísticos com evidência e ação recomendada. Este
plano consolida esses dois caminhos em um domínio único de recomendações.

## Princípios de experiência

- Mostrar no máximo três prioridades principais.
- Separar bloqueio crítico, oportunidade e informação.
- Toda recomendação informa evidência, confiança, impacto esperado e validade.
- Uma ação destrutiva ou ampla sempre exige confirmação.
- O usuário pode dispensar, adiar ou marcar como resolvida.
- O painel não afirma causalidade quando só há correlação.

## Tipos de recomendação do MVP

### Operação bloqueada

- fila pronta sem SDR disponível;
- nenhuma linha apta;
- campanha sem leads elegíveis;
- discador pausado dentro da agenda;
- callbacks vencidos;
- pós-atendimento travado.

### Risco

- concentração de falhas em uma linha;
- ritmo próximo do limite;
- linha em quarentena;
- aumento de quedas rápidas;
- falha recorrente de integração;
- configuração incompatível com a campanha.

### Oportunidade

- campanha abaixo da meta com capacidade ociosa;
- faixa horária historicamente mais eficiente se aproximando;
- pasta com leads recentes sem prioridade;
- campanha que pode reutilizar um playbook bem-sucedido.

## Modelo de dados

### Migration proposta: `044_operation_recommendations.sql`

Criar `operation_recommendations`:

- `id`, `tenant_id`, `campaign_id` opcional;
- `code`, `severity`, `status`;
- `title_key`, `evidence` estruturada, `recommended_action`;
- `action_type`, `action_payload` validado;
- `confidence`, `impact_scope` e `expires_at`;
- `rule_version`, timestamps de criação, atualização e resolução.

Criar `recommendation_events`:

- exibida, aberta, dispensada, adiada, aplicada, falhou ou resolvida;
- ator, timestamp, versão e metadados mínimos.

Recomendações efêmeras podem ser calculadas em tempo real; recomendações sobre as
quais o usuário agiu devem ser persistidas.

## Motor de recomendações

Criar `apps/api/src/modules/recommendations/` com um catálogo de regras puras.

Cada regra recebe um snapshot normalizado e retorna zero ou uma recomendação. O
agregador deve:

1. deduplicar pelo código e escopo;
2. ordenar por severidade, urgência e impacto;
3. limitar itens semelhantes;
4. invalidar recomendações cuja evidência deixou de existir;
5. impedir ações que violem segurança, permissões ou compliance.

O catálogo atual de `metrics-alerts.ts` deve ser migrado gradualmente, mantendo
compatibilidade durante a transição.

## API

```text
GET   /api/tenants/:tenantId/recommendations
GET   /api/tenants/:tenantId/recommendations/:id
POST  /api/tenants/:tenantId/recommendations/:id/dismiss
POST  /api/tenants/:tenantId/recommendations/:id/snooze
POST  /api/tenants/:tenantId/recommendations/:id/apply
GET   /api/tenants/:tenantId/recommendations/history
```

`apply` aceita somente ações catalogadas. Exemplos iniciais:

- abrir uma área com filtro pré-aplicado;
- pausar campanha;
- iniciar discador quando todos os pré-requisitos estiverem válidos;
- reatribuir callbacks selecionados;
- desabilitar temporariamente uma linha de uma campanha.

Não aceitar endpoint genérico que execute método ou payload arbitrário.

## Frontend

- Substituir a lógica local de `AttentionSection` pelo contrato da API.
- Card principal com “o que fazer agora”.
- Evidência expansível com valores e horário de atualização.
- CTA direto, `Ver detalhes`, `Lembrar depois` e `Dispensar`.
- Histórico de decisões em Métricas ou Configurações.
- Atualização por WebSocket usando invalidação, não payload completo sensível.
- Estado vazio deve mostrar por que a operação está saudável.

## Fases

### Fase 1 — catálogo e contrato

- Padronizar códigos, severidade, evidência e ação.
- Cobrir os alertas já existentes sem mudança de comportamento.

### Fase 2 — central unificada

- Nova API e consumo na visão geral.
- Telemetria de impressão, abertura e dispensa.

### Fase 3 — ações seguras

- Implementar CTAs catalogados e idempotentes.
- Registrar antes/depois e falhas.

### Fase 4 — oportunidades

- Consumir campanhas, motor de decisão e saúde da operação.
- Adicionar impacto estimado com metodologia visível.

## Critérios de aceite

- [ ] A visão geral mostra no máximo três prioridades ordenadas.
- [ ] Cada item possui evidência verificável e horário de atualização.
- [ ] Recomendações deixam de aparecer quando a condição é resolvida.
- [ ] Aplicar uma ação duas vezes não duplica efeitos.
- [ ] Ações respeitam papel, tenant, feature flags e proteções do discador.
- [ ] Hipóteses e correlações são rotuladas como tais.
- [ ] Existe histórico auditável de interação e resultado.
- [ ] Testes cobrem deduplicação, expiração, permissão e estado obsoleto.

## Métricas

- recomendações exibidas, abertas, aplicadas e dispensadas;
- tempo entre alerta crítico e resolução;
- percentual de recomendações expiradas sem ação;
- taxa de sucesso por tipo de ação;
- recorrência do mesmo problema;
- impacto observado após ação, sem apresentá-lo automaticamente como causal.

## Riscos

- Excesso de alertas reduz confiança: aplicar ranking, deduplicação e cooldown.
- Recomendações obsoletas podem causar dano: revalidar estado no momento da ação.
- A interface pode parecer autoritária: permitir inspeção, adiamento e reversão.
