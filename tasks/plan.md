# Plano: Jay-C 0.5 — servidores com salas, canais de texto e GIFs

## Visão geral

Hoje, cada servidor (IP) só tem salas efêmeras: o app manda `join` com um nome, a sala nasce ali e some quando esvazia. Não há lista de salas, senha, canais de texto nem histórico.

Na 0.5, cada servidor vira um "servidor" no estilo Discord. Referência visual: a janela de teste do chat.
- **Coluna de servidores** à esquerda (os IPs salvos).
- **Lista de canais:** salas de call e canais de texto.
- **Área principal:** um canal de texto ou a call em tela cheia.
- **Membros** à direita.

**Como a call se comporta:**
- Quem entra numa call aparece embaixo dela na lista de canais.
- Um painel "conectado" fica embaixo, e a pessoa pode ler um canal de texto enquanto fala.
- Clicar na call abre a visão de hoje.

**Salas:**
- Uma sala pode ter senha (ícone de cadeado).
- Uma sala com senha pode ficar invisível, e aí só se entra digitando o nome dela.
- **DC (direct call):** entrar direto numa sala pelo nome, sem abrir o servidor. Funciona como uma sala invisível do servidor e mantém o caminho de hoje.

**Também entram:**
- GIFs do Tenor em todos os chats (call e canais).
- O estado de mute e deafen fica salvo entre calls.
- O deafen silencia só as vozes da call, não as lives.

## Como funciona hoje (o que o plano reaproveita)

- **Servidor:**
  - `signaling-server/src/rooms.js` (`RoomRegistry`, salas em memória);
  - `server.js` (mensagens `join`, `chat`, `profile`, `screen-preview`, `leave` e as requisições do SFU);
  - `sfu-room.js` (um router do mediasoup por sala).
  - O `joined` já traz `features`, para o app saber o que o servidor aceita. É assim que a 0.5 convive com servidores e apps 0.4.
- **App:**
  - `ui/lobby.js` (endereço do servidor, nome da sala, salas recentes);
  - `ui/app-shell.js` (lobby ↔ call);
  - `ui/call-view.js`;
  - `ui/chat-panel.js` + `ui/markdown.js` (chat da call);
  - `core/call.js` (`toggleMic`, `toggleDeafen`);
  - `core/playback.js` (um barramento `voices` para vozes e lives; o deafen zera esse barramento);
  - `store/settings.js` (`serverAddress`, `lastRoom`, `recentRooms`).
- **CSP do app** (`tauri.conf.json`): `img-src 'self' data: blob:`. GIFs remotos exigem mudar isso.

## Decisões de arquitetura (com as respostas do usuário, no fim)

1. **Duas conexões, não uma:**
   - Uma "sessão de servidor" (WebSocket) que fica aberta enquanto o servidor está selecionado: lista de salas, quem está em cada uma, canais de texto.
   - A call continua usando o fluxo de hoje (`join` + SFU).
   - Isso mantém a call isolada (a reconexão dela já funciona) e deixa um app 0.4 entrar por DC num servidor 0.5 sem mudar nada.
2. **Compatibilidade:**
   - O servidor 0.5 anuncia `server-session` em `features`.
   - Um app 0.5 num servidor 0.4 mostra só o DC.
   - Um app 0.4 num servidor 0.5 continua entrando por nome (a sala aparece na lista dos outros, a não ser que seja invisível).
3. **Senha:**
   - O servidor guarda só o hash (`scrypt` do Node, com sal).
   - O `join` de uma sala com senha leva `password`.
   - Tentativas erradas têm limite por IP (o `rate-limit.js` já existe).
   - A senha nunca vai para logs nem para os outros.
4. **Persistência:** um arquivo JSON no servidor (`DATA_DIR`, padrão `./data`, com um volume no `docker-compose`) com as salas fixas, os canais de texto e o histórico deles. Sem banco de dados.
5. **Deafen só da call:** o `playback.js` ganha um barramento separado para o som das lives (`screen-audio`), que o deafen não toca.
6. **GIFs:**
   - A busca e a imagem passam pelo servidor (`TENOR_API_KEY` no servidor; sem a chave, o botão de GIF some).
   - A mensagem leva só o id do GIF, validado.
   - O servidor guarda um cache pequeno das imagens.
7. **Gerenciar o servidor:** `ADMIN_KEY` no servidor; o app manda a chave numa mensagem `admin` da sessão de servidor, e só então os pedidos de criar, editar e apagar valem. A chave nunca vai para logs.

## Grafo de dependências

```
T1 deafen só da call ─┐
T2 estado salvo ──────┤ (independentes, entram já)
                      │
T3 sessão de servidor + lista de salas ──┬── T4 senha e invisível ──┬── T5 salas fixas (persistência)
                                         │                          └── T8 DC (sala invisível)
                                         ├── T6 canais de texto (servidor) ── T7 canal de texto na UI
                                         └── T9 shell estilo Discord ── T10 call encaixada ── T11 membros + celular
T12 GIFs: depende só do chat da call (já existe); estende para os canais depois de T7
```

