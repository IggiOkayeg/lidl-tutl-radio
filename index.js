require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  NoSubscriberBehavior
} = require('@discordjs/voice');
const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.DISCORD_TOKEN;
const STREAM_URL = process.env.STREAM_URL || 'https://cast.sw.arm.fm/stream';
const PORT = process.env.PORT || 3000;
const SOUNDS_DIR = path.join(__dirname, 'sounds');

if (!fs.existsSync(SOUNDS_DIR)) fs.mkdirSync(SOUNDS_DIR);

if (!TOKEN) { console.error('❌ Missing DISCORD_TOKEN'); process.exit(1); }
try { execSync('ffmpeg -version', { stdio: 'ignore' }); }
catch { console.error('❌ FFmpeg not found'); process.exit(1); }

// ===================== State =====================
// guildAudio: Map<guildId, {
//   connection, voiceChannel,
//   radioFfmpeg, radioPlayer,   ← null when radio is off
//   soundPlayer,                ← null when no sound playing
//   isRestarting
// }>
const guildAudio = new Map();

// ===================== Discord Client =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ===================== Slash Commands =====================
const commands = [
  new SlashCommandBuilder().setName('radio').setDescription('Start radio'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop radio'),
  new SlashCommandBuilder().setName('join').setDescription('Join your voice channel'),
  new SlashCommandBuilder().setName('leave').setDescription('Leave voice channel'),
].map(c => c.toJSON());

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (err) { console.error('Failed to register commands:', err); }
});

// ===================== Message Commands =====================
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  const cmd = msg.content.trim().toLowerCase();
  if (cmd === '!radio') return handleRadioCommand(msg);
  if (cmd === '!stop')  return handleStopCommand(msg);
  if (cmd === '!join')  return handleJoinCommand(msg);
  if (cmd === '!leave') return handleLeaveCommand(msg);
});

// ===================== Slash Interactions =====================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;
  if (interaction.commandName === 'radio') return handleRadioCommand(interaction);
  if (interaction.commandName === 'stop')  return handleStopCommand(interaction);
  if (interaction.commandName === 'join')  return handleJoinCommand(interaction);
  if (interaction.commandName === 'leave') return handleLeaveCommand(interaction);
});

// ===================== Command Handlers =====================
async function handleJoinCommand(ctx) {
  const member = ctx.member;
  if (!member?.voice?.channel) return reply(ctx, '⚠️ Join a voice channel first.');
  const channel = member.voice.channel;
  const guildId = ctx.guild.id;

  // Already connected to this channel?
  const existing = guildAudio.get(guildId);
  if (existing?.voiceChannel?.id === channel.id) {
    return reply(ctx, `Already in **${channel.name}**.`);
  }

  // Leave old channel if in a different one
  if (existing) cleanup(guildId);

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator
  });

  guildAudio.set(guildId, {
    connection,
    voiceChannel: channel,
    radioFfmpeg: null,
    radioPlayer: null,
    soundPlayer: null,
    isRestarting: false
  });

  reply(ctx, `✅ Joined **${channel.name}**. Use \`!radio\` to start playing or open the soundboard.`);
}

function handleLeaveCommand(ctx) {
  const info = guildAudio.get(ctx.guild.id);
  if (!info) return reply(ctx, 'Not in any voice channel.');
  cleanup(ctx.guild.id);
  reply(ctx, '👋 Left the channel.');
}

async function handleRadioCommand(ctx) {
  const member = ctx.member;
  if (!member?.voice?.channel) return reply(ctx, '⚠️ Join a voice channel first.');
  const channel = member.voice.channel;
  await startRadio(ctx.guild.id, channel, ctx);
}

function handleStopCommand(ctx) {
  const info = guildAudio.get(ctx.guild.id);
  if (!info) return reply(ctx, 'Nothing is playing.');
  stopRadio(ctx.guild.id);
  reply(ctx, '⏹ Radio stopped. Bot is still in the channel. Use `!leave` to disconnect.');
}

// ===================== Radio Logic =====================
async function startRadio(guildId, voiceChannel, ctx) {
  let info = guildAudio.get(guildId);

  // Join if not already connected
  if (!info) {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator
    });
    info = { connection, voiceChannel, radioFfmpeg: null, radioPlayer: null, soundPlayer: null, isRestarting: false };
    guildAudio.set(guildId, info);
  }

  if (info.radioPlayer && !info.isRestarting) {
    return reply(ctx, 'Radio is already playing.');
  }

  console.log(`🎧 Starting radio in ${voiceChannel.name}`);

  const ffmpeg = spawn('ffmpeg', [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', STREAM_URL,
    '-analyzeduration', '0',
    '-loglevel', 'quiet',
    '-f', 's16le',
    '-acodec', 'pcm_s16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1'
  ], { windowsHide: true });

  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });

  player.play(resource);
  // Only subscribe if no sound is currently playing
  if (!info.soundPlayer) info.connection.subscribe(player);

  info.radioFfmpeg = ffmpeg;
  info.radioPlayer = player;
  info.isRestarting = false;

  player.once(AudioPlayerStatus.Playing, () => {
    console.log(`▶️ Radio playing in ${voiceChannel.name}`);
    reply(ctx, `▶️ Radio started in **${voiceChannel.name}**`);
  });

  player.on('error', (err) => {
    console.error('Radio player error:', err);
    restartRadio(guildId, voiceChannel, ctx);
  });

  ffmpeg.stdout.on('end', () => {
    console.warn('⚠️ Stream ended — restarting...');
    restartRadio(guildId, voiceChannel, ctx);
  });

  ffmpeg.on('error', (err) => {
    console.error('FFmpeg error:', err);
    cleanup(guildId);
  });
}

