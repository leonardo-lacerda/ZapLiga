# Instruções obrigatórias de operação

Antes de executar qualquer build, deploy, restart ou alteração em produção, leia completamente [`docs/deploy-runbook.md`](docs/deploy-runbook.md).

Respeite especialmente a regra de nunca compilar Rust/Waxum diretamente na VPS de produção. Builds pesados devem ocorrer no GitHub Actions ou em uma máquina separada; a VPS deve receber somente a imagem pronta e fazer uma troca controlada.
