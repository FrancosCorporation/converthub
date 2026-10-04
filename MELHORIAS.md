# MELHORIAS — converthub

> **Gerado por análise de código em 2026-10-02** · Stack: Node 22 (Express + `node:sqlite` + `sharp` + `ffmpeg`)
> Branch `main` · 556 LOC · testes presentes · CI presente
>
> **Este arquivo é um plano de execução.** Cada item tem ID, `arquivo:linha`, mudança exata,
> critério de aceite e comando de verificação.

---

## 0. Como usar este documento

1. Execute na ordem **P0 → P1 → P2 → P3**, respeitando as ondas da §8.
2. Ao terminar um item: marque `- [x]`, rode o **Verificação**, comite `fix(<ID>): descrição`.
3. **Não "corrija" a validação por magic bytes.** `validarTipo` (`src/fila.js:29-51`) é o ponto
   correto do projeto (não confia em extensão) — é exatamente o que deve ser preservado.
4. **Idioma:** português; commits em inglês com `fix:`/`feat:`/`docs:`.

---

## 1. Diagnóstico executivo

Hub de conversão de arquivos: ingere upload (valida por magic bytes), enfileira job, worker converte
com `sharp` (imagem) ou `ffpeg` (áudio/vídeo) e expõe download do resultado + painel de métricas.

**O que está bem (não reaça):**

| Item | Evidência |
|---|---|
| Validação por **magic bytes**, não extensão | `fila.js:29-51` (PNG/JPEG/GIF/TIFF/WEBP/MP3/FLAC/OGG/MP4/…) |
| Teto de 50 MB no upload | `server.js:11,27` |
| `formato` (destino) **não** controla o binário executado — só o mapa interno | `fila.js:94` (`formatos[formato.toLowerCase()]`, allowlist) |
| `ffmpeg` recebe `spawn` com **array** de args (não string) — sem shell injection | `fila.js:118` (`spawn('ffmpeg', ['-y', ...args], ...)`) |
| CHECK constraints em `status`/`tipo` | `fila.js:12-13` |
| Download só de job `pronto` | `server.js:50` |
| Erro de download expirado → `410` explícito | `server.js:60` |
| Transação de estado do job (marcar processando → pronto/falhou) | `fila.js:64-72` |

**O que está quebrado:**

1. **`formato` do cliente entra no nome do arquivo de saída** (`fila.js:66`:
   `` `saida.${job.formato_destino}` ``). Com `?formato=../../algo`, o `join` com `tmpdir()` escapa
   do diretório de trabalho — **path traversal na escrita**. E o `formato` **não é validado** contra
   uma allowlist antes de virar nome de arquivo (`ingere`, linha 53-57, só checa se é não-vazio).
2. **Upload sem limite de taxa e arquivo de entrada sobrevive à validação**: se `validarTipo` falha,
   o arquivo **já foi escrito** em `uploads/` (`server.js:33`) e **não é removido** — cada upload
   inválido deixa lixo no disco (DoS de disco por repetição).
3. **Sem `helmet`, sem rate limit** no upload.

---

## 2. Tabela de prioridades

