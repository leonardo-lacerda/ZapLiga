# Instruções obrigatórias de operação

Antes de executar qualquer build, deploy, restart ou alteração em produção, leia completamente [`docs/deploy-runbook.md`](docs/deploy-runbook.md).

Respeite especialmente a regra de nunca compilar Rust/Waxum diretamente na VPS de produção. Builds pesados devem ocorrer no GitHub Actions ou em uma máquina separada; a VPS deve receber somente a imagem pronta e fazer uma troca controlada.

Todo commit precisa das seções `O que foi feito:`, `Melhorias:` e `Ganhos esperados:`, cada uma com pelo menos uma linha, explicando o que foi feito, o que melhorou e o ganho esperado. O hook `.githooks/commit-msg` recusa a mensagem sem elas; veja a seção "Commits" do [`README.md`](README.md).
