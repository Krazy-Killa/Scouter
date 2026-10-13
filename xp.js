require("dotenv").config();

const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder } = require("discord.js");
const numeral = require("numeral");
const Database = require("better-sqlite3");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const {
    ACHIEVEMENTS,
    GOD_KI_AWAKENING_COOLDOWN_MS,
    MAX_STAMINA,
    RACES,
    RACE_LOCK_BASE_POWER,
    addExperience,
    canEarnMessageXp,
    changeRace,
    createDefaultUser,
    getGodTierLevel,
    getGodKiAwakeningChance,
    hasReachedGodTier,
    getKaiokenMultiplier,
    getProgressAchievementIds,
    getTransformationMultiplier,
    getXpRequiredForLevel,
    initializeUserProgress,
    isFormAvailableForRace,
    normalizeMessage,
    optInUser,
    optOutUser,
    recordMessageXp,
    recordTrainingDay,
    setBasePower,
    setKaiokenLevel,
    setUserLevel,
    setTransformation
} = require("./progression");
const { migrateLegacyEnmapData } = require("./enmap-migration");

// Local config.json is optional; environment variables take precedence.
let fileConfig = {};
try {
    fileConfig = require("./config.json");
} catch (error) {
    fileConfig = {};
}

const packageVersion = require("./package.json").version;
const COPYRIGHT_NOTICE = "© 2019-2026";
const legacyMessagePrefix = process.env.DISCORD_PREFIX || fileConfig.prefix || "!";

const config = {
    token: process.env.DISCORD_TOKEN || fileConfig.token,
    version: process.env.APP_VERSION || packageVersion,
    author: process.env.APP_AUTHOR || fileConfig.author || "Krazy-Killa",
    icon: process.env.APP_ICON || fileConfig.icon || "",
    minsize: Number(process.env.MIN_MSG_SIZE ?? fileConfig.minsize ?? 2)
};

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent
    ]
});

const TRANSFORM_CHOICES = [
    ["normal", "Normal"],
    ["beyondgod", "Beyond God"],
    ["ssj", "Super Saiyan"],
    ["ssj2", "Super Saiyan 2"],
    ["ssj3", "Super Saiyan 3"],
    ["ssg", "Super Saiyan God"],
    ["ssgss", "Super Saiyan God Super Saiyan"],
    ["potential", "Potential Unleashed"],
    ["giant", "Giant Namekian"],
    ["final", "Final Form"],
    ["golden", "Golden Form"]
];

function createSlashCommands() {
    const commands = [
        new SlashCommandBuilder().setName("help").setDescription("Show Scouter's commands."),
        new SlashCommandBuilder().setName("scan").setDescription("Scan your power or another member.")
            .addUserOption((option) => option.setName("target").setDescription("Member to scan")),
        new SlashCommandBuilder().setName("profile").setDescription("View a progression profile.")
            .addUserOption((option) => option.setName("target").setDescription("Member whose profile to view")),
        new SlashCommandBuilder().setName("compare").setDescription("Compare progression with another member.")
            .addUserOption((option) => option.setName("target").setDescription("Member to compare with").setRequired(true)),
        new SlashCommandBuilder().setName("leaderboard").setDescription("Show this server's power rankings."),
        new SlashCommandBuilder().setName("achievements").setDescription("View your progression achievements."),
        new SlashCommandBuilder().setName("train").setDescription("Trade stamina for a training reward."),
        new SlashCommandBuilder().setName("transform").setDescription("Change to an unlocked transformation.")
            .addStringOption((option) => option.setName("form").setDescription("Transformation to use").setRequired(true)
                .addChoices(...TRANSFORM_CHOICES.map(([value, name]) => ({ name, value }))))
            .addUserOption((option) => option.setName("helper1").setDescription("Saiyan helper for your first SSG awakening"))
            .addUserOption((option) => option.setName("helper2").setDescription("Saiyan helper for your first SSG awakening"))
            .addUserOption((option) => option.setName("helper3").setDescription("Saiyan helper for your first SSG awakening"))
            .addUserOption((option) => option.setName("helper4").setDescription("Saiyan helper for your first SSG awakening"))
            .addUserOption((option) => option.setName("helper5").setDescription("Saiyan helper for your first SSG awakening")),
        new SlashCommandBuilder().setName("kaioken").setDescription("Activate or disable Kaioken.")
            .addStringOption((option) => option.setName("level").setDescription("Kaioken multiplier")
                .setRequired(true)
                .addChoices(
                    { name: "x2", value: "x2" },
                    { name: "x3", value: "x3" },
                    { name: "x4", value: "x4" },
                    { name: "x10", value: "x10" },
                    { name: "Off", value: "off" }
                )),
        new SlashCommandBuilder().setName("revert").setDescription("Return to your base form."),
        new SlashCommandBuilder().setName("race").setDescription("Choose your race before it locks.")
            .addStringOption((option) => option.setName("race").setDescription("Race to become").setRequired(true)
                .addChoices(
                    { name: "Saiyan", value: "saiyan" },
                    { name: "Human", value: "human" },
                    { name: "Namekian", value: "namekian" },
                    { name: "Frieza Race", value: "frieza" }
                )),
        new SlashCommandBuilder().setName("privacy").setDescription("Opt in or out of progression tracking.")
            .addStringOption((option) => option.setName("action").setDescription("Privacy action").setRequired(true)
                .addChoices(
                    { name: "Opt out and delete my record", value: "optout" },
                    { name: "Opt in again", value: "optin" }
                )),
        new SlashCommandBuilder().setName("setlevel").setDescription("Set a member's tier (server owner only).")
            .addUserOption((option) => option.setName("target").setDescription("Member to update").setRequired(true))
            .addIntegerOption((option) => option.setName("level").setDescription("New tier").setMinValue(1).setRequired(true)),
        new SlashCommandBuilder().setName("setpower").setDescription("Set a member's base power (server owner only).")
            .addUserOption((option) => option.setName("target").setDescription("Member to update").setRequired(true))
            .addStringOption((option) => option.setName("power").setDescription("New base power (2,500 or higher)").setRequired(true)),
        new SlashCommandBuilder().setName("awardpower").setDescription("Award base power to a member (server owner only).")
            .addUserOption((option) => option.setName("target").setDescription("Member to reward").setRequired(true))
            .addStringOption((option) => option.setName("amount").setDescription("Positive whole-number amount").setRequired(true))
            .addStringOption((option) => option.setName("reason").setDescription("Optional reason").setMaxLength(200)),
        new SlashCommandBuilder().setName("reset").setDescription("Reset a member's profile (server owner only).")
            .addUserOption((option) => option.setName("target").setDescription("Member to reset").setRequired(true))
    ];

    return commands.map((command) => command.setDMPermission(false));
}

const SLASH_COMMANDS = createSlashCommands();

// Progression and stamina balance values. Displayed power still uses lore multipliers.
const STAMINA_REGEN_PER_DAY = 2000;
const BASE_MESSAGE_XP = 400;
const MESSAGE_XP_VARIANCE = 200;
const MESSAGE_LENGTH_BONUS = 0.1;
const MESSAGE_LENGTH_BONUS_CAP = 200;
const BASE_TRAINING_POWER = 5000;
const TRAIN_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const STAMINA_REGEN_PER_MS = STAMINA_REGEN_PER_DAY / (24 * 60 * 60 * 1000);
const NEW_USER_NOTICE_INTERVAL_MS = 60 * 1000;
const newUserNoticeState = new Map();

