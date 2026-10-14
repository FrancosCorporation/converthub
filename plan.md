# Plan — converthub

## 1. Visão geral

- **Nome:** converthub — conversor self-hosted de mídia
- **Descrição:** serviço Node 22+ (ESM) de conversão de imagem/vídeo com validação de upload por magic bytes, fila SQLite transacional com reserva atômica de jobs, pool de workers e expiração/limpeza automática de artefatos.
- **Problema que resolve:** conversão de arquivos self-hosted com superfície de upload endurecida (tamanho, tipo real, rate limit, teto de disco) e sem vazamento de caminhos internos.
- **Estado atual:** todos os itens do `MELHORIAS.md` (SEC-01..05, BUG-01..05, IMP-01, DEVOPS-01/02, DOC-01) concluídos em 2026-10-11; CI modernizada nesta sessão.

## 2. Arquitetura e tecnologias

- Node ≥ 22.5, ESM; dependências: express 4, helmet 8, sharp 0.35 (faixa corrigida de vulnerabilidade).
- Fila/jobs em SQLite local (`converthub.db`, fora do índice); workers com reserva em transação; saídas em `os.tmpdir()` com escopo ConvertHub.
- Docker + Compose (loopback, volume persistente, sem montar `/tmp` do host).
- CI: testes (3 suítes) + scan de licenças; **modernizada nesta sessão**.

## 3. Funcionalidades existentes

- [x] Upload com teto 50 MiB + magic bytes + rate limit/COTA de disco (SEC-02/04).
- [x] Fila transacional com workers sem sobreposição (BUG-04) e pool dedicado.
- [x] Downloads sem path traversal; listagem sanitizada (BUG-01/IMP-01).
- [x] Expiração (1h) e limpeza de órfãos (24h) (BUG-05).
- [x] Frontend sem `innerHTML`, Helmet + CSP (SEC-05).
- [x] CI com testes e licenças — **modernizada nesta sessão** (Ubuntu 24.04, Actions v7, Node 22/24, `npm ci`, gate de audit).

## 4. Objetivos futuros

- **OBJ-01 (P2, concluído nesta sessão):** CI previsível com gates.
- **OBJ-02 (P3, recomendação):** métricas de fila (endpoint `/health` com profundidade/idade do job mais antigo) para observabilidade mínima.
- **OBJ-03 (P3, recomendação):** suporte adicional de formatos somente após revisão da cadeia ffmpeg/sharp em ambiente de teste.

## 5. Melhorias técnicas

- **Infraestrutura:** ✅ CI fixa e com audit gate.
- **Qualidade:** suíte existente (3 arquivos) é o contrato de segurança do serviço — manter obrigatória na CI.

## 6. Roadmap

- **Fase 1–3:** concluídas. **Fase 4:** OBJ-02/OBJ-03 conforme necessidade real de operação.

## 7. Backlog priorizado

1. OBJ-02 — health/métricas de fila (P3).
2. OBJ-03 — formatos adicionais com revisão de segurança (P3).

## 8. Riscos e pendências

- FFmpeg/sharp são superfícies de parser de mídia: manter imagens base atualizadas e uploads restritos.
- Ledger histórico registra TEST-01 (validação E2E real de conversão) como pendente; CI executa a suíte, mas uma conversão real ponta-a-ponta em produção segue não verificada.

## 9. Ideias adicionais

- Compose com limites de recurso (`mem_limit`/`cpus`) documentados para self-hosting seguro.

---
*(Gerado em 2026-10-14 pelo agente orquestrador)*
