# Tarefas: Jay-C 0.5

Plano e decisões: [plan.md](plan.md). Cada tarefa: commit, resumo e pergunta antes da próxima.

Comandos: `npm test` (servidor + frontend), `cargo test --lib` em `frontend/src-tauri` quando mexer em Rust, `npm run dev` + `npm run server` para o manual, `node scripts/cdp-eval.mjs` para dirigir o app.

## Fase 0: pequenas e independentes

### [x] T1: Deafen silencia só as vozes da call
O `playback.js` passa a ter um barramento para o som das lives (`screen-audio`) fora do que o deafen zera.

**Critérios:**
- [ ] Com deafen ligado, as vozes (mic) de todos ficam em silêncio, e o som de uma live assistida continua tocando.
- [ ] O volume por pessoa e o volume da live (acima de 100%) continuam funcionando.
- [ ] Os sons do próprio app (entrar, sair, mute) seguem como hoje.

**Verificação:**
- [ ] `npm test`, com um teste do roteamento no `playback`.
- [ ] Manual: `output_meter` com um bot falando (oscilador) e outro transmitindo um tom. Com deafen: o nível do tom continua e o da voz cai a zero.

**Depende de:** nada · **Arquivos:** `core/playback.js`, `ui/call-view.js`, teste · **Tamanho:** S

### [x] T2: Mute e deafen salvos entre calls
O estado do mic e do deafen ao sair (ou ao fechar o app) é guardado e restaurado na próxima call.

**Critérios:**
- [ ] Sair mutado e entrar de novo: entra mutado. O mesmo para o deafen (que também deixa o mic desligado).
- [ ] Fechar o app no meio da call e abrir de novo: mesmo estado.
- [ ] A câmera continua começando desligada.

**Verificação:**
- [ ] `npm test`, com teste de que o settings guarda e lê o estado.
- [ ] Manual com o `cdp-eval`, guardando e restaurando os valores do usuário.

**Depende de:** nada · **Arquivos:** `store/settings.js`, `core/call.js`, `ui/app-shell.js` · **Tamanho:** S

## Checkpoint 0
- [ ] Testes passam; deafen medido no alto-falante; revisão com o usuário.

## Fase 1: o servidor com salas

### [ ] T3: Sessão de servidor e lista de salas ativas
Uma conexão `hello` (nome, foto, cor) que não entra em call recebe a lista de salas visíveis e quem está em cada uma, atualizada ao vivo. O `join` de hoje continua igual. O lobby mostra a lista e entra numa sala com um clique.

**Critérios:**
- [ ] `hello` → `server-state` (salas visíveis, participantes) e depois `rooms-updated` a cada mudança (alguém entra, sai, muta).
- [ ] O `joined` anuncia `server-session` em `features`; o app 0.5 num servidor 0.4 cai no lobby de hoje.
- [ ] Um app 0.4 entra por nome e aparece na lista dos outros.

**Verificação:**
- [ ] `npm test`, com testes do servidor: hello, lista, atualização, cliente 0.4.
- [ ] Manual: dois apps e um bot de navegador; a lista muda em menos de 1 s.

**Depende de:** nada · **Arquivos:** `signaling-server/src/server.js`, `rooms.js`, `frontend/src/core/server-session.js` (novo), `ui/lobby.js`, testes · **Tamanho:** M

### [ ] T4: Admin cria salas, com senha (cadeado) e invisíveis
Com a `ADMIN_KEY` do servidor (digitada uma vez no app e guardada por servidor), dá para criar, editar e apagar salas, com senha opcional e, com senha, a opção de ficar invisível. Na lista, a sala com senha mostra o cadeado e pede a senha; a invisível não aparece e só entra pelo nome. Nesta tarefa as salas ficam em memória (o disco é a T5).

**Critérios:**
- [ ] Sem a chave certa, criar, editar e apagar são recusados (`not-admin`); sem `ADMIN_KEY` no servidor, ninguém gerencia.
- [ ] O servidor guarda só o hash (`scrypt` + sal); o `join` sem senha ou com a senha errada é recusado com `wrong-password`.
- [ ] As tentativas erradas têm limite por IP.
- [ ] A sala invisível não aparece em `server-state` nem em `rooms-updated`, mas entra pelo nome com a senha.

