# Fase 3, etapa 3a: bancada MCP com os motores reais

Resultado do teste de bancada pedido em `PLANO.md` (seção 5.4). Foi feito em
12/11/2026 com o Codex CLI 0.153.0 e o Claude Code 2.1.321 (o que vem junto do
app do Claude), na máquina do dono, com as assinaturas dele. Nada no código da
Seraphine foi mexido e nenhum arquivo de configuração do dono foi tocado.

**Pasta da bancada (fica guardada para repetir o teste):**
`E:\Projetos\Projeto-Seraphine\_harness-teste\bancada-mcp\`

- `servidor_mcp.py`: servidor MCP mínimo, só biblioteca padrão, ferramentas
  `ping`, `soma`, `falha`, `lento`, `quem`; grava uma linha por requisição em
  um log (método, ferramenta, hora, pid e pid do pai).
- `sai_logo.py`: "servidor" que sai na hora com código 3 (teste de falha de partida).
- `piloto.py`: monta a linha de comando igual à dos adaptadores da Seraphine,
  acrescenta o MCP, roda o motor com o prompt no stdin e guarda tudo em `saidas\`.
- `resumo_stream.py`: mostra um fluxo bruto do Claude Code de forma compacta.
- `projeto\leia-me.txt`: pasta de trabalho dos motores. `pasta com espaço\`: cópia do
  servidor num caminho com espaço e acento.
- `saidas\<nome>.*`: para cada execução, `.cmd.txt` (linha de comando e prompt),
  `.jsonl` (fluxo bruto), `.stderr.txt`, `.servidor.log`, `.tempos.txt` (hora de
  chegada de cada linha), `.resumo.json` e, no Claude, `.mcp.json`. Prefixo `cx` =
  Codex, `cl` = Claude Code. Todos os valores (`BANCADA_RUN`, `BANCADA_TOKEN`)
  são inventados.

Execuções reais (que chamaram o modelo): **Codex 12, Claude Code 13**. Mais
algumas execuções do Codex que falharam na leitura da configuração, antes de
chamar o modelo (sem custo), usadas para descobrir os valores válidos das opções.

## Resumo

**Codex 0.153.0**

- Declarar o servidor por `-c mcp_servers.bancada.{command,args,env}` junto com
  `--ignore-user-config` funciona, nos dois níveis de sandbox.
- Do jeito que a Seraphine roda hoje (`approval_policy="never"`), **a chamada é
  recusada**: `MCP tool call requires approval, but approval policy is never`.
  Não trava e não derruba o turno; o item vem com `status: failed`.
- A correção mínima é uma opção por servidor:
  `-c mcp_servers.<nome>.default_tools_approval_mode="approve"` (valores
  aceitos: `auto`, `prompt`, `writes`, `approve`; também existe por ferramenta em
  `mcp_servers.<nome>.tools.<ferramenta>.approval_mode`). Isso libera só as
  ferramentas daquele servidor; o shell continua preso ao sandbox (ver pergunta 3).
- Cuidado novo: o Codex **não espera** um servidor lento. Com `initialize`
  demorando 4 s a primeira volta saiu sem as ferramentas (com 1 s funcionou).

**Claude Code 2.1.321**

- `--mcp-config` com `--strict-mcp-config` funciona, com arquivo ou com JSON na
  própria linha de comando. `--restricted` **não** impede servidores MCP.
- Do jeito que a Seraphine roda hoje, **a chamada é negada** em `plan` e em
  `acceptEdits` ("requires approval... no approval surface"). O servidor sobe e
  as ferramentas aparecem em `system/init`, mas cada uso é negado.
- Em `acceptEdits` basta `--allowedTools mcp__<servidor>` (forma do servidor
  inteiro; `mcp__<servidor>__<ferramenta>` também vale). Em `plan` **não há como**:
  mesmo com `--allowedTools` o modo plano nega MCP. Para o nível "somente leitura"
  a saída que funcionou foi usar `--permission-mode manual`, tirar
  `Edit,Write,NotebookEdit` do `--tools` e liberar o servidor com `--allowedTools`.
  Isso muda o nível de leitura do `plan` para `manual` (ver pergunta 2).
- O Claude Code **espera** o servidor (até uns 27 s) e mostra `failed` em
  `system/init` se ele não responder.

---

## 1. Como o servidor é declarado em uma execução avulsa

**Codex.** Três overrides `-c` (comando, argumentos, variáveis) mais a opção de
aprovação. Os valores são TOML; usei strings JSON, que são strings TOML válidas e
escapam a barra invertida. Linha que funcionou (execução `cx04`, `workspace-write`;
a Seraphine monta o argv como lista, então as aspas abaixo são as do
`list2cmdline` do Windows e não precisam de cuidado extra):

```
codex exec --json --ignore-user-config --ignore-rules --skip-git-repo-check --color never
  --sandbox workspace-write --cd <projeto>
  -c approval_policy="never" -c windows.sandbox="unelevated"
  -c mcp_servers.bancada.command="E:\\...\\Seraphine\\.venv\\Scripts\\python.exe"
  -c mcp_servers.bancada.args=["E:\\...\\bancada-mcp\\servidor_mcp.py"]
  -c mcp_servers.bancada.env={BANCADA_RUN="run-0001",BANCADA_TOKEN="tok-ficticio-AAAA"}
  -c mcp_servers.bancada.default_tools_approval_mode="approve"
  -
