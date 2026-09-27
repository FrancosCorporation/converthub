// E2E do ConvertHub: upload (magic bytes) → worker → download (fluxo de negócio completo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';

const PORTA = 3894;
const BASE = `http://localhost:${PORTA}`;
const TMP = mkdtempSync(join(tmpdir(), 'che-'));

const servidor = spawn('node', ['server.js'], {
  env: { ...process.env, NODE_ENV: 'test', PORT: String(PORTA), CONVERTHUB_DB: join(TMP, 'e2e.db') },
  stdio: 'ignore'
});
servidor.unref();
// o servidor NÃO escuta em NODE_ENV=test... mas o e2e precisa! (gate KANBANEX_NO_LISTEN)
// esse teste usa o servidor SEM NODE_ENV=test para o listen funcionar:
await new Promise((r) => setTimeout(r, 1500));

test.skip('servidor em modo test não escuta — verificação documentada', () => {});

// E2E REAL: servidor de verdade (sem NODE_ENV=test)
const servidorReal = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(PORTA), CONVERTHUB_DB: join(TMP, 'e2e.db') },
  stdio: 'ignore'
});
servidorReal.unref();
await new Promise((r) => setTimeout(r, 1800));

test('E2E: upload PNG -> worker converte WEBP -> download', async () => {
  // gera um PNG real
  const png = join(TMP, 'foto.png');
  await sharp({ create: { width: 32, height: 32, channels: 3, background: '#388bfd' } }).png().toFile(png);

  // upload com formato=webp
  const dados = readFileSync(png);
  const r1 = await fetch(`${BASE}/api/upload?formato=webp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: dados
  });
  assert.equal(r1.status, 201, 'upload aceito');
  const { id } = await r1.json();

  // aguarda o worker (pool a cada 2s)
  let job = null;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const lista = await fetch(`${BASE}/api/jobs`).then((r) => r.json());
    job = lista.find((j) => j.id === id);
    if (job?.status === 'pronto') break;
  }
  assert.equal(job?.status, 'pronto', `worker converteu: ${JSON.stringify(job)}`);

  // download do resultado
  const dl = await fetch(`${BASE}/api/jobs/${id}/download`);
  assert.equal(dl.status, 200);
  const buf = Buffer.from(await dl.arrayBuffer());
  assert.equal(buf.slice(0, 4).toString('hex'), '52494646', 'download é WEBP (RIFF)');
});

test('E2E: tipo desconhecido (magic bytes) rejeitado no upload', async () => {
  const r = await fetch(`${BASE}/api/upload?formato=png`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('deadbeefdeadbeef')
  });
  assert.equal(r.status, 400);
  const corpo = await r.json();
  assert.ok(corpo.erro.mensagem.includes('magic bytes'));
});

test('E2E: sem formato rejeitado', async () => {
  const r = await fetch(`${BASE}/api/upload`, { method: 'POST', body: Buffer.from('x') });
  assert.equal(r.status, 400);
});

process.on('exit', () => { servidor.kill(); servidorReal.kill(); });
