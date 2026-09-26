# ConvertHub — Self-hosted File Converter

![Status](https://img.shields.io/badge/M1-funcionando%20(7%2F7%20testes)-brightgreen)
![CI](https://img.shields.io/badge/CI-test%20%2B%20license%20check-blue)
![Node](https://img.shields.io/badge/Node-%3E%3D18-green?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)

Self-hosted file conversion with a job queue: upload → queue (SQLite) → workers
(Sharp for images, FFmpeg for audio/video) → download, with a jobs panel
(status, progress, errors), size/rate limits and magic-byte validation.

> 🇧🇷 Conversão de arquivos self-hosted com fila de jobs: upload → fila → workers
> (Sharp p/ imagem, FFmpeg p/ áudio/vídeo) → download, painel de jobs, limits e
> validação por magic bytes.

## Features

- [x] **M1a** — Fila de jobs (SQLite) + workers: **Sharp** (imagem) e **ffmpeg** (áudio/vídeo) — 7/7 testes
- [x] **Validação por MAGIC BYTES** (não extensão): MP4 com nome .png é detectado como vídeo!
- [x] Falha registra erro no job; métricas (taxa de sucesso)
- [ ] **M1b** — Painel de jobs (status/progresso) + limits (tamanho/taxa)
- [ ] **M2** — Worker pool com concorrência, múltiplos formatos, preview antes/depois

## Quick start (planejado)

```bash
docker compose up
```

## Built with

- Queue pattern from my webhook-relay project; ffmpeg/yt-dlp knowledge from download_videos_youtube
- References: [C4illin/ConvertX](https://github.com/C4illin/ConvertX) (19k⭐),
  [VERT-sh/VERT](https://github.com/VERT-sh/VERT) (15.6k⭐, fully local)

## License

MIT — Rodolfo Franco ([FrancosCorporation](https://github.com/FrancosCorporation))
