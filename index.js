const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');
const fs = require('fs');
const axios = require('axios');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;           // Set in .env
const CLIENT_ID = process.env.CLIENT_ID;           // Your bot's application ID
const OWNER_ID  = '866973900641665074';            // Auto-whitelisted, only one who can whitelist/unwhitelist

// ─── DATA FILES ───────────────────────────────────────────────────────────────
const DATA_DIR    = './data';
const WL_FILE     = `${DATA_DIR}/whitelist.json`;
const HITS_FILE   = `${DATA_DIR}/hits.json`;
const TRACKED_FILE= `${DATA_DIR}/tracked.json`;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function loadJSON(file, def) {
  if (!fs.existsSync(file)) { fs.writeFileSync(file, JSON.stringify(def, null, 2)); return def; }
  return JSON.parse(fs.readFileSync(file));
}
function saveJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

function getWhitelist()  { return loadJSON(WL_FILE,      { users: [OWNER_ID] }); }
function getHits()       { return loadJSON(HITS_FILE,    { hits: [] }); }
function getTracked()    { return loadJSON(TRACKED_FILE, { tracked: [] }); }

function isWhitelisted(userId) {
  if (userId === OWNER_ID) return true;
  return getWhitelist().users.includes(userId);
}

// ─── ROBLOX TRACKING ──────────────────────────────────────────────────────────
const PAPERS_GAME_ID = 583507031;

async function getRobloxUserId(username) {
  try {
    const res = await axios.post('https://users.roblox.com/v1/usernames/users', {
      usernames: [username], excludeBannedUsers: false
    });
    return res.data.data[0]?.id || null;
  } catch { return null; }
}

async function getRobloxPresence(userId) {
  try {
    const res = await axios.post('https://presence.roblox.com/v1/presence/users', { userIds: [userId] });
    const p = res.data.userPresences[0];
    // userPresenceType: 0=offline, 1=online(website), 2=in-game, 3=in-studio
    return p || null;
  } catch { return null; }
}

// Presence polling every 60 seconds
const lastPresenceState = {}; // userId -> last presence type

async function pollTracked(client) {
  const { tracked } = getTracked();
  for (const entry of tracked) {
    try {
      const robloxId = entry.robloxId;
      if (!robloxId) continue;

      const presence = await getRobloxPresence(robloxId);
      if (!presence) continue;

      const prevType = lastPresenceState[robloxId];
      const currType = presence.userPresenceType;

      // Only notify on change
      if (prevType === currType) continue;
      lastPresenceState[robloxId] = currType;

      let statusMsg = null;

      if (currType === 1) {
        statusMsg = `🌐 **${entry.username}** is now **online on the Roblox website**.`;
      } else if (currType === 2) {
        const placeId = presence.placeId;
        if (placeId === PAPERS_GAME_ID) {
          statusMsg = `🎮 **${entry.username}** is now **in-game on Papers** (the target game)!`;
        } else if (placeId) {
          // Try to get game name
          let gameName = 'Unknown Game';
          try {
            const gr = await axios.get(`https://games.roblox.com/v1/games?universeIds=${presence.universeId || ''}`);
            gameName = gr.data.data[0]?.name || gameName;
          } catch {}
          statusMsg = `🎮 **${entry.username}** is now **in-game**: ${gameName}`;
        } else {
          statusMsg = `⚠️ **${entry.username}** is in-game but is **untrackable** (game info unavailable).`;
        }
      } else if (currType === 0 && prevType !== undefined) {
        statusMsg = `💤 **${entry.username}** has gone **offline**.`;
      }

      if (statusMsg) {
        // DM all requesters
        for (const discordId of entry.requesters) {
          try {
            const user = await client.users.fetch(discordId);
            await user.send(statusMsg);
          } catch {}
        }
      }
    } catch {}
  }
}

