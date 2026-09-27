// ConvertHub M2 — worker pool com concorrência configurável + batch de formatos por categoria.
import { criarFila } from './fila.js';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// formatos por categoria (M2: múltiplos destinos de uma vez)
export const FORMATOS_POR_CATEGORIA = {
  imagem: ['png', 'jpg', 'webp', 'avif'],
  audio: ['mp3', 'ogg', 'flac'],
  video: ['mp4', 'webm', 'mkv']
};

export function criarPool(caminhoDb = 'converthub.db', { workers = 3 } = {}) {
  const fila = criarFila(caminhoDb);
  let rodando = false;

  // pool: processa N jobs em PARALELO (worker pool com concorrência)
  async function rodar() {
    if (rodando) return { pulado: true };
    rodando = true;
    try {
      while (true) {
        const lote = [];
        for (let i = 0; i < workers; i++) {
          const job = fila.db.prepare("SELECT id FROM jobs WHERE status = 'pendente' ORDER BY criado_em LIMIT 1").get();
          if (!job) break;
          // marca como processando IMEDIATAMENTE (evita 2 workers pegando o mesmo)
          fila.db.prepare("UPDATE jobs SET status = 'processando' WHERE id = ? AND status = 'pendente'").run(job.id);
          lote.push(job.id);
        }
        if (!lote.length) break;
        await Promise.all(lote.map((id) => processar(id)));
      }
      return { pulado: false, concluidos: true };
    } finally {
      rodando = false;
    }
  }

  async function processar(id) {
    const job = fila.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!job) return;
    const destino = join(mkdtempSync(join(tmpdir(), 'ch-')), `saida.${job.formato_destino}`);
    try {
      if (job.tipo === 'imagem') await converterImagem(job.arquivo_entrada, destino, job.formato_destino);
      else await converterMidia(job.arquivo_entrada, destino, job.tipo, job.formato_destino);
      fila.db.prepare("UPDATE jobs SET status = 'pronto', progresso = 100, saida = ? WHERE id = ?").run(destino, id);
    } catch (e) {
      fila.db.prepare("UPDATE jobs SET status = 'falhou', progresso = 100, erro = ? WHERE id = ?").run(String(e.message).slice(0, 300), id);
    }
  }

  async function converterImagem(entrada, destino, formato) {
    const f = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp', gif: 'gif', tiff: 'tiff', avif: 'avif' }[formato.toLowerCase()];
    if (!f) throw new Error(`formato não suportado: ${formato}`);
    await sharp(entrada).toFormat(f).toFile(destino);
  }

  async function converterMidia(entrada, destino, tipo, formato) {
    await new Promise((resolve, reject) => {
      const args = tipo === 'audio' ? ['-i', entrada, '-vn', destino] : ['-i', entrada, '-c:v', 'libx264', '-preset', 'fast', destino];
      const ff = spawn('ffmpeg', ['-y', ...args], { stdio: 'ignore' });
      ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
      ff.on('error', reject);
    });
  }

  return { fila, rodar, workers };
}
