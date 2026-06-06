// ============================================================
//  MALEDIKE BOT — index.js  (version complète v2)
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
  ChannelType,
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
//  CONFIGURATION PRINCIPALE
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

  PERMS: {
    bl:                 { roles: [], users: [] },
    ban:                { roles: [], users: [] },
    derank:             { roles: [], users: [] },
    derank_no_reason:   { roles: [], users: [] },
    wakeup:             { roles: [], users: [] },
    dog:                { roles: [], users: [] },
    dog_bypass:         { roles: [], users: [] },
    blr:                { roles: [], users: [] },
    couniamanmanw:      { roles: [], users: [] },
    menotte:            { roles: [], users: [] },
    system:             { roles: [], users: [] },
  },

  RATE_LIMITS: {
    bl:            { max: 5,  windowMs: 30 * 60 * 1000 },
    ban:           { max: 5,  windowMs: 15 * 60 * 1000 },
    couniamanmanw: { max: 1,  windowMs: 60 * 60 * 1000 },
    menotte:       { max: 3,  windowMs: 60 * 60 * 1000 },
    dog:           { limit: 3 },
  },

  WAKEUP_ACTIVE: false,
};

// ─────────────────────────────────────────────
//  STOCKAGE EN MÉMOIRE
// ─────────────────────────────────────────────
const store = {
  blacklist:      new Map(),
  blr:            new Map(),
  bans:           new Map(),
  dogs:           new Map(),
  menottes:       new Map(),
  couniamanmanw:  new Map(),
  aykokemanmanw:  new Map(),
  locknames:      new Map(),
  ourBans:        new Set(),
  ourKicks:       new Set(),
  rateCounts:     new Map(),
};

// ─────────────────────────────────────────────
//  HELPERS — HIÉRARCHIE
// ─────────────────────────────────────────────

function isSystemPlus(id) {
  return CONFIG.OWNER_IDS.includes(id);
}

function isSystem(member) {
  const p = CONFIG.PERMS.system;
  if (!p) return false;
  if (p.users.includes(member.id)) return true;
  if (member.roles.cache.some(r => p.roles.includes(r.id))) return true;
  return false;
}

function getModType(member) {
  if (isSystemPlus(member.id)) return "system+";
  if (isSystem(member))        return "system";
  return "moderator";
}

function hasPerm(member, key) {
  if (isSystemPlus(member.id)) return true;
  const p = CONFIG.PERMS[key];
  if (!p) return false;
  if (p.users.includes(member.id)) return true;
  if (member.roles.cache.some(r => p.roles.includes(r.id))) return true;
  return false;
}

function canActOn(actorMember, targetModType) {
  const actorType = getModType(actorMember);
  if (actorType === "system+") return true;
  if (actorType === "system" && targetModType === "system+") return false;
  if (actorType === "system" && targetModType === "system")  return false;
  if (actorType === "moderator") {
    if (targetModType === "system+" || targetModType === "system") return false;
  }
  return true;
}

// ─────────────────────────────────────────────
//  HELPERS — RATE LIMIT
// ─────────────────────────────────────────────
function checkRateLimit(userId, action) {
  const cfg = CONFIG.RATE_LIMITS[action];
  if (!cfg || !cfg.max) return { allowed: true };

  const key  = `${userId}:${action}`;
  const now  = Date.now();
  let entry  = store.rateCounts.get(key);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + cfg.windowMs };
    store.rateCounts.set(key, entry);
  }

  if (entry.count >= cfg.max) {
    const remaining = Math.ceil((entry.resetAt - now) / 60000);
    return { allowed: false, remaining };
  }

  entry.count++;
  return { allowed: true };
}

// ─────────────────────────────────────────────
//  HELPERS — EMBEDS
// ─────────────────────────────────────────────
const BLACK = 0x000000;
const RED   = 0xcc0000;
const DARK  = 0x1a1a1a;

function makeEmbed(color, description, fields = []) {
  const e = new EmbedBuilder().setColor(color).setDescription(description);
  if (fields.length) e.addFields(fields);
  return e;
}

function blDMEmbed(reason, modType, noReason) {
  const desc = (noReason || modType === "system+" || modType === "system")
    ? `Vous avez été **blacklisté** de **${CONFIG.SERVER_NAME}**.`
    : `Vous avez été **blacklisté** de **${CONFIG.SERVER_NAME}**.\nRaison : ${reason}`;
  return makeEmbed(BLACK, desc).setFooter({ text: `${CONFIG.SERVER_NAME} • discord.gg/maledike` });
}

function banDMEmbed(reason, modType, noReason) {
  const desc = (noReason || modType === "system+" || modType === "system")
    ? `Vous avez été **banni** de **${CONFIG.SERVER_NAME}**.`
    : `Vous avez été **banni** de **${CONFIG.SERVER_NAME}**.\nRaison : ${reason}`;
  return makeEmbed(BLACK, desc).setFooter({ text: `${CONFIG.SERVER_NAME} • discord.gg/maledike` });
}

function modDisplayName(modType, modId) {
  if (modType === "system+") return "system+";
  if (modType === "system")  return "system";
  return `<@${modId}>`;
}

function fmtDate(isoDate) {
  return isoDate ? `<t:${Math.floor(new Date(isoDate).getTime() / 1000)}:F>` : "Inconnue";
}

// ─────────────────────────────────────────────
//  HELPER — DM SÉCURISÉ
// ─────────────────────────────────────────────
async function sendDM(user, contentOrEmbed) {
  try {
    if (typeof contentOrEmbed === "string") {
      await user.send({ content: contentOrEmbed });
    } else {
      await user.send({ embeds: [contentOrEmbed] });
    }
  } catch { /* DM fermés */ }
}

// ─────────────────────────────────────────────
//  HELPERS — RANK
// ─────────────────────────────────────────────
function getRankRule(roleId) {
  return CONFIG.RANK_CONFIG.find(r => r.rankRole === roleId) || null;
}

function canRank(member, roleId) {
  if (isSystemPlus(member.id) || hasPerm(member, "rank")) return true;
  const rule = getRankRule(roleId);
  if (!rule || rule.allowedRoles.length === 0) return true;
  return member.roles.cache.some(r => rule.allowedRoles.includes(r.id));
}