```

- Caminho com **espaço e acento** funcionou no `args` (execução `cx07`, pasta
  `pasta com espaço\`). Array, tabela `env` e barra invertida dobrada: todos aceitos.
- No `resume` as mesmas quatro opções `-c` valem (e as mesmas aspas).
- Opções TOML que o 0.153.0 reconhece para o servidor (confirmadas pela leitura da
  configuração, com valores de tipo errado de propósito): `command`, `args`, `env`,
  `env_vars` (lista de nomes herdados do processo do motor), `startup_timeout_sec`
  (número), `tool_timeout_sec`, `enabled_tools` (lista), `default_tools_approval_mode`,
  `tools.<ferramenta>.approval_mode`.
- `codex mcp add` não foi usado (grava no arquivo do dono). `codex mcp --help` e
  `codex mcp add --help` foram só lidos.

**Claude Code.** Arquivo JSON ou texto JSON em `--mcp-config`, mais
`--strict-mcp-config` (que a Seraphine já passa). Arquivo gerado pelo piloto:

```json
{"mcpServers": {"bancada": {
  "command": "E:\\...\\Seraphine\\.venv\\Scripts\\python.exe",
  "args": ["E:\\...\\bancada-mcp\\servidor_mcp.py"],
  "env": {"BANCADA_RUN": "run-0001", "BANCADA_TOKEN": "tok-ficticio-AAAA"}}}}
```

```
claude.exe -p --output-format stream-json --verbose --restricted --strict-mcp-config
  --permission-mode acceptEdits --permission-prompts none
  --tools Read,Glob,Grep,Edit,Write,NotebookEdit,WebSearch
  --mcp-config <arquivo.json ou JSON inline> --allowedTools mcp__bancada
