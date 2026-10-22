const { EmbedBuilder } = require("discord.js");
const numeral = require("numeral");
const {
    ACHIEVEMENTS,
    MAX_STAMINA,
    RACES,
    RACE_LOCK_BASE_POWER,
    addExperience,
    createDefaultUser,
    getKaiokenMultiplier,
    getProgressAchievementIds,
    initializeUserProgress,
    optInUser,
    optOutUser,
    recordTrainingDay
} = require("../progression");
const { formatPowerAmount } = require("./power-format");

async function handlePrivacyCommand(context) {
    const { client, message, args, key, cancelPendingNewUserNotice, sendTemporary } = context;
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
    return true;
}

async function handleScanCommand(context) {
    const {
        client, message, args, key, now, config, copyrightNotice,
        createProfileSnapshot, getLevelProgress, getCurrentForm,
        getCurrentFormName, formatPowerLevel, borderColor, sendTemporary,
        replyTemporary
    } = context;
    let targetMember = message.mentions.members.first()
        || (args[0] ? message.guild.members.cache.get(args[0]) : null);
    if (!targetMember && args[0] && /^\d{17,20}$/.test(args[0])) {
        try {
            targetMember = await message.guild.members.fetch(args[0]);
        } catch (error) {
            if (error.code !== 10007 && error.code !== 10013) {
                console.error(`Failed to fetch scan target ${args[0]}:`, error);
                await replyTemporary(message, "The scouter could not complete the scan. Try again shortly.", 10000, "scan member lookup error");
                return true;
            }
        }
    }
    if (args.length > 0 && !targetMember) {
        await replyTemporary(message, "Choose a server member in the target option, or leave it empty to scan yourself.", 10000, "scan usage response");
        return true;
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
                text: `Scouter Bot ${config.version} | ${copyrightNotice} ${config.author}`,
                iconURL: client.user.displayAvatarURL({ extension: "png", size: 64 })
            });
        await sendTemporary(message.channel, { embeds: [scanEmbed] }, 15000, "self-scan response");
        return true;
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
            ? client.points.get(key) || createDefaultUser(targetUser.id, message.guild.id, now)
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
            const scannedUser = createProfileSnapshot(targetRecord, now);
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
        text: `Scouter Bot ${config.version} | ${copyrightNotice} ${config.author}`,
        iconURL: client.user.displayAvatarURL({ extension: "png", size: 64 })
    });
    await sendTemporary(message.channel, { embeds: [scanEmbed] }, 15000, "scan response");
    return true;
}

async function handleHelpCommand(context) {
    const {
        client, message, user, key, config, copyrightNotice,
        formatPowerAmount, sendTemporary
    } = context;
    const help = new EmbedBuilder()
        .setTitle("Command List")
        .addFields(
            { name: "/scan [target]", value: "Run a power scan on yourself or another member; opted-out members cannot be scanned.", inline: true },
            { name: "/profile [target]", value: "Displays your tier, power, form, stamina, progress, and achievements, or another member's profile.", inline: true },
            { name: "/compare target", value: "Compare progression with another server member.", inline: true },
            { name: "/leaderboard", value: `Shows the all-time leaderboard for ${message.guild.name}; use reactions to change pages.`, inline: true },
            { name: "/achievements", value: "Shows your unlocked achievements and progress.", inline: true },
            { name: "/privacy action", value: "Opt out of progression tracking and delete your record, or opt in again.", inline: true },
            { name: "/race race", value: `Choose Saiyan, Human, Namekian, or Frieza Race before reaching ${formatPowerAmount(RACE_LOCK_BASE_POWER)} base power.` },
            { name: "/transform form", value: "Change your form. Beyond God attempts to awaken God Ki at Tier 50. First-time Saiyan SSG awakening requires five distinct other Saiyans at Tier 21+." },
            { name: "/kaioken level", value: "Activate or disable the universal Kaioken ability. Stamina drain is amplified when stacked with another form." },
            { name: "/revert", value: "Automatically reverts you to your normal form." },
            { name: "/train", value: "Trade stamina for a large one-time power boost. Training is available once per day." },
            { name: "/spar target", value: "Challenge another member to a friendly spar. They must accept with a button within 5 minutes." },
            { name: "/setlevel target level", value: "Set a member's tier (server owner only)." },
            { name: "/setpower target power", value: "Set a member's base power and recalculate their tier (server owner only)." },
            { name: "/awardpower target amount [reason]", value: "Add base power to a member and recalculate their tier (server owner only)." },
            { name: "/reset target", value: "Reset a member's progression to a fresh profile (server owner only)." }
        )
        .setColor("#008B8B")
        .setFooter({ text: `Scouter Bot ${config.version} | ${copyrightNotice} ${config.author}`, iconURL: client.user.displayAvatarURL({ extension: "png", size: 64 }) });

    client.points.set(key, user);
    await sendTemporary(message.channel, { embeds: [help] }, 30000, "help response");
    return true;
}

