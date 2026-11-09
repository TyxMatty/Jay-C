# Hospedar seu próprio servidor do Jay-C

As chamadas passam por um pequeno servidor que **uma** pessoa do grupo roda no PC: quem hospeda. Leva uns 10 minutos, uma vez só. Os outros só se conectam (aba **Conectar**).

- Seu PC precisa estar ligado, com o servidor rodando, pra alguém conseguir entrar.
- O vídeo de todo mundo passa pelo seu PC, então sua velocidade de upload importa (veja o passo 4).

## 1. Instale o servidor

Escolha um jeito. **O Node.js é o mais simples**, e é tudo de que você precisa com Radmin VPN ou ZeroTier.

### Opção A: Node.js (recomendado)

1. Instale o **Node.js** (a versão LTS, 22 ou mais nova) pelo `nodejs.org`.
2. Baixe o código do Jay-C em ZIP: na página dele no GitHub (`github.com/TyxMatty/Jay-C`), clique em **Code › Download ZIP**. Se a página não abrir pra você, peça o ZIP a quem te mandou o Jay-C. Extraia numa pasta **curta**, como `C:\jay-c`. Uma pasta muito funda (como Downloads dentro do OneDrive) quebra a extração, porque alguns caminhos ficam longos demais pro Windows.
3. Abra um terminal na pasta que tem o `package.json` e rode, uma vez:

```
npm install -w signaling-server
```

### Opção B: Docker

Instale o Docker Desktop pelo `docker.com` e abra o programa uma vez. Depois, salve o arquivo `docker-compose.yml` da página de releases do Jay-C numa pasta vazia, como `C:\jay-c`.

![Um PC rodando o servidor do Jay-C dentro do Docker](/assets/setup/step1_docker.svg)

## 2. Ligue o servidor

**Node.js:** na mesma pasta, rode o comando abaixo e **deixe o terminal aberto**. Se você fechar, o servidor para, então rode de novo sempre que for ligar.

```
npm run server
```

Quando aparecer `listening on 0.0.0.0:3000`, está pronto. Se o Windows perguntar se o Node.js pode usar a rede, permita. Pra atualizar depois, baixe o ZIP de novo e repita o passo 1.

**Docker:** abra um terminal na pasta do `docker-compose.yml` e rode:

```
docker compose up -d
```

Na primeira vez, o Docker baixa o servidor (uns 400 MB). Depois disso, ele liga sozinho junto com o Docker. Pra atualizar, rode `docker compose pull` e o mesmo comando de novo.

![O servidor ligando num terminal](/assets/setup/step2_compose.svg)

## 3. Libere as portas

O servidor usa **duas portas**: `3000` (TCP) pra conexão e `40000` (UDP e TCP) pro áudio e o vídeo. Se o firewall bloquear a segunda, os outros conectam, mas ninguém se vê nem se ouve.

No Windows, abra o PowerShell **como administrador** no PC do servidor e rode:

```
New-NetFirewallRule -DisplayName "Jay-C" -Direction Inbound -Protocol TCP -LocalPort 3000,40000 -Action Allow
New-NetFirewallRule -DisplayName "Jay-C media" -Direction Inbound -Protocol UDP -LocalPort 40000 -Action Allow
```

![Portas 3000 e 40000 liberadas no firewall](/assets/setup/step3_firewall.svg)

## 4. Descubra o endereço do servidor

- **Mesma rede (em casa, LAN party):** no PC do servidor, rode `ipconfig` e use o **Endereço IPv4**, como `192.168.1.50`.
- **Pela internet:** todo mundo entra na mesma rede virtual do ZeroTier ou do Radmin VPN, e você usa o endereço do PC do servidor nessa rede. Assim não é preciso abrir portas no roteador.

**Fique de olho no upload.** Todo o vídeo passa pelo PC do servidor, que manda uma cópia pra cada pessoa que assiste. Uma live precisa de uns **5 Mbps de upload por pessoa em 1080p30** e 7,5 Mbps em 1080p60; então, 15 pessoas vendo uma live em 1080p60 precisam de uns 110 Mbps. Numa LAN isso é tranquilo; pela internet, o upload de quem hospeda é o limite. Se a imagem travar pros outros, baixe a qualidade da live.

![Amigos se conectando ao PC do servidor](/assets/setup/step4_address.svg)

## 5. Conecte e chame seus amigos

Nesse PC, abra **Configurações › Servidor** no Jay-C, coloque `localhost:3000`, clique em **Testar** e depois em **Adicionar**. Quando aparecer "Conectou", escolha um nome de sala.

Depois, mande duas coisas pros amigos: o endereço do servidor do passo 4 (como `192.168.1.50:3000`) e o nome da sala. Eles seguem a aba **Conectar**.

## 6. A chave de admin (opcional)

O Jay-C 0.5 em diante mostra as salas e os canais de texto do servidor ao lado dele. Quem tem a **chave de admin** do servidor gerencia tudo pelo app. Sem chave, o servidor funciona como antes, e ninguém muda as salas nem os canais.

