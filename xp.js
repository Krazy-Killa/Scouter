require("dotenv").config();

const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const numeral = require("numeral");
const Enmap = require("enmap");

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
    version: process.env.APP_VERSION || fileConfig.version || "0.2.0",
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
        GatewayIntentBits.MessageContent
    ]
});

client.points = new Enmap({ name: "points" });

// Progression and stamina balance values. Displayed power still uses lore multipliers.
const MAX_STAMINA = 10000;
const STAMINA_REGEN_PER_DAY = 2000;
const BASE_MESSAGE_XP = 400;
const MESSAGE_XP_VARIANCE = 200;
const BASE_TRAINING_POWER = 5000;
const TRAIN_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const BASE_LEVEL_XP = 5000;
const LEVEL_XP_FACTOR = 3000;
const STAMINA_REGEN_PER_MS = STAMINA_REGEN_PER_DAY / (24 * 60 * 60 * 1000);

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

function createDefaultUser(authorId, guildId, now = Date.now()) {
    return {
        userID: authorId,
        guildID: guildId,
        points: 2500,
        level: 1,
        transformation: 1,
        godki: 0,
        stamina: MAX_STAMINA,
        staminaUpdatedAt: now,
        trainLastUsedAt: 0
    };
}

function waitAndDelete(message, ms) {
    if (!message || !message.deletable) return;
    setTimeout(() => {
        message.delete().catch(() => {});
    }, ms);
}

function getXpRequiredForLevel(level) {
    // XP is cumulative: the returned value is the amount needed to advance from this level.
    return level * BASE_LEVEL_XP + LEVEL_XP_FACTOR * level * (level + 1) * (2 * level + 1) / 6;
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

function addExperience(user, amount) {
    user.points += amount;
    let levelsGained = 0;

    while (user.points - 2500 >= getXpRequiredForLevel(user.level)) {
        user.level += 1;
        levelsGained += 1;
    }

    return levelsGained;
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
            { name: "Powerlevel", value: numeral(user.points * user.transformation).format("0.0a"), inline: true },
            { name: "Levels gained", value: String(levelsGained), inline: true }
        )
        .setFooter({ text: `Scouter Bot ${config.version} | © 2019 ${config.author}`, iconURL: config.icon });

    message.channel.send({ embeds: [levelUpEmbed] }).then((sent) => waitAndDelete(sent, 30000));
}

client.on("ready", () => {
    console.log(`[NOTICE] Bot has started, with ${client.users.cache.size} users, in ${client.channels.cache.size} channels of ${client.guilds.cache.size} guilds.`);
});

