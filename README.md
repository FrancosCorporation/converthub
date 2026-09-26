# ConvertHub — Self-hosted File Converter

![Status](https://img.shields.io/badge/status-em%20constru%C3%A7%C3%A3o-orange)
![Node](https://img.shields.io/badge/Node-%3E%3D18-green?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)

Self-hosted file conversion with a job queue: upload → queue (SQLite) → workers
(Sharp for images, FFmpeg for audio/video) → download, with a jobs panel
(status, progress, errors), size/rate limits and magic-byte validation.

> 🇧🇷 Conversão de arquivos self-hosted com fila de jobs: upload → fila → workers
> (Sharp p/ imagem, FFmpeg p/ áudio/vídeo) → download, painel de jobs, limits e
> validação por magic bytes.

## Features (roadmap)

- [ ] **M1a** — Upload → queue → worker → download
- [ ] **M1b** — Jobs panel + limits (size/rate)
- [ ] **M2** — Multi-format categories, worker pool concurrency, before/after preview

## Built with

- Queue pattern from my webhook-relay project; ffmpeg/yt-dlp knowledge from download_videos_youtube
- References: [C4illin/ConvertX](https://github.com/C4illin/ConvertX) (19k⭐),
  [VERT-sh/VERT](https://github.com/VERT-sh/VERT) (15.6k⭐, fully local)

## License

MIT — Rodolfo Franco ([FrancosCorporation](https://github.com/FrancosCorporation))
