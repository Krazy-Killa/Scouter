const MAX_STAMINA = 10000;
const XP_COOLDOWN_MS = 60 * 1000;
const REPEATED_MESSAGE_WINDOW_MS = 10 * 60 * 1000;
const BASE_LEVEL_XP = 5000;
const LEVEL_XP_FACTOR = 3000;
const GOD_KI_BASE_MULTIPLIER = 1;
const GOD_KI_MAX_BASE_MULTIPLIER = 400;
const GOD_KI_MAX_TIER = 15;
const SSG_MIN_MULTIPLIER = 20000;
const SSG_MAX_MULTIPLIER = 30000;

const FORM_MULTIPLIERS = {
    normal: 1,
    ssj: 50,
    ssj2: 100,
    ssj3: 400,
    ssg: SSG_MIN_MULTIPLIER,
    ssgss: SSG_MIN_MULTIPLIER * 50
};

const VALID_FORMS = Object.keys(FORM_MULTIPLIERS);

const ACHIEVEMENTS = {
    level_10: { name: "Rising Fighter", description: "Reach Tier 10." },
    level_25: { name: "Elite Warrior", description: "Reach Tier 25." },
    level_50: { name: "God Ki Awakened", description: "Reach Tier 50." },
    level_64: { name: "Limit Breaker", description: "Reach Tier 64." },
    power_1m: { name: "Powerhouse", description: "Earn 1 million base power." },
    power_10m: { name: "Unstoppable", description: "Earn 10 million base power." },
    power_100m: { name: "Legendary", description: "Earn 100 million base power." },
    trained_once: { name: "First Training", description: "Complete your first training session." },
    training_streak_7: { name: "Dedicated", description: "Train on 7 consecutive UTC calendar days." },
    form_ssj: { name: "Super Saiyan", description: "Transform into Super Saiyan." },
    form_ssj2: { name: "Ascended Saiyan", description: "Transform into Super Saiyan 2." },
    form_ssj3: { name: "Unleashed Power", description: "Transform into Super Saiyan 3." },
    form_ssg: { name: "Godly Power", description: "Transform into Super Saiyan God." },
    form_ssgss: { name: "Beyond Godhood", description: "Transform into Super Saiyan God Super Saiyan." }
};

function createDefaultUser(authorId, guildId, now = Date.now()) {
    return {
        userID: authorId,
        guildID: guildId,
        points: 2500,
        level: 1,
        transformation: 1,
        transformationForm: "normal",
        godki: 0,
        stamina: MAX_STAMINA,
        staminaUpdatedAt: now,
        trainLastUsedAt: 0,
        lastXpAt: 0,
        lastXpContent: "",
        lastXpContentAt: 0,
        achievements: [],
        trainingStreakDays: 0,
        lastTrainingDay: null
    };
}

function initializeUserProgress(user) {
    if (!VALID_FORMS.includes(user.transformationForm)) {
        if (user.godki > 0) {
            const legacyGodKiForms = {
                80000: "normal",
                160000: "ssg",
                4000000: "ssj",
                8000000: "ssgss",
                32000000: "ssj3"
            };
            user.transformationForm = legacyGodKiForms[user.transformation] || "normal";
        } else {
            user.transformationForm = VALID_FORMS.find((form) => FORM_MULTIPLIERS[form] === user.transformation) || "normal";
        }
    }
    if (user.godki > 0 && Number.isFinite(user.level)) {
        setTransformation(user, user.transformationForm);
    }
    if (!Number.isFinite(user.lastXpAt)) user.lastXpAt = 0;
    if (typeof user.lastXpContent !== "string") user.lastXpContent = "";
    if (!Number.isFinite(user.lastXpContentAt)) user.lastXpContentAt = 0;
    if (!Array.isArray(user.achievements)) user.achievements = [];
    if (!Number.isFinite(user.trainingStreakDays)) user.trainingStreakDays = 0;
    if (typeof user.lastTrainingDay !== "string") user.lastTrainingDay = null;
}

function getGodKiBaseMultiplier(godTierLevel = 1) {
    const tier = Math.min(GOD_KI_MAX_TIER, Math.max(1, Math.floor(godTierLevel)));
    const tierProgress = (tier - 1) / (GOD_KI_MAX_TIER - 1);
    return GOD_KI_BASE_MULTIPLIER +
        Math.floor((GOD_KI_MAX_BASE_MULTIPLIER - GOD_KI_BASE_MULTIPLIER) * tierProgress);
}

function getSsgMultiplier(godTierLevel = 1) {
    const tier = Math.min(GOD_KI_MAX_TIER, Math.max(1, Math.floor(godTierLevel)));
    const tierProgress = (tier - 1) / (GOD_KI_MAX_TIER - 1);
    return SSG_MIN_MULTIPLIER + Math.floor((SSG_MAX_MULTIPLIER - SSG_MIN_MULTIPLIER) * tierProgress);
}

function getGodTierLevel(user) {
    return user.godki > 0 ? Math.max(1, user.level - user.godki + 1) : 0;
}

