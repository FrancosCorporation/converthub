# ConvertHub

Conversor self-hosted de imagens, áudios e vídeos. A API valida o tipo pelo conteúdo do arquivo, cria um job na fila SQLite e executa a conversão com Sharp ou FFmpeg.

## Requisitos

- Node.js 22.5 ou mais recente (`node:sqlite` é usado pela fila)
- npm
- FFmpeg no `PATH` para conversões de áudio e vídeo
- Sharp, instalado como dependência npm, para imagens
- Espaço para uploads temporários (até 1 GiB) e saídas em `os.tmpdir()` (retidas por até 1 hora)

O Dockerfile instala o FFmpeg. A imagem precisa de espaço disponível em `/data` e no diretório temporário do contêiner.

## Executar localmente

```bash
cp .env.example .env
npm ci
node --env-file=.env server.js
```

O painel fica em <http://localhost:3700>. `PORT`, `CONVERTHUB_DB` e `CONVERTHUB_UPLOADS` podem ser configurados no `.env`. Uploads são armazenados temporariamente em `uploads/`; o banco guarda a fila e o estado dos jobs.

## Executar com Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

Por padrão, a porta fica publicada apenas em `127.0.0.1:3700`. O banco e as entradas de jobs pendentes usam o volume persistente `dados`; entradas processadas são removidas e as saídas ficam em diretórios temporários. Para acesso externo, coloque um proxy reverso com TLS e controles de acesso adequados.

## Converter um arquivo pela API

Envie o conteúdo do arquivo como corpo binário e selecione um formato de saída compatível:

```bash
curl -X POST 'http://localhost:3700/api/upload?formato=webp' \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @foto.png
```

A resposta inclui o `id` do job. Consulte o painel ou `GET /api/jobs` até o status chegar a `pronto`, então baixe o resultado:

```bash
curl -OJ 'http://localhost:3700/api/jobs/<id>/download'
```

O arquivo pode ter até 50 MiB. A API permite 20 uploads por hora e IP, até quatro uploads simultâneos e até 1 GiB de arquivos pendentes no diretório de uploads. Arquivos inválidos são rejeitados antes de serem gravados. O formato é verificado novamente pela fila e não pode controlar um caminho no sistema.

## Formatos

| Tipo detectado | Formatos de saída |
|---|---|
| Imagem | PNG, JPG/JPEG, WebP, GIF, TIFF, AVIF |
| Áudio | MP3, OGG, FLAC, WAV, AAC, M4A, Opus |
| Vídeo | MP4, WebM, MKV |

O servidor detecta a entrada por magic bytes. O MIME e o nome enviados pelo cliente não são usados para decidir o tipo real. O FFmpeg recebe argumentos separados, sem shell.

## API

| Método e caminho | Uso |
|---|---|
| `POST /api/upload?formato=<extensão>` | Envia bytes e cria um job |
| `GET /api/jobs` | Lista jobs sem caminhos do filesystem |
| `GET /api/jobs/:id/download` | Baixa uma saída pronta ainda dentro da retenção |
| `GET /api/metricas` | Consulta contagens e taxa de sucesso |

As rotas de upload, jobs e métricas são públicas nesta versão. A listagem expõe apenas identificador, tipo, formato, estado, progresso e horário; caminhos de entrada/saída e detalhes internos de conversão não são retornados.

## Retenção e segurança

- Entradas são removidas quando a conversão termina; uploads órfãos são limpos depois de 24 horas.
- Saídas ficam em diretórios temporários `converthub-*` e são removidas após 1 hora. Diretórios órfãos com mais de 24 horas também são limpos.
- A API aplica limites por IP, teto de disco e limite de uploads simultâneos.
- Helmet configura cabeçalhos de segurança; o painel usa JavaScript e CSS externos e escreve conteúdo dinâmico com APIs do DOM.
- `uploads/`, bancos SQLite e arquivos `.env` ficam fora do Git.

## Desenvolvimento

```bash
npm test
```

A suíte existente cobre núcleo, conversão e fila. Os cenários específicos de path traversal e remoção de upload inválido ainda não têm casos automatizados.

## Licença

MIT — Rodolfo Franco ([FrancosCorporation](https://github.com/FrancosCorporation)).
