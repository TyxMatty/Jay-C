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

### [x] T3: Sessão de servidor, salas fixas e a lista ao vivo
Uma conexão `hello` (nome, foto, cor) que não entra em call recebe as salas fixas visíveis (lidas de `DATA_DIR/rooms.json`) e quem está em cada uma, atualizadas ao vivo. O `join` de hoje continua igual. O lobby mostra a lista e entra numa sala com um clique. (Replanejada: as salas fixas vêm do arquivo já aqui, porque as temporárias nunca aparecem na lista.)

**Critérios:**
- [x] `hello` → `server-state` (salas visíveis, participantes), depois `room-update` (entrou, saiu, foto) e `room-peer` (mic, live).
- [x] O `joined` anuncia `server-session` em `features`; o app 0.5 num servidor 0.4 esconde a lista (uma conexão, sem tentar de novo).
- [x] Uma sala que não está no arquivo (DC, app 0.4) e a sala invisível nunca aparecem.

**Verificação:**
- [x] `npm test`: hello, lista, atualização, mic, saída, salas fora da lista (servidor 22, frontend 92).
- [x] Manual: app de dev e um bot de navegador; contraste no lobby.

### [x] T4: Admin gerencia as salas
Com a `ADMIN_KEY` do servidor (digitada uma vez no app e guardada por servidor), dá para criar, renomear e apagar salas fixas, pôr ou tirar senha e, com senha, deixar a sala invisível. As mudanças vão para o `rooms.json` (gravação atômica) e para a lista de todos na hora.

**Critérios:**
- [ ] Sem a chave certa, os pedidos são recusados (`not-admin`); sem `ADMIN_KEY` no servidor, ninguém gerencia. A chave nunca vai para logs.
- [ ] O servidor guarda só o hash da senha (`scrypt` + sal).
- [ ] A gravação é atômica (temporário + rename); reiniciar mantém tudo; no Docker, `./data` precisa ser gravável pelo usuário do container (documentar).

**Verificação:**
- [ ] `npm test`: admin certo e errado, criar, renomear, apagar, gravar e reler.
- [ ] Manual: gerenciar pelo app; matar o servidor no meio de uma gravação.

**Depende de:** T3 · **Arquivos:** `directory.js`, `server.js`, `config.js`, `ui/` (tela de admin), testes · **Tamanho:** M

### [x] T5: Entrar numa sala com senha (cadeado) e na invisível
Na lista, a sala com senha mostra o cadeado e pede a senha; a invisível entra pelo nome (com a senha).

**Critérios:**
- [ ] O `join` sem senha ou com a senha errada é recusado com `wrong-password`; as tentativas erradas têm limite por IP.
- [x] A senha não é lembrada entre calls (fica só na memória da call) e nunca vai para logs.
- [ ] Reconectar no meio da call (queda do servidor) reenvia a senha.

**Verificação:**
- [ ] `npm test`: senha certa, errada, limite, invisível pelo nome.
- [ ] Manual: o cadeado e o pedido de senha no app, nos dois temas e nos 3 estilos.

**Depende de:** T4 · **Arquivos:** `server.js`, `directory.js`, `rate-limit.js`, `core/signaling.js`, `ui/lobby.js`, `ui/icons.js`, testes · **Tamanho:** M

## Checkpoint 1 (08/11/2026)
- [x] Salas fixas ao vivo, admin, senha e invisível: testes do servidor (28) e app de dev com bot.
- [x] Reinício: o `rooms.json` é relido (teste do `directory`); gravação atômica.
- [x] Cliente 0.4 (só `join`): coberto pelo teste do servidor; não rodei o instalador 0.4.3 contra o servidor novo. Um app 0.4 não entra numa sala com senha (não tem como mandá-la).
- [x] `docs/ARQUITETURA.md` seção 4 (e a versão em inglês) atualizada.
- [ ] Revisão com o usuário.

## Fase 2: canais de texto

### [x] T6: Canais de texto no servidor, com histórico
Canais de texto por servidor: listar, criar e apagar (admin), mensagens ao vivo para quem está na sessão de servidor e as últimas 500 mensagens de cada canal guardadas.

