const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const numeral = require("numeral");
const Enmap = require("enmap");

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

const TRANSFORM_RULES = {
    normal: { target: 1, minLevel: 1, allowGod: true },
    ssj: { target: 50, minLevel: 4, allowGod: false },
    ssj2: { target: 100, minLevel: 8, allowGod: false },
    ssj3: { target: 400, minLevel: 16, allowGod: false },
    ssg: { target: 160000, minLevel: 50, allowGod: true, setGodKi: true },
    ssgss: { target: 8000000, minLevel: 64, allowGod: true }
};

const DEMOTION_RULES = [
    { when: (user, now) => user.godki > 0 && user.transformation === 8000000 && now - user.lastSeen > 30000, apply: (user) => { user.transformation = 160000; } },
    { when: (user, now) => user.godki > 0 && user.transformation === 160000 && now - user.lastSeen > 60000, apply: (user) => { user.transformation = 80000; } },
    { when: (user, now) => user.godki < 1 && user.transformation === 400 && now - user.lastSeen > 120000, apply: (user) => { user.transformation = 100; } },
    { when: (user, now) => user.godki < 1 && user.transformation === 100 && now - user.lastSeen > 300000, apply: (user) => { user.transformation = 50; } },
    { when: (user, now) => user.godki < 1 && user.transformation === 50 && now - user.lastSeen > 600000, apply: (user) => { user.transformation = 1; } }
];

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

function createDefaultUser(authorId, guildId, lastSeen = Date.now()) {
    return {
        userID: authorId,
        guildID: guildId,
        points: 2500,
        level: 1,
        transformation: 1,
        godki: 0,
        lastSeen
    };
}

function applyDecay(user, now) {
    for (const rule of DEMOTION_RULES) {
        if (rule.when(user, now)) {
            rule.apply(user);
            return true;
        }
    }
    return false;
}

function waitAndDelete(message, ms) {
    if (!message || !message.deletable) return;
    setTimeout(() => {
        message.delete().catch(() => {});
    }, ms);
}

function getLevelProgress(user) {
    const godLevel = user.godki > 0 ? user.level - user.godki + 1 : 0;
    const curXP = user.points - 2500;
    const nxtLvl = Math.ceil(Math.pow((user.level + 1), 2.5) * (104.167 * Math.sqrt(user.level * (godLevel + 1))));
    return { godLevel, curXP, nxtLvl };
}

client.on("ready", () => {
    console.log(`[NOTICE] Bot has started, with ${client.users.cache.size} users, in ${client.channels.cache.size} channels of ${client.guilds.cache.size} guilds.`);
});

