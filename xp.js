require("dotenv").config();

const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const numeral = require("numeral");
const Enmap = require("enmap");
const {
    ACHIEVEMENTS,
    MAX_STAMINA,
    addExperience,
    canEarnMessageXp,
    createDefaultUser,
    getProgressAchievementIds,
    getXpRequiredForLevel,
    initializeUserProgress,
    normalizeMessage,
    optInUser,
    optOutUser,
    recordMessageXp,
    recordTrainingDay
} = require("./progression");

// Local config.json is optional; environment variables take precedence.
let fileConfig = {};
try {
    fileConfig = require("./config.json");
} catch (error) {
    fileConfig = {};
}

const config = {
    token: process.env.DISCORD_TOKEN || fileConfig.token,
    prefix: process.env.DISCORD_PREFIX || fileConfig.prefix || "!",
    version: process.env.APP_VERSION || fileConfig.version || "0.3.0",
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

client.points = new Enmap({ name: "points" });
client.privacy = new Enmap({ name: "privacy" });

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
    normal: { target: 1, minLevel: 1, allowGod: true, trainingMultiplier: 1, trainingPenalty: 0, trainingCost: 10, messageDrain: 0 },
    ssj: { target: 50, minLevel: 4, allowGod: false, trainingMultiplier: 50, trainingPenalty: 0.024, trainingCost: 500, messageDrain: 1 },
    ssj2: { target: 100, minLevel: 8, allowGod: false, trainingMultiplier: 100, trainingPenalty: 0.04, trainingCost: 1000, messageDrain: 2 },
    ssj3: { target: 400, minLevel: 16, allowGod: false, trainingMultiplier: 400, trainingPenalty: 0.06, trainingCost: 4000, messageDrain: 4 },
    ssg: { target: 160000, minLevel: 50, allowGod: true, setGodKi: true, trainingMultiplier: 450, trainingPenalty: 0.1, trainingCost: 4500, messageDrain: 5 },
    ssgss: { target: 8000000, minLevel: 64, allowGod: true, trainingMultiplier: 500, trainingPenalty: 0.15, trainingCost: 5000, messageDrain: 10 }
};

const TRANSFORMATION_FALLBACKS = {
    50: 1,
    100: 50,
    400: 100,
    160000: 80000,
    8000000: 160000
};

// Presentation helpers for the transformation multiplier.
const borderColor = (x) => {
    if (x === 1 || x === 80000) return "#FF0000";
    if (x === 50 || x === 100 || x === 400) return "#FFFF00";
    if (x === 160000) return "#FF2400";
    if (x === 8000000) return "#00FFFF";
    return "#08ff00";
};

const transformLabel = (x) => {
    if (x === 1 || x === 80000) return "";
    if (x === 50) return "SSJ";
    if (x === 100) return "SSJ2";
    if (x === 400) return "SSJ3";
    if (x === 160000) return "SSG";
    if (x === 8000000) return "SSGSS";
    return "";
};

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
    return user.godki > 0 ? 80000 : 1;
}

function dropTransformation(user) {
    user.transformation = TRANSFORMATION_FALLBACKS[user.transformation] || getBaseTransformation(user);
}