async function handleProfileCommand(context) {
    const {
        client, message, command, args, user, now, config, copyrightNotice,
        createProfileSnapshot, getLevelProgress, getCurrentForm,
        getCurrentFormName, getProgressBar, getTierProgressDisplay,
        getComparisonProfileDetails, transformLabel, borderColor,
        formatPowerLevel, sendTemporary, replyTemporary
    } = context;
    let targetMember = message.mentions.members.first()
        || (args[0] ? message.guild.members.cache.get(args[0]) : null);
    if (command === "compare" && !targetMember && /^\d{17,20}$/.test(args[0] || "")) {
        try {
            targetMember = await message.guild.members.fetch(args[0]);
        } catch (error) {
            if (error.code !== 10007 && error.code !== 10013) {
                console.error(`Failed to fetch comparison member ${args[0]}:`, error);
                await replyTemporary(message, "Could not look up that member right now. Please try again later.", 10000, "compare member lookup error");
                return true;
            }
        }
    }
    if (command === "profile" && args.length > 0 && !targetMember) {
        await replyTemporary(message, "Choose a server member in the target option, or leave it empty to view your own profile.", 10000, "profile usage response");
        return true;
    }
    if (command === "compare" && !targetMember) {
        await replyTemporary(message, "Choose a server member in the target option to compare with.", 10000, "compare usage response");
        return true;
    }
    if (command === "compare" && targetMember.id === message.author.id) {
        await replyTemporary(message, "Mention another member to compare your progression.", 10000, "compare self-target response");
        return true;
    }

    const targetUser = targetMember ? targetMember.user : message.author;
    const targetKey = `${message.guild.id}-${targetUser.id}`;
    if (client.privacy.get(targetKey)) {
        await replyTemporary(message, "That member has opted out of progression tracking.", 10000, `${command} privacy response`);
        return true;
    }
    const targetRecord = targetUser.id === message.author.id ? user : client.points.get(targetKey);
    if (!targetRecord) {
        await replyTemporary(message, "That member doesn't have a progression profile in this server yet.", 10000, `${command} missing-profile response`);
        return true;
    }

    const profile = createProfileSnapshot(targetRecord, now);
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
                text: `Scouter Bot ${config.version} | ${copyrightNotice} ${config.author}`,
                iconURL: client.user.displayAvatarURL({ extension: "png", size: 64 })
            });
        await sendTemporary(message.channel, { embeds: [profileEmbed] }, 12500, "profile response");
        return true;
    }

    const viewerProfile = createProfileSnapshot(user, now);
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
            text: `Scouter Bot ${config.version} | ${copyrightNotice} ${config.author}`,
            iconURL: client.user.displayAvatarURL({ extension: "png", size: 64 })
        });
    await sendTemporary(message.channel, { embeds: [comparisonEmbed] }, 12500, "compare response");
    return true;
}

async function handleAchievementsCommand({ client, message, user, sendTemporary }) {
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

    await sendTemporary(message.channel, { embeds: [achievementEmbed] }, 30000, "achievements response");
    return true;
}

