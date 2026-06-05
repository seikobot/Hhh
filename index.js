// ============================================================
//  MALEDIKE BOT — index.js
//  Tout se configure via les commandes Discord, aucun ID de rôle dans le code
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
if (!BOT_TOKEN) {
  console.error("TOKEN introuvable.");
  process.exit(1);
}

// ─────────────────────────────────────────────
//  CONFIGURATION — seuls les IDs du bot, tout le reste via Discord
// ─────────────────────────────────────────────
const CONFIG = {
  TOKEN:       BOT_TOKEN,
  CLIENT_ID:   "1512391751653130310",
  GUILD_ID:    "1511274220699783298",
  RENDER_URL:  "https://hhh-eyls.onrender.com",
  SERVER_NAME: "Maledike",

  // Owners originels — gérés via /ownerbot /unownerbot
  OWNER_IDS: ["685679698054742017", "465620464232955911"],

  // Règles de rang — configurées entièrement via /rankconfig sur Discord
  RANK_CONFIG: [],
};

// ─────────────────────────────────────────────
//  STOCKAGE EN MÉMOIRE
// ─────────────────────────────────────────────
const store = {
  blacklist: new Map(),
  bans:      new Map(),
};

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
const isOwner = (id)     => CONFIG.OWNER_IDS.includes(id);
const isAdmin = (member) => member.permissions.has(PermissionsBitField.Flags.Administrator);

async function sendDM(user, embed) {
  try { await user.send({ embeds: [embed] }); } catch {}
}

async function totalDerank(member) {
  try {
    const roles = member.roles.cache.filter(r => r.id !== member.guild.id && r.editable);
    await member.roles.remove(roles, "Derank total");
  } catch {}
}

function getRankRule(roleId) {
  return CONFIG.RANK_CONFIG.find(r => r.rankRole === roleId) || null;
}

function canRank(member, roleId) {
  if (isOwner(member.id) || isAdmin(member)) return true;
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
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User],
});

// ─────────────────────────────────────────────
//  SLASH COMMANDS — DÉFINITION
// ─────────────────────────────────────────────
const slashCommands = [

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Affiche toutes les commandes disponibles"),

  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("Attribue un rôle à un membre")
    .addUserOption(o => o.setName("membre").setDescription("Membre à rank").setRequired(true))
    .addRoleOption(o => o.setName("role").setDescription("Rôle à attribuer").setRequired(true)),

  new SlashCommandBuilder()
    .setName("derank")
    .setDescription("Retire tous les rôles d'un membre")
    .addUserOption(o => o.setName("membre").setDescription("Membre à derank").setRequired(true))
    .addStringOption(o => o.setName("raison").setDescription("Raison du derank").setRequired(true)),

  new SlashCommandBuilder()
    .setName("rankconfig")
    .setDescription("Configure les règles de rang depuis Discord (Admin/Owner)")
    .addStringOption(o =>
      o.setName("action").setDescription("Action").setRequired(true)
        .addChoices(
          { name: "Ajouter une règle",              value: "add" },
          { name: "Supprimer une règle",            value: "remove" },
          { name: "Voir toutes les règles",         value: "show" },
          { name: "Définir rôles autorisés à rank", value: "setallowed" },
          { name: "Définir rôle plafond max",       value: "setceiling" },
          { name: "Lier rôles auto au rank",        value: "linkroles" },
        )
    )
    .addRoleOption(o => o.setName("role").setDescription("Rôle principal").setRequired(false))
    .addRoleOption(o => o.setName("role2").setDescription("Rôle secondaire (plafond ou lié)").setRequired(false))
    .addRoleOption(o => o.setName("role3").setDescription("Rôle lié supplémentaire").setRequired(false))
    .addRoleOption(o => o.setName("role4").setDescription("Rôle lié supplémentaire").setRequired(false))
    .addRoleOption(o => o.setName("roleautorise").setDescription("Rôle autorisé à donner ce rang").setRequired(false)),

  new SlashCommandBuilder()
    .setName("ownerbot")
    .setDescription("Ajouter un Owner Bot")
    .addUserOption(o => o.setName("membre").setDescription("Membre à promouvoir").setRequired(true)),

  new SlashCommandBuilder()
    .setName("unownerbot")
    .setDescription("Retirer un Owner Bot")
    .addUserOption(o => o.setName("membre").setDescription("Membre à rétrograder").setRequired(true)),

  new SlashCommandBuilder()
    .setName("ownerbotlist")
    .setDescription("Liste des Owners Bot"),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Bannir un membre")
    .addUserOption(o => o.setName("membre").setDescription("Membre à bannir").setRequired(true))
    .addStringOption(o => o.setName("raison").setDescription("Raison").setRequired(false)),

  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Débannir un utilisateur par ID")
    .addStringOption(o => o.setName("id").setDescription("ID de l'utilisateur").setRequired(true)),

  new SlashCommandBuilder()
    .setName("baninfo")
    .setDescription("Informations sur un ban")
    .addStringOption(o => o.setName("id").setDescription("ID de l'utilisateur").setRequired(true)),

  new SlashCommandBuilder()
    .setName("bl")
    .setDescription("Blacklister un utilisateur")
    .addUserOption(o => o.setName("membre").setDescription("Membre à blacklister").setRequired(true))
    .addStringOption(o => o.setName("raison").setDescription("Raison").setRequired(true)),

  new SlashCommandBuilder()
    .setName("unbl")
    .setDescription("Retirer la blacklist d'un utilisateur")
    .addStringOption(o => o.setName("id").setDescription("ID de l'utilisateur").setRequired(true)),

  new SlashCommandBuilder()
    .setName("blist")
    .setDescription("Liste des utilisateurs blacklistés"),

  new SlashCommandBuilder()
    .setName("blinfo")
    .setDescription("Informations sur une blacklist")
    .addStringOption(o => o.setName("id").setDescription("ID de l'utilisateur").setRequired(true)),

].map(c => c.toJSON());

