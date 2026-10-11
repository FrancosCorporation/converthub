const $ = (id) => document.getElementById(id);
const MAX_BYTES = 50 * 1024 * 1024;
const formatoPorTipo = {
  imagem: ['png', 'jpg', 'webp', 'gif', 'tiff', 'avif'],
  audio: ['mp3', 'ogg', 'flac', 'wav', 'aac', 'm4a', 'opus'],
  video: ['mp4', 'webm', 'mkv']
};
const tipoLegivel = { imagem: 'Imagem', audio: 'Áudio', video: 'Vídeo' };
const statusLegivel = { pendente: 'Na fila', processando: 'Convertendo', pronto: 'Pronto', falhou: 'Falhou' };
let atualizando = false;

function criar(tag, classe, texto) {
  const elemento = document.createElement(tag);
  if (classe) elemento.className = classe;
  if (texto !== undefined) elemento.textContent = texto;
  return elemento;
}

function aviso(elemento, texto = '', erro = false) {
  elemento.textContent = texto;
  elemento.hidden = !texto;
  elemento.classList.toggle('error', Boolean(erro && texto));
}

async function requisicao(caminho, opcoes = {}) {
  const resposta = await fetch(caminho, { ...opcoes, credentials: 'same-origin' });
  const tipo = resposta.headers.get('content-type') || '';
  const corpo = tipo.includes('application/json') ? await resposta.json() : null;
  if (!resposta.ok) throw new Error(corpo?.erro?.mensagem || `Falha na solicitação (${resposta.status}).`);
  return corpo;
}

function filtrarFormatos(arquivo) {
  const seletor = $('output-format');
  const mime = arquivo?.type || '';
  const tipo = mime.startsWith('image/') ? 'imagem' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : '';
  const tipoGrupo = { Imagem: 'imagem', Áudio: 'audio', Vídeo: 'video' };
  for (const grupo of seletor.querySelectorAll('optgroup')) {
    const nome = tipoGrupo[grupo.label];
    grupo.hidden = Boolean(tipo && nome !== tipo);
    for (const opcao of grupo.querySelectorAll('option')) opcao.disabled = Boolean(tipo && nome !== tipo);
  }
  if (tipo && !formatoPorTipo[tipo].includes(seletor.value)) seletor.value = formatoPorTipo[tipo][0];
}

function renderizarMetricas(metricas) {
  const area = $('metrics');
  area.replaceChildren();
  const itens = [
    ['No total', String(metricas.total)],
    ['Concluídas', String(metricas.prontos)],
    ['Na fila', String(metricas.pendentes)],
    ['Com falha', String(metricas.falhos)],
    ['Taxa de sucesso', `${Number(metricas.taxaSucesso || 0).toFixed(1)}%`]
  ];
  for (const [titulo, valor] of itens) {
    const cartao = criar('div', 'metric');
    cartao.append(criar('span', '', titulo), criar('strong', '', valor));
    area.append(cartao);
  }
}

function renderizarJobs(jobs) {
  const corpo = $('jobs-body');
  corpo.replaceChildren();
  $('empty-state').hidden = jobs.length > 0;
  for (const job of jobs) {
    const linha = document.createElement('tr');
    const codigo = criar('code', 'job-id', String(job.id).slice(0, 14));
    codigo.title = String(job.id);
    const progresso = criar('div', 'progress-wrap');
    const barra = document.createElement('progress');
    barra.max = 100;
    barra.value = Math.max(0, Math.min(100, Number(job.progresso) || 0));
    barra.setAttribute('aria-label', `${barra.value}% concluído`);
    progresso.append(barra, criar('span', '', `${barra.value}%`));
    const estado = criar('span', `badge ${job.status}`, statusLegivel[job.status] || 'Desconhecido');
    const acao = document.createElement('td');
    if (job.status === 'pronto' && Number(job.download_disponivel) === 1) {
      const baixar = criar('a', 'download-link', 'Baixar');
      baixar.href = `/api/jobs/${encodeURIComponent(job.id)}/download`;
      baixar.setAttribute('aria-label', `Baixar conversão ${job.id}`);
      acao.append(baixar);
    } else if (job.status === 'falhou') {
      acao.append(criar('span', 'error-text', job.erro || 'Conversão não concluída'));
    } else if (job.status === 'pronto') {
      acao.append(criar('span', 'muted', 'Download expirado'));
    } else {
      acao.append(criar('span', 'muted', 'Aguardando'));
    }
    linha.append(criarCelula(codigo), criarCelula(tipoLegivel[job.tipo] || job.tipo), criarCelula(String(job.formato_destino).toUpperCase()), criarCelula(estado), acao);
    corpo.append(linha);
  }
}

function criarCelula(valor) {
  const celula = document.createElement('td');
  if (valor instanceof Node) celula.append(valor);
  else celula.textContent = String(valor ?? '');
  return celula;
}

async function atualizarPainel() {
  if (atualizando) return;
  atualizando = true;
  $('refresh-button').disabled = true;
  try {
    const [metricas, jobs] = await Promise.all([requisicao('/api/metricas'), requisicao('/api/jobs?limite=50')]);
    renderizarMetricas(metricas);
    renderizarJobs(jobs);
    aviso($('jobs-message'));
  } catch (erro) {
    aviso($('jobs-message'), erro.message, true);
  } finally {
    atualizando = false;
    $('refresh-button').disabled = false;
  }
}

async function enviarArquivo(evento) {
  evento.preventDefault();
  const arquivo = $('file-input').files?.[0];
  if (!arquivo) return aviso($('upload-message'), 'Escolha um arquivo para continuar.', true);
  if (arquivo.size > MAX_BYTES) return aviso($('upload-message'), 'O arquivo excede o limite de 50 MiB.', true);
  const botao = $('upload-button');
  botao.disabled = true;
  aviso($('upload-message'), 'Validando e enviando o arquivo…');
  try {
    const formato = $('output-format').value;
    const resultado = await requisicao(`/api/upload?formato=${encodeURIComponent(formato)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: arquivo
    });
    $('upload-form').reset();
    filtrarFormatos(null);
    aviso($('upload-message'), `Arquivo aceito. Job ${resultado.id} entrou na fila.`);
    await atualizarPainel();
  } catch (erro) {
    aviso($('upload-message'), erro.message, true);
  } finally {
    botao.disabled = false;
  }
}

$('file-input').addEventListener('change', (evento) => filtrarFormatos(evento.target.files?.[0]));
$('upload-form').addEventListener('submit', enviarArquivo);
$('refresh-button').addEventListener('click', atualizarPainel);
filtrarFormatos(null);
atualizarPainel();
setInterval(atualizarPainel, 3000);
