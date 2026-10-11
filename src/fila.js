// ConvertHub — fila SQLite com formatos validados, reserva atômica e arquivos temporários isolados.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { open, readdir, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';

export const FORMATOS_POR_CATEGORIA = Object.freeze({
  imagem: Object.freeze(['png', 'jpg', 'jpeg', 'webp', 'gif', 'tiff', 'avif']),
  audio: Object.freeze(['mp3', 'ogg', 'flac', 'wav', 'aac', 'm4a', 'opus']),
  video: Object.freeze(['mp4', 'webm', 'mkv'])
});

const FORMATOS_IMAGEM = Object.freeze({ png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp', gif: 'gif', tiff: 'tiff', avif: 'avif' });

function falha(codigo, mensagem) {
  return Object.assign(new Error(mensagem), { codigo });
}

function caminhoDentro(raiz, caminho) {
  const relativo = relative(resolve(raiz), resolve(caminho));
  return Boolean(relativo) && relativo !== '..' && !relativo.startsWith(`..${sep}`) && !isAbsolute(relativo);
}

export function validarCaminhoSaida(caminho) {
  if (typeof caminho !== 'string' || !caminhoDentro(tmpdir(), caminho)) return null;
  const absoluto = resolve(caminho);
  const relativo = relative(resolve(tmpdir()), absoluto).split(sep);
  if (relativo.length !== 2 || !/^converthub-[a-z0-9_-]+$/i.test(relativo[0]) ||
      !/^saida\.(png|jpg|jpeg|webp|gif|tiff|avif|mp3|ogg|flac|wav|aac|m4a|opus|mp4|mkv)$/i.test(relativo[1])) return null;
  return absoluto;
}

async function removerSaidaTemporaria(caminho) {
  const seguro = validarCaminhoSaida(caminho);
  if (!seguro) return false;
  try { await unlink(seguro); } catch { /* arquivo já removido ou conversão não o criou */ }
  try { await rm(dirname(seguro), { recursive: true, force: true }); } catch { /* limpeza best effort */ }
  return true;
}

export function validarFormato(tipo, formato) {
  if (typeof formato !== 'string') throw falha('formato', 'formato de saída inválido');
  const normalizado = formato.trim().toLowerCase().replace(/^\./, '');
  if (!FORMATOS_POR_CATEGORIA[tipo]?.includes(normalizado)) {
    throw falha('formato', `formato ${normalizado || '(vazio)'} não suportado para ${tipo || 'este arquivo'}`);
  }
  return normalizado;
}

export function criarFila(caminhoDb = 'converthub.db', { diretorioUploads = null } = {}) {
  const db = new DatabaseSync(caminhoDb);
  db.exec('PRAGMA busy_timeout = 5000');
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
      criado_em TEXT NOT NULL DEFAULT (datetime('now')),
      finalizado_em TEXT
    );
  `);
  const colunas = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((coluna) => coluna.name));
  if (!colunas.has('finalizado_em')) db.exec('ALTER TABLE jobs ADD COLUMN finalizado_em TEXT');
  db.exec("UPDATE jobs SET finalizado_em = criado_em WHERE status IN ('pronto','falhou') AND finalizado_em IS NULL");

  const inserir = db.prepare('INSERT INTO jobs (id, arquivo_entrada, tipo, formato_destino, status) VALUES (?, ?, ?, ?, ?)');

  function reservarProximo() {
    db.exec('BEGIN IMMEDIATE');
    try {
      const job = db.prepare("SELECT * FROM jobs WHERE status = 'pendente' ORDER BY criado_em, rowid LIMIT 1").get();
      if (!job) {
        db.exec('COMMIT');
        return null;
      }
      const reserva = db.prepare("UPDATE jobs SET status = 'processando', progresso = 10, erro = '', saida = '', finalizado_em = NULL WHERE id = ? AND status = 'pendente'").run(job.id);
      if (reserva.changes !== 1) {
        db.exec('ROLLBACK');
        return null;
      }
      db.exec('COMMIT');
      return job;
    } catch (erro) {
      try { db.exec('ROLLBACK'); } catch { /* preserva a falha original */ }
      throw erro;
    }
  }

  async function validarTipo(origem) {
    let buf;
    if (Buffer.isBuffer(origem)) {
      buf = origem.subarray(0, 12);
    } else if (typeof origem === 'string') {
      const arquivo = await open(origem, 'r');
      try {
        buf = Buffer.alloc(12);
        await arquivo.read(buf, 0, 12, 0);
      } finally {
        await arquivo.close();
      }
    } else {
      throw falha('dados', 'arquivo inválido');
    }
    const hex = buf.toString('hex');
    if (hex.startsWith('89504e47')) return 'imagem';                         // PNG
    if (hex.startsWith('ffd8ff')) return 'imagem';                           // JPEG
    if (hex.startsWith('47494638')) return 'imagem';                         // GIF
    if (hex.startsWith('49492a00') || hex.startsWith('4d4d002a')) return 'imagem'; // TIFF
    if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') return 'imagem'; // WEBP
    if (hex.startsWith('52494646') && hex.slice(16, 24) === '57415645') return 'audio'; // WAV
    if (hex.startsWith('494433') || hex.startsWith('fffb') || hex.startsWith('fff3') || hex.startsWith('fff2')) return 'audio'; // MP3
    if (hex.startsWith('664c6143')) return 'audio';                          // FLAC
    if (hex.startsWith('4f676753')) return 'audio';                          // OGG
    if (hex.startsWith('1a45dfa3')) return 'video';                          // MKV/WEBM
    if (hex.slice(8, 16) === '66747970') return 'video';                     // MP4
    if (hex.startsWith('52494646') && hex.slice(16, 24) === '41564920') return 'video'; // AVI
    return null;
  }

  return {
    db,

    validarTipo,
    validarFormato,

    ingere({ arquivo, tipo, formatoDestino } = {}) {
      if (typeof arquivo !== 'string' || !arquivo || arquivo.length > 4096) throw falha('dados', 'arquivo inválido');
      if (!Object.hasOwn(FORMATOS_POR_CATEGORIA, tipo)) throw falha('tipo', 'tipo inválido');
      const formato = validarFormato(tipo, formatoDestino);
      const id = `job_${randomUUID()}`;
      inserir.run(id, arquivo, tipo, formato, 'pendente');
      return { id };
    },

    async processarUm() {
      const job = reservarProximo();
      if (!job) return null;
      let diretorioTemporario = '';
      let destino = '';
      try {
        diretorioTemporario = mkdtempSync(join(tmpdir(), 'converthub-'));
        destino = join(diretorioTemporario, `saida.${job.formato_destino}`);
        db.prepare("UPDATE jobs SET saida = ? WHERE id = ? AND status = 'processando'").run(destino, job.id);
        if (job.tipo === 'imagem') await converterImagem(job.arquivo_entrada, destino, job.formato_destino);
        else await converterMidia(job.arquivo_entrada, destino, job.tipo, job.formato_destino);
        db.prepare("UPDATE jobs SET status = 'pronto', progresso = 100, erro = '', finalizado_em = datetime('now') WHERE id = ? AND status = 'processando'").run(job.id);
        return { id: job.id, ok: true, saida: destino };
      } catch (erro) {
        console.error(`[ConvertHub] Falha ao processar ${job.id}:`, erro);
        db.prepare("UPDATE jobs SET status = 'falhou', progresso = 100, erro = 'Falha na conversão', saida = '', finalizado_em = datetime('now') WHERE id = ?").run(job.id);
        if (destino) await removerSaidaTemporaria(destino);
        else if (diretorioTemporario) await rm(diretorioTemporario, { recursive: true, force: true }).catch(() => {});
        return { id: job.id, ok: false, erro: 'Falha na conversão' };
      } finally {
        if (diretorioUploads && caminhoDentro(diretorioUploads, job.arquivo_entrada) && /^up_[0-9a-f-]{36}$/i.test(basename(job.arquivo_entrada))) {
          await unlink(job.arquivo_entrada).catch(() => {});
          db.prepare("UPDATE jobs SET arquivo_entrada = '' WHERE id = ? AND status IN ('pronto','falhou')").run(job.id);
        }
      }
    },

    listar(limite = 50) {
      const tamanho = Number.isInteger(limite) ? Math.max(1, Math.min(limite, 100)) : 50;
      return db.prepare(`
        SELECT id, tipo, formato_destino, status, progresso, criado_em,
               CASE WHEN status = 'pronto' AND saida != '' THEN 1 ELSE 0 END AS download_disponivel,
               CASE WHEN status = 'falhou' THEN 'Falha na conversão' ELSE '' END AS erro
        FROM jobs ORDER BY criado_em DESC, rowid DESC LIMIT ?
      `).all(tamanho);
    },

    metricas() {
      const total = db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
      const prontos = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pronto'").get().n;
      const falhos = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'falhou'").get().n;
      const pendentes = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pendente','processando')").get().n;
      return { total, prontos, falhos, pendentes, taxaSucesso: total ? (prontos / total) * 100 : 0 };
    },

    recuperarAposReinicio() {
      return db.prepare("UPDATE jobs SET status = 'pendente', progresso = 0, erro = '', saida = '', finalizado_em = NULL WHERE status = 'processando'").run().changes;
    },

    async limparSaidasVencidas(idadeMs = 60 * 60 * 1000) {
      const prontos = db.prepare("SELECT id, saida, COALESCE(finalizado_em, criado_em) AS concluido FROM jobs WHERE status = 'pronto' AND saida != ''").all();
      const agora = Date.now();
      let removidos = 0;
      for (const job of prontos) {
        const concluido = Date.parse(`${job.concluido.replace(' ', 'T')}Z`);
        if (!Number.isFinite(concluido) || agora - concluido < idadeMs) continue;
        const caminho = validarCaminhoSaida(job.saida);
        if (caminho) {
          await removerSaidaTemporaria(caminho);
          removidos += 1;
        }
        db.prepare("UPDATE jobs SET saida = '' WHERE id = ? AND saida = ?").run(job.id, job.saida);
      }
      return removidos;
    },

    async limparTemporariosOrfaos(idadeMs = 24 * 60 * 60 * 1000) {
      const referenciados = new Set(db.prepare("SELECT saida FROM jobs WHERE saida != ''").all().map((row) => dirname(resolve(row.saida))));
      const agora = Date.now();
      let removidos = 0;
      for (const item of await readdir(tmpdir(), { withFileTypes: true })) {
        if (!item.isDirectory() || !/^converthub-[a-z0-9_-]+$/i.test(item.name)) continue;
        const diretorio = resolve(tmpdir(), item.name);
        if (referenciados.has(diretorio)) continue;
        const informacao = await stat(diretorio).catch(() => null);
        if (!informacao || agora - informacao.mtimeMs < idadeMs) continue;
        await rm(diretorio, { recursive: true, force: true });
        removidos += 1;
      }
      return removidos;
    }
  };
}

async function converterImagem(entrada, destino, formato) {
  const encoder = FORMATOS_IMAGEM[formato];
  if (!encoder) throw falha('formato', `formato de imagem não suportado: ${formato}`);
  await sharp(entrada).toFormat(encoder).toFile(destino);
}

async function converterMidia(entrada, destino, tipo, formato) {
  await new Promise((resolvePromise, rejectPromise) => {
    let argumentos;
    if (tipo === 'audio') {
      argumentos = ['-i', entrada, '-vn', destino];
    } else if (formato === 'webm') {
      argumentos = ['-i', entrada, '-c:v', 'libvpx-vp9', '-c:a', 'libopus', destino];
    } else {
      argumentos = ['-i', entrada, '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac', destino];
    }
    const processo = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...argumentos], { stdio: ['ignore', 'ignore', 'ignore'] });
    processo.once('error', rejectPromise);
    processo.once('close', (codigo) => codigo === 0 ? resolvePromise() : rejectPromise(new Error(`ffmpeg saiu com código ${codigo}`)));
  });
}