// ─────────────────────────────────────────────
//  READY — déploiement auto + statut
// ─────────────────────────────────────────────
const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

client.once("ready", async () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);

  // Déploiement des commandes sur le serveur (instantané)
  try {
    await rest.put(
      Routes.applicationGuildCommands(CONFIG.CLIENT_ID, CONFIG.GUILD_ID),
      { body: slashCommands }
    );
    console.log("✅ Commandes slash déployées sur le serveur Maledike.");
  } catch (err) {
    console.error("❌ Erreur déploiement commandes:", err.message);
  }

  // Statut "Joue à discord.gg/maledike"
  client.user.setPresence({
    activities: [{ name: "discord.gg/maledike", type: ActivityType.Playing }],
    status: "online",
  });

  startKeepAlive();
});

// ─────────────────────────────────────────────
//  GUILD MEMBER ADD — Blacklist check
// ─────────────────────────────────────────────
client.on(Events.GuildMemberAdd, async (member) => {
  const bl = store.blacklist.get(member.id);
  if (!bl) return;
  await sendDM(member.user, new EmbedBuilder()
    .setColor(0xcc0000)
    .setDescription(`Vous avez été blacklisté de **${CONFIG.SERVER_NAME}**.\nRaison : ${bl.reason}`)
  );
  try { await member.kick(`[Blacklist] ${bl.reason}`); } catch {}
});

