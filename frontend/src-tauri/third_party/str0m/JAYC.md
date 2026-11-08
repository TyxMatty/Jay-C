# str0m no Jay-C

Cópia do str0m 0.25.0 (crates.io, MIT OR Apache-2.0), sem os testes, os exemplos e as dependências deles, usada pela live nativa (`src/native_live/webrtc.rs`) via `[patch.crates-io]` no `Cargo.toml` do app.

**Mudança** (procure por "Jay-C:"):
- `Bwe::set_pacing_cap(Option<Bitrate>)`: um teto para o ritmo de envio do pacer (`Session::configure_pacer`). O str0m espaça pela própria estimativa (1,1×), que mede só o caminho até o servidor. O mediasoup repassa cada pacote na hora, então um quadro grande chegava de uma vez ao roteador de quem assiste e estourava a fila dele (`docs/spikes/10-live-nativa.md`, "Espaçar o envio").

- `Bwe::queued_bytes()`: os bytes de mídia na fila do pacer. A live media a fila por conta própria (bytes entregues menos os que o str0m contava como enviados), e essa conta subia devagar sem esvaziar: os start codes do Annex B entram nos entregues e não nos enviados. Com o ritmo limitado, 15 KB fantasmas viravam 80 ms de fila, e a live pulava quadros e descia de degrau (medido).

**Ao atualizar o str0m:** baixe a versão nova, copie `src/`, `Cargo.toml` (sem `[[example]]`, `[[test]]`, `[dev-dependencies]` e a feature `examples`), `README.md`, `LICENSE-MIT.txt` e `docs/chrome-sdp.json`, e reaplique a mudança. Se o str0m ganhar um teto de ritmo próprio, apague esta cópia.
