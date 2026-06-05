// ============================================================
//  MALEDIKE BOT — index.js
//  Modération complète + Rank/Derank + Blacklist + Keep-Alive
//  Préfixe : ?   |   Owner Bot intégré   |   Protection totale
// ============================================================

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionsBitField,
  Collection,
  Events,
  AuditLogEvent,
} = require("discord.js");
const express = require("express");
const fetch   = require("node-fetch");
const fs      = require("fs");

// ─────────────────────────────────────────────
//  TOKEN — Secret File Render (/etc/secrets/TOKEN) ou env
// ─────────────────────────────────────────────
function loadToken() {
  try {
    const s = fs.readFileSync("/etc/secrets/TOKEN", "utf8").trim();
    if (s) return s;
  } catch {}
  return process.env.TOKEN || null;
}
const BOT_TOKEN = loadToken();
if (!BOT_TOKEN) {
  console.error("❌ TOKEN introuvable. Ajoutez un Secret File nommé TOKEN sur Render.");
  process.exit(1);
}

// ─────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────
const CONFIG = {
  TOKEN:     BOT_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  GUILD_ID:  process.env.GUILD_ID,

  // URL Render pour le keep-alive
  RENDER_URL: "https://hhh-eyls.onrender.com",

  // Owners du bot — immunité totale, accès à toutes les commandes
  // Modifiables en live via ?ownerbot / ?unownerbot
  OWNER_IDS: ["685679698054742017", "465620464232955911"],

  // Rôle VIP pouvant derank sans raison (IDs Discord)
  VIP_ROLES: [],

  // Plafond de rank par rôle : { roleID: roleIDplafond }
  RANK_CEILINGS: {},

  // Rôles protégés qu'on ne peut pas attribuer sans permission spéciale
  PROTECTED_ROLES: [],

  // Limites d'actions anti-abus par rôle
  // { roleID: { action: { max: X, window: secondes } } }
  ROLE_ACTION_LIMITS: {},

  // Whitelist de commandes : { commande: { roles: [], users: [] } }
  COMMAND_WHITELIST: {
    rank:    { roles: [], users: [] },
    derank:  { roles: [], users: [] },
    ban:     { roles: [], users: [] },
    unban:   { roles: [], users: [] },
    baninfo: { roles: [], users: [] },
    bl:      { roles: [], users: [] },
    unbl:    { roles: [], users: [] },
    blist:   { roles: [], users: [] },
    blinfo:  { roles: [], users: [] },
    config:  { roles: [], users: [] },
  },

  // Couleurs des embeds
  COLORS: {
    success:  0x2ecc71,
    error:    0xe74c3c,
    info:     0x3498db,
    warn:     0xf39c12,
    rank:     0x9b59b6,
    derank:   0xe67e22,
    ban:      0xc0392b,
    bl:       0x8e44ad,
    owner:    0xf1c40f,
    help:     0x1abc9c,
  },

  SERVER_NAME: "Maledike",
};

// ─────────────────────────────────────────────
//  STOCKAGE EN MÉMOIRE
// ─────────────────────────────────────────────
const store = {
  blacklist:       new Map(), // { userID: { reason, modId, date } }
  bans:            new Map(), // { userID: { reason, modId, date } }
  actionLogs:      new Map(), // { userID: { action: [timestamps] } }
  persistWarnings: new Map(), // { userID: count }
};

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────

/** Vérifie si un utilisateur est Owner Bot */
function isOwner(userId) {
  return CONFIG.OWNER_IDS.includes(userId);
}

/** Embed générique stylé */
function embed(color, title, description, fields = []) {
  const e = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
  if (fields.length) e.addFields(fields);
  return e;
}

/** Vérifie si un utilisateur a la permission d'utiliser une commande */
function hasPermission(member, command) {
  // Owner Bot → accès total
  if (isOwner(member.id)) return true;
  const wl = CONFIG.COMMAND_WHITELIST[command];
  if (!wl) return true;
  if (wl.users.includes(member.id)) return true;
  if (member.roles.cache.some((r) => wl.roles.includes(r.id))) return true;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  return false;
}

/** Enregistre une action pour l'anti-abus */
function logAction(userId, action) {
  if (!store.actionLogs.has(userId)) store.actionLogs.set(userId, {});
  const logs = store.actionLogs.get(userId);
  if (!logs[action]) logs[action] = [];
  logs[action].push(Date.now());
}