| ID | Título | Sev | Arquivo | Depende de |
|---|---|---|---|---|
| SEC-01 | `formato` do cliente entra no path de saída (path traversal) | **P0** | `src/fila.js:66` | — |
| SEC-02 | Upload inválido deixa arquivo órfão em `uploads/` (DoS de disco) | **P0** | `server.js:33-37` | — |
| SEC-03 | `formato` não validado contra allowlist no `ingere` | **P1** | `src/fila.js:53-57` | SEC-01 |
| SEC-04 | Upload sem rate limit | **P1** | `server.js:20` | — |
| SEC-05 | Sem `helmet`/headers de segurança | **P2** | `server.js:14` | — |
| BUG-01 | Download não escopa `saida` ao tmpdir (lê o que o banco disser) | **P1** | `server.js:51-53` | SEC-01 |
| BUG-02 | `formato` inválido só falha **depois** de enfileirar (job fica `falhou` com poluição) | **P2** | `fila.js:68,92` | SEC-03 |
| BUG-03 | `err.message` exposto ao cliente em 500 (`e.message.slice`) | **P2** | `server.js:41` | — |
| BUG-04 | Worker `processarUm` não é reentrante (2 calls/s além do status) | **P2** | `server.js:94-96` | — |
| BUG-05 | Arquivos de saída em `tmpdir` não têm TTL de limpeza | **P2** | `fila.js:64` | — |
| IMP-01 | Painel `/api/jobs` público expõe caminhos absolutos | **P1** | `server.js:65` · `fila.js:79` | SEC-05 |
| TEST-01 | Sem teste de path traversal no `formato` | **P1** | `test/` | SEC-01 |
| TEST-02 | Sem teste de upload inválido limpando disco | **P2** | novo `test/` | SEC-02 |
| DEVOPS-01 | `converthub.db` commitado no repo | **P1** | `converthub.db` | — |
| DEVOPS-02 | Sem `.env.example` | **P3** | *(ausente)* | — |
| DOC-01 | README não documenta requisitos (ffmpeg/sharp) | **P2** | `README.md` | — |

**Placar: 2 P0 · 6 P1 · 7 P2 · 1 P3 = 16 itens.**

---

## 3. Segurança
### SEC-01 · `formato` do cliente entra no path de saída (path traversal) · [P0]

- **Arquivo:** `src/fila.js:66`
- **Evidência:**
  ```javascript
  const destino = join(mkdtempSync(join(tmpdir(), 'ch-')), `saida.${job.formato_destino}`);
  ```
  `job.formato_destino` vem **cru** do cliente (`?formato=...`, `server.js:21,38` →
  `fila.ingere({formatoDestino: formato})`, linha 57) e só é validado como não-vazio (`ingere`,
  linha 54). Com `?formato=../../../../home/usuario/.bashrc`, o `join` normaliza `saida.../../..`
  e **sai do tmpdir**, gravando o arquivo convertido num caminho arbitrário controlado pelo cliente.
- **Impacto:** **escrita de arquivo arbitrária** (com o conteúdo da saída convertida) em qualquer
  caminho gravável pelo processo — desde `.bashrc` (execução no próximo login) até ficheiros de
  configuração. Combinado com `BUG-02` (o job só falha depois), o atacante controla o job inteiro.
  É o P0 mais grave do projeto.
- **Mudança:** (1) validar `formato` contra **allowlist** **antes** de enfileirar, no `ingere` ou no
  `server.js` (por tipo: imagem aceita o mapa de `fila.js:94`, áudio/vídeo o do `ffmpeg`); (2) usar
  um **nome interno** gerado pelo servidor, nunca o formato do cliente:
  ```javascript
  const destino = join(tmpDoJob, `saida.${extensaoValidada}`);   // extensao de allowlist, nao input
  ```
  (3) revalidar que o `join` resolvido está **dentro** do tmpdir do job (`startsWith`), como
  padrão defensivo.
- **Aceite:** `?formato=../../x` é rejeitado com `400` **antes** de criar job; nenhum arquivo fora do
  tmpdir é escrito.
