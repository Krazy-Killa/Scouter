const numeral = require("numeral");
const {
    createDefaultUser,
    getGodTierLevel,
    getProgressAchievementIds,
    initializeUserProgress,
    setBasePower,
    setUserLevel
} = require("../progression");

const ADMIN_COMMANDS = new Set(["setlevel", "setpower", "awardpower", "reset"]);

async function handleAdminCommand({
    client,
    message,
    command,
    args,
    now,
    replyTemporary,
    sendTemporary,
    awardAchievements
}) {
    if (!ADMIN_COMMANDS.has(command)) return false;

    if (message.author.id !== (message.guild.ownerId ?? null)) {
        await replyTemporary(message, "Only the server owner can use this progression command.", 10000, `${command} permission response`);
        return true;
    }

    const targetUser = message.mentions.users.first() || client.users.cache.get(args[0]);
    if (!targetUser) {
        await replyTemporary(message, "Mention a server member or provide their user ID.", 10000, `${command} user response`);
        return true;
    }

    const targetKey = `${message.guild.id}-${targetUser.id}`;
    if (client.privacy.get(targetKey)) {
        await replyTemporary(message, "That user has opted out of progression tracking.", 10000, `${command} privacy response`);
        return true;
    }

    if (command === "reset") {
        if (!client.points.has(targetKey)) {
            await replyTemporary(message, "That user does not have a progression profile to reset.", 10000, "reset missing-profile response");
            return true;
        }
        client.points.set(targetKey, createDefaultUser(targetUser.id, message.guild.id, now));
        await sendTemporary(message.channel, `${targetUser.tag}'s progression has been reset to a fresh profile.`, 10000, "reset confirmation");
        return true;
    }

    if (command === "setlevel") {
        const level = Number(args[1]);
        if (!Number.isSafeInteger(level) || level < 1) {
            await replyTemporary(message, "Enter a whole-number level of 1 or higher.", 10000, "setlevel validation response");
            return true;
        }

        const user = client.points.get(targetKey) || createDefaultUser(targetUser.id, message.guild.id, now);
        initializeUserProgress(user);
        setUserLevel(user, level);
        client.points.set(targetKey, user);
        await sendTemporary(message.channel, `${targetUser.tag} has been set to Tier ${level}.`, 10000, "setlevel confirmation");
        return true;
    }

    if (command === "awardpower") {
        const amount = Number(args[1]?.replaceAll(",", ""));
        if (!Number.isSafeInteger(amount) || amount < 1) {
            await replyTemporary(message, "Enter a positive whole-number power award.", 10000, "awardpower validation response");
            return true;
        }

        const reason = args.slice(2).join(" ").trim();
        if (reason.length > 200) {
            await replyTemporary(message, "Keep the award reason to 200 characters or fewer.", 10000, "awardpower reason validation response");
            return true;
        }

        const user = client.points.get(targetKey) || createDefaultUser(targetUser.id, message.guild.id, now);
        initializeUserProgress(user);
        const awardedPower = user.points + amount;
        if (!Number.isSafeInteger(awardedPower)) {
            await replyTemporary(message, "That award would exceed the maximum supported power value.", 10000, "awardpower overflow response");
            return true;
        }

        setBasePower(user, awardedPower);
        client.points.set(targetKey, user);
        awardAchievements(
            { author: targetUser, channel: message.channel },
            user,
            getProgressAchievementIds(user)
        );

        const tierLabel = user.godki > 0
            ? `God Tier ${getGodTierLevel(user)}`
            : `Tier ${user.level}`;
        const reasonText = reason ? ` Reason: ${reason.replace(/@/g, "@\u200b")}` : "";
        await sendTemporary(
            message.channel,
            `${numeral(amount).format("0,0")} base power awarded to ${targetUser.tag}; their base power is now ${numeral(user.points - 2500).format("0,0")} (${tierLabel}).${reasonText}`,
            10000,
            "awardpower confirmation"
        );
        return true;
    }

    const power = Number(args[1]?.replaceAll(",", ""));
    if (!Number.isSafeInteger(power) || power < 2500) {
        await replyTemporary(message, "Enter a whole-number base power of at least 2,500.", 10000, "setpower validation response");
        return true;
    }

    const user = client.points.get(targetKey) || createDefaultUser(targetUser.id, message.guild.id, now);
    initializeUserProgress(user);
    setBasePower(user, power);
    client.points.set(targetKey, user);
    const tierLabel = user.godki > 0
        ? `God Tier ${getGodTierLevel(user)}`
        : `Tier ${user.level}`;
    await sendTemporary(
        message.channel,
        `${targetUser.tag}'s base power is now ${numeral(power).format("0,0")} (${tierLabel}).`,
        10000,
        "setpower confirmation"
    );
    return true;
}

module.exports = { handleAdminCommand };