**Critérios:**
- [ ] `server-state` traz os canais; `channel-message` chega a todos na sessão.
- [ ] `channel-history` devolve as últimas mensagens (paginação simples por id) e sobrevive a um reinício.
- [ ] Mesmo limite e limpeza do chat de hoje (1–500 caracteres, sem caracteres de controle) e limite de taxa.

**Verificação:**
- [ ] `npm test`: envio, histórico, limite, reinício.

**Depende de:** T3, T5 · **Arquivos:** `server.js`, `store.js`, `signaling-server/src/channels.js` (novo), testes · **Tamanho:** M

### [x] T7: Canal de texto na interface
Abrir um canal de texto mostra o histórico e as mensagens novas; o campo de envio reaproveita o do chat da call (Markdown, quebras de linha).

**Critérios:**
- [ ] Rolar para cima carrega mais histórico; uma mensagem nova rola para baixo só se já estava no fim.
- [ ] Não lidas: um marcador no canal que não está aberto.
- [ ] Contraste ≥ 4,5:1 nos 6 combos.

**Verificação:**
- [ ] `npm test`: o que for lógica pura (agrupar mensagens, não lidas).
- [ ] Manual com dois apps; `contrast-audit.js`.

**Depende de:** T6 · **Arquivos:** `ui/text-channel.js` (novo), `ui/chat-panel.js` (extrair o que for comum), `core/server-session.js`, `core/i18n.js` · **Tamanho:** M

## Checkpoint 2 (08/11/2026)
- [x] Mensagens ao vivo e histórico depois de reiniciar o servidor (encerrado à força) e o app: testado no app de dev com um bot.
- [x] O chat da call igual a antes (a lista de mensagens agora é comum).
- [ ] Revisão com o usuário.

## Fase 3: layout estilo Discord

### [x] T8: DC, entrar direto numa sala pelo nome
O caminho de hoje (endereço + nome da sala) fica como "Direct call". A sala criada assim é temporária e invisível na lista do servidor.

**Critérios:**
- [ ] DC numa sala que não existe cria uma temporária invisível; numa fixa com senha, pede a senha.
- [ ] As salas recentes e o "entrar de novo" continuam funcionando.

**Verificação:**
- [ ] `npm test`: a sala do DC fica fora da lista. Manual.

**Depende de:** T4 · **Arquivos:** `ui/lobby.js`, `rooms.js`, testes · **Tamanho:** S

### [x] T9: Shell nova: coluna de servidores, canais e área principal
O app abre na coluna de servidores salvos. Escolher um mostra os canais (calls com quem está nelas, canais de texto) e a área principal. A call ainda abre como hoje (tela cheia); o encaixe é a T10.

**Critérios:**
- [ ] Servidores salvos (adicionar, remover, reordenar); o ativo é lembrado.
- [ ] Lista de canais com as calls (participantes embaixo, cadeado) e os canais de texto.
- [ ] Teclado e leitor de tela: navegação por Tab e setas, rótulos ARIA. Contraste ≥ 4,5:1.

**Verificação:**
- [ ] `npm test`: lista de servidores no settings, com migração de `serverAddress`.
- [ ] Manual + `contrast-audit.js`, nos dois temas e 3 estilos.

**Depende de:** T3, T4, T7 · **Arquivos:** `ui/app-shell.js`, `ui/server-rail.js` (novo), `ui/channel-list.js` (novo), `store/settings.js`, `styles/` · **Tamanho:** L (se passar de 5 arquivos, separar a coluna de servidores numa tarefa própria)

### [x] T10: Call encaixada
Com a call aberta, dá para ir a um canal de texto e a call continua. Um painel "conectado à voz" embaixo dos canais traz mic, deafen e sair; clicar na call volta à visão de hoje.

**Critérios:**
- [ ] Navegar entre canais não derruba nem renegocia a call (mesmos producers e consumers).
- [ ] O próprio nome aparece embaixo da call na lista, com o estado de mute e deafen.
- [ ] Live, PiP e o tour "Welcome!" continuam funcionando.

**Verificação:**
- [ ] Manual: `getStats()` antes e depois de navegar (os mesmos ids); PiP; live nativa.
- [ ] `npm test`.

**Depende de:** T9 · **Arquivos:** `ui/app-shell.js`, `ui/call-view.js` (só montagem), `ui/voice-panel.js` (novo) · **Tamanho:** M

### [x] T11: Membros à direita e celular
Painel de membros do servidor (online por sala) à direita; no Android (tela estreita), as colunas viram gavetas.

