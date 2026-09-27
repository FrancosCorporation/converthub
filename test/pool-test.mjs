// Testes M2 do ConvertHub — worker pool com concorrência (2 jobs em paralelo sem conflito).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { criarPool, FORMATOS_POR_CATEGORIA } from '../src/pool.js';

const TMP = mkdtempSync(join(tmpdir(), 'chpool-'));

test('formatos por categoria (M2: múltiplos destinos)', () => {
  assert.ok(FORMATOS_POR_CATEGORIA.imagem.includes('webp'));
  assert.ok(FORMATOS_POR_CATEGORIA.audio.includes('mp3'));
  assert.ok(FORMATOS_POR_CATEGORIA.video.includes('mkv'));
});

test('POOL: 3 workers processam 5 jobs sem pegar o mesmo job 2x', async () => {
  const pool = criarPool(join(TMP, 'pool.db'), { workers: 3 });
  // cria 5 imagens reais
  const pngs = [];
  for (let i = 0; i < 5; i++) {
    const png = join(TMP, `img${i}.png`);
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#388bfd' } }).png().toFile(png);
    pngs.push(png);
  }
  for (const p of pngs) pool.fila.ingere({ arquivo: p, tipo: 'imagem', formatoDestino: 'webp' });

  const r = await pool.rodar();
  assert.equal(r.pulado, false);
  const metricas = pool.fila.metricas();
  assert.equal(metricas.prontos, 5, `5 jobs processados: ${metricas.prontos}`);
  assert.equal(metricas.falhos, 0);
});

test('POOL: rodar 2x em sequência — a 2ª é pulada (lock de pool)', async () => {
  const pool = criarPool(join(TMP, 'pool2.db'), { workers: 1 });
  const png = join(TMP, 'x.png');
  await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } }).png().toFile(png);
  pool.fila.ingere({ arquivo: png, tipo: 'imagem', formatoDestino: 'jpg' });
  const [r1, r2] = await Promise.all([pool.rodar(), pool.rodar()]);
  assert.equal(r1.pulado, false);
  assert.equal(r2.pulado, true, '2ª chamada em paralelo é pulada (lock)');
  assert.equal(pool.fila.metricas().prontos, 1, 'job processado 1 vez só');
});
