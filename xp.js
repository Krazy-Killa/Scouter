require("dotenv").config();

const { Client, GatewayIntentBits, EmbedBuilder, MessageFlags } = require("discord.js");
const numeral = require("numeral");
const Database = require("better-sqlite3");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const {
    ACHIEVEMENTS,
    MAX_STAMINA,
    RACES,
    addExperience,
    canEarnMessageXp,
    createDefaultUser,
    getGodTierLevel,
    getKaiokenMultiplier,
    getProgressAchievementIds,
    getTransformationMultiplier,
    getXpRequiredForLevel,
    initializeUserProgress,
    normalizeMessage,
    recordMessageXp,
    setKaiokenLevel,
    setTransformation
} = require("./progression");
const { migrateLegacyEnmapData } = require("./enmap-migration");
const { handleAdminCommand } = require("./commands/admin");
const {
    KAIOKEN_RULES,
    TRANSFORM_RULES,
    formatCooldownRemaining,
    handleTransformationCommand
} = require("./commands/transformation");
const {
    SPAR_CUSTOM_ID_PREFIX,
    handleSparButton,
    handleSparCommand,
    restoreSparChallenges
} = require("./commands/spar");
const { handleUserCommand } = require("./commands/user-commands");
const { createSlashCommands, handleSlashCommand } = require("./commands/slash-commands");
const { ERROR_RESPONSE_COLOR, toEmbedPayload } = require("./commands/response-embeds");
const { formatPowerAmount } = require("./commands/power-format");

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
    return formatPowerAmount(power);
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
        const sentMessage = await channel.send(toEmbedPayload(content));
        if (!channel.isSlashCommandResponse) {
            waitAndDelete(sentMessage, deleteAfterMs);
        }
        return sentMessage;
    } catch (error) {
        console.error(`Failed to send ${context}:`, error);
        if (channel.isSlashCommandResponse) {
            return channel.reportFailure(error, context);
        }
        return null;
    }
}