**Critérios:**
- [x] Membros online por sala; quem está em live aparece marcado.
- [x] A 375 px de largura: nada corta, nada rola na horizontal; as gavetas abrem por botão.
- [x] O PiP do Android continua funcionando. Medido num celular (Android 16), com a call na tela e escondida; o vídeo não enchia a janela e foi corrigido.

**Verificação:**
- [x] Manual num celular de verdade (`scripts/android-dev.ps1 --host <IP do PC>`), no lugar do emulador, que não roda neste PC.
- [x] Com `Emulation.setDeviceMetricsOverride` (375 e 360 px), cliques e teclas reais pelo CDP; o Voltar do Android simulado com user agent de Android.

**Depende de:** T10 · **Arquivos:** `ui/members-panel.js` (novo), `ui/app-shell.js`, `styles/` · **Tamanho:** M

## Checkpoint 3
- [ ] Fluxo completo no desktop e no emulador; contraste; live sem regressão; revisão com o usuário.

## Fase 4: GIFs, imagens e vídeos

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

### [ ] T13: Imagens e vídeos nos chats
Pedido do usuário (08/11/2026). Um botão de anexo (e colar ou arrastar) no campo do chat (call e canais) manda uma imagem ou um vídeo, que aparece na mensagem: a imagem abre maior com um clique, e o vídeo toca ali mesmo. O arquivo vai para o servidor, e o app só carrega mídia do próprio servidor. As decisões em aberto estão no `plan.md`, pergunta 8.

**Critérios:**
- [ ] Tipos aceitos conferidos pelo conteúdo (os primeiros bytes), não só pela extensão. O tamanho máximo vem do servidor (`features`), e um arquivo grande demais é recusado antes de subir.
- [ ] A mensagem leva só o id do arquivo no servidor, validado; nenhuma URL arbitrária vira imagem ou vídeo.
- [ ] Imagem com tamanho reservado (sem pular o chat ao carregar); vídeo sem tocar sozinho e sem som até clicar.
- [ ] Arquivos de mensagens que saíram do histórico (ou de uma call que esvaziou) são apagados do disco.
- [ ] Sem espaço no servidor ou com envio desligado pelo host, o botão some ou avisa.

**Verificação:**
- [ ] `npm test`: tipo pelo conteúdo, limite, id inválido, limpeza.
- [ ] Manual: imagem e vídeo nos dois chats, no desktop e no Android; contraste da barra de envio.

**Depende de:** T7 (e T12, se reaproveitar o caminho de mídia pelo servidor) · **Arquivos:** `signaling-server/src/media.js` (novo), `server.js`, `channels.js`, `ui/chat-log.js`, `ui/chat-panel.js`, `tauri.conf.json` (CSP de `img-src`/`media-src`), testes · **Tamanho:** M

## Checkpoint 4
- [ ] GIF na call e num canal; sem chave, o botão some.
- [ ] Imagem e vídeo nos dois chats; tipo ou tamanho errado é recusado.
- [ ] Revisão com o usuário.

## Release 0.5.0
- [ ] Docs (ARQUITETURA 4 e 10, CONTINUAR, guia do servidor com `DATA_DIR` e `TENOR_API_KEY`), versão, tag, notas.
- [ ] Instalador testado numa máquina ou conta de teste; app 0.4.3 contra o servidor 0.5 e o contrário.

## Bugs para corrigir depois

- [ ] **Android: fechar o PiP da live fecha o app inteiro** (visto pelo usuário em 08/11/2026, no Samsung SM-S711B com Android 16). Deveria só mandar o app para segundo plano, com a call seguindo. No logcat, ao fechar a mini-janela: `stopped(true)` na activity e `pipModeChanged active=false`. No modo dev, a página perdeu a conexão com o Vite e recarregou ao voltar, e a call caiu. Falta separar o que é do PiP e o que é só do Vite.
- [ ] **Android: sair pelo Voltar derruba o processo ao fechar.** Visto 1 vez (08/11/2026, mesmo aparelho), com o Voltar no "Chamada direta", sem gaveta aberta: `FORTIFY: pthread_mutex_lock called on a destroyed mutex` no logcat, logo depois de a activity parar. Para quem usa, o app só fecha, mas é um crash nativo.
