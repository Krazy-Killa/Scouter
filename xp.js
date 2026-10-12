require("dotenv").config();

const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const numeral = require("numeral");
const Database = require("better-sqlite3");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const {
    ACHIEVEMENTS,
    MAX_STAMINA,
    addExperience,
    canEarnMessageXp,
    createDefaultUser,
    getGodTierLevel,
    getProgressAchievementIds,
    getTransformationMultiplier,
    getXpRequiredForLevel,
    initializeUserProgress,
    normalizeMessage,
    optInUser,
    optOutUser,
    recordMessageXp,
    recordTrainingDay,
    setBasePower,
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

const config = {
    token: process.env.DISCORD_TOKEN || fileConfig.token,
    prefix: process.env.DISCORD_PREFIX || fileConfig.prefix || "!",
    version: process.env.APP_VERSION || packageVersion,
    author: process.env.APP_AUTHOR || fileConfig.author || "Krazy-Killa",
    icon: process.env.APP_ICON || fileConfig.icon || "",
    minsize: Number(process.env.MIN_MSG_SIZE ?? fileConfig.minsize ?? 2)
};

if (!config.token || config.token === "REPLACE_WITH_DISCORD_TOKEN") {
    throw new Error("Missing Discord token. Set DISCORD_TOKEN in your environment or provide a local config.json that is not committed to git.");
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent
    ]
});

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
    ssj: { minLevel: 4, trainingMultiplier: 50, trainingPenalty: 0.024, trainingCost: 500, messageDrain: 1 },
    ssj2: { minLevel: 8, trainingMultiplier: 100, trainingPenalty: 0.04, trainingCost: 1000, messageDrain: 2 },
    ssj3: { minLevel: 16, trainingMultiplier: 400, trainingPenalty: 0.06, trainingCost: 4000, messageDrain: 15 },
    ssg: { minLevel: 50, setGodKi: true, trainingMultiplier: 450, trainingPenalty: 0.1, trainingCost: 4500, messageDrain: 5 },
    ssgss: { minLevel: 64, setGodKi: true, trainingMultiplier: 500, trainingPenalty: 0.15, trainingCost: 5000, messageDrain: 10 }
};

// Presentation helpers for the transformation multiplier.
const borderColor = (form) => {
    if (form === "normal") return "#FF0000";
    if (["ssj", "ssj2", "ssj3"].includes(form)) return "#FFFF00";
    if (form === "ssg") return "#FF2400";
    if (form === "ssgss") return "#00FFFF";
    return "#08ff00";
};

function transformationName(form, godki = 0) {
    if (form === "normal") return godki > 0 ? "Beyond God" : "Normal";
    return {
        ssj: "Super Saiyan",
        ssj2: "Super Saiyan 2",
        ssj3: "Super Saiyan 3",
        ssg: "Super Saiyan God",
        ssgss: "Super Saiyan God Super Saiyan"
    }[form] || "Normal";
}

const transformLabel = (form, godki = 0) => form === "normal"
    ? ""
    : `${transformationName(form, godki)} `;

function formatPowerLevel(power) {
    return power < 100000
        ? numeral(power).format("0,0")
        : numeral(power).format("0.0a");
}

function waitAndDelete(message, ms) {
    if (!message) return;
    setTimeout(async () => {
        try {
            await message.delete();
        } catch (error) {
            if (error.code !== 10008) {
                console.error(`Failed to delete message ${message.id}:`, error);
            }
        }
    }, ms);
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
    return getTransformationMultiplier("normal", user.godki, getGodTierLevel(user) || 1);
}