function stopRadio(guildId) {
  const info = guildAudio.get(guildId);
  if (!info) return;
  try { info.radioPlayer?.stop(); } catch {}
  try { info.radioFfmpeg?.kill('SIGKILL'); } catch {}
  info.radioPlayer = null;
  info.radioFfmpeg = null;
}

function restartRadio(guildId, voiceChannel, ctx) {
  const info = guildAudio.get(guildId);
  if (!info || info.isRestarting) return;
  info.isRestarting = true;
  stopRadio(guildId);
  setTimeout(() => {
    console.log('🔁 Restarting radio...');
    startRadio(guildId, voiceChannel, ctx);
  }, 5000);
}

// ===================== Soundboard Logic =====================
function getSounds() {
  return fs.readdirSync(SOUNDS_DIR)
    .filter(f => /\.(mp3|wav|ogg|flac|m4a)$/i.test(f))
    .map(f => ({ name: path.basename(f, path.extname(f)), file: f }));
}

function playSoundInGuild(guildId, soundName) {
  const info = guildAudio.get(guildId);
  if (!info) return { ok: false, error: 'Bot is not in any voice channel. Use !join first.' };

  const sounds = getSounds();
  const sound = sounds.find(s => s.name === soundName);
  if (!sound) return { ok: false, error: `Sound "${soundName}" not found in /sounds folder.` };

  const filePath = path.join(SOUNDS_DIR, sound.file);

  // If a sound is already playing, kill it
  if (info.soundPlayer) {
    try { info.soundPlayer.stop(); } catch {}
    info.soundPlayer = null;
  }

  const ffmpeg = spawn('ffmpeg', [
    '-i', filePath,
    '-f', 's16le', '-acodec', 'pcm_s16le',
    '-ar', '48000', '-ac', '2',
    '-loglevel', 'quiet',
    'pipe:1'
  ], { windowsHide: true });

  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
  const soundPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });

  soundPlayer.play(resource);
  info.connection.subscribe(soundPlayer); // Takes over from radio player
  info.soundPlayer = soundPlayer;

  const resumeRadio = () => {
    // Hand control back to the radio player when sound finishes
    if (info.radioPlayer) info.connection.subscribe(info.radioPlayer);
    info.soundPlayer = null;
  };

  soundPlayer.once(AudioPlayerStatus.Idle, resumeRadio);
  soundPlayer.once('error', (err) => {
    console.error('Soundboard error:', err);
    resumeRadio();
  });

  console.log(`🔊 Playing sound: ${sound.file}`);
  return { ok: true, playing: sound.name };
}

// ===================== Cleanup =====================
function cleanup(guildId, destroyConnection = true) {
  const info = guildAudio.get(guildId);
  if (!info) return;
  try { info.soundPlayer?.stop(); } catch {}
  try { info.radioPlayer?.stop(); } catch {}
  try { info.radioFfmpeg?.kill('SIGKILL'); } catch {}
  if (destroyConnection) {
    try { info.connection?.destroy(); } catch {}
    guildAudio.delete(guildId);
  }
}

// ===================== HTTP API Server =====================
const server = http.createServer((req, res) => {
  // CORS — needed for the HTML soundboard to call this from a browser
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET / — health check
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  // GET /sounds — list available sound files
  if (req.method === 'GET' && req.url === '/sounds') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getSounds()));
    return;
  }

  // GET /status — which guilds/channels bot is in
  if (req.method === 'GET' && req.url === '/status') {
    const guilds = [];
    for (const [guildId, info] of guildAudio.entries()) {
      guilds.push({
        guildId,
        channel: info.voiceChannel?.name || 'unknown',
        radioPlaying: !!info.radioPlayer,
        soundPlaying: !!info.soundPlayer
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ guilds }));
    return;
  }

  // POST /play — play a sound { sound: "name", guildId?: "..." }
  if (req.method === 'POST' && req.url === '/play') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { sound, guildId } = JSON.parse(body);
        if (!sound) throw new Error('Missing "sound" field');

        // Use provided guildId or fall back to first connected guild
        const targetGuildId = guildId || [...guildAudio.keys()][0];
        if (!targetGuildId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Bot is not in any voice channel' }));
          return;
        }

        const result = playSoundInGuild(targetGuildId, sound);
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`🌐 API server running on http://localhost:${PORT}`));

// ===================== Helpers =====================
function reply(ctx, text) {
  if (ctx.isRepliable?.()) return ctx.reply(text);
  if (ctx.reply) return ctx.reply(text);
}

process.on('SIGINT', () => {
  console.log('🧹 Shutting down...');
  for (const [gid] of guildAudio.entries()) cleanup(gid);
  process.exit();
});

client.login(TOKEN);
