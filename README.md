# ConvertHub — Self-hosted File Converter

![Status](https://img.shields.io/badge/M1b-funcionando%20(10%2F10%20testes)-brightgreen)
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

- [x] **M1a** — Fila de jobs (SQLite) + workers: **Sharp** (imagem) e **ffmpeg** (áudio/vídeo)
- [x] **Validação por MAGIC BYTES** (não extensão): MP4 com nome .png é detectado como vídeo!
- [x] **M1b** — Painel de jobs (status/progresso/erros em tempo real) + upload API + **download do resultado** + limite 50MB + worker pool 2x
- [x] **E2E provado (10/10):** upload PNG → worker → download WEBP (RIFF) completo
- [ ] **M2** — Múltiplos formatos por categoria, preview antes/depois

## Quick start

```bash
docker compose up   # painel em http://localhost:3700
```

```bash
# upload + conversão + download (fluxo completo)
curl -X POST "http://localhost:3700/api/upload?formato=webp" --data-binary @foto.png
# => {"id":"job_..."} — o worker converte; depois:
curl -OJ http://localhost:3700/api/jobs/<id>/download
```

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