// ─── SLASH COMMANDS ───────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName('whitelist')
    .setDescription('Add a user to the bot whitelist (owner only)')
    .addUserOption(o => o.setName('user').setDescription('User to whitelist').setRequired(true)),

  new SlashCommandBuilder().setName('unwhitelist')
    .setDescription('Remove a user from the whitelist (owner only)')
    .addUserOption(o => o.setName('user').setDescription('User to remove').setRequired(true)),

  new SlashCommandBuilder().setName('display-whitelist')
    .setDescription('Show all whitelisted users'),

  new SlashCommandBuilder().setName('hit-add')
    .setDescription('Add a hit to the list')
    .addStringOption(o => o.setName('username').setDescription('Target username').setRequired(true))
    .addStringOption(o => o.setName('reward').setDescription('Reward for the hit').setRequired(true))
    .addUserOption(o => o.setName('requested_to').setDescription('Who the hit is assigned to').setRequired(true)),

  new SlashCommandBuilder().setName('hits')
    .setDescription('View all active (unclaimed/unrevoked) hits'),

  new SlashCommandBuilder().setName('hit-claimed')
    .setDescription('Mark a hit as claimed')
    .addStringOption(o => o.setName('username').setDescription('Target username of the hit').setRequired(true)),

  new SlashCommandBuilder().setName('hit-revoked')
    .setDescription('Revoke/remove a hit')
    .addStringOption(o => o.setName('username').setDescription('Target username of the hit').setRequired(true)),

  new SlashCommandBuilder().setName('track')
    .setDescription('Track a Roblox user\'s presence')
    .addStringOption(o => o.setName('roblox_user').setDescription('Roblox username to track').setRequired(true)),

  new SlashCommandBuilder().setName('untrack')
    .setDescription('Stop tracking a Roblox user')
    .addStringOption(o => o.setName('roblox_user').setDescription('Roblox username to untrack').setRequired(true)),

  new SlashCommandBuilder().setName('tracked')
    .setDescription('Show all currently tracked Roblox users'),
].map(c => c.toJSON());

// ─── REGISTER COMMANDS ────────────────────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  console.log('Registering slash commands...');
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('Commands registered.');
}

