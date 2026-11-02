# Jay-C

App leve e open-source de chamadas e compartilhamento de tela para desktop e mobile, com servidor de sinalização self-hosted via Docker.

| Pasta | Conteúdo |
|---|---|
| [`signaling-server/`](signaling-server/) | Servidor de sinalização WebRTC (Node.js + `ws`) e arquivos Docker |
| `frontend/` | App Tauri v2 + Vanilla JS *(em construção)* |
| `plugins/tauri-plugin-pip/` | Plugin de Picture-in-Picture para Android/iOS *(em construção)* |
| [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) | Arquitetura, decisões técnicas e etapas |

## Rodando o servidor localmente

```bash
npm install
npm run server
```

O servidor escuta em `ws://0.0.0.0:3000`. O health check fica em `http://localhost:3000/health`.

## Testes

```bash
npm test
```