// One rule table drives transformation access, training rewards, and stamina usage.
const TRANSFORM_RULES = {
    normal: { minLevel: 1, trainingMultiplier: 1, trainingPenalty: 0, trainingCost: 10, messageDrain: 0 },
    beyondgod: { minLevel: 50, setGodKi: true, trainingMultiplier: 1, trainingPenalty: 0, trainingCost: 10, messageDrain: 0 },
    ssj: { minLevel: 4, trainingMultiplier: 50, trainingPenalty: 0.024, trainingCost: 500, messageDrain: 1 },
    ssj2: { minLevel: 8, trainingMultiplier: 100, trainingPenalty: 0.04, trainingCost: 1000, messageDrain: 2 },
    ssj3: { minLevel: 16, trainingMultiplier: 400, trainingPenalty: 0.06, trainingCost: 4000, messageDrain: 15 },
    ssg: { minLevel: 50, setGodKi: true, trainingMultiplier: 450, trainingPenalty: 0.1, trainingCost: 4500, messageDrain: 5 },
    ssgss: { minGodTier: 15, trainingMultiplier: 500, trainingPenalty: 0.15, trainingCost: 5000, messageDrain: 10 },
    potential: { minLevelByRace: { human: 16, namekian: 25 }, trainingMultiplier: 250, trainingPenalty: 0.08, trainingCost: 2500, messageDrain: 6 },
    giant: { minLevel: 8, trainingMultiplier: 120, trainingPenalty: 0.05, trainingCost: 1200, messageDrain: 4 },
    final: { minLevel: 8, trainingMultiplier: 120, trainingPenalty: 0.05, trainingCost: 1200, messageDrain: 4 },
    golden: { minLevel: 25, trainingMultiplier: 600, trainingPenalty: 0.1, trainingCost: 6000, messageDrain: 10 }
};

const KAIOKEN_RULES = {
    2: { command: "x2", minLevel: 4, messageDrain: 2, trainingCost: 250, trainingMultiplier: 10, trainingPenalty: 0.01 },
    3: { command: "x3", minLevel: 8, messageDrain: 5, trainingCost: 500, trainingMultiplier: 15, trainingPenalty: 0.02 },
    4: { command: "x4", minLevel: 16, messageDrain: 10, trainingCost: 1000, trainingMultiplier: 20, trainingPenalty: 0.04 },
    10: { command: "x10", minLevel: 25, messageDrain: 25, trainingCost: 3000, trainingMultiplier: 50, trainingPenalty: 0.1 }
};

// Presentation helpers for the transformation multiplier.
const borderColor = (form) => {
    if (form === "normal") return "#FF0000";
    if (["ssj", "ssj2", "ssj3"].includes(form)) return "#FFFF00";
    if (form === "ssg") return "#FF2400";
    if (form === "ssgss") return "#00FFFF";
    if (["golden", "final"].includes(form)) return "#FFD700";
    if (form === "potential") return "#7B2CBF";
    return "#08ff00";
};

function transformationName(form, godki = 0, race = "saiyan") {
    if (form === "normal") return godki > 0 ? "Beyond God" : "Normal";
    if (form === "beyondgod") return "Beyond God";
    return {
        ssj: "Super Saiyan",
        ssj2: "Super Saiyan 2",
        ssj3: "Super Saiyan 3",
        ssg: "Super Saiyan God",
        ssgss: "Super Saiyan God Super Saiyan",
        potential: "Potential Unleashed",
        giant: "Giant Namekian",
        final: "Final Form",
        golden: "Golden Form"
    }[form] || "Normal";
}

const transformLabel = (form, godki = 0, race = "saiyan") => form === "normal"
    ? ""
    : `${transformationName(form, godki, race)} `;

function formatPowerLevel(power) {
    return power < 100000
        ? numeral(power).format("0,0")
        : numeral(power).format("0.0a");
}

function waitAndDelete(message, ms) {
    if (!message) return;
    const deleteTimer = setTimeout(async () => {
        try {
            await message.delete();
        } catch (error) {
            if (error.code !== 10008) {
                console.error(`Failed to delete message ${message.id}:`, error);
            }
        }
    }, ms);
    deleteTimer.unref?.();
}

async function sendTemporary(channel, content, deleteAfterMs, context) {
    try {
        const sentMessage = await channel.send(content);
        waitAndDelete(sentMessage, deleteAfterMs);
        return sentMessage;
    } catch (error) {
        console.error(`Failed to send ${context}:`, error);
        return null;
    }
}

async function replyTemporary(message, content, deleteAfterMs, context) {
    try {
        const reply = await message.reply(content);
        waitAndDelete(reply, deleteAfterMs);
        return reply;
    } catch (error) {
        console.error(`Failed to send ${context}:`, error);
        return null;
    }
}

function getLevelProgress(user) {
    const godLevel = user.godki > 0 ? user.level - user.godki + 1 : 0;
    const currentXp = user.points - 2500;
    const nextLevelXp = getXpRequiredForLevel(user.level);
    return { godLevel, currentXp, nextLevelXp, difference: Math.max(0, nextLevelXp - currentXp) };
}

function getCurrentFormName(user) {
    const formName = transformationName(getCurrentForm(user), user.godki, user.race);
    if (user.kaiokenLevel > 0) return `${formName} + Kaioken x${user.kaiokenLevel}`;
    return formName;
}

function getStaminaCosts(user, rule) {
    const kaiokenRule = KAIOKEN_RULES[user.kaiokenLevel];
    if (!kaiokenRule) return { messageDrain: rule.messageDrain, trainingCost: rule.trainingCost };

    if (getCurrentForm(user) === "normal") {
        return {
            messageDrain: kaiokenRule.messageDrain,
            trainingCost: kaiokenRule.trainingCost
        };
    }
    return {
        messageDrain: rule.messageDrain * user.kaiokenLevel,
        trainingCost: rule.trainingCost * user.kaiokenLevel
    };
}

function recoverStamina(user, now) {
    if (!Number.isFinite(user.stamina)) user.stamina = MAX_STAMINA;
    user.stamina = Math.max(0, Math.min(MAX_STAMINA, user.stamina));
    if (!Number.isFinite(user.staminaUpdatedAt)) user.staminaUpdatedAt = now;
    if (!Number.isFinite(user.trainLastUsedAt)) user.trainLastUsedAt = 0;

    const elapsed = Math.max(0, now - user.staminaUpdatedAt);
    // Recovery only happens in base form; transformed forms spend stamina through activity.
    if (user.transformation === getBaseTransformation(user)) {
        user.stamina = Math.min(MAX_STAMINA, user.stamina + elapsed * STAMINA_REGEN_PER_MS);
    }
    user.staminaUpdatedAt = now;
}

function getBaseTransformation(user) {
    return getTransformationMultiplier("normal", user.godki, getGodTierLevel(user) || 1, user.race);
}

function dropTransformation(user) {
    const fallbacks = {
        saiyan: { ssj: "normal", ssj2: "ssj", ssj3: "ssj2", ssg: "normal", ssgss: "ssg" },
        human: { potential: "normal" },
        namekian: { giant: "normal", potential: "giant" },
        frieza: { final: "normal", golden: "final" }
    };
    const fallbackForm = fallbacks[user.race]?.[getCurrentForm(user)] || "normal";
    setTransformation(user, fallbackForm);
}

function dropPowerup(user) {
    if (user.kaiokenLevel > 2) {
        const lowerLevels = { 10: 4, 4: 3, 3: 2 };
        setKaiokenLevel(user, lowerLevels[user.kaiokenLevel]);
        return;
    }
    if (user.kaiokenLevel === 2) {
        setKaiokenLevel(user, 0);
        return;
    }
    dropTransformation(user);
}

function getCurrentForm(user) {
    return user.transformationForm || "normal";
}

function createProfileSnapshot(user, now) {
    const snapshot = { ...user };
    initializeUserProgress(snapshot);
    recoverStamina(snapshot, now);
    return snapshot;
}

function getProfileDetails(user) {
    const levelProgress = getLevelProgress(user);
    const tier = user.godki > 0
        ? `God Tier ${levelProgress.godLevel}`
        : `Tier ${user.level}`;
    return [
        `**Tier:** ${tier}`,
        `**Race:** ${RACES[user.race]?.name || RACES.saiyan.name}`,
        `**Base power:** ${numeral(user.points - 2500).format("0,0")}`,
        `**Displayed power:** ${formatPowerLevel(user.points * user.transformation)}`,
        `**Current form:** ${getCurrentFormName(user)}`,
        `**Stamina:** ${numeral(Math.floor(user.stamina)).format("0,0")} / ${numeral(MAX_STAMINA).format("0,0")}`,
        `**Next tier:** ${levelProgress.difference > 0
            ? `${numeral(levelProgress.difference).format("0,0")} more power needed`
            : "Ready to advance"}`,
        `**Achievements:** ${user.achievements.length} / ${Object.keys(ACHIEVEMENTS).length}`
    ].join("\n");
}