// ─── CLIENT ───────────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages] });

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
  // Poll every 60s
  setInterval(() => pollTracked(client), 60_000);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ── DMs only ──
  if (interaction.channel?.type !== 1 /* DM */) {
    return interaction.reply({ content: '❌ This bot only works in DMs.', ephemeral: true });
  }

  const userId = interaction.user.id;
  const cmd    = interaction.commandName;

  // ── Whitelist check (skip for owner on whitelist commands) ──
  const wlOnlyOwner = ['whitelist', 'unwhitelist'];
  if (wlOnlyOwner.includes(cmd)) {
    if (userId !== OWNER_ID) {
      return interaction.reply({ content: '❌ Only the bot owner can use this command.', ephemeral: true });
    }
  } else {
    if (!isWhitelisted(userId)) {
      return interaction.reply({ content: '❌ You are not whitelisted to use this bot.', ephemeral: true });
    }
  }

  // ─────────────────────────────────────────────────────────────
  if (cmd === 'whitelist') {
    const target = interaction.options.getUser('user');
    const wl = getWhitelist();
    if (wl.users.includes(target.id)) {
      return interaction.reply(`ℹ️ **${target.username}** is already whitelisted.`);
    }
    wl.users.push(target.id);
    saveJSON(WL_FILE, wl);
    return interaction.reply(`✅ **${target.username}** has been whitelisted.`);
  }

  if (cmd === 'unwhitelist') {
    const target = interaction.options.getUser('user');
    if (target.id === OWNER_ID) return interaction.reply('❌ Cannot unwhitelist the owner.');
    const wl = getWhitelist();
    const idx = wl.users.indexOf(target.id);
    if (idx === -1) return interaction.reply(`ℹ️ **${target.username}** is not whitelisted.`);
    wl.users.splice(idx, 1);
    saveJSON(WL_FILE, wl);
    return interaction.reply(`✅ **${target.username}** has been removed from the whitelist.`);
  }

  if (cmd === 'display-whitelist') {
    const wl = getWhitelist();
    const lines = await Promise.all(wl.users.map(async id => {
      try { const u = await client.users.fetch(id); return `• ${u.username} (\`${id}\`)`; }
      catch { return `• Unknown (\`${id}\`)`; }
    }));
    const embed = new EmbedBuilder()
      .setTitle('📋 Whitelisted Users')
      .setDescription(lines.join('\n') || 'No users whitelisted.')
      .setColor(0x5865F2);
    return interaction.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────
  if (cmd === 'hit-add') {
    const username   = interaction.options.getString('username');
    const reward     = interaction.options.getString('reward');
    const requestedTo= interaction.options.getUser('requested_to');
    const hits = getHits();
    hits.hits.push({
      id: Date.now().toString(),
      username,
      reward,
      requestedBy: userId,
      requestedTo: requestedTo.id,
      requestedToName: requestedTo.username,
      status: 'active',
      createdAt: new Date().toISOString()
    });
    saveJSON(HITS_FILE, hits);
    const embed = new EmbedBuilder()
      .setTitle('🎯 Hit Added')
      .addFields(
        { name: 'Target', value: username, inline: true },
        { name: 'Reward', value: reward, inline: true },
        { name: 'Assigned To', value: requestedTo.username, inline: true },
      )
      .setColor(0xED4245)
      .setTimestamp();
    return interaction.reply({ embeds: [embed] });
  }

  if (cmd === 'hits') {
    const hits = getHits().hits.filter(h => h.status === 'active');
    if (!hits.length) return interaction.reply('📭 No active hits.');
    const embed = new EmbedBuilder().setTitle('🎯 Active Hits').setColor(0xED4245);
    hits.forEach(h => {
      embed.addFields({ name: `Target: ${h.username}`, value: `Reward: **${h.reward}** | Assigned: **${h.requestedToName}**` });
    });
    return interaction.reply({ embeds: [embed] });
  }

  if (cmd === 'hit-claimed') {
    const username = interaction.options.getString('username');
    const hits = getHits();
    const hit = hits.hits.find(h => h.username.toLowerCase() === username.toLowerCase() && h.status === 'active');
    if (!hit) return interaction.reply(`❌ No active hit found for **${username}**.`);
    hit.status = 'claimed';
    hit.claimedBy = userId;
    hit.claimedAt = new Date().toISOString();
    saveJSON(HITS_FILE, hits);
    return interaction.reply(`✅ Hit on **${username}** marked as **claimed**.`);
  }

  if (cmd === 'hit-revoked') {
    const username = interaction.options.getString('username');
    const hits = getHits();
    const hit = hits.hits.find(h => h.username.toLowerCase() === username.toLowerCase() && h.status === 'active');
    if (!hit) return interaction.reply(`❌ No active hit found for **${username}**.`);
    hit.status = 'revoked';
    hit.revokedBy = userId;
    hit.revokedAt = new Date().toISOString();
    saveJSON(HITS_FILE, hits);
    return interaction.reply(`🚫 Hit on **${username}** has been **revoked**.`);
  }

  // ─────────────────────────────────────────────────────────────
  if (cmd === 'track') {
    const robloxUser = interaction.options.getString('roblox_user');
    await interaction.deferReply();

    const robloxId = await getRobloxUserId(robloxUser);
    if (!robloxId) return interaction.editReply(`❌ Roblox user **${robloxUser}** not found.`);

    const data = getTracked();
    let entry = data.tracked.find(t => t.robloxId === robloxId);
    if (entry) {
      if (!entry.requesters.includes(userId)) entry.requesters.push(userId);
    } else {
      entry = { username: robloxUser, robloxId, requesters: [userId] };
      data.tracked.push(entry);
    }
    saveJSON(TRACKED_FILE, data);
    return interaction.editReply(`✅ Now tracking **${robloxUser}**. You'll be DMed when their presence changes.`);
  }

  if (cmd === 'untrack') {
    const robloxUser = interaction.options.getString('roblox_user');
    const data = getTracked();
    const idx = data.tracked.findIndex(t => t.username.toLowerCase() === robloxUser.toLowerCase());
    if (idx === -1) return interaction.reply(`❌ **${robloxUser}** is not being tracked.`);
    // Remove this user from requesters list
    data.tracked[idx].requesters = data.tracked[idx].requesters.filter(id => id !== userId);
    // If no more requesters, remove entry entirely
    if (data.tracked[idx].requesters.length === 0) data.tracked.splice(idx, 1);
    saveJSON(TRACKED_FILE, data);
    return interaction.reply(`✅ Stopped tracking **${robloxUser}**.`);
  }

  if (cmd === 'tracked') {
    const data = getTracked();
    const mine = data.tracked.filter(t => t.requesters.includes(userId));
    if (!mine.length) return interaction.reply('📭 You are not tracking anyone.');
    const embed = new EmbedBuilder()
      .setTitle('👁️ Tracked Roblox Users')
      .setDescription(mine.map(t => `• **${t.username}** (ID: \`${t.robloxId}\`)`).join('\n'))
      .setColor(0x57F287);
    return interaction.reply({ embeds: [embed] });
  }
});

client.login(BOT_TOKEN);
