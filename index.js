// ============================================================
//  MALEDIKE BOT — index.js
//  100% préfixe "?"  |  Owner Bot  |  Protection totale
// ============================================================

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionsBitField,
  Events,
} = require("discord.js");
const express = require("express");
const fetch   = require("node-fetch");
const fs      = require("fs");

// ─────────────────────────────────────────────
//  TOKEN — Secret File Render ou variable d'env
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
  console.error("TOKEN introuvable. Ajoutez un Secret File TOKEN sur Render.");
  process.exit(1);
}

// ─────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────
const CONFIG = {
  TOKEN:      BOT_TOKEN,
  RENDER_URL: "https://hhh-eyls.onrender.com",

  // Owners — immunité totale, accès à tout
  OWNER_IDS: ["685679698054742017", "465620464232955911"],

  // Rôles VIP (derank sans raison)
  VIP_ROLES: [],

  // Plafonds rank : { idRoleQuiRank: idRolePlafond }
  RANK_CEILINGS: {},

  // Rôles qu'on ne peut pas attribuer sans permission spéciale
  PROTECTED_ROLES: [],

  // Limites anti-abus : { idRole: { action: { max, window } } }
  ROLE_ACTION_LIMITS: {},

  // Whitelist par commande : { commande: { roles: [], users: [] } }
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

  COLORS: {
    success: 0x2ecc71,
    error:   0xcc0000,
    info:    0x2c2c2c,
    warn:    0xf39c12,
    rank:    0xcc0000,
    derank:  0xcc0000,
    ban:     0xcc0000,
    bl:      0xcc0000,
    owner:   0xcc0000,
  },

  SERVER_NAME: "Maledike",
};

// ─────────────────────────────────────────────
//  STOCKAGE EN MÉMOIRE
// ─────────────────────────────────────────────
const store = {
  blacklist:       new Map(),
  bans:            new Map(),
  actionLogs:      new Map(),
  persistWarnings: new Map(),
  sniped:          new Map(), // { channelId: { content, author, time } }
};

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────

function isOwner(userId) {
  return CONFIG.OWNER_IDS.includes(userId);
}

function embed(color, title, description, fields = []) {
  const e = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
  if (fields.length) e.addFields(fields);
  return e;
}

function hasPermission(member, command) {
  // Owners Bot et admins → accès total
  if (isOwner(member.id)) return true;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  const wl = CONFIG.COMMAND_WHITELIST[command];
  // Pas de whitelist OU whitelist vide → accès libre par défaut
  if (!wl || (wl.roles.length === 0 && wl.users.length === 0)) return true;
  // Whitelist remplie → vérifier strictement
  if (wl.users.includes(member.id)) return true;
  if (member.roles.cache.some((r) => wl.roles.includes(r.id))) return true;
  return false;
}

function logAction(userId, action) {
  if (!store.actionLogs.has(userId)) store.actionLogs.set(userId, {});
  const logs = store.actionLogs.get(userId);
  if (!logs[action]) logs[action] = [];
  logs[action].push(Date.now());
}

function isLimitExceeded(member, action) {
  if (isOwner(member.id)) return false;
  for (const [roleId, limits] of Object.entries(CONFIG.ROLE_ACTION_LIMITS)) {
    if (!member.roles.cache.has(roleId)) continue;
    const limit = limits[action];
    if (!limit) continue;
    const logs = store.actionLogs.get(member.id)?.[action] || [];
    const recent = logs.filter((t) => t > Date.now() - limit.window * 1000);
    if (recent.length >= limit.max) return true;
  }
  return false;
}

async function totalDerank(member, reason = "Anti-abus automatique") {
  try {
    const roles = member.roles.cache.filter((r) => r.id !== member.guild.id && r.editable);
    await member.roles.remove(roles, reason);
    return true;
  } catch { return false; }
}

async function sendDM(user, content) {
  try { await user.send(content); } catch {}
}

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
//  READY
// ─────────────────────────────────────────────
client.once("ready", () => {
  console.log(`Bot connecté : ${client.user.tag}`);
  startKeepAlive();
});

// ─────────────────────────────────────────────
//  SNIPE — capture des messages supprimés
// ─────────────────────────────────────────────
client.on(Events.MessageDelete, (message) => {
  if (!message.guild || message.author?.bot) return;
  store.sniped.set(message.channelId, {
    content: message.content || "(contenu vide ou média)",
    author:  message.author?.tag || "Inconnu",
    time:    new Date(),
  });
});

