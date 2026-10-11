// ConvertHub — upload limitado, validação em memória, API de jobs e workers.
import express from 'express';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import helmet from 'helmet';
import { criarFila, validarCaminhoSaida } from './src/fila.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = resolve(ROOT, 'public');
const UPLOADS = resolve(process.env.CONVERTHUB_UPLOADS || join(ROOT, 'uploads'));
const PORT = Number(process.env.PORT || 3700);
const LIMITE_BYTES = 50 * 1024 * 1024;
const LIMITE_DISCO_UPLOADS = 1024 * 1024 * 1024;
const MAX_UPLOADS_ATIVOS = 4;
const TTL_SAIDAS_MS = 60 * 60 * 1000;
const TTL_ORFAOS_MS = 24 * 60 * 60 * 1000;
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT precisa ser um inteiro entre 1 e 65535.');

await mkdir(UPLOADS, { recursive: true });
const fila = criarFila(process.env.CONVERTHUB_DB || 'converthub.db', { diretorioUploads: UPLOADS });
fila.recuperarAposReinicio();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);
const desenvolvimento = app.get('env') !== 'production';
app.use(helmet({
  strictTransportSecurity: desenvolvimento ? false : { maxAge: 15_552_000 },
  contentSecurityPolicy: {
    directives: {
      'upgrade-insecure-requests': desenvolvimento ? null : [],
      'object-src': ["'none'"],
      'frame-ancestors': ["'none'"]
    }
  }
}));

let uploadsAtivos = 0;
let bytesReservados = 0;

function criarLimitador(limite, janelaMs, maxChaves = 20_000) {
  const janelas = new Map();
  let operacoes = 0;
  return (chave) => {
    const agora = Date.now();
    let janela = janelas.get(chave);
    if (!janela || janela.ate <= agora) {
      janela = { usos: 0, ate: agora + janelaMs };
      janelas.set(chave, janela);
    }
    const permitido = janela.usos < limite;
    if (permitido) janela.usos += 1;
    if (++operacoes % 256 === 0 || janelas.size > maxChaves) {
      for (const [k, v] of janelas) if (v.ate <= agora) janelas.delete(k);
      while (janelas.size > maxChaves) janelas.delete(janelas.keys().next().value);
    }
    return { permitido, aguardeMs: Math.max(1, janela.ate - agora) };
  };
}

const limiteUploadPorIp = criarLimitador(20, 60 * 60 * 1000);

function responderLimite(res, aguardeMs, codigo = 'limite') {
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(aguardeMs / 1000))));
  res.status(429).json({ erro: { codigo, mensagem: 'Limite temporário de solicitações atingido. Tente novamente mais tarde.' } });
}

function limitarUpload(req, res, next) {
  const resultado = limiteUploadPorIp(req.ip || req.socket.remoteAddress || 'desconhecido');
  if (!resultado.permitido) return responderLimite(res, resultado.aguardeMs);
  next();
}

function limitarUploadsConcorrentes(req, res, next) {
  if (uploadsAtivos >= MAX_UPLOADS_ATIVOS) return responderLimite(res, 30_000, 'ocupado');
  uploadsAtivos += 1;
  let liberado = false;
  const liberar = () => {
    if (liberado) return;
    liberado = true;
    uploadsAtivos = Math.max(0, uploadsAtivos - 1);
  };
  res.once('finish', liberar);
  res.once('close', liberar);
  next();
}

async function tamanhoUploads() {
  let tamanho = 0;
  for (const item of await readdir(UPLOADS, { withFileTypes: true })) {
    if (!item.isFile()) continue;
    const info = await stat(join(UPLOADS, item.name)).catch(() => null);
    if (info) tamanho += info.size;
  }
  return tamanho;
}

async function limparUploadsOrfaos(idadeMs = TTL_ORFAOS_MS) {
  const referenciados = new Set(fila.db.prepare("SELECT arquivo_entrada FROM jobs WHERE status IN ('pendente','processando')").all().map((row) => resolve(row.arquivo_entrada)));
  const agora = Date.now();
  let removidos = 0;
  for (const item of await readdir(UPLOADS, { withFileTypes: true })) {
    if (!item.isFile() || !/^up_[0-9a-f-]{36}$/i.test(item.name)) continue;
    const caminho = resolve(UPLOADS, item.name);
    if (referenciados.has(caminho)) continue;
    const info = await stat(caminho).catch(() => null);
    if (!info || agora - info.mtimeMs < idadeMs) continue;
    await unlink(caminho).catch(() => {});
    removidos += 1;
  }
  return removidos;
}

async function limpezaAgendada() {
  const [saidas, temporarios, uploads] = await Promise.all([
    fila.limparSaidasVencidas(TTL_SAIDAS_MS),
    fila.limparTemporariosOrfaos(TTL_ORFAOS_MS),
    limparUploadsOrfaos(TTL_ORFAOS_MS)
  ]);
  if (saidas || temporarios || uploads) console.info(`[ConvertHub] Limpeza: ${saidas} saídas, ${temporarios} temporários, ${uploads} uploads órfãos.`);
}

await limpezaAgendada();

function erroApi(erro, res) {
  const status = { formato: 400, tipo: 400, dados: 400, quota: 507 }[erro.codigo] || 500;
  if (status === 500) console.error('[ConvertHub] Erro interno:', erro);
  res.status(status).json({ erro: { codigo: status === 500 ? 'interno' : erro.codigo, mensagem: status === 500 ? 'Erro interno do servidor' : erro.message } });
}