function exceedsCeiling(member, roleToGiveId) {
  if (isSystemPlus(member.id)) return false;
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
    if (roles.size > 0) await member.roles.remove(roles, "Derank total");
  } catch (err) {
    console.error("Erreur totalDerank:", err.message);
  }
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
//  SLASH COMMANDS — DÉFINITION
// ─────────────────────────────────────────────
const slashCommands = [

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Affiche toutes les commandes (System+ uniquement)"),

  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("Attribue un rôle à un membre")
    .addUserOption(o => o.setName("membre").setDescription("Membre à rank").setRequired(true))
    .addRoleOption(o => o.setName("role").setDescription("Rôle à attribuer").setRequired(true)),

  new SlashCommandBuilder()
    .setName("derank")
    .setDescription("Retire tous les rôles d'un membre")
    .addUserOption(o => o.setName("membre").setDescription("Membre à derank").setRequired(true))
    .addStringOption(o => o.setName("raison").setDescription("Raison (optionnelle si autorisé)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("rankconfig")
    .setDescription("Configure les règles de rang (System+ uniquement)")
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

  new SlashCommandBuilder()
    .setName("ownerbot")
    .setDescription("Ajouter un Owner Bot / System+ (System+ uniquement)")
    .addUserOption(o => o.setName("membre").setDescription("Membre à promouvoir").setRequired(true)),

  new SlashCommandBuilder()
    .setName("unownerbot")
    .setDescription("Retirer un Owner Bot / System+ (System+ uniquement)")
    .addUserOption(o => o.setName("membre").setDescription("Membre à rétrograder").setRequired(true)),

  new SlashCommandBuilder()
    .setName("ownerbotlist")
    .setDescription("Liste des Owners Bot / System+ (System+ uniquement)"),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Bannir un membre du serveur")
    .addUserOption(o => o.setName("membre").setDescription("Membre à bannir").setRequired(true))
    .addStringOption(o => o.setName("raison").setDescription("Raison").setRequired(false)),

  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Débannir un utilisateur")
    .addStringOption(o => o.setName("id").setDescription("ID de l'utilisateur").setRequired(true)),

  new SlashCommandBuilder()
    .setName("baninfo")
    .setDescription("Informations sur un ban")
    .addUserOption(o => o.setName("membre").setDescription("Mentionner le membre").setRequired(false))
    .addStringOption(o => o.setName("id").setDescription("ID de l'utilisateur").setRequired(false)),

  new SlashCommandBuilder()
    .setName("bl")
    .setDescription("Blacklister un utilisateur")
    .addUserOption(o => o.setName("membre").setDescription("Mentionner le membre").setRequired(false))
    .addStringOption(o => o.setName("id").setDescription("ID (si pas sur le serveur)").setRequired(false))
    .addStringOption(o => o.setName("raison").setDescription("Raison").setRequired(false)),

  new SlashCommandBuilder()
    .setName("unbl")
    .setDescription("Retirer de la blacklist")
    .addStringOption(o => o.setName("id").setDescription("ID de l'utilisateur").setRequired(true)),

  new SlashCommandBuilder()
    .setName("blist")
    .setDescription("Liste de tous les utilisateurs blacklistés"),

  new SlashCommandBuilder()
    .setName("blinfo")
    .setDescription("Informations sur une blacklist")
    .addUserOption(o => o.setName("membre").setDescription("Mentionner le membre").setRequired(false))
    .addStringOption(o => o.setName("id").setDescription("ID de l'utilisateur").setRequired(false)),

  new SlashCommandBuilder()
    .setName("blr")
    .setDescription("Blackliste les rôles d'un utilisateur (il ne peut plus en avoir)")
    .addUserOption(o => o.setName("membre").setDescription("Membre à BLR").setRequired(true))
    .addStringOption(o => o.setName("raison").setDescription("Raison").setRequired(true)),

  new SlashCommandBuilder()
    .setName("unblr")
    .setDescription("Retire le BLR d'un utilisateur")
    .addUserOption(o => o.setName("membre").setDescription("Membre").setRequired(true)),

  new SlashCommandBuilder()
    .setName("blrinfo")
    .setDescription("Informations sur un BLR")
    .addUserOption(o => o.setName("membre").setDescription("Membre").setRequired(false))
    .addStringOption(o => o.setName("id").setDescription("ID").setRequired(false)),

  new SlashCommandBuilder()
    .setName("wakeup")
    .setDescription("Déplace un membre dans tous les vocaux pendant 20 secondes")
    .addUserOption(o => o.setName("membre").setDescription("Membre à wakeup").setRequired(true)),

  new SlashCommandBuilder()
    .setName("dog")
    .setDescription("Met un utilisateur en laisse (pseudo verrouillé, suit le maître en vocal)")
    .addUserOption(o => o.setName("membre").setDescription("Victime").setRequired(true)),

  new SlashCommandBuilder()
    .setName("undog")
    .setDescription("Enlève la laisse d'un chien (seulement le maître ou autorisés)")
    .addUserOption(o => o.setName("membre").setDescription("Chien à libérer").setRequired(true)),

  new SlashCommandBuilder()
    .setName("undogalls")
    .setDescription("Enlève la laisse à tous les chiens du serveur"),

  new SlashCommandBuilder()
    .setName("doglist")
    .setDescription("Liste de tous les chiens du serveur"),

  new SlashCommandBuilder()
    .setName("aykokemanmanw")
    .setDescription("Blacklist permanente (seul System+ peut révoquer)")
    .addUserOption(o => o.setName("membre").setDescription("Victime").setRequired(true)),

  new SlashCommandBuilder()
    .setName("viniw")
    .setDescription("Retire l'aykokemanmanw d'un utilisateur (System+ uniquement)")
    .addUserOption(o => o.setName("membre").setDescription("Utilisateur").setRequired(true))
    .addStringOption(o => o.setName("id").setDescription("ID").setRequired(false)),

  new SlashCommandBuilder()
    .setName("couniamanmanw")
    .setDescription("Timeout 28 jours impossible à lever")
    .addUserOption(o => o.setName("membre").setDescription("Victime").setRequired(true)),

  new SlashCommandBuilder()
    .setName("uncouniamanmanw")
    .setDescription("Retire le couniamanmanw d'un utilisateur")
    .addUserOption(o => o.setName("membre").setDescription("Utilisateur").setRequired(true)),

  new SlashCommandBuilder()
    .setName("settingbl")
    .setDescription("Configurer qui peut utiliser la catégorie BL + limites")
    .addStringOption(o =>
      o.setName("action").setDescription("Action").setRequired(true)
        .addChoices(
          { name: "Ajouter rôle/user",   value: "add"       },
          { name: "Retirer rôle/user",   value: "remove"    },
          { name: "Afficher config",     value: "show"      },
          { name: "Définir limite BL",   value: "setlimit"  },
        ))
    .addRoleOption(o => o.setName("role").setDescription("Rôle").setRequired(false))
    .addUserOption(o => o.setName("utilisateur").setDescription("Utilisateur").setRequired(false))
    .addIntegerOption(o => o.setName("limite").setDescription("Nb max de BL en 30 minutes").setRequired(false)),

  new SlashCommandBuilder()
    .setName("settingban")
    .setDescription("Configurer qui peut utiliser la catégorie BAN + limites")
    .addStringOption(o =>
      o.setName("action").setDescription("Action").setRequired(true)
        .addChoices(
          { name: "Ajouter rôle/user",   value: "add"       },
          { name: "Retirer rôle/user",   value: "remove"    },
          { name: "Afficher config",     value: "show"      },
          { name: "Définir limite BAN",  value: "setlimit"  },
        ))
    .addRoleOption(o => o.setName("role").setDescription("Rôle").setRequired(false))
    .addUserOption(o => o.setName("utilisateur").setDescription("Utilisateur").setRequired(false))
    .addIntegerOption(o => o.setName("limite").setDescription("Nb max de BAN en 15 minutes").setRequired(false)),

  new SlashCommandBuilder()
    .setName("settingderank")
    .setDescription("Configurer qui peut derank (avec/sans raison)")
    .addStringOption(o =>
      o.setName("action").setDescription("Action").setRequired(true)
        .addChoices(
          { name: "Ajouter rôle/user",               value: "add"           },
          { name: "Retirer rôle/user",               value: "remove"        },
          { name: "Afficher config",                 value: "show"          },
          { name: "Ajouter derank sans raison",      value: "add_no_reason" },
          { name: "Retirer derank sans raison",      value: "rem_no_reason" },
        ))
    .addRoleOption(o => o.setName("role").setDescription("Rôle").setRequired(false))
    .addUserOption(o => o.setName("utilisateur").setDescription("Utilisateur").setRequired(false)),

  new SlashCommandBuilder()
    .setName("settingwakeup")
    .setDescription("Configurer qui peut utiliser /wakeup")
    .addStringOption(o =>
      o.setName("action").setDescription("Action").setRequired(true)
        .addChoices(
          { name: "Ajouter rôle/user",  value: "add"    },
          { name: "Retirer rôle/user",  value: "remove" },
          { name: "Afficher config",    value: "show"   },
        ))
    .addRoleOption(o => o.setName("role").setDescription("Rôle").setRequired(false))
    .addUserOption(o => o.setName("utilisateur").setDescription("Utilisateur").setRequired(false)),

  new SlashCommandBuilder()
    .setName("settingdogs")
    .setDescription("Configurer la catégorie DOG (qui peut dog + limite de laisses)")
    .addStringOption(o =>
      o.setName("action").setDescription("Action").setRequired(true)
        .addChoices(
          { name: "Ajouter rôle/user",    value: "add"       },
          { name: "Retirer rôle/user",    value: "remove"    },
          { name: "Afficher config",      value: "show"      },
          { name: "Définir limite laisse",value: "setlimit"  },
        ))
    .addRoleOption(o => o.setName("role").setDescription("Rôle").setRequired(false))
    .addUserOption(o => o.setName("utilisateur").setDescription("Utilisateur").setRequired(false))
    .addIntegerOption(o => o.setName("limite").setDescription("Nb max de laisses par maître").setRequired(false)),

  new SlashCommandBuilder()
    .setName("settingsaykokemanmanw")
    .setDescription("Configuration aykokemanmanw (System+ uniquement)"),

  new SlashCommandBuilder()
    .setName("settingscouniamanmanw")
    .setDescription("Configurer qui peut utiliser /couniamanmanw + limite")
    .addStringOption(o =>
      o.setName("action").setDescription("Action").setRequired(true)
        .addChoices(
          { name: "Ajouter rôle/user",    value: "add"       },
          { name: "Retirer rôle/user",    value: "remove"    },
          { name: "Afficher config",      value: "show"      },
          { name: "Définir limite",       value: "setlimit"  },
        ))
    .addRoleOption(o => o.setName("role").setDescription("Rôle").setRequired(false))
    .addUserOption(o => o.setName("utilisateur").setDescription("Utilisateur").setRequired(false))
    .addIntegerOption(o => o.setName("limite").setDescription("Limite d'utilisation").setRequired(false)),

  new SlashCommandBuilder()
    .setName("settingmenotte")
    .setDescription("Configurer qui peut utiliser +menotte / +libre + limite")
    .addStringOption(o =>
      o.setName("action").setDescription("Action").setRequired(true)
        .addChoices(
          { name: "Ajouter rôle/user",    value: "add"       },
          { name: "Retirer rôle/user",    value: "remove"    },
          { name: "Afficher config",      value: "show"      },
          { name: "Définir limite",       value: "setlimit"  },
        ))
    .addRoleOption(o => o.setName("role").setDescription("Rôle").setRequired(false))
    .addUserOption(o => o.setName("utilisateur").setDescription("Utilisateur").setRequired(false))
    .addIntegerOption(o => o.setName("limite").setDescription("Limite").setRequired(false)),

  new SlashCommandBuilder()
    .setName("settingviniw")
    .setDescription("Configuration viniw (System+ uniquement)"),

  new SlashCommandBuilder()
    .setName("settingsystem")
    .setDescription("Configurer les rôles/users avec le statut System")
    .addStringOption(o =>
      o.setName("action").setDescription("Action").setRequired(true)
        .addChoices(
          { name: "Ajouter rôle/user",  value: "add"    },
          { name: "Retirer rôle/user",  value: "remove" },
          { name: "Afficher config",    value: "show"   },
        ))
    .addRoleOption(o => o.setName("role").setDescription("Rôle").setRequired(false))
    .addUserOption(o => o.setName("utilisateur").setDescription("Utilisateur").setRequired(false)),

].map(c => c.toJSON());

// ─────────────────────────────────────────────
//  REST
// ─────────────────────────────────────────────
const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

// ─────────────────────────────────────────────
//  READY — Déploiement des commandes (SANS DOUBLONS)
// ─────────────────────────────────────────────
client.once("ready", async () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);
  try {
    // 1) Purge des commandes globales (source des doublons)
    await rest.put(Routes.applicationCommands(CONFIG.CLIENT_ID), { body: [] });
    console.log("✅ Commandes globales purgées.");

    // 2) Enregistrement uniquement sur le serveur cible
    await rest.put(
      Routes.applicationGuildCommands(CONFIG.CLIENT_ID, CONFIG.GUILD_ID),
      { body: slashCommands }
    );
    console.log(`✅ ${slashCommands.length} commandes slash déployées sur le serveur.`);
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
//  GUILD MEMBER ADD — vérif blacklist + aykokemanmanw
// ─────────────────────────────────────────────
client.on(Events.GuildMemberAdd, async (member) => {
  const bl = store.blacklist.get(member.id);
  if (bl) {
    await sendDM(member.user, new EmbedBuilder()
      .setColor(BLACK)
      .setDescription(`Vous avez été **blacklisté** de **${CONFIG.SERVER_NAME}**, vous ne pouvez pas rejoindre.`)
      .setFooter({ text: `${CONFIG.SERVER_NAME} • discord.gg/maledike` })
    );
    try { await member.kick("[Blacklist] Accès refusé"); } catch {}
    return;
  }

  const ayko = store.aykokemanmanw.get(member.id);
  if (ayko) {
    await sendDM(member.user, new EmbedBuilder()
      .setColor(BLACK)
      .setDescription(`Tu as été **aykokemanmanw** sur **${CONFIG.SERVER_NAME}** force à toi.`)
      .setFooter({ text: `${CONFIG.SERVER_NAME} • discord.gg/maledike` })
    );
    try { await member.kick("[Aykokemanmanw] Accès permanent refusé"); } catch {}
    return;
  }

  const dog = store.dogs.get(member.id);
  if (dog) {
    const master = await member.guild.members.fetch(dog.masterId).catch(() => null);
    if (master) {
      const lockedName = `${member.user.displayName}(🦮 ${master.user.displayName})`;
      store.locknames.set(member.id, lockedName);
      try { await member.setNickname(lockedName, "Dog lock"); } catch {}
    }
  }
});

// ─────────────────────────────────────────────
//  MEMBER UPDATE — lock le pseudo si en laisse
// ─────────────────────────────────────────────
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const lockedName = store.locknames.get(newMember.id);
  if (!lockedName) return;

  if (newMember.nickname !== lockedName) {
    try { await newMember.setNickname(lockedName, "Dog lock — pseudo verrouillé"); } catch {}
  }

  if (store.blr.has(newMember.id)) {
    const addedRoles = newMember.roles.cache.filter(r =>
      r.id !== newMember.guild.id && !oldMember.roles.cache.has(r.id)
    );
    if (addedRoles.size > 0) {
      try { await newMember.roles.remove(addedRoles, "BLR actif — rôles interdits"); } catch {}
    }
  }
});

// ─────────────────────────────────────────────
//  VOICE STATE UPDATE — Dog suit le maître / Menotte
// ─────────────────────────────────────────────
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;

  if (newState.channelId !== oldState.channelId && newState.member) {
    const masterId = newState.member.id;
    for (const [dogId, dogData] of store.dogs.entries()) {
      if (dogData.masterId !== masterId) continue;
      const dogMember = await guild.members.fetch(dogId).catch(() => null);
      if (!dogMember?.voice?.channel) continue;
      if (newState.channelId) {
        try { await dogMember.voice.setChannel(newState.channelId, "Dog — suit le maître"); } catch {}
      }
    }
  }

  if (newState.member) {
    const menotte = store.menottes.get(newState.member.id);
    if (menotte) {
      const lockedChannelId = menotte.channelId;
      if (newState.channelId && newState.channelId !== lockedChannelId) {
        setTimeout(async () => {
          try { await newState.member.voice.setChannel(lockedChannelId, "Menotte active"); } catch {}
        }, 300);
      }
    }
  }
});

