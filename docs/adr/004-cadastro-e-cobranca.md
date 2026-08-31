# ADR 004 — Cadastro público e cobrança

Status: padrão operacional seguro, aguardando ratificação comercial. Responsável: CEO/Produto.

Produção inicia com `PUBLIC_REGISTRATION_ENABLED=false`; criação de empresas é assistida. A habilitação pública só ocorre após Gate B aprovado. O modelo inicial de cobrança é assistido/manual: Comercial registra contrato, super admin altera limites/status, Financeiro confere pagamento e Suporte mantém a trilha de auditoria. Portanto, checkout e assinatura self-service (Fase 8) não bloqueiam o lançamento atual. Se a direção escolher venda self-service, a Fase 8 torna-se obrigatória antes do Gate C.
