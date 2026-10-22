const { EmbedBuilder } = require("discord.js");
const numeral = require("numeral");
const {
    GOD_KI_AWAKENING_COOLDOWN_MS,
    MAX_STAMINA,
    RACES,
    RACE_LOCK_BASE_POWER,
    changeRace,
    getGodKiAwakeningChance,
    hasReachedGodTier,
    initializeUserProgress,
    isFormAvailableForRace,
    setKaiokenLevel,
    setTransformation
} = require("../progression");
const { formatPowerAmount } = require("./power-format");

const TRANSFORM_RULES = {
    normal: { minLevel: 1, trainingMultiplier: 1, trainingPenalty: 0, trainingCost: 10, messageDrain: 0 },
    beyondgod: { minLevel: 50, setGodKi: true, trainingMultiplier: 1, trainingPenalty: 0, trainingCost: 10, messageDrain: 0 },
    ssj: { minLevel: 21, trainingMultiplier: 50, trainingPenalty: 0.024, trainingCost: 500, messageDrain: 1 },
    ssj2: { minLevel: 25, trainingMultiplier: 100, trainingPenalty: 0.04, trainingCost: 1000, messageDrain: 2 },
    ssj3: { minLevel: 33, trainingMultiplier: 400, trainingPenalty: 0.06, trainingCost: 4000, messageDrain: 15 },
    ssg: { minLevel: 50, setGodKi: true, trainingMultiplier: 450, trainingPenalty: 0.1, trainingCost: 4500, messageDrain: 5 },
    ssgss: { minGodTier: 15, trainingMultiplier: 500, trainingPenalty: 0.15, trainingCost: 5000, messageDrain: 10 },
    potential: { minLevelByRace: { human: 21, namekian: 25 }, trainingMultiplier: 250, trainingPenalty: 0.08, trainingCost: 2500, messageDrain: 6 },
    giant: { minLevel: 21, trainingMultiplier: 120, trainingPenalty: 0.05, trainingCost: 1200, messageDrain: 4 },
    final: { minLevel: 21, trainingMultiplier: 120, trainingPenalty: 0.05, trainingCost: 1200, messageDrain: 4 },
    golden: { minLevel: 25, trainingMultiplier: 600, trainingPenalty: 0.1, trainingCost: 6000, messageDrain: 10 }
};

const KAIOKEN_RULES = {
    2: { command: "x2", minLevel: 2, messageDrain: 2, trainingCost: 250, trainingMultiplier: 10, trainingPenalty: 0.01 },
    3: { command: "x3", minLevel: 6, messageDrain: 5, trainingCost: 500, trainingMultiplier: 15, trainingPenalty: 0.02 },
    4: { command: "x4", minLevel: 12, messageDrain: 10, trainingCost: 1000, trainingMultiplier: 20, trainingPenalty: 0.04 },
    10: { command: "x10", minLevel: 20, messageDrain: 25, trainingCost: 3000, trainingMultiplier: 50, trainingPenalty: 0.1 }
};

function formatCooldownRemaining(milliseconds) {
    if (milliseconds < 60 * 60 * 1000) {
        return `about ${Math.ceil(milliseconds / (60 * 1000))} minute(s)`;
    }
    return `about ${Math.ceil(milliseconds / (60 * 60 * 1000))} hour(s)`;
}