function dropTransformation(user) {
    const fallbackForm = {
        ssj: "normal",
        ssj2: "ssj",
        ssj3: "ssj2",
        ssg: "normal",
        ssgss: "ssg"
    }[getCurrentForm(user)] || "normal";
    setTransformation(user, fallbackForm);
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
        `**Base power:** ${numeral(user.points - 2500).format("0,0")}`,
        `**Displayed power:** ${formatPowerLevel(user.points * user.transformation)}`,
        `**Current form:** ${transformationName(getCurrentForm(user), user.godki)}`,
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

client.on("messageCreate", async (message) => {
    if (!message.guild || message.author.bot) return;

    const rightNow = Date.now();
    const key = `${message.guild.id}-${message.author.id}`;
    const isCommand = message.content.startsWith(config.prefix);
    const args = isCommand ? message.content.slice(config.prefix.length).trim().split(/\s+/g) : [];
    const command = args.length > 0 ? args.shift().toLowerCase() : null;
    if (["help", "profile", "compare", "scan", "leaderboard", "achievements", "train", "transform", "revert", "setlevel", "setpower", "reset", "privacy"].includes(command)) {
        waitAndDelete(message, 1500);
    }

    if (command === "privacy") {
        const privacyAction = args[0] ? args[0].toLowerCase() : null;
        if (privacyAction === "optout") {
            optOutUser(client.privacy, client.points, key);
            cancelPendingNewUserNotice(message.guild.id, message.author.id);
            await sendTemporary(
                message.channel,
                `Progression tracking is off for you in this server. Your saved progression record has been deleted. Use \`${config.prefix}privacy optin\` to start fresh later.`,
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
                `Use \`${config.prefix}privacy optout\` to disable tracking and delete your saved record, or \`${config.prefix}privacy optin\` to start fresh later.`,
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
            await replyTemporary(message, `Mention a server member or provide their ID. Example: \`${config.prefix}scan @user\` or \`${config.prefix}scan user-id\`.`, 10000, "scan usage response");
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
                        { name: "Signal profile", value: `${tier} • ${transformationName(getCurrentForm(scannedUser), scannedUser.godki)}`, inline: true },
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
        if (isCommand) {
            await replyTemporary(
                message,
                `Progression tracking is off for you in this server. Use \`${config.prefix}privacy optin\` to start fresh.`,
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

    if (!isCommand) {
        if (message.content.length < config.minsize) return;

        const normalizedContent = normalizeMessage(message.content);
        if (!canEarnMessageXp(user, normalizedContent, rightNow)) return;

        // Ordinary chat grants progression XP and drains stamina while transformed.
        const form = getCurrentForm(user);
        const staminaCost = TRANSFORM_RULES[form].messageDrain;
        if (staminaCost > 0) {
            if (user.stamina <= 0) {
                dropTransformation(user);
            } else {
                user.stamina = Math.max(0, user.stamina - staminaCost);
                if (user.stamina === 0) dropTransformation(user);
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
                { name: `${config.prefix}scan [@user|user-id]`, value: "Run a power scan on yourself or another member; opted-out members cannot be scanned.", inline: true },
                { name: `${config.prefix}profile [@user]`, value: "Displays your tier, power, form, stamina, progress, and achievements, or another member's profile.", inline: true },
                { name: `${config.prefix}compare @user|user-id`, value: "Compares your progression with another server member by mention or ID.", inline: true },
                { name: `${config.prefix}leaderboard`, value: `Shows the all-time leaderboard for ${message.guild.name}; use reactions to change pages.`, inline: true },
                { name: `${config.prefix}achievements`, value: "Shows your unlocked achievements and progress.", inline: true },
                { name: `${config.prefix}privacy`, value: "Opt out of progression tracking and delete your record, or opt in again.", inline: true },
                { name: `${config.prefix}transform`, value: "Changes your form, which drains stamina as you chat." },
                { name: `${config.prefix}revert`, value: "Automatically reverts you to your normal form." },
                { name: `${config.prefix}train`, value: "Trade stamina for a large one-time power boost. Training is available once per day." },
                { name: `${config.prefix}setlevel @user <level>`, value: "Set a member's tier (server owner only)." },
                { name: `${config.prefix}setpower @user <power>`, value: "Set a member's base power and recalculate their tier (server owner only)." },
                { name: `${config.prefix}reset @user`, value: "Reset a member's progression to a fresh profile (server owner only)." }
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
            await replyTemporary(message, `Mention a server member or use \`${config.prefix}profile\` to view your own profile.`, 10000, "profile usage response");
            return;
        }
        if (command === "compare" && !targetMember) {
            await replyTemporary(message, `Mention a server member or provide their ID. Example: \`${config.prefix}compare @user\` or \`${config.prefix}compare user-id\`.`, 10000, "compare usage response");
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
                    name: `${transformLabel(getCurrentForm(profile), profile.godki)}${displayName}`,
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
                        const transformationLabel = currentForm === "normal"
                            ? ""
                            : `  •  ${transformationName(currentForm, data.godki)}`;
                        const powerLevel = formatPowerLevel(data.points * data.transformation);

                        return `${rankLabel} <@${data.userID}>\n└ ${tierLabel}${transformationLabel}  •  **${powerLevel}** power`;
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
        if (user.stamina < rule.trainingCost) {
            return replyTemporary(message, `Not enough stamina to train in ${transformationName(form, user.godki)}. You need ${numeral(rule.trainingCost).format("0,0")} stamina; you have ${numeral(Math.floor(user.stamina)).format("0,0")}.`, 10000, "training stamina response");
        }

        const rawPower = BASE_TRAINING_POWER * rule.trainingMultiplier;
        const powerGained = Math.floor(rawPower * (1 - rule.trainingPenalty));
        user.stamina = Math.max(0, user.stamina - rule.trainingCost);
        recordTrainingDay(user, rightNow);
        user.trainLastUsedAt = rightNow;
        const levelsGained = addExperience(user, powerGained);

        const droppedForm = user.stamina === 0 && user.transformation !== getBaseTransformation(user);
        if (droppedForm) dropTransformation(user);

        const trainingAchievements = ["trained_once"];
        if (user.trainingStreakDays >= 7) trainingAchievements.push("training_streak_7");
        awardAchievements(message, user, [...trainingAchievements, ...getProgressAchievementIds(user)]);
        client.points.set(key, user);

        const trainingEmbed = new EmbedBuilder()
            .setTitle(`${message.author.username} finished training!`)
            .setDescription(droppedForm
                ? "The training drained your stamina and forced you to drop a form."
                : `Training in ${transformationName(form, user.godki)} converted stamina into power.`)
            .setColor("#08ff00")
            .addFields(
                { name: "Power gained", value: numeral(powerGained).format("0,0"), inline: true },
                { name: "Stamina used", value: numeral(rule.trainingCost).format("0,0"), inline: true },
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
        await sendTemporary(
            message.channel,
            `Reverted to ${baseForm}. Your power level is now ${formatPowerLevel(user.points * user.transformation)}.`,
            10000,
            "revert confirmation"
        );
        return;
    }

    // Transformation changes require an unlocked form and available stamina.
    if (command === "transform") {
        const form = args.length > 0 ? args[0].toLowerCase() : null;

        if (!form || !Object.prototype.hasOwnProperty.call(TRANSFORM_RULES, form)) {
            const invalidTransform = new EmbedBuilder()
                .setAuthor({ name: `${transformLabel(getCurrentForm(user), user.godki)}${message.member?.displayName || message.author.username}`, iconURL: message.author.displayAvatarURL({ extension: "png", size: 64 }) })
                .setColor("#FF0000")
                .addFields(
                    { name: "Error!", value: "Additional arguments required!" },
                    { name: "Valid arguments are:", value: "`normal` (Normal/Beyond God), `ssj` (Super Saiyan), `ssj2` (Super Saiyan 2), `ssj3` (Super Saiyan 3), `ssg` (Super Saiyan God), `ssgss` (Super Saiyan God Super Saiyan)." }
                )
                .setFooter({ text: `Scouter Bot ${config.version} | ${COPYRIGHT_NOTICE} ${config.author}`, iconURL: client.user.displayAvatarURL({ extension: "png", size: 64 }) });

            sendTemporary(message.channel, { embeds: [invalidTransform] }, 10000, "invalid transformation response");
            return;
        }

        const rule = TRANSFORM_RULES[form];
        if (user.level < rule.minLevel) {
            const lowLevelWarning = new EmbedBuilder()
                .setAuthor({ name: `${transformLabel(getCurrentForm(user), user.godki)}${message.member?.displayName || message.author.username}`, iconURL: message.author.displayAvatarURL({ extension: "png", size: 64 }) })
                .setThumbnail(message.author.displayAvatarURL({ dynamic: true, size: 256 }))
                .setColor("#FF0000")
                .addFields({ name: "Level too low!", value: "Additional power required to transform." });

            sendTemporary(message.channel, { embeds: [lowLevelWarning] }, 10000, "level requirement response");
            return;
        }

        if (form !== "normal" && user.stamina <= 0) {
            return replyTemporary(message, "You're out of stamina and need to recover before transforming.", 10000, "transformation stamina response");
        }

        if (form === "normal") {
            setTransformation(user, "normal");
        } else {
            if (rule.setGodKi && user.godki < 1) user.godki = user.level;
            setTransformation(user, form);
        }

        if (form !== "normal") awardAchievements(message, user, [`form_${form}`]);
        client.points.set(key, user);

        const transformedLevel = user.transformation;
        const transformedProgress = getLevelProgress(user);
        const transformEmbed = new EmbedBuilder()
            .setTitle(form !== "normal" ? `${message.author.username} transformed!` : `${message.author.username} reverted to ${transformationName(form, user.godki)}!`)
            .setDescription(form !== "normal" ? "Transformations amplify your power depending on the form you choose!" : "You reverted to your base form.")
            .setAuthor({ name: `${transformLabel(form, user.godki)}${message.member?.displayName || message.author.username}`, iconURL: message.author.displayAvatarURL({ extension: "png", size: 64 }) })
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
    if (["setlevel", "setpower", "reset"].includes(command)) {
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
});

client.on("error", (error) => console.error(error));
client.on("warn", (warning) => console.warn(warning));

import("enmap")
    .then(async ({ default: Enmap }) => {
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
        return client.login(config.token);
    })
    .catch((error) => {
        console.error("Failed to initialize Enmap or log in to Discord:", error);
        process.exitCode = 1;
    });
