Maledike Discord Bot - discord.js v14
// Commandes : /rank /derank ?ban ?unban ?baninfo
//             ?bl ?unbl ?blist ?blinfo
//             + Anti-abus + Permissions
// ============================================

const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const express = require('express');

// ── CONFIG ────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID  = process.env.GUILD_ID;
const PORT      = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_URL || 'https://hhh-eyls.onrender.com';

// Hiérarchie des rôles (ID Discord → niveau)
// Plus le niveau est élevé, plus le rôle est puissant
const ROLE_HIERARCHY = {
  // 'ROLE_ID': { level: 10, rankCap: 5, rateLimit: { count: 5, minutes: 5 } }
  // Personnalisez via le dashboard Base44
};

// Rôles protégés (ne peuvent pas être assignés)
const PROTECTED_ROLES = new Set([/* 'ROLE_ID' */]);

// Rôles VIP (peuvent derank sans raison)
const VIP_ROLES = new Set([/* 'ROLE_ID' */]);

// Suivi des violations de rôles protégés
const persistViolations = new Map();

// Rate limiting : rankUsage[userId][roleId] = [timestamps]
const rankUsage = new Map();

// ── KEEP-ALIVE SERVER ─────────────────────────
const app = express();
app.get('/', (req, res) => res.send('Bot is alive!'));
app.listen(PORT, () => console.log(`[Keep-Alive] Serveur sur port ${PORT}`));

// Auto-ping toutes les 60 secondes
setInterval(() => {
  fetch(RENDER_URL)
    .then(() => console.log('[Keep-Alive] Ping OK -', new Date().toISOString()))
    .catch(e => console.error('[Keep-Alive] Ping échoué:', e.message));
}, 60_000);

// ── CLIENT DISCORD ────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
});

// ── COMMANDES SLASH ───────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Attribue un rôle à un utilisateur')
    .addUserOption(opt => opt.setName('user').setDescription('Utilisateur cible').setRequired(true))
    .addRoleOption(opt => opt.setName('role').setDescription('Rôle à attribuer').setRequired(true)),

  new SlashCommandBuilder()
    .setName('derank')
    .setDescription('Retire un rôle à un utilisateur')
    .addUserOption(opt => opt.setName('user').setDescription('Utilisateur cible').setRequired(true))
    .addRoleOption(opt => opt.setName('role').setDescription('Rôle à retirer').setRequired(false))
    .addStringOption(opt => opt.setName('reason').setDescription('Raison du derank').setRequired(false)),
].map(cmd => cmd.toJSON());

// ── HELPERS ───────────────────────────────────
function getExecutorLevel(member) {
  let maxLevel = 0;
  for (const [roleId, config] of Object.entries(ROLE_HIERARCHY)) {
    if (member.roles.cache.has(roleId)) {
      maxLevel = Math.max(maxLevel, config.level);
    }
  }
  return maxLevel;
}

function getExecutorCap(member) {
  let cap = 0;
  for (const [roleId, config] of Object.entries(ROLE_HIERARCHY)) {
    if (member.roles.cache.has(roleId)) {
      cap = Math.max(cap, config.rankCap || 0);
    }
  }
  return cap;
}

function isVIP(member) {
  return [...VIP_ROLES].some(id => member.roles.cache.has(id));
}

function checkRateLimit(userId, roleId) {
  if (!ROLE_HIERARCHY[roleId]?.rateLimit) return true;
  const { count, minutes } = ROLE_HIERARCHY[roleId].rateLimit;
  const now = Date.now();
  const window = minutes * 60_000;

  if (!rankUsage.has(userId)) rankUsage.set(userId, {});
  const userUsage = rankUsage.get(userId);
  if (!userUsage[roleId]) userUsage[roleId] = [];

  // Nettoie les entrées expirées
  userUsage[roleId] = userUsage[roleId].filter(t => now - t < window);

  if (userUsage[roleId].length >= count) return false;
  userUsage[roleId].push(now);
  return true;
}

function errorEmbed(description) {
  return new EmbedBuilder()
    .setColor(0xED4245)
    .setDescription(`❌ ${description}`);
}

function successEmbed(description) {
  return new EmbedBuilder()
    .setColor(0x57F287)
    .setDescription(`✅ ${description}`);
}

