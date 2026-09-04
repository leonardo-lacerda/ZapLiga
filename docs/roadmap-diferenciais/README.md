# Roadmap de vantagens defensáveis do ZapLiga

## Objetivo

Transformar o ZapLiga de um discador automático via WhatsApp em um sistema
operacional de receita que decide, executa, protege e aprende com cada operação.

Este diretório separa a estratégia em planos implementáveis. Cada plano contém
escopo, arquitetura, fases, critérios de aceite, métricas e riscos. Os documentos
não autorizam deploy automático nem alteração direta em produção.

## Tese de produto

> O ZapLiga escolhe quem ligar, quando ligar, por qual linha e para qual SDR;
> protege a operação durante a execução e mostra qual decisão gerou resultado.

A vantagem não depende de uma funcionalidade isolada. Ela surge da combinação de:

1. workflows incorporados à rotina do cliente;
2. decisões operacionais explicáveis;
3. confiança e proteção das linhas;
4. dados históricos difíceis de reconstruir;
5. uma experiência que converte sinais em ações.

## Planos

| Ordem | Documento | Resultado principal |
| ---: | --- | --- |
| Execução | [Plano mestre de implementação](07-plano-mestre-execucao.md) | Organiza os seis planos em lotes executáveis, gates de qualidade e um acompanhamento persistente. |
| 1 | [Campanhas, playbooks e integrações](01-campanhas-playbooks-integracoes.md) | A operação passa a ser configurada e acompanhada como campanha, não como conjunto de telas soltas. |
| 2 | [Motor de decisão e fila inteligente](02-motor-decisao-fila-inteligente.md) | Cada lead recebe prioridade explicável e o discador usa a melhor decisão disponível. |
| 3 | [Central de comando e recomendações](03-central-comando-recomendacoes.md) | O líder recebe bloqueios, oportunidades e ações priorizadas em tempo real. |
| 4 | [Saúde da operação e camada de confiança](04-saude-operacao-confianca.md) | Linhas, fila, SDRs e compliance ganham diagnóstico e score operacional auditável. |
| 5 | [Dados, aprendizado e benchmarks](05-dados-aprendizado-benchmarks.md) | O produto aprende com resultados sem expor dados pessoais ou prometer causalidade falsa. |
| 6 | [Posicionamento, marca e prova](06-posicionamento-marca-prova.md) | A vantagem técnica se torna compreensível e demonstrável em poucos minutos. |

## Dependências

```text
Campanhas e playbooks
        |
        v
Motor de decisão ------> Central de comando
        |                       |
        v                       v
Saúde e confiança ------> Recomendações seguras
        |
        v
Dados e aprendizado ----> Benchmarks
        |
        v
Posicionamento e prova pública
```

Campanhas criam o contexto necessário para comparar resultados. O motor de decisão
registra por que cada lead foi priorizado. A camada de saúde impede que otimização
comercial ultrapasse limites operacionais ou de compliance. Somente depois desse
ciclo estar instrumentado os benchmarks passam a ter base confiável.

## Princípios obrigatórios

- Começar com regras determinísticas e explicáveis; IA não é requisito do MVP.
- Nunca otimizar volume de chamadas acima de consentimento, agenda ou saúde da linha.
- Toda ação automática precisa registrar versão da regra, evidência e motivo.
- Recomendações devem distinguir fato, correlação e hipótese.
- Mudanças que alterem seleção de leads devem estrear em `shadow mode`.
- Novos módulos devem manter isolamento por `tenant_id`, auditoria e feature flag.
- Dados entre empresas só podem alimentar benchmarks agregados com opt-in e proteção
  contra identificação de uma empresa, pessoa ou telefone.
- Builds, deploys e alterações em produção seguem obrigatoriamente
  `docs/deploy-runbook.md`.

## Ordem de entrega recomendada

### Marco A — operação estruturada

- Campanhas e playbooks criados, versionados e conectados a pastas.
- Uma campanha pode ser iniciada, pausada e encerrada sem alterar configurações
  globais de outras campanhas.
- Leads recebidos por integração preservam campanha e origem.

### Marco B — decisão assistida

- Score determinístico roda em sombra e explica seus motivos.
- O líder compara a ordem atual com a ordem sugerida.
- Após validação, campanhas habilitadas podem usar a fila inteligente.

### Marco C — operação orientada por ação

- A central mostra no máximo três prioridades por vez.
- Ações simples podem ser executadas com confirmação e auditoria.
- Saúde da operação bloqueia sugestões incompatíveis com segurança ou compliance.

### Marco D — vantagem acumulativa

- Resultados retroalimentam recomendações por tenant.
- Experimentos possuem grupo, versão e critério de sucesso.
- Benchmarks agregados só aparecem quando o coorte atende os limites de privacidade.

### Marco E — prova comercial

- A landing usa a mesma linguagem do produto.
- Existe demonstração segura com dados sintéticos e estados realistas.
- As alegações de ganho são sustentadas por métricas reais e metodologia publicada.

## Critério global de conclusão

Este roadmap estará implementado quando uma empresa puder receber leads, iniciar uma
campanha, operar com priorização explicável, receber ações recomendadas, acompanhar a
saúde da operação e medir resultado por campanha; e quando nenhuma dessas decisões
depender de leitura manual de logs ou de conhecimento interno da equipe ZapLiga.

## Fora do escopo transversal

- CRM genérico substituindo ferramentas comerciais existentes;
- gravação ou transcrição sem base legal, consentimento e política de retenção;
- modelo de IA decidindo sozinho sem fallback determinístico;
- benchmark público baseado em poucos clientes;
- automação que remova bloqueios de segurança para aumentar volume.
