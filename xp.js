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
    RACE_LOCK_BASE_POWER,
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
    optInUser,
    optOutUser,
    recordMessageXp,
    recordTrainingDay,
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

        if (targetUser.id === client.user.id) {
            scanEmbed
                .setTitle("SCOUTER // SELF-SCAN")
                .setDescription("**RECURSIVE SCAN DETECTED**")
                .setColor("#08ff00")
                .addFields(
                    { name: "Power reading", value: "OVER 9,000!", inline: true },
                    { name: "Signal profile", value: "Autonomous Scouter Unit", inline: true },
                    { name: "Scan status", value: "Unreadable • Scanner cannot measure itself", inline: true },
                    { name: "Result", value: "Nice try. I do the scanning around here." }
                )
                .setFooter({
                    text: `Scouter Bot ${config.version} | ${COPYRIGHT_NOTICE} ${config.author}`,
                    iconURL: client.user.displayAvatarURL({ extension: "png", size: 64 })
                });
            await sendTemporary(message.channel, { embeds: [scanEmbed] }, 15000, "self-scan response");
            return;
        }

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
                        { name: "Signal profile", value: `${RACES[scannedUser.race].name} • ${tier} • ${getCurrentFormName(scannedUser)}`, inline: true },
                        { name: "Stamina", value: `${numeral(Math.floor(scannedUser.stamina)).format("0,0")} / ${numeral(MAX_STAMINA).format("0,0")}`, inline: true },
                        {
                            name: "Next tier",
                            value: levelProgress.difference > 0
                                ? `${formatPowerAmount(levelProgress.difference)} more power needed`
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
                { name: "/race race", value: `Choose Saiyan, Human, Namekian, or Frieza Race before reaching ${formatPowerAmount(RACE_LOCK_BASE_POWER)} base power.` },
                { name: "/transform form", value: "Change your form. Beyond God attempts to awaken God Ki at Tier 50. First-time Saiyan SSG awakening requires five distinct other Saiyan helpers." },
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
            const levelProgress = getLevelProgress(profile);
            const tier = profile.godki > 0
                ? `God Tier ${levelProgress.godLevel}`
                : `Tier ${profile.level}`;
            const stamina = Math.floor(profile.stamina);
            const profileEmbed = new EmbedBuilder()
                .setAuthor({
                    name: `${transformLabel(getCurrentForm(profile), profile.godki, profile.race)}${displayName}`,
                    iconURL: targetUser.displayAvatarURL({ extension: "png", size: 64 })
                })
                .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 256 }))
                .setTitle("Progression Profile")
                .setDescription(`**${tier}** · ${RACES[profile.race]?.name || RACES.saiyan.name}\n${getCurrentFormName(profile)}`)
                .setColor(borderColor(getCurrentForm(profile)))
                .addFields(
                    {
                        name: "⚡ Power · Base → Form",
                        value: `${formatPowerAmount(profile.points - 2500)} → ${formatPowerLevel(profile.points * profile.transformation)}`,
                        inline: true
                    },
                    {
                        name: "💪 Stamina",
                        value: `${getProgressBar(stamina, MAX_STAMINA)}\n${numeral(stamina).format("0,0")} / ${numeral(MAX_STAMINA).format("0,0")}`,
                        inline: true
                    },
                    {
                        name: "📈 Progress",
                        value: `**Next tier:**\n${getTierProgressDisplay(profile)}\n**Achievements:** ${profile.achievements.length} / ${Object.keys(ACHIEVEMENTS).length}`,
                        inline: false
                    }
                )
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
            .setDescription("Server progression at a glance")
            .setColor("#008B8B")
            .addFields(
                { name: viewerName, value: getComparisonProfileDetails(viewerProfile), inline: true },
                { name: displayName, value: getComparisonProfileDetails(profile), inline: true }
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
            return replyTemporary(message, `You're exhausted from training. Try again in ${formatCooldownRemaining(cooldownRemaining)}.`, 10000, "training cooldown response");
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
                { name: "Power gained", value: formatPowerAmount(powerGained), inline: true },
                { name: "Stamina used", value: numeral(trainingCost).format("0,0"), inline: true },
                { name: "Stamina remaining", value: `${numeral(Math.floor(user.stamina)).format("0,0")} / ${numeral(MAX_STAMINA).format("0,0")}`, inline: true },
                { name: "Current power level", value: formatPowerLevel(user.points * user.transformation), inline: true }
            )
            .setFooter({ text: "Training can be used once every 24 hours.", iconURL: client.user.displayAvatarURL({ extension: "png", size: 64 }) });

        sendTemporary(message.channel, { embeds: [trainingEmbed] }, 30000, "training result");
        sendLevelUp(message, user, levelsGained);
        return;
    }

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

client.on("interactionCreate", async (interaction) => {
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
