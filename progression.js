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
const RACE_LOCK_BASE_POWER = 1000000;
const GOD_KI_AWAKENING_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const GOD_KI_AWAKENING_BASE_CHANCE = 0.05;
const GOD_KI_AWAKENING_PITY_ATTEMPTS = 4;

const RACES = {
    saiyan: {
        name: "Saiyan",
        forms: ["ssj", "ssj2", "ssj3", "ssg", "ssgss"]
    },
    human: {
        name: "Human",
        forms: ["potential"]
    },
    namekian: {
        name: "Namekian",
        forms: ["giant", "potential"]
    },
    frieza: {
        name: "Frieza Race",
        forms: ["final", "golden"]
    }
};

const RACE_FORM_MULTIPLIERS = {
    human: { potential: 100 },
    namekian: { giant: 50, potential: 250 },
    frieza: { final: 50, golden: 400 }
};

const FORM_MULTIPLIERS = {
    normal: 1,
    ssj: 50,
    ssj2: 100,
    ssj3: 400,
    ssg: SSG_MIN_MULTIPLIER,
    ssgss: SSG_MIN_MULTIPLIER * 50
};

const VALID_FORMS = [...new Set([
    ...Object.keys(FORM_MULTIPLIERS),
    ...Object.values(RACE_FORM_MULTIPLIERS).flatMap((forms) => Object.keys(forms))
])];
const KAIOKEN_LEVELS = [2, 3, 4, 10];
const UNSTABLE_KAIOKEN_FORMS = ["ssj", "ssj2", "ssj3"];
const UNIVERSAL_FORMS = ["normal"];
const GOD_KI_FORMS = ["normal", "ssg", "ssgss"];

const ACHIEVEMENTS = {
    level_10: { name: "Rising Fighter", description: "Reach Tier 10." },
    level_25: { name: "Elite Warrior", description: "Reach Tier 25." },
    level_50: { name: "God Ki Threshold", description: "Reach Tier 50 and unlock the ability to awaken God Ki." },
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
    form_ssgss: { name: "Beyond Godhood", description: "Transform into Super Saiyan God Super Saiyan." },
    form_kaioken: { name: "Kaio-ken", description: "Use Kaioken as an ability." },
    form_potential: { name: "Potential Unleashed", description: "Transform into Potential Unleashed." },
    form_giant: { name: "Giant Namekian", description: "Transform into Giant Namekian." },
    form_final: { name: "Final Form", description: "Transform into Final Form." },
    form_golden: { name: "Golden Form", description: "Transform into Golden Form." },
    form_beyondgod: { name: "God Ki Awakened", description: "Awaken universal God Ki." }
};