client.on("messageCreate", async (message) => {
    if (!message.guild || message.author.bot) return;

    // Load or initialize one guild-scoped record, then persist stamina recovery.
    const rightNow = Date.now();
    const key = `${message.guild.id}-${message.author.id}`;
    let user = client.points.get(key);

    if (!user) {
        user = createDefaultUser(message.author.id, message.guild.id, rightNow);

        const newUser = new EmbedBuilder()
            .setTitle("New User Found!")
            .setDescription(`Calculating your power ${message.author.username}:`)
            .setThumbnail(message.author.displayAvatarURL({ dynamic: true, size: 256 }))
            .setColor("#08ff00")
            .addFields(
                { name: ":crossed_swords:Your Tier", value: String(user.level), inline: true },
                { name: "Powerlevel", value: numeral(user.points * user.transformation).format("0.0a"), inline: true }
            );

        message.channel.send({ embeds: [newUser] }).then((sent) => waitAndDelete(sent, 5000));
    }

    recoverStamina(user, rightNow);
    client.points.set(key, user);

    const isCommand = message.content.startsWith(config.prefix);
    const args = isCommand ? message.content.slice(config.prefix.length).trim().split(/\s+/g) : [];
    const command = args.length > 0 ? args.shift().toLowerCase() : null;

    if (!isCommand) {
        if (message.content.length < config.minsize) return;

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

        const messageXp = BASE_MESSAGE_XP + Math.floor(Math.random() * (MESSAGE_XP_VARIANCE + 1));
        const levelsGained = addExperience(user, messageXp);
        client.points.set(key, user);

        sendLevelUp(message, user, levelsGained);
    }

    const levelInfo = getLevelProgress(user);

    // Read-only commands report the user's current progression and guild rankings.
    if (command === "help") {
        waitAndDelete(message, 1500);
        const help = new EmbedBuilder()
            .setTitle("Command List")
            .addFields(
                { name: `${config.prefix}info`, value: "Displays your current power reading and tier level, and how much more you need to advance to the next tier.", inline: true },
                { name: `${config.prefix}leaderboard`, value: `Shows the current leaderboard for ${message.guild.name}.`, inline: true },
                { name: `${config.prefix}transform`, value: "Changes your form, which drains stamina as you chat." },
                { name: `${config.prefix}train`, value: "Trade stamina for a large one-time power boost. Training is available once per day." }
            )
            .setColor("#008B8B")
            .setFooter({ text: `Scouter Bot ${config.version} | © 2019 ${config.author}`, iconURL: config.icon });

        client.points.set(key, user);
        message.channel.send({ embeds: [help] }).then((sent) => waitAndDelete(sent, 30000));
        return;
    }

    if (command === "info") {
        waitAndDelete(message, 1500);
        client.points.set(key, user);

        const infoEmbed = new EmbedBuilder()
            .setTitle("Displaying Current Tier & Power")
            .setAuthor({ name: `${transformLabel(user.transformation)} ${message.author.username}`, iconURL: config.icon })
            .setThumbnail(message.author.displayAvatarURL({ dynamic: true, size: 256 }))
            .setColor(borderColor(user.transformation))
            .addFields(
                { name: user.godki > 0 ? ":crossed_swords:God Tier" : ":crossed_swords:Tier", value: String(user.godki > 0 ? levelInfo.godLevel : user.level), inline: true },
                { name: "Powerlevel", value: `${numeral((user.points * user.transformation)).format("0.0a")}`, inline: true },
                { name: "Power per message:", value: `${numeral(BASE_MESSAGE_XP)}–${numeral(BASE_MESSAGE_XP + MESSAGE_XP_VARIANCE)} power.` },
                { name: "Stamina", value: `${numeral(Math.floor(user.stamina)).format("0,0")} / ${numeral(MAX_STAMINA).format("0,0")}`, inline: true }
            );

        if (levelInfo.difference <= 0) {
            infoEmbed.setFooter({ text: "You're about to ascend to the next level! Congratulations!", iconURL: "https://www.stickpng.com/assets/images/5a81af7d9123fa7bcc9b0793.png" });
        } else {
            infoEmbed.setFooter({ text: `${numeral(levelInfo.difference).format("0,0")} additional power needed to reach the next tier!`, iconURL: "https://www.stickpng.com/assets/images/5a81af7d9123fa7bcc9b0793.png" });
        }

        message.channel.send({ embeds: [infoEmbed] }).then((sent) => waitAndDelete(sent, 12500));
        return;
    }

    if (command === "leaderboard") {
        waitAndDelete(message, 1500);
        client.points.set(key, user);

        const filtered = client.points.filterArray((p) => p.guildID === message.guild.id);
        const sorted = filtered.sort((a, b) => b.points * b.transformation - a.points * a.transformation);
        const top10 = sorted.slice(0, 10);

        const embed = new EmbedBuilder()
            .setTitle(`${message.guild.name} Leaderboard`)
            .setAuthor({ name: client.user.username, iconURL: client.user.displayAvatarURL({ dynamic: true, size: 256 }) })
            .setDescription("Our top 10 strongest members!")
            .setFooter({ text: `Scouter Bot ${config.version} | © 2019 ${config.author}`, iconURL: config.icon })
            .setColor(0x00ae86);

        let i = 0;
        let ig = 0;
        for (const data of top10) {
            const member = client.users.cache.get(data.userID);
            if (!member) continue;

            if (data.godki > 0) {
                ig += 1;
                embed.addFields({ name: `${ig}. ${member.tag}`, value: `**God Tier Level**: ${(data.level - data.godki + 1)}\n**Powerlevel**: ${numeral(data.points * data.transformation).format("0.0a")}`, inline: true });
            } else {
                i += 1;
                embed.addFields({ name: `${i}. ${member.tag}`, value: `**Tier Level**: ${data.level}\n**Powerlevel**: ${numeral(data.points * data.transformation).format("0.0a")}`, inline: true });
            }
        }

        message.channel.send({ embeds: [embed] }).then((sent) => waitAndDelete(sent, 30000));
        return;
    }

    // Training trades stamina for a once-daily power reward.
    if (command === "train") {
        const cooldownRemaining = TRAIN_COOLDOWN_MS - (rightNow - user.trainLastUsedAt);
        if (cooldownRemaining > 0) {
            const hoursRemaining = Math.ceil(cooldownRemaining / (60 * 60 * 1000));
            return message.reply(`You're exhausted from training. Try again in about ${hoursRemaining} hour(s).`);
        }

        const form = getCurrentForm(user);
        const rule = TRANSFORM_RULES[form];
        if (user.stamina < rule.trainingCost) {
            return message.reply(`Not enough stamina to train in ${form.toUpperCase()}. You need ${numeral(rule.trainingCost).format("0,0")} stamina; you have ${numeral(Math.floor(user.stamina)).format("0,0")}.`);
        }

        const rawPower = BASE_TRAINING_POWER * rule.trainingMultiplier;
        const powerGained = Math.floor(rawPower * (1 - rule.trainingPenalty));
        user.stamina = Math.max(0, user.stamina - rule.trainingCost);
        user.trainLastUsedAt = rightNow;
        const levelsGained = addExperience(user, powerGained);

        const droppedForm = user.stamina === 0 && user.transformation !== getBaseTransformation(user);
        if (droppedForm) dropTransformation(user);

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
                { name: "Current power level", value: numeral(user.points * user.transformation).format("0.0a"), inline: true }
            )
            .setFooter({ text: "Training can be used once every 24 hours." });

        message.channel.send({ embeds: [trainingEmbed] });
        sendLevelUp(message, user, levelsGained);
        return;
    }

    // Transformation changes require an unlocked form and available stamina.
    if (command === "transform") {
        const form = args.length > 0 ? args[0].toLowerCase() : null;
        waitAndDelete(message, 2000);

        if (!form || !Object.prototype.hasOwnProperty.call(TRANSFORM_RULES, form)) {
            const invalidTransform = new EmbedBuilder()
                .setAuthor({ name: `${transformLabel(user.transformation)} ${message.author.username}`, iconURL: config.icon })
                .setColor("#FF0000")
                .addFields(
                    { name: "Error!", value: "Additional arguments required!" },
                    { name: "Valid arguments are:", value: "Normal, SSJ, SSJ2, SSJ3, SSG, SSGSS" }
                )
                .setFooter({ text: `Scouter Bot ${config.version} | © 2019 ${config.author}`, iconURL: config.icon });

            message.channel.send({ embeds: [invalidTransform] }).then((sent) => waitAndDelete(sent, 10000));
            return;
        }

        const rule = TRANSFORM_RULES[form];
        if (user.godki > 0 && !rule.allowGod && form !== "ssgss") {
            const godTierWarning = new EmbedBuilder()
                .setAuthor({ name: `${transformLabel(user.transformation)} ${message.author.username}`, iconURL: config.icon })
                .setThumbnail(message.author.displayAvatarURL({ dynamic: true, size: 256 }))
                .setColor("#FF0000")
                .addFields({ name: "You've ascended to god tier.", value: "These transformations are no longer relevant to you anymore." });

            message.channel.send({ embeds: [godTierWarning] }).then((sent) => waitAndDelete(sent, 10000));
            return;
        }

        if (user.level < rule.minLevel) {
            const lowLevelWarning = new EmbedBuilder()
                .setAuthor({ name: `${transformLabel(user.transformation)} ${message.author.username}`, iconURL: config.icon })
                .setThumbnail(message.author.displayAvatarURL({ dynamic: true, size: 256 }))
                .setColor("#FF0000")
                .addFields({ name: "Level too low!", value: "Additional power required to transform." });

            message.channel.send({ embeds: [lowLevelWarning] }).then((sent) => waitAndDelete(sent, 10000));
            return;
        }

        if (form !== "normal" && user.stamina <= 0) {
            return message.reply("You're out of stamina and need to recover before transforming.");
        }

        if (form === "normal") {
            user.transformation = user.godki > 0 ? 80000 : 1;
        } else {
            if (rule.setGodKi && user.godki < 1) user.godki = user.level;
            user.transformation = rule.target;
        }

        client.points.set(key, user);

        const transformedLevel = user.transformation;
        const transformedProgress = getLevelProgress(user);
        const transformEmbed = new EmbedBuilder()
            .setTitle(form !== "normal" ? `${message.author.username} transformed!` : `${message.author.username} reverted to normal!`)
            .setDescription(form !== "normal" ? "Transformations amplify your power depending on the form you choose!" : "You reverted to your base form.")
            .setAuthor({ name: `${transformLabel(transformedLevel)} ${message.author.username}`, iconURL: config.icon })
            .setThumbnail(message.author.displayAvatarURL({ dynamic: true, size: 256 }))
            .setColor(borderColor(transformedLevel))
            .addFields(
                { name: user.godki > 0 ? ":crossed_swords:God Tier" : ":crossed_swords:Tier", value: String(user.godki > 0 ? transformedProgress.godLevel : user.level), inline: true },
                { name: "Powerlevel", value: `${numeral((user.points * transformedLevel)).format("0.0a")}`, inline: true },
                { name: "Progress", value: `${numeral(transformedProgress.difference).format("0,0")} additional power till level up` },
                { name: "Stamina", value: `${numeral(Math.floor(user.stamina)).format("0,0")} / ${numeral(MAX_STAMINA).format("0,0")}`, inline: true }
            );

        message.channel.send({ embeds: [transformEmbed] }).then((sent) => waitAndDelete(sent, 10000));
        return;
    }

    // Guild-owner-only utility for administrative level adjustments.
    if (command === "setlevel") {
        const guildOwner = message.guild.ownerId ?? null;
        if (message.author.id !== guildOwner) {
            return message.reply("You're not the boss of me, you can't do that!");
        }

        const userMention = message.mentions.users.first() || client.users.cache.get(args[0]);
        if (!userMention) return message.reply("You must mention someone or give their ID!");

        const setLevel = Number.parseInt(args[1], 10);
        if (!Number.isInteger(setLevel) || setLevel < 1) return message.reply("Enter a level of 1 or higher.");

        const targetKey = `${message.guild.id}-${userMention.id}`;
        const targetUser = client.points.get(targetKey) || createDefaultUser(userMention.id, message.guild.id, rightNow);
        targetUser.level = setLevel;
        client.points.set(targetKey, targetUser);
        message.channel.send(`${userMention.tag} has been set to ${setLevel}.`);
        return;
    }
});

client.on("error", (error) => console.error(error));
client.on("warn", (warning) => console.warn(warning));

client.login(config.token);