- **Verificação:**
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -X POST 'http://localhost:3700/api/upload?formato=../../evil' \
    -F 'f=@/home/servidor/Git/repo-racer/index.html'
  # esperado 400 (formato invalido), nada escrito fora do tmpdir
  ls /tmp/ch-*/ 2>/dev/null | grep -c evil   # 0
  ```

### SEC-02 · Upload inválido deixa arquivo órfão em `uploads/` (DoS de disco) · [P0]

- **Arquivo:** `server.js:33-37`
- **Evidência:**
  ```javascript
  const entrada = join(ROOT, 'uploads', `up_...`);
  await writeFile(entrada, Buffer.concat(chunks));      // linha 33: escreve ANTES de validar
  const tipo = await fila.validarTipo(entrada);          // linha 34: valida DEPOIS
  if (!tipo) return res.status(400)...
  ```
  Se `validarTipo` retorna `null` (tipo desconhecido) ou o job falha, o arquivo em `uploads/` **nunca
  é removido** — não há `unlink` em nenhum caminho de erro.
- **Impacto:** cada upload de lixo (50 MB de bytes aleatórios, tipo não reconhecido) fica **para
  sempre** em `uploads/`. Repetir o pedido enche o disco — **DoS de disco**, e num servidor com
  container é queda do serviço inteiro. Não há limpeza nem TTL.
- **Mudança:** (1) validar o tipo **antes** de persistir (ler os primeiros bytes do buffer em
  memória — `validarTipo` pode aceitar `Buffer` em vez de caminho, evitando a escrita); (2) se
  precisar gravar antes, usar `try/finally` para apagar em qualquer falha; (3) rotina de limpeza
  (TTL) para `uploads/` e para `tmpdir` (ver `BUG-05`).
- **Aceite:** upload de tipo desconhecido **não** deixa arquivo; `uploads/` só cresce com entradas
  válidas.
- **Verificação:**
  ```bash
  ls uploads/ | wc -l                                   # antes
  head -c 5000000 /dev/urandom > /tmp/lixo.bin
  curl -s -X POST 'http://localhost:3700/api/upload?formato=webp' -F 'f=@/tmp/lixo.bin'   # 400
  ls uploads/ | wc -l                                   # igual ao "antes" (nenhum orfao)
  ```

### SEC-03 · `formato` não validado contra allowlist no `ingere` · [P1]

- **Arquivo:** `src/fila.js:53-57`
- **Evidência:** `if (!arquivo || !formatoDestino)` — valida só presença; o `formato` é gravado no
  banco (`INSERT ... formato_destino`, linha 57) sem passar pelo mapa de formatos válidos.
- **Impacto:** é a raiz do `SEC-01` e do `BUG-02`: qualquer string vira job, só falha na execução
  (minutos depois, no worker).
- **Mudança:** validar no `ingere` contra o conjunto de formatos suportados (unir o mapa de imagem
  `fila.js:94` e os de mídia); recusar com `400 dados`. Aí o `SEC-01` fica com uma segunda camada.
- **Aceite:** `ingere({formatoDestino: 'exe'})` lança erro de dados, não cria job.
- **Verificação:**
  ```bash
  node -e "import('./src/fila.js').then(m=>{const f=m.criarFila(':memory:');try{f.ingere({arquivo:'x',tipo:'imagem',formatoDestino:'../../y'});console.log('FALHA')}catch(e){console.log('OK:',e.codigo)}})"
  ```

### SEC-04 · Upload sem rate limit · [P1]

- **Arquivo:** `server.js:20`
- **Evidência:** rota de upload pública (por desenho) sem limite. Cada chamada escreve até 50 MB.
- **Impacto:** DoS de banda/disco (agravado pelo `SEC-02`): um laço sobe arquivos de 50 MB e enche o
  disco ou satura a banda. Sem auth, é trivial.
- **Mudança:** rate limit por IP (ex.: 20/hora) + teto agregado de disco em `uploads/` que rejeite
  acima de um limite (com `409`/`507`).
- **Aceite:** 21º upload na hora → `429`; disco cheio → erro claro, não crash.
- **Verificação:**
  ```bash
  for i in $(seq 1 25); do curl -s -o /dev/null -w "%{http_code} " -X POST \
    'http://localhost:3700/api/upload?formato=webp' -F 'f=@/tmp/pequeno.png'; done; echo
  ```

### BUG-01 · Download não escopa `saida` ao tmpdir (lê o que o banco disser) · [P1]

- **Arquivo:** `server.js:51-53`
- **Evidência:** `const saida = job.saida; const dados = await readFile(saida);` — o caminho vem
  **cru do banco**. Se um job malicioso gravou um `saida` apontando para fora (o `SEC-01` permitia),
  o `readFile` lê e **devolve qualquer arquivo** do sistema.
- **Impacto:** leitura arbitrária de arquivo (depois do `SEC-01` fechar, o risco fecha, mas a defesa
  em profundidade continua válida: se algum dia o `saida` for manipulado, a leitura não escapa).
- **Mudança:** escopar o `saida` ao diretório do job (`startsWith(tmpdir)`) antes do `readFile`;
  derivar o caminho do tmpdir pelo **id do job**, não pela coluna.
- **Aceite:** job com `saida` apontando para `/etc/passwd` → `404`/`410`, não o conteúdo.
- **Verificação:**
  ```bash
  # inserir job com saida='/etc/passwd' e tentar baixar -> deve recusar
  ```

### IMP-01 · Painel `/api/jobs` público expõe caminhos absolutos · [P1]

- **Arquivo:** `server.js:65` · `fila.js:79`
- **Evidência:** `listar()` devolve `SELECT id, arquivo_entrada, ..., saida, ...` — inclui os
  caminhos **absolutos** de entrada e saída, na rota pública.
- **Impacto:** vazamento da topologia do filesystem (caminhos do tmpdir, do projeto) e dos
  caminhos de arquivo de cada job — informação desnecessária para o painel e útil para Attacks de
  ASNI.
- **Mudança:** (1) aplicar `exigirToken` (ver `SEC-05`) ou, no mínimo, (2) devolver só
  `id/tipo/formato/status/progresso/criado_em` (sem caminhos); o painel não precisa do path.
- **Aceite:** a resposta de `/api/jobs` não contém `arquivo_entrada`/`saida`.
- **Verificação:**
  ```bash
  curl -s http://localhost:3700/api/jobs | jq '.[0] | has("saida")'   # false
  ```

### SEC-05 · Sem `helmet`/headers de segurança · [P2]

- **Arquivo:** `server.js:14` (só `express` + rotas; nenhum middleware de cabeçalho)
- **Evidência:** nenhum `helmet`, nenhum header manual de segurança. O serviço serve painel
  (HTML) e SVG/binary.
- **Impacto:** sem `X-Content-Type-Options: nosniff`, o download (`application/octet-stream`) pode
  ser interpretado pelo browser; sem `X-Frame-Options`, o painel pode ser *frameado* (clickjacking em
  ação de admin, quando `IMP-01` exigir token); sem HSTS. Custo baixo, fecha classe de ataque.
- **Mudança:** `npm i helmet` + `app.use(helmet())` logo após `const app = express()`;
  adicionar HSTS apenas fora de `localhost`.
- **Aceite:** toda resposta traz `x-content-type-options: nosniff` e `x-frame-options`.
- **Verificação:**
  ```bash
  curl -sI http://localhost:3700/ | grep -iE 'x-frame-options|x-content-type-options'
  ```

---

## 4. Bugs e defeitos funcionais

### BUG-02 · `formato` inválido só falha **depois** de enfileirar · [P2]

- **Arquivo:** `src/fila.js:68,92` · `server.js:38-39`
- **Evidência:** `ingere` aceita qualquer `formato` (ver `SEC-03`); o job é criado `pendente` e só
  no worker `converterImagem` (linha 94) cai em `throw` de formato não suportado, marcando
  `falhou`.
- **Impacto:** o cliente recebe `201` (sucesso) e só depois o job falha — confiança quebrada e
  poluição no banco com jobs impossíveis. Pior com o `SEC-01`: um job malicioso fica na fila.
- **Mudança:** validar no `ingere` (ver `SEC-03`); o cliente recebe `400` na hora.
- **Aceite:** `?formato=xyz` → `400` no upload, nenhum job criado.
- **Verificação:** `curl -X POST '...?formato=xyz'` → 400; `GET /api/jobs` sem o job novo.

### BUG-03 · `err.message` exposto ao cliente em 500 · [P2]

- **Arquivo:** `server.js:41` (`mensagem: e.message`)
- **Evidência:** o handler de upload devolve a mensagem de erro crua (que pode conter caminho
  absoluto, comando do binário, etc.).
- **Impacto:** vazamento de detalhe interno (paths, nomes de temp). Não é brecha crítica, mas é o
  padrão "não devolva stack ao cliente".
- **Mudança:** mensagem genérica ao cliente (`erro interno`); logar o detalhe no servidor.
- **Aceite:** erro interno não expõe path no corpo da resposta.
- **Verificação:**
  ```bash
  # forcar erro interno (ex.: formato que quebra o sharp) e conferir que a resposta nao traz path
  curl -s -X POST 'http://localhost:3700/api/upload?formato=webp' -F 'f=@/tmp/lixo.bin' \
    | grep -q '/tmp/ch-\|/home/servidor' && echo FALHA || echo OK
  ```

### BUG-04 · Worker `processarUm` não é reentrante · [P2]

- **Arquivo:** `server.js:94-96`
- **Evidência:** `setInterval(() => Promise.all([fila.processarUm(), fila.processarUm()]), 2000)` —
  sem trava de reentrância. Dois `processarUm` podem selecionar o **mesmo** job `pendente` (o SELECT
  e o UPDATE de status não são atômicos) e processar duas vezes.
- **Impacto:** com 2 workers a 2 s, um job lento (vídeo longo) pode ser pego duas vezes — as duas
  gravações colidem no mesmo `destino`; e o `marcar(...,'processando')` de um sobrescreve o estado do
  outro.
- **Mudança:** trava de reentrância (flag `processando` no módulo) — o `setInterval` não inicia
  enquanto o anterior não terminou; ou atomicidade no SQLite: `UPDATE ... WHERE status='pendente'
  RETURNING` para "reservar" o job.
- **Aceite:** um job nunca é processado duas vezes (verificável pelo número de escritas de saída).
- **Verificação:** adicionar log de início de job e garantir uma linha por job.

### BUG-05 · Arquivos de saída em `tmpdir` não têm TTL de limpeza · [P2]

- **Arquivo:** `src/fila.js:64` (`mkdtempSync(join(tmpdir(), 'ch-'))`)
- **Evidência:** cada job cria um diretório em `/tmp/ch-XXXX`; nada remove. O download expira só
  porque o arquivo pode sumir por outros meios (`server.js:60` trata o `410`).
- **Impacto:** acúmulo de saídas em `/tmp` (que costuma ser `tmpfs`, ou seja **RAM**) — enche a
  memória com o tempo. O `410` do download é symptomático disso.
- **Mudança:** limpeza com TTL (ex.: apaga `/tmp/ch-*` com mais de 1 h), num intervalo; e no
  `marcar(...,'pronto')`, manter a saída por X min (janela de download) e depois remover.
- **Aceite:** `/tmp/ch-*` nunca passa de um número fixo de diretórios (após o TTL).
- **Verificação:** `ls /tmp/ | grep -c '^ch-'` após processar vários jobs e esperar o TTL.

---

## 5. Qualidade: testes, arquitetura e observabilidade

### TEST-01 · Sem teste de path traversal no `formato` · [P1]

- **Arquivo:** `test/` (existente, mas sem caso de path traversal no `formato`)
- **Evidência:** os testes cobrem ingest/convert de caminho feliz; não cobrem `formato` malicioso.
- **Impacto:** o `SEC-01` (escrita arbitrária) pode voltar sem teste que pegue.
- **Mudança:** `POST /api/upload?formato=../../x` (com arquivo válido) → `400`; e nenhum arquivo
  criado fora do tmpdir. Cobrir `formato` com `..`, `/`, e string vazia.
- **Aceite:** `npm test` inclui os 3 casos e falha se a allowlist sair.
- **Verificação:** `npm test 2>&1 | tail -2`.

### TEST-02 · Sem teste de upload inválido limpando disco · [P2]

- **Arquivo:** novo `test/` (upload com tipo desconhecido)
- **Evidência:** nenhum teste faz upload de lixo e verifica que `uploads/` não cresce.
- **Impacto:** o `SEC-02` (DoS de disco) pode voltar.
- **Mudança:** upload de bytes aleatórios → `400` e contagem de arquivos em `uploads/` inalterada.
- **Aceite:** teste passa; falha se o `unlink` de segurança for removido.
- **Verificação:** `npm test 2>&1 | tail -2`.
---

## 6. DevOps / Infra

### DEVOPS-01 · `converthub.db` commitado no repo · [P1]

- **Arquivo:** `converthub.db` (na raiz, trackeado)
- **Evidência:** `git ls-files | grep '\\.db$'` lista o arquivo; `server.js:12` usa
  `CONVERTHUB_DB || 'converthub.db'`.
- **Impacto:** dados de job versionados (caminhos absolutos de arquivo em `saida`/`arquivo_entrada` —
  ver `IMP-01`); cada `pull` sobrescreve o banco de dev; histórico inchado com binário mutante.
- **Mudança:** `git rm --cached converthub.db`; `*.db` no `.gitignore`.
- **Aceite:** nenhum `.db` no índice; testes verdes.
- **Verificação:**
  ```bash
  git ls-files | grep -c '\\.db$'   # 0
  npm test 2>&1 | tail -2
  ```

### DEVOPS-02 · Sem `.env.example` · [P3]

- **Arquivo:** *(ausente)* `.env.example` · `server.js:10,12`
- **Evidência:** lê `PORT` e `CONVERTHUB_DB`.
- **Impacto:** baixo; evita adivinhação.
- **Mudança:** `.env.example` com `PORT=3700`, `CONVERTHUB_DB=converthub.db`.
- **Aceite:** exemplo versionado cobre as 2 variáveis.
- **Verificação:** `diff` entre `process.env.*` e as chaves do exemplo.

---

## 7. Documentação

### DOC-01 · README não documenta requisitos (ffmpeg/sharp) · [P2]

- **Arquivo:** `README.md`
- **Evidência:** o projeto depende de binário de sistema (`ffmpeg`, `fila.js:117`) e de nativo
  (`sharp`, `fila.js:5`), mas o README não deixa isso explícito.
- **Impacto:** quem implanta em container sem `ffmpeg` vê todo job de áudio/vídeo falhar (`falhou` com
  `ffmpeg saiu com 127`), sem saber a causa.
- **Mudança:** seção "Requisitos" com: `ffmpeg` no PATH (e versão mínima), `sharp` (instalado via npm),
  e o espaço em disco para `uploads/` e `/tmp`; e o item `BUG-05` (TTL de limpeza).
- **Aceite:** README lista os 3 requisitos de sistema.
- **Verificação:** `grep -ni 'ffmpeg\|sharp\|requisito' README.md`.

---

## 8. Ordem de execução (waves)

### Wave 1 — Fechar escrita arbitrária e disco (P0)
1. **`SEC-03`** — validar `formato` contra allowlist no `ingere`.
2. **`SEC-01`** — nome de saída interno do servidor + escopo no tmpdir.
3. **`SEC-02`** — validar antes de gravar (ou apagar em falha) + TTL de limpeza.

> Depois da Wave 1, nenhum input do cliente controla path de escrita e o disco não enche.

### Wave 2 — Blindar a borda (P1)
4. **`BUG-01`** — escopar `saida` ao tmpdir no download.
5. **`IMP-01`** — `exigirToken` ou remover paths da resposta de `/api/jobs`.
6. **`SEC-04`** — rate limit no upload + teto de disco.
7. **`TEST-01`**, **`TEST-02`** — travar `SEC-01`/`SEC-02`.

### Wave 3 — Robustez (P2)
8. **`BUG-04`** — trava de reentrância no worker.
9. **`BUG-05`** — TTL de limpeza de `/tmp/ch-*` e `uploads/`.
10. **`BUG-02`** — `formato` inválido rejeitado na hora (parcialmente coberto por `SEC-03`).
11. **`BUG-03`** — não expor `err.message`.
12. **`SEC-05`** — `helmet`.
13. **`DEVOPS-01`** — tirar o `.db` do índice.
14. **`DOC-01`** — requisitos no README.

### Wave 4 — Envs (P3)
15. **`DEVOPS-02`** — `.env.example`.

**Dependências que não podem ser invertidas:**
`SEC-03` antes de `SEC-01` e `BUG-02` (validar o formato é o que impede o path) · `SEC-01` antes de
`BUG-01` (o escopo do download pressupõe path controlado) · `SEC-02` e `TEST-02` juntos ·
`DEVOPS-01` antes de criar teste que escreva banco.

---

## 9. Fora de escopo / riscos

| Item | Decisão | Motivo |
|---|---|---|
| Validar arquivos com antivírus | **Não, ainda** | O magic bytes já cobre tipo; antivírus é feature. Manter o item `DOC-01` (requisitos). |
| Trocar `ffmpeg` por WASM | **Não** | O `spawn` com array de args já é seguro contra shell injection; performance é aceitável. |
| Converter **URL** (SSRF) | **Não** | O serviço hoje só aceita upload. Se adicionar URL, reabrir threat model (ver nota SSRF no `IMP` do `devmetrics`). |
| Streaming de progresso | **Não** | O schema já tem `progresso`; manter. |
| Filas externas (Redis/BullMQ) | **Não** | Volume de 1 projeto; o SQLite com worker pool basta. |

**Riscos desta execução:**

- **`SEC-01` pode quebrar formatos legítimos.** A allowlist deve cobrir tudo que o painel envia
  (imagem: png/jpg/jpeg/webp/gif/tiff/avif; mídia: os que o `ffmpeg` faz) — montar a lista **antes**
  de validar, ou upload válido começa a dar `400`.
- **`SEC-02` (validar antes de gravar) muda o fluxo do `validarTipo`.** Ele hoje lê o **arquivo**;
  adaptar para aceitar `Buffer` (os 12 primeiros bytes) para não precisar gravar antes de validar.
- **`BUG-04` (trava de reentrância) pode reduzir throughput** — com 2 workers, se um segura a trava,
  o outro ocioso. Manter o paralelismo de 2, mas garantir exclusão por job (não global).
- **`IMPO-01` exigir token no painel** pode quebrar o painel atual (que não manda token) — migrar
  servidor + front juntos, ou começar por remover os paths da resposta (menos invasivo).

---

## 10. Definição de pronto (DoD)

**Segurança**
- [ ] `SEC-01` — `formato=../../x` → 400, nada escrito fora do tmpdir
- [ ] `SEC-02` — upload inválido não deixa arquivo; `uploads/` não cresce
- [ ] `SEC-03` — `formato` validado contra allowlist no `ingere`
- [ ] `SEC-04` — 21º upload na hora → 429; teto de disco respeitado
- [ ] `SEC-05` — headers do `helmet` presentes
- [ ] `BUG-01` — download de `saida` fora do tmpdir é recusado
- [ ] `IMP-01` — `/api/jobs` não devolve paths absolutos

**Funcional**
- [ ] `BUG-02` — `formato` inválido rejeitado na hora, sem criar job
- [ ] `BUG-03` — erro interno não expõe path
- [ ] `BUG-04` — job nunca processado duas vezes
- [ ] `BUG-05` — `/tmp/ch-*` com TTL de limpeza

**Testes e infra**
- [ ] `TEST-01` — 3 casos de path traversal no `formato`
- [ ] `TEST-02` — upload inválido não cresce o disco
- [ ] `DEVOPS-01` — nenhum `.db` no índice
- [ ] `DEVOPS-02` — `.env.example` com as 2 variáveis
- [ ] `DOC-01` — README lista ffmpeg/sharp/disco

**Validação final:**
```bash
npm test 2>&1 | tail -2
node --check server.js src/fila.js
git ls-files | grep -c '\\.db$'   # 0
```

---

*Fim do plano. Gerado por leitura direta do código em 2026-10-02. Nenhum item já estava corrigido*
*— todos apontam para defeitos ainda presentes.*
