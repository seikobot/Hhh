// ============================================================
//  MALEDIKE BOT — index.js  (version complète)
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
  Events,
  ActivityType,
} = require("discord.js");
const express = require("express");
const fetch   = require("node-fetch");
const fs      = require("fs");

// ─────────────────────────────────────────────
//  TOKEN
// ─────────────────────────────────────────────
function loadToken() {
  try {
    const s = fs.readFileSync("/etc/secrets/TOKEN", "utf8").trim();
    if (s) return s;
  } catch {}
  return process.env.TOKEN || null;
}
const BOT_TOKEN = loadToken();
if (!BOT_TOKEN) { console.error("TOKEN introuvable."); process.exit(1); }

// ─────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────
const CONFIG = {
  TOKEN:       BOT_TOKEN,
  CLIENT_ID:   "1512391751653130310",
  GUILD_ID:    "1511274220699783298",
  RENDER_URL:  "https://hhh-eyls.onrender.com",
  SERVER_NAME: "Maledike",
  OWNER_IDS:   ["685679698054742017", "465620464232955911"],
  HARDCODED:   ["685679698054742017", "465620464232955911"],
  RANK_CONFIG: [],

  // Permissions configurables via /setperms
  PERMS: {
    bl:            { roles: [], users: [] },  // peut /bl
    unbl:          { roles: [], users: [] },  // peut /unbl (sauf si bl par owner/system)
    ban:           { roles: [], users: [] },  // peut /ban
    bl_no_reason:  { roles: [], users: [] },  // peut /bl sans raison
    ban_no_reason: { roles: [], users: [] },  // peut /ban sans raison
    rank:          { roles: [], users: [] },  // peut /rank /derank
    wakeup:        { roles: [], users: [] },  // peut /wakeup
    system:        { roles: [], users: [] },  // affiché "system" sur blinfo/baninfo
  },
};

// ─────────────────────────────────────────────
//  STOCKAGE EN MÉMOIRE
// ─────────────────────────────────────────────
const store = {
  blacklist: new Map(),  // id → { reason, modId, modType, date }
  bans:      new Map(),  // id → { reason, modId, modType, date }
  ourBans:   new Set(),  // IDs bannis par notre bot (évite double DM)
  ourKicks:  new Set(),  // IDs kickés par notre bot (évite double DM)
};

// ─────────────────────────────────────────────
//  HELPERS PERMISSION
// ─────────────────────────────────────────────
const isOwner  = (id)     => CONFIG.OWNER_IDS.includes(id);
const isAdmin  = (member) => member.permissions.has(PermissionsBitField.Flags.Administrator);

function hasPerm(member, key) {
  if (isOwner(member.id)) return true;
  const p = CONFIG.PERMS[key];
  if (!p) return false;
  if (p.users.includes(member.id)) return true;
  if (member.roles.cache.some(r => p.roles.includes(r.id))) return true;
  return false;
}

function getModType(member) {
  if (isOwner(member.id)) return "system+";
  const p = CONFIG.PERMS["system"];
  if (p && (p.users.includes(member.id) || member.roles.cache.some(r => p.roles.includes(r.id)))) return "system";
  return "moderator";
}

function modLabel(modType) {
  if (modType === "system+") return "Blacklisté par System+";
  if (modType === "system")  return "Blacklisté par System";
  return "Modérateur";
}

function banModLabel(modType) {
  if (modType === "system+") return "Banni par System+";
  if (modType === "system")  return "Banni par System";
  return "Modérateur";
}

function blDMText(reason, modType, noReason) {
  if (noReason || modType === "system+" || modType === "system") {
    return `Vous avez été **blacklisté** de **${CONFIG.SERVER_NAME}**.`;
  }
  return `Vous avez été **blacklisté** de **${CONFIG.SERVER_NAME}**.\nRaison : ${reason}`;
}

function banDMText(reason, modType, noReason) {
  if (noReason || modType === "system+" || modType === "system") {
    return `Vous avez été **banni** de **${CONFIG.SERVER_NAME}**.`;
  }
  return `Vous avez été **banni** de **${CONFIG.SERVER_NAME}**.\nRaison : ${reason}`;
}

// ─────────────────────────────────────────────
//  HELPERS RANK
// ─────────────────────────────────────────────
function getRankRule(roleId) {
  return CONFIG.RANK_CONFIG.find(r => r.rankRole === roleId) || null;
}

function canRank(member, roleId) {
  if (isOwner(member.id) || isAdmin(member) || hasPerm(member, "rank")) return true;
  const rule = getRankRule(roleId);
  if (!rule || rule.allowedRoles.length === 0) return true;
  return member.roles.cache.some(r => rule.allowedRoles.includes(r.id));
}

function exceedsCeiling(member, roleToGiveId) {
  if (isOwner(member.id) || isAdmin(member)) return false;
  for (const rule of CONFIG.RANK_CONFIG) {
    if (rule.maxRole && rule.allowedRoles.some(r => member.roles.cache.has(r))) {
      const ceiling = member.guild.roles.cache.get(rule.maxRole);
      const target  = member.guild.roles.cache.get(roleToGiveId);
      if (ceiling && target && target.comparePositionTo(ceiling) > 0) return true;
    }
  }
  return false;
}

async function totalDerank(member) {
  try {
    const roles = member.roles.cache.filter(r => r.id !== member.guild.id && r.editable);
    await member.roles.remove(roles, "Derank total");
  } catch {}
}

