# Seraphine neste Windows

Abra **Seraphine** pelo atalho na Área de Trabalho ou no menu Iniciar.
O atalho inicia os serviços parados e abre a aplicação em
<http://127.0.0.1:5173>. Fechar a janela mantém os serviços em execução.

Esta instalação usa uma janela do Edge dedicada à interface web local.
O instalador Tauri existente no repositório é específico do macOS.

## Serviços

| Componente | Configuração desta instalação |
| --- | --- |
| Interface | React/Vite, porta 5173 |
| Servidor e dados | Python 3.12/FastAPI, porta 8000, SQLite e ChromaDB locais |
| Cérebro | Codex, usando a conta já conectada neste Windows |
| Outras opções | Claude com a conexão importada; Ollama com `qwen2.5:3b` |
| Memória semântica | Ollama com `nomic-embed-text`, porta 11434 |
| Reconhecimento de fala | faster-whisper `small`, CPU/int8 |
| Voz | ElevenLabs, chave e voz importadas da instalação anterior |
| WhatsApp | Serviço importado no Docker Engine do Ubuntu/WSL, porta 3001 |

O servidor Qwen3-TTS anterior está desligado. Com ElevenLabs selecionada,
o iniciador não abre um servidor de voz local. ElevenLabs, Codex, Claude,
Google e WhatsApp precisam de internet; os dados e o servidor da Seraphine
ficam neste computador e não dependem da VPS.

O Codex aparece na configuração inicial ao lado de Ollama e Claude. A escolha
é aplicada e salva no servidor. O Codex usa seu login existente, recebe o
contexto da Seraphine e devolve pedidos para as ferramentas da aplicação.
Seu terminal e suas ferramentas próprias ficam desativados nesse modo.
Se o login expirar, conecte sua conta novamente no Codex deste computador.

As configurações estão em `apps/seraphine/backend/.env`, ignorado pelo Git.
`apps/seraphine/frontend/.env.local` aponta a interface para o servidor local.
Não publique esses arquivos nem as pastas de dados: contêm informações pessoais
e credenciais das integrações.

## Iniciar e atualizar

Na raiz do repositório:

```powershell
.\scripts\start-windows.ps1
```

O parâmetro `-NoBrowser` inicia os serviços sem abrir outra janela.
Os registros de execução ficam em `data/windows/logs/`.
Na primeira utilização do microfone, permita seu uso no navegador.

Depois de atualizar o código:

```powershell
python -m uv sync --package seraphine --extra windows
npx --yes pnpm@10.33.0 --filter seraphine-web... install --frozen-lockfile --store-dir "$env:LOCALAPPDATA/pnpm/store"
Push-Location apps/seraphine/frontend
node node_modules/typescript/bin/tsc -b
node node_modules/vite/bin/vite.js build
Pop-Location
```

Reinicie o servidor depois de alterar código Python ou configurações.
Atualize a página depois de reconstruir a interface.

## Dados importados e recuperação

Os dados em uso ficam em `data/imported-vps/`. A migração preservou conversas,
memórias, notas, diário, tarefas, finanças, imagens e configurações. A instalação
local anterior permanece em `data/`, separada dos dados importados.

`data/windows/migration-vps-20260911/` contém o arquivo completo da VPS,
as imagens dos serviços, verificações SHA-256 e cópias anteriores à migração.
O código mais recente encontrado na VPS foi incorporado ao repositório.
`vps-final.sqlite` é uma segunda cópia consistente do banco, conferida ao final.
Guarde uma cópia dessa pasta em outro disco para proteger contra falha deste PC.

O Google usa agora `http://127.0.0.1:8000/google/oauth/callback` como retorno
autorizado. Tokens revogados exigem uma nova confirmação no navegador.
O QR de pareamento do WhatsApp fica em <http://127.0.0.1:8000/wa>.

Os serviços Linux usam o Docker Engine no Ubuntu; Docker Desktop não é necessário.
O iniciador mantém o Ubuntu ativo e cria conexões locais sem alterar o firewall.
As sessões do WhatsApp ficam nos volumes `seraphine_local_whatsapp_auth` e
`seraphine_local_whatsapp_cache`. O arquivo Compose está em
`apps/seraphine/docker-compose.windows.yml`.

O antigo CLIProxy foi preservado como opção de recuperação, no perfil
`legacy-proxy`. Ele não participa da conversa atual; suas autorizações antigas
podem precisar de renovação. Para iniciá-lo explicitamente:

```powershell
.\scripts\start-windows-services.ps1 -ProxyOnly
```

## Acesso e recursos da plataforma

Os endereços acima funcionam neste Windows. O domínio público anterior continua
apontando para a VPS; acesso pelo Mac ou celular precisa de uma conexão remota
separada para este computador. O PC deve permanecer ligado para executar os serviços.

HealthKit, automações do macOS, áudio nativo da Apple, janelas auxiliares do Tauri
e o Maestro nativo não estão disponíveis nesta janela web. Modelos locais podem
ter capacidades diferentes das opções em nuvem.
