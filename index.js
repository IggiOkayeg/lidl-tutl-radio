// index.js
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

const TOKEN = process.env.DISCORD_TOKEN;
const STREAM_URL = process.env.STREAM_URL || 'https://cast.sw.arm.fm/stream';

const http = require('http');
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, () => console.log(`Heartbeat server on port ${PORT}`));

if (!TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

// Проверка FFmpeg
try {
  execSync('ffmpeg -version', { stdio: 'ignore' });
} catch {
  console.error('❌ FFmpeg не найден в PATH. Установи его или добавь в PATH.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const guildAudio = new Map();

// ======================== Slash команды ========================

const commands = [
  new SlashCommandBuilder().setName('radio').setDescription('Начать проигрывание радио'),
  new SlashCommandBuilder().setName('stop').setDescription('Остановить радио')
].map(cmd => cmd.toJSON());

// Регистрация команд при старте
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Slash-команды зарегистрированы');
  } catch (err) {
    console.error('Не удалось зарегистрировать команды:', err);
  }
});

// ======================== Команды ========================

// поддержка обычных !radio / !stop
client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  const content = msg.content.trim().toLowerCase();
  if (content === '!radio') return handleRadioCommand(msg);
  if (content === '!stop') return handleStopCommand(msg);
});

// поддержка slash-команд
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;
  if (interaction.commandName === 'radio') return handleRadioCommand(interaction);
  if (interaction.commandName === 'stop') return handleStopCommand(interaction);
});

// ======================== Основная логика ========================

async function handleRadioCommand(ctx) {
  const guild = ctx.guild;
  const member = ctx.member;
  if (!member?.voice?.channel) {
    reply(ctx, 'Сначала зайди в голосовой канал.');
    return;
  }
  const channel = member.voice.channel;
  await startStreaming(guild.id, channel, ctx);
}

function handleStopCommand(ctx) {
  const info = guildAudio.get(ctx.guild.id);
  if (!info) {
    reply(ctx, 'Сейчас ничего не играет.');
    return;
  }
  cleanup(ctx.guild.id);
  reply(ctx, '⏹ Радио остановлено, бот покинул канал.');
}

async function startStreaming(guildId, voiceChannel, ctx) {
  const existing = guildAudio.get(guildId);
  if (existing && !existing.isRestarting) {
    reply(ctx, 'Уже проигрывается радио в этом сервере.');
    return;
  }

  console.log(`🎧 Подключаюсь к ${voiceChannel.name} (${guildId})`);

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator
  });

  const startFFmpeg = () => {
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

    ffmpeg.on('error', (err) => {
      console.error('FFmpeg error:', err);
      reply(ctx, '⚠️ Ошибка запуска FFmpeg.');
      cleanup(guildId);
    });

    return ffmpeg;
  };

  const ffmpeg = startFFmpeg();
  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play }
  });

  player.play(resource);
  connection.subscribe(player);

  guildAudio.set(guildId, { connection, ffmpeg, player, isRestarting: false });

  player.on(AudioPlayerStatus.Playing, () => {
    console.log(`▶️ Радио играет в ${voiceChannel.name}`);
    reply(ctx, `▶️ Радио запущено в **${voiceChannel.name}**`);
  });

  player.on('error', (err) => {
    console.error('Audio player error:', err);
    restartStream(guildId, voiceChannel, ctx);
  });

  ffmpeg.stdout.on('end', () => {
    console.warn('⚠️ Поток закончился — перезапуск...');
    restartStream(guildId, voiceChannel, ctx);
  });
}

function restartStream(guildId, voiceChannel, ctx) {
  const info = guildAudio.get(guildId);
  if (!info || info.isRestarting) return;
  info.isRestarting = true;
  cleanup(guildId, false);
  setTimeout(() => {
    console.log('🔁 Перезапуск радио...');
    startStreaming(guildId, voiceChannel, ctx);
  }, 5000);
}

function cleanup(guildId, destroyConnection = true) {
  const info = guildAudio.get(guildId);
  if (!info) return;
  try { info.player?.stop(); } catch {}
  try { info.ffmpeg?.kill('SIGKILL'); } catch {}
  if (destroyConnection) try { info.connection?.destroy(); } catch {}
  guildAudio.delete(guildId);
}

// Универсальный ответ (для сообщений и слэшей)
function reply(ctx, text) {
  if ('reply' in ctx) return ctx.reply(text);
  if ('reply' in ctx?.interaction) return ctx.interaction.reply(text);
  if ('isRepliable' in ctx && ctx.isRepliable()) return ctx.reply(text);
  if (ctx.reply) return ctx.reply(text);
}

process.on('SIGINT', () => {
  console.log('🧹 Завершение работы...');
  for (const [gid] of guildAudio.entries()) cleanup(gid);
  process.exit();
});

client.login(TOKEN);