function getMessagePowerRange() {
    const minimum = BASE_MESSAGE_XP;
    const maximum = Math.floor((BASE_MESSAGE_XP + MESSAGE_XP_VARIANCE) * (1 + MESSAGE_LENGTH_BONUS));
    return `${numeral(minimum).format("0,0")}–${numeral(maximum).format("0,0")} power per eligible message, depending on message length.`;
}

// Send one summary even if a large reward crosses several levels.
function sendLevelUp(message, user, levelsGained) {
    if (levelsGained === 0) return;

    const godLevel = user.godki > 0 ? user.level - user.godki + 1 : 0;
    const levelUpEmbed = new EmbedBuilder()
        .setTitle("Level Up!")
        .setDescription(user.godki > 0
            ? `Congratulations to ${message.author} for reaching God Tier ${godLevel}`
            : `Congratulations to ${message.author} for reaching Tier ${user.level}`)
        .setThumbnail(message.author.displayAvatarURL({ dynamic: true, size: 256 }))
        .setColor("#08ff00")
        .addFields(
            { name: user.godki > 0 ? ":crossed_swords:New God Tier" : ":crossed_swords:New Tier", value: String(user.godki > 0 ? godLevel : user.level), inline: true },
            { name: "Powerlevel", value: formatPowerLevel(user.points * user.transformation), inline: true },
            { name: "Levels gained", value: String(levelsGained), inline: true }
        )
        .setFooter({ text: `Scouter Bot ${config.version} | ${COPYRIGHT_NOTICE} ${config.author}`, iconURL: client.user.displayAvatarURL({ extension: "png", size: 64 }) });

    sendTemporary(message.channel, { embeds: [levelUpEmbed] }, 30000, "level-up notice");
}

function awardAchievements(message, user, achievementIds) {
    const newlyUnlocked = [...new Set(achievementIds)]
        .filter((id) => ACHIEVEMENTS[id] && !user.achievements.includes(id));
    if (newlyUnlocked.length === 0) return;

    user.achievements.push(...newlyUnlocked);
    const achievementEmbed = new EmbedBuilder()
        .setTitle(newlyUnlocked.length === 1 ? "Achievement Unlocked!" : "Achievements Unlocked!")
        .setDescription(newlyUnlocked
            .map((id) => `**${ACHIEVEMENTS[id].name}** — ${ACHIEVEMENTS[id].description}`)
            .join("\n"))
        .setThumbnail(message.author.displayAvatarURL({ dynamic: true, size: 256 }))
        .setColor("#FFD700");

    sendTemporary(message.channel, { embeds: [achievementEmbed] }, 30000, `achievement notice for user ${user.userID}`);
}

function sendNewUserNotice(guildId, channel, user) {
    let state = newUserNoticeState.get(guildId);
    if (!state) {
        state = { lastSentAt: 0, pendingUserIds: new Set(), timer: null, channel };
        newUserNoticeState.set(guildId, state);
    }

    state.pendingUserIds.add(user.id);
    state.channel = channel;

    const sendNotice = () => {
        const addedCount = state.pendingUserIds.size;
        state.pendingUserIds.clear();
        state.timer = null;
        if (addedCount === 0) return;
        state.lastSentAt = Date.now();

        const totalTracked = client.points.filter((record) => record.guildID === guildId).length;
        const newUserEmbed = new EmbedBuilder()
            .setTitle("New Users Tracked!")
            .setDescription(`Added ${addedCount} new ${addedCount === 1 ? "user" : "users"} to the server's progression records.`)
            .setColor("#08ff00")
            .addFields(
                { name: "Users added in this update", value: String(addedCount), inline: true },
                { name: "Total users tracked", value: String(totalTracked), inline: true }
            );

        sendTemporary(state.channel, { embeds: [newUserEmbed] }, 5000, `new-user notice for guild ${guildId}`);
    };

    const timeUntilNextNotice = NEW_USER_NOTICE_INTERVAL_MS - (Date.now() - state.lastSentAt);
    if (timeUntilNextNotice <= 0) {
        sendNotice();
    } else if (!state.timer) {
        state.timer = setTimeout(sendNotice, timeUntilNextNotice);
        state.timer.unref?.();
    }
}

function cancelPendingNewUserNotice(guildId, userId) {
    const state = newUserNoticeState.get(guildId);
    if (!state) return;

    state.pendingUserIds.delete(userId);
    if (state.pendingUserIds.size === 0 && state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
    }
}

client.on("clientReady", () => {
    console.log(`[NOTICE] Bot has started, with ${client.users.cache.size} users, in ${client.channels.cache.size} channels of ${client.guilds.cache.size} guilds.`);
});

function createInteractionContext(interaction) {
    const commandName = interaction.commandName;
    const options = interaction.options;
    const targetUser = options.getUser("target");
    const helperUsers = commandName === "transform"
        ? Array.from({ length: 5 }, (_, index) => options.getUser(`helper${index + 1}`)).filter(Boolean)
        : [];
    const mentionedUsers = helperUsers.length > 0 ? helperUsers : targetUser ? [targetUser] : [];
    const targetMember = targetUser
        ? options.getMember("target") || interaction.guild.members.cache.get(targetUser.id) || {
            id: targetUser.id,
            user: targetUser,
            displayName: targetUser.globalName || targetUser.username
        }
        : null;
    const commandArgs = [];

    if (commandName === "privacy") commandArgs.push(options.getString("action"));
    if (commandName === "race") commandArgs.push(options.getString("race"));
    if (commandName === "kaioken") commandArgs.push(options.getString("level"));
    if (commandName === "transform") commandArgs.push(options.getString("form"));
    if (["setlevel", "setpower", "awardpower", "reset"].includes(commandName)) {
        commandArgs.push(targetUser.id);
        if (commandName === "setlevel") commandArgs.push(String(options.getInteger("level")));
        if (commandName === "setpower") commandArgs.push(options.getString("power"));
        if (commandName === "awardpower") {
            commandArgs.push(options.getString("amount"));
            const reason = options.getString("reason");
            if (reason) commandArgs.push(reason);
        }
    }

    let firstResponse = true;
    const send = async (payload) => {
        const response = firstResponse
            ? await interaction.editReply(payload)
            : await interaction.followUp(payload);
        firstResponse = false;
        return response;
    };

    return {
        isSlashCommand: true,
        commandName,
        commandArgs,
        content: "",
        author: interaction.user,
        member: interaction.member?.displayName
            ? interaction.member
            : { displayName: interaction.member?.nick || interaction.user.globalName || interaction.user.username },
        guild: interaction.guild,
        channel: { send },
        mentions: {
            members: { first: () => targetMember },
            users: {
                first: () => mentionedUsers[0] || null,
                values: () => mentionedUsers.values()
            }
        },
        delete: async () => {},
        reply: send
    };
}

async function handleInteraction(interaction) {
    if (!interaction.inGuild()) {
        await interaction.reply({ content: "Scouter commands are only available in a server.", ephemeral: true });
        return;
    }

    await interaction.deferReply();
    await handleMessage(createInteractionContext(interaction));
}