// ─────────────────────────────────────────────
//  HELPER DM
// ─────────────────────────────────────────────
async function sendDM(user, content) {
  try {
    if (typeof content === "string") await user.send({ content });
    else await user.send({ embeds: [content] });
  } catch {}
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
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User],
});

// ─────────────────────────────────────────────
//  SLASH COMMANDS (sans aucun doublon)
// ─────────────────────────────────────────────
const slashCommands = [

  // ── GÉNÉRAL ──────────────────────────────────
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Affiche toutes les commandes (Owner uniquement)"),

  // ── RANGS ────────────────────────────────────
  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("Attribue un rôle à un membre")
    .addUserOption(o => o.setName("membre").setDescription("Membre à rank").setRequired(true))
    .addRoleOption(o => o.setName("role").setDescription("Rôle à attribuer").setRequired(true)),

  new SlashCommandBuilder()
    .setName("derank")
    .setDescription("Retire tous les rôles d'un membre")
    .addUserOption(o => o.setName("membre").setDescription("Membre à derank").setRequired(true))
    .addStringOption(o => o.setName("raison").setDescription("Raison").setRequired(true)),

  new SlashCommandBuilder()
    .setName("rankconfig")
    .setDescription("Configure les règles de rang (Owner uniquement)")
    .addStringOption(o =>
      o.setName("action").setDescription("Action").setRequired(true)
        .addChoices(
          { name: "Ajouter une règle",              value: "add"        },
          { name: "Supprimer une règle",            value: "remove"     },
          { name: "Voir toutes les règles",         value: "show"       },
          { name: "Définir rôles autorisés à rank", value: "setallowed" },
          { name: "Définir rôle plafond max",       value: "setceiling" },
          { name: "Lier rôles auto au rank",        value: "linkroles"  },
        ))
    .addRoleOption(o => o.setName("role").setDescription("Rôle principal").setRequired(false))
    .addRoleOption(o => o.setName("role2").setDescription("Rôle secondaire").setRequired(false))
    .addRoleOption(o => o.setName("role3").setDescription("Rôle lié supplémentaire").setRequired(false))
    .addRoleOption(o => o.setName("role4").setDescription("Rôle lié supplémentaire").setRequired(false))
    .addRoleOption(o => o.setName("roleautorise").setDescription("Rôle autorisé à donner ce rang").setRequired(false)),

  // ── OWNER BOT ────────────────────────────────
  new SlashCommandBuilder()
    .setName("ownerbot")
    .setDescription("Ajouter un Owner Bot (Owner uniquement)")
    .addUserOption(o => o.setName("membre").setDescription("Membre à promouvoir").setRequired(true)),

  new SlashCommandBuilder()
    .setName("unownerbot")
    .setDescription("Retirer un Owner Bot (Owner uniquement)")
    .addUserOption(o => o.setName("membre").setDescription("Membre à rétrograder").setRequired(true)),

  new SlashCommandBuilder()
    .setName("ownerbotlist")
    .setDescription("Liste des Owners Bot (Owner uniquement)"),

  // ── BAN ──────────────────────────────────────
  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Bannir un membre du serveur")
    .addUserOption(o => o.setName("membre").setDescription("Membre à bannir").setRequired(true))
    .addStringOption(o => o.setName("raison").setDescription("Raison (optionnelle si permission)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Débannir un utilisateur")
    .addStringOption(o => o.setName("id").setDescription("ID de l'utilisateur").setRequired(true)),

  new SlashCommandBuilder()
    .setName("baninfo")
    .setDescription("Informations sur un ban")
    .addStringOption(o => o.setName("id").setDescription("ID de l'utilisateur").setRequired(true)),

  // ── BLACKLIST ─────────────────────────────────
  new SlashCommandBuilder()
    .setName("bl")
    .setDescription("Blacklister un utilisateur (@mention ou ID)")
    .addUserOption(o => o.setName("membre").setDescription("Mentionner le membre").setRequired(false))
    .addStringOption(o => o.setName("id").setDescription("ID de l'utilisateur (si pas sur le serveur)").setRequired(false))
    .addStringOption(o => o.setName("raison").setDescription("Raison (optionnelle si permission)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("unbl")
    .setDescription("Retirer un utilisateur de la blacklist (Owner uniquement)")
    .addStringOption(o => o.setName("id").setDescription("ID de l'utilisateur").setRequired(true)),

  new SlashCommandBuilder()
    .setName("blist")
    .setDescription("Liste des utilisateurs blacklistés"),

  new SlashCommandBuilder()
    .setName("blinfo")
    .setDescription("Informations sur une blacklist (@mention ou ID)")
    .addUserOption(o => o.setName("membre").setDescription("Mentionner le membre").setRequired(false))
    .addStringOption(o => o.setName("id").setDescription("ID de l'utilisateur").setRequired(false)),

  // ── WAKEUP ────────────────────────────────────
  new SlashCommandBuilder()
    .setName("wakeup")
    .setDescription("Déplace un membre dans tous les vocaux pendant 20 secondes")
    .addUserOption(o => o.setName("membre").setDescription("Membre à wakeup").setRequired(true)),

  // ── SETPERMS ─────────────────────────────────
  new SlashCommandBuilder()
    .setName("setperms")
    .setDescription("Configurer qui peut utiliser chaque catégorie (Owner uniquement)")
    .addStringOption(o =>
      o.setName("action").setDescription("Permission à configurer").setRequired(true)
        .addChoices(
          { name: "Qui peut /bl",               value: "bl"            },
          { name: "Qui peut /unbl",             value: "unbl"          },
          { name: "Qui peut /ban",              value: "ban"           },
          { name: "Qui peut /bl sans raison",   value: "bl_no_reason"  },
          { name: "Qui peut /ban sans raison",  value: "ban_no_reason" },
          { name: "Qui peut /rank et /derank",  value: "rank"          },
          { name: "Qui peut /wakeup",           value: "wakeup"        },
          { name: "Désigner comme System",      value: "system"        },
        ))
    .addStringOption(o =>
      o.setName("type").setDescription("Ajouter, retirer ou afficher").setRequired(true)
        .addChoices(
          { name: "Ajouter",  value: "add"    },
          { name: "Retirer",  value: "remove" },
          { name: "Afficher", value: "show"   },
        ))
    .addRoleOption(o => o.setName("role").setDescription("Rôle à configurer").setRequired(false))
    .addUserOption(o => o.setName("utilisateur").setDescription("Utilisateur à configurer").setRequired(false)),

].map(c => c.toJSON());

// ─────────────────────────────────────────────
//  READY
// ─────────────────────────────────────────────
const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

client.once("ready", async () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);
  try {
    await rest.put(
      Routes.applicationGuildCommands(CONFIG.CLIENT_ID, CONFIG.GUILD_ID),
      { body: slashCommands }
    );
    console.log("✅ Commandes slash déployées.");
  } catch (err) {
    console.error("❌ Erreur déploiement:", err.message);
  }
  client.user.setPresence({
    activities: [{ name: "discord.gg/maledike", type: ActivityType.Playing }],
    status: "online",
  });
  startKeepAlive();
});

// ─────────────────────────────────────────────
//  GUILD MEMBER ADD — vérif blacklist à l'arrivée
// ─────────────────────────────────────────────
client.on(Events.GuildMemberAdd, async (member) => {
  const bl = store.blacklist.get(member.id);
  if (!bl) return;
  const noReason = (bl.modType === "system+" || bl.modType === "system");
  await sendDM(member.user, new EmbedBuilder()
    .setColor(0xcc0000)
    .setDescription(blDMText(bl.reason, bl.modType, noReason))
    .setFooter({ text: "Maledike • discord.gg/maledike" })
  );
  try { await member.kick(`[Blacklist] ${bl.reason}`); } catch {}
});

// ─────────────────────────────────────────────
//  DÉTECTION BAN PAR UN AUTRE BOT → DM victime
// ─────────────────────────────────────────────
client.on(Events.GuildBanAdd, async (ban) => {
  // Si le ban vient de notre propre commande /ban, on ignore (déjà géré)
  if (store.ourBans.has(ban.user.id)) {
    store.ourBans.delete(ban.user.id);
    return;
  }
  // Vérifier dans les logs d'audit si c'est un bot externe
  try {
    await new Promise(r => setTimeout(r, 1500)); // petit délai pour que l'audit log arrive
    const logs = await ban.guild.fetchAuditLogs({ limit: 1, type: 22 }); // BAN_MEMBER
    const entry = logs.entries.first();
    if (!entry) return;
    const isRecent = (Date.now() - entry.createdTimestamp) < 5000;
    if (!isRecent || entry.target.id !== ban.user.id) return;
    // Si c'est un bot autre que nous
    if (entry.executor.bot && entry.executor.id !== CONFIG.CLIENT_ID) {
      await ban.user.send({ embeds: [
        new EmbedBuilder()
          .setColor(0xcc0000)
          .setDescription(`Vous avez été **banni** de **${CONFIG.SERVER_NAME}**.`)
          .setFooter({ text: "Maledike • discord.gg/maledike" })
      ]}).catch(() => {});
    }
  } catch {}
});

// ─────────────────────────────────────────────
//  DÉTECTION KICK/BL PAR UN AUTRE BOT → DM victime
// ─────────────────────────────────────────────
client.on(Events.GuildMemberRemove, async (member) => {
  if (store.blacklist.has(member.id)) return; // déjà géré par notre bot
  if (store.ourKicks.has(member.id)) {
    store.ourKicks.delete(member.id);
    return;
  }
  try {
    await new Promise(r => setTimeout(r, 1500));
    const logs = await member.guild.fetchAuditLogs({ limit: 1, type: 20 }); // MEMBER_KICK
    const entry = logs.entries.first();
    if (!entry) return;
    const isRecent = (Date.now() - entry.createdTimestamp) < 5000;
    if (!isRecent || entry.target.id !== member.id) return;
    if (entry.executor.bot && entry.executor.id !== CONFIG.CLIENT_ID) {
      await member.user.send({ embeds: [
        new EmbedBuilder()
          .setColor(0xcc0000)
          .setDescription(`Vous avez été **blacklisté** de **${CONFIG.SERVER_NAME}**.`)
          .setFooter({ text: "Maledike • discord.gg/maledike" })
      ]}).catch(() => {});
    }
  } catch {}
});

// ─────────────────────────────────────────────
//  INTERACTION HANDLER
// ─────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, member, guild } = interaction;

  const reply = (color, desc, fields = [], ephemeral = false) => {
    const e = new EmbedBuilder().setColor(color).setDescription(desc);
    if (fields.length) e.addFields(fields);
    return interaction.reply({ embeds: [e], ephemeral });
  };

  // ════════════════════════════════════════════
  //  /help — Owner uniquement
  // ════════════════════════════════════════════
  if (commandName === "help") {
    if (!isOwner(member.id))
      return reply(0xcc0000, "❌ `/help` est réservé aux **Owners Bot**.", [], true);

    return interaction.reply({ embeds: [
      new EmbedBuilder()
        .setColor(0x1a1a1a)
        .setTitle("╸ Commandes Maledike")
        .setDescription("discord.gg/maledike")
        .addFields(
          {
            name: "🎖️ Rangs",
            value: [
              "`/rank` `membre` `role` — Attribue un rôle",
              "`/derank` `membre` `raison` — Retire tous les rôles",
            ].join("\n"),
          },
          {
            name: "🔨 Ban",
            value: [
              "`/ban` `membre` `[raison]` — Bannir un membre",
              "`/unban` `id` — Débannir",
              "`/baninfo` `id` — Infos sur un ban",
            ].join("\n"),
          },
          {
            name: "🚫 Blacklist",
            value: [
              "`/bl` `[membre/@]` `[id]` `[raison]` — Blacklister",
              "`/unbl` `id` — Retirer *(Owner uniquement)*",
              "`/blist` — Liste des blacklistés",
              "`/blinfo` `[membre/@|id]` — Infos",
            ].join("\n"),
          },
          {
            name: "💤 Wakeup",
            value: "`/wakeup` `membre` — Déplace dans tous les vocaux 20s",
          },
          {
            name: "👑 Owner Bot",
            value: [
              "`/ownerbot` `membre` — Ajouter Owner",
              "`/unownerbot` `membre` — Retirer Owner",
              "`/ownerbotlist` — Liste des Owners",
            ].join("\n"),
          },
          {
            name: "⚙️ Configuration *(Owner)*",
            value: [
              "`/setperms` `action` `type` `[role|user]` — Gérer les permissions",
              "`/rankconfig` — Configurer les règles de rang",
            ].join("\n"),
          },
        )
        .setFooter({ text: "Maledike • discord.gg/maledike" })
    ], ephemeral: true });
  }

  // ════════════════════════════════════════════
  //  /setperms — Owner uniquement
  // ════════════════════════════════════════════
  if (commandName === "setperms") {
    if (!isOwner(member.id))
      return reply(0xcc0000, "❌ Réservé aux **Owners Bot**.", [], true);

    const action = interaction.options.getString("action");
    const type   = interaction.options.getString("type");
    const role   = interaction.options.getRole("role");
    const user   = interaction.options.getUser("utilisateur");
    const perm   = CONFIG.PERMS[action];

    if (!perm) return reply(0xcc0000, "Permission inconnue.", [], true);

    if (type === "show") {
      const roles = perm.roles.length ? perm.roles.map(id => `<@&${id}>`).join(", ")  : "Aucun";
      const users = perm.users.length ? perm.users.map(id => `<@${id}>`).join(", ")   : "Aucun";
      const labels = {
        bl: "/bl", unbl: "/unbl", ban: "/ban", bl_no_reason: "/bl sans raison",
        ban_no_reason: "/ban sans raison", rank: "/rank & /derank",
        wakeup: "/wakeup", system: "Statut System",
      };
      return interaction.reply({ embeds: [
        new EmbedBuilder().setColor(0x1a1a1a)
          .setTitle(`⚙️ Permissions — ${labels[action]}`)
          .addFields(
            { name: "Rôles autorisés", value: roles },
            { name: "Utilisateurs",    value: users },
          )
      ], ephemeral: true });
    }

    if (!role && !user)
      return reply(0xcc0000, "Précise un `role` ou un `utilisateur`.", [], true);

    if (type === "add") {
      if (role && !perm.roles.includes(role.id)) perm.roles.push(role.id);
      if (user && !perm.users.includes(user.id))  perm.users.push(user.id);
      const added = [role && `<@&${role.id}>`, user && `<@${user.id}>`].filter(Boolean).join(", ");
      return reply(0x1a1a1a, `✓ ${added} peut maintenant utiliser \`${action}\`.`);
    }

    if (type === "remove") {
      if (role) perm.roles = perm.roles.filter(id => id !== role.id);
      if (user) perm.users = perm.users.filter(id => id !== user.id);
      const removed = [role && `<@&${role.id}>`, user && `<@${user.id}>`].filter(Boolean).join(", ");
      return reply(0x1a1a1a, `✓ ${removed} retiré de la permission \`${action}\`.`);
    }

    return reply(0xcc0000, "Type inconnu.", [], true);
  }

  // ════════════════════════════════════════════
  //  /rank
  // ════════════════════════════════════════════
  if (commandName === "rank") {
    if (!isOwner(member.id) && !isAdmin(member) && !hasPerm(member, "rank"))
      return reply(0xcc0000, "❌ Permission refusée pour `/rank`.", [], true);

    const targetUser   = interaction.options.getUser("membre");
    const role         = interaction.options.getRole("role");
    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);

    if (isOwner(targetUser.id))
      return reply(0xcc0000, "Vous ne pouvez pas rank un Owner Bot.", [], true);
    if (!targetMember)
      return reply(0xcc0000, "Ce membre n'est pas sur le serveur.", [], true);
    if (!canRank(member, role.id))
      return reply(0xcc0000, `Vous n'avez pas l'autorisation d'attribuer **${role.name}**.`, [], true);
    if (exceedsCeiling(member, role.id))
      return reply(0x2b2d31, `✗ Plafond dépassé pour **${role.name}**.`, [], true);

    try {
      await targetMember.roles.add(role, `Rank par ${member.user.tag}`);
      const rule      = getRankRule(role.id);
      const autoAdded = [];
      if (rule?.assignRoles.length > 0) {
        for (const id of rule.assignRoles) {
          const r = guild.roles.cache.get(id);
          if (r) { try { await targetMember.roles.add(r, "Rôle lié"); autoAdded.push(r); } catch {} }
        }
      }
      const rolesAfter = targetMember.roles.cache
        .filter(r => r.id !== guild.id)
        .sort((a, b) => b.position - a.position)
        .map(r => `<@&${r.id}>`)
        .join(", ") || "Aucun";

      return interaction.reply({ embeds: [
        new EmbedBuilder().setColor(0x1a1a1a)
          .setDescription(
            `✓ <@${targetUser.id}> a été rank **${role.name}**.` +
            (autoAdded.length ? `\nRôles ajoutés : ${autoAdded.map(r => `<@&${r.id}>`).join(", ")}` : "")
          )
          .addFields(
            { name: "Rôles actuels", value: rolesAfter },
            { name: "Par",           value: `<@${member.id}>`, inline: true },
            { name: "Rôle attribué", value: `<@&${role.id}>`,  inline: true },
          )
      ]});
    } catch (err) {
      return reply(0xcc0000, `Erreur : \`${err.message}\``, [], true);
    }
  }

  // ════════════════════════════════════════════
  //  /derank
  // ════════════════════════════════════════════
  if (commandName === "derank") {
    if (!isOwner(member.id) && !isAdmin(member) && !hasPerm(member, "rank"))
      return reply(0xcc0000, "❌ Permission refusée pour `/derank`.", [], true);

    const targetUser   = interaction.options.getUser("membre");
    const raison       = interaction.options.getString("raison");
    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);

    if (isOwner(targetUser.id))
      return reply(0xcc0000, "Vous ne pouvez pas derank un Owner Bot.", [], true);
    if (!targetMember)
      return reply(0xcc0000, "Ce membre n'est pas sur le serveur.", [], true);

    const rolesBefore = targetMember.roles.cache
      .filter(r => r.id !== guild.id)
      .sort((a, b) => b.position - a.position)
      .map(r => `<@&${r.id}>`)
      .join(", ") || "Aucun";

    await totalDerank(targetMember);
    await sendDM(targetUser, new EmbedBuilder()
      .setColor(0xcc0000)
      .setDescription(`Vous avez été derank sur **${CONFIG.SERVER_NAME}**.\nRaison : ${raison}`)
    );

    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0xcc0000)
        .setDescription(`✓ <@${targetUser.id}> a été derank totalement.`)
        .addFields(
          { name: "Rôles retirés", value: rolesBefore },
          { name: "Par",    value: `<@${member.id}>`, inline: true },
          { name: "Raison", value: raison,             inline: true },
        )
    ]});
  }

  // ════════════════════════════════════════════
  //  /rankconfig — Owner uniquement
  // ════════════════════════════════════════════
  if (commandName === "rankconfig") {
    if (!isOwner(member.id))
      return reply(0xcc0000, "❌ `/rankconfig` est réservé aux **Owners Bot**.", [], true);

    const action       = interaction.options.getString("action");
    const role         = interaction.options.getRole("role");
    const role2        = interaction.options.getRole("role2");
    const role3        = interaction.options.getRole("role3");
    const role4        = interaction.options.getRole("role4");
    const roleAutorise = interaction.options.getRole("roleautorise");

    if (action === "show") {
      if (CONFIG.RANK_CONFIG.length === 0)
        return reply(0x1a1a1a, "Aucune règle configurée.");
      const lines = CONFIG.RANK_CONFIG.map((r, i) => {
        const name    = guild.roles.cache.get(r.rankRole)?.name || r.rankRole;
        const ceiling = r.maxRole ? `<@&${r.maxRole}>` : "Aucun";
        const linked  = r.assignRoles.length ? r.assignRoles.map(id => `<@&${id}>`).join(", ") : "Aucun";
        const allowed = r.allowedRoles.length ? r.allowedRoles.map(id => `<@&${id}>`).join(", ") : "Tous";
        return `**${i + 1}. ${name}**\n→ Plafond : ${ceiling} | Liés : ${linked} | Autorisés : ${allowed}`;
      });
      return interaction.reply({ embeds: [
        new EmbedBuilder().setColor(0x1a1a1a).setTitle("📋 Règles de rang").setDescription(lines.join("\n\n"))
      ], ephemeral: true });
    }

    if (action === "add") {
      if (!role) return reply(0xcc0000, "Sélectionne un rôle avec `role`.", [], true);
      if (CONFIG.RANK_CONFIG.find(r => r.rankRole === role.id))
        return reply(0xcc0000, `Une règle existe déjà pour **${role.name}**.`, [], true);
      CONFIG.RANK_CONFIG.push({ rankRole: role.id, assignRoles: [], maxRole: null, allowedRoles: [] });
      return reply(0x1a1a1a, `✓ Règle créée pour **${role.name}**.`);
    }

    if (action === "remove") {
      if (!role) return reply(0xcc0000, "Sélectionne le rôle avec `role`.", [], true);
      const idx = CONFIG.RANK_CONFIG.findIndex(r => r.rankRole === role.id);
      if (idx === -1) return reply(0xcc0000, `Aucune règle pour **${role.name}**.`, [], true);
      CONFIG.RANK_CONFIG.splice(idx, 1);
      return reply(0x1a1a1a, `✓ Règle supprimée pour **${role.name}**.`);
    }

    if (action === "setceiling") {
      if (!role || !role2) return reply(0xcc0000, "`role` = le rang — `role2` = le plafond max.", [], true);
      let rule = CONFIG.RANK_CONFIG.find(r => r.rankRole === role.id);
      if (!rule) { rule = { rankRole: role.id, assignRoles: [], maxRole: null, allowedRoles: [] }; CONFIG.RANK_CONFIG.push(rule); }
      rule.maxRole = role2.id;
      return reply(0x1a1a1a, `✓ Plafond : **${role.name}** ne peut pas dépasser **${role2.name}**.`);
    }

    if (action === "linkroles") {
      if (!role) return reply(0xcc0000, "Sélectionne le rôle principal avec `role`.", [], true);
      let rule = CONFIG.RANK_CONFIG.find(r => r.rankRole === role.id);
      if (!rule) { rule = { rankRole: role.id, assignRoles: [], maxRole: null, allowedRoles: [] }; CONFIG.RANK_CONFIG.push(rule); }
      const toLink = [role2, role3, role4].filter(Boolean);
      if (!toLink.length) return reply(0xcc0000, "Ajoute au moins un rôle lié avec `role2`.", [], true);
      for (const r of toLink) if (!rule.assignRoles.includes(r.id)) rule.assignRoles.push(r.id);
      return reply(0x1a1a1a, `✓ Rôles liés à **${role.name}** : ${toLink.map(r => `<@&${r.id}>`).join(", ")}`);
    }

    if (action === "setallowed") {
      if (!role || !roleAutorise) return reply(0xcc0000, "`role` = le rang — `roleautorise` = qui peut le donner.", [], true);
      let rule = CONFIG.RANK_CONFIG.find(r => r.rankRole === role.id);
      if (!rule) { rule = { rankRole: role.id, assignRoles: [], maxRole: null, allowedRoles: [] }; CONFIG.RANK_CONFIG.push(rule); }
      if (!rule.allowedRoles.includes(roleAutorise.id)) rule.allowedRoles.push(roleAutorise.id);
      return reply(0x1a1a1a, `✓ **${roleAutorise.name}** peut maintenant rank **${role.name}**.`);
    }

    return reply(0xcc0000, "Action inconnue.", [], true);
  }

  // ════════════════════════════════════════════
  //  OWNER BOT — Owner uniquement
  // ════════════════════════════════════════════
  if (commandName === "ownerbot") {
    if (!isOwner(member.id)) return reply(0xcc0000, "❌ Réservé aux **Owners Bot**.", [], true);
    const target = interaction.options.getUser("membre");
    if (isOwner(target.id)) return reply(0xcc0000, "Cet utilisateur est déjà Owner Bot.", [], true);
    CONFIG.OWNER_IDS.push(target.id);
    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0xcc0000)
        .setDescription(`👑 **${target.tag}** est maintenant **Owner Bot**.`)
        .addFields({ name: "Ajouté par", value: `<@${member.id}>`, inline: true })
    ]});
  }

  if (commandName === "unownerbot") {
    if (!isOwner(member.id)) return reply(0xcc0000, "❌ Réservé aux **Owners Bot**.", [], true);
    const target = interaction.options.getUser("membre");
    if (CONFIG.HARDCODED.includes(target.id)) return reply(0xcc0000, "Impossible de retirer un Owner originel.", [], true);
    const idx = CONFIG.OWNER_IDS.indexOf(target.id);
    if (idx === -1) return reply(0xcc0000, "Cet utilisateur n'est pas Owner Bot.", [], true);
    CONFIG.OWNER_IDS.splice(idx, 1);
    return reply(0x1a1a1a, `✓ **${target.tag}** n'est plus Owner Bot.`);
  }

  if (commandName === "ownerbotlist") {
    if (!isOwner(member.id)) return reply(0xcc0000, "❌ Réservé aux **Owners Bot**.", [], true);
    const lines = [];
    for (const id of CONFIG.OWNER_IDS) {
      const u = await client.users.fetch(id).catch(() => null);
      lines.push(`${u ? `**${u.tag}**` : `\`${id}\``} ${CONFIG.HARDCODED.includes(id) ? "*(originel)*" : ""}`);
    }
    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0xcc0000).setTitle("👑 Owners Bot").setDescription(lines.join("\n") || "Aucun.")
    ], ephemeral: true });
  }

  // ════════════════════════════════════════════
  //  /ban
  // ════════════════════════════════════════════
  if (commandName === "ban") {
    if (!isOwner(member.id) && !hasPerm(member, "ban"))
      return reply(0xcc0000, "❌ Permission refusée pour `/ban`.", [], true);

    const target      = interaction.options.getUser("membre");
    const raisonInput = interaction.options.getString("raison");
    const noReason    = hasPerm(member, "ban_no_reason");
    const raison      = raisonInput || (noReason ? "—" : null);

    if (!raison)
      return reply(0xcc0000, "❌ Vous devez fournir une raison pour bannir.", [], true);
    if (isOwner(target.id))
      return reply(0xcc0000, "❌ Impossible de bannir un Owner Bot.", [], true);

    const modType = getModType(member);

    try {
      store.ourBans.add(target.id); // évite double DM GuildBanAdd
      await guild.bans.create(target.id, { reason: raison, deleteMessageSeconds: 604800 });
      store.bans.set(target.id, { reason: raison, modId: member.id, modType, date: new Date().toISOString() });

      await sendDM(target, new EmbedBuilder()
        .setColor(0xcc0000)
        .setDescription(banDMText(raison, modType, !raisonInput && noReason))
        .setFooter({ text: "Maledike • discord.gg/maledike" })
      );

      return interaction.reply({ embeds: [
        new EmbedBuilder().setColor(0xcc0000)
          .setDescription(`✓ **${target.tag}** a été banni.`)
          .addFields(
            { name: "Par",    value: `<@${member.id}>`, inline: true },
            { name: "Raison", value: raison,             inline: true },
          )
      ]});
    } catch (err) {
      store.ourBans.delete(target.id);
      return reply(0xcc0000, `Erreur : \`${err.message}\``, [], true);
    }
  }

  // ════════════════════════════════════════════
  //  /unban
  // ════════════════════════════════════════════
  if (commandName === "unban") {
    if (!isOwner(member.id) && !hasPerm(member, "ban"))
      return reply(0xcc0000, "❌ Permission refusée pour `/unban`.", [], true);
    const id = interaction.options.getString("id");
    try {
      await guild.bans.remove(id);
      store.bans.delete(id);
      return reply(0x1a1a1a, `✓ \`${id}\` a été débanni.`);
    } catch (err) {
      return reply(0xcc0000, `Erreur : \`${err.message}\``, [], true);
    }
  }

  // ════════════════════════════════════════════
  //  /baninfo
  // ════════════════════════════════════════════
  if (commandName === "baninfo") {
    if (!isOwner(member.id) && !hasPerm(member, "ban"))
      return reply(0xcc0000, "❌ Permission refusée.", [], true);

    const id      = interaction.options.getString("id");
    const banData = store.bans.get(id);
    let guildBan  = null;
    try { guildBan = await guild.bans.fetch(id); } catch {}
    if (!banData && !guildBan)
      return reply(0x1a1a1a, "Cet utilisateur n'est pas banni.");

    const u          = await client.users.fetch(id).catch(() => null);
    const modDisplay = banModLabel(banData?.modType);

    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0xcc0000).setTitle("🔨 Informations du ban")
        .addFields(
          { name: "Cible",      value: u ? `**${u.tag}** (\`${id}\`)` : `\`${id}\``, inline: false },
          { name: "Modérateur", value: modDisplay,                                     inline: true  },
          { name: "Raison",     value: banData?.reason || guildBan?.reason || "Inconnue"              },
          { name: "Date",       value: banData?.date ? `<t:${Math.floor(new Date(banData.date).getTime()/1000)}:F>` : "Inconnue" },
        )
    ], ephemeral: true });
  }

  // ════════════════════════════════════════════
  //  /bl — @mention OU ID, raison optionnelle selon perm
  // ════════════════════════════════════════════
  if (commandName === "bl") {
    if (!isOwner(member.id) && !hasPerm(member, "bl"))
      return reply(0xcc0000, "❌ Permission refusée pour `/bl`.", [], true);

    const targetUser  = interaction.options.getUser("membre");
    const rawId       = interaction.options.getString("id");
    const targetId    = targetUser?.id || rawId;
    const raisonInput = interaction.options.getString("raison");
    const noReason    = hasPerm(member, "bl_no_reason");
    const raison      = raisonInput || (noReason ? "—" : null);

    if (!targetId)
      return reply(0xcc0000, "❌ Mentionne un membre avec `membre` ou fournis un `id`.", [], true);
    if (!raison)
      return reply(0xcc0000, "❌ Vous devez fournir une raison.", [], true);

    const target = targetUser || await client.users.fetch(targetId).catch(() => null);
    if (!target)
      return reply(0xcc0000, "❌ Utilisateur introuvable.", [], true);
    if (isOwner(target.id))
      return reply(0xcc0000, "❌ Impossible de blacklister un Owner Bot.", [], true);

    const modType = getModType(member);
    store.blacklist.set(target.id, { reason: raison, modId: member.id, modType, date: new Date().toISOString() });

    const targetMember = await guild.members.fetch(target.id).catch(() => null);
    if (targetMember) {
      await sendDM(target, new EmbedBuilder()
        .setColor(0xcc0000)
        .setDescription(blDMText(raison, modType, !raisonInput && noReason))
        .setFooter({ text: "Maledike • discord.gg/maledike" })
      );
      store.ourKicks.add(target.id); // évite double DM GuildMemberRemove
      try { await targetMember.kick(`[Blacklist] ${raison}`); } catch {}
    }

    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0xcc0000)
        .setDescription(`✓ **${target.tag}** (\`${target.id}\`) a été blacklisté.`)
        .addFields(
          { name: "Par",    value: `<@${member.id}>`, inline: true },
          { name: "Raison", value: raison,             inline: true },
        )
    ]});
  }

  // ════════════════════════════════════════════
  //  /unbl
  //  Règles :
  //  1. bl par owner (system+) → seul un owner peut /unbl
  //  2. bl par system          → seul un owner OU ce system précis peut /unbl
  //  3. bl par modérateur      → ceux qui ont la perm "unbl" peuvent /unbl
  // ════════════════════════════════════════════
  if (commandName === "unbl") {
    const id     = interaction.options.getString("id");
    const blData = store.blacklist.get(id);

    if (!blData)
      return reply(0x1a1a1a, "Cet utilisateur n'est pas dans la blacklist.");

    const { modType, modId } = blData;

    // Cas 1 : bl par owner (system+) → owner uniquement
    if (modType === "system+") {
      if (!isOwner(member.id))
        return reply(0xcc0000, "❌ Cette blacklist a été posée par un **Owner Bot**. Seul un Owner Bot peut la retirer.", [], true);
    }
    // Cas 2 : bl par system → owner OU le system exact qui l'a bl
    else if (modType === "system") {
      const isThatSystem = (member.id === modId);
      if (!isOwner(member.id) && !isThatSystem)
        return reply(0xcc0000, "❌ Cette blacklist a été posée par un **System**. Seul un Owner Bot ou ce System peut la retirer.", [], true);
    }
    // Cas 3 : bl par modérateur normal → vérif perm unbl
    else {
      if (!isOwner(member.id) && !hasPerm(member, "unbl"))
        return reply(0xcc0000, "❌ Vous n'avez pas la permission d'utiliser `/unbl`.", [], true);
    }

    store.blacklist.delete(id);
    const u = await client.users.fetch(id).catch(() => null);
    return reply(0x1a1a1a, `✓ **${u ? u.tag : id}** a été retiré de la blacklist.`);
  }

  // ════════════════════════════════════════════
  //  /blist
  // ════════════════════════════════════════════
  if (commandName === "blist") {
    if (!isOwner(member.id) && !hasPerm(member, "bl"))
      return reply(0xcc0000, "❌ Permission refusée.", [], true);

    if (!store.blacklist.size)
      return reply(0x1a1a1a, "Aucun utilisateur blacklisté.");

    const lines = [];
    for (const [id, data] of store.blacklist.entries()) {
      const u = await client.users.fetch(id).catch(() => null);
      lines.push(`${u ? `**${u.tag}**` : `\`${id}\``} — ${data.reason}`);
    }
    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0xcc0000)
        .setTitle(`🚫 Blacklist (${store.blacklist.size})`)
        .setDescription(lines.join("\n"))
    ], ephemeral: true });
  }

  // ════════════════════════════════════════════
  //  /blinfo — modType affiché correctement
  // ════════════════════════════════════════════
  if (commandName === "blinfo") {
    if (!isOwner(member.id) && !hasPerm(member, "bl"))
      return reply(0xcc0000, "❌ Permission refusée.", [], true);

    const targetUser = interaction.options.getUser("membre");
    const targetId   = interaction.options.getString("id") || targetUser?.id;

    if (!targetId)
      return reply(0xcc0000, "❌ Mentionne un membre ou fournis un ID.", [], true);

    const blData = store.blacklist.get(targetId);
    if (!blData)
      return reply(0x1a1a1a, "Cet utilisateur n'est pas dans la blacklist.");

    const u          = await client.users.fetch(targetId).catch(() => null);
    const modDisplay = modLabel(blData.modType);

    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0xcc0000).setTitle("🚫 Informations blacklist")
        .addFields(
          { name: "Cible",         value: u ? `**${u.tag}** (\`${targetId}\`)` : `\`${targetId}\``, inline: false },
          { name: "Modérateur",    value: modDisplay,                                                 inline: true  },
          { name: "Raison",        value: blData.reason                                                              },
          { name: "Date",          value: `<t:${Math.floor(new Date(blData.date).getTime()/1000)}:F>`               },
        )
    ], ephemeral: true });
  }

  // ════════════════════════════════════════════
  //  /wakeup — déplace dans tous les vocaux 20s
  // ════════════════════════════════════════════
  if (commandName === "wakeup") {
    if (!isOwner(member.id) && !hasPerm(member, "wakeup"))
      return reply(0xcc0000, "❌ Permission refusée pour `/wakeup`.", [], true);

    const targetUser   = interaction.options.getUser("membre");
    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);

    if (!targetMember)
      return reply(0xcc0000, "❌ Ce membre n'est pas sur le serveur.", [], true);
    if (!targetMember.voice.channel)
      return reply(0xcc0000, "❌ Ce membre n'est pas dans un salon vocal.", [], true);

    const voiceChannels = guild.channels.cache
      .filter(c => c.isVoiceBased())
      .toArray();

    if (voiceChannels.length < 2)
      return reply(0xcc0000, "❌ Pas assez de salons vocaux sur le serveur.", [], true);

    const originalChannel = targetMember.voice.channel;

    await interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0xcc0000)
        .setDescription(`💤 **${targetUser.tag}** est en train de se faire wakeup pendant 20 secondes...`)
    ]});

    let i = 0;
    const otherChannels = voiceChannels.filter(c => c.id !== originalChannel.id);
    const endTime = Date.now() + 20_000;

    const wakeInterval = setInterval(async () => {
      if (Date.now() >= endTime) {
        clearInterval(wakeInterval);
        try { await targetMember.voice.setChannel(originalChannel, "Fin du wakeup"); } catch {}
        return;
      }
      const channel = otherChannels[i % otherChannels.length];
      try { await targetMember.voice.setChannel(channel, "Wakeup"); } catch {}
      i++;
    }, 1500);
  }
});

// ─────────────────────────────────────────────
//  KEEP-ALIVE
// ─────────────────────────────────────────────
function startKeepAlive() {
  const app  = express();
  const PORT = process.env.PORT || 10000;
  app.get("/",     (_, res) => res.send("Bot en ligne."));
  app.get("/ping", (_, res) => res.json({ status: "ok", uptime: process.uptime() }));
  app.listen(PORT, () => console.log(`Keep-alive actif sur le port ${PORT}`));
  setInterval(async () => { try { await fetch(`${CONFIG.RENDER_URL}/ping`); } catch {} }, 60_000);
}

// ─────────────────────────────────────────────
//  CONNEXION
// ─────────────────────────────────────────────
client.login(BOT_TOKEN).catch(err => {
  console.error("Erreur de connexion:", err.message);
  process.exit(1);
});
