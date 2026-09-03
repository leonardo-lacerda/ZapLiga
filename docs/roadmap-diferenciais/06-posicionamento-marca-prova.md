# Plano 06 — Posicionamento, marca e prova

## Resultado desejado

Fazer uma pessoa entender em poucos minutos que o ZapLiga é uma plataforma de
operação outbound, não apenas um discador, e conseguir verificar essa promessa com
uma demonstração segura e evidências reais.

## Decisão de identidade

O repositório está na pasta `ZapCall`, enquanto produto, interface e domínio usam
`ZapLiga`. Antes de ampliar aquisição, registrar uma decisão única:

- nome oficial;
- grafia e pronúncia;
- domínio principal;
- categoria de produto;
- promessa curta;
- política de menção ao WhatsApp e ao gateway utilizado.

Este plano assume provisoriamente `ZapLiga`, por ser o nome presente na aplicação.
A implementação só deve fazer uma troca ampla de marca após decisão explícita.

## Posicionamento proposto

Categoria:

> Sistema operacional para operações outbound por voz no WhatsApp.

Promessa:

> O ZapLiga decide, disca, protege e aprende para colocar SDRs em mais conversas
> produtivas.

Prova em três pilares:

1. mais tempo de conversa e menos espera;
2. operação visível e acionável em tempo real;
3. proteção e rastreabilidade incorporadas.

## Mudanças na landing

### Hero

- Comunicar categoria e resultado, não apenas “discagem automática”.
- Demonstrar o ciclo receber → priorizar → discar → conectar → aprender.
- Manter uma CTA principal de demonstração e uma secundária para demo interativa.
- Não exibir números de performance como fatos sem fonte ou indicação de simulação.

### Demonstração do produto

Criar uma experiência pública com dados sintéticos:

- campanha recebendo novos leads;
- fila mudando com motivos de prioridade;
- linha entrando em cooldown;
- chamada atendida e conectada a um SDR;
- recomendação surgindo e sendo resolvida;
- resultado atualizando a campanha.

A demo deve ser isolada da API de produção ou servida por fixtures estáticas. Nenhum
número real, QR Code, segredo ou chamada externa pode ser acessível.

### Prova comercial

- Estudos de caso com contexto, período, volume e definição das métricas.
- Antes/depois somente quando houver baseline comparável.
- Capturas reais anonimizadas ou ambiente demonstrativo identificado como simulação.
- Página de metodologia para taxa de atendimento, conversão e ganho de produtividade.
- Página de confiança explicando proteção de linhas, compliance e limitações.

## Mudanças dentro do produto

- Nomear campanhas, motor de decisão, central de comando e saúde de forma consistente.
- Usar os mesmos códigos e conceitos no painel, documentação e landing.
- Mostrar explicações curtas nos primeiros usos, não um tour longo obrigatório.
- Gerar um “resumo executivo da operação” compartilhável em PDF/CSV sem dados pessoais.
- Permitir que o cliente veja a primeira evidência de valor durante o onboarding:
  primeira campanha criada, primeiro lead recebido e primeira conversa atendida.

## Sistema de mensagens

| Situação | Mensagem principal |
| --- | --- |
| aquisição | Mais conversas produtivas por hora de SDR. |
| onboarding | Configure uma campanha e deixe a operação pronta. |
| operação | Veja o que está acontecendo e o que fazer agora. |
| decisão | Entenda por que cada lead foi priorizado. |
| confiança | Proteções operacionais fazem parte do produto. |
| resultado | Compare campanhas pelo que gerou avanço comercial. |

Evitar “IA revolucionária”, “zero bloqueio”, “garantia de conversão” ou qualquer
alegação incompatível com evidência e risco da integração.

## Implementação técnica

- Consolidar tokens e componentes visuais entre landing e aplicação sem obrigar os
  dois projetos a compartilhar runtime.
- Criar fixtures versionadas em `apps/landing/demo-data/`.
- Criar componentes da demo sem dependência de sessão autenticada.
- Adicionar eventos analíticos de funil: visualização, interação com demo, início de
  cadastro, campanha criada e primeira chamada atendida.
- Versionar textos principais para facilitar teste e rollback.
- Garantir acessibilidade, responsividade e `prefers-reduced-motion`.

## Fases

### Fase 1 — decisão e narrativa

- Fechar nome, categoria, promessa e pilares de prova.
- Mapear termos divergentes no código e documentos.

### Fase 2 — produto consistente

- Ajustar navegação e nomenclatura após os Planos 01 a 04.
- Criar onboarding orientado à primeira campanha e primeira conversa.

### Fase 3 — demo pública

- Implementar cenário sintético completo e identificá-lo como demonstração.
- Instrumentar interações.

### Fase 4 — evidência

- Publicar metodologia e estudos de caso autorizados.
- Substituir alegações simuladas por resultados verificáveis quando disponíveis.

## Critérios de aceite

- [ ] Nome e categoria são idênticos na aplicação, landing e documentação pública.
- [ ] O hero comunica público, problema, transformação e CTA sem depender de jargão.
- [ ] A demo apresenta o ciclo central em até poucos minutos de interação.
- [ ] Dados da demo são sintéticos e tecnicamente isolados.
- [ ] Toda alegação quantitativa pública possui fonte e metodologia.
- [ ] O onboarding conduz até a primeira campanha e mede abandono por etapa.
- [ ] Termos de risco e compliance são claros sem dominar a narrativa principal.
- [ ] Landing e aplicação passam por revisão responsiva e de acessibilidade.

## Métricas

- conversão de visita para demonstração ou cadastro;
- interação e conclusão da demo;
- tempo até primeira campanha;
- tempo até primeiro lead recebido;
- tempo até primeira conversa atendida;
- abandono por etapa do onboarding;
- percentual de visitantes que identificam corretamente a categoria em pesquisa.

## Riscos

- Promessa maior que a entrega atual: lançar narrativa em sincronia com feature flags.
- Troca de nome prematura: decidir antes de alterar código e domínio.
- Demo parecer dado real: rotular simulação e publicar metodologia.
- Design impressionar sem provar valor: ligar cada animação a um comportamento real.