/** Vérifie si la limite d'actions est dépassée */
function isLimitExceeded(member, action) {
  if (isOwner(member.id)) return false; // Owners exemptés
  for (const [roleId, limits] of Object.entries(CONFIG.ROLE_ACTION_LIMITS)) {
    if (!member.roles.cache.has(roleId)) continue;
    const limit = limits[action];
    if (!limit) continue;
    const logs = store.actionLogs.get(member.id)?.[action] || [];
    const windowStart = Date.now() - limit.window * 1000;
    const recent = logs.filter((t) => t > windowStart);
    if (recent.length >= limit.max) return true;
  }
  return false;
}

/** Derank total d'un membre */
async function totalDerank(member, reason = "Anti-abus automatique") {
  try {
    const roles = member.roles.cache.filter((r) => r.id !== member.guild.id && r.editable);
    await member.roles.remove(roles, reason);
    return true;
  } catch {
    return false;
  }
}

/** Envoie un MP silencieux */
async function sendDM(user, content) {
  try { await user.send(content); } catch {}
}

/** Vérifie qu'un rôle rank ne dépasse pas son plafond */
function rankAllowed(rankerMember, roleToGive) {
  for (const [rankerId, ceilingId] of Object.entries(CONFIG.RANK_CEILINGS)) {
    if (!rankerMember.roles.cache.has(rankerId)) continue;
    const ceiling = rankerMember.guild.roles.cache.get(ceilingId);
    const target  = rankerMember.guild.roles.cache.get(roleToGive.id);
    if (!ceiling || !target) continue;
    if (target.comparePositionTo(ceiling) > 0) return false;
  }
  return true;
}

/**
 * Vérifie si la cible est un Owner Bot — bloque toute action sur eux.
 * Renvoie true si la cible est protégée (Owner).
 */
function targetIsOwner(targetId) {
  return isOwner(targetId);
}

// ─────────────────────────────────────────────
//  CLIENT DISCORD
// ─────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User],
});

// ─────────────────────────────────────────────
//  SLASH COMMANDS — DÉFINITION
// ─────────────────────────────────────────────
const slashCommands = [
  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("Attribue un rôle à un membre")
    .addUserOption((o) => o.setName("user").setDescription("Membre cible").setRequired(true))
    .addRoleOption((o) => o.setName("role").setDescription("Rôle à attribuer").setRequired(true)),

  new SlashCommandBuilder()
    .setName("derank")
    .setDescription("Retire un rôle à un membre")
    .addUserOption((o) => o.setName("user").setDescription("Membre cible").setRequired(true))
    .addRoleOption((o) => o.setName("role").setDescription("Rôle à retirer").setRequired(false))
    .addStringOption((o) => o.setName("raison").setDescription("Raison du derank").setRequired(false)),

  new SlashCommandBuilder()
    .setName("config")
    .setDescription("Configure le bot en live")
    .addStringOption((o) =>
      o.setName("action").setDescription("Action").setRequired(true).addChoices(
        { name: "Ajouter rôle whitelist",  value: "add_whitelist_role" },
        { name: "Retirer rôle whitelist",  value: "remove_whitelist_role" },
        { name: "Ajouter rôle protégé",    value: "add_protected" },
        { name: "Retirer rôle protégé",    value: "remove_protected" },
        { name: "Définir plafond rank",    value: "set_ceiling" },
        { name: "Ajouter rôle VIP derank", value: "add_vip" },
        { name: "Voir la config actuelle", value: "show" }
      )
    )
    .addStringOption((o) => o.setName("commande").setDescription("Commande concernée").setRequired(false))
    .addRoleOption((o) => o.setName("role").setDescription("Rôle concerné").setRequired(false))
    .addRoleOption((o) => o.setName("role2").setDescription("Rôle secondaire (plafond)").setRequired(false)),
].map((c) => c.toJSON());

// ─────────────────────────────────────────────
//  DÉPLOIEMENT DES COMMANDES SLASH (Guild = instantané)
// ─────────────────────────────────────────────
const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

(async () => {
  try {
    console.log("Déploiement des commandes slash...");
    if (CONFIG.GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CONFIG.CLIENT_ID, CONFIG.GUILD_ID), { body: slashCommands });
    } else {
      await rest.put(Routes.applicationCommands(CONFIG.CLIENT_ID), { body: slashCommands });
    }
    console.log("✅ Commandes slash déployées avec succès !");
  } catch (error) {
    console.error("❌ Erreur lors du déploiement des commandes:", error);
  }
})();

// ─────────────────────────────────────────────
//  ÉVÉNEMENTS DISCORD
// ─────────────────────────────────────────────
client.once("ready", () => {
  console.log(`✅ Bot connecté en tant que ${client.user.tag}`);
  startKeepAlive();
});

