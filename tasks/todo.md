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

## Checkpoint 3 (08/11/2026, no notebook: RTX 3050 + Intel UHD, Samsung SM-S711B pelo cabo)
- [x] **Desktop** (app de dev, perfil de teste, servidor de teste com 2 salas, 2 canais e 30 mensagens, um bot no painel do navegador com câmera e live): #papo com o histórico → mensagem → call "geral" → assistir a live do bot → #papo durante a call → mensagem → voltar pelo painel de voz.
  - A call fica no DOM com `hidden`, e os consumers são os mesmos do começo ao fim.
  - Com a call escondida, a live do bot seguiu: 262 → 668 pacotes, `<video>` sem pausar, quadros subindo.
  - **Falar lendo:** o mic real deste PC está mudo no Windows (−141 dBFS no `mic_open`). No lugar, o Jay-A falso (`fake_jay_a --pipe jay-a-link-cp3`, com `JAYC_JAY_A_PIPE` e um `JAYC_JAY_A_EXE` inexistente, para não tocar no Jay-A do usuário) mandou um tom de 440 Hz. O bot recebeu 50 pacotes/s e 32 kbps com a call visível e também escondida.
- [x] **Celular** (no lugar do emulador, a pedido do usuário; `android-dev.ps1 --host <IP do Wi-Fi>`): o mesmo fluxo pelas gavetas.
  - Escolher um canal fecha a gaveta, e a call fica no DOM.
  - Com a call escondida, a live do bot seguiu: 99 → 249 quadros, sem pausar. Sem rolagem lateral.
  - O mic do celular chega ao bot igual com a call visível e escondida (50 pacotes/s, 27–30 kbps).
  - Uma vez, logo depois de clicar em "Assistir live", o consumer de áudio do bot foi trocado (renovação do `catch-up.js`). Não se repetiu em 36 s visível, escondida e visível de novo, com o log interceptado e a página sempre `visible`. A causa não foi confirmada.
