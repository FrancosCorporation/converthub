// Testes do ConvertHub — magic bytes, fila, worker imagem (sharp) e ffmpeg real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { criarFila } from '../src/fila.js';

const TMP = mkdtempSync(join(tmpdir(), 'ch-'));

// PNG REAL gerado pelo sharp (o handcrafted tinha CRC inválido — libpng rejeitava)
async function gerarPngReal(caminho) {
  const sharp = (await import('sharp')).default;
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#2ea043' } }).png().toFile(caminho);
}

test('magic bytes: PNG detectado como imagem', async () => {
  const fila = criarFila(join(TMP, 't1.db'));
  const png = join(TMP, 'foto.png');
  await gerarPngReal(png);
  const tipo = await fila.validarTipo(png);
  assert.equal(tipo, 'imagem');
});

test('magic bytes: arquivo com extensão mentirosa detectado pelo conteúdo', async () => {
  const fila = criarFila(join(TMP, 't2.db'));
  const mentiroso = join(TMP, 'fake.png'); // MP4 ftyp (bytes 4-7: 66747970) com nome .png
  writeFileSync(mentiroso, Buffer.from('000000186674797069736f6d', 'hex') + Buffer.alloc(200));
  const tipo = await fila.validarTipo(mentiroso);
  assert.equal(tipo, 'video'); // magic bytes > extensão!
});

test('magic bytes: desconhecido devolve null', async () => {
  const fila = criarFila(join(TMP, 't3.db'));
  const desconhecido = join(TMP, 'x.bin');
  writeFileSync(desconhecido, Buffer.from('deadbeefdeadbeefdeadbeef', 'hex'));
  assert.equal(await fila.validarTipo(desconhecido), null);
});

test('fila: ingestão valida tipo e formato', () => {
  const fila = criarFila(join(TMP, 't4.db'));
  assert.throws(() => fila.ingere({ arquivo: 'x', tipo: 'inexistente', formatoDestino: 'png' }));
  assert.throws(() => fila.ingere({ arquivo: '', tipo: 'imagem', formatoDestino: 'png' }));
  const r = fila.ingere({ arquivo: 'x', tipo: 'imagem', formatoDestino: 'webp' });
  assert.ok(r.id.startsWith('job_'));
});

test('worker imagem: converte PNG -> WEBP real (sharp)', async () => {
  const fila = criarFila(join(TMP, 't5.db'));
  const png = join(TMP, 'real.png');
  await gerarPngReal(png);
  const r = fila.ingere({ arquivo: png, tipo: 'imagem', formatoDestino: 'webp' });
  const out = await fila.processarUm();
  assert.equal(out.id, r.id);
  assert.equal(out.ok, true);
  const saida = await import('node:fs/promises').then((fs) => fs.readFile(out.saida));
  assert.ok(saida.slice(0, 4).toString('hex') === '52494646', 'saída é RIFF (WEBP)');
  const metricas = fila.metricas();
  assert.equal(metricas.prontos, 1);
});

test('worker áudio: ffmpeg gera wav de teste e converte -> mp3 real', async () => {
  const fila = criarFila(join(TMP, 't6.db'));
  // gera um wav de 1s via ffmpeg (sistema)
  const wav = join(TMP, 'teste.wav');
  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', wav], { stdio: 'ignore' });
    ff.on('close', (c) => (c === 0 ? resolve() : reject(new Error('ffmpeg gerou? ' + c))));
    ff.on('error', reject);
  });
  const r = fila.ingere({ arquivo: wav, tipo: 'audio', formatoDestino: 'mp3' });
  const out = await fila.processarUm();
  assert.equal(out.ok, true, 'conversão ffmpeg->mp3 ok');
  const saida = await import('node:fs/promises').then((fs) => fs.stat(out.saida));
  assert.ok(saida.size > 1000, 'mp3 com conteúdo');
});

test('worker: falha registra erro (imagem corrupta)', async () => {
  const fila = criarFila(join(TMP, 't7.db'));
  const corrupto = join(TMP, 'corrupto.png');
  writeFileSync(corrupto, Buffer.from('89504e47' + 'lixo demais que não é png', 'utf8').slice(0, 30));
  fila.ingere({ arquivo: corrupto, tipo: 'imagem', formatoDestino: 'png' });
  const out = await fila.processarUm();
  assert.equal(out.ok, false);
  assert.ok(out.erro.length > 0);
  assert.equal(fila.metricas().falhos, 1);
});