**No servidor,** escolha um segredo comprido que só você sabe (como uma senha, com pelo menos 20 caracteres) e ligue o servidor com ele:

- **Node.js:** no PowerShell, `$env:ADMIN_KEY="um-segredo-comprido"; npm run server`. Use o mesmo comando toda vez que ligar: sem a chave, ninguém gerencia o servidor.
- **Docker:** no `docker-compose.yml`, tire o `#` antes de `ADMIN_KEY`, coloque o seu segredo e rode `docker compose up -d` de novo. No Linux, deixe o servidor gravar os dados uma vez: `mkdir -p data && sudo chown 1000:1000 data`.

Pra aparecer um nome no lugar do endereço, defina também `SERVER_NAME` (ex.: `$env:SERVER_NAME="Jogatina"`, ou no `docker-compose.yml`).

[[admin-key-field]]

**No app,** cadastre a chave uma vez em cada computador que vai gerenciar o servidor:

1. Clique no servidor na coluna da esquerda. Uma **engrenagem** aparece ao lado do nome dele, em cima dos canais (só em servidores ligados com chave).
2. Clique na engrenagem, digite a chave em **Chave de admin** e aperte **Desbloquear**.
3. O Jay-C lembra a chave deste servidor e desbloqueia sozinho nas próximas vezes.

- **Chave errada:** "Essa não é a chave de admin deste servidor." Depois de 5 tentativas erradas, o servidor espera 10 s entre uma e outra.
- **Trocar a chave:** ligue o servidor de novo com a nova. Os computadores com a antiga pedem a chave outra vez.
- **Outro admin:** passe a chave pra ele, por uma conversa privada.
- **Num computador compartilhado:** **Esquecer a chave**, no pé das configurações do servidor, tira ela deste computador.

O servidor nunca grava a chave no log nem nos arquivos dele.

## 7. Salas que todo mundo vê

Com a chave cadastrada, abra a engrenagem. Em **Salas de call**:

- **Nova sala:** um nome (letras, números, `-` e `_`) e **Salvar**. Ela aparece na lista pra todo mundo, na hora.
- **Senha** (opcional): a sala mostra um cadeado, e quem entra digita a senha.
- **Invisível** (só com senha): a sala fica fora da lista. Quem quer entrar digita o nome dela em **Chamada direta**.
- **Editar** uma sala muda o nome ou a senha; **Apagar** pergunta de novo antes de apagar. Uma sala com gente dentro não pode mudar de nome.

Uma sala com qualquer outro nome, pela **Chamada direta**, funciona como antes, mas fica fora da lista.

## 8. Canais de texto

Canais de texto são chats que ficam no servidor, pra todo mundo dele, também fora das calls. O servidor guarda as últimas 500 mensagens de cada um.

Com a chave cadastrada, abra a engrenagem. Em **Canais de texto**:

1. **Novo canal:** digite o **Nome do canal** (letras, números, `-` e `_`, ex.: `geral` ou `planos-da-jogatina`) e aperte **Salvar**. Ele aparece em **Canais de texto** pra todo mundo do servidor, na hora.
2. **Renomear:** digite o nome novo e **Salvar**. As mensagens ficam.
3. **Apagar:** aperte duas vezes (na segunda ele pergunta "Apagar com as mensagens?"). As mensagens e os arquivos do canal são apagados do servidor, sem volta.

Aperte **Pronto** pra fechar. Todo mundo lê e escreve nos canais; um ponto marca os que têm mensagem nova. O servidor guarda tudo na pasta `data` dele (`channels.json` e `history`).

## 9. Fotos, GIFs e vídeos nos chats

O Jay-C 0.5 em diante manda imagens (PNG, JPEG, WebP), GIFs e vídeos (MP4, WebM) no chat da call e nos canais de texto. Vem ligado, e os arquivos ficam no seu servidor: nenhum serviço de fora vê quem manda ou assiste.

- **Onde ficam:** na pasta `data/media`. Um arquivo é apagado junto com a mensagem: quando ela sai das últimas 500 do canal, quando o canal é apagado ou quando a call esvazia (o chat da call não guarda histórico).
- **Limites:** 8 MB por imagem e 50 MB por vídeo, e 2 GB pra todos juntos. Mude com `MAX_IMAGE_MB`, `MAX_VIDEO_MB` e `MEDIA_DISK_MB` (ex.: `$env:MEDIA_DISK_MB="10000"`, ou no `docker-compose.yml`). Passado o total, arquivos novos são recusados até mensagens antigas saírem.
- **Banda:** todo mundo que vê um arquivo baixa ele do seu servidor. Vídeos só baixam quando alguém dá play.
- **Pra desligar:** `MEDIA=off`.

Só quem está naquela call, ou no seu servidor, vê os arquivos dela. Antes de uma foto ou vídeo subir, o app tira de onde ele foi feito (o GPS nos metadados).