// ─────────────────────────────────────────────
//  AUDIT LOG — Re-timeout couniamanmanw si quelqu'un essaie de le lever
// ─────────────────────────────────────────────
client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
  if (entry.action !== 24) return;
  const targetId = entry.target?.id;
  if (!targetId) return;

  const cmw = store.couniamanmanw.get(targetId);
  if (!cmw) return;

  const executorId = entry.executor?.id;
  if (!executorId || executorId === CONFIG.CLIENT_ID) return;
  if (isSystemPlus(executorId)) return;

  const executor    = await guild.members.fetch(executorId).catch(() => null);
  const cmwExecutor = cmw.executorId;

  if (executor && isSystem(executor) && !isSystemPlus(cmwExecutor)) return;

  const targetMember = await guild.members.fetch(targetId).catch(() => null);
  if (targetMember) {
    const now = Date.now();
    if (now < cmw.timeoutEnd) {
      const remaining = cmw.timeoutEnd - now;
      try {
        await targetMember.timeout(Math.min(remaining, 28 * 24 * 60 * 60 * 1000), "Couniamanmanw — re-timeout");
      } catch {}
    }
  }

  if (executor) {
    await sendDM(executor.user, new EmbedBuilder()
      .setColor(BLACK)
      .setDescription(`⚠️ **Attention** tu as essayé de toucher au couniamanmanw d'un supérieur.`)
    );
  }
});

// ─────────────────────────────────────────────
//  MESSAGE CREATE — Commandes préfixe +
// ─────────────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.guild)     return;
  if (!message.content.startsWith("+")) return;

  const args   = message.content.slice(1).trim().split(/\s+/);
  const cmd    = args.shift().toLowerCase();
  const guild  = message.guild;
  const member = message.member;

  const prefixReply = async (embed) => {
    try { await message.reply({ embeds: [embed] }); } catch {}
  };

  // ════════════════════════════════════════════
  //  +bl
  // ════════════════════════════════════════════
  if (cmd === "bl") {
    if (!isSystemPlus(member.id) && !hasPerm(member, "bl"))
      return prefixReply(makeEmbed(RED, "❌ Permission refusée pour `+bl`."));

    const rateCheck = checkRateLimit(member.id, "bl");
    if (!rateCheck.allowed)
      return prefixReply(makeEmbed(RED, `❌ Limite atteinte. Réessaie dans **${rateCheck.remaining} minutes**.`));

    const mention  = message.mentions.users.first();
    const rawArg   = args[0];
    const targetId = mention?.id || (rawArg && /^\d{17,20}$/.test(rawArg) ? rawArg : null);

    if (!targetId)
      return prefixReply(makeEmbed(RED, "❌ Mentionne une victime : `+bl @victime raison: ...`"));

    const full        = args.slice(mention ? 0 : 1).join(" ");
    const raisonMatch = full.match(/raison\s*:\s*(.+)/i);
    const modType     = getModType(member);
    let raison        = raisonMatch ? raisonMatch[1].trim() : null;

    if (!raison && !isSystemPlus(member.id) && !isSystem(member))
      return prefixReply(makeEmbed(RED, "❌ Fournis une raison : `+bl @victime raison: <raison>`"));

    raison = raison || "—";

    const target = mention || await client.users.fetch(targetId).catch(() => null);
    if (!target)
      return prefixReply(makeEmbed(RED, "❌ Utilisateur introuvable."));
    if (isSystemPlus(target.id))
      return prefixReply(makeEmbed(RED, "❌ Impossible de blacklister un System+."));

    store.blacklist.set(target.id, { reason: raison, modId: member.id, modType, date: new Date().toISOString() });

    const targetMember = await guild.members.fetch(target.id).catch(() => null);
    if (targetMember) {
      await sendDM(target, blDMEmbed(raison, modType, raison === "—"));
      store.ourKicks.add(target.id);
      try { await targetMember.kick(`[Blacklist] ${raison}`); } catch {}
    }

    await sendDM(member.user, makeEmbed(BLACK, `✓ **${target.tag}** a été blacklisté de **${CONFIG.SERVER_NAME}**.`));

    return prefixReply(new EmbedBuilder()
      .setColor(RED)
      .setDescription(`✓ <@${target.id}> a été blacklisté.`)
      .addFields(
        { name: "Par",    value: `<@${member.id}>`, inline: true },
        { name: "Raison", value: raison,             inline: true },
      )
    );
  }

  // ════════════════════════════════════════════
  //  +unbl
  // ════════════════════════════════════════════
  if (cmd === "unbl") {
    const mention  = message.mentions.users.first();
    const rawId    = args[0];
    const targetId = mention?.id || rawId;

    if (!targetId)
      return prefixReply(makeEmbed(RED, "❌ Usage : `+unbl @user` ou `+unbl <ID>`"));

    const blData = store.blacklist.get(targetId);
    if (!blData)
      return prefixReply(makeEmbed(DARK, "Cet utilisateur n'est pas dans la blacklist."));

    if (blData.modType === "system+") {
      if (!isSystemPlus(member.id))
        return prefixReply(makeEmbed(RED, "❌ Seul un **System+** peut retirer une blacklist posée par un System+."));
    } else if (blData.modType === "system") {
      if (!isSystemPlus(member.id) && member.id !== blData.modId)
        return prefixReply(makeEmbed(RED, "❌ Seul un **System+** ou le **System** qui l'a posée peut la retirer."));
    } else {
      if (!isSystemPlus(member.id) && !isSystem(member))
        return prefixReply(makeEmbed(RED, "❌ Permission refusée pour `+unbl`."));
    }

    store.blacklist.delete(targetId);
    const u = await client.users.fetch(targetId).catch(() => null);
    return prefixReply(makeEmbed(DARK, `✓ **${u ? u.tag : targetId}** a été retiré de la blacklist.`));
  }

  // ════════════════════════════════════════════
  //  +ban
  // ════════════════════════════════════════════
  if (cmd === "ban") {
    if (!isSystemPlus(member.id) && !hasPerm(member, "ban"))
      return prefixReply(makeEmbed(RED, "❌ Permission refusée pour `+ban`."));

    const rateCheck = checkRateLimit(member.id, "ban");
    if (!rateCheck.allowed)
      return prefixReply(makeEmbed(RED, `❌ Limite atteinte. Réessaie dans **${rateCheck.remaining} minutes**.`));

    const mention  = message.mentions.users.first();
    const rawArg   = args[0];
    const targetId = mention?.id || (rawArg && /^\d{17,20}$/.test(rawArg) ? rawArg : null);

    if (!targetId)
      return prefixReply(makeEmbed(RED, "❌ Usage : `+ban @user raison: <raison>`"));

    const full        = args.slice(mention ? 0 : 1).join(" ");
    const raisonMatch = full.match(/raison\s*:\s*(.+)/i);
    const modType     = getModType(member);
    let raison        = raisonMatch ? raisonMatch[1].trim() : null;

    if (!raison && !isSystemPlus(member.id) && !isSystem(member))
      return prefixReply(makeEmbed(RED, "❌ Fournis une raison : `+ban @user raison: <raison>`"));

    raison = raison || "—";

    const target = mention || await client.users.fetch(targetId).catch(() => null);
    if (!target)
      return prefixReply(makeEmbed(RED, "❌ Utilisateur introuvable."));
    if (isSystemPlus(target.id))
      return prefixReply(makeEmbed(RED, "❌ Impossible de bannir un System+."));

    try {
      store.ourBans.add(target.id);
      await guild.bans.create(target.id, { reason: raison, deleteMessageSeconds: 604800 });
      store.bans.set(target.id, { reason: raison, modId: member.id, modType, date: new Date().toISOString() });
      await sendDM(target, banDMEmbed(raison, modType, raison === "—"));
      return prefixReply(new EmbedBuilder()
        .setColor(RED)
        .setDescription(`✓ **${target.tag}** a été banni.`)
        .addFields(
          { name: "Par",    value: `<@${member.id}>`, inline: true },
          { name: "Raison", value: raison,             inline: true },
        )
      );
    } catch (err) {
      store.ourBans.delete(target.id);
      return prefixReply(makeEmbed(RED, `❌ Erreur : \`${err.message}\``));
    }
  }

  // ════════════════════════════════════════════
  //  +unban
  // ════════════════════════════════════════════
  if (cmd === "unban") {
    if (!isSystemPlus(member.id) && !hasPerm(member, "ban"))
      return prefixReply(makeEmbed(RED, "❌ Permission refusée pour `+unban`."));

    const id = args[0];
    if (!id) return prefixReply(makeEmbed(RED, "❌ Usage : `+unban <ID>`"));

    try {
      await guild.bans.remove(id);
      store.bans.delete(id);
      return prefixReply(makeEmbed(DARK, `✓ \`${id}\` a été débanni.`));
    } catch (err) {
      return prefixReply(makeEmbed(RED, `❌ Erreur : \`${err.message}\``));
    }
  }

  // ════════════════════════════════════════════
  //  +baninfo
  // ════════════════════════════════════════════
  if (cmd === "baninfo") {
    if (!isSystemPlus(member.id) && !hasPerm(member, "ban"))
      return prefixReply(makeEmbed(RED, "❌ Permission refusée pour `+baninfo`."));

    const mention  = message.mentions.users.first();
    const rawId    = args[0];
    const targetId = mention?.id || rawId;

    if (!targetId)
      return prefixReply(makeEmbed(RED, "❌ Usage : `+baninfo @user` ou `+baninfo <ID>`"));

    const banData = store.bans.get(targetId);
    let guildBan  = null;
    try { guildBan = await guild.bans.fetch(targetId); } catch {}

    if (!banData && !guildBan)
      return prefixReply(makeEmbed(DARK, "Cet utilisateur n'est pas banni."));

    const u = await client.users.fetch(targetId).catch(() => null);

    return prefixReply(new EmbedBuilder()
      .setColor(BLACK)
      .setDescription(`╭───────────────\n│ 📄 Rapport BAN INFO\n╰───────────────`)
      .addFields(
        { name: "👤 Utilisateur", value: `• Pseudo : ${u ? `<@${u.id}>` : `\`${targetId}\``}\n• Identifiant : \`${targetId}\`` },
        { name: "📝 Motif",       value: banData?.reason || guildBan?.reason || "Inconnue" },
        { name: "👮 Traitement",  value: `• Modérateur : ${banData ? modDisplayName(banData.modType, banData.modId) : "Inconnu"}\n• Identifiant : \`${banData?.modId || "?"}\`` },
        { name: "📅 Date",        value: `• ${fmtDate(banData?.date)}` },
      )
    );
  }

  // ════════════════════════════════════════════
  //  +derank
  // ════════════════════════════════════════════
  if (cmd === "derank") {
    if (!isSystemPlus(member.id) && !hasPerm(member, "derank"))
      return prefixReply(makeEmbed(RED, "❌ Permission refusée pour `+derank`."));

    const mention  = message.mentions.users.first();
    const rawArg   = args[0];
    const targetId = mention?.id || (rawArg && /^\d{17,20}$/.test(rawArg) ? rawArg : null);

    if (!targetId)
      return prefixReply(makeEmbed(RED, "❌ Usage : `+derank @user`"));
    if (isSystemPlus(targetId))
      return prefixReply(makeEmbed(RED, "❌ Impossible de derank un System+."));

    const targetMember = await guild.members.fetch(targetId).catch(() => null);
    if (!targetMember)
      return prefixReply(makeEmbed(RED, "❌ Ce membre n'est pas sur le serveur."));

    const full   = args.slice(mention ? 0 : 1).join(" ").trim();
    const raison = full || null;
    const modType = getModType(member);

    if (!canActOn(member, modType))
      return prefixReply(makeEmbed(RED, "❌ Vous ne pouvez pas agir sur cet utilisateur."));

    if (!raison && !isSystemPlus(member.id) && !isSystem(member) && !hasPerm(member, "derank_no_reason"))
      return prefixReply(makeEmbed(RED, "❌ Fournis une raison pour `+derank`."));

    const rolesBefore = targetMember.roles.cache
      .filter(r => r.id !== guild.id)
      .sort((a, b) => b.position - a.position)
      .map(r => `<@&${r.id}>`)
      .join(", ") || "Aucun";

    await totalDerank(targetMember);
    await sendDM(targetMember.user, new EmbedBuilder()
      .setColor(BLACK)
      .setDescription(`Vous avez été **derank** sur **${CONFIG.SERVER_NAME}**.`)
    );

    return prefixReply(new EmbedBuilder()
      .setColor(RED)
      .setDescription(`✓ <@${targetId}> a été totalement derank.`)
      .addFields(
        { name: "Rôles retirés", value: rolesBefore.slice(0, 1024) },
        { name: "Par",    value: `<@${member.id}>`, inline: true },
        { name: "Raison", value: raison || "—",     inline: true },
      )
    );
  }

  // ════════════════════════════════════════════
  //  +menotte
  // ════════════════════════════════════════════
  if (cmd === "menotte") {
    if (!isSystemPlus(member.id) && !isSystem(member) && !hasPerm(member, "menotte"))
      return prefixReply(makeEmbed(RED, "❌ Permission refusée pour `+menotte`."));

    const mention   = message.mentions.users.first();
    const rawArgs   = args.filter(a => !a.startsWith("<@"));
    const targetId  = mention?.id;
    const channelId = rawArgs[0];

    if (!targetId || !channelId)
      return prefixReply(makeEmbed(RED, "❌ Usage : `+menotte @user <IDchannel>`"));

    const targetMember = await guild.members.fetch(targetId).catch(() => null);
    if (!targetMember)
      return prefixReply(makeEmbed(RED, "❌ Ce membre n'est pas sur le serveur."));
    if (isSystemPlus(targetId))
      return prefixReply(makeEmbed(RED, "❌ Impossible de mettre en menotte un System+."));
    if (isSystem(targetMember) && !isSystemPlus(member.id))
      return prefixReply(makeEmbed(RED, "❌ Impossible de mettre en menotte un System."));

    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased())
      return prefixReply(makeEmbed(RED, "❌ L'ID du channel doit être un salon vocal valide."));

    const rateCheck = checkRateLimit(member.id, "menotte");
    if (!rateCheck.allowed)
      return prefixReply(makeEmbed(RED, `❌ Limite atteinte. Réessaie dans **${rateCheck.remaining} minutes**.`));

    store.menottes.set(targetId, { executorId: member.id, channelId, date: new Date().toISOString() });

    if (targetMember.voice.channel) {
      try { await targetMember.voice.setChannel(channelId, "Menotte"); } catch {}
    }

    return prefixReply(makeEmbed(DARK, `✓ <@${targetId}> est maintenant en menotte dans <#${channelId}>.`));
  }

  // ════════════════════════════════════════════
  //  +libre
  // ════════════════════════════════════════════
  if (cmd === "libre") {
    const mention  = message.mentions.users.first();
    const targetId = mention?.id;

    if (!targetId)
      return prefixReply(makeEmbed(RED, "❌ Usage : `+libre @user`"));

    const menotte = store.menottes.get(targetId);
    if (!menotte)
      return prefixReply(makeEmbed(DARK, "Cet utilisateur n'est pas en menotte."));

    if (!isSystemPlus(member.id) && !isSystem(member) && menotte.executorId !== member.id)
      return prefixReply(makeEmbed(RED, "❌ Seul celui qui a mis la menotte peut la retirer."));

    store.menottes.delete(targetId);
    return prefixReply(makeEmbed(DARK, `✓ <@${targetId}> est libéré de sa menotte.`));
  }
});

