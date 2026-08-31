# ADR 003 — Propriedade e expiração de callbacks

Status: aceito para lançamento. Responsável: Operações.

Um retorno pertence ao mesmo SDR por padrão e não volta à fila geral. Ao vencer, permanece visível como `due`; ausência do SDR não transfere propriedade. Líder pode reatribuir ou liberar. Nova chamada concluída encerra o callback de modo idempotente. Agenda e supressão continuam obrigatórias. A flag `callbacks` permite retirar a interface/rotas durante incidente sem apagar dados.