function getTransformationMultiplier(form, godki = 0, godTierLevel = 1) {
    if (!Object.prototype.hasOwnProperty.call(FORM_MULTIPLIERS, form)) {
        throw new Error(`Unknown transformation form: ${form}`);
    }
    const godKiBase = getGodKiBaseMultiplier(godTierLevel);
    const ssgMultiplier = getSsgMultiplier(godTierLevel);
    if (godki > 0 && form === "normal") return godKiBase;
    if (godki > 0 && form === "ssg") return ssgMultiplier;
    if (godki > 0 && form === "ssgss") return ssgMultiplier * 50;
    if (godki > 0 && ["ssj", "ssj2", "ssj3"].includes(form)) {
        const ssgShare = { ssj: 1 / 3, ssj2: 2 / 3, ssj3: 3 / 4 }[form];
        return Math.min(
            godKiBase * FORM_MULTIPLIERS[form],
            Math.floor(ssgMultiplier * ssgShare)
        );
    }
    return FORM_MULTIPLIERS[form];
}

function setTransformation(user, form) {
    user.transformationForm = form;
    user.transformation = getTransformationMultiplier(form, user.godki, getGodTierLevel(user) || 1);
}

function getXpRequiredForLevel(level) {
    return level * BASE_LEVEL_XP + LEVEL_XP_FACTOR * level * (level + 1) * (2 * level + 1) / 6;
}

function addExperience(user, amount) {
    user.points += amount;
    let levelsGained = 0;

    while (user.points - 2500 >= getXpRequiredForLevel(user.level)) {
        user.level += 1;
        levelsGained += 1;
    }

    if (levelsGained > 0 && user.godki > 0) {
        setTransformation(user, user.transformationForm || "normal");
    }

    return levelsGained;
}

function updateGodKiForLevel(user) {
    if (!(user.godki > 0)) return;
    if (user.level < 50) {
        user.godki = 0;
        if (["ssg", "ssgss"].includes(user.transformationForm)) {
            user.transformationForm = "normal";
        }
    } else {
        user.godki = Math.min(user.godki, user.level);
    }
}

function setUserLevel(user, level) {
    if (!Number.isSafeInteger(level) || level < 1) {
        throw new RangeError("Level must be a positive safe integer.");
    }
    user.level = level;
    updateGodKiForLevel(user);
    setTransformation(user, user.transformationForm || "normal");
}

function setBasePower(user, power) {
    if (!Number.isSafeInteger(power) || power < 2500) {
        throw new RangeError("Base power must be a safe integer of at least 2,500.");
    }

    user.points = power;
    user.level = 1;
    let unspentPower = user.points - 2500;
    while (unspentPower >= getXpRequiredForLevel(user.level)) {
        unspentPower -= getXpRequiredForLevel(user.level);
        user.level += 1;
    }

    updateGodKiForLevel(user);
    setTransformation(user, user.transformationForm || "normal");
}

function normalizeMessage(content) {
    return content.trim().replace(/\s+/g, " ").toLowerCase();
}

function canEarnMessageXp(user, normalizedContent, now) {
    if (now - user.lastXpAt < XP_COOLDOWN_MS) return false;
    if (normalizedContent === user.lastXpContent &&
        now - user.lastXpContentAt < REPEATED_MESSAGE_WINDOW_MS) return false;
    return true;
}

function recordMessageXp(user, normalizedContent, now) {
    user.lastXpAt = now;
    user.lastXpContent = normalizedContent;
    user.lastXpContentAt = now;
}

function getProgressAchievementIds(user) {
    const achievements = [];
    for (const level of [10, 25, 50, 64]) {
        if (user.level >= level) achievements.push(`level_${level}`);
    }
    for (const power of [1000000, 10000000, 100000000]) {
        if (user.points - 2500 >= power) achievements.push(`power_${power / 1000000}m`);
    }
    return achievements;
}

function recordTrainingDay(user, now) {
    const today = new Date(now).toISOString().slice(0, 10);
    const previousDay = user.lastTrainingDay
        ? Date.parse(`${user.lastTrainingDay}T00:00:00.000Z`)
        : NaN;
    const todayDate = Date.parse(`${today}T00:00:00.000Z`);
    const consecutiveDay = Number.isFinite(previousDay) && todayDate - previousDay === 24 * 60 * 60 * 1000;

    user.trainingStreakDays = consecutiveDay ? user.trainingStreakDays + 1 : 1;
    user.lastTrainingDay = today;
}

function optOutUser(privacyStore, pointsStore, key) {
    privacyStore.set(key, true);
    pointsStore.delete(key);
}

function optInUser(privacyStore, key) {
    privacyStore.delete(key);
}

module.exports = {
    ACHIEVEMENTS,
    MAX_STAMINA,
    XP_COOLDOWN_MS,
    GOD_KI_BASE_MULTIPLIER,
    GOD_KI_MAX_BASE_MULTIPLIER,
    GOD_KI_MAX_TIER,
    REPEATED_MESSAGE_WINDOW_MS,
    addExperience,
    canEarnMessageXp,
    createDefaultUser,
    getGodKiBaseMultiplier,
    getGodTierLevel,
    getProgressAchievementIds,
    getSsgMultiplier,
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
};
