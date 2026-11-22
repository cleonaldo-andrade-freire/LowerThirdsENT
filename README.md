# Lower Thirds ENT

Sistema local de Lower Thirds para OBS Studio (Overlay + Dock + API HTTP/WebSocket + Macro Deck).

## Rodar

```bash
npm install
npm start            # só nesta máquina (127.0.0.1:3000)
npm run start:lan    # libera o Dock/API para outros dispositivos da rede
npm run dev          # reinicia automaticamente ao editar o server.js
```

Porta diferente (PowerShell): `$env:PORT=3001; npm start`

## OBS Studio

| Onde | URL | Configuração |
|---|---|---|
| Browser Source | `http://localhost:3000/overlay.html` | 1920 × 1080, "Shutdown source when not visible" **desmarcado** |
| Custom Browser Dock (Docks → Custom Browser Docks) | `http://localhost:3000/dock.html` | Nome: `Lower Thirds` |

Teste no navegador com fundo xadrez: `http://localhost:3000/overlay.html?preview=1`

## API (Macro Deck → plugin Web Request, método POST)

| Ação | URL |
|---|---|
| Exibir (dados atuais) | `POST /api/take` |
| Exibir com dados | `POST /api/take` + JSON `{"name":"...","role":"...","template":"news","autoHide":8}` ou `?name=...&role=...` |
| Ocultar | `POST /api/hide` |
| Alternar | `POST /api/toggle` |
| Slot N | `POST /api/take/slot/1`, `/2`, `/3`... |
| Listar presets | `GET /api/presets` |
| Substituir presets | `POST /api/presets` + array JSON |
| Novo preset | `POST /api/presets/add` + JSON |
| Editar preset | `PUT /api/presets/:id` + JSON |
| Excluir preset | `DELETE /api/presets/:id` |
| Upload de foto | `POST /api/upload` + `{"image":"data:image/png;base64,..."}` |
| Estado atual | `GET /api/state` |

Em `/api/take`: enviando `name`, um participante novo é montado; sem `name`, apenas os campos enviados (ex.: `template`) alteram o que já está carregado.

Modelos: `modern`, `clean`, `elegant`, `minimal`, `news`, `breaking`, `podcast`, `gradient`, `soft`, `split`, `sports`, `cyber`, `frosted`, `classic`, `outline`, `inline`, `verse`, `ribbon`, `spotlight`, `stack`, `subscribe`, `worship`.
`autoHide` em segundos (0 = desligado).

Posição e tamanho (opcionais em `/api/take` e nos presets): `x` e `y` em pixels da tela 1920×1080, medidos do canto inferior esquerdo da tela até o canto inferior esquerdo do card (padrão `x=110`, `y=120`), e `scale` de `0.3` a `3` (padrão `1`). No Dock, ajuste arrastando o card na pré-visualização do modal.

## Dock

Lista de presets com **TAKE · Editar · Excluir** por slot, botão **+** para criar, **HIDE** e ON AIR no topo e pré-visualização colapsável.

**Estúdio (tamanho real):** no modal de editar/criar, clique em **⛶ Tamanho real** para ver a tela 1920×1080 em 100% (ou 75%, 50%, 33%, ajustar), com fundo de simulação (xadrez, preto, cinza, verde, imagem/print do culto ou câmera ao vivo), guias de área segura de TV e ímã (encaixe nas áreas seguras e grade de 10 px). Para usar em 100%, abra o Dock numa janela grande do navegador: `http://localhost:3000/dock.html`.

Atalhos: `Alt+1..9` dispara o slot · `Ctrl+Shift+H` HIDE · `Alt+N` novo preset · `Ctrl+V` cola foto (abre "Novo preset" se o modal estiver fechado) · no modal: `Enter` salva, `Ctrl+Enter` salva e põe no ar, `Esc` fecha · arraste a linha para reordenar slots.
