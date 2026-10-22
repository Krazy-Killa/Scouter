const { randomUUID } = require("node:crypto");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require("discord.js");
const { toEmbedPayload } = require("./response-embeds");

const SPAR_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SPAR_CUSTOM_ID_PREFIX = "spar";
const expiryTimers = new Map();

const STATUS_DETAILS = {
    accepted: { color: "#08ff00", text: (c) => `✅ <@${c.opponentID}> accepted the challenge. Both fighters are ready!` },
    declined: { color: "#FF0000", text: (c) => `❌ <@${c.opponentID}> declined the challenge.` },
    cancelled: { color: "#808080", text: (c) => `🚫 <@${c.challengerID}> cancelled the challenge.` },
    expired: { color: "#808080", text: (c) => `⌛ <@${c.opponentID}> did not respond in time, so the challenge was declined.` },
    unavailable: { color: "#808080", text: () => "🚫 A fighter is no longer available, so the challenge was closed." }
};

function getActiveChallenge(client, guildId, userId, now) {
    return client.sparChallenges.filter((challenge) =>
        challenge.guildID === guildId &&
        challenge.expiresAt > now &&
        (challenge.challengerID === userId || challenge.opponentID === userId)
    )[0];
}

function buildButtons(challengeId, disabled) {
    const button = (action, label, style) => new ButtonBuilder()
        .setCustomId(`${SPAR_CUSTOM_ID_PREFIX}:${action}:${challengeId}`)
        .setLabel(label)
        .setStyle(style)
        .setDisabled(disabled);
    return new ActionRowBuilder().addComponents(
        button("accept", "Accept", ButtonStyle.Success),
        button("decline", "Decline", ButtonStyle.Danger),
        button("cancel", "Cancel challenge", ButtonStyle.Secondary)
    );
}

function buildChallengePayload(challenge, status = "pending") {
    const pending = status === "pending";
    const details = STATUS_DETAILS[status];
    const embed = new EmbedBuilder()
        .setTitle("🥊 Sparring Challenge")
        .setColor(pending ? "#FFA500" : details.color)
        .setDescription(pending
            ? `<@${challenge.challengerID}> challenges <@${challenge.opponentID}> to a friendly spar!\n\nOnly <@${challenge.opponentID}> can accept or decline. This challenge expires <t:${Math.floor(challenge.expiresAt / 1000)}:R>.`
            : details.text(challenge));
    return {
        content: pending ? `<@${challenge.opponentID}>` : "",
        embeds: [embed],
        components: [buildButtons(challenge.id, !pending)],
        allowedMentions: { users: pending ? [challenge.opponentID] : [] }
    };
}

function clearExpiryTimer(challengeId) {
    const timer = expiryTimers.get(challengeId);
    if (timer) clearTimeout(timer);
    expiryTimers.delete(challengeId);
}

async function expireChallenge(client, challengeId) {
    clearExpiryTimer(challengeId);
    const challenge = client.sparChallenges?.get(challengeId);
    if (!challenge) return;
    client.sparChallenges.delete(challengeId);
    if (!challenge.messageID) return;
    try {
        const channel = await client.channels.fetch(challenge.channelID);
        const message = await channel.messages.fetch(challenge.messageID);
        await message.edit(buildChallengePayload(challenge, "expired"));
    } catch (error) {
        console.error(`Failed to close expired spar challenge ${challengeId}:`, error);
    }
}

function scheduleExpiry(client, challenge, now = Date.now()) {
    clearExpiryTimer(challenge.id);
    const timer = setTimeout(
        () => expireChallenge(client, challenge.id),
        Math.max(0, challenge.expiresAt - now)
    );
    timer.unref?.();
    expiryTimers.set(challenge.id, timer);
}

// Re-arm persisted challenges after a restart; already-expired ones are closed immediately.
function restoreSparChallenges(client, now = Date.now()) {
    if (!client.sparChallenges) return;
    for (const challenge of client.sparChallenges.filter(() => true)) {
        scheduleExpiry(client, challenge, now);
    }
}