**Verificação:**
- [ ] `npm test`: hash, senha certa e errada, limite, invisível fora da lista.
- [ ] Manual: o cadeado e o pedido de senha no app, nos dois temas e nos 3 estilos.

**Depende de:** T3 · **Arquivos:** `rooms.js`, `server.js`, `rate-limit.js`, `ui/lobby.js`, `ui/icons.js`, testes · **Tamanho:** M

### [ ] T5: Salas fixas, guardadas em disco
As salas criadas pelo admin existem mesmo vazias e sobrevivem a um reinício do servidor.

**Critérios:**
- [ ] `DATA_DIR` (padrão `./data`) guarda as salas fixas em JSON. A gravação é atômica (arquivo temporário e depois rename).
- [ ] Reiniciar o servidor mantém as salas, as senhas (hash) e a visibilidade.
- [ ] O `docker-compose.yml` monta um volume para `DATA_DIR`.

**Verificação:**
- [ ] `npm test`: gravar, ler, arquivo corrompido (o servidor sobe vazio e avisa no log).
- [ ] Manual: matar o servidor no meio de uma gravação e subir de novo.

**Depende de:** T4 · **Arquivos:** `signaling-server/src/store.js` (novo), `rooms.js`, `config.js`, `docker-compose.yml`, testes · **Tamanho:** M

## Checkpoint 1
- [ ] Dois apps e um app 0.4 no mesmo servidor; senha; invisível; reinício.
- [ ] `docs/ARQUITETURA.md` seção 4 atualizada; revisão com o usuário.

## Fase 2: canais de texto

### [ ] T6: Canais de texto no servidor, com histórico
Canais de texto por servidor: listar, criar e apagar (admin), mensagens ao vivo para quem está na sessão de servidor e as últimas 500 mensagens de cada canal guardadas.

**Critérios:**
- [ ] `server-state` traz os canais; `channel-message` chega a todos na sessão.
- [ ] `channel-history` devolve as últimas mensagens (paginação simples por id) e sobrevive a um reinício.
- [ ] Mesmo limite e limpeza do chat de hoje (1–500 caracteres, sem caracteres de controle) e limite de taxa.

**Verificação:**
- [ ] `npm test`: envio, histórico, limite, reinício.

**Depende de:** T3, T5 · **Arquivos:** `server.js`, `store.js`, `signaling-server/src/channels.js` (novo), testes · **Tamanho:** M

### [ ] T7: Canal de texto na interface
Abrir um canal de texto mostra o histórico e as mensagens novas; o campo de envio reaproveita o do chat da call (Markdown, quebras de linha).

**Critérios:**
- [ ] Rolar para cima carrega mais histórico; uma mensagem nova rola para baixo só se já estava no fim.
- [ ] Não lidas: um marcador no canal que não está aberto.
- [ ] Contraste ≥ 4,5:1 nos 6 combos.

**Verificação:**
- [ ] `npm test`: o que for lógica pura (agrupar mensagens, não lidas).
- [ ] Manual com dois apps; `contrast-audit.js`.

**Depende de:** T6 · **Arquivos:** `ui/text-channel.js` (novo), `ui/chat-panel.js` (extrair o que for comum), `core/server-session.js`, `core/i18n.js` · **Tamanho:** M

## Checkpoint 2
- [ ] Mensagens ao vivo e histórico depois de reiniciar servidor e app; revisão com o usuário.

## Fase 3: layout estilo Discord

### [ ] T8: DC, entrar direto numa sala pelo nome
O caminho de hoje (endereço + nome da sala) fica como "Direct call". A sala criada assim é temporária e invisível na lista do servidor.

**Critérios:**
- [ ] DC numa sala que não existe cria uma temporária invisível; numa fixa com senha, pede a senha.
- [ ] As salas recentes e o "entrar de novo" continuam funcionando.

**Verificação:**
- [ ] `npm test`: a sala do DC fica fora da lista. Manual.

**Depende de:** T4 · **Arquivos:** `ui/lobby.js`, `rooms.js`, testes · **Tamanho:** S

### [ ] T9: Shell nova: coluna de servidores, canais e área principal
O app abre na coluna de servidores salvos. Escolher um mostra os canais (calls com quem está nelas, canais de texto) e a área principal. A call ainda abre como hoje (tela cheia); o encaixe é a T10.