// ─────────────────────────────────────────────
//  GUILD MEMBER ADD — Blacklist check
// ─────────────────────────────────────────────
client.on(Events.GuildMemberAdd, async (member) => {
  const bl = store.blacklist.get(member.id);
  if (!bl) return;
  await sendDM(member.user, `> ⛔ **Vous avez été blacklisté de ${CONFIG.SERVER_NAME}.**\n> **Raison :** ${bl.reason}`);
  try { await member.kick(`[Blacklist] ${bl.reason}`); } catch {
    console.error(`Impossible de kick le membre blacklisté ${member.id}`);
  }
});

// ─────────────────────────────────────────────
//  SLASH COMMAND HANDLER
// ─────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, member, guild } = interaction;

  // ── /rank ──
  if (commandName === "rank") {
    if (!hasPermission(member, "rank")) {
      return interaction.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Accès refusé", "Vous n'avez pas la permission d'utiliser `/rank`.")], ephemeral: true });
    }
    const targetUser   = interaction.options.getUser("user");
    const role         = interaction.options.getRole("role");
    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);

    if (!targetMember) return interaction.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Introuvable", "Ce membre n'est pas sur le serveur.")], ephemeral: true });

    // Protéger les Owners
    if (targetIsOwner(targetUser.id)) {
      return interaction.reply({ embeds: [embed(CONFIG.COLORS.error, "🛡️ Protégé", "Vous ne pouvez pas utiliser une commande sur un Owner Bot.")], ephemeral: true });
    }

    if (CONFIG.PROTECTED_ROLES.includes(role.id)) {
      const warns = (store.persistWarnings.get(member.id) || 0) + 1;
      store.persistWarnings.set(member.id, warns);
      if (warns >= 2) {
        await totalDerank(member, "Persistance sur rôle protégé");
        await sendDM(member.user, `> ⚠️ Vous avez été **derank totalement** sur **${CONFIG.SERVER_NAME}** pour avoir persisté à attribuer un rôle protégé.`);
        store.persistWarnings.delete(member.id);
        return interaction.reply({ embeds: [embed(CONFIG.COLORS.error, "⛔ Derank automatique", `${member} a été derank totalement pour persistance.`)] });
      }
      return interaction.reply({ embeds: [embed(CONFIG.COLORS.error, "🛡️ Rôle protégé", `${member} Vous n'avez pas l'autorisation d'attribuer un rôle protégé.`)] });
    }

    if (!rankAllowed(member, role)) {
      return interaction.reply({ embeds: [embed(CONFIG.COLORS.error, "🚫 Plafond dépassé", "Vous ne pouvez pas attribuer un rôle supérieur à votre plafond autorisé.")], ephemeral: true });
    }
    if (isLimitExceeded(member, "rank")) {
      await totalDerank(member, "Dépassement limite rank");
      return interaction.reply({ embeds: [embed(CONFIG.COLORS.error, "⚠️ Limite dépassée", `${member} a dépassé la limite de ranks. Derank total appliqué.`)] });
    }
    logAction(member.id, "rank");
    try {
      await targetMember.roles.add(role, `Rank par ${member.user.tag}`);
      return interaction.reply({
        embeds: [embed(CONFIG.COLORS.rank, "✅ Rôle attribué", `Le rôle ${role} a été attribué à ${targetMember}.`, [
          { name: "👤 Exécuteur", value: `${member}`,       inline: true },
          { name: "🎯 Cible",     value: `${targetMember}`, inline: true },
          { name: "🏷️ Rôle",     value: `${role}`,         inline: true },
        ])],
      });
    } catch (err) {
      return interaction.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Erreur", `\`${err.message}\``)], ephemeral: true });
    }
  }

  // ── /derank ──
  if (commandName === "derank") {
    if (!hasPermission(member, "derank")) {
      return interaction.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Accès refusé", "Permission refusée.")], ephemeral: true });
    }
    const targetUser   = interaction.options.getUser("user");
    const role         = interaction.options.getRole("role");
    const raison       = interaction.options.getString("raison");
    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);

    if (!targetMember) return interaction.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Introuvable", "Ce membre n'est pas sur le serveur.")], ephemeral: true });
    if (targetIsOwner(targetUser.id)) {
      return interaction.reply({ embeds: [embed(CONFIG.COLORS.error, "🛡️ Protégé", "Vous ne pouvez pas utiliser une commande sur un Owner Bot.")], ephemeral: true });
    }

    const isVIP = member.roles.cache.some((r) => CONFIG.VIP_ROLES.includes(r.id));
    if (!isVIP && !raison) {
      return interaction.reply({ embeds: [embed(CONFIG.COLORS.error, "📝 Raison requise", "Vous devez fournir une raison pour effectuer un derank.")], ephemeral: true });
    }
    if (isLimitExceeded(member, "derank")) {
      await totalDerank(member, "Dépassement limite derank");
      return interaction.reply({ embeds: [embed(CONFIG.COLORS.error, "⚠️ Limite dépassée", `${member} a dépassé la limite de deranks. Derank total appliqué.`)] });
    }
    logAction(member.id, "derank");
    try {
      if (role) {
        await targetMember.roles.remove(role, raison || "Derank VIP");
        return interaction.reply({
          embeds: [embed(CONFIG.COLORS.derank, "🔻 Rôle retiré", `Le rôle ${role} a été retiré à ${targetMember}.`, [
            { name: "👤 Exécuteur", value: `${member}`,       inline: true },
            { name: "🎯 Cible",     value: `${targetMember}`, inline: true },
            { name: "🏷️ Rôle",     value: `${role}`,         inline: true },
            { name: "📝 Raison",    value: raison || "Aucune (VIP)", inline: false },
          ])],
        });
      } else {
        if (!isVIP) return interaction.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Précisez un rôle", "Veuillez préciser le rôle à retirer.")], ephemeral: true });
        await totalDerank(targetMember, raison || "Derank total VIP");
        return interaction.reply({
          embeds: [embed(CONFIG.COLORS.derank, "🔻 Derank total", `${targetMember} a été derank totalement.`, [
            { name: "👤 Exécuteur", value: `${member}`,       inline: true },
            { name: "🎯 Cible",     value: `${targetMember}`, inline: true },
          ])],
        });
      }
    } catch (err) {
      return interaction.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Erreur", `\`${err.message}\``)], ephemeral: true });
    }
  }

  // ── /config ──
  if (commandName === "config") {
    if (!hasPermission(member, "config")) {
      return interaction.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Accès refusé", "Permission refusée.")], ephemeral: true });
    }
    const action = interaction.options.getString("action");
    const role   = interaction.options.getRole("role");
    const role2  = interaction.options.getRole("role2");
    const cmd    = interaction.options.getString("commande");

    if (action === "show") {
      const desc = [
        `**Owners Bot :** ${CONFIG.OWNER_IDS.map((id) => `<@${id}>`).join(", ") || "Aucun"}`,
        `**Rôles VIP :** ${CONFIG.VIP_ROLES.map((id) => `<@&${id}>`).join(", ") || "Aucun"}`,
        `**Rôles protégés :** ${CONFIG.PROTECTED_ROLES.map((id) => `<@&${id}>`).join(", ") || "Aucun"}`,
        `**Plafonds rank :** ${Object.entries(CONFIG.RANK_CEILINGS).map(([k, v]) => `<@&${k}> → <@&${v}>`).join(", ") || "Aucun"}`,
      ].join("\n");
      return interaction.reply({ embeds: [embed(CONFIG.COLORS.info, "⚙️ Configuration actuelle", desc)], ephemeral: true });
    }
    if (action === "add_whitelist_role" && cmd && role) {
      if (!CONFIG.COMMAND_WHITELIST[cmd]) CONFIG.COMMAND_WHITELIST[cmd] = { roles: [], users: [] };
      if (!CONFIG.COMMAND_WHITELIST[cmd].roles.includes(role.id)) CONFIG.COMMAND_WHITELIST[cmd].roles.push(role.id);
      return interaction.reply({ embeds: [embed(CONFIG.COLORS.success, "✅ Whitelist", `${role} peut utiliser \`/${cmd}\`.`)], ephemeral: true });
    }
    if (action === "remove_whitelist_role" && cmd && role) {
      if (CONFIG.COMMAND_WHITELIST[cmd]) CONFIG.COMMAND_WHITELIST[cmd].roles = CONFIG.COMMAND_WHITELIST[cmd].roles.filter((id) => id !== role.id);
      return interaction.reply({ embeds: [embed(CONFIG.COLORS.success, "✅ Whitelist", `${role} ne peut plus utiliser \`/${cmd}\`.`)], ephemeral: true });
    }
    if (action === "add_protected" && role) {
      if (!CONFIG.PROTECTED_ROLES.includes(role.id)) CONFIG.PROTECTED_ROLES.push(role.id);
      return interaction.reply({ embeds: [embed(CONFIG.COLORS.success, "🛡️ Protégé", `${role} est maintenant protégé.`)], ephemeral: true });
    }
    if (action === "remove_protected" && role) {
      const i = CONFIG.PROTECTED_ROLES.indexOf(role.id);
      if (i > -1) CONFIG.PROTECTED_ROLES.splice(i, 1);
      return interaction.reply({ embeds: [embed(CONFIG.COLORS.success, "🛡️ Protection retirée", `${role} n'est plus protégé.`)], ephemeral: true });
    }
    if (action === "set_ceiling" && role && role2) {
      CONFIG.RANK_CEILINGS[role.id] = role2.id;
      return interaction.reply({ embeds: [embed(CONFIG.COLORS.success, "🏔️ Plafond défini", `${role} peut rank jusqu'au maximum ${role2}.`)], ephemeral: true });
    }
    if (action === "add_vip" && role) {
      if (!CONFIG.VIP_ROLES.includes(role.id)) CONFIG.VIP_ROLES.push(role.id);
      return interaction.reply({ embeds: [embed(CONFIG.COLORS.success, "⭐ VIP ajouté", `${role} peut derank sans raison.`)], ephemeral: true });
    }
    return interaction.reply({ embeds: [embed(CONFIG.COLORS.warn, "⚠️ Incomplet", "Veuillez renseigner tous les paramètres nécessaires.")], ephemeral: true });
  }
});