client.on("messageCreate", async (message) => {
    if (!message.guild || message.author.bot) return;

    const rightNow = Date.now();
    const key = `${message.guild.id}-${message.author.id}`;
    let user = client.points.get(key);

    if (!user) {
        user = createDefaultUser(message.author.id, message.guild.id, rightNow);
        client.points.set(key, user);

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

    applyDecay(user, rightNow);

    const isCommand = message.content.startsWith(config.prefix);
    const args = isCommand ? message.content.slice(config.prefix.length).trim().split(/\s+/g) : [];
    const command = args.length > 0 ? args.shift().toLowerCase() : null;

    const levelExp = (((Math.sqrt(user.level) + 1) * (Math.floor(Math.random() * 187.5) + 437.5)) / (user.level + 1)) * (user.transformation / user.level);

    if (!isCommand) {
        if (message.content.length < config.minsize) return;
        user.points = Math.floor(user.points + levelExp);
        client.points.set(key, user);
    }

    const levelInfo = getLevelProgress(user);

    if (!isCommand && levelInfo.nxtLvl <= levelInfo.curXP) {
        user.level += 1;
        client.points.set(key, user);

        const levelUpEmbed = new EmbedBuilder()
            .setTitle("Level Up!")
            .setDescription(user.godki > 0
                ? `Congratulations to ${message.author} for reaching God Tier ${levelInfo.godLevel + 1}`
                : `Congratulations to ${message.author} for reaching Tier ${user.level}`)
            .setThumbnail(message.author.displayAvatarURL({ dynamic: true, size: 256 }))
            .setColor("#08ff00")
            .addFields(
                { name: user.godki > 0 ? ":crossed_swords:New God Tier" : ":crossed_swords:New Tier", value: String(user.godki > 0 ? levelInfo.godLevel + 1 : user.level), inline: true },
                { name: "Powerlevel", value: numeral((user.points * user.transformation)).format("0.0a"), inline: true },
                { name: "They will gain roughly:", value: `${numeral(levelExp).format("0,0")} power per message.` }
            )
            .setFooter({ text: `Scouter Bot ${config.version} | © 2019 ${config.author}`, iconURL: config.icon });

        message.channel.send({ embeds: [levelUpEmbed] }).then((sent) => waitAndDelete(sent, 30000));
    }

    user.lastSeen = rightNow;

    if (command === "help") {
        waitAndDelete(message, 1500);
        const help = new EmbedBuilder()
            .setTitle("Command List")
            .addFields(
                { name: `${config.prefix}info`, value: "Displays your current power reading and tier level, and how much more you need to advance to the next tier.", inline: true },
                { name: `${config.prefix}leaderboard`, value: `Shows the current leaderboard for ${message.guild.name}.`, inline: true },
                { name: `${config.prefix}transform`, value: "Basic transformation command that will amplify your power depending on the form you take." }
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

        const difference = levelInfo.nxtLvl - levelInfo.curXP;
        const infoEmbed = new EmbedBuilder()
            .setTitle("Displaying Current Tier & Power")
            .setAuthor({ name: `${transformLabel(user.transformation)} ${message.author.username}`, iconURL: config.icon })
            .setThumbnail(message.author.displayAvatarURL({ dynamic: true, size: 256 }))
            .setColor(borderColor(user.transformation))
            .addFields(
                { name: user.godki > 0 ? ":crossed_swords:God Tier" : ":crossed_swords:Tier", value: String(user.godki > 0 ? levelInfo.godLevel : user.level), inline: true },
                { name: "Powerlevel", value: `${numeral((user.points * user.transformation)).format("0.0a")}`, inline: true },
                { name: "Power per message:", value: `${numeral(levelExp).format("0,0")} power per message.` }
            );

        if (difference <= 0) {
            infoEmbed.setFooter({ text: "You're about to ascend to the next level! Congratulations!", iconURL: "https://www.stickpng.com/assets/images/5a81af7d9123fa7bcc9b0793.png" });
        } else {
            infoEmbed.setFooter({ text: `${numeral(difference).format("0,0")} additional power needed to reach the next tier!`, iconURL: "https://www.stickpng.com/assets/images/5a81af7d9123fa7bcc9b0793.png" });
        }

        message.channel.send({ embeds: [infoEmbed] }).then((sent) => waitAndDelete(sent, 12500));
        return;
    }

    if (command === "leaderboard") {
        waitAndDelete(message, 1500);
        client.points.set(key, user);

        const filtered = client.points.filterArray((p) => p.guildID === message.guild.id);
        const sorted = filtered.sort((a, b) => b.points - a.points);
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
                embed.addFields({ name: `${ig}. ${member.tag}`, value: `**God Tier Level**: ${(data.level - data.godki + 1)}\n**Powerlevel**: ${numeral(data.points * 80000).format("0.0a")}`, inline: true });
            } else {
                i += 1;
                embed.addFields({ name: `${i}. ${member.tag}`, value: `**Tier Level**: ${data.level}\n**Powerlevel**: ${numeral(data.points).format("0.0a")}`, inline: true });
            }
        }

        message.channel.send({ embeds: [embed] }).then((sent) => waitAndDelete(sent, 30000));
        return;
    }

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

        if (form === "normal") {
            user.transformation = user.godki > 0 ? 80000 : 1;
        } else {
            if (rule.setGodKi && user.godki < 1) user.godki = user.level;
            user.transformation = rule.target;
        }

        client.points.set(key, user);

        const transformedLevel = user.transformation;
        const difference = levelInfo.nxtLvl - levelInfo.curXP;
        const transformEmbed = new EmbedBuilder()
            .setTitle(form !== "normal" ? `${message.author.username} transformed!` : `${message.author.username} reverted to normal!`)
            .setDescription(form !== "normal" ? "Transformations amplify your power depending on the form you choose!" : "You reverted to your base form.")
            .setAuthor({ name: `${transformLabel(transformedLevel)} ${message.author.username}`, iconURL: config.icon })
            .setThumbnail(message.author.displayAvatarURL({ dynamic: true, size: 256 }))
            .setColor(borderColor(transformedLevel))
            .addFields(
                { name: user.godki > 0 ? ":crossed_swords:God Tier" : ":crossed_swords:Tier", value: String(user.godki > 0 ? levelInfo.godLevel : user.level), inline: true },
                { name: "Powerlevel", value: `${numeral((user.points * transformedLevel)).format("0.0a")}`, inline: true },
                { name: "Progress", value: `${numeral(difference).format("0,0")} additional power till level up` }
            );

        message.channel.send({ embeds: [transformEmbed] }).then((sent) => waitAndDelete(sent, 10000));
        return;
    }

    if (command === "setlevel") {
        const guildOwner = message.guild.ownerId ?? null;
        if (message.author.id !== guildOwner) {
            return message.reply("You're not the boss of me, you can't do that!");
        }

        const userMention = message.mentions.users.first() || client.users.cache.get(args[0]);
        if (!userMention) return message.reply("You must mention someone or give their ID!");

        const setLevel = Number.parseInt(args[1], 10);
        if (!Number.isInteger(setLevel)) return message.reply("You didn't tell me how many points to give...");

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