// ── COMMANDE /rank ────────────────────────────
async function handleRank(interaction) {
  const executor = interaction.member;
  const targetUser = interaction.options.getUser('user');
  const role = interaction.options.getRole('role');
  const target = await interaction.guild.members.fetch(targetUser.id);

  // Rôle protégé ?
  if (PROTECTED_ROLES.has(role.id)) {
    // Enregistre la violation
    const key = `${executor.id}-protected`;
    const violations = (persistViolations.get(key) || 0) + 1;
    persistViolations.set(key, violations);

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xFEE75C)
        .setDescription(`<@${executor.id}> Vous n'avez pas l'autorisation d'attribuer un rôle protégé.`)
      ]
    });

    // Si persistence : derank total + MP
    if (violations >= 2) {
      persistViolations.delete(key);
      // Retirer tous les rôles hiérarchiques
      const rolesToRemove = Object.keys(ROLE_HIERARCHY)
        .filter(id => executor.roles.cache.has(id));
      for (const rid of rolesToRemove) {
        await executor.roles.remove(rid).catch(() => {});
      }
      // MP
      executor.user.send(
        'Vous avez été derank sur **Maledike** pour avoir persisté à attribuer un rôle protégé.'
      ).catch(() => {});

      await interaction.followUp({
        embeds: [errorEmbed(`<@${executor.id}> a été derank totalement pour persistance.`)]
      });
    }
    return;
  }

  const execLevel = getExecutorLevel(executor);
  const execCap = getExecutorCap(executor);
  const roleLevel = ROLE_HIERARCHY[role.id]?.level || 0;

  // Vérification plafond
  if (roleLevel > execCap) {
    return interaction.reply({
      embeds: [errorEmbed(`Vous ne pouvez pas rank jusqu'au rôle <@&${role.id}>. Plafond : niveau ${execCap}.`)],
      ephemeral: true
    });
  }

  // Rate limit
  if (!checkRateLimit(executor.id, role.id)) {
    const rl = ROLE_HIERARCHY[role.id]?.rateLimit;
    return interaction.reply({
      embeds: [errorEmbed(`Limite atteinte : max ${rl.count} ranks en ${rl.minutes} minutes.`)],
      ephemeral: true
    });
  }

  await target.roles.add(role.id);
  await interaction.reply({
    embeds: [successEmbed(`<@${targetUser.id}> a reçu le rôle <@&${role.id}>.`)]
  });
}

// ── COMMANDE /derank ──────────────────────────
async function handleDerank(interaction) {
  const executor = interaction.member;
  const targetUser = interaction.options.getUser('user');
  const role = interaction.options.getRole('role');
  const reason = interaction.options.getString('reason');

  // VIP : derank simple sans rôle ni raison requis
  if (isVIP(executor) && !role) {
    const target = await interaction.guild.members.fetch(targetUser.id);
    const rolesToRemove = Object.keys(ROLE_HIERARCHY)
      .filter(id => target.roles.cache.has(id));
    for (const rid of rolesToRemove) {
      await target.roles.remove(rid).catch(() => {});
    }
    return interaction.reply({
      embeds: [successEmbed(`<@${targetUser.id}> a été derank (VIP).`)]
    });
  }

  if (!role) {
    return interaction.reply({
      embeds: [errorEmbed('Précisez le rôle à retirer (ou utilisez /derank sans rôle si VIP).')],
      ephemeral: true
    });
  }

  // Raison obligatoire (sauf VIP)
  if (!isVIP(executor) && !reason) {
    return interaction.reply({
      embeds: [errorEmbed('Une raison est obligatoire pour derank.')],
      ephemeral: true
    });
  }

  const target = await interaction.guild.members.fetch(targetUser.id);
  await target.roles.remove(role.id);
  await interaction.reply({
    embeds: [successEmbed(`<@${targetUser.id}> a été derank du rôle <@&${role.id}>${reason ? ` — ${reason}` : ''}.`)]
  });
}