// ─────────────────────────────────────────────
//  INTERACTION HANDLER — Slash Commands
// ─────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, member, guild } = interaction;

  const reply = (color, desc, fields = [], ephemeral = false) => {
    const e = makeEmbed(color, desc, fields);
    return interaction.reply({ embeds: [e], ephemeral });
  };

  // ════════════════════════════════════════════
  //  /help
  // ════════════════════════════════════════════
  if (commandName === "help") {
    if (!isSystemPlus(member.id))
      return reply(RED, "❌ `/help` est réservé aux **System+**.", [], true);

    return interaction.reply({ embeds: [
      new EmbedBuilder()
        .setColor(BLACK)
        .setTitle("╸ Commandes Maledike")
        .setDescription("discord.gg/maledike")
        .addFields(
          { name: "🎖️ Rangs",        value: "`/rank` — Attribue un rôle\n`/derank` `+derank` — Retire tous les rôles" },
          { name: "🔨 Ban",           value: "`/ban` `+ban` — Bannir\n`/unban` `+unban` — Débannir\n`/baninfo` `+baninfo` — Infos" },
          { name: "🚫 Blacklist",     value: "`/bl` `+bl` — Blacklister\n`/unbl` `+unbl` — Retirer\n`/blist` — Liste\n`/blinfo` — Infos" },
          { name: "🎭 Blacklist Rôle",value: "`/blr` — BLR\n`/unblr` — Retirer BLR\n`/blrinfo` — Infos" },
          { name: "💤 Wakeup",        value: "`/wakeup` — Déplace dans tous les vocaux 20s" },
          { name: "🐕 Dog",           value: "`/dog` — Mettre en laisse\n`/undog` — Enlever laisse\n`/undogalls` — Enlever toutes les laisses\n`/doglist` — Liste" },
          { name: "☠️ Spécial",       value: "`/aykokemanmanw` — BL permanente\n`/viniw` — Retire aykokemanmanw\n`/couniamanmanw` — Timeout 28j\n`/uncouniamanmanw` — Retire" },
          { name: "⛓️ Menotte",       value: "`+menotte @user IDchannel` — Menotte\n`+libre @user` — Libère" },
          { name: "👑 Owner Bot",      value: "`/ownerbot` `/unownerbot` `/ownerbotlist`" },
          { name: "⚙️ Configuration", value: "`/settingbl` `/settingban` `/settingderank` `/settingwakeup`\n`/settingdogs` `/settingsaykokemanmanw` `/settingscouniamanmanw`\n`/settingmenotte` `/settingviniw` `/settingsystem`\n`/rankconfig`" },
        )
        .setFooter({ text: "Maledike • discord.gg/maledike" })
    ], ephemeral: true });
  }

  // ════════════════════════════════════════════
  //  /rank
  // ════════════════════════════════════════════
  if (commandName === "rank") {
    if (!isSystemPlus(member.id) && !hasPerm(member, "rank"))
      return reply(RED, "❌ Permission refusée pour `/rank`.", [], true);

    const targetUser   = interaction.options.getUser("membre");
    const role         = interaction.options.getRole("role");
    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);

    if (isSystemPlus(targetUser.id))
      return reply(RED, "❌ Impossible de rank un System+.", [], true);
    if (!targetMember)
      return reply(RED, "❌ Ce membre n'est pas sur le serveur.", [], true);
    if (!canRank(member, role.id))
      return reply(RED, `❌ Vous n'avez pas l'autorisation d'attribuer **${role.name}**.`, [], true);
    if (exceedsCeiling(member, role.id))
      return reply(DARK, `✗ Plafond dépassé pour **${role.name}**.`, [], true);

    try {
      await targetMember.roles.add(role, `Rank par ${member.user.tag}`);
      const rule      = getRankRule(role.id);
      const autoAdded = [];
      if (rule?.assignRoles?.length > 0) {
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
        new EmbedBuilder().setColor(DARK)
          .setDescription(
            `✓ <@${targetUser.id}> a été rank **${role.name}**.` +
            (autoAdded.length ? `\nRôles ajoutés : ${autoAdded.map(r => `<@&${r.id}>`).join(", ")}` : "")
          )
          .addFields(
            { name: "Rôles actuels", value: rolesAfter.slice(0, 1024) },
            { name: "Par",           value: `<@${member.id}>`,   inline: true },
            { name: "Rôle attribué", value: `<@&${role.id}>`,    inline: true },
          )
      ]});
    } catch (err) {
      return reply(RED, `❌ Erreur : \`${err.message}\``, [], true);
    }
  }

  // ════════════════════════════════════════════
  //  /derank
  // ════════════════════════════════════════════
  if (commandName === "derank") {
    if (!isSystemPlus(member.id) && !hasPerm(member, "derank"))
      return reply(RED, "❌ Permission refusée pour `/derank`.", [], true);

    const targetUser   = interaction.options.getUser("membre");
    const raison       = interaction.options.getString("raison");
    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);

    if (isSystemPlus(targetUser.id))
      return reply(RED, "❌ Impossible de derank un System+.", [], true);
    if (!targetMember)
      return reply(RED, "❌ Ce membre n'est pas sur le serveur.", [], true);
    if (!raison && !isSystemPlus(member.id) && !isSystem(member) && !hasPerm(member, "derank_no_reason"))
      return reply(RED, "❌ Vous devez fournir une raison.", [], true);

    const rolesBefore = targetMember.roles.cache
      .filter(r => r.id !== guild.id)
      .sort((a, b) => b.position - a.position)
      .map(r => `<@&${r.id}>`)
      .join(", ") || "Aucun";

    await totalDerank(targetMember);
    await sendDM(targetUser, new EmbedBuilder()
      .setColor(BLACK)
      .setDescription(`Vous avez été **derank** sur **${CONFIG.SERVER_NAME}**.`)
    );

    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(RED)
        .setDescription(`✓ <@${targetUser.id}> a été totalement derank.`)
        .addFields(
          { name: "Rôles retirés", value: rolesBefore.slice(0, 1024) },
          { name: "Par",    value: `<@${member.id}>`, inline: true },
          { name: "Raison", value: raison || "—",     inline: true },
        )
    ]});
  }

  // ════════════════════════════════════════════
  //  /rankconfig
  // ════════════════════════════════════════════
  if (commandName === "rankconfig") {
    if (!isSystemPlus(member.id))
      return reply(RED, "❌ `/rankconfig` est réservé aux **System+**.", [], true);

    const action       = interaction.options.getString("action");
    const role         = interaction.options.getRole("role");
    const role2        = interaction.options.getRole("role2");
    const role3        = interaction.options.getRole("role3");
    const role4        = interaction.options.getRole("role4");
    const roleAutorise = interaction.options.getRole("roleautorise");

    if (action === "show") {
      if (CONFIG.RANK_CONFIG.length === 0) return reply(DARK, "Aucune règle configurée.");
      const lines = CONFIG.RANK_CONFIG.map((r, i) => {
        const name    = guild.roles.cache.get(r.rankRole)?.name || r.rankRole;
        const ceiling = r.maxRole ? `<@&${r.maxRole}>` : "Aucun";
        const linked  = r.assignRoles?.length ? r.assignRoles.map(id => `<@&${id}>`).join(", ") : "Aucun";
        const allowed = r.allowedRoles?.length ? r.allowedRoles.map(id => `<@&${id}>`).join(", ") : "Tous";
        return `**${i + 1}. ${name}**\n→ Plafond : ${ceiling} | Liés : ${linked} | Autorisés : ${allowed}`;
      });
      return interaction.reply({ embeds: [
        new EmbedBuilder().setColor(DARK).setTitle("📋 Règles de rang").setDescription(lines.join("\n\n"))
      ], ephemeral: true });
    }
    if (action === "add") {
      if (!role) return reply(RED, "Sélectionne un rôle avec `role`.", [], true);
      if (CONFIG.RANK_CONFIG.find(r => r.rankRole === role.id))
        return reply(RED, `Une règle existe déjà pour **${role.name}**.`, [], true);
      CONFIG.RANK_CONFIG.push({ rankRole: role.id, assignRoles: [], maxRole: null, allowedRoles: [] });
      return reply(DARK, `✓ Règle créée pour **${role.name}**.`);
    }
    if (action === "remove") {
      if (!role) return reply(RED, "Sélectionne le rôle avec `role`.", [], true);
      const idx = CONFIG.RANK_CONFIG.findIndex(r => r.rankRole === role.id);
      if (idx === -1) return reply(RED, `Aucune règle pour **${role.name}**.`, [], true);
      CONFIG.RANK_CONFIG.splice(idx, 1);
      return reply(DARK, `✓ Règle supprimée pour **${role.name}**.`);
    }
    if (action === "setceiling") {
      if (!role || !role2) return reply(RED, "`role` = le rang — `role2` = le plafond max.", [], true);
      let rule = CONFIG.RANK_CONFIG.find(r => r.rankRole === role.id);
      if (!rule) { rule = { rankRole: role.id, assignRoles: [], maxRole: null, allowedRoles: [] }; CONFIG.RANK_CONFIG.push(rule); }
      rule.maxRole = role2.id;
      return reply(DARK, `✓ Plafond : **${role.name}** ne peut pas dépasser **${role2.name}**.`);
    }
    if (action === "linkroles") {
      if (!role) return reply(RED, "Sélectionne le rôle principal avec `role`.", [], true);
      let rule = CONFIG.RANK_CONFIG.find(r => r.rankRole === role.id);
      if (!rule) { rule = { rankRole: role.id, assignRoles: [], maxRole: null, allowedRoles: [] }; CONFIG.RANK_CONFIG.push(rule); }
      const toLink = [role2, role3, role4].filter(Boolean);
      if (!toLink.length) return reply(RED, "Ajoute au moins un rôle lié avec `role2`.", [], true);
      for (const r of toLink) if (!rule.assignRoles.includes(r.id)) rule.assignRoles.push(r.id);
      return reply(DARK, `✓ Rôles liés à **${role.name}** : ${toLink.map(r => `<@&${r.id}>`).join(", ")}`);
    }
    if (action === "setallowed") {
      if (!role || !roleAutorise) return reply(RED, "`role` = le rang — `roleautorise` = qui peut le donner.", [], true);
      let rule = CONFIG.RANK_CONFIG.find(r => r.rankRole === role.id);
      if (!rule) { rule = { rankRole: role.id, assignRoles: [], maxRole: null, allowedRoles: [] }; CONFIG.RANK_CONFIG.push(rule); }
      if (!rule.allowedRoles.includes(roleAutorise.id)) rule.allowedRoles.push(roleAutorise.id);
      return reply(DARK, `✓ **${roleAutorise.name}** peut maintenant rank **${role.name}**.`);
    }
    return reply(RED, "Action inconnue.", [], true);
  }

  // ════════════════════════════════════════════
  //  /ownerbot / /unownerbot / /ownerbotlist
  // ════════════════════════════════════════════
  if (commandName === "ownerbot") {
    if (!isSystemPlus(member.id)) return reply(RED, "❌ Réservé aux **System+**.", [], true);
    const target = interaction.options.getUser("membre");
    if (isSystemPlus(target.id)) return reply(RED, "Cet utilisateur est déjà System+.", [], true);
    CONFIG.OWNER_IDS.push(target.id);
    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(BLACK)
        .setDescription(`👑 **${target.tag}** est maintenant **System+ (Owner Bot)**.`)
        .addFields({ name: "Ajouté par", value: `<@${member.id}>`, inline: true })
    ]});
  }

  if (commandName === "unownerbot") {
    if (!isSystemPlus(member.id)) return reply(RED, "❌ Réservé aux **System+**.", [], true);
    const target = interaction.options.getUser("membre");
    if (CONFIG.HARDCODED.includes(target.id)) return reply(RED, "Impossible de retirer un System+ originel.", [], true);
    const idx = CONFIG.OWNER_IDS.indexOf(target.id);
    if (idx === -1) return reply(RED, "Cet utilisateur n'est pas System+.", [], true);
    CONFIG.OWNER_IDS.splice(idx, 1);
    return reply(DARK, `✓ **${target.tag}** n'est plus System+.`);
  }

  if (commandName === "ownerbotlist") {
    if (!isSystemPlus(member.id)) return reply(RED, "❌ Réservé aux **System+**.", [], true);
    const lines = [];
    for (const id of CONFIG.OWNER_IDS) {
      const u = await client.users.fetch(id).catch(() => null);
      lines.push(`${u ? `**${u.tag}**` : `\`${id}\``} ${CONFIG.HARDCODED.includes(id) ? "*(originel)*" : ""}`);
    }
    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(BLACK).setTitle("👑 System+ / Owners Bot").setDescription(lines.join("\n") || "Aucun.")
    ], ephemeral: true });
  }

  // ════════════════════════════════════════════
  //  /ban
  // ════════════════════════════════════════════
  if (commandName === "ban") {
    if (!isSystemPlus(member.id) && !hasPerm(member, "ban"))
      return reply(RED, "❌ Permission refusée pour `/ban`.", [], true);

    const rateCheck = checkRateLimit(member.id, "ban");
    if (!rateCheck.allowed)
      return reply(RED, `❌ Limite de ban atteinte. Réessaie dans **${rateCheck.remaining} minutes**.`, [], true);

    const target      = interaction.options.getUser("membre");
    const raisonInput = interaction.options.getString("raison");
    const modType     = getModType(member);
    let raison        = raisonInput;

    if (!raison && !isSystemPlus(member.id) && !isSystem(member))
      return reply(RED, "❌ Vous devez fournir une raison pour bannir.", [], true);

    raison = raison || "—";

    if (isSystemPlus(target.id))
      return reply(RED, "❌ Impossible de bannir un System+.", [], true);

    try {
      store.ourBans.add(target.id);
      await guild.bans.create(target.id, { reason: raison, deleteMessageSeconds: 604800 });
      store.bans.set(target.id, { reason: raison, modId: member.id, modType, date: new Date().toISOString() });
      await sendDM(target, banDMEmbed(raison, modType, !raisonInput));
      return interaction.reply({ embeds: [
        new EmbedBuilder().setColor(RED)
          .setDescription(`✓ **${target.tag}** a été banni.`)
          .addFields(
            { name: "Par",    value: `<@${member.id}>`, inline: true },
            { name: "Raison", value: raison,             inline: true },
          )
      ]});
    } catch (err) {
      store.ourBans.delete(target.id);
      return reply(RED, `❌ Erreur : \`${err.message}\``, [], true);
    }
  }

  // ════════════════════════════════════════════
  //  /unban
  // ════════════════════════════════════════════
  if (commandName === "unban") {
    if (!isSystemPlus(member.id) && !hasPerm(member, "ban"))
      return reply(RED, "❌ Permission refusée pour `/unban`.", [], true);
    const id = interaction.options.getString("id");
    try {
      await guild.bans.remove(id);
      store.bans.delete(id);
      return reply(DARK, `✓ \`${id}\` a été débanni.`);
    } catch (err) {
      return reply(RED, `❌ Erreur : \`${err.message}\``, [], true);
    }
  }

  // ════════════════════════════════════════════
  //  /baninfo
  // ════════════════════════════════════════════
  if (commandName === "baninfo") {
    if (!isSystemPlus(member.id) && !hasPerm(member, "ban"))
      return reply(RED, "❌ Permission refusée pour `/baninfo`.", [], true);

    const targetUser = interaction.options.getUser("membre");
    const targetId   = interaction.options.getString("id") || targetUser?.id;
    if (!targetId) return reply(RED, "❌ Mentionne un membre ou fournis un ID.", [], true);

    const banData = store.bans.get(targetId);
    let guildBan  = null;
    try { guildBan = await guild.bans.fetch(targetId); } catch {}
    if (!banData && !guildBan) return reply(DARK, "Cet utilisateur n'est pas banni.");

    const u = await client.users.fetch(targetId).catch(() => null);
    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(BLACK)
        .setDescription("╭───────────────\n│ 📄 Rapport BAN INFO\n╰───────────────")
        .addFields(
          { name: "👤 Utilisateur", value: `• Pseudo : ${u ? `<@${u.id}>` : `\`${targetId}\``}\n• Identifiant : \`${targetId}\`` },
          { name: "📝 Motif",       value: banData?.reason || guildBan?.reason || "Inconnue" },
          { name: "👮 Traitement",  value: banData ? `• Modérateur : ${modDisplayName(banData.modType, banData.modId)}\n• Identifiant : \`${banData.modId}\`` : "• Inconnu" },
          { name: "📅 Date",        value: `• ${fmtDate(banData?.date)}` },
        )
    ], ephemeral: true });
  }

  // ════════════════════════════════════════════
  //  /bl
  // ════════════════════════════════════════════
  if (commandName === "bl") {
    if (!isSystemPlus(member.id) && !hasPerm(member, "bl"))
      return reply(RED, "❌ Permission refusée pour `/bl`.", [], true);

    const rateCheck = checkRateLimit(member.id, "bl");
    if (!rateCheck.allowed)
      return reply(RED, `❌ Limite de BL atteinte. Réessaie dans **${rateCheck.remaining} minutes**.`, [], true);

    const targetUser  = interaction.options.getUser("membre");
    const rawId       = interaction.options.getString("id");
    const targetId    = targetUser?.id || rawId;
    const raisonInput = interaction.options.getString("raison");
    const modType     = getModType(member);
    let raison        = raisonInput;

    if (!targetId)
      return reply(RED, "❌ Mentionne un membre avec `membre` ou fournis un `id`.", [], true);
    if (!raison && !isSystemPlus(member.id) && !isSystem(member))
      return reply(RED, "❌ Vous devez fournir une raison.", [], true);

    raison = raison || "—";

    const target = targetUser || await client.users.fetch(targetId).catch(() => null);
    if (!target) return reply(RED, "❌ Utilisateur introuvable.", [], true);
    if (isSystemPlus(target.id)) return reply(RED, "❌ Impossible de blacklister un System+.", [], true);

    store.blacklist.set(target.id, { reason: raison, modId: member.id, modType, date: new Date().toISOString() });

    const targetMember = await guild.members.fetch(target.id).catch(() => null);
    if (targetMember) {
      await sendDM(target, blDMEmbed(raison, modType, !raisonInput));
      store.ourKicks.add(target.id);
      try { await targetMember.kick(`[Blacklist] ${raison}`); } catch {}
    }

    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(RED)
        .setDescription(`✓ **${target.tag}** (\`${target.id}\`) a été blacklisté.`)
        .addFields(
          { name: "Par",    value: `<@${member.id}>`, inline: true },
          { name: "Raison", value: raison,             inline: true },
        )
    ]});
  }

  // ════════════════════════════════════════════
  //  /unbl
  // ════════════════════════════════════════════
  if (commandName === "unbl") {
    const id     = interaction.options.getString("id");
    const blData = store.blacklist.get(id);
    if (!blData) return reply(DARK, "Cet utilisateur n'est pas dans la blacklist.");

    if (blData.modType === "system+") {
      if (!isSystemPlus(member.id))
        return reply(RED, "❌ Cette blacklist a été posée par un **System+**. Seul un System+ peut la retirer.", [], true);
    } else if (blData.modType === "system") {
      if (!isSystemPlus(member.id) && member.id !== blData.modId)
        return reply(RED, "❌ Cette blacklist a été posée par un **System**. Seul un System+ ou ce System peut la retirer.", [], true);
    } else {
      if (!isSystemPlus(member.id) && !isSystem(member))
        return reply(RED, "❌ Vous n'avez pas la permission d'utiliser `/unbl`.", [], true);
    }

    store.blacklist.delete(id);
    const u = await client.users.fetch(id).catch(() => null);
    return reply(DARK, `✓ **${u ? u.tag : id}** a été retiré de la blacklist.`);
  }

  // ════════════════════════════════════════════
  //  /blist
  // ════════════════════════════════════════════
  if (commandName === "blist") {
    if (!isSystemPlus(member.id) && !hasPerm(member, "bl"))
      return reply(RED, "❌ Permission refusée.", [], true);
    if (!store.blacklist.size) return reply(DARK, "Aucun utilisateur blacklisté.");

    const lines = [];
    for (const [id, data] of store.blacklist.entries()) {
      const u = await client.users.fetch(id).catch(() => null);
      lines.push(`${u ? `**${u.tag}**` : `\`${id}\``} — ${data.reason}`);
    }
    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(BLACK)
        .setTitle(`🚫 Blacklist (${store.blacklist.size})`)
        .setDescription(lines.join("\n").slice(0, 4096))
    ], ephemeral: true });
  }

  // ════════════════════════════════════════════
  //  /blinfo
  // ════════════════════════════════════════════
  if (commandName === "blinfo") {
    if (!isSystemPlus(member.id) && !hasPerm(member, "bl"))
      return reply(RED, "❌ Permission refusée.", [], true);

    const targetUser = interaction.options.getUser("membre");
    const targetId   = interaction.options.getString("id") || targetUser?.id;
    if (!targetId) return reply(RED, "❌ Mentionne un membre ou fournis un ID.", [], true);

    const blData = store.blacklist.get(targetId);
    if (!blData) return reply(DARK, "Cet utilisateur n'est pas dans la blacklist.");

    const u = await client.users.fetch(targetId).catch(() => null);
    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(BLACK)
        .setDescription("╭───────────────\n│ 📄 Rapport BL INFO\n╰───────────────")
        .addFields(
          { name: "👤 Utilisateur", value: blData.modType === "system+" || blData.modType === "system" ? `• Pseudo : par un ${blData.modType}\n• Identifiant : \`${targetId}\`` : `• Pseudo : ${u ? `<@${u.id}>` : `\`${targetId}\``}\n• Identifiant : \`${targetId}\`` },
          { name: "📝 Motif",       value: blData.reason },
          { name: "👮 Traitement",  value: `• Modérateur : ${modDisplayName(blData.modType, blData.modId)}\n• Identifiant : \`${blData.modId}\`` },
          { name: "📅 Date",        value: `• ${fmtDate(blData.date)}` },
        )
    ], ephemeral: true });
  }

  // ════════════════════════════════════════════
  //  /blr
  // ════════════════════════════════════════════
  if (commandName === "blr") {
    if (!isSystemPlus(member.id) && !hasPerm(member, "blr"))
      return reply(RED, "❌ Permission refusée pour `/blr`.", [], true);

    const targetUser   = interaction.options.getUser("membre");
    const raison       = interaction.options.getString("raison");
    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);

    if (!targetMember) return reply(RED, "❌ Ce membre n'est pas sur le serveur.", [], true);
    if (isSystemPlus(targetUser.id)) return reply(RED, "❌ Impossible de BLR un System+.", [], true);

    store.blr.set(targetUser.id, { reason: raison, modId: member.id, date: new Date().toISOString() });
    await totalDerank(targetMember);

    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(RED)
        .setDescription(`✓ <@${targetUser.id}> est maintenant en **Blacklist Rôle**. Il ne peut plus avoir de rôle.`)
        .addFields(
          { name: "Par",    value: `<@${member.id}>`, inline: true },
          { name: "Raison", value: raison,             inline: true },
        )
    ]});
  }

  // ════════════════════════════════════════════
  //  /unblr
  // ════════════════════════════════════════════
  if (commandName === "unblr") {
    if (!isSystemPlus(member.id) && !hasPerm(member, "blr"))
      return reply(RED, "❌ Permission refusée pour `/unblr`.", [], true);

    const targetUser = interaction.options.getUser("membre");
    const blrData    = store.blr.get(targetUser.id);
    if (!blrData) return reply(DARK, "Cet utilisateur n'est pas en Blacklist Rôle.");

    if (!canActOn(member, getModType({ id: blrData.modId, roles: { cache: new Map() } })))
      return reply(RED, "❌ Vous ne pouvez pas retirer un BLR posé par quelqu'un de supérieur.", [], true);

    store.blr.delete(targetUser.id);
    return reply(DARK, `✓ <@${targetUser.id}> n'est plus en Blacklist Rôle.`);
  }

  // ════════════════════════════════════════════
  //  /blrinfo
  // ════════════════════════════════════════════
  if (commandName === "blrinfo") {
    if (!isSystemPlus(member.id) && !hasPerm(member, "blr"))
      return reply(RED, "❌ Permission refusée.", [], true);

    const targetUser = interaction.options.getUser("membre");
    const targetId   = interaction.options.getString("id") || targetUser?.id;
    if (!targetId) return reply(RED, "❌ Mentionne un membre ou fournis un ID.", [], true);

    const blrData = store.blr.get(targetId);
    if (!blrData) return reply(DARK, "Cet utilisateur n'est pas en Blacklist Rôle.");

    const u = await client.users.fetch(targetId).catch(() => null);
    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(BLACK)
        .setDescription("╭───────────────\n│ 📄 Rapport BLR INFO\n╰───────────────")
        .addFields(
          { name: "👤 Utilisateur", value: `• Pseudo : ${u ? `<@${u.id}>` : `\`${targetId}\``}\n• Identifiant : \`${targetId}\`` },
          { name: "📝 Motif",       value: blrData.reason },
          { name: "👮 Traitement",  value: `• Modérateur : <@${blrData.modId}>\n• Identifiant : \`${blrData.modId}\`` },
          { name: "📅 Date",        value: `• ${fmtDate(blrData.date)}` },
        )
    ], ephemeral: true });
  }

  // ════════════════════════════════════════════
  //  /wakeup
  // ════════════════════════════════════════════
  if (commandName === "wakeup") {
    if (!isSystemPlus(member.id) && !hasPerm(member, "wakeup"))
      return reply(RED, "❌ Permission refusée pour `/wakeup`.", [], true);
    if (CONFIG.WAKEUP_ACTIVE)
      return reply(RED, "❌ Un wakeup est déjà en cours. Attendez qu'il se termine.", [], true);

    const targetUser   = interaction.options.getUser("membre");
    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);

    if (!targetMember) return reply(RED, "❌ Ce membre n'est pas sur le serveur.", [], true);
    if (!targetMember.voice.channel) return reply(RED, "❌ Ce membre n'est pas dans un salon vocal.", [], true);

    const voiceChannels = guild.channels.cache.filter(c => c.isVoiceBased()).toArray();
    if (voiceChannels.length < 2) return reply(RED, "❌ Pas assez de salons vocaux sur le serveur.", [], true);

    const originalChannel = targetMember.voice.channel;
    CONFIG.WAKEUP_ACTIVE  = true;

    await interaction.reply({ embeds: [
      new EmbedBuilder().setColor(BLACK)
        .setDescription(`💤 **${targetUser.tag}** est en train de se faire **wakeup** pendant 20 secondes...`)
    ]});

    await sendDM(targetUser, makeEmbed(BLACK, `<@${member.id}> te demande de te réveiller !`));

    const otherChannels = voiceChannels.filter(c => c.id !== originalChannel.id);
    let i = 0;
    const endTime = Date.now() + 20_000;

    const wakeInterval = setInterval(async () => {
      if (Date.now() >= endTime) {
        clearInterval(wakeInterval);
        CONFIG.WAKEUP_ACTIVE = false;
        try { await targetMember.voice.setChannel(originalChannel, "Fin du wakeup"); } catch {}
        return;
      }
      const channel = otherChannels[i % otherChannels.length];
      try { await targetMember.voice.setChannel(channel, "Wakeup"); } catch {}
      i++;
    }, 1500);
  }

  // ════════════════════════════════════════════
  //  /dog
  // ════════════════════════════════════════════
  if (commandName === "dog") {
    if (!isSystemPlus(member.id) && !hasPerm(member, "dog"))
      return reply(RED, "❌ Permission refusée pour `/dog`.", [], true);

    const targetUser = interaction.options.getUser("membre");
    if (isSystemPlus(targetUser.id))
      return reply(RED, "❌ Impossible de mettre en laisse un System+.", [], true);

    const dogLimit = CONFIG.RATE_LIMITS.dog?.limit || 3;
    let masterDogCount = 0;
    for (const [, d] of store.dogs.entries()) {
      if (d.masterId === member.id) masterDogCount++;
    }
    if (masterDogCount >= dogLimit && !isSystemPlus(member.id))
      return reply(RED, `❌ Tu as atteint ta limite de **${dogLimit} laisses** simultanées.`, [], true);

    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
    store.dogs.set(targetUser.id, { masterId: member.id, date: new Date().toISOString() });

    const masterDisplay = member.user.displayName || member.user.username;
    const victimDisplay = targetUser.displayName || targetUser.username;
    const lockedName    = `${victimDisplay}(🦮 ${masterDisplay})`;

    store.locknames.set(targetUser.id, lockedName);
    if (targetMember) {
      try { await targetMember.setNickname(lockedName, "Dog — pseudo verrouillé"); } catch {}
    }

    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(BLACK)
        .setDescription(`🐕 <@${targetUser.id}> est maintenant en laisse de <@${member.id}>.`)
        .addFields({ name: "Pseudo verrouillé", value: `\`${lockedName}\``, inline: true })
    ]});
  }

  // ════════════════════════════════════════════
  //  /undog
  // ════════════════════════════════════════════
  if (commandName === "undog") {
    const targetUser = interaction.options.getUser("membre");
    const dogData    = store.dogs.get(targetUser.id);
    if (!dogData) return reply(DARK, "Cet utilisateur n'est pas en laisse.");

    const canBypass = isSystemPlus(member.id) || isSystem(member) || hasPerm(member, "dog_bypass");
    const isMaster  = dogData.masterId === member.id;

    if (!canBypass && !isMaster) {
      const masterMember = await guild.members.fetch(dogData.masterId).catch(() => null);
      const isProtected  = masterMember ? (isSystemPlus(dogData.masterId) || isSystem(masterMember)) : false;

      return interaction.reply({ embeds: [
        new EmbedBuilder().setColor(BLACK)
          .setDescription(isProtected
            ? (isSystemPlus(dogData.masterId)
                ? "❌ Vous n'avez pas l'autorisation de retirer la laisse d'un **system+**."
                : `❌ Vous n'avez pas l'autorisation de retirer la laisse de <@${dogData.masterId}> car **Protect**.`)
            : "❌ Vous n'avez pas l'autorisation d'enlever une laisse qui n'est pas la vôtre."
          )
      ]});
    }

    store.dogs.delete(targetUser.id);
    store.locknames.delete(targetUser.id);

    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
    if (targetMember) {
      try { await targetMember.setNickname(null, "Dog — laisse retirée"); } catch {}
    }

    return reply(DARK, `✓ <@${targetUser.id}> n'est plus en laisse.`);
  }

  // ════════════════════════════════════════════
  //  /undogalls
  // ════════════════════════════════════════════
  if (commandName === "undogalls") {
    if (!isSystemPlus(member.id) && !isSystem(member) && !hasPerm(member, "dog_bypass"))
      return reply(RED, "❌ Permission refusée pour `/undogalls`.", [], true);

    const count = store.dogs.size;
    for (const [dogId] of store.dogs.entries()) {
      store.locknames.delete(dogId);
      const m = await guild.members.fetch(dogId).catch(() => null);
      if (m) { try { await m.setNickname(null, "Undogalls"); } catch {} }
    }
    store.dogs.clear();
    return reply(DARK, `✓ **${count}** laisse(s) retirée(s).`);
  }

  // ════════════════════════════════════════════
  //  /doglist
  // ════════════════════════════════════════════
  if (commandName === "doglist") {
    if (!isSystemPlus(member.id) && !hasPerm(member, "dog"))
      return reply(RED, "❌ Permission refusée.", [], true);
    if (!store.dogs.size) return reply(DARK, "Aucun chien sur le serveur.");

    const lines = [];
    for (const [dogId, dogData] of store.dogs.entries()) {
      const dog    = await client.users.fetch(dogId).catch(() => null);
      const master = await client.users.fetch(dogData.masterId).catch(() => null);
      lines.push(`🐕 ${dog ? `**${dog.tag}**` : `\`${dogId}\``} — Maître : ${master ? `**${master.tag}**` : `\`${dogData.masterId}\``}`);
    }

    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(BLACK)
        .setTitle(`🐕 Liste des chiens (${store.dogs.size})`)
        .setDescription(lines.join("\n").slice(0, 4096))
    ], ephemeral: true });
  }

  // ════════════════════════════════════════════
  //  /aykokemanmanw
  // ════════════════════════════════════════════
  if (commandName === "aykokemanmanw") {
    if (!isSystemPlus(member.id))
      return reply(RED, "❌ Seul un **System+** peut utiliser `/aykokemanmanw`.", [], true);

    const targetUser = interaction.options.getUser("membre");
    if (isSystemPlus(targetUser.id))
      return reply(RED, "❌ Impossible d'aykokemanmanw un System+.", [], true);

    store.aykokemanmanw.set(targetUser.id, { executorId: member.id, date: new Date().toISOString() });
    store.blacklist.set(targetUser.id, { reason: "aykokemanmanw", modId: member.id, modType: "system+", date: new Date().toISOString() });

    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
    if (targetMember) {
      await sendDM(targetUser, new EmbedBuilder()
        .setColor(BLACK)
        .setDescription(`Tu as été **aykokemanmanw** sur **${CONFIG.SERVER_NAME}** force à toi.`)
        .setFooter({ text: `${CONFIG.SERVER_NAME} • discord.gg/maledike` })
      );
      store.ourKicks.add(targetUser.id);
      try { await targetMember.kick("[Aykokemanmanw]"); } catch {}
    }

    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(BLACK)
        .setDescription(`☠️ <@${targetUser.id}> a reçu un **aykokemanmanw** permanent.`)
        .addFields({ name: "Par", value: `<@${member.id}>`, inline: true })
    ]});
  }

  // ════════════════════════════════════════════
  //  /viniw
  // ════════════════════════════════════════════
  if (commandName === "viniw") {
    if (!isSystemPlus(member.id))
      return reply(RED, "❌ Seul un **System+** peut utiliser `/viniw`.", [], true);

    const targetUser = interaction.options.getUser("membre");
    const rawId      = interaction.options.getString("id");
    const targetId   = targetUser?.id || rawId;
    if (!targetId) return reply(RED, "❌ Mentionne un membre ou fournis un ID.", [], true);

    const ayko = store.aykokemanmanw.get(targetId);
    if (!ayko) return reply(DARK, "Cet utilisateur n'est pas en aykokemanmanw.");

    store.aykokemanmanw.delete(targetId);
    store.blacklist.delete(targetId);

    const u = await client.users.fetch(targetId).catch(() => null);
    return reply(DARK, `✓ **${u ? u.tag : targetId}** peut à nouveau rejoindre le serveur.`);
  }

  // ════════════════════════════════════════════
  //  /couniamanmanw
  // ════════════════════════════════════════════
  if (commandName === "couniamanmanw") {
    if (!isSystemPlus(member.id) && !isSystem(member) && !hasPerm(member, "couniamanmanw"))
      return reply(RED, "❌ Permission refusée pour `/couniamanmanw`.", [], true);

    const targetUser   = interaction.options.getUser("membre");
    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);

    if (!targetMember) return reply(RED, "❌ Ce membre n'est pas sur le serveur.", [], true);
    if (isSystemPlus(targetUser.id)) return reply(RED, "❌ Impossible de couniamanmanw un System+.", [], true);
    if (isSystem(targetMember) && !isSystemPlus(member.id)) return reply(RED, "❌ Impossible de couniamanmanw un System.", [], true);

    const TIMEOUT_DURATION = 28 * 24 * 60 * 60 * 1000;
    const timeoutEnd       = Date.now() + TIMEOUT_DURATION;

    store.couniamanmanw.set(targetUser.id, { executorId: member.id, date: new Date().toISOString(), timeoutEnd });

    try {
      await targetMember.timeout(TIMEOUT_DURATION, "Couniamanmanw");
    } catch (err) {
      return reply(RED, `❌ Erreur lors du timeout : \`${err.message}\``, [], true);
    }

    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(BLACK)
        .setDescription(`⏳ <@${targetUser.id}> est en **couniamanmanw** pour 28 jours.`)
        .addFields(
          { name: "Par",       value: `<@${member.id}>`,                     inline: true },
          { name: "Expire le", value: `<t:${Math.floor(timeoutEnd/1000)}:F>`, inline: true },
        )
    ]});
  }

  // ════════════════════════════════════════════
  //  /uncouniamanmanw
  // ════════════════════════════════════════════
  if (commandName === "uncouniamanmanw") {
    const targetUser = interaction.options.getUser("membre");
    const cmwData    = store.couniamanmanw.get(targetUser.id);
    if (!cmwData) return reply(DARK, "Cet utilisateur n'est pas en couniamanmanw.");

    if (isSystemPlus(cmwData.executorId)) {
      if (!isSystemPlus(member.id))
        return reply(RED, "❌ Seul un **System+** peut retirer ce couniamanmanw.", [], true);
    } else if (isSystem({ id: cmwData.executorId, roles: { cache: new Map() } })) {
      if (!isSystemPlus(member.id) && member.id !== cmwData.executorId)
        return reply(RED, "❌ Seul un **System+** ou le **System** qui l'a posé peut le retirer.", [], true);
    }

    store.couniamanmanw.delete(targetUser.id);
    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
    if (targetMember) {
      try { await targetMember.timeout(null, "Uncouniamanmanw"); } catch {}
    }

    return reply(DARK, `✓ <@${targetUser.id}> n'est plus en couniamanmanw.`);
  }

  // ════════════════════════════════════════════
  //  SETTINGS — Helper commun
  // ════════════════════════════════════════════
  async function handleSettingCmd(permKey, interaction, extraLabel = "") {
    if (!isSystemPlus(member.id))
      return reply(RED, `❌ Réservé aux **System+**.`, [], true);

    const action = interaction.options.getString("action");
    const role   = interaction.options.getRole("role");
    const user   = interaction.options.getUser("utilisateur");
    const perm   = CONFIG.PERMS[permKey];
    if (!perm) return reply(RED, "Permission inconnue.", [], true);

    if (action === "show") {
      const roles = perm.roles.length ? perm.roles.map(id => `<@&${id}>`).join(", ") : "Aucun";
      const users = perm.users.length ? perm.users.map(id => `<@${id}>`).join(", ")  : "Aucun";
      return interaction.reply({ embeds: [
        new EmbedBuilder().setColor(BLACK)
          .setTitle(`⚙️ Permissions — ${extraLabel || permKey}`)
          .addFields(
            { name: "Rôles autorisés", value: roles },
            { name: "Utilisateurs",    value: users },
          )
      ], ephemeral: true });
    }
    if (action === "add") {
      if (!role && !user) return reply(RED, "Précise un `role` ou un `utilisateur`.", [], true);
      if (role && !perm.roles.includes(role.id)) perm.roles.push(role.id);
      if (user && !perm.users.includes(user.id))  perm.users.push(user.id);
      const added = [role && `<@&${role.id}>`, user && `<@${user.id}>`].filter(Boolean).join(", ");
      return reply(BLACK, `✓ ${added} peut maintenant utiliser \`${permKey}\`.`);
    }
    if (action === "remove") {
      if (!role && !user) return reply(RED, "Précise un `role` ou un `utilisateur`.", [], true);
      if (role) perm.roles = perm.roles.filter(id => id !== role.id);
      if (user) perm.users = perm.users.filter(id => id !== user.id);
      const removed = [role && `<@&${role.id}>`, user && `<@${user.id}>`].filter(Boolean).join(", ");
      return reply(DARK, `✓ ${removed} retiré de la permission \`${permKey}\`.`);
    }
    return reply(RED, "Action inconnue.", [], true);
  }

  // ════════════════════════════════════════════
  //  /settingbl
  // ════════════════════════════════════════════
  if (commandName === "settingbl") {
    if (!isSystemPlus(member.id)) return reply(RED, "❌ Réservé aux **System+**.", [], true);
    const action = interaction.options.getString("action");
    if (action === "setlimit") {
      const limite = interaction.options.getInteger("limite");
      if (!limite) return reply(RED, "❌ Fournis une limite.", [], true);
      CONFIG.RATE_LIMITS.bl.max = limite;
      return reply(DARK, `✓ Limite BL définie à **${limite}** par 30 minutes.`);
    }
    return handleSettingCmd("bl", interaction, "Catégorie BL");
  }

  // ════════════════════════════════════════════
  //  /settingban
  // ════════════════════════════════════════════
  if (commandName === "settingban") {
    if (!isSystemPlus(member.id)) return reply(RED, "❌ Réservé aux **System+**.", [], true);
    const action = interaction.options.getString("action");
    if (action === "setlimit") {
      const limite = interaction.options.getInteger("limite");
      if (!limite) return reply(RED, "❌ Fournis une limite.", [], true);
      CONFIG.RATE_LIMITS.ban.max = limite;
      return reply(DARK, `✓ Limite BAN définie à **${limite}** par 15 minutes.`);
    }
    return handleSettingCmd("ban", interaction, "Catégorie BAN");
  }

  // ════════════════════════════════════════════
  //  /settingderank
  // ════════════════════════════════════════════
  if (commandName === "settingderank") {
    if (!isSystemPlus(member.id)) return reply(RED, "❌ Réservé aux **System+**.", [], true);
    const action = interaction.options.getString("action");
    const role   = interaction.options.getRole("role");
    const user   = interaction.options.getUser("utilisateur");

    if (action === "add_no_reason") {
      const p = CONFIG.PERMS.derank_no_reason;
      if (role && !p.roles.includes(role.id)) p.roles.push(role.id);
      if (user && !p.users.includes(user.id))  p.users.push(user.id);
      return reply(DARK, `✓ Autorisation de derank sans raison ajoutée.`);
    }
    if (action === "rem_no_reason") {
      const p = CONFIG.PERMS.derank_no_reason;
      if (role) p.roles = p.roles.filter(id => id !== role.id);
      if (user) p.users = p.users.filter(id => id !== user.id);
      return reply(DARK, `✓ Autorisation de derank sans raison retirée.`);
    }
    return handleSettingCmd("derank", interaction, "Catégorie DERANK");
  }

  // ════════════════════════════════════════════
  //  /settingwakeup
  // ════════════════════════════════════════════
  if (commandName === "settingwakeup") {
    return handleSettingCmd("wakeup", interaction, "Catégorie WAKEUP");
  }

  // ════════════════════════════════════════════
  //  /settingdogs
  // ════════════════════════════════════════════
  if (commandName === "settingdogs") {
    if (!isSystemPlus(member.id)) return reply(RED, "❌ Réservé aux **System+**.", [], true);
    const action = interaction.options.getString("action");
    if (action === "setlimit") {
      const limite = interaction.options.getInteger("limite");
      if (!limite) return reply(RED, "❌ Fournis une limite.", [], true);
      CONFIG.RATE_LIMITS.dog.limit = limite;
      return reply(DARK, `✓ Limite de laisses par maître définie à **${limite}**.`);
    }
    return handleSettingCmd("dog", interaction, "Catégorie DOG");
  }

  // ════════════════════════════════════════════
  //  /settingsaykokemanmanw
  // ════════════════════════════════════════════
  if (commandName === "settingsaykokemanmanw") {
    if (!isSystemPlus(member.id)) return reply(RED, "❌ Réservé aux **System+**.", [], true);
    return reply(DARK, `ℹ️ La commande \`/aykokemanmanw\` est **exclusivement réservée aux System+**. Aucune configuration supplémentaire n'est possible.`, [], true);
  }

  // ════════════════════════════════════════════
  //  /settingscouniamanmanw
  // ════════════════════════════════════════════
  if (commandName === "settingscouniamanmanw") {
    if (!isSystemPlus(member.id)) return reply(RED, "❌ Réservé aux **System+**.", [], true);
    const action = interaction.options.getString("action");
    if (action === "setlimit") {
      const limite = interaction.options.getInteger("limite");
      if (!limite) return reply(RED, "❌ Fournis une limite.", [], true);
      CONFIG.RATE_LIMITS.couniamanmanw.max = limite;
      return reply(DARK, `✓ Limite de /couniamanmanw définie à **${limite}**.`);
    }
    return handleSettingCmd("couniamanmanw", interaction, "Catégorie COUNIAMANMANW");
  }

  // ════════════════════════════════════════════
  //  /settingmenotte
  // ════════════════════════════════════════════
  if (commandName === "settingmenotte") {
    if (!isSystemPlus(member.id)) return reply(RED, "❌ Réservé aux **System+**.", [], true);
    const action = interaction.options.getString("action");
    if (action === "setlimit") {
      const limite = interaction.options.getInteger("limite");
      if (!limite) return reply(RED, "❌ Fournis une limite.", [], true);
      CONFIG.RATE_LIMITS.menotte.max = limite;
      return reply(DARK, `✓ Limite de +menotte définie à **${limite}** par heure.`);
    }
    return handleSettingCmd("menotte", interaction, "Catégorie MENOTTE");
  }

  // ════════════════════════════════════════════
  //  /settingviniw
  // ════════════════════════════════════════════
  if (commandName === "settingviniw") {
    if (!isSystemPlus(member.id)) return reply(RED, "❌ Réservé aux **System+**.", [], true);
    return reply(DARK, `ℹ️ La commande \`/viniw\` est **exclusivement réservée aux System+**. Aucune configuration supplémentaire n'est possible.`, [], true);
  }

  // ════════════════════════════════════════════
  //  /settingsystem
  // ════════════════════════════════════════════
  if (commandName === "settingsystem") {
    return handleSettingCmd("system", interaction, "Statut SYSTEM");
  }
});