**Critérios:**
- [ ] Servidores salvos (adicionar, remover, reordenar); o ativo é lembrado.
- [ ] Lista de canais com as calls (participantes embaixo, cadeado) e os canais de texto.
- [ ] Teclado e leitor de tela: navegação por Tab e setas, rótulos ARIA. Contraste ≥ 4,5:1.

**Verificação:**
- [ ] `npm test`: lista de servidores no settings, com migração de `serverAddress`.
- [ ] Manual + `contrast-audit.js`, nos dois temas e 3 estilos.

**Depende de:** T3, T4, T7 · **Arquivos:** `ui/app-shell.js`, `ui/server-rail.js` (novo), `ui/channel-list.js` (novo), `store/settings.js`, `styles/` · **Tamanho:** L (se passar de 5 arquivos, separar a coluna de servidores numa tarefa própria)

### [ ] T10: Call encaixada
Com a call aberta, dá para ir a um canal de texto e a call continua. Um painel "conectado à voz" embaixo dos canais traz mic, deafen e sair; clicar na call volta à visão de hoje.

**Critérios:**
- [ ] Navegar entre canais não derruba nem renegocia a call (mesmos producers e consumers).
- [ ] O próprio nome aparece embaixo da call na lista, com o estado de mute e deafen.
- [ ] Live, PiP e o tour "Welcome!" continuam funcionando.

**Verificação:**
- [ ] Manual: `getStats()` antes e depois de navegar (os mesmos ids); PiP; live nativa.
- [ ] `npm test`.

**Depende de:** T9 · **Arquivos:** `ui/app-shell.js`, `ui/call-view.js` (só montagem), `ui/voice-panel.js` (novo) · **Tamanho:** M

### [ ] T11: Membros à direita e celular
Painel de membros do servidor (online por sala) à direita; no Android (tela estreita), as colunas viram gavetas.

**Critérios:**
- [ ] Membros online por sala; quem está em live aparece marcado.
- [ ] A 375 px de largura: nada corta, nada rola na horizontal; as gavetas abrem por botão.
- [ ] O PiP do Android continua funcionando.

**Verificação:**
- [ ] Manual no emulador (`scripts/android-dev.ps1`) e com `Emulation.setDeviceMetricsOverride`.

**Depende de:** T10 · **Arquivos:** `ui/members-panel.js` (novo), `ui/app-shell.js`, `styles/` · **Tamanho:** M

## Checkpoint 3
- [ ] Fluxo completo no desktop e no emulador; contraste; live sem regressão; revisão com o usuário.

## Fase 4: GIFs

### [ ] T12: GIFs do Tenor nos chats
Um botão de GIF no campo do chat (call e canais) abre a busca do Tenor e manda o GIF escolhido. A busca e as imagens passam pelo servidor (decisão do usuário): o Tenor não vê o IP de quem assiste.

**Critérios:**
- [ ] Sem `TENOR_API_KEY` no servidor, o botão some (`features`).
- [ ] A mensagem leva só o id do GIF; o servidor e o app validam o formato. Nenhuma URL arbitrária vira imagem.
- [ ] O app só carrega GIFs do próprio servidor (sem abrir domínio novo na CSP de `img-src`, além do endereço do servidor); o servidor guarda um cache pequeno.
- [ ] O GIF respeita "Animações: Desligado" (mostra parado).

**Verificação:**
- [ ] `npm test`: validação do id, servidor sem chave.
- [ ] Manual com uma chave de teste.

**Depende de:** chat da call (já existe); para os canais, T7 · **Arquivos:** `signaling-server/src/gifs.js` (novo), `server.js`, `ui/gif-picker.js` (novo), `ui/chat-panel.js`, `ui/markdown.js`, `tauri.conf.json` · **Tamanho:** M

## Checkpoint 4
- [ ] GIF na call e num canal; sem chave, o botão some; revisão com o usuário.

## Release 0.5.0
- [ ] Docs (ARQUITETURA 4 e 10, CONTINUAR, guia do servidor com `DATA_DIR` e `TENOR_API_KEY`), versão, tag, notas.
- [ ] Instalador testado numa máquina ou conta de teste; app 0.4.3 contra o servidor 0.5 e o contrário.
