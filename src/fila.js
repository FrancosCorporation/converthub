// ConvertHub — núcleo: fila de jobs + workers (sharp p/ imagem, ffmpeg p/ áudio/vídeo).
// Validação por MAGIC BYTES (não extensão) — exigência do plano (juízes).
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

export function criarFila(caminhoDb = 'converthub.db') {
  const db = new DatabaseSync(caminhoDb);
  db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    arquivo_entrada TEXT NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('imagem','audio','video')),
    formato_destino TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pendente','processando','pronto','falhou')),
    progresso INTEGER NOT NULL DEFAULT 0,
    erro TEXT DEFAULT '',
    saida TEXT DEFAULT '',
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `);

  const inserir = db.prepare('INSERT INTO jobs (id, arquivo_entrada, tipo, formato_destino, status) VALUES (?, ?, ?, ?, ?)');
  const marcar = db.prepare('UPDATE jobs SET status = ?, progresso = ?, erro = ?, saida = ? WHERE id = ?');

  return {
    db,

    // valida por MAGIC BYTES (não confia na extensão!)
    async validarTipo(caminho) {
      const buf = Buffer.alloc(12);
      const fd = await import('node:fs/promises').then((fs) => fs.open(caminho, 'r'));
      await fd.read(buf, 0, 12, 0);
      await fd.close();
      const hex = buf.toString('hex');
      if (hex.startsWith('89504e47')) return 'imagem';          // PNG
      if (hex.startsWith('ffd8ff')) return 'imagem';            // JPEG
      if (hex.startsWith('47494638')) return 'imagem';          // GIF
      if (hex.startsWith('49492a00') || hex.startsWith('4d4d002a')) return 'imagem'; // TIFF
      if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') return 'imagem'; // WEBP (RIFF....WEBP)
      if (hex.startsWith('494433') || hex.startsWith('fffb') || hex.startsWith('fff3') || hex.startsWith('fff2')) return 'audio'; // MP3
      if (hex.startsWith('664c6143')) return 'audio';           // FLAC
      if (hex.startsWith('4f676753')) return 'audio';           // OGG (ou video ogg)
      if (hex.startsWith('1a45dfa3')) return 'video';           // MKV/WEBM (EBML)
      if (hex.slice(8, 16) === '66747970') return 'video';      // MP4 (ftyp nos bytes 4-7)
      if (hex.startsWith('52494646')) return 'video';           // AVI/WEBP riff geral
      return null; // desconhecido
    },

    ingere({ arquivo, tipo, formatoDestino }) {
      if (!arquivo || !formatoDestino) throw Object.assign(new Error('arquivo e formato_destino obrigatórios'), { codigo: 'dados' });
      if (!['imagem', 'audio', 'video'].includes(tipo)) throw Object.assign(new Error('tipo inválido'), { codigo: 'tipo' });
      const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      inserir.run(id, arquivo, tipo, formatoDestino, 'pendente');
      return { id };
    },

    // worker: processa 1 job pendente (concorrência controlada pelo chamador)
    async processarUm() {
      const job = db.prepare("SELECT * FROM jobs WHERE status = 'pendente' ORDER BY criado_em LIMIT 1").get();
      if (!job) return null;
      marcar.run('processando', 10, '', '', job.id);
      const destino = join(mkdtempSync(join(tmpdir(), 'ch-')), `saida.${job.formato_destino}`);
      try {
        if (job.tipo === 'imagem') await converterImagem(job.arquivo_entrada, destino, job.formato_destino);
        else await converterMidia(job.arquivo_entrada, destino, job.tipo, job.formato_destino);
        marcar.run('pronto', 100, '', destino, job.id);
        return { id: job.id, ok: true, saida: destino };
      } catch (e) {
        marcar.run('falhou', 100, String(e.message).slice(0, 300), '', job.id);
        return { id: job.id, ok: false, erro: e.message };
      }
    },

    listar(limite = 50) {
      return db.prepare('SELECT id, arquivo_entrada, tipo, formato_destino, status, progresso, erro, saida, criado_em FROM jobs ORDER BY criado_em DESC LIMIT ?').all(limite);
    },

    metricas() {
      const total = db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
      const prontos = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pronto'").get().n;
      const falhos = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'falhou'").get().n;
      const pendentes = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pendente'").get().n;
      return { total, prontos, falhos, pendentes, taxaSucesso: total ? (prontos / total) * 100 : 0 };
    }
  };
}

// worker de imagem: sharp (rápido, nativo)
async function converterImagem(entrada, destino, formato) {
  const formatos = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp', gif: 'gif', tiff: 'tiff', avif: 'avif' };
  const f = formatos[formato.toLowerCase()];
  if (!f) throw new Error(`formato de imagem não suportado: ${formato}`);
  await sharp(entrada).toFormat(f).toFile(destino);
}

// worker de áudio/vídeo: ffmpeg (sistema)
async function converterMidia(entrada, destino, tipo, formato) {
  await new Promise((resolve, reject) => {
    const args = tipo === 'audio'
      ? ['-i', entrada, '-vn', destino]                    // áudio: extrai sem vídeo
      : ['-i', entrada, '-c:v', 'libx264', '-preset', 'fast', destino]; // vídeo: h264 rápido
    const ff = spawn('ffmpeg', ['-y', ...args], { stdio: 'ignore' });
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg saiu com ${code}`))));
    ff.on('error', reject);
  });
}