- [x] **Contraste:** nenhuma falha.
  - Desktop: 6 combos × 3 telas (#papo com a lista, o painel de voz e os membros: 54 textos; a call: 28; Chamada direta: 37).
  - Celular, Calmo escuro: #papo, gaveta de canais, gaveta de membros e call.
- [x] **Live:** a live do bot (navegador) toca para o app e para o celular. A live nativa não abria neste notebook; corrigida (ver "Bugs"). Depois: 1080p, 0 perdas e 0 congelamentos para quem assiste. A CPU não é comparável com a da NVIDIA (build debug, outra placa).
- [ ] Revisão com o usuário.

## Fase 4: GIFs, imagens e vídeos

### [ ] T12: GIFs, zoom na câmera e o celular
Em partes, cada uma com commit e pergunta antes da próxima. A ordem sugerida começa pelo que o usuário viu quebrado no celular (D–G) e deixa os GIFs (A), que dependem da chave do Tenor, para o fim. As partes B a G foram pedidas pelo usuário em 08/11/2026.

#### [ ] T12.A: GIFs do Tenor nos chats
Um botão de GIF no campo do chat (call e canais) abre a busca do Tenor e manda o GIF escolhido. A busca e as imagens passam pelo servidor (decisão do usuário): o Tenor não vê o IP de quem assiste. Antes de começar: conferir se a API do Tenor ainda aceita chaves novas.

**Critérios:**
- [ ] Sem `TENOR_API_KEY` no servidor, o botão some (`features`).
- [ ] A mensagem leva só o id do GIF; o servidor e o app validam o formato. Nenhuma URL arbitrária vira imagem.
- [ ] O app só carrega GIFs do próprio servidor (sem abrir domínio novo na CSP de `img-src`, além do endereço do servidor); o servidor guarda um cache pequeno.
- [ ] O GIF respeita "Animações: Desligado" (mostra parado).

**Verificação:**
- [ ] `npm test`: validação do id, servidor sem chave.
- [ ] Manual com uma chave de teste.

**Depende de:** chat da call (já existe); para os canais, T7 · **Arquivos:** `signaling-server/src/gifs.js` (novo), `server.js`, `ui/gif-picker.js` (novo), `ui/chat-panel.js`, `ui/markdown.js`, `tauri.conf.json` · **Tamanho:** M

#### [ ] T12.B: Focar a câmera de alguém e dar zoom
Ampliar a câmera (ou a live) de outra pessoa só para si, sem mudar o que ela manda. **Primeiro a câmera entra em foco, como uma live já entra** (pedido do usuário em 08/11/2026): clicar no card da câmera a deixa grande no palco, com os outros cards ao lado, e clicar de novo volta à grade. O zoom só existe com a câmera em foco.

**Critérios:**
- [ ] Focar uma câmera funciona como focar uma live (o mesmo layout, o clique e o Enter com o card em foco de teclado, a View Transition com as animações ligadas). Uma live e uma câmera não ficam em foco ao mesmo tempo: focar uma tira o foco da outra.
- [ ] Desktop, com a câmera em foco: roda do mouse (ou + e − no menu do botão direito) amplia e reduz; arrastar move a parte ampliada; "Zoom normal" no menu (ou a tecla 0) volta. O duplo clique fica como na live: tela cheia, onde o zoom também vale. Sair do foco volta o zoom a 1×.
- [ ] Celular: tocar no card foca; com o foco, pinça com dois dedos amplia e arrasta; dois toques voltam ao 1×.
- [ ] Vale para um card por vez e não muda o tamanho do card; some quando a câmera desliga ou a pessoa sai.
- [ ] Teclado: + e − com o card em foco, e o nível do zoom anunciado ao leitor de tela.

**Verificação:**
- [ ] `npm test`: a conta do zoom (limites de 1× a 4×, a área visível nunca sai do vídeo).
- [ ] Manual: desktop com a roda e o arraste reais (CDP), e no celular com toques reais (`adb shell input` ou CDP `Input.dispatchTouchEvent`).

**Arquivos:** `ui/call-view.js` (o card), `core/zoom.js` (novo, a conta), `ui/audio-menu.js` (o menu do botão direito), `styles/` · **Tamanho:** M

#### [x] T12.C: Deslizar abre as gavetas no celular
**Feito (08/11/2026):**
- **A regra:** `core/swipe.js` (`swipeDrawer`, com testes). Conta só um gesto de ≥ 60 px, ≥ 1,5× mais de lado que para cima ou para baixo, em ≤ 600 ms. Sem gaveta aberta, para a direita abre os canais e para a esquerda os membros; o sentido contrário fecha a aberta.
- **A ligação:** `ui/app-shell.js` ouve `touchstart`/`touchend` (passivos) na shell, só no layout de celular (≤ 599 px), e chama o mesmo `setDrawer` do botão. O Voltar do Android e o `inert` continuam iguais.
- **Fica de fora:** um gesto que começa na barra da call (que arrasta), num controle deslizante, numa fileira que rola para o lado ou em algo com `data-no-swipe` (o zoom da T12.B vai usar).
- **Sem acompanhar o dedo:** a gaveta abre com a animação de sempre (nenhuma com as animações desligadas).
- **Medido no app de dev a 375×812, com toques reais pelo CDP (`Input.dispatchTouchEvent`):**
  - para a direita abre os canais, de novo continua aberta, para a esquerda fecha;
  - para a esquerda abre os membros, para a direita fecha;
  - curto (40 px), diagonal para baixo e lento (1 s): nada;
  - com a gaveta aberta, a área principal fica `inert`;
  - na call, o gesto que começa na barra não abre a gaveta, e o que começa no palco abre.
- **Não testado num celular de verdade:** ele estava fora do USB.

Um gesto de deslizar abre a gaveta da esquerda (coluna dos servidores, "Chamada direta", calls e canais), como o botão ☰ de hoje.

**Critérios:**
- [ ] **Direção (decidida pelo usuário em 08/11/2026, como no Discord):** deslizar o dedo **para a direita** abre a gaveta da esquerda (servidores, "Chamada direta", calls e canais). Deslizar **para a esquerda** abre a de membros.
- [x] Deslizar de volta fecha. O gesto não briga com a rolagem vertical (só conta se for mais de lado que para cima ou para baixo) nem com o zoom da T12.B e a barra arrastável da call.
- [x] Respeita "Animações: Desligado" (a gaveta abre sem acompanhar o dedo).

**Verificação:**
- [ ] `npm test`: a regra do gesto (distância, ângulo, borda).
- [ ] Manual no celular, com toques reais.

**Arquivos:** `ui/app-shell.js` (gavetas), `core/swipe.js` (novo), `styles/` · **Tamanho:** S

#### [x] T12.D: Botões sem seleção de texto no celular
Segurar um botão no celular seleciona o texto dele (e o Android mostra o menu de copiar).

**Feito (08/11/2026):**
- **Onde acontecia:** o usuário viu nas Configurações. No lobby, um toque longo de 1 s em 4 botões não selecionava nada.
- **A causa (medida na WebView):** o `<dialog>` fica na top layer e não herda o `user-select: none` do `body`. A cadeia era `BODY none → DIV none → DIALOG text`, e tudo dentro dele (abas, botões, rótulos, dicas) vinha `text`.
- **A correção:** `dialog, [popover] { user-select: none }` em `styles/app.css`. Os popovers (painel da live, menu do botão direito) também estão na top layer.
- **Medido no Samsung SM-S711B, com toques longos reais nas Configurações, no comportamento antigo e com a correção:**
  - aba "Perfil": selecionava "Perfil" → nada;
  - botão "Escolher foto": "Escolher" → nada;
  - dica: "quando" → nada;
  - opção "Sólida": cursor de texto → nada.
- **Continua selecionável:** o campo do nome e o Markdown do guia (computado `text`). O usuário confirmou no celular.
- **Desktop (Chromium no painel):** o diálogo e as abas também computam `none`. O arraste real não foi possível, porque o painel estava escondido.
- O `-webkit-touch-callout` não existe no Chromium: não foi preciso.

**Critérios:**
- [x] Segurar qualquer botão, aba ou item da lista não seleciona texto nem abre o menu do sistema (`-webkit-user-select`, `-webkit-touch-callout`).
- [x] Campos de texto, mensagens do chat e o guia continuam selecionáveis (como no desktop, 0.3.4).

**Verificação:** manual no celular (toque longo real) e no desktop (o arraste da 0.3.4 continua sem selecionar).

**Arquivos:** `styles/app.css` · **Tamanho:** S

#### [x] T12.E: Feedback de toque, sem o realce azul
Tocar ou segurar um botão no celular pinta o retângulo azul do Android (`-webkit-tap-highlight-color`), e não há outro sinal de que o toque pegou.

**Feito (08/11/2026):**
- **O realce azul:** `-webkit-tap-highlight-color: transparent` no `html`.
- **O retorno no lugar dele:** tudo o que é clicável (`button`, `[role=tab]`, `[role=button]`, as opções `.segmented` e links), enquanto pressionado, ganha uma camada escura sobre o fundo e embaixo do texto (`--press-overlay`). Com as animações ligadas, também encolhe para 0,97. A barra da call fica com o próprio pulo (`scale(0.9)`).
- **Por que escurecer:** a primeira versão usava uma camada da cor do texto a 12%. Ela puxava o fundo para o texto, e o Suave caiu para 4,09 (claro) e 4,40 (escuro) nos rótulos discretos.
- **Intensidade por tema:**
  - escuro, 18%: num fundo escuro com texto claro, escurecer aumenta o contraste (Neon escuro: 6,74 → 6,99);
  - claro, 5%: no claro, escurecer diminui o contraste, então fica fraca.
- **Contraste pressionado:** o `contrast-audit.js` não enxerga a camada. Medido com um script que compõe o fundo real + a camada contra a cor do rótulo, nos 6 combos (lobby e Configurações › Aparência no celular): nenhuma falha. O pior caso é 4,60 (Suave claro, a pílula do servidor), e o botão de destaque fica em 4,99 no Calmo escuro.
- **Medido no Samsung com o dedo de verdade** (`adb input swipe` parado em "Entrar na sala", Calmo escuro):
  - durante o toque: `:active`, a camada de 18%, `scale: 0.97` e o realce transparente; ao soltar, tudo volta;
  - o pixel do botão: `rgb(170,139,255)` parado e `rgb(153,133,209)` com o dedo.
- **Visto e não tratado:** o `:hover` "gruda" depois de um toque no celular, até tocar em outro lugar. Num botão de destaque, o hover é mais claro.

**Critérios:**
- [x] Sem o retângulo azul em nenhum botão.
- [x] No lugar, um retorno próprio no estilo: o botão escurece ou encolhe um pouco enquanto o dedo está nele (`:active`), nos 3 estilos e nos dois temas. Com "Animações: Desligado", sem movimento, só a cor.
- [x] O contraste continua ≥ 4,5:1 no estado pressionado.

**Verificação:** manual no celular; `contrast-audit.js` com o estado pressionado forçado (CDP `CSS.forcePseudoState`).

**Arquivos:** `styles/app.css` · **Tamanho:** S

#### [ ] T12.F: Fechar o PiP não fecha o app (Android): implementada, falta testar num aparelho
**Medido antes (08/11/2026, Samsung pelo cabo, app de dev):**
- **Fechar o PiP pelo X não matou o processo** (mesmo pid). A activity ficou escondida (`setForceHidden`), a call seguiu conectada, e abrir pelo ícone voltou à mesma call, sem recarregar.
- **O mic foi calado em ~15 s** (50 → 13,75 → 4,5 pacotes/s).
- **O "fecha o app" do relato** bate com o recarregamento do modo dev pelo Wi-Fi. Não testado num APK instalado.

**Implementado (decisão do usuário: notificação durante a call):**
- **`CallService` (plugin `pip`):** serviço em primeiro plano do tipo `microphone`. A notificação diz "Em call em #sala", com "Ligar/Desligar microfone" e "Sair da chamada", e um toque abre o app. Os textos vêm traduzidos da página.
- **Ciclo de vida:** o `core/activity-pip.js` inicia o serviço com o PiP da call, atualiza o rótulo em `setState({ micOn })` e para no `destroy`. Os botões chegam à página pelo evento `callAction`.
- **WebView:** com o serviço rodando, ela não é pausada quando o PiP fecha.
- **Permissões no manifest do plugin:** `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE` e `POST_NOTIFICATIONS`. A última é pedida uma vez no Android 13+; negada, o serviço roda e só a notificação some.
- **Compila:** o build Android passa e o `npm test` também. **Nada foi testado num aparelho:** o celular caiu do USB, e o emulador fechou sozinho durante a instalação.

**Testes pendentes (combinado com o usuário: depois):**
- [ ] A notificação aparece na call, e o serviço roda (`dumpsys activity services`).
- [ ] Fechar o PiP: o mic segue chegando ao bot, e `dumpsys audio` não marca a captura como `silenced`.
- [ ] Botões da notificação: o Mutar muda o mic no app e o rótulo, e o Sair encerra a call, o serviço e a notificação.
- [ ] Sair pelo app e trocar de sala (parar e iniciar em seguida): o serviço não fica preso nem duplicado.
- [ ] Permissão de notificação negada: o serviço roda mesmo assim.
- [ ] App morto no meio da call: nenhuma notificação fantasma.
- [ ] Voltar durante a call (T12.G) com o serviço.
- [ ] Um APK instalado, fora do modo dev: fechar o PiP não fecha o app.
Visto pelo usuário em 08/11/2026 (Samsung SM-S711B, Android 16): fechar a mini-janela da live fecha o app inteiro. Deveria mandar o app para segundo plano, com a call seguindo (o som continua, e o app volta na mesma tela). No logcat, ao fechar: `stopped(true)` na activity e `pipModeChanged active=false`. No modo dev, a página perdeu a conexão com o Vite e recarregou ao voltar, e a call caiu: separar o que é do PiP e o que é só do Vite (testar também num APK que não seja dev).

**Critérios:**
- [ ] Fechar o PiP: o processo continua, a call continua (o outro lado ainda recebe o mic) e abrir o app volta à call.
- [ ] Se o Android matar o processo de qualquer jeito, abrir de novo não deixa uma call fantasma.

**Verificação:** manual no celular, com o logcat e um bot medindo os pacotes do mic do celular depois de fechar o PiP.

**Achado na T12.G (08/11/2026), importante aqui:** com o app em segundo plano (sem PiP), a call mantém a conexão, mas o Android cala o mic em segundos. Medido no Samsung: 50 → 5 pacotes/s (silêncio do Opus) entre 0–4 s e 10–14 s depois; voltando ao app, 50 de novo. No PiP, fica em 50. Então "fechar o PiP sem derrubar a call" provavelmente precisa de um serviço em primeiro plano do tipo `microphone` (com notificação), senão a call segue muda. Medir antes de decidir.

**Arquivos:** `plugins/tauri-plugin-pip` (Kotlin), talvez `gen/android` (`MainActivity`) · **Tamanho:** M

#### [x] T12.G: Voltar manda o app para segundo plano (Android)
**Feito (08/11/2026), medido no Samsung SM-S711B (Android 16):**
- **O que acontecia:** o `AppPlugin` do Tauri volta no histórico da página (gavetas, tela cheia). Sem histórico, ele chama `activity.onBackPressed()`, a activity termina, e o processo morreu junto (`has died`, logcat). O `FORTIFY` não apareceu desta vez.
- **A correção, fora da call:** `MainActivity.kt` registra um `OnBackPressedCallback` que chama `moveTaskToBack(true)`. Ele só roda quando o `AppPlugin` passa o Voltar adiante, porque os callbacks rodam do mais novo para o mais velho e o do Tauri entra depois.
- **A correção, durante a call:** só mandar para segundo plano calava o mic em segundos (50 → 5 pacotes/s), enquanto o Home, que entra no PiP, o mantinha em 50. Agora, com a entrada automática no PiP armada (call aberta), o Voltar entra no PiP como o Home (`PipPlugin.enterForBack`).
- **Medido:**
  - com uma gaveta aberta, o 1º Voltar fecha a gaveta e o app fica na frente;
  - o 2º Voltar manda para segundo plano, com o mesmo pid; ao abrir de novo, a mesma página (um marcador no `window` sobreviveu) e sem recarregar;
  - Voltar durante a call: entra no PiP, e o bot recebe o mic do celular a 50 pacotes/s de 0–4 s e de 10–14 s depois;
  - 10 ciclos de Voltar e reabrir fora da call: 10/10 em segundo plano com o mesmo pid, 0 crashes (`FORTIFY` e `Fatal signal`), 0 mortes de processo, 0 PiP.


O Voltar na tela inicial do app (sem gaveta aberta) fecha o app inteiro. Deveria mandar para segundo plano, como o Home, sem fechar (e, durante uma call, sem derrubar a call). Visto também 1 vez um crash nativo ao fechar assim (`FORTIFY: pthread_mutex_lock called on a destroyed mutex`, 08/11/2026).

**Critérios:**
- [x] Voltar sem nada para fechar: o app vai para segundo plano (`moveTaskToBack`), e o processo continua.
- [x] O Voltar continua fechando gavetas, diálogos e o chat antes disso (T11).
- [x] O crash não aparece no logcat em 10 saídas seguidas.

**Verificação:** manual no celular com `adb shell input keyevent KEYCODE_BACK` e o logcat.

**Arquivos:** `gen/android` (`MainActivity`) ou um plugin, `ui/app-shell.js` (o histórico das gavetas) · **Tamanho:** S

### [ ] T13: Imagens e vídeos nos chats
Pedido do usuário (08/11/2026). Um botão de anexo (e colar ou arrastar) no campo do chat (call e canais) manda uma imagem ou um vídeo, que aparece na mensagem: a imagem abre maior com um clique, e o vídeo toca ali mesmo. O arquivo vai para o servidor, e o app só carrega mídia do próprio servidor. As decisões (onde ficam, limites, quanto tempo) estão no `plan.md`, item 8, respondidas pelo usuário em 08/11/2026.

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
- [ ] No celular: zoom numa câmera, deslizar abre e fecha as gavetas, botões sem seleção nem realce azul e com retorno de toque, o PiP e o Voltar mandam para segundo plano com a call seguindo.
- [ ] Imagem e vídeo nos dois chats; tipo ou tamanho errado é recusado.
- [ ] Revisão com o usuário.

## Release 0.5.0
- [ ] Docs (ARQUITETURA 4 e 10, CONTINUAR, guia do servidor com `DATA_DIR` e `TENOR_API_KEY`), versão, tag, notas.
- [ ] Instalador testado numa máquina ou conta de teste; app 0.4.3 contra o servidor 0.5 e o contrário.

## Bugs para corrigir depois

- [x] **Live nativa não abre num notebook com duas placas (NVIDIA + Intel).** Corrigido em 08/11/2026: o codificador da NVIDIA não inicia nem com um device na NVIDIA; o app tenta os codificadores na ordem e usa o primeiro que inicia e aceita o device (aqui, o Intel Quick Sync, com a troca de tipo de saída aceita). Ver `docs/spikes/10-live-nativa.md`. Relato original: Visto em 08/11/2026 no notebook do usuário (RTX 3050 Laptop + Intel UHD, i5-13420H): `native live: H.264 encoder: Falha catastrófica (0x8000FFFF)`, e o app cai no seletor do sistema. Hipótese, não medida: o `create_device` (`native_live/mod.rs`) cria o D3D11 no adaptador padrão, e o `encoder.rs` pega o primeiro codificador H.264 de hardware da lista (`found[0]`) sem conferir se ele é do mesmo adaptador. Com dois codificadores, o `MFT_MESSAGE_SET_D3D_MANAGER` recebe um device de outra placa. Correção provável: escolher o codificador cujo `MFT_ENUM_ADAPTER_LUID` é o do adaptador do device, ou criar o device no adaptador do codificador. Antes, medir os LUIDs. A live nativa só tinha sido testada num PC com a NVIDIA sozinha.

- **Android: fechar o PiP fecha o app inteiro:** movido para a T12.F.
- **Android: o Voltar fecha o app (e uma vez derrubou o processo):** movido para a T12.G.