// ─────────────────────────────────────────────
//  GUILD MEMBER ADD — Blacklist check
// ─────────────────────────────────────────────
client.on(Events.GuildMemberAdd, async (member) => {
  const bl = store.blacklist.get(member.id);
  if (!bl) return;
  await sendDM(member.user, `Vous avez été blacklisté de ${CONFIG.SERVER_NAME}.\nRaison : ${bl.reason}`);
  try { await member.kick(`[Blacklist] ${bl.reason}`); } catch {}
});

// ─────────────────────────────────────────────
//  PREFIX COMMAND HANDLER — préfixe "?"
// ─────────────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  const content = message.content.trim();
  if (!content.startsWith("?")) return;

  const args    = content.slice(1).trim().split(/\s+/);
  const command = args.shift().toLowerCase();
  const guild   = message.guild;
  const member  = message.member;

  // ── Protection Owner : aucune commande sur un Owner ──
  const potentialTargetId = args[0]?.replace(/[<@!>]/g, "");
  const sensitiveCommands = ["ban", "unban", "bl", "unbl", "blinfo", "baninfo", "rank", "derank"];
  if (potentialTargetId && isOwner(potentialTargetId) && sensitiveCommands.includes(command)) {
    return message.reply({
      embeds: [embed(CONFIG.COLORS.error, "Action impossible", "Vous ne pouvez pas utiliser une commande sur un Owner Bot.")],
    });
  }

  // ════════════════════════════════════════════
  //  ?help — owners uniquement
  // ════════════════════════════════════════════
  if (command === "help") {
    if (!isOwner(member.id)) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(0x0d0d0d).setDescription("Accès refusé.")] });
    }
    const sep = "▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬";
    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xcc0000)
          .setTitle("Maledike UHQ")
          .setDescription(`Préfixe **\`?\`**  —  Accès conditionné par whitelist ou grade admin\n${sep}`)
          .addFields(
            {
              name: "Rang",
              value: [
                "`?rank @user @role` → Attribuer un rôle (respect du plafond)",
                "`?derank @user @role [raison]` → Retirer un rôle",
              ].join("\n"),
            },
            { name: "\u200b", value: sep },
            {
              name: "Moderation",
              value: [
                "`?ban @user [raison]` → Bannir",
                "`?unban @user` → Débannir",
                "`?baninfo @user` → Infos sur un ban",
              ].join("\n"),
            },
            { name: "\u200b", value: sep },
            {
              name: "Blacklist",
              value: [
                "`?bl @user [raison]` → Blacklister",
                "`?unbl @user` → Retirer la blacklist",
                "`?blist` → Liste des blacklistés",
                "`?blinfo @user` → Infos blacklist",
              ].join("\n"),
            },
            { name: "\u200b", value: sep },
            {
              name: "Configuration",
              value: [
                "`?config show` → Voir la config actuelle",
                "`?config whitelist add <commande> @role` → Autoriser un rôle",
                "`?config whitelist remove <commande> @role` → Retirer un rôle",
                "`?config protected add @role` → Protéger un rôle",
                "`?config protected remove @role` → Déprotéger un rôle",
                "`?config ceiling @roleRanker @rolePlafond` → Définir un plafond",
                "`?config vip @role` → Rôle VIP (derank sans raison)",
              ].join("\n"),
            },
            { name: "\u200b", value: sep },
            {
              name: "Owner Bot",
              value: [
                "`?ownerbot @user` → Ajouter un Owner Bot",
                "`?unownerbot @user` → Retirer un Owner Bot",
                "`?ownerbotlist` → Liste des Owners Bot",
              ].join("\n"),
            },
          )
          .setFooter({ text: "Maledike UHQ  —  usage interne uniquement" })
          .setTimestamp(),
      ],
    });
  }

  // ════════════════════════════════════════════
  //  OWNER BOT
  // ════════════════════════════════════════════

  if (command === "ownerbot") {
    if (!isOwner(member.id)) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Accès refusé", "Commande réservée aux Owners Bot.")] });
    const targetId = args[0]?.replace(/[<@!>]/g, "");
    if (!targetId) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Usage", "`?ownerbot @user/ID`")] });
    if (CONFIG.OWNER_IDS.includes(targetId)) return message.reply({ embeds: [embed(CONFIG.COLORS.warn, "Déjà Owner", "Cet utilisateur est déjà Owner Bot.")] });
    CONFIG.OWNER_IDS.push(targetId);
    const u = await client.users.fetch(targetId).catch(() => null);
    return message.reply({
      embeds: [embed(CONFIG.COLORS.owner, "Owner Bot ajouté", `${u ? `**${u.tag}**` : `\`${targetId}\``} est maintenant Owner Bot.`, [
        { name: "Ajouté par", value: `${member}`, inline: true },
      ])],
    });
  }

  if (command === "unownerbot") {
    if (!isOwner(member.id)) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Accès refusé", "Commande réservée aux Owners Bot.")] });
    const targetId = args[0]?.replace(/[<@!>]/g, "");
    if (!targetId) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Usage", "`?unownerbot @user/ID`")] });
    const HARDCODED = ["685679698054742017", "465620464232955911"];
    if (HARDCODED.includes(targetId)) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Protégé", "Impossible de retirer un Owner originel.")] });
    const idx = CONFIG.OWNER_IDS.indexOf(targetId);
    if (idx === -1) return message.reply({ embeds: [embed(CONFIG.COLORS.warn, "Introuvable", "Cet utilisateur n'est pas Owner Bot.")] });
    CONFIG.OWNER_IDS.splice(idx, 1);
    const u = await client.users.fetch(targetId).catch(() => null);
    return message.reply({ embeds: [embed(CONFIG.COLORS.success, "Owner Bot retiré", `${u ? `**${u.tag}**` : `\`${targetId}\``} n'est plus Owner Bot.`)] });
  }

  if (command === "ownerbotlist") {
    if (!isOwner(member.id)) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Accès refusé", "Commande réservée aux Owners Bot.")] });
    const HARDCODED = ["685679698054742017", "465620464232955911"];
    const lines = [];
    for (const id of CONFIG.OWNER_IDS) {
      const u = await client.users.fetch(id).catch(() => null);
      lines.push(`${u ? `**${u.tag}**` : `\`${id}\``}  \`${id}\`${HARDCODED.includes(id) ? "  [originel]" : ""}`);
    }
    return message.reply({
      embeds: [embed(CONFIG.COLORS.owner, `Owners Bot — ${CONFIG.OWNER_IDS.length}`, lines.join("\n") || "Aucun owner.")],
    });
  }

  // ════════════════════════════════════════════
  //  ?config — sous-commandes textuelles
  // ════════════════════════════════════════════
  if (command === "config") {
    if (!hasPermission(member, "config")) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Accès refusé", "Permission refusée.")] });

    const sub = args[0]?.toLowerCase();

    // ?config show
    if (sub === "show") {
      const desc = [
        `**Owners Bot :** ${CONFIG.OWNER_IDS.map((id) => `<@${id}>`).join(", ") || "Aucun"}`,
        `**Rôles VIP :** ${CONFIG.VIP_ROLES.map((id) => `<@&${id}>`).join(", ") || "Aucun"}`,
        `**Rôles protégés :** ${CONFIG.PROTECTED_ROLES.map((id) => `<@&${id}>`).join(", ") || "Aucun"}`,
        `**Plafonds rank :** ${Object.entries(CONFIG.RANK_CEILINGS).map(([k, v]) => `<@&${k}> → <@&${v}>`).join(", ") || "Aucun"}`,
        `\n**Whitelist par commande :**`,
        ...Object.entries(CONFIG.COMMAND_WHITELIST).map(([cmd, wl]) => {
          const roles = wl.roles.map((id) => `<@&${id}>`).join(", ") || "—";
          const users = wl.users.map((id) => `<@${id}>`).join(", ") || "—";
          return `\`?${cmd}\` → rôles : ${roles} | users : ${users}`;
        }),
      ].join("\n");
      return message.reply({ embeds: [embed(CONFIG.COLORS.info, "Configuration actuelle", desc)] });
    }

    // ?config whitelist add <commande> @role
    // ?config whitelist remove <commande> @role
    if (sub === "whitelist") {
      const action  = args[1]?.toLowerCase();
      const cmd     = args[2]?.toLowerCase();
      const roleId  = args[3]?.replace(/[<@&>]/g, "");
      if (!action || !cmd || !roleId) {
        return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Usage", "`?config whitelist add/remove <commande> @role`")] });
      }
      if (!CONFIG.COMMAND_WHITELIST[cmd]) CONFIG.COMMAND_WHITELIST[cmd] = { roles: [], users: [] };
      if (action === "add") {
        if (!CONFIG.COMMAND_WHITELIST[cmd].roles.includes(roleId)) CONFIG.COMMAND_WHITELIST[cmd].roles.push(roleId);
        return message.reply({ embeds: [embed(CONFIG.COLORS.success, "Whitelist mise à jour", `<@&${roleId}> peut utiliser \`?${cmd}\`.`)] });
      }
      if (action === "remove") {
        CONFIG.COMMAND_WHITELIST[cmd].roles = CONFIG.COMMAND_WHITELIST[cmd].roles.filter((id) => id !== roleId);
        return message.reply({ embeds: [embed(CONFIG.COLORS.success, "Whitelist mise à jour", `<@&${roleId}> ne peut plus utiliser \`?${cmd}\`.`)] });
      }
    }

    // ?config protected add/remove @role
    if (sub === "protected") {
      const action = args[1]?.toLowerCase();
      const roleId = args[2]?.replace(/[<@&>]/g, "");
      if (!action || !roleId) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Usage", "`?config protected add/remove @role`")] });
      if (action === "add") {
        if (!CONFIG.PROTECTED_ROLES.includes(roleId)) CONFIG.PROTECTED_ROLES.push(roleId);
        return message.reply({ embeds: [embed(CONFIG.COLORS.success, "Rôle protégé", `<@&${roleId}> est maintenant protégé.`)] });
      }
      if (action === "remove") {
        const i = CONFIG.PROTECTED_ROLES.indexOf(roleId);
        if (i > -1) CONFIG.PROTECTED_ROLES.splice(i, 1);
        return message.reply({ embeds: [embed(CONFIG.COLORS.success, "Protection retirée", `<@&${roleId}> n'est plus protégé.`)] });
      }
    }

    // ?config ceiling @roleRanker @rolePlafond
    if (sub === "ceiling") {
      const roleRankerId  = args[1]?.replace(/[<@&>]/g, "");
      const rolePlafondId = args[2]?.replace(/[<@&>]/g, "");
      if (!roleRankerId || !rolePlafondId) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Usage", "`?config ceiling @roleRanker @rolePlafond`")] });
      CONFIG.RANK_CEILINGS[roleRankerId] = rolePlafondId;
      return message.reply({ embeds: [embed(CONFIG.COLORS.success, "Plafond défini", `<@&${roleRankerId}> peut rank jusqu'au maximum <@&${rolePlafondId}>.`)] });
    }

    // ?config vip @role
    if (sub === "vip") {
      const roleId = args[1]?.replace(/[<@&>]/g, "");
      if (!roleId) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Usage", "`?config vip @role`")] });
      if (!CONFIG.VIP_ROLES.includes(roleId)) CONFIG.VIP_ROLES.push(roleId);
      return message.reply({ embeds: [embed(CONFIG.COLORS.success, "Rôle VIP ajouté", `<@&${roleId}> peut derank sans raison.`)] });
    }

    // Aide config si mal utilisée
    return message.reply({
      embeds: [embed(CONFIG.COLORS.info, "?config — sous-commandes", [
        "`?config show`",
        "`?config whitelist add/remove <commande> @role`",
        "`?config protected add/remove @role`",
        "`?config ceiling @roleRanker @rolePlafond`",
        "`?config vip @role`",
      ].join("\n"))],
    });
  }

  // ════════════════════════════════════════════
  //  RANG
  // ════════════════════════════════════════════

  // ?rank @user @role
  if (command === "rank") {
    if (!hasPermission(member, "rank")) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Accès refusé", "Permission refusée.")] });

    const targetId = args[0]?.replace(/[<@!>]/g, "");
    const roleId   = args[1]?.replace(/[<@&>]/g, "");
    if (!targetId || !roleId) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Usage", "`?rank @user @role`")] });

    const targetMember = await guild.members.fetch(targetId).catch(() => null);
    const role         = guild.roles.cache.get(roleId);

    if (!targetMember) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Introuvable", "Ce membre n'est pas sur le serveur.")] });
    if (!role)         return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Introuvable", "Ce rôle n'existe pas.")] });

    if (CONFIG.PROTECTED_ROLES.includes(roleId)) {
      const warns = (store.persistWarnings.get(member.id) || 0) + 1;
      store.persistWarnings.set(member.id, warns);
      if (warns >= 2) {
        await totalDerank(member, "Persistance sur rôle protégé");
        await sendDM(member.user, `Vous avez été derank totalement sur ${CONFIG.SERVER_NAME} pour avoir persisté à attribuer un rôle protégé.`);
        store.persistWarnings.delete(member.id);
        return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Derank automatique", `${member} a été derank totalement pour persistance.`)] });
      }
      return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Rôle protégé", `${member} vous n'avez pas l'autorisation d'attribuer ce rôle.`)] });
    }

    if (!rankAllowed(member, role)) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Plafond dépassé", "Vous ne pouvez pas attribuer un rôle supérieur à votre plafond.")] });
    if (isLimitExceeded(member, "rank")) {
      await totalDerank(member, "Dépassement limite rank");
      return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Limite dépassée", `${member} a dépassé la limite de ranks. Derank total appliqué.`)] });
    }
    logAction(member.id, "rank");

    try {
      await targetMember.roles.add(role, `Rank par ${member.user.tag}`);
      return message.reply({
        embeds: [embed(CONFIG.COLORS.rank, "Rôle attribué", `Le rôle ${role} a été attribué à ${targetMember}.`, [
          { name: "Exécuteur", value: `${member}`,       inline: true },
          { name: "Cible",     value: `${targetMember}`, inline: true },
          { name: "Rôle",      value: `${role}`,         inline: true },
        ])],
      });
    } catch (err) {
      return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Erreur", `\`${err.message}\``)] });
    }
  }

  // ?derank @user @role [raison]
  if (command === "derank") {
    if (!hasPermission(member, "derank")) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Accès refusé", "Permission refusée.")] });

    const targetId = args[0]?.replace(/[<@!>]/g, "");
    const roleId   = args[1]?.replace(/[<@&>]/g, "");
    const raison   = args.slice(2).join(" ") || null;

    if (!targetId) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Usage", "`?derank @user @role [raison]`")] });

    const targetMember = await guild.members.fetch(targetId).catch(() => null);
    if (!targetMember) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Introuvable", "Ce membre n'est pas sur le serveur.")] });

    const isVIP = member.roles.cache.some((r) => CONFIG.VIP_ROLES.includes(r.id));

    // VIP sans rôle précisé = derank total
    if (!roleId) {
      if (!isVIP) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Usage", "`?derank @user @role [raison]`")] });
      if (isLimitExceeded(member, "derank")) {
        await totalDerank(member, "Dépassement limite derank");
        return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Limite dépassée", `${member} a dépassé la limite. Derank total appliqué.`)] });
      }
      logAction(member.id, "derank");
      await totalDerank(targetMember, raison || "Derank total VIP");
      return message.reply({
        embeds: [embed(CONFIG.COLORS.derank, "Derank total", `${targetMember} a été derank totalement.`, [
          { name: "Exécuteur", value: `${member}`,       inline: true },
          { name: "Cible",     value: `${targetMember}`, inline: true },
        ])],
      });
    }

    const role = guild.roles.cache.get(roleId);
    if (!role) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Introuvable", "Ce rôle n'existe pas.")] });

    if (!isVIP && !raison) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Raison requise", "Vous devez fournir une raison pour effectuer un derank.")] });
    if (isLimitExceeded(member, "derank")) {
      await totalDerank(member, "Dépassement limite derank");
      return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Limite dépassée", `${member} a dépassé la limite. Derank total appliqué.`)] });
    }
    logAction(member.id, "derank");

    try {
      await targetMember.roles.remove(role, raison || "Derank VIP");
      return message.reply({
        embeds: [embed(CONFIG.COLORS.derank, "Rôle retiré", `Le rôle ${role} a été retiré à ${targetMember}.`, [
          { name: "Exécuteur", value: `${member}`,                  inline: true },
          { name: "Cible",     value: `${targetMember}`,            inline: true },
          { name: "Rôle",      value: `${role}`,                    inline: true },
          { name: "Raison",    value: raison || "Aucune (VIP)",      inline: false },
        ])],
      });
    } catch (err) {
      return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Erreur", `\`${err.message}\``)] });
    }
  }

  // ════════════════════════════════════════════
  //  MODERATION
  // ════════════════════════════════════════════

  if (command === "ban") {
    if (!hasPermission(member, "ban")) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Accès refusé", "Permission refusée.")] });
    const targetId = args[0]?.replace(/[<@!>]/g, "");
    const raison   = args.slice(1).join(" ") || "Aucune raison fournie";
    if (!targetId) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Usage", "`?ban @user/ID [raison]`")] });
    const targetUser = await client.users.fetch(targetId).catch(() => null);
    if (!targetUser) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Introuvable", "Impossible de trouver cet utilisateur.")] });
    try {
      await guild.bans.create(targetId, { reason: raison, deleteMessageSeconds: 604800 });
      store.bans.set(targetId, { reason: raison, modId: member.id, date: new Date().toISOString() });
      return message.reply({
        embeds: [embed(CONFIG.COLORS.ban, "Banni", `${targetUser.tag} a été banni du serveur.`, [
          { name: "Exécuteur", value: `${member}`,                       inline: true },
          { name: "Cible",     value: `${targetUser.tag} (${targetId})`, inline: true },
          { name: "Raison",    value: raison,                            inline: false },
        ])],
      });
    } catch (err) {
      return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Erreur", `\`${err.message}\``)] });
    }
  }

  if (command === "unban") {
    if (!hasPermission(member, "unban")) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Accès refusé", "Permission refusée.")] });
    const targetId = args[0]?.replace(/[<@!>]/g, "");
    if (!targetId) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Usage", "`?unban @user/ID`")] });
    try {
      await guild.bans.remove(targetId);
      store.bans.delete(targetId);
      return message.reply({ embeds: [embed(CONFIG.COLORS.success, "Débanni", `L'utilisateur \`${targetId}\` a été débanni.`)] });
    } catch (err) {
      return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Erreur", `\`${err.message}\``)] });
    }
  }

  if (command === "baninfo") {
    if (!hasPermission(member, "baninfo")) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Accès refusé", "Permission refusée.")] });
    const targetId = args[0]?.replace(/[<@!>]/g, "");
    if (!targetId) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Usage", "`?baninfo @user/ID`")] });
    const banData = store.bans.get(targetId);
    let guildBan  = null;
    try { guildBan = await guild.bans.fetch(targetId); } catch {}
    if (!banData && !guildBan) return message.reply({ embeds: [embed(CONFIG.COLORS.info, "Aucun ban", "Cet utilisateur n'est pas banni.")] });
    const targetUser = await client.users.fetch(targetId).catch(() => null);
    let modDisplay   = "🔴 Modérateur introuvable";
    if (banData?.modId) {
      const mod = await client.users.fetch(banData.modId).catch(() => null);
      modDisplay = mod ? `${mod.tag} (${mod.id})` : "🔴 Introuvable";
    }
    return message.reply({
      embeds: [embed(CONFIG.COLORS.ban, "Informations du ban", `Détails pour \`${targetUser?.tag || targetId}\``, [
        { name: "Cible",      value: targetUser ? `${targetUser.tag} (${targetId})` : targetId,                                          inline: true },
        { name: "Modérateur", value: modDisplay,                                                                                          inline: true },
        { name: "Raison",     value: banData?.reason || guildBan?.reason || "Inconnue",                                                   inline: false },
        { name: "Date",       value: banData?.date ? `<t:${Math.floor(new Date(banData.date).getTime() / 1000)}:F>` : "Inconnue",         inline: false },
      ])],
    });
  }

  // ════════════════════════════════════════════
  //  BLACKLIST
  // ════════════════════════════════════════════

  if (command === "bl") {
    if (!hasPermission(member, "bl")) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Accès refusé", "Permission refusée.")] });
    const targetId = args[0]?.replace(/[<@!>]/g, "");
    const raison   = args.slice(1).join(" ") || "Aucune raison fournie";
    if (!targetId) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Usage", "`?bl @user/ID [raison]`")] });
    const targetUser   = await client.users.fetch(targetId).catch(() => null);
    store.blacklist.set(targetId, { reason: raison, modId: member.id, date: new Date().toISOString() });
    const targetMember = await guild.members.fetch(targetId).catch(() => null);
    if (targetMember) {
      await sendDM(targetMember.user, `Vous avez été blacklisté de ${CONFIG.SERVER_NAME}.\nRaison : ${raison}`);
      try { await targetMember.kick(`[Blacklist] ${raison}`); } catch {}
    }
    return message.reply({
      embeds: [embed(CONFIG.COLORS.bl, "Blacklisté", `${targetUser?.tag || targetId} a été blacklisté.`, [
        { name: "Exécuteur", value: `${member}`,                                                       inline: true },
        { name: "Cible",     value: targetUser ? `${targetUser.tag} (${targetId})` : targetId,         inline: true },
        { name: "Raison",    value: raison,                                                             inline: false },
      ])],
    });
  }

  if (command === "unbl") {
    if (!hasPermission(member, "unbl")) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Accès refusé", "Permission refusée.")] });
    const targetId = args[0]?.replace(/[<@!>]/g, "");
    if (!targetId) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Usage", "`?unbl @user/ID`")] });
    if (!store.blacklist.has(targetId)) return message.reply({ embeds: [embed(CONFIG.COLORS.warn, "Introuvable", "Cet utilisateur n'est pas blacklisté.")] });
    store.blacklist.delete(targetId);
    return message.reply({ embeds: [embed(CONFIG.COLORS.success, "Blacklist retirée", `\`${targetId}\` a été retiré de la blacklist.`)] });
  }

  if (command === "blist") {
    if (!hasPermission(member, "blist")) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Accès refusé", "Permission refusée.")] });
    if (store.blacklist.size === 0) return message.reply({ embeds: [embed(CONFIG.COLORS.info, "Blacklist vide", "Aucun utilisateur blacklisté.")] });
    const entries = [];
    for (const [id, data] of store.blacklist.entries()) {
      const u = await client.users.fetch(id).catch(() => null);
      entries.push(`${u ? `**${u.tag}**` : `\`${id}\``}  —  ${data.reason}  (<t:${Math.floor(new Date(data.date).getTime() / 1000)}:d>)`);
    }
    const chunks = [];
    let cur = "";
    for (const line of entries) {
      if ((cur + "\n" + line).length > 1000) { chunks.push(cur); cur = line; }
      else cur += (cur ? "\n" : "") + line;
    }
    if (cur) chunks.push(cur);
    for (let i = 0; i < chunks.length; i++) {
      await message.reply({ embeds: [embed(CONFIG.COLORS.bl, `Blacklist (${store.blacklist.size})  ${i + 1}/${chunks.length}`, chunks[i])] });
    }
    return;
  }

  if (command === "blinfo") {
    if (!hasPermission(member, "blinfo")) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Accès refusé", "Permission refusée.")] });
    const targetId = args[0]?.replace(/[<@!>]/g, "");
    if (!targetId) return message.reply({ embeds: [embed(CONFIG.COLORS.error, "Usage", "`?blinfo @user/ID`")] });
    const blData = store.blacklist.get(targetId);
    if (!blData) return message.reply({ embeds: [embed(CONFIG.COLORS.info, "Non blacklisté", "Cet utilisateur n'est pas dans la blacklist.")] });
    const targetUser = await client.users.fetch(targetId).catch(() => null);
    let modDisplay   = "🔴 Modérateur introuvable";
    if (blData.modId) {
      const mod = await client.users.fetch(blData.modId).catch(() => null);
      modDisplay = mod ? `${mod.tag} (${mod.id})` : "🔴 Introuvable";
    }
    return message.reply({
      embeds: [embed(CONFIG.COLORS.bl, "Informations blacklist", `Détails pour \`${targetUser?.tag || targetId}\``, [
        { name: "Cible",      value: targetUser ? `${targetUser.tag} (${targetId})` : targetId,                                        inline: true },
        { name: "Modérateur", value: modDisplay,                                                                                        inline: true },
        { name: "Raison",     value: blData.reason,                                                                                     inline: false },
        { name: "Date",       value: `<t:${Math.floor(new Date(blData.date).getTime() / 1000)}:F>`,                                     inline: false },
      ])],
    });
  }
});

// ─────────────────────────────────────────────
//  KEEP-ALIVE
// ─────────────────────────────────────────────
function startKeepAlive() {
  const app = express();
  app.get("/",     (_req, res) => res.send("Bot en ligne."));
  app.get("/ping", (_req, res) => res.json({ status: "ok", uptime: process.uptime() }));
  const PORT = process.env.PORT || 10000;
  app.listen(PORT, () => console.log(`Keep-alive sur le port ${PORT}`));
  setInterval(async () => {
    try { await fetch(`${CONFIG.RENDER_URL}/ping`); } catch {}
  }, 60 * 1000);
}

// ─────────────────────────────────────────────
//  CONNEXION
// ─────────────────────────────────────────────
client.login(BOT_TOKEN).catch((err) => {
  console.error("Erreur de connexion Discord:", err.message);
  process.exit(1);
});