async function handleMessage(message) {
    if (!message.guild || message.author.bot) return;

    const rightNow = Date.now();
    const key = `${message.guild.id}-${message.author.id}`;
    const isSlashCommand = message.isSlashCommand === true;
    if (!isSlashCommand && message.content.startsWith(legacyMessagePrefix)) return;
    const args = isSlashCommand ? message.commandArgs || [] : [];
    const command = isSlashCommand ? message.commandName : null;

    if (command === "privacy") {
        const privacyAction = args[0] ? args[0].toLowerCase() : null;
        if (privacyAction === "optout") {
            optOutUser(client.privacy, client.points, key);
            cancelPendingNewUserNotice(message.guild.id, message.author.id);
            await sendTemporary(
                message.channel,
                "Progression tracking is off for you in this server. Your saved progression record has been deleted. Use `/privacy action:optin` to start fresh later.",
                30000,
                "privacy opt-out confirmation"
            );
        } else if (privacyAction === "optin") {
            optInUser(client.privacy, key);
            await sendTemporary(
                message.channel,
                "Progression tracking is on again. A new record will be created when you next chat.",
                30000,
                "privacy opt-in confirmation"
            );
        } else {
            await sendTemporary(
                message.channel,
                "Use `/privacy action:optout` to disable tracking and delete your saved record, or `/privacy action:optin` to start fresh later.",
                30000,
                "privacy command instructions"
            );
        }
        return;
    }

    if (command === "scan") {
        let targetMember = message.mentions.members.first()
            || (args[0] ? message.guild.members.cache.get(args[0]) : null);
        if (!targetMember && args[0] && /^\d{17,20}$/.test(args[0])) {
            try {
                targetMember = await message.guild.members.fetch(args[0]);
            } catch (error) {
                if (error.code !== 10007 && error.code !== 10013) {
                    console.error(`Failed to fetch scan target ${args[0]}:`, error);
                    await replyTemporary(message, "The scouter could not complete the scan. Try again shortly.", 10000, "scan member lookup error");
                    return;
                }
            }
        }
        if (args.length > 0 && !targetMember) {
            await replyTemporary(message, "Choose a server member in the target option, or leave it empty to scan yourself.", 10000, "scan usage response");
            return;
        }

        const targetUser = targetMember ? targetMember.user : message.author;
        const targetKey = `${message.guild.id}-${targetUser.id}`;
        const displayName = targetMember?.displayName
            || (targetUser.id === message.author.id ? message.member?.displayName : null)
            || targetUser.username;
        const scanEmbed = new EmbedBuilder()
            .setTitle("SCOUTER // POWER SCAN")
            .setAuthor({
                name: `Target acquired: ${displayName}`,
                iconURL: targetUser.displayAvatarURL({ extension: "png", size: 64 })
            })
            .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 256 }))
            .setColor("#E34B4B");

        if (client.privacy.get(targetKey)) {
            scanEmbed
                .setDescription("**SCAN BLOCKED**")
                .addFields(
                    { name: "Signal", value: "Privacy lock engaged", inline: true },
                    { name: "Power reading", value: "Unavailable", inline: true },
                    { name: "Result", value: "This member has opted out of progression tracking. The scouter cannot read their power." }
                );
        } else {
            const targetRecord = targetUser.id === message.author.id
                ? client.points.get(key) || createDefaultUser(targetUser.id, message.guild.id, rightNow)
                : client.points.get(targetKey);
            if (!targetRecord) {
                scanEmbed
                    .setDescription("**NO POWER DATA**")
                    .addFields(
                        { name: "Signal", value: "No registered reading", inline: true },
                        { name: "Power reading", value: "Unknown", inline: true },
                        { name: "Scan status", value: "Unreadable • No profile data", inline: true },
                        { name: "Result", value: "No progression profile exists for this member in this server yet." }
                    );
            } else {
                const scannedUser = createProfileSnapshot(targetRecord, rightNow);
                const levelProgress = getLevelProgress(scannedUser);
                const tier = scannedUser.godki > 0
                    ? `God Tier ${levelProgress.godLevel}`
                    : `Tier ${scannedUser.level}`;
                scanEmbed
                    .setDescription("**SCAN COMPLETE**")
                    .setColor(borderColor(getCurrentForm(scannedUser)))
                    .addFields(
                        { name: "Power reading", value: `⚡ **${formatPowerLevel(scannedUser.points * scannedUser.transformation)}**`, inline: true },
                        { name: "Base power", value: numeral(scannedUser.points - 2500).format("0,0"), inline: true },
                        { name: "Signal profile", value: `${RACES[scannedUser.race].name} • ${tier} • ${getCurrentFormName(scannedUser)}`, inline: true },
                        { name: "Stamina", value: `${numeral(Math.floor(scannedUser.stamina)).format("0,0")} / ${numeral(MAX_STAMINA).format("0,0")}`, inline: true },
                        {
                            name: "Next tier",
                            value: levelProgress.difference > 0
                                ? `${numeral(levelProgress.difference).format("0,0")} more power needed`
                                : "Ready to advance",
                            inline: true
                        },
                        { name: "Scan status", value: "Readable • Progression tracking is enabled", inline: true }
                    );
            }
        }
        scanEmbed.setFooter({
            text: `Scouter Bot ${config.version} | ${COPYRIGHT_NOTICE} ${config.author}`,
            iconURL: client.user.displayAvatarURL({ extension: "png", size: 64 })
        });
        await sendTemporary(message.channel, { embeds: [scanEmbed] }, 15000, "scan response");
        return;
    }

    if (client.privacy.get(key)) {
        if (isSlashCommand) {
            await replyTemporary(
                message,
                "Progression tracking is off for you in this server. Use `/privacy action:optin` to start fresh.",
                10000,
                "opted-out command notice"
            );
        }
        return;
    }

    // Load or initialize one guild-scoped record, then persist stamina recovery.
    let user = client.points.get(key);

    if (!user) {
        user = createDefaultUser(message.author.id, message.guild.id, rightNow);
        client.points.set(key, user);
        sendNewUserNotice(message.guild.id, message.channel, message.author);
    }

    initializeUserProgress(user);
    recoverStamina(user, rightNow);
    client.points.set(key, user);

    if (command === "race") {
        const raceName = args.join(" ").trim().toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(RACES, raceName)) {
            return replyTemporary(
                message,
                `Choose a race: ${Object.entries(RACES).map(([id, race]) => `\`${id}\` (${race.name})`).join(", ")}.`,
                10000,
                "race usage response"
            );
        }
        if (user.race === raceName) {
            return replyTemporary(message, `You are already a ${RACES[raceName].name}.`, 10000, "race unchanged response");
        }
        if (!changeRace(user, raceName)) {
            return replyTemporary(
                message,
                `Your race is locked after reaching ${numeral(RACE_LOCK_BASE_POWER).format("0,0")} base power.`,
                10000,
                "race locked response"
            );
        }
        client.points.set(key, user);
        return sendTemporary(
            message.channel,
            `Your race is now ${RACES[raceName].name}. Your form has returned to ${transformationName("normal", user.godki, user.race)}.${user.kaiokenLevel > 0 ? ` Kaioken x${user.kaiokenLevel} remains active.` : ""}`,
            10000,
            "race change confirmation"
        );
    }

    if (command === "kaioken") {
        const requestedLevel = args[0]?.toLowerCase();
        if (["off", "disable", "0"].includes(requestedLevel)) {
            if (user.kaiokenLevel === 0) {
                return replyTemporary(message, "Kaioken is already disabled.", 10000, "Kaioken state response");
            }
            setKaiokenLevel(user, 0);
            client.points.set(key, user);
            return sendTemporary(message.channel, "Kaioken ability disabled.", 10000, "Kaioken disabled response");
        }

        const level = Number(requestedLevel?.replace(/^x/, ""));
        const rule = KAIOKEN_RULES[level];
        if (!rule) {
            return replyTemporary(
                message,
                "Choose a Kaioken level: x2, x3, x4, x10, or off.",
                10000,
                "Kaioken usage response"
            );
        }
        if (user.level < rule.minLevel) {
            return replyTemporary(message, `Reach Tier ${rule.minLevel} to unlock Kaioken x${level}.`, 10000, "Kaioken level response");
        }
        if (user.kaiokenLevel === level) {
            return replyTemporary(message, `Kaioken x${level} is already active.`, 10000, "Kaioken unchanged response");
        }
        if (["ssj", "ssj2", "ssj3"].includes(getCurrentForm(user))) {
            return replyTemporary(
                message,
                "Kaioken cannot be used with Super Saiyan, Super Saiyan 2, or Super Saiyan 3 because their ki is unstable. Transform out of that form first.",
                10000,
                "Kaioken instability response"
            );
        }
        if (user.stamina <= 0) {
            return replyTemporary(message, "You're out of stamina and need to recover before using Kaioken.", 10000, "Kaioken stamina response");
        }

        setKaiokenLevel(user, level);
        awardAchievements(message, user, ["form_kaioken"]);
        client.points.set(key, user);
        return sendTemporary(
            message.channel,
            `Kaioken x${level} is active on ${transformationName(getCurrentForm(user), user.godki, user.race)}. Current power: ${formatPowerLevel(user.points * user.transformation)}.`,
            10000,
            "Kaioken activation response"
        );
    }

    if (!isSlashCommand) {
        if (message.content.length < config.minsize) return;

        const normalizedContent = normalizeMessage(message.content);
        if (!canEarnMessageXp(user, normalizedContent, rightNow)) return;

        // Ordinary chat grants progression XP and drains stamina while transformed.
        const form = getCurrentForm(user);
        const { messageDrain: staminaCost } = getStaminaCosts(user, TRANSFORM_RULES[form]);
        if (staminaCost > 0) {
            if (user.stamina <= 0) {
                dropPowerup(user);
            } else {
                user.stamina = Math.max(0, user.stamina - staminaCost);
                if (user.stamina === 0) dropPowerup(user);
            }
        }

        const meaningfulLength = [...message.content.replace(/\s/g, "")].length;
        const lengthBonus = Math.min(meaningfulLength / MESSAGE_LENGTH_BONUS_CAP, 1) * MESSAGE_LENGTH_BONUS;
        const messageXp = Math.floor(
            (BASE_MESSAGE_XP + Math.floor(Math.random() * (MESSAGE_XP_VARIANCE + 1))) * (1 + lengthBonus)
        );
        const levelsGained = addExperience(user, messageXp);
        recordMessageXp(user, normalizedContent, rightNow);
        awardAchievements(message, user, getProgressAchievementIds(user));
        client.points.set(key, user);

        sendLevelUp(message, user, levelsGained);
    }

    // Read-only commands report the user's current progression and guild rankings.
    if (command === "help") {
        const help = new EmbedBuilder()
            .setTitle("Command List")
            .addFields(
                { name: "/scan [target]", value: "Run a power scan on yourself or another member; opted-out members cannot be scanned.", inline: true },
                { name: "/profile [target]", value: "Displays your tier, power, form, stamina, progress, and achievements, or another member's profile.", inline: true },
                { name: "/compare target", value: "Compare your progression with another server member.", inline: true },
                { name: "/leaderboard", value: `Shows the all-time leaderboard for ${message.guild.name}; use reactions to change pages.`, inline: true },
                { name: "/achievements", value: "Shows your unlocked achievements and progress.", inline: true },
                { name: "/privacy action", value: "Opt out of progression tracking and delete your record, or opt in again.", inline: true },
                { name: "/race race", value: `Choose Saiyan, Human, Namekian, or Frieza Race before reaching ${numeral(RACE_LOCK_BASE_POWER).format("0,0")} base power.` },
                { name: "/transform form", value: "Change your form. Beyond God attempts to awaken God Ki at Tier 50. First-time Saiyan SSG awakening requires five other Saiyan helpers." },
                { name: "/kaioken level", value: "Activate or disable the universal Kaioken ability. Stamina drain is amplified when stacked with another form." },
                { name: "/revert", value: "Automatically reverts you to your normal form." },
                { name: "/train", value: "Trade stamina for a large one-time power boost. Training is available once per day." },
                { name: "/setlevel target level", value: "Set a member's tier (server owner only)." },
                { name: "/setpower target power", value: "Set a member's base power and recalculate their tier (server owner only)." },
                { name: "/awardpower target amount [reason]", value: "Add base power to a member and recalculate their tier (server owner only)." },
                { name: "/reset target", value: "Reset a member's progression to a fresh profile (server owner only)." }
            )
            .setColor("#008B8B")
            .setFooter({ text: `Scouter Bot ${config.version} | ${COPYRIGHT_NOTICE} ${config.author}`, iconURL: client.user.displayAvatarURL({ extension: "png", size: 64 }) });

        client.points.set(key, user);
        sendTemporary(message.channel, { embeds: [help] }, 30000, "help response");
        return;
    }

    if (command === "profile" || command === "compare") {
        let targetMember = message.mentions.members.first()
            || (args[0] ? message.guild.members.cache.get(args[0]) : null);
        if (command === "compare" && !targetMember && /^\d{17,20}$/.test(args[0] || "")) {
            try {
                targetMember = await message.guild.members.fetch(args[0]);
            } catch (error) {
                if (error.code !== 10007 && error.code !== 10013) {
                    console.error(`Failed to fetch comparison member ${args[0]}:`, error);
                    await replyTemporary(message, "Could not look up that member right now. Please try again later.", 10000, "compare member lookup error");
                    return;
                }
            }
        }
        if (command === "profile" && args.length > 0 && !targetMember) {
            await replyTemporary(message, "Choose a server member in the target option, or leave it empty to view your own profile.", 10000, "profile usage response");
            return;
        }
        if (command === "compare" && !targetMember) {
            await replyTemporary(message, "Choose a server member in the target option to compare with.", 10000, "compare usage response");
            return;
        }
        if (command === "compare" && targetMember.id === message.author.id) {
            await replyTemporary(message, "Mention another member to compare your progression.", 10000, "compare self-target response");
            return;
        }

        const targetUser = targetMember ? targetMember.user : message.author;
        const targetKey = `${message.guild.id}-${targetUser.id}`;
        if (client.privacy.get(targetKey)) {
            await replyTemporary(
                message,
                "That member has opted out of progression tracking.",
                10000,
                `${command} privacy response`
            );
            return;
        }

        const targetRecord = targetUser.id === message.author.id
            ? user
            : client.points.get(targetKey);
        if (!targetRecord) {
            await replyTemporary(
                message,
                "That member doesn't have a progression profile in this server yet.",
                10000,
                `${command} missing-profile response`
            );
            return;
        }

        const profile = createProfileSnapshot(targetRecord, rightNow);
        const displayName = targetMember?.displayName
            || (targetUser.id === message.author.id ? message.member?.displayName : null)
            || targetUser.username;
        if (command === "profile") {
            const profileEmbed = new EmbedBuilder()
                .setAuthor({
                    name: `${transformLabel(getCurrentForm(profile), profile.godki, profile.race)}${displayName}`,
                    iconURL: targetUser.displayAvatarURL({ extension: "png", size: 64 })
                })
                .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 256 }))
                .setTitle("Progression Profile")
                .setDescription(getProfileDetails(profile))
                .setColor(borderColor(getCurrentForm(profile)))
                .addFields({ name: "Power per message", value: getMessagePowerRange() })
                .setFooter({
                    text: `Scouter Bot ${config.version} | ${COPYRIGHT_NOTICE} ${config.author}`,
                    iconURL: client.user.displayAvatarURL({ extension: "png", size: 64 })
                });
            await sendTemporary(message.channel, { embeds: [profileEmbed] }, 12500, "profile response");
            return;
        }

        const viewerProfile = createProfileSnapshot(user, rightNow);
        const viewerName = message.member?.displayName || message.author.username;
        const comparisonEmbed = new EmbedBuilder()
            .setTitle("Progression Comparison")
            .setColor("#008B8B")
            .addFields(
                { name: viewerName, value: getProfileDetails(viewerProfile), inline: true },
                { name: displayName, value: getProfileDetails(profile), inline: true },
                { name: "Power per message", value: getMessagePowerRange() }
            )
            .setFooter({
                text: `Scouter Bot ${config.version} | ${COPYRIGHT_NOTICE} ${config.author}`,
                iconURL: client.user.displayAvatarURL({ extension: "png", size: 64 })
            });
        await sendTemporary(message.channel, { embeds: [comparisonEmbed] }, 12500, "compare response");
        return;
    }

    if (command === "achievements") {
        const unlocked = new Set(user.achievements);
        const achievementEntries = Object.entries(ACHIEVEMENTS)
            .map(([id, achievement]) => `${unlocked.has(id) ? "🏅" : "🔒"} **${achievement.name}**\n${achievement.description}`);
        const columnSize = Math.ceil(achievementEntries.length / 2);
        const achievementColumns = [
            achievementEntries.slice(0, columnSize),
            achievementEntries.slice(columnSize)
        ].filter((column) => column.length > 0);
        const achievementEmbed = new EmbedBuilder()
            .setAuthor({
                name: `${message.author.username}'s Achievements`,
                iconURL: message.author.displayAvatarURL({ extension: "png", size: 64 })
            })
            .addFields(achievementColumns.map((column, index) => ({
                name: achievementColumns.length === 1 ? "Achievements" : index === 0 ? "Achievements" : "More achievements",
                value: column.join("\n\n"),
                inline: true
            })))
            .setColor("#FFD700")
            .setFooter({ text: `${user.achievements.length} of ${Object.keys(ACHIEVEMENTS).length} unlocked` });

        sendTemporary(message.channel, { embeds: [achievementEmbed] }, 30000, "achievements response");
        return;
    }

    if (command === "leaderboard") {
        client.points.set(key, user);

        const filtered = client.points.filter((p) => p.guildID === message.guild.id);
        for (const record of filtered) {
            initializeUserProgress(record);
            client.points.set(`${record.guildID}-${record.userID}`, record);
        }
        const sorted = filtered.sort((a, b) => b.points * b.transformation - a.points * a.transformation);
        const pageSize = 10;
        const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));

        const createLeaderboardEmbed = (page) => {
            const pageStart = (page - 1) * pageSize;
            const pageEntries = sorted.slice(pageStart, pageStart + pageSize);
            const rankingColumns = [pageEntries.slice(0, 5), pageEntries.slice(5, 10)]
                .filter((column) => column.length > 0)
                .map((column, columnIndex) => ({
                    name: `Ranks ${pageStart + columnIndex * 5 + 1}–${pageStart + columnIndex * 5 + column.length}`,
                    value: column.map((data, index) => {
                        const rank = pageStart + columnIndex * 5 + index + 1;
                        const rankLabel = rank <= 3 ? ["🥇", "🥈", "🥉"][rank - 1] : `**${rank}.**`;
                        const tierLabel = data.godki > 0
                            ? `God Tier ${data.level - data.godki + 1}`
                            : `Tier ${data.level}`;
                        const currentForm = data.transformationForm || "normal";
                        const transformationLabel = currentForm === "normal" && !data.kaiokenLevel
                            ? ""
                            : `  •  ${getCurrentFormName(data)}`;
                        const powerLevel = formatPowerLevel(data.points * data.transformation);

                        return `${rankLabel} <@${data.userID}>\n└ ${RACES[data.race]?.name || RACES.saiyan.name} • ${tierLabel}${transformationLabel}  •  **${powerLevel}** power`;
                    }).join("\n\n"),
                    inline: true
                }));

            return new EmbedBuilder()
                .setTitle("🏆 Power Rankings")
                .setDescription(`**${message.guild.name}**\nAll-time power rankings • Page ${page} of ${totalPages} • ${sorted.length} members`)
                .addFields(rankingColumns.length > 0
                    ? rankingColumns
                    : [{ name: "No rankings yet", value: "Start chatting to earn power!" }])
                .setFooter({ text: `Scouter Bot ${config.version} | ${COPYRIGHT_NOTICE} ${config.author}`, iconURL: client.user.displayAvatarURL({ extension: "png", size: 64 }) })
                .setColor(0x00ae86);
        };

        const leaderboardMessage = await sendTemporary(
            message.channel,
            { embeds: [createLeaderboardEmbed(1)] },
            totalPages > 1 ? 120000 : 30000,
            "leaderboard"
        );
        if (!leaderboardMessage) return;
        if (totalPages > 1) {
            const previousPageEmoji = "⬅️";
            const nextPageEmoji = "➡️";
            try {
                await leaderboardMessage.react(previousPageEmoji);
                await leaderboardMessage.react(nextPageEmoji);
            } catch (error) {
                console.error("Failed to add leaderboard pagination reactions:", error);
                await replyTemporary(
                    leaderboardMessage,
                    "I couldn't add the page controls. Please check that I have Add Reactions and Read Message History permissions.",
                    10000,
                    "leaderboard pagination error"
                );
                return;
            }

            const collector = leaderboardMessage.createReactionCollector({
                filter: (reaction, reactor) =>
                    reactor.id === message.author.id &&
                    [previousPageEmoji, nextPageEmoji].includes(reaction.emoji.name),
                time: 120000
            });
            let currentPage = 1;

            collector.on("collect", async (reaction, reactor) => {
                try {
                    await reaction.users.remove(reactor.id);
                    currentPage += reaction.emoji.name === nextPageEmoji ? 1 : -1;
                    if (currentPage < 1 || currentPage > totalPages) {
                        currentPage -= reaction.emoji.name === nextPageEmoji ? 1 : -1;
                        return;
                    }
                    await leaderboardMessage.edit({ embeds: [createLeaderboardEmbed(currentPage)] });
                } catch (error) {
                    console.error("Failed to update paginated leaderboard:", error);
                    collector.stop("pagination-error");
                }
            });

            collector.on("end", () => {
                leaderboardMessage.reactions.removeAll()
                    .catch((error) => console.error("Failed to remove leaderboard pagination reactions:", error));
            });
        }

        return;
    }

    // Training trades stamina for a once-daily power reward.
    if (command === "train") {
        const cooldownRemaining = TRAIN_COOLDOWN_MS - (rightNow - user.trainLastUsedAt);
        if (cooldownRemaining > 0) {
            const hoursRemaining = Math.ceil(cooldownRemaining / (60 * 60 * 1000));
            return replyTemporary(message, `You're exhausted from training. Try again in about ${hoursRemaining} hour(s).`, 10000, "training cooldown response");
        }

        const form = getCurrentForm(user);
        const rule = TRANSFORM_RULES[form];
        const { trainingCost } = getStaminaCosts(user, rule);
        const trainingFormName = getCurrentFormName(user);
        if (user.stamina < trainingCost) {
            return replyTemporary(message, `Not enough stamina to train in ${trainingFormName}. You need ${numeral(trainingCost).format("0,0")} stamina; you have ${numeral(Math.floor(user.stamina)).format("0,0")}.`, 10000, "training stamina response");
        }

        const kaiokenRule = KAIOKEN_RULES[user.kaiokenLevel];
        const trainingMultiplier = form === "normal" && kaiokenRule
            ? kaiokenRule.trainingMultiplier
            : rule.trainingMultiplier * getKaiokenMultiplier(user.kaiokenLevel);
        const trainingPenalty = form === "normal" && kaiokenRule
            ? kaiokenRule.trainingPenalty
            : rule.trainingPenalty;
        const rawPower = BASE_TRAINING_POWER * trainingMultiplier;
        const powerGained = Math.floor(rawPower * (1 - trainingPenalty));
        user.stamina = Math.max(0, user.stamina - trainingCost);
        recordTrainingDay(user, rightNow);
        user.trainLastUsedAt = rightNow;
        const levelsGained = addExperience(user, powerGained);

        const droppedPowerup = user.stamina === 0 && user.transformation !== getBaseTransformation(user);
        if (droppedPowerup) dropPowerup(user);

        const trainingAchievements = ["trained_once"];
        if (user.trainingStreakDays >= 7) trainingAchievements.push("training_streak_7");
        awardAchievements(message, user, [...trainingAchievements, ...getProgressAchievementIds(user)]);
        client.points.set(key, user);

        const trainingEmbed = new EmbedBuilder()
            .setTitle(`${message.author.username} finished training!`)
            .setDescription(droppedPowerup
                ? "The training drained your stamina and forced you to lower a form or Kaioken level."
                : `Training in ${trainingFormName} converted stamina into power.`)
            .setColor("#08ff00")
            .addFields(
                { name: "Power gained", value: numeral(powerGained).format("0,0"), inline: true },
                { name: "Stamina used", value: numeral(trainingCost).format("0,0"), inline: true },
                { name: "Stamina remaining", value: `${numeral(Math.floor(user.stamina)).format("0,0")} / ${numeral(MAX_STAMINA).format("0,0")}`, inline: true },
                { name: "Current power level", value: formatPowerLevel(user.points * user.transformation), inline: true }
            )
            .setFooter({ text: "Training can be used once every 24 hours.", iconURL: client.user.displayAvatarURL({ extension: "png", size: 64 }) });

        sendTemporary(message.channel, { embeds: [trainingEmbed] }, 30000, "training result");
        sendLevelUp(message, user, levelsGained);
        return;
    }

    if (command === "revert") {
        setTransformation(user, "normal");
        client.points.set(key, user);
        const baseForm = user.godki > 0 ? "Beyond God" : "Normal";
        const kaiokenNotice = user.kaiokenLevel > 0 ? ` Kaioken x${user.kaiokenLevel} remains active.` : "";
        await sendTemporary(
            message.channel,
            `Reverted to ${baseForm}.${kaiokenNotice} Your power level is now ${formatPowerLevel(user.points * user.transformation)}.`,
            10000,
            "revert confirmation"
        );
        return;
    }

    // Transformation changes require an unlocked form and available stamina.
    if (command === "transform") {
        const requestedForm = args.length > 0 ? args[0].toLowerCase() : null;

        const validForms = ["normal", "beyondgod", ...RACES[user.race].forms];
        if (!requestedForm || !Object.prototype.hasOwnProperty.call(TRANSFORM_RULES, requestedForm)) {
            const invalidTransform = new EmbedBuilder()
                .setAuthor({ name: `${transformLabel(getCurrentForm(user), user.godki, user.race)}${message.member?.displayName || message.author.username}`, iconURL: message.author.displayAvatarURL({ extension: "png", size: 64 }) })
                .setColor("#FF0000")
                .addFields(
                    { name: "Error!", value: "Choose a valid form for your race." },
                    { name: "Valid arguments are:", value: validForms.map((form) => `\`${form}\` (${transformationName(form, user.godki, user.race)})`).join(", ") }
                )
                .setFooter({ text: `Scouter Bot ${config.version} | ${COPYRIGHT_NOTICE} ${config.author}`, iconURL: client.user.displayAvatarURL({ extension: "png", size: 64 }) });

            sendTemporary(message.channel, { embeds: [invalidTransform] }, 10000, "invalid transformation response");
            return;
        }

        const rule = TRANSFORM_RULES[requestedForm];
        if (requestedForm !== "beyondgod" && !isFormAvailableForRace(requestedForm, user.race)) {
            return replyTemporary(
                message,
                `${transformationName(requestedForm, user.godki, user.race)} is only available to the appropriate race.`,
                10000,
                "race transformation restriction response"
            );
        }
        const requiredLevel = rule.minLevelByRace?.[user.race] ?? rule.minLevel;
        const meetsRequirement = rule.minGodTier
            ? hasReachedGodTier(user, rule.minGodTier)
            : user.level >= requiredLevel;
        if (!meetsRequirement) {
            const lowLevelWarning = new EmbedBuilder()
                .setAuthor({ name: `${transformLabel(getCurrentForm(user), user.godki, user.race)}${message.member?.displayName || message.author.username}`, iconURL: message.author.displayAvatarURL({ extension: "png", size: 64 }) })
                .setThumbnail(message.author.displayAvatarURL({ dynamic: true, size: 256 }))
                .setColor("#FF0000")
                .addFields({
                    name: rule.minGodTier ? "God Tier too low!" : "Level too low!",
                    value: rule.minGodTier
                        ? `Awaken God Ki, then reach God Tier ${rule.minGodTier} to unlock Super Saiyan God Super Saiyan.`
                        : `Reach Tier ${requiredLevel} to unlock ${transformationName(requestedForm, user.godki, user.race)}.`
                });

            sendTemporary(message.channel, { embeds: [lowLevelWarning] }, 10000, "level requirement response");
            return;
        }

        const form = requestedForm === "beyondgod" ? "normal" : requestedForm;
        if (user.kaiokenLevel > 0 && ["ssj", "ssj2", "ssj3"].includes(form)) {
            return replyTemporary(
                message,
                "Super Saiyan, Super Saiyan 2, and Super Saiyan 3 cannot be combined with Kaioken because their ki is unstable. Disable Kaioken first.",
                10000,
                "transformation instability response"
            );
        }
        if (form !== "normal" && user.stamina <= 0) {
            return replyTemporary(message, "You're out of stamina and need to recover before transforming.", 10000, "transformation stamina response");
        }

        if (requestedForm === "beyondgod") {
            if (user.godki > 0) {
                setTransformation(user, "normal");
            } else {
                const cooldownRemaining = GOD_KI_AWAKENING_COOLDOWN_MS
                    - (rightNow - user.lastGodKiAwakeningAttemptAt);
                if (cooldownRemaining > 0) {
                    const hoursRemaining = Math.ceil(cooldownRemaining / (60 * 60 * 1000));
                    return replyTemporary(
                        message,
                        `Your next God Ki awakening attempt is available in about ${hoursRemaining} hour(s).`,
                        10000,
                        "God Ki awakening cooldown response"
                    );
                }

                const chance = getGodKiAwakeningChance(user.godKiAwakeningAttempts);
                user.lastGodKiAwakeningAttemptAt = rightNow;
                if (Math.random() >= chance) {
                    user.godKiAwakeningAttempts += 1;
                    client.points.set(key, user);
                    return sendTemporary(
                        message.channel,
                        `Your attempt to awaken God Ki failed (${Math.round(chance * 100)}% chance). Try again in 12 hours. Your chance will rise after four failed attempts.`,
                        10000,
                        "God Ki awakening failure response"
                    );
                }

                user.godki = user.level;
                user.godKiAwakeningAttempts = 0;
                setTransformation(user, "normal");
                awardAchievements(message, user, ["form_beyondgod"]);
            }
        } else if (form === "normal") {
            setTransformation(user, "normal");
        } else {
            if (requestedForm === "ssg" && user.godki < 1) {
                if (user.kaiokenLevel > 0) {
                    return replyTemporary(
                        message,
                        "Disable Kaioken before awakening Super Saiyan God.",
                        10000,
                        "SSG awakening Kaioken response"
                    );
                }
                const helperIds = [...message.mentions.users.values()]
                    .map((helper) => helper.id)
                    .filter((id) => id !== message.author.id);
                const uniqueHelperIds = [...new Set(helperIds)];
                if (uniqueHelperIds.length !== 5) {
                    return replyTemporary(
                        message,
                        "Your first Super Saiyan God awakening requires exactly five other Saiyan helpers. Select five helpers in the helper options.",
                        10000,
                        "SSG awakening helper count response"
                    );
                }

                const helpers = uniqueHelperIds.map((helperId) => ({
                    id: helperId,
                    profile: client.points.get(`${message.guild.id}-${helperId}`)
                }));
                for (const { id, profile } of helpers) {
                    if (!profile) {
                        return replyTemporary(
                            message,
                            "All five helpers must have an existing Saiyan progression profile in this server.",
                            10000,
                            "SSG awakening helper profile response"
                        );
                    }
                    initializeUserProgress(profile);
                    client.points.set(`${message.guild.id}-${id}`, profile);
                    if (profile.race !== "saiyan") {
                        return replyTemporary(
                            message,
                            "All five helpers must be Saiyans.",
                            10000,
                            "SSG awakening helper race response"
                        );
                    }
                }

                user.godki = user.level;
            } else if (rule.setGodKi && user.godki < 1) {
                user.godki = user.level;
            }
            setTransformation(user, form);
        }

        if (requestedForm !== "normal") awardAchievements(message, user, [`form_${requestedForm}`]);
        client.points.set(key, user);

        const transformedLevel = user.transformation;
        const transformedProgress = getLevelProgress(user);
        const isRevert = requestedForm === "normal";
        const transformEmbed = new EmbedBuilder()
            .setTitle(isRevert ? `${message.author.username} reverted to ${getCurrentFormName(user)}!` : `${message.author.username} transformed!`)
            .setDescription(isRevert ? "You reverted to your base form." : "Your active form and abilities amplify your power.")
            .setAuthor({ name: `${transformLabel(requestedForm, user.godki, user.race)}${user.kaiokenLevel > 0 ? `Kaioken x${user.kaiokenLevel} ` : ""}${message.member?.displayName || message.author.username}`, iconURL: message.author.displayAvatarURL({ extension: "png", size: 64 }) })
            .setThumbnail(message.author.displayAvatarURL({ dynamic: true, size: 256 }))
            .setColor(borderColor(form))
            .addFields(
                { name: user.godki > 0 ? ":crossed_swords:God Tier" : ":crossed_swords:Tier", value: String(user.godki > 0 ? transformedProgress.godLevel : user.level), inline: true },
                { name: "Powerlevel", value: formatPowerLevel(user.points * transformedLevel), inline: true },
                { name: "Progress", value: `${numeral(transformedProgress.difference).format("0,0")} additional power till level up` },
                { name: "Stamina", value: `${numeral(Math.floor(user.stamina)).format("0,0")} / ${numeral(MAX_STAMINA).format("0,0")}`, inline: true }
            );

        sendTemporary(message.channel, { embeds: [transformEmbed] }, 10000, "transformation result");
        return;
    }

    // Guild-owner-only utilities for administrative progression adjustments.
    if (["setlevel", "setpower", "awardpower", "reset"].includes(command)) {
        const guildOwner = message.guild.ownerId ?? null;
        if (message.author.id !== guildOwner) {
            return replyTemporary(message, "Only the server owner can use this progression command.", 10000, `${command} permission response`);
        }

        const userMention = message.mentions.users.first() || client.users.cache.get(args[0]);
        if (!userMention) {
            return replyTemporary(message, "Mention a server member or provide their user ID.", 10000, `${command} user response`);
        }

        const targetKey = `${message.guild.id}-${userMention.id}`;
        if (client.privacy.get(targetKey)) {
            return replyTemporary(message, "That user has opted out of progression tracking.", 10000, `${command} privacy response`);
        }

        if (command === "reset") {
            if (!client.points.has(targetKey)) {
                return replyTemporary(message, "That user does not have a progression profile to reset.", 10000, "reset missing-profile response");
            }
            client.points.set(targetKey, createDefaultUser(userMention.id, message.guild.id, rightNow));
            return sendTemporary(message.channel, `${userMention.tag}'s progression has been reset to a fresh profile.`, 10000, "reset confirmation");
        }

        if (command === "setlevel") {
            const setLevel = Number(args[1]);
            if (!Number.isSafeInteger(setLevel) || setLevel < 1) {
                return replyTemporary(message, "Enter a whole-number level of 1 or higher.", 10000, "setlevel validation response");
            }
            const targetUser = client.points.get(targetKey) || createDefaultUser(userMention.id, message.guild.id, rightNow);
            initializeUserProgress(targetUser);
            setUserLevel(targetUser, setLevel);
            client.points.set(targetKey, targetUser);
            return sendTemporary(message.channel, `${userMention.tag} has been set to Tier ${setLevel}.`, 10000, "setlevel confirmation");
        }

        if (command === "awardpower") {
            const awardAmount = Number(args[1]?.replaceAll(",", ""));
            if (!Number.isSafeInteger(awardAmount) || awardAmount < 1) {
                return replyTemporary(message, "Enter a positive whole-number power award.", 10000, "awardpower validation response");
            }
            const reason = args.slice(2).join(" ").trim();
            if (reason.length > 200) {
                return replyTemporary(message, "Keep the award reason to 200 characters or fewer.", 10000, "awardpower reason validation response");
            }

            const targetUser = client.points.get(targetKey) || createDefaultUser(userMention.id, message.guild.id, rightNow);
            initializeUserProgress(targetUser);
            const awardedPower = targetUser.points + awardAmount;
            if (!Number.isSafeInteger(awardedPower)) {
                return replyTemporary(message, "That award would exceed the maximum supported power value.", 10000, "awardpower overflow response");
            }

            setBasePower(targetUser, awardedPower);
            client.points.set(targetKey, targetUser);
            awardAchievements(
                { author: userMention, channel: message.channel },
                targetUser,
                getProgressAchievementIds(targetUser)
            );

            const tierLabel = targetUser.godki > 0
                ? `God Tier ${getGodTierLevel(targetUser)}`
                : `Tier ${targetUser.level}`;
            const reasonText = reason ? ` Reason: ${reason.replace(/@/g, "@\u200b")}` : "";
            return sendTemporary(
                message.channel,
                `${numeral(awardAmount).format("0,0")} base power awarded to ${userMention.tag}; their base power is now ${numeral(targetUser.points - 2500).format("0,0")} (${tierLabel}).${reasonText}`,
                10000,
                "awardpower confirmation"
            );
        }

        const setPower = Number(args[1]?.replaceAll(",", ""));
        if (!Number.isSafeInteger(setPower) || setPower < 2500) {
            return replyTemporary(message, "Enter a whole-number base power of at least 2,500.", 10000, "setpower validation response");
        }
        const targetUser = client.points.get(targetKey) || createDefaultUser(userMention.id, message.guild.id, rightNow);
        initializeUserProgress(targetUser);
        setBasePower(targetUser, setPower);
        client.points.set(targetKey, targetUser);
        const tierLabel = targetUser.godki > 0
            ? `God Tier ${getGodTierLevel(targetUser)}`
            : `Tier ${targetUser.level}`;
        return sendTemporary(
            message.channel,
            `${userMention.tag}'s base power is now ${numeral(setPower).format("0,0")} (${tierLabel}).`,
            10000,
            "setpower confirmation"
        );
    }
}

