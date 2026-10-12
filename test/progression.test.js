const test = require("node:test");
const assert = require("node:assert/strict");
const {
    XP_COOLDOWN_MS,
    REPEATED_MESSAGE_WINDOW_MS,
    addExperience,
    canEarnMessageXp,
    createDefaultUser,
    getGodKiBaseMultiplier,
    getGodTierLevel,
    getSsgMultiplier,
    getProgressAchievementIds,
    getTransformationMultiplier,
    getXpRequiredForLevel,
    initializeUserProgress,
    normalizeMessage,
    optInUser,
    optOutUser,
    recordMessageXp,
    recordTrainingDay,
    setTransformation
} = require("../progression");

test("normalizes message case and whitespace before duplicate checks", () => {
    assert.equal(normalizeMessage("  Hello \t WORLD  "), "hello world");
});

test("awards XP once the cooldown has elapsed for a different message", () => {
    const user = createDefaultUser("user", "guild", 0);
    recordMessageXp(user, "first", 1000);

    assert.equal(canEarnMessageXp(user, "second", 1000 + XP_COOLDOWN_MS - 1), false);
    assert.equal(canEarnMessageXp(user, "second", 1000 + XP_COOLDOWN_MS), true);
});

test("blocks a repeated message until its repeat window expires", () => {
    const user = createDefaultUser("user", "guild", 0);
    recordMessageXp(user, "same message", 1000);

    assert.equal(canEarnMessageXp(user, "same message", 1000 + XP_COOLDOWN_MS), false);
    assert.equal(canEarnMessageXp(user, "same message", 1000 + REPEATED_MESSAGE_WINDOW_MS - 1), false);
    assert.equal(canEarnMessageXp(user, "same message", 1000 + REPEATED_MESSAGE_WINDOW_MS), true);
});

test("computes level thresholds and grants every crossed level", () => {
    assert.equal(getXpRequiredForLevel(1), 8000);

    const user = createDefaultUser("user", "guild", 0);
    const totalForLevel3 = getXpRequiredForLevel(1) + getXpRequiredForLevel(2);
    assert.equal(addExperience(user, totalForLevel3), 2);
    assert.equal(user.level, 3);
});

test("unlocks progression achievements for attained level and base power", () => {
    const user = createDefaultUser("user", "guild", 0);
    user.level = 64;
    user.points = 2500 + 10000000;

    assert.deepEqual(getProgressAchievementIds(user), [
        "level_10", "level_25", "level_50", "level_64", "power_1m", "power_10m"
    ]);
});

test("increments training streak on consecutive UTC days and resets after a gap", () => {
    const user = createDefaultUser("user", "guild", 0);
    const day1 = Date.parse("2026-01-01T23:59:00.000Z");

    recordTrainingDay(user, day1);
    recordTrainingDay(user, day1 + 2 * 60 * 1000);
    assert.equal(user.trainingStreakDays, 2);

    recordTrainingDay(user, day1 + 3 * 24 * 60 * 60 * 1000);
    assert.equal(user.trainingStreakDays, 1);
});

test("initializes new progression fields on existing records", () => {
    const legacyUser = { userID: "user", guildID: "guild" };

    initializeUserProgress(legacyUser);

    assert.equal(legacyUser.lastXpAt, 0);
    assert.equal(legacyUser.lastXpContent, "");
    assert.deepEqual(legacyUser.achievements, []);
    assert.equal(legacyUser.trainingStreakDays, 0);
    assert.equal(legacyUser.lastTrainingDay, null);
});

test("scales Beyond God and SSG multipliers linearly across God Tier 1 through 15", () => {
    assert.equal(getGodKiBaseMultiplier(1), 1);
    assert.equal(getGodKiBaseMultiplier(8), 200);
    assert.equal(getGodKiBaseMultiplier(15), 400);
    assert.equal(getGodKiBaseMultiplier(100), 400);

    assert.equal(getSsgMultiplier(1), 20000);
    assert.equal(getSsgMultiplier(8), 25000);
    assert.equal(getSsgMultiplier(15), 30000);
    assert.equal(getSsgMultiplier(100), 30000);
});

test("uses tier-scaled multipliers for all god-ki forms", () => {
    assert.equal(getTransformationMultiplier("normal", 1, 1), 1);
    assert.equal(getTransformationMultiplier("ssj", 1, 1), 50);
    assert.equal(getTransformationMultiplier("ssj2", 1, 15), 40000);
    assert.equal(getTransformationMultiplier("ssj3", 1, 15), 160000);
    assert.equal(getTransformationMultiplier("ssg", 1, 15), 30000);
    assert.equal(getTransformationMultiplier("ssgss", 1, 15), 1500000);
    assert.equal(
        getTransformationMultiplier("ssgss", 1, 8),
        getTransformationMultiplier("ssg", 1, 8) * 50
    );
});

test("updates the active god-ki multiplier when the user gains a God Tier", () => {
    const user = createDefaultUser("user", "guild", 0);
    user.godki = 1;
    setTransformation(user, "ssg");

    assert.equal(user.transformation, 20000);
    assert.equal(addExperience(user, getXpRequiredForLevel(1)), 1);
    assert.equal(user.level, 2);
    assert.equal(user.transformation, 20714);
});

test("maps overall level 50 to God Tier 1 and level 64 to God Tier 15", () => {
    const user = createDefaultUser("user", "guild", 0);
    user.godki = 50;
    user.level = 50;
    assert.equal(getGodTierLevel(user), 1);

    user.level = 64;
    assert.equal(getGodTierLevel(user), 15);
});

test("preserves transformation identity for all god-ki forms", () => {
    const user = createDefaultUser("user", "guild", 0);
    user.godki = 1;

    setTransformation(user, "ssj2");
    assert.equal(user.transformation, 100);
    assert.equal(user.transformationForm, "ssj2");

    setTransformation(user, "ssgss");
    assert.equal(user.transformation, 1000000);
    assert.equal(user.transformationForm, "ssgss");
});

test("migrates existing god-ki records to their matching form name", () => {
    const legacyUser = { userID: "user", guildID: "guild", level: 64, godki: 64, transformation: 8000000 };

    initializeUserProgress(legacyUser);

    assert.equal(legacyUser.transformationForm, "ssgss");
    assert.equal(legacyUser.transformation, 1000000);
});

test("privacy opt-out deletes progression and opt-in clears the opt-out marker", () => {
    const privacyStore = new Map();
    const pointsStore = new Map([["guild-user", { points: 10000 }]]);

    optOutUser(privacyStore, pointsStore, "guild-user");
    assert.equal(privacyStore.get("guild-user"), true);
    assert.equal(pointsStore.has("guild-user"), false);

    optInUser(privacyStore, "guild-user");
    assert.equal(privacyStore.has("guild-user"), false);
});
