// ConvertHub M2 — concorrência sobre a reserva atômica da fila compartilhada.
import { criarFila, FORMATOS_POR_CATEGORIA } from './fila.js';

export { FORMATOS_POR_CATEGORIA };

export function criarPool(caminhoDb = 'converthub.db', { workers = 3, diretorioUploads = null } = {}) {
  if (!Number.isInteger(workers) || workers < 1 || workers > 8) throw new TypeError('workers deve ser um inteiro entre 1 e 8');
  const fila = criarFila(caminhoDb, { diretorioUploads });
  let rodando = false;

  async function rodar() {
    if (rodando) return { pulado: true };
    rodando = true;
    let processados = 0;
    try {
      while (true) {
        const resultados = await Promise.all(Array.from({ length: workers }, () => fila.processarUm()));
        const lote = resultados.filter(Boolean);
        processados += lote.length;
        if (!lote.length) break;
      }
      return { pulado: false, concluidos: true, processados };
    } finally {
      rodando = false;
    }
  }

  return { fila, rodar, workers };
}