async function handleTransformationCommand({
    client,
    message,
    command,
    args,
    user,
    key,
    now,
    config,
    copyrightNotice,
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
}) {
    if (command === "race") {
        const raceName = args.join(" ").trim().toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(RACES, raceName)) {
            await replyTemporary(
                message,
                `Choose a race: ${Object.entries(RACES).map(([id, race]) => `\`${id}\` (${race.name})`).join(", ")}.`,
                10000,
                "race usage response"
            );
            return true;
        }
        if (user.race === raceName) {
            await replyTemporary(message, `You are already a ${RACES[raceName].name}.`, 10000, "race unchanged response");
            return true;
        }
        if (!changeRace(user, raceName)) {
            await replyTemporary(
                message,
                `Your race is locked after reaching ${formatPowerAmount(RACE_LOCK_BASE_POWER)} base power.`,
                10000,
                "race locked response"
            );
            return true;
        }
        client.points.set(key, user);
        await sendTemporary(
            message.channel,
            `Your race is now ${RACES[raceName].name}. Your form has returned to ${transformationName("normal", user.godki, user.race)}.${user.kaiokenLevel > 0 ? ` Kaioken x${user.kaiokenLevel} remains active.` : ""}`,
            10000,
            "race change confirmation"
        );
        return true;
    }

    if (command === "kaioken") {
        const requestedLevel = args[0]?.toLowerCase();
        if (["off", "disable", "0"].includes(requestedLevel)) {
            if (user.kaiokenLevel === 0) {
                await replyTemporary(message, "Kaioken is already disabled.", 10000, "Kaioken state response");
                return true;
            }
            setKaiokenLevel(user, 0);
            client.points.set(key, user);
            await sendTemporary(message.channel, "Kaioken ability disabled.", 10000, "Kaioken disabled response");
            return true;
        }

        const level = Number(requestedLevel?.replace(/^x/, ""));
        const rule = KAIOKEN_RULES[level];
        if (!rule) {
            await replyTemporary(
                message,
                "Choose a Kaioken level: x2, x3, x4, x10, or off.",
                10000,
                "Kaioken usage response"
            );
            return true;
        }
        if (user.level < rule.minLevel) {
            await replyTemporary(message, `Reach Tier ${rule.minLevel} to unlock Kaioken x${level}.`, 10000, "Kaioken level response");
            return true;
        }
        if (user.kaiokenLevel === level) {
            await replyTemporary(message, `Kaioken x${level} is already active.`, 10000, "Kaioken unchanged response");
            return true;
        }
        if (["ssj", "ssj2", "ssj3"].includes(getCurrentForm(user))) {
            await replyTemporary(
                message,
                "Kaioken cannot be used with Super Saiyan, Super Saiyan 2, or Super Saiyan 3 because their ki is unstable. Transform out of that form first.",
                10000,
                "Kaioken instability response"
            );
            return true;
        }
        if (user.stamina <= 0) {
            await replyTemporary(message, "You're out of stamina and need to recover before using Kaioken.", 10000, "Kaioken stamina response");
            return true;
        }

        setKaiokenLevel(user, level);
        awardAchievements(message, user, ["form_kaioken"]);
        client.points.set(key, user);
        await sendTemporary(
            message.channel,
            `Kaioken x${level} is active on ${transformationName(getCurrentForm(user), user.godki, user.race)}. Current power: ${formatPowerLevel(user.points * user.transformation)}.`,
            10000,
            "Kaioken activation response"
        );
        return true;
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
        return true;
    }

    if (command !== "transform") return false;

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
            .setFooter({ text: `Scouter Bot ${config.version} | ${copyrightNotice} ${config.author}`, iconURL: client.user.displayAvatarURL({ extension: "png", size: 64 }) });

        await sendTemporary(message.channel, { embeds: [invalidTransform] }, 10000, "invalid transformation response");
        return true;
    }

    const rule = TRANSFORM_RULES[requestedForm];
    if (requestedForm !== "beyondgod" && !isFormAvailableForRace(requestedForm, user.race)) {
        await replyTemporary(
            message,
            `${transformationName(requestedForm, user.godki, user.race)} is only available to the appropriate race.`,
            10000,
            "race transformation restriction response"
        );
        return true;
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

        await sendTemporary(message.channel, { embeds: [lowLevelWarning] }, 10000, "level requirement response");
        return true;
    }

    const form = requestedForm === "beyondgod" ? "normal" : requestedForm;
    if (user.kaiokenLevel > 0 && ["ssj", "ssj2", "ssj3"].includes(form)) {
        await replyTemporary(
            message,
            "Super Saiyan, Super Saiyan 2, and Super Saiyan 3 cannot be combined with Kaioken because their ki is unstable. Disable Kaioken first.",
            10000,
            "transformation instability response"
        );
        return true;
    }
    if (form !== "normal" && user.stamina <= 0) {
        await replyTemporary(message, "You're out of stamina and need to recover before transforming.", 10000, "transformation stamina response");
        return true;
    }

    if (requestedForm === "beyondgod") {
        if (user.godki > 0) {
            setTransformation(user, "normal");
        } else {
            const cooldownRemaining = GOD_KI_AWAKENING_COOLDOWN_MS
                - (now - user.lastGodKiAwakeningAttemptAt);
            if (cooldownRemaining > 0) {
                await replyTemporary(
                    message,
                    `Your next God Ki awakening attempt is available in ${formatCooldownRemaining(cooldownRemaining)}.`,
                    10000,
                    "God Ki awakening cooldown response"
                );
                return true;
            }

            const chance = getGodKiAwakeningChance(user.godKiAwakeningAttempts);
            user.lastGodKiAwakeningAttemptAt = now;
            if (Math.random() >= chance) {
                user.godKiAwakeningAttempts += 1;
                client.points.set(key, user);
                await sendTemporary(
                    message.channel,
                    `Your attempt to awaken God Ki failed (${Math.round(chance * 100)}% chance). Try again in 12 hours. Your chance will rise after four failed attempts.`,
                    10000,
                    "God Ki awakening failure response"
                );
                return true;
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
                await replyTemporary(
                    message,
                    "Disable Kaioken before awakening Super Saiyan God.",
                    10000,
                    "SSG awakening Kaioken response"
                );
                return true;
            }
            const helperIds = [...message.mentions.users.values()]
                .map((helper) => helper.id)
                .filter((id) => id !== message.author.id);
            const uniqueHelperIds = [...new Set(helperIds)];
            if (uniqueHelperIds.length !== 5) {
                await replyTemporary(
                    message,
                    "Your first Super Saiyan God awakening requires exactly five distinct other Saiyan helpers. Select five different users in the helper options.",
                    10000,
                    "SSG awakening helper count response"
                );
                return true;
            }

            const helpers = uniqueHelperIds.map((helperId) => ({
                id: helperId,
                profile: client.points.get(`${message.guild.id}-${helperId}`)
            }));
            for (const { id, profile } of helpers) {
                if (!profile) {
                    await replyTemporary(
                        message,
                        "All five helpers must have an existing Saiyan progression profile in this server.",
                        10000,
                        "SSG awakening helper profile response"
                    );
                    return true;
                }
                initializeUserProgress(profile);
                client.points.set(`${message.guild.id}-${id}`, profile);
                if (profile.race !== "saiyan") {
                    await replyTemporary(
                        message,
                        "All five helpers must be Saiyans.",
                        10000,
                        "SSG awakening helper race response"
                    );
                    return true;
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
            { name: "Progress", value: `${formatPowerAmount(transformedProgress.difference)} additional power till level up` },
            { name: "Stamina", value: `${numeral(Math.floor(user.stamina)).format("0,0")} / ${numeral(MAX_STAMINA).format("0,0")}`, inline: true }
        );

    await sendTemporary(message.channel, { embeds: [transformEmbed] }, 10000, "transformation result");
    return true;
}

module.exports = {
    KAIOKEN_RULES,
    TRANSFORM_RULES,
    formatCooldownRemaining,
    handleTransformationCommand
};