client.on("messageCreate", handleMessage);

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
        await handleInteraction(interaction);
    } catch (error) {
        console.error(`Failed to handle /${interaction.commandName}:`, error);
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply("Scouter could not complete that command. Please try again shortly.");
            } else {
                await interaction.reply({
                    content: "Scouter could not complete that command. Please try again shortly.",
                    ephemeral: true
                });
            }
        } catch (responseError) {
            console.error(`Failed to report /${interaction.commandName} error:`, responseError);
        }
    }
});

client.on("error", (error) => console.error(error));
client.on("warn", (warning) => console.warn(warning));

client.on("clientReady", async () => {
    try {
        await client.application.commands.set(SLASH_COMMANDS.map((command) => command.toJSON()));
        console.log(`[NOTICE] Registered ${SLASH_COMMANDS.length} global slash commands.`);
    } catch (error) {
        console.error("Failed to register global slash commands:", error);
    }
});

async function start() {
    try {
        if (!config.token || config.token === "REPLACE_WITH_DISCORD_TOKEN") {
            throw new Error("Missing Discord token. Set DISCORD_TOKEN in your environment or provide a local config.json that is not committed to git.");
        }

        const { default: Enmap } = await import("enmap");
        const { stringify } = await import("better-serialize");
        const databasePath = resolve(process.cwd(), "data", "enmap.sqlite");
        if (existsSync(databasePath)) {
            const database = new Database(databasePath);
            try {
                migrateLegacyEnmapData(database, stringify);
            } finally {
                database.close();
            }
        }
        client.points = new Enmap({ name: "points" });
        client.privacy = new Enmap({ name: "privacy" });
        await client.login(config.token);
    } catch (error) {
        console.error("Failed to initialize Enmap or log in to Discord:", error);
        process.exitCode = 1;
    }
}

if (require.main === module) {
    start();
}

module.exports = { client, config, handleInteraction, handleMessage, SLASH_COMMANDS };
