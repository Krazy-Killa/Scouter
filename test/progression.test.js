const test = require("node:test");
const assert = require("node:assert/strict");
const {
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

test("privacy opt-out deletes progression and opt-in clears the opt-out marker", () => {
    const privacyStore = new Map();
    const pointsStore = new Map([["guild-user", { points: 10000 }]]);

    optOutUser(privacyStore, pointsStore, "guild-user");
    assert.equal(privacyStore.get("guild-user"), true);
    assert.equal(pointsStore.has("guild-user"), false);

    optInUser(privacyStore, "guild-user");
    assert.equal(privacyStore.has("guild-user"), false);
});
