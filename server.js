// ConvertHub — servidor: ingestão de arquivos + painel + worker de entrega.
import express from 'express';
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { criarFila } from './src/fila.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 3700;
const LIMITE_BYTES = 50 * 1024 * 1024; // 50MB
const fila = criarFila(process.env.CONVERTHUB_DB || 'converthub.db');

const app = express();

// pasta de uploads
await mkdir(join(ROOT, 'uploads'), { recursive: true }).catch(() => {});

// upload de arquivo para conversão
app.post('/api/upload', async (req, res) => {
  const formato = req.query.formato;
  if (!formato) return res.status(400).json({ erro: { codigo: 'formato', mensagem: 'informe ?formato=png|webp|mp3|...' } });
  const chunks = [];
  let tamanho = 0;
  req.on('data', (c) => {
    tamanho += c.length;
    if (tamanho > LIMITE_BYTES) { req.destroy(); return res.status(413).json({ erro: { codigo: '413', mensagem: 'arquivo maior que 50MB' } }); }
    chunks.push(c);
  });
  req.on('end', async () => {
    try {
      const entrada = join(ROOT, 'uploads', `up_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
      await writeFile(entrada, Buffer.concat(chunks));
      const tipo = await fila.validarTipo(entrada);
      if (!tipo) {
        return res.status(400).json({ erro: { codigo: 'tipo', mensagem: 'tipo de arquivo desconhecido (magic bytes)' } });
      }
      const r = fila.ingere({ arquivo: entrada, tipo, formatoDestino: formato });
      res.status(201).json(r);
    } catch (e) {
      res.status(500).json({ erro: { codigo: 'interno', mensagem: e.message } });
    }
  });
});

// download do resultado (último job pronto)
app.get('/api/jobs/:id/download', async (req, res) => {
  const job = fila.db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ erro: { codigo: '404', mensagem: 'job não encontrado' } });
  if (job.status !== 'pronto') return res.status(409).json({ erro: { codigo: 'nao-pronto', mensagem: `status: ${job.status}` } });
  const saida = job.saida; // caminho REGISTRADO pelo worker no banco
  try {
    const dados = await readFile(saida);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="convertido.${job.formato_destino}"`
    });
    res.end(dados);
  } catch {
    res.status(410).json({ erro: { codigo: '410', mensagem: 'arquivo de saída expirou (tmp limpo) — reenvie o job' } });
  }
});

// API do painel
app.get('/api/jobs', (req, res) => res.json(fila.listar(Number(req.query.limite) || 50)));
app.get('/api/metricas', (req, res) => res.json(fila.metricas()));

// estático (painel)
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
app.use(async (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  try {
    let arquivo = normalize(join(ROOT, 'public', req.path));
    if (!arquivo.startsWith(ROOT)) throw new Error('fora');
    const dados = await readFile(arquivo); // lê ANTES de escrever headers (padrão do featureflags)
    res.writeHead(200, { 'Content-Type': MIME[extname(arquivo)] || 'text/html; charset=utf-8' });
    res.end(dados);
  } catch {
    try {
      const indice = await readFile(join(ROOT, 'public/index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(indice);
    } catch { res.writeHead(500); res.end('erro'); }
  }
});

const server = http.createServer(app);
export { server, fila };

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => {
    console.log(`ConvertHub em http://localhost:${PORT} (upload: POST /api/upload?formato=webp)`);
    // worker pool: 2 workers processando em paralelo (M2 parcial já no M1b)
    setInterval(async () => {
      await Promise.all([fila.processarUm(), fila.processarUm()]).catch(() => {});
    }, 2000);
  });
}