async function handleSparCommand({ client, message, command, now, replyTemporary }) {
    if (command !== "spar") return false;

    const reply = (text) => replyTemporary(message, text, 10000, "spar response");
    const guildId = message.guild.id;
    const target = message.mentions.users.first();
    if (!target) {
        await reply("Choose a member to challenge with `/spar target:@member`.");
        return true;
    }
    if (target.id === message.author.id) {
        await reply("You can't spar with yourself.");
        return true;
    }
    if (target.bot) {
        await reply("Bots can't be challenged to a spar.");
        return true;
    }

    const targetKey = `${guildId}-${target.id}`;
    if (client.privacy.get(targetKey) || !client.points.get(targetKey)) {
        await reply(`<@${target.id}> can't be challenged to a spar right now.`);
        return true;
    }
    if (getActiveChallenge(client, guildId, message.author.id, now)) {
        await reply("You already have a pending spar challenge. Wait for it to finish or cancel it first.");
        return true;
    }
    if (getActiveChallenge(client, guildId, target.id, now)) {
        await reply(`<@${target.id}> already has a pending spar challenge.`);
        return true;
    }

    const challenge = {
        id: randomUUID(),
        guildID: guildId,
        channelID: message.channel.id ?? message.channelId ?? null,
        messageID: null,
        challengerID: message.author.id,
        opponentID: target.id,
        createdAt: now,
        expiresAt: now + SPAR_CHALLENGE_TTL_MS
    };

    let sent;
    try {
        sent = await message.channel.send(buildChallengePayload(challenge));
    } catch (error) {
        console.error("Failed to send spar challenge:", error);
        if (message.channel.isSlashCommandResponse) await message.channel.reportFailure(error, "spar challenge");
        return true;
    }

    challenge.messageID = sent?.id ?? null;
    challenge.channelID = sent?.channelId ?? challenge.channelID;
    client.sparChallenges.set(challenge.id, challenge);
    scheduleExpiry(client, challenge, now);
    return true;
}

async function replyPrivately(interaction, text) {
    await interaction.reply({ ...toEmbedPayload(text), flags: MessageFlags.Ephemeral });
}

async function handleSparButton(interaction, { client, now = Date.now() }) {
    const [, action, challengeId] = interaction.customId.split(":");
    const challenge = client.sparChallenges.get(challengeId);
    if (!challenge) {
        await replyPrivately(interaction, "This spar challenge is no longer active.");
        return;
    }
    if (interaction.guildId !== challenge.guildID) {
        await replyPrivately(interaction, "This spar challenge belongs to a different server.");
        return;
    }
    if (challenge.expiresAt <= now) {
        clearExpiryTimer(challengeId);
        client.sparChallenges.delete(challengeId);
        await interaction.update(buildChallengePayload(challenge, "expired"));
        return;
    }

    const userId = interaction.user.id;
    if (action === "cancel") {
        if (userId !== challenge.challengerID) {
            await replyPrivately(interaction, "Only the challenger can cancel this challenge.");
            return;
        }
    } else if (action === "accept" || action === "decline") {
        if (userId !== challenge.opponentID) {
            await replyPrivately(interaction, `Only <@${challenge.opponentID}> can respond to this challenge.`);
            return;
        }
    } else {
        await replyPrivately(interaction, "Unknown spar action.");
        return;
    }

    let status = { accept: "accepted", decline: "declined", cancel: "cancelled" }[action];
    if (status === "accepted") {
        const fighterKeys = [challenge.challengerID, challenge.opponentID]
            .map((id) => `${challenge.guildID}-${id}`);
        const available = fighterKeys.every((key) => !client.privacy.get(key) && client.points.get(key));
        if (!available) status = "unavailable";
    }

    // Remove the challenge before responding so duplicate clicks cannot resolve it twice.
    clearExpiryTimer(challengeId);
    client.sparChallenges.delete(challengeId);
    await interaction.update(buildChallengePayload(challenge, status));
}

module.exports = {
    SPAR_CHALLENGE_TTL_MS,
    SPAR_CUSTOM_ID_PREFIX,
    expireChallenge,
    handleSparButton,
    handleSparCommand,
    restoreSparChallenges
};