// ─────────────────────────────────────────────
//  PREFIX COMMAND HANDLER — préfixe « ? »
// ─────────────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  // Ignorer les bots SAUF si c'est un bot géré par le serveur
  // (le bot écoute les commandes humaines uniquement)
  if (message.author.bot || !message.guild) return;

  const content = message.content.trim();
  const PREFIX  = "?";
  if (!content.startsWith(PREFIX)) return;

  const args    = content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();
  const guild   = message.guild;
  const member  = message.member;

  // ════════════════════════════════════════════
  //  OWNER BOT COMMANDS
  // ════════════════════════════════════════════

  // ── ?ownerbot @user/ID ──
  if (command === "ownerbot") {
    if (!isOwner(member.id)) {
      return message.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Accès refusé", "Seuls les Owners Bot peuvent utiliser cette commande.")] });
    }
    const targetId = args[0]?.replace(/[<@!>]/g, "");
    if (!targetId) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Usage", "`?ownerbot @user/ID`")] });
    if (CONFIG.OWNER_IDS.includes(targetId)) {
      return message.reply({ embeds: [embed(CONFIG.COLORS.warn, "⚠️ Déjà Owner", "Cet utilisateur est déjà Owner Bot.")] });
    }
    CONFIG.OWNER_IDS.push(targetId);
    const u = await client.users.fetch(targetId).catch(() => null);
    return message.reply({
      embeds: [embed(CONFIG.COLORS.owner, "👑 Owner Bot ajouté", `${u ? `${u.tag} (${targetId})` : targetId} est maintenant **Owner Bot**.`, [
        { name: "👤 Ajouté par", value: `${member}`, inline: true },
      ])],
    });
  }

  // ── ?unownerbot @user/ID ──
  if (command === "unownerbot") {
    if (!isOwner(member.id)) {
      return message.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Accès refusé", "Seuls les Owners Bot peuvent utiliser cette commande.")] });
    }
    const targetId = args[0]?.replace(/[<@!>]/g, "");
    if (!targetId) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Usage", "`?unownerbot @user/ID`")] });
    // Empêcher de retirer les owners permanents hardcodés
    const HARDCODED = ["685679698054742017", "465620464232955911"];
    if (HARDCODED.includes(targetId)) {
      return message.reply({ embeds: [embed(CONFIG.COLORS.error, "🔒 Protégé", "Impossible de retirer un Owner Bot originel.")] });
    }
    const idx = CONFIG.OWNER_IDS.indexOf(targetId);
    if (idx === -1) {
      return message.reply({ embeds: [embed(CONFIG.COLORS.warn, "⚠️ Introuvable", "Cet utilisateur n'est pas Owner Bot.")] });
    }
    CONFIG.OWNER_IDS.splice(idx, 1);
    const u = await client.users.fetch(targetId).catch(() => null);
    return message.reply({
      embeds: [embed(CONFIG.COLORS.success, "✅ Owner Bot retiré", `${u ? `${u.tag} (${targetId})` : targetId} n'est plus Owner Bot.`)],
    });
  }

  // ── ?ownerbotlist ──
  if (command === "ownerbotlist") {
    if (!isOwner(member.id)) {
      return message.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Accès refusé", "Seuls les Owners Bot peuvent utiliser cette commande.")] });
    }
    const lines = [];
    for (const id of CONFIG.OWNER_IDS) {
      const u = await client.users.fetch(id).catch(() => null);
      const hardcoded = ["685679698054742017", "465620464232955911"].includes(id);
      lines.push(`• ${u ? `**${u.tag}**` : `\`${id}\``} — \`${id}\` ${hardcoded ? "🔒" : ""}`);
    }
    return message.reply({
      embeds: [embed(CONFIG.COLORS.owner, `👑 Owners Bot (${CONFIG.OWNER_IDS.length})`,
        lines.join("\n") || "Aucun owner défini.", [
          { name: "ℹ️ Info", value: "🔒 = Owner originel non supprimable", inline: false },
        ]
      )],
    });
  }

  // ════════════════════════════════════════════
  //  ?help
  // ════════════════════════════════════════════
  if (command === "help") {
    const helpEmbed = new EmbedBuilder()
      .setColor(CONFIG.COLORS.help)
      .setTitle("📖 Aide — Maledike Bot")
      .setDescription("Toutes les commandes utilisent le préfixe **`?`**")
      .addFields(
        {
          name: "━━━ 👑 Owner Bot",
          value: [
            "`?ownerbot @user/ID` — Ajouter un Owner Bot",
            "`?unownerbot @user/ID` — Retirer un Owner Bot",
            "`?ownerbotlist` — Liste des Owners Bot",
          ].join("\n"),
        },
        {
          name: "━━━ 🔨 Modération",
          value: [
            "`?ban @user/ID [raison]` — Bannir un utilisateur",
            "`?unban @user/ID` — Débannir un utilisateur",
            "`?baninfo @user/ID` — Infos sur un ban",
          ].join("\n"),
        },
        {
          name: "━━━ ⛔ Blacklist",
          value: [
            "`?bl @user/ID [raison]` — Blacklister un utilisateur",
            "`?unbl @user/ID` — Retirer la blacklist",
            "`?blist` — Liste des blacklistés",
            "`?blinfo @user/ID` — Infos sur une blacklist",
          ].join("\n"),
        },
        {
          name: "━━━ 🎭 Slash Commands",
          value: [
            "`/rank @user @role` — Attribuer un rôle",
            "`/derank @user [@role] [raison]` — Retirer un rôle",
            "`/config` — Configurer le bot en live",
          ].join("\n"),
        },
        {
          name: "━━━ ℹ️ Notes",
          value: [
            "• Les **Owners Bot** sont immunisés contre toutes les commandes.",
            "• Les admins ont accès à toutes les commandes.",
            "• Les whitelist se configurent via `/config`.",
          ].join("\n"),
        }
      )
      .setFooter({ text: `${CONFIG.SERVER_NAME} Bot • Préfixe : ?` })
      .setTimestamp();
    return message.reply({ embeds: [helpEmbed] });
  }

  // ════════════════════════════════════════════
  //  PROTECTION OWNER — bloque toute commande
  //  visant un Owner Bot
  // ════════════════════════════════════════════
  // On extrait la cible potentielle pour toutes les commandes suivantes
  const potentialTargetId = args[0]?.replace(/[<@!>]/g, "");
  if (potentialTargetId && targetIsOwner(potentialTargetId)) {
    const cmdList = ["ban", "unban", "bl", "unbl", "blinfo", "baninfo", "rank", "derank"];
    if (cmdList.includes(command)) {
      return message.reply({
        embeds: [embed(CONFIG.COLORS.error, "🛡️ Action impossible", "Vous ne pouvez pas utiliser une commande sur un **Owner Bot**.")],
      });
    }
  }

  // ════════════════════════════════════════════
  //  MODÉRATION
  // ════════════════════════════════════════════

  // ── ?ban ──
  if (command === "ban") {
    if (!hasPermission(member, "ban")) {
      return message.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Accès refusé", "Permission refusée.")] });
    }
    const targetId = args[0]?.replace(/[<@!>]/g, "");
    const raison   = args.slice(1).join(" ") || "Aucune raison fournie";
    if (!targetId) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Usage", "`?ban @user/ID [raison]`")] });

    const targetUser = await client.users.fetch(targetId).catch(() => null);
    if (!targetUser) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Introuvable", "Impossible de trouver cet utilisateur.")] });

    try {
      await guild.bans.create(targetId, { reason: raison, deleteMessageSeconds: 604800 });
      store.bans.set(targetId, { reason: raison, modId: member.id, date: new Date().toISOString() });
      return message.reply({
        embeds: [embed(CONFIG.COLORS.ban, "🔨 Banni", `${targetUser.tag} a été banni du serveur.`, [
          { name: "👤 Exécuteur", value: `${member}`,                          inline: true },
          { name: "🎯 Cible",     value: `${targetUser.tag} (${targetId})`,    inline: true },
          { name: "📝 Raison",    value: raison,                               inline: false },
        ])],
      });
    } catch (err) {
      return message.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Erreur", `\`${err.message}\``)] });
    }
  }

  // ── ?unban ──
  if (command === "unban") {
    if (!hasPermission(member, "unban")) {
      return message.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Accès refusé", "Permission refusée.")] });
    }
    const targetId = args[0]?.replace(/[<@!>]/g, "");
    if (!targetId) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Usage", "`?unban @user/ID`")] });
    try {
      await guild.bans.remove(targetId);
      store.bans.delete(targetId);
      return message.reply({ embeds: [embed(CONFIG.COLORS.success, "✅ Débanni", `L'utilisateur \`${targetId}\` a été débanni.`)] });
    } catch (err) {
      return message.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Erreur", `\`${err.message}\``)] });
    }
  }

  // ── ?baninfo ──
  if (command === "baninfo") {
    if (!hasPermission(member, "baninfo")) {
      return message.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Accès refusé", "Permission refusée.")] });
    }
    const targetId = args[0]?.replace(/[<@!>]/g, "");
    if (!targetId) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Usage", "`?baninfo @user/ID`")] });

    const banData = store.bans.get(targetId);
    let guildBan  = null;
    try { guildBan = await guild.bans.fetch(targetId); } catch {}

    if (!banData && !guildBan) {
      return message.reply({ embeds: [embed(CONFIG.COLORS.info, "ℹ️ Aucun ban", "Cet utilisateur n'est pas banni.")] });
    }
    const targetUser = await client.users.fetch(targetId).catch(() => null);
    let modDisplay   = "🔴 Modérateur introuvable";
    if (banData?.modId) {
      const mod = await client.users.fetch(banData.modId).catch(() => null);
      modDisplay = mod ? `${mod.tag} (${mod.id})` : "🔴 Introuvable";
    }
    return message.reply({
      embeds: [embed(CONFIG.COLORS.ban, "📋 Informations du ban", `Détails pour \`${targetUser?.tag || targetId}\``, [
        { name: "🎯 Cible",      value: targetUser ? `${targetUser.tag} (${targetId})` : targetId, inline: true },
        { name: "👮 Modérateur", value: modDisplay,                                                inline: true },
        { name: "📝 Raison",     value: banData?.reason || guildBan?.reason || "Inconnue",         inline: false },
        { name: "📅 Date",       value: banData?.date ? `<t:${Math.floor(new Date(banData.date).getTime() / 1000)}:F>` : "Inconnue", inline: false },
      ])],
    });
  }

  // ════════════════════════════════════════════
  //  BLACKLIST
  // ════════════════════════════════════════════

  // ── ?bl ──
  if (command === "bl") {
    if (!hasPermission(member, "bl")) {
      return message.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Accès refusé", "Permission refusée.")] });
    }
    const targetId = args[0]?.replace(/[<@!>]/g, "");
    const raison   = args.slice(1).join(" ") || "Aucune raison fournie";
    if (!targetId) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Usage", "`?bl @user/ID [raison]`")] });

    const targetUser   = await client.users.fetch(targetId).catch(() => null);
    store.blacklist.set(targetId, { reason: raison, modId: member.id, date: new Date().toISOString() });

    const targetMember = await guild.members.fetch(targetId).catch(() => null);
    if (targetMember) {
      await sendDM(targetMember.user, `> ⛔ **Vous avez été blacklisté de ${CONFIG.SERVER_NAME}.**\n> **Raison :** ${raison}`);
      try { await targetMember.kick(`[Blacklist] ${raison}`); } catch {}
    }
    return message.reply({
      embeds: [embed(CONFIG.COLORS.bl, "⛔ Blacklisté", `${targetUser?.tag || targetId} a été blacklisté.`, [
        { name: "👤 Exécuteur", value: `${member}`,                                                         inline: true },
        { name: "🎯 Cible",     value: targetUser ? `${targetUser.tag} (${targetId})` : targetId,           inline: true },
        { name: "📝 Raison",    value: raison,                                                               inline: false },
      ])],
    });
  }

  // ── ?unbl ──
  if (command === "unbl") {
    if (!hasPermission(member, "unbl")) {
      return message.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Accès refusé", "Permission refusée.")] });
    }
    const targetId = args[0]?.replace(/[<@!>]/g, "");
    if (!targetId) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Usage", "`?unbl @user/ID`")] });
    if (!store.blacklist.has(targetId)) {
      return message.reply({ embeds: [embed(CONFIG.COLORS.warn, "⚠️ Introuvable", "Cet utilisateur n'est pas blacklisté.")] });
    }
    store.blacklist.delete(targetId);
    return message.reply({ embeds: [embed(CONFIG.COLORS.success, "✅ Blacklist retirée", `\`${targetId}\` a été retiré de la blacklist.`)] });
  }

  // ── ?blist ──
  if (command === "blist") {
    if (!hasPermission(member, "blist")) {
      return message.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Accès refusé", "Permission refusée.")] });
    }
    if (store.blacklist.size === 0) {
      return message.reply({ embeds: [embed(CONFIG.COLORS.info, "📋 Blacklist vide", "Aucun utilisateur n'est actuellement blacklisté.")] });
    }
    const entries = [];
    for (const [id, data] of store.blacklist.entries()) {
      const u = await client.users.fetch(id).catch(() => null);
      entries.push(`• **${u?.tag || id}** — ${data.reason} (<t:${Math.floor(new Date(data.date).getTime() / 1000)}:d>)`);
    }
    const chunks = [];
    let current  = "";
    for (const line of entries) {
      if ((current + "\n" + line).length > 1000) { chunks.push(current); current = line; }
      else current += (current ? "\n" : "") + line;
    }
    if (current) chunks.push(current);
    for (let i = 0; i < chunks.length; i++) {
      await message.reply({ embeds: [embed(CONFIG.COLORS.bl, `⛔ Blacklist (${store.blacklist.size}) — ${i + 1}/${chunks.length}`, chunks[i])] });
    }
    return;
  }

  // ── ?blinfo ──
  if (command === "blinfo") {
    if (!hasPermission(member, "blinfo")) {
      return message.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Accès refusé", "Permission refusée.")] });
    }
    const targetId = args[0]?.replace(/[<@!>]/g, "");
    if (!targetId) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "❌ Usage", "`?blinfo @user/ID`")] });
    const blData = store.blacklist.get(targetId);
    if (!blData) return message.reply({ embeds: [embed(CONFIG.COLORS.info, "ℹ️ Non blacklisté", "Cet utilisateur n'est pas dans la blacklist.")] });

    const targetUser = await client.users.fetch(targetId).catch(() => null);
    let modDisplay   = "🔴 Modérateur introuvable";
    if (blData.modId) {
      const mod = await client.users.fetch(blData.modId).catch(() => null);
      modDisplay = mod ? `${mod.tag} (${mod.id})` : "🔴 Introuvable";
    }
    return message.reply({
      embeds: [embed(CONFIG.COLORS.bl, "📋 Informations de la blacklist", `Détails pour \`${targetUser?.tag || targetId}\``, [
        { name: "🎯 Cible",      value: targetUser ? `${targetUser.tag} (${targetId})` : targetId, inline: true },
        { name: "👮 Modérateur", value: modDisplay,                                                 inline: true },
        { name: "📝 Raison",     value: blData.reason,                                              inline: false },
        { name: "📅 Date",       value: `<t:${Math.floor(new Date(blData.date).getTime() / 1000)}:F>`, inline: false },
      ])],
    });
  }
});

// ─────────────────────────────────────────────
//  KEEP-ALIVE (Express + self-ping)
// ─────────────────────────────────────────────
function startKeepAlive() {
  const app = express();
  app.get("/",     (_req, res) => res.send("✅ Bot en ligne."));
  app.get("/ping", (_req, res) => res.json({ status: "ok", uptime: process.uptime() }));

  const PORT = process.env.PORT || 10000;
  app.listen(PORT, () => console.log(`🌐 Serveur keep-alive sur le port ${PORT}`));

  // Self-ping toutes les 60 secondes
  setInterval(async () => {
    try { await fetch(`${CONFIG.RENDER_URL}/ping`); } catch {}
  }, 60 * 1000);
}

// ─────────────────────────────────────────────
//  CONNEXION DU BOT
// ─────────────────────────────────────────────
client.login(BOT_TOKEN).catch((err) => {
  console.error("❌ Erreur de connexion Discord:", err.message);
  process.exit(1);
});