// ─────────────────────────────────────────────
//  DÉTECTION BAN EXTERNE → DM victime
// ─────────────────────────────────────────────
client.on(Events.GuildBanAdd, async (ban) => {
  if (store.ourBans.has(ban.user.id)) {
    store.ourBans.delete(ban.user.id);
    return;
  }
  try {
    await new Promise(r => setTimeout(r, 1500));
    const logs  = await ban.guild.fetchAuditLogs({ limit: 1, type: 22 });
    const entry = logs.entries.first();
    if (!entry) return;
    if ((Date.now() - entry.createdTimestamp) >= 5000) return;
    if (entry.target.id !== ban.user.id) return;
    if (entry.executor.bot && entry.executor.id !== CONFIG.CLIENT_ID) {
      await ban.user.send({ embeds: [
        new EmbedBuilder().setColor(BLACK)
          .setDescription(`Vous avez été **banni** de **${CONFIG.SERVER_NAME}**.`)
          .setFooter({ text: `${CONFIG.SERVER_NAME} • discord.gg/maledike` })
      ]}).catch(() => {});
    }
  } catch {}
});

// ─────────────────────────────────────────────
//  DÉTECTION KICK EXTERNE → DM victime
// ─────────────────────────────────────────────
client.on(Events.GuildMemberRemove, async (member) => {
  if (store.blacklist.has(member.id))     return;
  if (store.aykokemanmanw.has(member.id)) return;
  if (store.ourKicks.has(member.id)) {
    store.ourKicks.delete(member.id);
    return;
  }
  try {
    await new Promise(r => setTimeout(r, 1500));
    const logs  = await member.guild.fetchAuditLogs({ limit: 1, type: 20 });
    const entry = logs.entries.first();
    if (!entry) return;
    if ((Date.now() - entry.createdTimestamp) >= 5000) return;
    if (entry.target.id !== member.id) return;
    if (entry.executor.bot && entry.executor.id !== CONFIG.CLIENT_ID) {
      await member.user.send({ embeds: [
        new EmbedBuilder().setColor(BLACK)
          .setDescription(`Vous avez été **blacklisté** de **${CONFIG.SERVER_NAME}**.`)
          .setFooter({ text: `${CONFIG.SERVER_NAME} • discord.gg/maledike` })
      ]}).catch(() => {});
    }
  } catch {}
});

// ─────────────────────────────────────────────
//  KEEP-ALIVE
// ─────────────────────────────────────────────
function startKeepAlive() {
  const app  = express();
  const PORT = process.env.PORT || 10000;
  app.get("/",     (_, res) => res.send("Maledike Bot en ligne."));
  app.get("/ping", (_, res) => res.json({ status: "ok", uptime: process.uptime() }));
  app.listen(PORT, () => console.log(`✅ Keep-alive actif sur le port ${PORT}`));
  setInterval(async () => {
    try { await fetch(`${CONFIG.RENDER_URL}/ping`); } catch {}
  }, 60_000);
}

// ─────────────────────────────────────────────
//  CONNEXION
// ─────────────────────────────────────────────
client.login(BOT_TOKEN).catch(err => {
  console.error("❌ Erreur de connexion:", err.message);
  process.exit(1);
});