// ─────────────────────────────────────────────
//  SLASH COMMAND HANDLER
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
  //  /help
  // ════════════════════════════════════════════
  if (commandName === "help") {
    const e = new EmbedBuilder()
      .setColor(0x1a1a1a)
      .setTitle("╸ Commandes Maledike")
      .setDescription("discord.gg/maledike")
      .addFields(
        {
          name: "🎖️ Rangs",
          value: [
            "`/rank` `membre` `role` — Attribue un rôle",
            "`/derank` `membre` `raison` — Retire tous les rôles",
            "`/rankconfig` — Configure les règles de rang *(Admin)*",
          ].join("\n"),
        },
        {
          name: "🔨 Modération",
          value: [
            "`/ban` `membre` `[raison]` — Bannir",
            "`/unban` `id` — Débannir",
            "`/baninfo` `id` — Infos ban",
            "`/bl` `membre` `raison` — Blacklister",
            "`/unbl` `id` — Retirer blacklist",
            "`/blist` — Liste blacklistés",
            "`/blinfo` `id` — Infos blacklist",
          ].join("\n"),
        },
        {
          name: "👑 Owner Bot",
          value: [
            "`/ownerbot` `membre` — Ajouter Owner",
            "`/unownerbot` `membre` — Retirer Owner",
            "`/ownerbotlist` — Liste Owners",
          ].join("\n"),
        },
      )
      .setFooter({ text: "Maledike • discord.gg/maledike" });
    return interaction.reply({ embeds: [e] });
  }

  // ════════════════════════════════════════════
  //  /rank
  // ════════════════════════════════════════════
  if (commandName === "rank") {
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
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2b2d31).setDescription(`✗ Vous ne pouvez pas attribuer **${role}**.`)] });

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
            { name: "Rôles actuels",  value: rolesAfter },
            { name: "Par",            value: `<@${member.id}>`, inline: true },
            { name: "Rôle attribué",  value: `<@&${role.id}>`,  inline: true },
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
    const targetUser   = interaction.options.getUser("membre");
    const raison       = interaction.options.getString("raison");
    const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);

    if (isOwner(targetUser.id))
      return reply(0xcc0000, "Vous ne pouvez pas derank un Owner Bot.", [], true);
    if (!targetMember)
      return reply(0xcc0000, "Ce membre n'est pas sur le serveur.", [], true);
    if (!isOwner(member.id) && !isAdmin(member))
      return reply(0xcc0000, "Vous n'avez pas la permission d'utiliser `/derank`.", [], true);

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
  //  /rankconfig — tout se passe sur Discord
  // ════════════════════════════════════════════
  if (commandName === "rankconfig") {
    if (!isOwner(member.id) && !isAdmin(member))
      return reply(0xcc0000, "Réservé aux administrateurs et Owners Bot.", [], true);

    const action       = interaction.options.getString("action");
    const role         = interaction.options.getRole("role");
    const role2        = interaction.options.getRole("role2");
    const role3        = interaction.options.getRole("role3");
    const role4        = interaction.options.getRole("role4");
    const roleAutorise = interaction.options.getRole("roleautorise");

    if (action === "show") {
      if (CONFIG.RANK_CONFIG.length === 0)
        return reply(0x1a1a1a, "Aucune règle configurée. Utilise `/rankconfig add` pour commencer.");
      const lines = CONFIG.RANK_CONFIG.map((r, i) => {
        const name    = guild.roles.cache.get(r.rankRole)?.name || r.rankRole;
        const ceiling = r.maxRole ? `<@&${r.maxRole}>` : "Aucun";
        const linked  = r.assignRoles.length ? r.assignRoles.map(id => `<@&${id}>`).join(", ") : "Aucun";
        const allowed = r.allowedRoles.length ? r.allowedRoles.map(id => `<@&${id}>`).join(", ") : "Tous";
        return `**${i + 1}. ${name}**\n→ Plafond : ${ceiling} | Liés : ${linked} | Autorisés : ${allowed}`;
      });
      return interaction.reply({ embeds: [
        new EmbedBuilder().setColor(0x1a1a1a)
          .setTitle("📋 Règles de rang")
          .setDescription(lines.join("\n\n"))
      ], ephemeral: true });
    }

    if (action === "add") {
      if (!role) return reply(0xcc0000, "Sélectionne le rôle avec l'option `role`.", [], true);
      if (CONFIG.RANK_CONFIG.find(r => r.rankRole === role.id))
        return reply(0xcc0000, `Une règle existe déjà pour **${role.name}**.`, [], true);
      CONFIG.RANK_CONFIG.push({ rankRole: role.id, assignRoles: [], maxRole: null, allowedRoles: [] });
      return reply(0x1a1a1a,
        `✓ Règle créée pour **${role.name}**.\n` +
        `Utilise \`/rankconfig setceiling\`, \`linkroles\` et \`setallowed\` pour la configurer.`
      );
    }

    if (action === "remove") {
      if (!role) return reply(0xcc0000, "Sélectionne le rôle avec `role`.", [], true);
      const idx = CONFIG.RANK_CONFIG.findIndex(r => r.rankRole === role.id);
      if (idx === -1) return reply(0xcc0000, `Aucune règle pour **${role.name}**.`, [], true);
      CONFIG.RANK_CONFIG.splice(idx, 1);
      return reply(0x1a1a1a, `✓ Règle supprimée pour **${role.name}**.`);
    }

    if (action === "setceiling") {
      if (!role || !role2) return reply(0xcc0000, "`role` = le rang concerné — `role2` = le plafond maximum.", [], true);
      let rule = CONFIG.RANK_CONFIG.find(r => r.rankRole === role.id);
      if (!rule) { rule = { rankRole: role.id, assignRoles: [], maxRole: null, allowedRoles: [] }; CONFIG.RANK_CONFIG.push(rule); }
      rule.maxRole = role2.id;
      return reply(0x1a1a1a, `✓ Plafond défini : **${role.name}** ne peut pas dépasser **${role2.name}**.`);
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
      if (!role || !roleAutorise) return reply(0xcc0000, "`role` = le rang — `roleautorise` = le rôle qui peut le donner.", [], true);
      let rule = CONFIG.RANK_CONFIG.find(r => r.rankRole === role.id);
      if (!rule) { rule = { rankRole: role.id, assignRoles: [], maxRole: null, allowedRoles: [] }; CONFIG.RANK_CONFIG.push(rule); }
      if (!rule.allowedRoles.includes(roleAutorise.id)) rule.allowedRoles.push(roleAutorise.id);
      return reply(0x1a1a1a, `✓ **${roleAutorise.name}** peut maintenant rank **${role.name}**.`);
    }

    return reply(0xcc0000, "Action inconnue.", [], true);
  }

  // ════════════════════════════════════════════
  //  OWNER BOT
  // ════════════════════════════════════════════
  if (commandName === "ownerbot") {
    if (!isOwner(member.id)) return reply(0xcc0000, "Réservé aux Owners Bot.", [], true);
    const target = interaction.options.getUser("membre");
    if (isOwner(target.id)) return reply(0xcc0000, "Cet utilisateur est déjà Owner Bot.", [], true);
    CONFIG.OWNER_IDS.push(target.id);
    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0xcc0000)
        .setDescription(`**${target.tag}** est maintenant Owner Bot.`)
        .addFields({ name: "Ajouté par", value: `<@${member.id}>`, inline: true })
    ]});
  }

  if (commandName === "unownerbot") {
    if (!isOwner(member.id)) return reply(0xcc0000, "Réservé aux Owners Bot.", [], true);
    const target    = interaction.options.getUser("membre");
    const HARDCODED = ["685679698054742017", "465620464232955911"];
    if (HARDCODED.includes(target.id)) return reply(0xcc0000, "Impossible de retirer un Owner originel.", [], true);
    const idx = CONFIG.OWNER_IDS.indexOf(target.id);
    if (idx === -1) return reply(0xcc0000, "Cet utilisateur n'est pas Owner Bot.", [], true);
    CONFIG.OWNER_IDS.splice(idx, 1);
    return reply(0x1a1a1a, `✓ **${target.tag}** n'est plus Owner Bot.`);
  }

  if (commandName === "ownerbotlist") {
    if (!isOwner(member.id)) return reply(0xcc0000, "Réservé aux Owners Bot.", [], true);
    const HARDCODED = ["685679698054742017", "465620464232955911"];
    const lines = [];
    for (const id of CONFIG.OWNER_IDS) {
      const u = await client.users.fetch(id).catch(() => null);
      lines.push(`${u ? `**${u.tag}**` : `\`${id}\``} ${HARDCODED.includes(id) ? "*(originel)*" : ""}`);
    }
    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0xcc0000).setTitle("👑 Owners Bot").setDescription(lines.join("\n") || "Aucun.")
    ], ephemeral: true });
  }

  // ════════════════════════════════════════════
  //  BAN / UNBAN / BANINFO
  // ════════════════════════════════════════════
  if (commandName === "ban") {
    if (!isOwner(member.id) && !isAdmin(member)) return reply(0xcc0000, "Permission refusée.", [], true);
    const target = interaction.options.getUser("membre");
    const raison = interaction.options.getString("raison") || "Aucune raison fournie";
    if (isOwner(target.id)) return reply(0xcc0000, "Vous ne pouvez pas bannir un Owner Bot.", [], true);
    try {
      await guild.bans.create(target.id, { reason: raison, deleteMessageSeconds: 604800 });
      store.bans.set(target.id, { reason: raison, modId: member.id, date: new Date().toISOString() });
      return interaction.reply({ embeds: [
        new EmbedBuilder().setColor(0xcc0000)
          .setDescription(`✓ **${target.tag}** a été banni.`)
          .addFields(
            { name: "Par",    value: `<@${member.id}>`, inline: true },
            { name: "Raison", value: raison,             inline: true },
          )
      ]});
    } catch (err) {
      return reply(0xcc0000, `Erreur : \`${err.message}\``, [], true);
    }
  }

  if (commandName === "unban") {
    if (!isOwner(member.id) && !isAdmin(member)) return reply(0xcc0000, "Permission refusée.", [], true);
    const id = interaction.options.getString("id");
    try {
      await guild.bans.remove(id);
      store.bans.delete(id);
      return reply(0x1a1a1a, `✓ L'utilisateur \`${id}\` a été débanni.`);
    } catch (err) {
      return reply(0xcc0000, `Erreur : \`${err.message}\``, [], true);
    }
  }

  if (commandName === "baninfo") {
    if (!isOwner(member.id) && !isAdmin(member)) return reply(0xcc0000, "Permission refusée.", [], true);
    const id      = interaction.options.getString("id");
    const banData = store.bans.get(id);
    let guildBan  = null;
    try { guildBan = await guild.bans.fetch(id); } catch {}
    if (!banData && !guildBan) return reply(0x1a1a1a, "Cet utilisateur n'est pas banni.");
    const u   = await client.users.fetch(id).catch(() => null);
    const mod = banData?.modId ? (await client.users.fetch(banData.modId).catch(() => null))?.tag || "Introuvable" : "Introuvable";
    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0xcc0000).setTitle("Informations du ban")
        .addFields(
          { name: "Cible",      value: u ? `${u.tag} (${id})` : id, inline: true },
          { name: "Modérateur", value: mod,                           inline: true },
          { name: "Raison",     value: banData?.reason || guildBan?.reason || "Inconnue" },
          { name: "Date",       value: banData?.date ? `<t:${Math.floor(new Date(banData.date).getTime() / 1000)}:F>` : "Inconnue" },
        )
    ], ephemeral: true });
  }

  // ════════════════════════════════════════════
  //  BLACKLIST
  // ════════════════════════════════════════════
  if (commandName === "bl") {
    if (!isOwner(member.id) && !isAdmin(member)) return reply(0xcc0000, "Permission refusée.", [], true);
    const target = interaction.options.getUser("membre");
    const raison = interaction.options.getString("raison");
    if (isOwner(target.id)) return reply(0xcc0000, "Vous ne pouvez pas blacklister un Owner Bot.", [], true);
    store.blacklist.set(target.id, { reason: raison, modId: member.id, date: new Date().toISOString() });
    const targetMember = await guild.members.fetch(target.id).catch(() => null);
    if (targetMember) {
      await sendDM(target, new EmbedBuilder().setColor(0xcc0000)
        .setDescription(`Vous avez été blacklisté de **${CONFIG.SERVER_NAME}**.\nRaison : ${raison}`)
      );
      try { await targetMember.kick(`[Blacklist] ${raison}`); } catch {}
    }
    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0xcc0000)
        .setDescription(`✓ **${target.tag}** a été blacklisté.`)
        .addFields(
          { name: "Par",    value: `<@${member.id}>`, inline: true },
          { name: "Raison", value: raison,             inline: true },
        )
    ]});
  }

  if (commandName === "unbl") {
    if (!isOwner(member.id) && !isAdmin(member)) return reply(0xcc0000, "Permission refusée.", [], true);
    const id = interaction.options.getString("id");
    if (!store.blacklist.has(id)) return reply(0x1a1a1a, "Cet utilisateur n'est pas blacklisté.");
    store.blacklist.delete(id);
    return reply(0x1a1a1a, `✓ \`${id}\` retiré de la blacklist.`);
  }

  if (commandName === "blist") {
    if (!isOwner(member.id) && !isAdmin(member)) return reply(0xcc0000, "Permission refusée.", [], true);
    if (!store.blacklist.size) return reply(0x1a1a1a, "Aucun utilisateur blacklisté.");
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

  if (commandName === "blinfo") {
    if (!isOwner(member.id) && !isAdmin(member)) return reply(0xcc0000, "Permission refusée.", [], true);
    const id     = interaction.options.getString("id");
    const blData = store.blacklist.get(id);
    if (!blData) return reply(0x1a1a1a, "Cet utilisateur n'est pas blacklisté.");
    const u   = await client.users.fetch(id).catch(() => null);
    const mod = blData.modId ? (await client.users.fetch(blData.modId).catch(() => null))?.tag || "Introuvable" : "Introuvable";
    return interaction.reply({ embeds: [
      new EmbedBuilder().setColor(0xcc0000).setTitle("Informations blacklist")
        .addFields(
          { name: "Cible",      value: u ? `${u.tag} (${id})` : id, inline: true },
          { name: "Modérateur", value: mod,                           inline: true },
          { name: "Raison",     value: blData.reason },
          { name: "Date",       value: `<t:${Math.floor(new Date(blData.date).getTime() / 1000)}:F>` },
        )
    ], ephemeral: true });
  }
});

// ─────────────────────────────────────────────
//  KEEP-ALIVE
// ─────────────────────────────────────────────
function startKeepAlive() {
  const app = express();
  app.get("/",     (_, res) => res.send("Bot en ligne."));
  app.get("/ping", (_, res) => res.json({ status: "ok", uptime: process.uptime() }));
  const PORT = process.env.PORT || 10000;
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