```

- JSON **inline** funcionou (execução `cl14`; o `list2cmdline` põe as aspas).
  O arquivo não é necessário.
- Os valores do `env` aceitam `${NOME}`: o Claude Code troca pelo valor do
  ambiente do próprio processo dele (execução `cl14`). Assim o segredo não vai
  nem para a linha de comando nem para o disco.
- `--allowedTools` aceita lista; coloque-o por último ou separe com `=`/outra
  opção, porque ele engole os argumentos seguintes (o prompt vai no stdin, então
  na prática não atrapalha).
- Caminho com espaço e acento no `args` funcionou (`cl10`).
- `claude mcp add` não foi usado.

## 2. A chamada funciona na invocação da Seraphine?

### Codex

Execução `cx01` (somente leitura, invocação atual + servidor, sem opção de aprovação):

```
{"type":"item.started","item":{"id":"item_0","type":"mcp_tool_call","server":"bancada","tool":"ping","arguments":{"texto":"oi"},"result":null,"error":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_0","type":"mcp_tool_call","server":"bancada","tool":"ping","arguments":{"texto":"oi"},"result":null,"error":{"message":"MCP tool call requires approval, but approval policy is never"},"status":"failed"}}
```

Log do servidor: `initialize`, `notifications/initialized`, `tools/list` e **nenhum**
`tools/call`. Ou seja, o servidor sobe, as ferramentas são oferecidas ao modelo e a
chamada é recusada pelo Codex antes de chegar ao servidor. O turno termina normal
(`turn.completed`), sem `turn.failed` nem `error`; o modelo só relata a recusa.

Com `default_tools_approval_mode="approve"` (`cx03`, somente leitura; `cx04`,
`workspace-write`) a chamada chega ao servidor e volta:

```
server log:  08:00:19.710 metodo=tools/call ferramenta=falha ...   (cx04: 3 chamadas, todas no log)
{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"bancada","tool":"ping","arguments":{"texto":"oi"},"result":{"content":[{"type":"text","text":"[BANCADA-OK] eco: oi"}],"structured_content":null},"error":null,"status":"completed"}}
```

Sobre os valores: o valor inválido `xx` devolve `expected one of auto, prompt, writes,
approve`. Só `approve` foi exercitado de ponta a ponta; `auto` (padrão) é o que
recusou em `cx01`; `prompt` e `writes` não foram rodados (`prompt` esperaria uma
resposta que não existe no `exec`).

**O que a mudança afrouxa:** qualquer ferramenta daquele servidor roda sem
perguntar, inclusive em sandbox `read-only` (`cx03`). A segurança passa a depender
de a ponte só oferecer ferramentas seguras e de o porteiro da Seraphine conferir
cada chamada. Só o servidor da Seraphine deve receber `approve`.

### Claude Code

| Execução | Modo | Opções | Resultado |
|---|---|---|---|
| `cl01` | plan | invocação atual + MCP | negada |
| `cl02` | plan | + `--allowedTools mcp__bancada__ping` | **negada** (modo plano) |
| `cl03` | acceptEdits | invocação atual + MCP | negada |
| `cl04` | acceptEdits | + `--allowedTools mcp__bancada` | funciona (ping, soma, falha) |
| `cl08` | manual | `--tools Read,Glob,Grep,WebSearch` + `--allowedTools mcp__bancada` | funciona |

Negação (`cl03`), no fluxo:

```
{"type":"system","subtype":"permission_denied","tool_name":"mcp__bancada__ping","decision_reason_type":"asyncAgent","decision_reason":"no approval surface in this session; permission request denied automatically","message":"Permission for this tool use was denied. It requires approval, and this session has no approval surface ..."}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Permission for this tool use was denied. ...","is_error":true,"tool_use_id":"toolu_01E1..."}]}}
... "result" com "permission_denials":[{"tool_name":"mcp__bancada__ping","tool_use_id":"toolu_01E1...","tool_input":{"texto":"oi"}}], "is_error":false
```

Em `cl01` a mensagem diz "Cannot call mcp__bancada__ping while in plan mode".
Em `cl02` (com `--allowedTools`) o `permission_denied` repete a negação: o modo plano
vence a lista de permissões. Servidor: `server/discover`, `initialize`,
`notifications/initialized`, `tools/list`, nenhum `tools/call`.

- `--restricted` **permite** servidores MCP (o `system/init` mostra
  `mcp_servers:[{"name":"bancada","status":"connected","source":"dynamic"}]`). A
  descrição do `--restricted` só fala de pular MCP junto com `--strict-mcp-config`;
  com `--strict-mcp-config --mcp-config` o servidor declarado é o único.
- `--permission-prompts none` **nega** a chamada que pediria aprovação; não trava.
- `--allowedTools` é necessário, nas duas formas (`mcp__bancada` para o servidor
  inteiro, `mcp__bancada__ping` para uma ferramenta; a primeira foi a testada
  de ponta a ponta, a segunda em `cl02`, onde o motivo da negação foi o modo plano).
- **Nível somente leitura.** `plan` não serve. `cl08` mostra a alternativa:
  `--permission-mode manual`, `--tools Read,Glob,Grep,WebSearch` (sem Edit, Write,
  NotebookEdit) e `--allowedTools mcp__bancada`. Linha usada:
  `claude.exe -p --output-format stream-json --verbose --restricted --strict-mcp-config
  --permission-prompts none --mcp-config <arq> --permission-mode manual
  --tools Read,Glob,Grep,WebSearch --allowedTools mcp__bancada`. Funcionou: ping e
  leitura de arquivo. **O que muda:** o "somente leitura" deixa de ser uma regra do
  modo e passa a ser só a ausência das ferramentas de escrita na lista `--tools`;
  como `--permission-prompts none` nega tudo que pediria aprovação e `--restricted`
  tira shell, o resultado é equivalente na prática, mas a defesa agora é a lista.
  O modo `manual` aparece como `permissionMode":"default"` no `system/init`.
  Não está na lista proibida da Seraphine (`bypassPermissions`, `dontAsk`, `auto`).
- Um erro meu na execução `cl07` (as opções foram tiradas por engano) mostrou
  outra coisa: **sem `--tools`** o Claude Code oferece dezenas de ferramentas
  embutidas (Task, Artifact, SendMessage, EnterWorktree, ...) e as ferramentas MCP
  viram "adiadas", precisando de `ToolSearch`. O `--tools` atual da Seraphine deve
  ser mantido sempre.

## 3. Adicionar o MCP muda o que o agente pode fazer?

**Não.** Com a configuração que funciona (e `approve`/`--allowedTools` ligados):

**Codex, `workspace-write` (`cx05`).** Pedi um `Set-Content -Path ..\fora-da-pasta.txt`
no shell:

```
"command":"...powershell.exe -Command \"Set-Content -Path ..\\fora-da-pasta.txt -Value teste\"",
"aggregated_output":"Set-Content : O acesso ao caminho 'E:\\...\\bancada-mcp\\fora-da-pasta.txt' foi negado. ...","exit_code":1,"status":"failed"
```

O arquivo **não** foi criado (conferido com `Test-Path`; nada a remover). O comando
rodou sem pedir aprovação porque está dentro do sandbox (é o comportamento de
hoje); a escrita fora do projeto continua barrada pelo sandbox. O MCP rodou no
mesmo turno.

**Claude Code, `acceptEdits` (`cl06`).** Pedi a escrita de `..\fora-da-pasta.txt`
com a ferramenta de escrita e um `echo oi` no shell:

```
{"type":"system","subtype":"permission_denied","tool_name":"Write","decision_reason":"--restricted: path outside the working directory","message":"...\\fora-da-pasta.txt is outside ...\\projeto; --restricted confines the file tools to the working directory."}
```

Escrita negada; o arquivo não existe. Não há ferramenta de shell na lista
(o modelo respondeu "não há ferramenta de shell disponível"). `--tools` continua
valendo: o MCP não acrescentou nenhuma ferramenta embutida (o `system/init` lista as
7 de sempre mais as 5 do servidor).

Limite do teste: só testei **uma** escrita fora do projeto por motor. A observação
do código da Seraphine de que o `workspace-write` do Codex também escreve no
temp do sistema continua valendo e não foi retestada.

## 4. O que aparece no fluxo de eventos

### Codex (`item.started` / `item.completed` com `type: mcp_tool_call`)

Sucesso (`cx04`):

```
{"type":"item.started","item":{"id":"item_2","type":"mcp_tool_call","server":"bancada","tool":"soma","arguments":{"a":2,"b":3},"result":null,"error":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_2","type":"mcp_tool_call","server":"bancada","tool":"soma","arguments":{"a":2,"b":3},"result":{"content":[{"type":"text","text":"[BANCADA-OK] soma = 5"}],"structured_content":null},"error":null,"status":"completed"}}
```

Erro da ferramenta (`falha`, o servidor devolve `isError: true`): o item termina
com `status:"failed"`, **`error:null`** e o texto do erro dentro de `result.content`:

```
{"type":"item.completed","item":{"id":"item_3","type":"mcp_tool_call","server":"bancada","tool":"falha","arguments":{},"result":{"content":[{"type":"text","text":"[BANCADA-OK] erro proposital da ferramenta falha"}],"structured_content":null},"error":null,"status":"failed"}}
```

Chamada recusada pela política: `status:"failed"`, `result:null`,
`error:{"message":"MCP tool call requires approval, but approval policy is never"}`.

Ferramenta lenta (`cx06`, `lento` com 20 s): `item.started` em 6,48 s e
`item.completed` em 26,50 s depois do início; **nenhum evento no meio** (sem
batimento). O Codex não gerou timeout nos 20 s (o padrão de `tool_timeout_sec` não
foi lido nem testado acima disso).

O nome da ferramenta no fluxo vem em dois campos, `server` e `tool` (sem prefixo).
O modelo enxerga `mcp__<servidor>__<ferramenta>` (pergunta 7). Os argumentos vêm
completos em `arguments`, o resultado em `result.content[]` (blocos `text`) e
`structured_content`.

**O que o `CodexEventParser` de hoje registra:**

- `item.started` → `step` `{type:"tool_call", phase:"started", call_id:"item_N",
  tool:"bancada.ping"}`; `item.completed` → o mesmo `step` com `phase:"completed"`
  e, se `status == "failed"`, `failed: True`. O pareamento por `id` funciona.
- **Perde:** os argumentos; o resultado; a mensagem de erro (a recusa de política
  e o `falha` ficam iguais, só `failed:true`; a recusa tem o motivo em
  `error.message`, que o parser ignora); a distinção "a ferramenta devolveu erro"
  (`result` preenchido, `error` nulo) × "o motor recusou" (`result` nulo, `error`
  preenchido).
- Nada no parser de hoje trata o servidor que não subiu: o fluxo não tem evento
  nenhum (pergunta 6).

### Claude Code (blocos `tool_use` e `tool_result`)

Sucesso (`cl04`):

```
{"type":"assistant","message":{... "content":[{"type":"tool_use","id":"toolu_018i...","name":"mcp__bancada__ping","input":{"texto":"oi"},"caller":{"type":"direct"}}] ...},"tool_use_meta":[{"id":"toolu_018i...","display_name":"Ping","server_display_name":"bancada","tool_name":"ping"}]}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_018i...","type":"tool_result","content":[{"type":"text","text":"[BANCADA-OK] eco: oi"}]}]}, "tool_use_result":[{"type":"text","text":"[BANCADA-OK] eco: oi"}]}
```

Erro da ferramenta (`falha`):

```
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"[BANCADA-OK] erro proposital da ferramenta falha","is_error":true,"tool_use_id":"toolu_015M..."}]}, "tool_use_result":"Error: [BANCADA-OK] erro proposital da ferramenta falha"}
```

Ferramenta lenta (`cl09`, 20 s): o `tool_use` chega em 3,6 s e o `tool_result` em 23,6 s;
no meio só um `rate_limit_event`. Sem batimento.

Negação por permissão: além do `tool_result` com `is_error: true`, vem um evento
`{"type":"system","subtype":"permission_denied",...}` e o `result` final traz
`permission_denials`.

O nome é `mcp__<servidor>__<ferramenta>` (por exemplo `mcp__bancada__ping`).

**O que o `ClaudeStreamParser` de hoje registra:**

- `tool_use` → `step` `{type:"tool_use", phase:"started", call_id, tool:"mcp__bancada__soma",
  target:""}`. O `target` sai **vazio**, porque `_short_target` só olha as chaves
  `file_path, path, notebook_path, pattern, query, url, command` e os argumentos do
  MCP (`texto`, `a`, `b`) não estão nessa lista. **Perde os argumentos.**
- `tool_result` → `step` `completed` com o mesmo `call_id`; quando `is_error`, vem
  `failed:true` e `error` (300 caracteres), mais uma nota
  `"mcp__bancada__falha falhou: ..."`. O erro de ferramenta e a negação de
  permissão ficam parecidos (os dois são `is_error`); só a negação deixa rastro
  extra, em `parser.denials` (`permission_denials` do `result`), sem aviso na tela.
  O evento `system/permission_denied` é ignorado.
- **Perde:** os argumentos, o resultado de sucesso (provavelmente de propósito),
  o servidor (só aparece embutido no nome, e `tool_use_meta` é ignorado), e a
  separação entre "negado" e "falhou".
- `_READ_ONLY_TOOLS` não conhece nomes MCP: todo `mcp__*` é tratado como **não**
  somente leitura (sem `read_only:true`). É o lado seguro, mas a regra da fase 1d
  (cortar sem deixar nada pela metade) vai tratar `memory_read` como ação que
  pode deixar coisa pela metade, a menos que a ponte diga qual ferramenta só lê.
- Aviso de plano: o `rate_limit_event` desta máquina veio com
  `status:"allowed_warning"` (uso semanal em 88%, `surpassedThreshold: 0.75`); o
  parser só trata `rejected`. Não é da ponte, mas apareceu em todas as execuções.

## 5. Valores por execução (`quem`)

- **Codex, tabela `env`** (`cx05`): `quem` devolveu `BANCADA_RUN=run-0002
  BANCADA_TOKEN=tok-ficticio-BBBB`, valores diferentes dos de outras execuções
  (`run-0001`, `run-0003`...). No mesmo turno, um comando de shell pedindo
  `$env:BANCADA_RUN` e `$env:BANCADA_TOKEN` devolveu **vazio**: o valor só chegou
  ao processo do servidor. No fluxo, o texto do comando teve o valor do token
  trocado por `[REDACTED_SECRET]` (o Codex esconde nomes que parecem segredo no
  texto do comando; a saída do comando não é escondida).
- **Codex, `env_vars` + ambiente do processo do motor** (`cx16`, `cx17`): também
  entrega ao servidor (`cx16`) e tira o segredo da linha de comando, **mas o
  shell do agente herda as variáveis**: `cx17` mostrou
  `token=tok-ficticio-EEEE` na saída do comando. Não usar `env_vars` para segredo
  enquanto o shell do agente existir (não testei `shell_environment_policy` para
  filtrar).
- **Claude Code** (`cl06`, `cl14`): `env` no JSON funciona; com `${NOME}` o valor vem do
  ambiente do `claude.exe` e não aparece na linha de comando (`cl14`). Não há shell
  nesta configuração, então a pergunta do vazamento para o shell não se aplica.
- **Aparece no fluxo?** O valor só aparece onde a própria ferramenta `quem` o
  devolve (o resultado da chamada). O `system/init` do Claude Code lista os
  servidores sem o `env`; o fluxo do Codex não ecoa a configuração. Os valores
  aparecem (a) no `.jsonl` só pelo resultado de `quem`, (b) na linha de comando do
  motor quando passados por `-c ...env=` ou pelo JSON inline sem `${}`, e (c) no
  arquivo `.mcp.json` que o piloto gravou (o piloto só grava valores inventados).
- **Para a Seraphine:** o token de execução **não pode** ir em arquivo (regra do
  plano). Claude Code: `--mcp-config` inline com `"BANCADA_TOKEN":"${...}"` e o
  valor no ambiente do processo. Codex: sem arquivo, mas só dá para entregar pela
  tabela `env` (valor na linha de comando do processo, legível por processos do
  mesmo usuário) ou por `env_vars` (vaza para o shell do agente). Decisão fica para
  a 3b; uma alternativa que não depende de segredo na linha de comando é o servidor
  ler o token de um canal local aberto por ele (o plano já prevê canal local com
  token por execução).

## 6. Ciclo de vida

| Pergunta | Codex | Claude Code |
|---|---|---|
| Quando o motor inicia o servidor | na partida, antes da 1ª volta do modelo (log do servidor 0,2 s depois do início do motor; `cx06` mostrou o processo vivo aos 3 s, antes da chamada aos 6 s) | na partida, antes do `system/init` (`cl04`: `tools/list` 0,2 s após o início, chamada só aos 5 s) |
| Conversa retomada | sobe **de novo** (pid novo, `start`/`initialize`/`tools/list` no log de `cx07`) | sobe de novo (pid novo no log de `cl10`) |
| Fim do servidor | termina com o motor (`servidor_vivo_apos_motor: []` em todas as execuções) | termina com o motor; o servidor vê o `stdin` fechado (`stdin_fechado` no log) |
| Servidor que sai na hora (`sai_logo.py`, código 3) | **segue sem as ferramentas, em silêncio**: exit 0, nada em stderr, nenhum evento de erro; o modelo só diz que não tem a ferramenta (`cx08`) | segue sem as ferramentas, **avisando no `system/init`**: `mcp_servers:[{"name":"bancada","status":"failed"}]` e sem `mcp__bancada__*` em `tools`; exit 0 (`cl11`) |
| Servidor lento no `initialize` | **não espera**: com 1 s funcionou (`cx11`); com 4 s a primeira volta saiu **sem** as ferramentas (`cx10`: `tools/list` chegou em 08:02:44, mas o modelo disse "sem ferramenta"); com 45 s idem (`cx09`) e o motor terminou em 9 s sem erro | **espera**: com 12 s o `system/init` só saiu em 12,6 s e a chamada funcionou (`cl12`); com 40 s o `system/init` saiu em 27,6 s com `status:"failed"` (`CONNECT_TIMEOUT: "Request timed out"` segundo o próprio modelo) e a execução seguiu sem ferramentas (`cl13`) |

Pontos para a ponte:

- Em nenhum dos dois motores a falha do servidor derruba a execução. No Codex ela
  é **invisível** no fluxo; no Claude Code ela fica só no `system/init`
  (`mcp_servers[].status`), que o parser de hoje não lê.
- O servidor da ponte tem que responder `initialize` em bem menos de 1 s no
  Codex (o limiar fica entre 1 s e 4 s; não achei o valor exato). Python do `.venv`
  sobe em ~0,1 s nesta máquina, então a ponte deve ser um programa pequeno, sem
  importar pacotes pesados na partida.
- Árvore de processos no Windows (`cx06.arvore.txt`): o motor é pai de um
  `python.exe` do `.venv` (o lançador do ambiente virtual), que é pai do
  `python.exe` real da instalação. O `ppid` gravado pelo servidor é, por isso,
  o lançador e não o `codex.exe`/`claude.exe`. O `taskkill /T` do `kill_tree` pega
  a árvore inteira.
- Execução cortada à força não foi testada para ver se o servidor sobrevive (o
  Job Object da Seraphine já cobre o motor e seus filhos).

## 7. Como o modelo enxerga as ferramentas

- **Codex:** `mcp__bancada__falha`, `mcp__bancada__lento`, `mcp__bancada__ping`,
  `mcp__bancada__quem`, `mcp__bancada__soma` (resposta do modelo em `cx07`; o fluxo
  de eventos usa `server` e `tool` separados).
- **Claude Code:** os mesmos nomes `mcp__<servidor>__<ferramenta>`, listados em
  `tools` do `system/init` e nos blocos `tool_use` (`cl10`).
- **Descrição em português do Brasil:** usada sem problema pelos dois ("Devolve o
  texto recebido com uma marca fixa. Use para testar a ponte da Seraphine."
  foi repetida corretamente em `cx07` e `cl10`); acentos nos argumentos e nas
  respostas chegaram íntegros. (No terminal do Windows o texto apareceu com
  acentos quebrados só na exibição do PowerShell; os arquivos estão em UTF-8.)
- Dica: nomes de ferramenta curtos e o nome do servidor curto (`seraphine`)
  mantêm o nome visto pelo modelo curto (`mcp__seraphine__memoria_buscar`).

## 8. Retomada de conversa

- **Codex** (`cx07`): `codex exec resume --json --ignore-user-config --ignore-rules
  --skip-git-repo-check -c sandbox_mode="workspace-write" -c approval_policy="never"
  -c windows.sandbox="unelevated" -c mcp_servers.bancada.*=... <thread_id> -`. Com o
  servidor declarado de novo (inclusive de outro caminho, com espaço) a ferramenta
  `soma` foi chamada (`soma = 9`). O `thread_id` não mudou. Não testei retomar **sem**
  redeclarar o servidor (a Seraphine sempre vai redeclarar, então não importa).
- **Claude Code** (`cl10`): `--resume <session_id>` com o `--mcp-config` de novo e
  `--allowedTools`; a chamada `soma` funcionou e o `session_id` continuou o mesmo
  (`aebbf0bc-...`). Não testei `--resume` sem a configuração.
- Em ambos o servidor é **novo** (outro pid, outro log de partida) e não guarda
  estado entre execuções. A ponte deve receber tudo de que precisa (identidade,
  escopo) a cada partida pelo ambiente.

## 9. Surpresas e diferenças que a ponte precisa absorver

- **Codex: política de aprovação vale para MCP.** `approval_policy="never"` recusa
  toda chamada MCP, sem erro de turno. Só `default_tools_approval_mode` (ou o
  `approval_mode` por ferramenta) resolve.
- **Codex: erro de ferramenta e recusa parecem iguais para o parser atual** (os
  dois são `status:"failed"`), mas o primeiro traz o texto em `result` e o segundo
  em `error.message`.
- **Codex não espera servidor lento e não avisa se ele falhar.** O Claude Code
  espera e avisa em `system/init`. Hoje a Seraphine só descobriria pelo modelo.
- **Claude Code: `plan` bloqueia MCP**, mesmo liberado. O nível "somente leitura"
  precisa de outra forma (`manual` + lista `--tools` sem escrita).
- **Claude Code: sem `--tools` as ferramentas MCP ficam "adiadas"** e exigem
  `ToolSearch`; com o `--tools` atual elas já vêm no conjunto.
- **Claude Code: `server/discover`**: o servidor recebe uma requisição `server/discover`
  antes do `initialize`. O servidor da bancada ignora métodos desconhecidos (responde
  erro -32601 só quando há `id`); a ponte precisa fazer o mesmo e não quebrar.
- **Segredo no ambiente do motor vaza para o shell do Codex** (`cx17`), mesmo com
  nome contendo `TOKEN`.
- **Codex edita o texto do comando no fluxo** (`[REDACTED_SECRET]`): o texto
  mostrado não é o comando exato que rodou.
- Uso do plano do Claude: o evento `rate_limit_event` veio com
  `allowed_warning` em todas as execuções (semana a 88%).
- O modelo respondeu "Fable" em `model` (`claude-fable-5-2`) no Claude Code
  sem eu pedir modelo; a Seraphine passa `--model` só quando configurado.

## O que a ponte precisa fazer

**Para a ponte (servidor MCP stdio da Seraphine)**

1. Programa pequeno, `python.exe` do `.venv`, só biblioteca padrão ou imports
   leves; responder `initialize` em muito menos de 1 s (limiar do Codex entre 1 s e 4 s).
2. Falar JSON-RPC por linhas; aceitar e ignorar sem erro `notifications/*` e
   `server/discover`; implementar `initialize`, `tools/list`, `tools/call` (e `ping`).
3. Receber a identidade da execução (`run id`) e o token por ambiente na partida;
   não guardar estado entre partidas (o motor sobe um servidor novo a cada
   execução e a cada retomada); encerrar quando o `stdin` fechar.
4. Marcar na resposta do `tools/call` erro de ferramenta com `isError: true` e mensagem
   curta em português (os dois motores entregam isso ao modelo).
5. Escrever ferramentas com nomes curtos; a descrição em português funciona.
6. Registrar antes e depois de cada chamada no porteiro do backend (a bancada mostra que
   o motor não deixa rastro útil dos argumentos e do resultado no nosso parser).
7. Anunciar quais ferramentas só leem (para a regra da fase 1d), já que os nomes
   `mcp__*` não são conhecidos pelo parser.

**Para o adaptador do Codex (`codex.py`)**

1. Quando houver ponte: acrescentar `-c mcp_servers.<nome>.command/args/env` e
   **`-c mcp_servers.<nome>.default_tools_approval_mode="approve"`**, também no
   `resume`; manter `--ignore-user-config`, `approval_policy="never"` e `--sandbox`.
   Aplicar `approve` **só** ao servidor da Seraphine, nunca em modo global.
2. Passar o token pela tabela `env` do servidor (não usar `env_vars` enquanto o
   agente tiver shell); avaliar `shell_environment_policy` se a decisão de 3b
   for usar o ambiente do processo.
3. Parser: guardar `arguments` e o resultado (cortados), distinguir `error` (recusa)
   de `result` com `status:failed` (erro da ferramenta) e mostrar a mensagem.
4. Detectar "ferramentas ausentes" por conta própria: o fluxo não avisa. Idéia:
   a ponte registrar `tools/list` atendido (hora e pid) e o backend conferir ao fim
   da execução; se não houve `tools/list` ou nenhuma chamada era esperada,
   avisar o dono. Servidor lento no Codex some sem aviso.
5. Documentar no cabeçalho do adaptador que `mcp_tool_call` agora está verificado
   (campos `server`, `tool`, `arguments`, `result`, `error`, `status`).

**Para o adaptador do Claude Code (`claude_code.py`)**

1. Quando houver ponte: `--mcp-config` com JSON inline (sem arquivo) e
   `"env":{"...":"${NOME}"}` com os valores no ambiente do processo; manter
   `--strict-mcp-config`, `--restricted`, `--permission-prompts none` e `--tools`.
2. Acrescentar `--allowedTools mcp__<nome>` (servidor inteiro) ao nível de
   escrita (`acceptEdits`).
3. Nível somente leitura: `plan` bloqueia MCP; trocar por `--permission-mode manual`,
   `--tools Read,Glob,Grep,WebSearch` e `--allowedTools mcp__<nome>`, **ou**
   aceitar que no `plan` a ponte não funciona e avisar o dono. Revisar a lista
   `_FORBIDDEN_MODES` e o `assert` (continua sem `bypassPermissions`/`dontAsk`/`auto`).
4. Parser: ler `mcp_servers` do `system/init` e avisar se `status != connected`;
   guardar os argumentos do MCP (`_short_target` não conhece as chaves);
   tratar `system/permission_denied` como "negado" (diferente de "falhou");
   reconhecer o prefixo `mcp__<nome>__` para o `read_only`.
5. Atualizar o cabeçalho com os formatos agora vistos de um CLI logado
   (`tool_use`/`tool_result` e o `result` completo).

**O que nunca deve ser afrouxado**

- Nada de `--dangerously-bypass-approvals-and-sandbox`, `bypassPermissions`,
  `dontAsk` ou `auto`.
- `approve` só no servidor da Seraphine; nenhuma ferramenta que escreva fora do
  porteiro (escopo conferido a cada chamada). Com `approve` e `--allowedTools`
  o motor **não pergunta mais nada** sobre aquele servidor.
- Manter `--ignore-user-config`, `--ignore-rules`, `--strict-mcp-config`,
  `--restricted` e `--tools`: o teste mostrou que o MCP não abre brecha no
  sandbox do Codex nem nas ferramentas de arquivo do Claude Code.
- Token de execução nunca em arquivo, em log ou em URL.

## O que não foi testado

- Ferramenta MCP que passa de 60 s (`tool_timeout_sec` do Codex; o tempo limite
  de ferramenta do Claude Code). Só o `lento` de 20 s.
- Limiar exato do Codex para esperar o servidor (entre 1 s e 4 s) e o valor de
  `startup_timeout_sec` na prática; o tempo limite do Claude Code ficou entre
  12 s e 27 s observados (a espera real foi ~27 s).
- `default_tools_approval_mode` com `auto` explícito, `prompt` e `writes`; e
  `tools.<ferramenta>.approval_mode` (só a leitura da configuração foi conferida,
  sem execução).
- Anotações de ferramenta MCP (`readOnlyHint`, `destructiveHint`) e o efeito delas
  na aprovação do Codex. O servidor da bancada não as declara.
- Vários servidores ao mesmo tempo; servidor HTTP (`--url`); OAuth.
- Retomada sem redeclarar o servidor; `codex exec fork`.
- Servidor que morre no meio de uma chamada; cancelamento da execução com servidor
  vivo (o Job Object e o `taskkill /T` da Seraphine não foram acionados aqui).
- Filtrar variáveis do shell do Codex com `shell_environment_policy` para usar
  `env_vars`.
- Conteúdo de resultado que não é texto (imagem, recurso) e respostas grandes
  (limite de tamanho: parte da 3b).
- `claude -p` sem `--permission-prompts none` (padrão `host`): não rodei para
  não travar esperando um anfitrião que não existe.
- Sessões gravadas em disco pelos motores (`~/.codex/sessions`, `~/.claude`) e se
  guardam os valores do `env`: não inspecionei (são pastas do dono).
- Execuções repetidas para medir variação: cada caso foi rodado uma vez.
