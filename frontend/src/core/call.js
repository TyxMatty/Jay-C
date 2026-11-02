import { SignalingClient } from './signaling.js';
import { Peer } from './peer.js';
import { openLocalMedia, getMicTrack, getCameraTrack } from './media.js';

/**
 * A call in one room: local media + signaling + one Peer per remote participant (mesh).
 *
 * Events (CustomEvent):
 *   participant-added   { participant }
 *   participant-removed { participant }
 *   participant-updated { participant }   connection state or remote tracks changed
 *   local-updated       {}                local tracks changed (mute, camera on/off)
 *   signaling-state     { state }
 *   ended               {}
 *
 * participant = { id, name, peer: Peer, connectionState, media: { audio, video } | null }
 *   `media` is what the remote says it is sending (null until its control channel opens).
 */
export class Call extends EventTarget {
  /** Local tracks; Peers keep a reference to this object, so mutate it, never reassign. */
  local = { audio: null, video: null };
  /** For the local preview tile. */
  localStream = new MediaStream();
  /** @type {Map<string, { id: string, name: string, peer: Peer, connectionState: string }>} */
  participants = new Map();
  mediaErrors = {};
  room = null;

  #signaling = null;
  #iceServers = [];
  #ended = false;

  get micOn() {
    return Boolean(this.local.audio?.enabled);
  }

  get cameraOn() {
    return Boolean(this.local.video);
  }

  /** Opens local media, joins the room and connects to everyone already there. */
  async join({ url, room, name }) {
    this.room = room;
    const media = await openLocalMedia();
    this.local.audio = media.audio;
    this.local.video = media.video;
    this.mediaErrors = media.errors;
    this.#syncLocalStream();

    const signaling = new SignalingClient(url);
    this.#signaling = signaling;
    signaling.addEventListener('state', (e) => this.#emit('signaling-state', e.detail));
    signaling.addEventListener('peer-joined', (e) => this.#addParticipant(e.detail, { initiator: false }));
    signaling.addEventListener('peer-left', (e) => this.#removeParticipant(e.detail.id));
    signaling.addEventListener('signal', (e) => this.#onSignal(e.detail));
    signaling.addEventListener('rejoined', (e) => this.#onRejoined(e.detail));

    let joined;
    try {
      joined = await signaling.join(room, name);
    } catch (error) {
      this.#stopLocal();
      throw error;
    }
    this.#iceServers = joined.iceServers ?? [];
    // We are the newcomer: we offer to everyone already in the room.
    for (const p of joined.peers) this.#addParticipant(p, { initiator: true });
  }

  async toggleMic() {
    if (this.local.audio) {
      this.local.audio.enabled = !this.local.audio.enabled;
    } else {
      // No mic yet (denied or missing at join): try again now.
      this.local.audio = await getMicTrack();
      await this.#replaceOnAllPeers('audio');
    }
    this.#syncLocalStream();
  }

  async toggleCamera() {
    if (this.local.video) {
      // Stop the track so the camera light turns off; remote side sees the video track mute.
      this.local.video.stop();
      this.local.video = null;
    } else {
      this.local.video = await getCameraTrack();
    }
    await this.#replaceOnAllPeers('video');
    this.#syncLocalStream();
  }

  leave() {
    if (this.#ended) return;
    this.#ended = true;
    this.#signaling?.close();
    for (const id of [...this.participants.keys()]) this.#removeParticipant(id);
    this.#stopLocal();
    this.#emit('ended', {});
  }

  #addParticipant({ id, name }, { initiator }) {
    const existing = this.participants.get(id);
    if (existing) {
      if (name && existing.name !== name) {
        existing.name = name;
        this.#emit('participant-updated', { participant: existing });
      }
      return existing;
    }

    const peer = new Peer({
      polite: !initiator,
      iceServers: this.#iceServers,
      sendSignal: (data) => this.#signaling.send(id, data),
      local: this.local,
    });
    const participant = { id, name: name ?? 'Guest', peer, connectionState: peer.connectionState, media: null };
    this.participants.set(id, participant);

    peer.addEventListener('state', (e) => {
      participant.connectionState = e.detail.connectionState;
      this.#emit('participant-updated', { participant });
    });
    peer.addEventListener('track', () => this.#emit('participant-updated', { participant }));
    peer.addEventListener('channel-open', () => peer.sendMessage(this.#mediaMessage()));
    peer.addEventListener('message', (e) => {
      const { message } = e.detail;
      if (message.type === 'media') {
        participant.media = { audio: Boolean(message.audio), video: Boolean(message.video) };
        this.#emit('participant-updated', { participant });
      }
    });
    peer.addEventListener('error', (e) => console.warn(`[peer ${name}]`, e.detail.error));

    this.#emit('participant-added', { participant });
    if (initiator) peer.start();
    return participant;
  }

  #removeParticipant(id) {
    const participant = this.participants.get(id);
    if (!participant) return;
    this.participants.delete(id);
    participant.peer.close();
    this.#emit('participant-removed', { participant });
  }

  #onSignal({ from, data }) {
    // An offer can only come from someone who joined after us, so peer-joined arrived first;
    // fall back to creating the participant anyway.
    const participant = this.participants.get(from) ?? this.#addParticipant({ id: from }, { initiator: false });
    participant.peer.handleSignal(data);
  }

  /** The signaling connection dropped and came back with a new id: rebuild every peer connection. */
  #onRejoined(joined) {
    for (const id of [...this.participants.keys()]) this.#removeParticipant(id);
    this.#iceServers = joined.iceServers ?? this.#iceServers;
    for (const p of joined.peers) this.#addParticipant(p, { initiator: true });
  }

  async #replaceOnAllPeers(kind) {
    await Promise.all([...this.participants.values()].map((p) => p.peer.replaceTrack(kind, this.local[kind])));
  }

  #syncLocalStream() {
    for (const track of this.localStream.getTracks()) {
      if (track !== this.local.audio && track !== this.local.video) this.localStream.removeTrack(track);
    }
    for (const track of [this.local.audio, this.local.video]) {
      if (track && !this.localStream.getTracks().includes(track)) this.localStream.addTrack(track);
    }
    const message = this.#mediaMessage();
    for (const { peer } of this.participants.values()) peer.sendMessage(message);
    this.#emit('local-updated', {});
  }

  #mediaMessage() {
    return { type: 'media', audio: this.micOn, video: this.cameraOn };
  }

  #stopLocal() {
    for (const track of [this.local.audio, this.local.video]) track?.stop();
    this.local.audio = this.local.video = null;
    for (const track of this.localStream.getTracks()) this.localStream.removeTrack(track);
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
