// The mic and deafen state carried from one call to the next (Settings: callAudio). Saved as the
// user left it: `muted` is the mic's own state, not what deafen did to it, so a call left deafened
// comes back deafened, and undeafening brings the mic back only if it wasn't muted before.

/** What to save from a call's state. */
export const savedCallAudio = ({ deafened, micMuted, micBeforeDeafen }) => ({
  muted: deafened ? !micBeforeDeafen : micMuted,
  deafened,
});

/** How a call starts from what was saved (deafen also mutes). */
export const startCallAudio = ({ muted = false, deafened = false } = {}) => ({
  micMuted: muted || deafened,
  deafened,
  micBeforeDeafen: !muted,
});