async function handleLeaderboardCommand(context) {
    const {
        client, message, user, key, config, copyrightNotice,
        formatPowerLevel, getCurrentFormName, sendTemporary, replyTemporary
    } = context;
    client.points.set(key, user);

    const filtered = client.points.filter((record) => record.guildID === message.guild.id);
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
                value: column.map((record, index) => {
                    const rank = pageStart + columnIndex * 5 + index + 1;
                    const rankLabel = rank <= 3 ? ["🥇", "🥈", "🥉"][rank - 1] : `**${rank}.**`;
                    const tierLabel = record.godki > 0
                        ? `God Tier ${record.level - record.godki + 1}`
                        : `Tier ${record.level}`;
                    const currentForm = record.transformationForm || "normal";
                    const transformationLabel = currentForm === "normal" && !record.kaiokenLevel
                        ? ""
                        : `  •  ${getCurrentFormName(record)}`;
                    const powerLevel = formatPowerLevel(record.points * record.transformation);

                    return `${rankLabel} <@${record.userID}>\n└ ${RACES[record.race]?.name || RACES.saiyan.name} • ${tierLabel}${transformationLabel}  •  **${powerLevel}** power`;
                }).join("\n\n"),
                inline: true
            }));

        return new EmbedBuilder()
            .setTitle("🏆 Power Rankings")
            .setDescription(`**${message.guild.name}**\nAll-time power rankings • Page ${page} of ${totalPages} • ${sorted.length} members`)
            .addFields(rankingColumns.length > 0
                ? rankingColumns
                : [{ name: "No rankings yet", value: "Start chatting to earn power!" }])
            .setFooter({ text: `Scouter Bot ${config.version} | ${copyrightNotice} ${config.author}`, iconURL: client.user.displayAvatarURL({ extension: "png", size: 64 }) })
            .setColor(0x00ae86);
    };

    const leaderboardMessage = await sendTemporary(
        message.channel,
        { embeds: [createLeaderboardEmbed(1)] },
        totalPages > 1 ? 120000 : 30000,
        "leaderboard"
    );
    if (!leaderboardMessage) return true;
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
            return true;
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

    return true;
}

async function handleTrainingCommand(context) {
    const {
        client, message, user, key, now, config, copyrightNotice,
        trainCooldownMs, baseTrainingPower, transformRules, kaiokenRules,
        getCurrentForm, getCurrentFormName, getStaminaCosts,
        getKaiokenMultiplier, getBaseTransformation, dropPowerup,
        formatCooldownRemaining, formatPowerLevel, replyTemporary,
        sendTemporary, sendLevelUp, awardAchievements
    } = context;
    const cooldownRemaining = trainCooldownMs - (now - user.trainLastUsedAt);
    if (cooldownRemaining > 0) {
        await replyTemporary(message, `You're exhausted from training. Try again in ${formatCooldownRemaining(cooldownRemaining)}.`, 10000, "training cooldown response");
        return true;
    }

    const form = getCurrentForm(user);
    const rule = transformRules[form];
    const { trainingCost } = getStaminaCosts(user, rule);
    const trainingFormName = getCurrentFormName(user);
    if (user.stamina < trainingCost) {
        await replyTemporary(message, `Not enough stamina to train in ${trainingFormName}. You need ${numeral(trainingCost).format("0,0")} stamina; you have ${numeral(Math.floor(user.stamina)).format("0,0")}.`, 10000, "training stamina response");
        return true;
    }

    const kaiokenRule = kaiokenRules[user.kaiokenLevel];
    const trainingMultiplier = form === "normal" && kaiokenRule
        ? kaiokenRule.trainingMultiplier
        : rule.trainingMultiplier * getKaiokenMultiplier(user.kaiokenLevel);
    const trainingPenalty = form === "normal" && kaiokenRule
        ? kaiokenRule.trainingPenalty
        : rule.trainingPenalty;
    const rawPower = baseTrainingPower * trainingMultiplier;
    const powerGained = Math.floor(rawPower * (1 - trainingPenalty));
    user.stamina = Math.max(0, user.stamina - trainingCost);
    recordTrainingDay(user, now);
    user.trainLastUsedAt = now;
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

    await sendTemporary(message.channel, { embeds: [trainingEmbed] }, 30000, "training result");
    sendLevelUp(message, user, levelsGained);
    return true;
}

const USER_COMMAND_HANDLERS = {
    privacy: handlePrivacyCommand,
    scan: handleScanCommand,
    help: handleHelpCommand,
    profile: handleProfileCommand,
    compare: handleProfileCommand,
    achievements: handleAchievementsCommand,
    leaderboard: handleLeaderboardCommand,
    train: handleTrainingCommand
};

async function handleUserCommand(context) {
    const handler = USER_COMMAND_HANDLERS[context.command];
    return handler ? handler(context) : false;
}

module.exports = { handleUserCommand };
