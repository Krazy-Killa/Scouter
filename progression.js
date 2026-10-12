const MAX_STAMINA = 10000;
const XP_COOLDOWN_MS = 60 * 1000;
const REPEATED_MESSAGE_WINDOW_MS = 10 * 60 * 1000;
const BASE_LEVEL_XP = 5000;
const LEVEL_XP_FACTOR = 3000;

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
    form_ssj: { name: "Super Saiyan", description: "Transform into SSJ." },
    form_ssj2: { name: "Ascended Saiyan", description: "Transform into SSJ2." },
    form_ssj3: { name: "Unleashed Power", description: "Transform into SSJ3." },
    form_ssg: { name: "Godly Power", description: "Transform into SSG." },
    form_ssgss: { name: "Beyond Godhood", description: "Transform into SSGSS." }
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
    if (!Number.isFinite(user.lastXpAt)) user.lastXpAt = 0;
    if (typeof user.lastXpContent !== "string") user.lastXpContent = "";
    if (!Number.isFinite(user.lastXpContentAt)) user.lastXpContentAt = 0;
    if (!Array.isArray(user.achievements)) user.achievements = [];
    if (!Number.isFinite(user.trainingStreakDays)) user.trainingStreakDays = 0;
    if (typeof user.lastTrainingDay !== "string") user.lastTrainingDay = null;
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

    return levelsGained;
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
    REPEATED_MESSAGE_WINDOW_MS,
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
};
