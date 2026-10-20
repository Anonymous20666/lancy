export const PUBLIC_MUSIC_COMMANDS = [
  { command: 'play', description: 'Listen to or download a full selected recording' },
  { command: 'music', description: 'Open listen/download and music options' },
  { command: 'lyrics', description: 'Find reliably matched recording lyrics' }
];
export const ADMIN_MUSIC_COMMANDS = [
  { command: 'addq', description: 'Admin: select and queue audio for this destination' },
  { command: 'vplay', description: 'Admin: queue video + audio for the live call' },
  { command: 'player', description: 'Admin: open the persistent control dashboard' },
  { command: 'pause', description: 'Admin: pause the shared call playback' },
  { command: 'resume', description: 'Admin: resume shared playback' },
  { command: 'skip', description: 'Admin: play the next queued recording' },
  { command: 'previous', description: 'Admin: return to the previous recording' },
  { command: 'stop', description: 'Admin: stop playback and clear this queue' },
  { command: 'leave', description: 'Admin: disconnect the playback account, not the group' },
  { command: 'queue', description: 'Admin: inspect and edit this destination queue' },
  { command: 'seek', description: 'Admin: seek to a position in seconds' },
  { command: 'volume', description: 'Admin: adjust the shared call volume' },
  { command: 'loop', description: 'Admin: change repeat mode' },
  { command: 'shuffle', description: 'Admin: shuffle the queued recordings' },
  { command: 'playlist', description: 'Save lists; admins can load into live queues' }
];
export const PRIVATE_CHANNEL_COMMANDS = [
  { command: 'channel', description: 'Channel admin: /channel @name for a pinned DM player' },
  { command: 'destination', description: 'Select a verified channel control destination' }
];
const musicNames = new Set([...PUBLIC_MUSIC_COMMANDS, ...ADMIN_MUSIC_COMMANDS, ...PRIVATE_CHANNEL_COMMANDS].map(c => c.command));
export function withMusicCommands(base, { admin = false, privateChat = false, prefix = '/' } = {}) {
  const result = [...base.filter(c => !musicNames.has(c.command)), ...PUBLIC_MUSIC_COMMANDS,
    ...(admin || privateChat ? ADMIN_MUSIC_COMMANDS : []), ...(privateChat ? PRIVATE_CHANNEL_COMMANDS : [])];
  return result.map(c => ({ ...c, description: prefix === '/' ? c.description : `[${prefix}${c.command}] ${c.description}`.slice(0, 256) }));
}