// O corpo binário é limitado pelo parser e validado em memória antes de gravar no disco.
app.post('/api/upload', limitarUpload, limitarUploadsConcorrentes, express.raw({ type: () => true, limit: LIMITE_BYTES }), async (req, res) => {
  const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const formatoBruto = req.query.formato;
  let bytesReservadosLocalmente = 0;
  if (typeof formatoBruto !== 'string' || !formatoBruto) return res.status(400).json({ erro: { codigo: 'formato', mensagem: 'informe um formato de saída compatível com o tipo de arquivo' } });
  let caminhoEntrada = '';
  try {
    const tipo = await fila.validarTipo(buffer);
    if (!tipo) return res.status(400).json({ erro: { codigo: 'tipo', mensagem: 'tipo de arquivo desconhecido (magic bytes)' } });
    const formato = fila.validarFormato(tipo, formatoBruto);

    const usados = await tamanhoUploads();
    if (usados + bytesReservados + buffer.length > LIMITE_DISCO_UPLOADS) {
      return res.status(507).json({ erro: { codigo: 'quota', mensagem: 'armazenamento de uploads cheio; aguarde o processamento e tente novamente' } });
    }
    bytesReservados += buffer.length;
    bytesReservadosLocalmente = buffer.length;
    caminhoEntrada = join(UPLOADS, `up_${randomUUID()}`);
    await writeFile(caminhoEntrada, buffer, { flag: 'wx' });
    const job = fila.ingere({ arquivo: caminhoEntrada, tipo, formatoDestino: formato });
    caminhoEntrada = '';
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(job);
  } catch (erro) {
    if (caminhoEntrada) await unlink(caminhoEntrada).catch(() => {});
    erroApi(erro, res);
  } finally {
    if (bytesReservadosLocalmente) bytesReservados = Math.max(0, bytesReservados - bytesReservadosLocalmente);
  }
});

app.get('/api/jobs/:id/download', async (req, res) => {
  const job = fila.db.prepare('SELECT id, tipo, formato_destino, status, saida FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ erro: { codigo: '404', mensagem: 'job não encontrado' } });
  if (job.status !== 'pronto') return res.status(409).json({ erro: { codigo: 'nao-pronto', mensagem: `status: ${job.status}` } });
  if (!job.saida) return res.status(410).json({ erro: { codigo: '410', mensagem: 'arquivo de saída expirou; envie outro job' } });
  let formato;
  try { formato = fila.validarFormato(job.tipo, job.formato_destino); }
  catch { return res.status(404).json({ erro: { codigo: 'saida', mensagem: 'arquivo de saída indisponível' } }); }
  const saida = validarCaminhoSaida(job.saida);
  if (!saida || extname(saida).toLowerCase() !== `.${formato}`) {
    return res.status(404).json({ erro: { codigo: 'saida', mensagem: 'arquivo de saída indisponível' } });
  }
  try {
    const dados = await readFile(saida);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="convertido.${formato}"`);
    res.status(200).send(dados);
  } catch {
    res.status(410).json({ erro: { codigo: '410', mensagem: 'arquivo de saída expirou; envie outro job' } });
  }
});

app.get('/api/jobs', (req, res) => {
  const limite = Number(req.query.limite);
  res.setHeader('Cache-Control', 'no-store');
  res.json(fila.listar(Number.isInteger(limite) ? limite : 50));
});
app.get('/api/metricas', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(fila.metricas());
});
app.use('/api', (req, res) => res.status(404).json({ erro: { codigo: '404', mensagem: 'Rota não encontrada' } }));

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
app.use(async (req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method)) return next();
  const arquivo = req.path === '/' ? resolve(PUBLIC, 'index.html') : resolve(PUBLIC, `.${req.path}`);
  if (arquivo !== PUBLIC && !arquivo.startsWith(`${PUBLIC}${sep}`)) return res.status(404).type('text/plain').send('Não encontrado');
  try {
    const dados = await readFile(arquivo);
    res.setHeader('Content-Type', MIME[extname(arquivo)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    if (req.method === 'HEAD') return res.status(200).end();
    res.status(200).send(dados);
  } catch {
    res.status(404).type('text/plain').send('Não encontrado');
  }
});

app.use((erro, req, res, next) => {
  if (res.headersSent) return next(erro);
  const status = Number.isInteger(erro.status) && erro.status >= 400 && erro.status < 500 ? erro.status : 500;
  if (status === 500) console.error('[ConvertHub] Erro HTTP interno:', erro);
  const codigo = status === 413 ? '413' : status === 400 ? 'requisicao_invalida' : 'interno';
  const mensagem = status === 413 ? 'arquivo maior que 50 MiB' : status === 400 ? 'corpo da requisição inválido' : 'Erro interno do servidor';
  res.status(status).json({ erro: { codigo, mensagem } });
});

const server = http.createServer(app);
export { server, fila };

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => {
    console.log(`ConvertHub em http://localhost:${PORT} (upload: POST /api/upload?formato=webp)`);
    let loteAtivo = false;
    setInterval(async () => {
      if (loteAtivo) return;
      loteAtivo = true;
      try { await Promise.all([fila.processarUm(), fila.processarUm()]); }
      catch (erro) { console.error('[ConvertHub] Falha no ciclo dos workers:', erro); }
      finally { loteAtivo = false; }
    }, 1000);
    setInterval(() => limpezaAgendada().catch((erro) => console.error('[ConvertHub] Falha na limpeza:', erro)), 60 * 1000);
  });
}