function createDefaultUser(authorId, guildId, now = Date.now()) {
    return {
        userID: authorId,
        guildID: guildId,
        points: 2500,
        level: 1,
        race: "human",
        raceLocked: false,
        transformation: 1,
        transformationForm: "normal",
        kaiokenLevel: 0,
        godki: 0,
        godKiAwakeningAttempts: 0,
        lastGodKiAwakeningAttemptAt: 0,
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
    const legacyKaiokenForms = {
        kaioken: 10,
        kaioken2: 2,
        kaioken3: 3,
        kaioken4: 4,
        kaioken10: 10
    };
    if (Object.prototype.hasOwnProperty.call(legacyKaiokenForms, user.transformationForm)) {
        user.kaiokenLevel = legacyKaiokenForms[user.transformationForm];
        user.transformationForm = "normal";
    }
    if (!KAIOKEN_LEVELS.includes(user.kaiokenLevel)) user.kaiokenLevel = 0;
    if (!Number.isSafeInteger(user.godKiAwakeningAttempts) || user.godKiAwakeningAttempts < 0) {
        user.godKiAwakeningAttempts = 0;
    }
    if (!Number.isFinite(user.lastGodKiAwakeningAttemptAt)) user.lastGodKiAwakeningAttemptAt = 0;
    if (!Object.prototype.hasOwnProperty.call(RACES, user.race)) user.race = "saiyan";
    if (typeof user.raceLocked !== "boolean") user.raceLocked = false;
    if (user.points - 2500 >= RACE_LOCK_BASE_POWER) user.raceLocked = true;
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
    if (!isFormAvailableForRace(user.transformationForm, user.race)) {
        user.transformationForm = "normal";
    }
    if (UNSTABLE_KAIOKEN_FORMS.includes(user.transformationForm)) user.kaiokenLevel = 0;
    if (Number.isFinite(user.level)) {
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

function hasReachedGodTier(user, requiredTier) {
    return user.godki > 0 && getGodTierLevel(user) >= requiredTier;
}

function getGodKiAwakeningChance(failedAttempts) {
    if (!Number.isSafeInteger(failedAttempts) || failedAttempts < 0) {
        throw new RangeError("Failed God Ki awakening attempts must be a non-negative safe integer.");
    }
    const pitySteps = Math.max(0, failedAttempts - GOD_KI_AWAKENING_PITY_ATTEMPTS + 1);
    return Math.min(1, GOD_KI_AWAKENING_BASE_CHANCE * (2 ** pitySteps));
}

function isFormAvailableForRace(form, race = "saiyan") {
    if (!Object.prototype.hasOwnProperty.call(RACES, race)) return false;
    if (UNIVERSAL_FORMS.includes(form)) return true;
    if (GOD_KI_FORMS.includes(form)) return race === "saiyan";
    return RACES[race].forms.includes(form);
}

function getTransformationMultiplier(form, godki = 0, godTierLevel = 1, race = "saiyan") {
    if (!VALID_FORMS.includes(form)) {
        throw new Error(`Unknown transformation form: ${form}`);
    }
    if (!isFormAvailableForRace(form, race)) {
        throw new Error(`Transformation ${form} is not available to race ${race}.`);
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
    const raceFormMultiplier = RACE_FORM_MULTIPLIERS[race]?.[form];
    if (raceFormMultiplier !== undefined) {
        return godki > 0 ? godKiBase * raceFormMultiplier : raceFormMultiplier;
    }
    return FORM_MULTIPLIERS[form];
}

function setTransformation(user, form) {
    const race = Object.prototype.hasOwnProperty.call(RACES, user.race) ? user.race : "saiyan";
    if (!isFormAvailableForRace(form, race)) {
        throw new Error(`Transformation ${form} is not available to race ${race}.`);
    }
    user.transformationForm = form;
    if (UNSTABLE_KAIOKEN_FORMS.includes(form)) user.kaiokenLevel = 0;
    user.transformation = getTransformationMultiplier(form, user.godki, getGodTierLevel(user) || 1, race)
        * getKaiokenMultiplier(user.kaiokenLevel);
}

function getKaiokenMultiplier(level) {
    if (!KAIOKEN_LEVELS.includes(level)) return 1;
    return level;
}

function setKaiokenLevel(user, level) {
    if (level !== 0 && !KAIOKEN_LEVELS.includes(level)) {
        throw new RangeError(`Unknown Kaioken level: ${level}`);
    }
    if (level > 0 && UNSTABLE_KAIOKEN_FORMS.includes(user.transformationForm)) {
        throw new Error(`Kaioken is not compatible with ${user.transformationForm} due to Ki instability.`);
    }
    user.kaiokenLevel = level;
    const race = Object.prototype.hasOwnProperty.call(RACES, user.race) ? user.race : "saiyan";
    user.transformation = getTransformationMultiplier(
        user.transformationForm || "normal",
        user.godki,
        getGodTierLevel(user) || 1,
        race
    ) * getKaiokenMultiplier(level);
}

function changeRace(user, race) {
    if (!Object.prototype.hasOwnProperty.call(RACES, race)) {
        throw new RangeError(`Unknown race: ${race}`);
    }
    if (user.race === race) return false;
    if (user.raceLocked || user.points - 2500 >= RACE_LOCK_BASE_POWER) {
        user.raceLocked = true;
        return false;
    }
    user.race = race;
    user.transformationForm = "normal";
    setTransformation(user, "normal");
    return true;
}

function getXpRequiredForLevel(level) {
    return level * BASE_LEVEL_XP + LEVEL_XP_FACTOR * level * (level + 1) * (2 * level + 1) / 6;
}

function addExperience(user, amount) {
    user.points += amount;
    if (user.points - 2500 >= RACE_LOCK_BASE_POWER) user.raceLocked = true;
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
    if (user.points - 2500 >= RACE_LOCK_BASE_POWER) user.raceLocked = true;
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
    RACES,
    RACE_LOCK_BASE_POWER,
    XP_COOLDOWN_MS,
    GOD_KI_BASE_MULTIPLIER,
    GOD_KI_AWAKENING_BASE_CHANCE,
    GOD_KI_AWAKENING_COOLDOWN_MS,
    GOD_KI_MAX_BASE_MULTIPLIER,
    GOD_KI_MAX_TIER,
    REPEATED_MESSAGE_WINDOW_MS,
    addExperience,
    canEarnMessageXp,
    changeRace,
    createDefaultUser,
    getGodKiBaseMultiplier,
    getGodKiAwakeningChance,
    getGodTierLevel,
    getKaiokenMultiplier,
    hasReachedGodTier,
    getProgressAchievementIds,
    getSsgMultiplier,
    getTransformationMultiplier,
    getXpRequiredForLevel,
    initializeUserProgress,
    isFormAvailableForRace,
    normalizeMessage,
    optInUser,
    optOutUser,
    recordMessageXp,
    recordTrainingDay,
    setBasePower,
    setKaiokenLevel,
    setUserLevel,
    setTransformation
};