// ── EVENTS ────────────────────────────────────
client.once('ready', async () => {
  console.log(`[Bot] Connecté en tant que ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('[Bot] Commandes slash enregistrées');
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'rank') await handleRank(interaction);
  if (interaction.commandName === 'derank') await handleDerank(interaction);
});

// ── BLACKLIST EN MÉMOIRE ──────────────────────
// (remplacer par une BDD persistante en production)
const blacklistDB = new Map();

// ── SUIVI ANTI-ABUS ───────────────────────────
const abuseTracker = new Map();
// abuseLimitConfig: { [roleId]: { [action]: { max_count, window_minutes, penalty } } }
// À charger depuis votre dashboard Base44 (API fetch au démarrage recommandé)
const abuseLimitConfig = {};

function trackAbuse(userId, roleId, action) {
  const limitCfg = abuseLimitConfig[roleId]?.[action];
  if (!limitCfg) return false;
  if (!abuseTracker.has(userId)) abuseTracker.set(userId, {});
  const tracker = abuseTracker.get(userId);
  if (!tracker[action]) tracker[action] = [];
  const now = Date.now();
  const window = (limitCfg.window_minutes || 10) * 60_000;
  tracker[action] = tracker[action].filter(t => now - t < window);
  tracker[action].push(now);
  return tracker[action].length > (limitCfg.max_count || 5);
}

// ── COMMANDES PREFIX (?ban, ?bl, etc.) ────────
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  const args = message.content.trim().split(/\s+/);
  const cmd = args[0].toLowerCase();
  const isAdmin = message.member?.permissions.has(PermissionFlagsBits.Administrator);

  // ── ?ban ──────────────────────────────────
  if (cmd === '?ban' && isAdmin) {
    const target = message.mentions.users.first() || await client.users.fetch(args[1]).catch(() => null);
    if (!target) return message.reply({ embeds: [errorEmbed('Utilisateur introuvable.')] });
    const reason = args.slice(2).join(' ') || 'Aucune raison';
    await message.guild.members.ban(target.id, { reason }).catch(() => {});
    message.reply({ embeds: [new EmbedBuilder()
      .setColor(0xFF6B35)
      .setTitle('🔨 Utilisateur banni')
      .addFields(
        { name: 'Cible', value: `<@${target.id}> (${target.tag})`, inline: true },
        { name: 'Modérateur', value: `<@${message.author.id}>`, inline: true },
        { name: 'Raison', value: reason }
      ).setTimestamp()
    ]});
  }

  // ── ?unban ────────────────────────────────
  if (cmd === '?unban' && isAdmin) {
    const userId = args[1]?.replace(/[<@!>]/g, '');
    if (!userId) return message.reply({ embeds: [errorEmbed('Précisez un ID utilisateur.')] });
    await message.guild.members.unban(userId).catch(() => {});
    message.reply({ embeds: [new EmbedBuilder().setColor(0x57F287).setDescription(`✅ <@${userId}> a été débanni.`)] });
  }

  // ── ?baninfo ──────────────────────────────
  if (cmd === '?baninfo') {
    const userId = args[1]?.replace(/[<@!>]/g, '');
    const ban = await message.guild.bans.fetch(userId).catch(() => null);
    if (!ban) return message.reply({ embeds: [errorEmbed('Aucun ban trouvé.')] });
    message.reply({ embeds: [new EmbedBuilder()
      .setColor(0xFF6B35).setTitle('🔨 Informations Ban')
      .addFields(
        { name: 'Cible', value: `${ban.user.tag} (${ban.user.id})` },
        { name: 'Raison', value: ban.reason || 'Aucune raison' }
      ).setTimestamp()
    ]});
  }

  // ── ?bl ───────────────────────────────────
  if (cmd === '?bl' && isAdmin) {
    const target = message.mentions.users.first() || await client.users.fetch(args[1]).catch(() => null);
    if (!target) return message.reply({ embeds: [errorEmbed('Utilisateur introuvable.')] });
    const reason = args.slice(2).join(' ') || 'Aucune raison';
    blacklistDB.set(target.id, { userId: target.id, tag: target.tag, reason, modId: message.author.id, date: new Date() });
    await message.guild.members.kick(target.id, `Blacklisté : ${reason}`).catch(() => {});
    target.send(`Vous avez été blacklisté de **Maledike**. Raison : ${reason}`).catch(() => {});
    message.reply({ embeds: [new EmbedBuilder()
      .setColor(0xED4245).setTitle('🚫 Utilisateur blacklisté')
      .addFields(
        { name: 'Cible', value: `<@${target.id}> (${target.tag})`, inline: true },
        { name: 'Modérateur', value: `<@${message.author.id}>`, inline: true },
        { name: 'Raison', value: reason }
      ).setTimestamp()
    ]});
  }

  // ── ?unbl ─────────────────────────────────
  if (cmd === '?unbl' && isAdmin) {
    const userId = args[1]?.replace(/[<@!>]/g, '');
    blacklistDB.delete(userId);
    message.reply({ embeds: [new EmbedBuilder().setColor(0x57F287).setDescription(`✅ <@${userId}> retiré de la blacklist.`)] });
  }

  // ── ?blist ────────────────────────────────
  if (cmd === '?blist') {
    const entries = [...blacklistDB.values()];
    if (!entries.length) return message.reply({ embeds: [new EmbedBuilder().setColor(0x57F287).setDescription('✅ Aucune blacklist active.')] });
    const list = entries.slice(0, 20).map((e, i) => `${i + 1}. **${e.tag}** (${e.userId}) — ${e.reason}`).join('\n');
    message.reply({ embeds: [new EmbedBuilder().setColor(0xED4245).setTitle(`🚫 Blacklist (${entries.length})`).setDescription(list).setTimestamp()] });
  }

  // ── ?blinfo ───────────────────────────────
  if (cmd === '?blinfo') {
    const userId = args[1]?.replace(/[<@!>]/g, '');
    const entry = blacklistDB.get(userId);
    if (!entry) return message.reply({ embeds: [errorEmbed('Aucune blacklist trouvée.')] });
    const mod = await client.users.fetch(entry.modId).catch(() => null);
    message.reply({ embeds: [new EmbedBuilder()
      .setColor(0xED4245).setTitle('🚫 Informations Blacklist')
      .addFields(
        { name: 'Cible', value: `${entry.tag} (${entry.userId})` },
        { name: 'Modérateur', value: mod ? `${mod.tag}` : '🔴 Introuvable' },
        { name: 'Raison', value: entry.reason },
        { name: 'Date', value: entry.date.toLocaleString('fr-FR') }
      )
    ]});
  }
});

// ── AUTO-KICK BLACKLISTÉS ─────────────────────
client.on('guildMemberAdd', async member => {
  const entry = blacklistDB.get(member.id);
  if (entry) {
    member.send(`Vous avez été blacklisté de **Maledike**. Raison : ${entry.reason}`).catch(() => {});
    await member.kick('Blacklisté').catch(() => {});
  }
});