## Fases e tarefas

Cada tarefa termina testável, com commit, resumo e pergunta antes da próxima (o ritmo do projeto).

### Fase 0: coisas pequenas e independentes
- **T1** Deafen silencia só as vozes da call (S)
- **T2** Mute e deafen salvos entre calls (S)

**Checkpoint:** testes passam; deafen medido no alto-falante (`output_meter`) com uma live tocando.

### Fase 1: o servidor com salas
- **T3** Sessão de servidor e lista de salas ativas (M)
- **T4** Sala com senha (cadeado) e invisível (M)
- **T5** Salas fixas, guardadas em disco (M)

**Checkpoint:**
- dois apps e um app 0.4 no mesmo servidor;
- a lista atualiza ao vivo;
- senha certa e errada;
- sala invisível não aparece e entra pelo nome;
- o servidor reiniciado mantém as salas fixas.

### Fase 2: canais de texto
- **T6** Canais de texto no servidor, com histórico (M)
- **T7** Canal de texto na interface (M)

**Checkpoint:** mensagens chegam ao vivo e o histórico volta depois de reiniciar o servidor e o app.

### Fase 3: o layout estilo Discord
- **T8** DC: entrar direto numa sala pelo nome (S)
- **T9** Shell nova: coluna de servidores, lista de canais e área principal (L, a parte de mais risco; ver os riscos)
- **T10** Call encaixada: painel "conectado" e clicar na call para ampliar (M)
- **T11** Membros à direita e layout de celular (Android) (M)

**Checkpoint:**
- fluxo completo no desktop: servidor → canal de texto → call → ler texto falando → voltar à call;
- o mesmo no emulador Android;
- contraste (`contrast-audit.js`) nos 6 combos de estilo;
- nenhuma regressão na live.

### Fase 4: GIFs
- **T12** GIFs do Tenor nos chats (M)

**Checkpoint:** buscar, mandar e ver um GIF no chat da call e num canal de texto; sem chave, o botão some.

### Release 0.5.0
- Documentação (ARQUITETURA seção 4 e 10, CONTINUAR, guia de configuração do servidor com `DATA_DIR` e `TENOR_API_KEY`), versão, tag e notas.
- Teste do instalador numa máquina ou conta de teste.

## Riscos e mitigação

| Risco | Impacto | Mitigação |
|---|---|---|
| A shell nova (T9–T11) mexe em tudo que o usuário vê, inclusive no Android | Alto | Fazer cedo dentro da fase 3; manter `call-view.js` intacto (só muda onde ele é montado); medir contraste e testar no emulador em cada tarefa |
| A API do Tenor (chave, cotas, se ainda aceita chaves novas) | Médio | Verificar antes de T12 (não verifiquei); sem chave, o recurso some e nada quebra |
| GIFs pelo servidor gastam a banda de quem hospeda | Baixo | Cache pequeno no servidor e a versão menor do Tenor (a de pré-visualização) no chat |
| Salas invisíveis só por nome: um nome curto é fácil de adivinhar | Baixo | Invisível exige senha (como no pedido); limite de tentativas por IP |
| Persistência em JSON corromper numa queda | Médio | Gravar num arquivo temporário e renomear; testar com o servidor sendo morto no meio |
| App 0.4 com servidor 0.5 e o contrário | Médio | `features`; teste com o instalador 0.4.3 (numa conta de teste) contra o servidor novo |
| `call.js` já tem ~1.100 linhas | Médio | A sessão de servidor vai num módulo próprio (`core/server-session.js`), sem crescer o `call.js` |

## Decisões do usuário (08/11/2026)

1. **Quem gerencia:** só quem hospeda. O servidor tem uma `ADMIN_KEY` (variável de ambiente); o app guarda a chave por servidor, depois de digitada uma vez. Só com ela dá para criar, editar e apagar salas e canais e pôr senha. Sem `ADMIN_KEY`, ninguém gerencia (o servidor só tem DC).
2. **Salas fixas:** as salas de call existem mesmo vazias e ficam guardadas no servidor. Uma sala aberta pelo nome (DC, ou um app 0.4) é temporária e invisível.
3. **Histórico:** as últimas 500 mensagens de cada canal de texto ficam no disco do servidor. O chat da call continua sem histórico.
4. **GIFs pelo servidor:** o servidor busca no Tenor (com a `TENOR_API_KEY` dele) e repassa a imagem. O Tenor não vê o IP de quem assiste, e a CSP do app não precisa abrir domínio nenhum.

## Perguntas ainda abertas (não bloqueiam a fase 0 nem a 1)

5. **Coluna de servidores:** é a lista de endereços salvos (hoje `serverAddress` é um só)? Proposta: sim, com o endereço de hoje migrado como o primeiro.
6. **Senha também para canais de texto,** ou só para salas de call? Proposta: só salas de call.
7. **Invisível só com senha** (como entendi do pedido), ou pode haver sala fixa invisível sem senha? Proposta: só com senha.