function getCurrentForm(user) {
    if (user.godki > 0 && user.transformation === 80000) return "normal";
    return Object.keys(TRANSFORM_RULES).find((form) => TRANSFORM_RULES[form].target === user.transformation) || "normal";
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
        .setFooter({ text: `Scouter Bot ${config.version} | © 2019 ${config.author}`, iconURL: client.user.displayAvatarURL({ extension: "png", size: 64 }) });

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

        const totalTracked = client.points.filterArray((record) => record.guildID === guildId).length;
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
    if (["help", "info", "leaderboard", "achievements", "train", "transform", "setlevel", "privacy"].includes(command)) {
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

    const levelInfo = getLevelProgress(user);

    // Read-only commands report the user's current progression and guild rankings.
    if (command === "help") {
        const help = new EmbedBuilder()
            .setTitle("Command List")
            .addFields(
                { name: `${config.prefix}info`, value: "Displays your current power reading and tier level, and how much more you need to advance to the next tier.", inline: true },
                { name: `${config.prefix}leaderboard`, value: `Shows the all-time leaderboard for ${message.guild.name}; use reactions to change pages.`, inline: true },
                { name: `${config.prefix}achievements`, value: "Shows your unlocked achievements and progress.", inline: true },
                { name: `${config.prefix}privacy`, value: "Opt out of progression tracking and delete your record, or opt in again.", inline: true },
                { name: `${config.prefix}transform`, value: "Changes your form, which drains stamina as you chat." },
                { name: `${config.prefix}train`, value: "Trade stamina for a large one-time power boost. Training is available once per day." }
            )
            .setColor("#008B8B")
            .setFooter({ text: `Scouter Bot ${config.version} | © 2019 ${config.author}`, iconURL: client.user.displayAvatarURL({ extension: "png", size: 64 }) });

        client.points.set(key, user);
        sendTemporary(message.channel, { embeds: [help] }, 30000, "help response");
        return;
    }

    if (command === "info") {
        client.points.set(key, user);

        const infoEmbed = new EmbedBuilder()
            .setTitle("Displaying Current Tier & Power")
            .setAuthor({ name: `${transformLabel(user.transformation)} ${message.author.username}`, iconURL: message.author.displayAvatarURL({ extension: "png", size: 64 }) })
            .setThumbnail(message.author.displayAvatarURL({ dynamic: true, size: 256 }))
            .setColor(borderColor(user.transformation))
            .addFields(
                { name: user.godki > 0 ? ":crossed_swords:God Tier" : ":crossed_swords:Tier", value: String(user.godki > 0 ? levelInfo.godLevel : user.level), inline: true },
                { name: "Powerlevel", value: formatPowerLevel(user.points * user.transformation), inline: true },
                { name: "Power per message:", value: `${numeral(BASE_MESSAGE_XP).format("0,0")}–${numeral(Math.floor((BASE_MESSAGE_XP + MESSAGE_XP_VARIANCE) * (1 + MESSAGE_LENGTH_BONUS))).format("0,0")} power, based on message length.` },
                { name: "Stamina", value: `${numeral(Math.floor(user.stamina)).format("0,0")} / ${numeral(MAX_STAMINA).format("0,0")}`, inline: true }
            );

        if (levelInfo.difference <= 0) {
            infoEmbed.setFooter({ text: "You're about to ascend to the next level! Congratulations!", iconURL: client.user.displayAvatarURL({ extension: "png", size: 64 }) });
        } else {
            infoEmbed.setFooter({ text: `${numeral(levelInfo.difference).format("0,0")} additional power needed to reach the next tier!`, iconURL: client.user.displayAvatarURL({ extension: "png", size: 64 }) });
        }

        sendTemporary(message.channel, { embeds: [infoEmbed] }, 12500, "info response");
        return;
    }

    if (command === "achievements") {
        const unlocked = new Set(user.achievements);
        const achievementList = Object.entries(ACHIEVEMENTS)
            .map(([id, achievement]) => `${unlocked.has(id) ? "🏅" : "🔒"} **${achievement.name}** — ${achievement.description}`)
            .join("\n");
        const achievementEmbed = new EmbedBuilder()
            .setTitle(`${message.author.username}'s Achievements`)
            .setDescription(achievementList)
            .setColor("#FFD700")
            .setFooter({ text: `${user.achievements.length} / ${Object.keys(ACHIEVEMENTS).length} unlocked` });

        sendTemporary(message.channel, { embeds: [achievementEmbed] }, 30000, "achievements response");
        return;
    }

    if (command === "leaderboard") {
        client.points.set(key, user);

        const filtered = client.points.filterArray((p) => p.guildID === message.guild.id);
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
                        const powerLevel = formatPowerLevel(data.points * data.transformation);

                        return `${rankLabel} <@${data.userID}>\n└ ${tierLabel}  •  **${powerLevel}** power`;
                    }).join("\n\n"),
                    inline: true
                }));

            return new EmbedBuilder()
                .setTitle("🏆 Power Rankings")
                .setDescription(`**${message.guild.name}**\nAll-time power rankings • Page ${page} of ${totalPages} • ${sorted.length} members`)
                .addFields(rankingColumns.length > 0
                    ? rankingColumns
                    : [{ name: "No rankings yet", value: "Start chatting to earn power!" }])
                .setFooter({ text: `Scouter Bot ${config.version} | © 2019 ${config.author}`, iconURL: client.user.displayAvatarURL({ extension: "png", size: 64 }) })
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
            return replyTemporary(message, `Not enough stamina to train in ${form.toUpperCase()}. You need ${numeral(rule.trainingCost).format("0,0")} stamina; you have ${numeral(Math.floor(user.stamina)).format("0,0")}.`, 10000, "training stamina response");
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
                : `Training in ${form.toUpperCase()} converted stamina into power.`)
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

    // Transformation changes require an unlocked form and available stamina.
    if (command === "transform") {
        const form = args.length > 0 ? args[0].toLowerCase() : null;

        if (!form || !Object.prototype.hasOwnProperty.call(TRANSFORM_RULES, form)) {
            const invalidTransform = new EmbedBuilder()
                .setAuthor({ name: `${transformLabel(user.transformation)} ${message.author.username}`, iconURL: message.author.displayAvatarURL({ extension: "png", size: 64 }) })
                .setColor("#FF0000")
                .addFields(
                    { name: "Error!", value: "Additional arguments required!" },
                    { name: "Valid arguments are:", value: "Normal, SSJ, SSJ2, SSJ3, SSG, SSGSS" }
                )
                .setFooter({ text: `Scouter Bot ${config.version} | © 2019 ${config.author}`, iconURL: client.user.displayAvatarURL({ extension: "png", size: 64 }) });

            sendTemporary(message.channel, { embeds: [invalidTransform] }, 10000, "invalid transformation response");
            return;
        }

        const rule = TRANSFORM_RULES[form];
        if (user.godki > 0 && !rule.allowGod && form !== "ssgss") {
            const godTierWarning = new EmbedBuilder()
                .setAuthor({ name: `${transformLabel(user.transformation)} ${message.author.username}`, iconURL: message.author.displayAvatarURL({ extension: "png", size: 64 }) })
                .setThumbnail(message.author.displayAvatarURL({ dynamic: true, size: 256 }))
                .setColor("#FF0000")
                .addFields({ name: "You've ascended to god tier.", value: "These transformations are no longer relevant to you anymore." });

            sendTemporary(message.channel, { embeds: [godTierWarning] }, 10000, "god-tier transformation response");
            return;
        }

        if (user.level < rule.minLevel) {
            const lowLevelWarning = new EmbedBuilder()
                .setAuthor({ name: `${transformLabel(user.transformation)} ${message.author.username}`, iconURL: message.author.displayAvatarURL({ extension: "png", size: 64 }) })
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
            user.transformation = user.godki > 0 ? 80000 : 1;
        } else {
            if (rule.setGodKi && user.godki < 1) user.godki = user.level;
            user.transformation = rule.target;
        }

        if (form !== "normal") awardAchievements(message, user, [`form_${form}`]);
        client.points.set(key, user);

        const transformedLevel = user.transformation;
        const transformedProgress = getLevelProgress(user);
        const transformEmbed = new EmbedBuilder()
            .setTitle(form !== "normal" ? `${message.author.username} transformed!` : `${message.author.username} reverted to normal!`)
            .setDescription(form !== "normal" ? "Transformations amplify your power depending on the form you choose!" : "You reverted to your base form.")
            .setAuthor({ name: `${transformLabel(transformedLevel)} ${message.author.username}`, iconURL: message.author.displayAvatarURL({ extension: "png", size: 64 }) })
            .setThumbnail(message.author.displayAvatarURL({ dynamic: true, size: 256 }))
            .setColor(borderColor(transformedLevel))
            .addFields(
                { name: user.godki > 0 ? ":crossed_swords:God Tier" : ":crossed_swords:Tier", value: String(user.godki > 0 ? transformedProgress.godLevel : user.level), inline: true },
                { name: "Powerlevel", value: formatPowerLevel(user.points * transformedLevel), inline: true },
                { name: "Progress", value: `${numeral(transformedProgress.difference).format("0,0")} additional power till level up` },
                { name: "Stamina", value: `${numeral(Math.floor(user.stamina)).format("0,0")} / ${numeral(MAX_STAMINA).format("0,0")}`, inline: true }
            );

        sendTemporary(message.channel, { embeds: [transformEmbed] }, 10000, "transformation result");
        return;
    }

    // Guild-owner-only utility for administrative level adjustments.
    if (command === "setlevel") {
        const guildOwner = message.guild.ownerId ?? null;
        if (message.author.id !== guildOwner) {
            return replyTemporary(message, "You're not the boss of me, you can't do that!", 10000, "setlevel permission response");
        }

        const userMention = message.mentions.users.first() || client.users.cache.get(args[0]);
        if (!userMention) return replyTemporary(message, "You must mention someone or give their ID!", 10000, "setlevel user response");

        const setLevel = Number.parseInt(args[1], 10);
        if (!Number.isInteger(setLevel) || setLevel < 1) return replyTemporary(message, "Enter a level of 1 or higher.", 10000, "setlevel validation response");

        const targetKey = `${message.guild.id}-${userMention.id}`;
        if (client.privacy.get(targetKey)) {
            return replyTemporary(message, "That user has opted out of progression tracking.", 10000, "setlevel privacy response");
        }
        const targetUser = client.points.get(targetKey) || createDefaultUser(userMention.id, message.guild.id, rightNow);
        targetUser.level = setLevel;
        client.points.set(targetKey, targetUser);
        sendTemporary(message.channel, `${userMention.tag} has been set to ${setLevel}.`, 10000, "setlevel confirmation");
        return;
    }
});

client.on("error", (error) => console.error(error));
client.on("warn", (warning) => console.warn(warning));

client.login(config.token);
