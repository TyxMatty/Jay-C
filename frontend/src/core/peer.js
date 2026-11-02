const KINDS = ['audio', 'video'];

/**
 * One RTCPeerConnection to one remote participant, using the W3C "perfect negotiation" pattern.
 *
 * Media layout: exactly one sendrecv transceiver per kind (audio, video). The newcomer to a room
 * creates them and sends the first offer (`start()`); the existing participant adopts the
 * transceivers from that offer. Later media changes (mute camera, screen share, quality) use
 * `replaceTrack()` on those senders, which needs no renegotiation.
 *
 * A reliable "control" data channel carries small JSON app messages (e.g. camera/mic state),
 * because a remote track does not reliably report that the sender stopped sending.
 *
 * Events (CustomEvent): state { connectionState }, track { track }, channel-open {},
 * message { message }, error { error }
 */
export class Peer extends EventTarget {
  /** @type {RTCPeerConnection} */
  pc;
  /** All remote tracks, ready to attach to a <video>. */
  remoteStream = new MediaStream();

  #polite;
  #sendSignal;
  #local;
  #senders = { audio: null, video: null };
  /** @type {RTCDataChannel | null} */
  #channel = null;
  #makingOffer = false;
  #ignoreOffer = false;

  /**
   * @param {object} options
   * @param {boolean} options.polite   Polite peers yield on offer collisions.
   * @param {RTCIceServer[]} options.iceServers
   * @param {(data: object) => void} options.sendSignal
   * @param {{ audio: MediaStreamTrack | null, video: MediaStreamTrack | null }} options.local
   *   Live view of the local tracks (the caller mutates it and calls `replaceTrack`).
   */
  constructor({ polite, iceServers, sendSignal, local }) {
    super();
    this.#polite = polite;
    this.#sendSignal = sendSignal;
    this.#local = local;
    this.pc = new RTCPeerConnection({ iceServers });

    this.pc.onnegotiationneeded = async () => {
      try {
        this.#makingOffer = true;
        await this.pc.setLocalDescription();
        this.#sendSignal({ description: this.pc.localDescription });
      } catch (error) {
        this.#emit('error', { error });
      } finally {
        this.#makingOffer = false;
      }
    };

    this.pc.onicecandidate = ({ candidate }) => this.#sendSignal({ candidate });

    this.pc.ontrack = ({ track }) => {
      this.remoteStream.addTrack(track);
      this.#emit('track', { track });
    };

    this.pc.onconnectionstatechange = () => {
      const { connectionState } = this.pc;
      if (connectionState === 'failed') this.pc.restartIce();
      this.#emit('state', { connectionState });
    };

    this.pc.ondatachannel = ({ channel }) => {
      if (channel.label === 'control') this.#setupChannel(channel);
    };
  }

  get connectionState() {
    return this.pc.connectionState;
  }

  /** Called on the side that initiates (the newcomer): creates the transceivers, which triggers the offer. */
  start() {
    this.#setupChannel(this.pc.createDataChannel('control', { ordered: true }));
    for (const kind of KINDS) {
      const transceiver = this.pc.addTransceiver(this.#local[kind] ?? kind, { direction: 'sendrecv' });
      this.#senders[kind] = transceiver.sender;
    }
  }

  /** Swaps the outgoing track of `kind` (null = send nothing) without renegotiating. */
  async replaceTrack(kind, track) {
    await this.#senders[kind]?.replaceTrack(track);
  }

  /** @returns {RTCRtpSender | null} */
  sender(kind) {
    return this.#senders[kind];
  }

  /** Sends a JSON message over the control channel (dropped if it isn't open yet). */
  sendMessage(message) {
    if (this.#channel?.readyState === 'open') this.#channel.send(JSON.stringify(message));
  }

  /** Handles a `{ description }` or `{ candidate }` payload from the remote peer. */
  async handleSignal({ description, candidate }) {
    try {
      if (description) {
        const offerCollision =
          description.type === 'offer' && (this.#makingOffer || this.pc.signalingState !== 'stable');
        this.#ignoreOffer = !this.#polite && offerCollision;
        if (this.#ignoreOffer) return;

        await this.pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          this.#adoptTransceivers();
          await this.pc.setLocalDescription();
          this.#sendSignal({ description: this.pc.localDescription });
        }
      } else if (candidate !== undefined) {
        try {
          await this.pc.addIceCandidate(candidate ?? undefined);
        } catch (error) {
          if (!this.#ignoreOffer) throw error;
        }
      }
    } catch (error) {
      this.#emit('error', { error });
    }
  }

  close() {
    this.pc.onnegotiationneeded = this.pc.onicecandidate = this.pc.ontrack = null;
    this.pc.onconnectionstatechange = this.pc.ondatachannel = null;
    if (this.#channel) this.#channel.onopen = this.#channel.onmessage = null;
    this.pc.close();
    for (const track of this.remoteStream.getTracks()) track.stop();
  }

  /** On the answering side, take over the transceivers the offer created and attach our tracks. */
  #adoptTransceivers() {
    for (const transceiver of this.pc.getTransceivers()) {
      const kind = transceiver.receiver.track.kind;
      if (this.#senders[kind] || transceiver.currentDirection === 'stopped') continue;
      transceiver.direction = 'sendrecv';
      transceiver.sender.replaceTrack(this.#local[kind] ?? null);
      this.#senders[kind] = transceiver.sender;
    }
  }

  #setupChannel(channel) {
    this.#channel = channel;
    channel.onopen = () => this.#emit('channel-open', {});
    channel.onmessage = ({ data }) => {
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message && typeof message.type === 'string') this.#emit('message', { message });
    };
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