async function replyTemporary(message, content, deleteAfterMs, context) {
    try {
        const reply = await message.reply(toEmbedPayload(content));
        if (!message.isSlashCommand) {
            waitAndDelete(reply, deleteAfterMs);
        }
        return reply;
    } catch (error) {
        console.error(`Failed to send ${context}:`, error);
        if (message.isSlashCommand) {
            return message.channel.reportFailure(error, context);
        }
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

function getProgressBar(value, maximum, length = 10) {
    const progress = maximum > 0 ? Math.max(0, Math.min(1, value / maximum)) : 0;
    const status = progress >= 2 / 3 ? "🟢" : progress >= 1 / 3 ? "🟡" : "🔴";
    const filledBars = Math.round(progress * length);
    return `${status} ${"▰".repeat(filledBars)}${"▱".repeat(length - filledBars)}`;
}

function getTierProgressDisplay(user) {
    const { currentXp, nextLevelXp, difference } = getLevelProgress(user);
    const previousLevelXp = user.level > 1 ? getXpRequiredForLevel(user.level - 1) : 0;
    const tierXpRequired = nextLevelXp - previousLevelXp;
    const tierXpEarned = Math.max(0, Math.min(tierXpRequired, currentXp - previousLevelXp));
    const progress = tierXpRequired > 0 ? tierXpEarned / tierXpRequired : 1;
    const percentage = Math.round(progress * 100);

    return [
        getProgressBar(tierXpEarned, tierXpRequired),
        `${formatPowerAmount(tierXpEarned)} / ${formatPowerAmount(tierXpRequired)} (${percentage}%)`,
        difference > 0
            ? `${formatPowerAmount(difference)} power needed`
            : "Ready to advance"
    ].join("\n");
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

function getComparisonProfileDetails(user) {
    const levelProgress = getLevelProgress(user);
    const tier = user.godki > 0
        ? `God Tier ${levelProgress.godLevel}`
        : `Tier ${user.level}`;
    const stamina = Math.floor(user.stamina);
    return [
        `**${tier} · ${RACES[user.race]?.name || RACES.saiyan.name}**`,
        getCurrentFormName(user),
        "",
        "**⚡ Power · Base → Form**",
        `${formatPowerAmount(user.points - 2500)} → ${formatPowerLevel(user.points * user.transformation)}`,
        "",
        "**💪 Stamina**",
        getProgressBar(stamina, MAX_STAMINA),
        `${numeral(stamina).format("0,0")} / ${numeral(MAX_STAMINA).format("0,0")}`,
        "",
        "**📈 Progress**",
        getTierProgressDisplay(user),
        `Achievements · ${user.achievements.length} / ${Object.keys(ACHIEVEMENTS).length}`
    ].join("\n");
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

async function handleInteraction(interaction) {
    await handleSlashCommand(interaction, handleMessage);
}

async function handleMessage(message) {
    if (!message.guild || message.author.bot) return;

    const rightNow = Date.now();
    const key = `${message.guild.id}-${message.author.id}`;
    const isSlashCommand = message.isSlashCommand === true;
    if (!isSlashCommand && message.content.startsWith(legacyMessagePrefix)) return;
    const args = isSlashCommand ? message.commandArgs || [] : [];
    const command = isSlashCommand ? message.commandName : null;

    if (command === "privacy" && await handleUserCommand({
        client,
        message,
        command,
        args,
        key,
        cancelPendingNewUserNotice,
        sendTemporary
    })) return;

    if (command === "scan" && await handleUserCommand({
        client,
        message,
        command,
        args,
        key,
        now: rightNow,
        config,
        copyrightNotice: COPYRIGHT_NOTICE,
        createProfileSnapshot,
        getLevelProgress,
        getCurrentForm,
        getCurrentFormName,
        formatPowerLevel,
        borderColor,
        sendTemporary,
        replyTemporary
    })) return;

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

    if (await handleTransformationCommand({
        client,
        message,
        command,
        args,
        user,
        key,
        now: rightNow,
        config,
        copyrightNotice: COPYRIGHT_NOTICE,
        replyTemporary,
        sendTemporary,
        awardAchievements,
        getCurrentForm,
        getCurrentFormName,
        getLevelProgress,
        formatPowerLevel,
        transformationName,
        transformLabel,
        borderColor
    })) return;

    if (await handleSparCommand({ client, message, command, now: rightNow, replyTemporary })) return;

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

    const userCommandContext = {
        client,
        message,
        command,
        args,
        user,
        key,
        now: rightNow,
        config,
        copyrightNotice: COPYRIGHT_NOTICE,
        formatPowerAmount,
        createProfileSnapshot,
        getLevelProgress,
        getCurrentForm,
        getCurrentFormName,
        getProgressBar,
        getTierProgressDisplay,
        getComparisonProfileDetails,
        transformLabel,
        borderColor,
        formatPowerLevel,
        sendTemporary,
        replyTemporary,
        cancelPendingNewUserNotice,
        trainCooldownMs: TRAIN_COOLDOWN_MS,
        baseTrainingPower: BASE_TRAINING_POWER,
        transformRules: TRANSFORM_RULES,
        kaiokenRules: KAIOKEN_RULES,
        getStaminaCosts,
        getKaiokenMultiplier,
        getBaseTransformation,
        dropPowerup,
        formatCooldownRemaining,
        sendLevelUp,
        awardAchievements
    };
    if (["help", "profile", "compare", "achievements", "leaderboard", "train"].includes(command)
        && await handleUserCommand(userCommandContext)) return;

    await handleAdminCommand({
        client,
        message,
        command,
        args,
        now: rightNow,
        replyTemporary,
        sendTemporary,
        awardAchievements
    });
}

client.on("messageCreate", handleMessage);

async function handleButtonInteraction(interaction) {
    if (!interaction.customId.startsWith(`${SPAR_CUSTOM_ID_PREFIX}:`)) return;
    await handleSparButton(interaction, { client });
}

client.on("interactionCreate", async (interaction) => {
    if (interaction.isButton()) {
        try {
            await handleButtonInteraction(interaction);
        } catch (error) {
            console.error(`Failed to handle button ${interaction.customId}:`, error);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        ...toEmbedPayload("Scouter could not complete that action. Please try again shortly.", ERROR_RESPONSE_COLOR),
                        flags: MessageFlags.Ephemeral
                    });
                }
            } catch (responseError) {
                console.error("Failed to report button error:", responseError);
            }
        }
        return;
    }
    if (!interaction.isChatInputCommand()) return;
    try {
        await handleInteraction(interaction);
    } catch (error) {
        console.error(`Failed to handle /${interaction.commandName}:`, error);
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(toEmbedPayload(
                    "Scouter could not complete that command. Please try again shortly.",
                    ERROR_RESPONSE_COLOR
                ));
            } else {
                await interaction.reply({
                    ...toEmbedPayload(
                        "Scouter could not complete that command. Please try again shortly.",
                        ERROR_RESPONSE_COLOR
                    ),
                    flags: MessageFlags.Ephemeral
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
    restoreSparChallenges(client);
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
        client.sparChallenges = new Enmap({ name: "sparChallenges" });
        await client.login(config.token);
    } catch (error) {
        console.error("Failed to initialize Enmap or log in to Discord:", error);
        process.exitCode = 1;
    }
}

if (require.main === module) {
    start();
}

module.exports = {
    client,
    config,
    handleButtonInteraction,
    handleInteraction,
    handleMessage,
    SLASH_COMMANDS
};
