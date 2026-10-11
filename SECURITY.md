# Segurança

## Reportar uma vulnerabilidade

Use **Report a vulnerability** na aba **Security** deste repositório no GitHub para enviar um relato privado. Não publique detalhes exploráveis em issues públicas. Inclua impacto, passos para reproduzir e uma forma segura de contato para coordenar a correção.

## Controles implementados

- Magic bytes determinam o tipo de entrada; o MIME e o nome do arquivo do cliente não são confiáveis.
- O formato de saída é validado por tipo antes de gravar o arquivo. O worker usa uma extensão permitida em um diretório temporário próprio.
- O endpoint limita o corpo a 50 MiB, aceita 20 uploads por hora e IP, limita a quatro uploads simultâneos e mantém no máximo 1 GiB no diretório de entradas.
- Uploads inválidos não são gravados. Entradas válidas são removidas após o processamento; uploads órfãos têm limpeza por idade.
- Caminhos de saída são validados dentro de diretórios temporários `converthub-*` antes de ler ou apagar. A API de jobs não expõe caminhos absolutos.
- Helmet configura cabeçalhos de segurança e a política do painel permite somente CSS/JavaScript da mesma origem.
- FFmpeg é executado com argumentos separados, sem shell. Erros de conversão são registrados no servidor e retornados ao cliente como mensagem genérica.

## Operação e limites

- A API de upload, a listagem de jobs, as métricas e o download por identificador são públicos nesta versão. Não trate o UUID de um job como mecanismo de autorização.
- Rate limits e contagem de uploads simultâneos são locais ao processo; reiniciam com o serviço e não são compartilhados entre réplicas.
- O serviço não autentica usuários nem isola jobs por conta. Coloque autenticação e controles de rede no proxy antes de expor a instalação publicamente.
- O aplicativo valida o formato e magic bytes, mas Sharp e FFmpeg ainda processam conteúdo não confiável. Execute o contêiner com limites de CPU, memória e armazenamento adequados.
- `trust proxy` permanece desabilitado. Só configure proxies conhecidos antes de usar o endereço IP do cliente para rate limiting.
- O volume persistente contém o SQLite e entradas de jobs pendentes. Entradas processadas e saídas têm retenção limitada.
