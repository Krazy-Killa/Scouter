const test = require("node:test");
const assert = require("node:assert/strict");
const {
    XP_COOLDOWN_MS,
    REPEATED_MESSAGE_WINDOW_MS,
    RACES,
    RACE_LOCK_BASE_POWER,
    addExperience,
    canEarnMessageXp,
    changeRace,
    createDefaultUser,
    getGodKiBaseMultiplier,
    getGodTierLevel,
    getGodKiAwakeningChance,
    getKaiokenMultiplier,
    hasReachedGodTier,
    getSsgMultiplier,
    getProgressAchievementIds,
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

test("sets base power and recalculates the tier from total earned power", () => {
    const user = createDefaultUser("user", "guild", 0);

    setBasePower(user, 2500 + getXpRequiredForLevel(1));
    assert.equal(user.points, 10500);
    assert.equal(user.level, 2);

    setBasePower(user, 2500);
    assert.equal(user.level, 1);
});

test("a power gain advances the user when the displayed next-tier requirement is met", () => {
    const user = createDefaultUser("user", "guild", 0);
    const level5Threshold = getXpRequiredForLevel(5);
    setBasePower(user, 2500 + level5Threshold - 1);
    assert.equal(user.level, 5);

    assert.equal(addExperience(user, 1), 1);
    assert.equal(user.level, 6);
});

test("clears God Ki and reverts god forms when set power lowers the tier below 50", () => {
    const user = createDefaultUser("user", "guild", 0);
    user.race = "saiyan";
    user.level = 50;
    user.godki = 50;
    setTransformation(user, "ssgss");

    setBasePower(user, 2500);

    assert.equal(user.level, 1);
    assert.equal(user.godki, 0);
    assert.equal(user.transformationForm, "normal");
    assert.equal(user.transformation, 1);
});

test("clears God Ki when an admin-set level falls below Tier 50", () => {
    const user = createDefaultUser("user", "guild", 0);
    user.race = "saiyan";
    user.level = 50;
    user.godki = 50;
    setTransformation(user, "ssg");

    setUserLevel(user, 49);

    assert.equal(user.godki, 0);
    assert.equal(user.transformationForm, "normal");
    assert.equal(user.transformation, 1);
});

test("updates God Tier transformation scaling when set power raises an unlocked user", () => {
    const user = createDefaultUser("user", "guild", 0);
    user.race = "saiyan";
    user.godki = 50;
    setTransformation(user, "ssg");
    const powerForGodTierTwo = 2500 + getXpRequiredForLevel(50);

    setBasePower(user, powerForGodTierTwo);

    assert.equal(user.level, 51);
    assert.equal(user.godki, 50);
    assert.equal(user.transformation, 20714);
});

test("rejects invalid base power values", () => {
    const user = createDefaultUser("user", "guild", 0);

    assert.throws(() => setBasePower(user, 2499), /at least 2,500/);
    assert.throws(() => setBasePower(user, 2500.5), /safe integer/);
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
    assert.equal(legacyUser.godKiAwakeningAttempts, 0);
    assert.equal(legacyUser.lastGodKiAwakeningAttemptAt, 0);
});

test("God Ki awakening pity chance doubles after four failed attempts and caps at 100 percent", () => {
    assert.equal(getGodKiAwakeningChance(0), 0.05);
    assert.equal(getGodKiAwakeningChance(3), 0.05);
    assert.equal(getGodKiAwakeningChance(4), 0.1);
    assert.equal(getGodKiAwakeningChance(5), 0.2);
    assert.equal(getGodKiAwakeningChance(6), 0.4);
    assert.equal(getGodKiAwakeningChance(7), 0.8);
    assert.equal(getGodKiAwakeningChance(8), 1);
    assert.throws(() => getGodKiAwakeningChance(-1), /non-negative safe integer/);
});

test("new profiles default to Human while legacy profiles remain Saiyan and high-power profiles lock", () => {
    assert.equal(createDefaultUser("new", "guild", 0).race, "human");
    const legacyUser = { userID: "legacy", guildID: "guild", points: 2500 + RACE_LOCK_BASE_POWER };

    initializeUserProgress(legacyUser);

    assert.equal(legacyUser.race, "saiyan");
    assert.equal(legacyUser.raceLocked, true);
});

test("race changes are allowed below the base-power threshold and reset the active form", () => {
    const user = createDefaultUser("user", "guild", 0);
    user.race = "saiyan";
    user.godki = 50;
    setKaiokenLevel(user, 2);
    setTransformation(user, "ssg");

    assert.equal(changeRace(user, "human"), true);
    assert.equal(user.race, "human");
    assert.equal(user.godki, 50);
    assert.equal(user.kaiokenLevel, 2);
    assert.equal(user.transformationForm, "normal");
    assert.equal(user.transformation, 2);
});

test("race locks permanently at one million base power", () => {
    const user = createDefaultUser("user", "guild", 0);
    user.points += RACE_LOCK_BASE_POWER - 1;
    assert.equal(changeRace(user, "namekian"), true);

    addExperience(user, 1);
    assert.equal(user.raceLocked, true);
    assert.equal(changeRace(user, "frieza"), false);

    setBasePower(user, 2500);
    assert.equal(changeRace(user, "frieza"), false);
});

test("racial transformations are restricted to their races and God Tier scales them", () => {
    assert.equal(Object.keys(RACES).length, 4);
    assert.equal(isFormAvailableForRace("ssj", "human"), false);
    assert.equal(isFormAvailableForRace("golden", "frieza"), true);
    assert.equal(isFormAvailableForRace("ssg", "namekian"), false);
    assert.equal(isFormAvailableForRace("normal", "namekian"), true);

    assert.equal(getTransformationMultiplier("potential", 0, 1, "human"), 100);
    assert.equal(getTransformationMultiplier("potential", 1, 15, "human"), 40000);
    assert.equal(getTransformationMultiplier("potential", 1, 15, "namekian"), 100000);
    assert.equal(getTransformationMultiplier("golden", 1, 15, "frieza"), 160000);
});

test("Kaioken is an ability multiplier that stacks with compatible forms", () => {
    const user = createDefaultUser("user", "guild", 0);
    assert.equal(getKaiokenMultiplier(0), 1);
    assert.equal(getKaiokenMultiplier(2), 2);
    assert.equal(getKaiokenMultiplier(3), 3);
    assert.equal(getKaiokenMultiplier(4), 4);
    assert.equal(getKaiokenMultiplier(10), 10);

    setKaiokenLevel(user, 3);
    assert.equal(user.transformation, 3);

    user.race = "human";
    setTransformation(user, "potential");
    assert.equal(user.transformation, 300);

    user.race = "saiyan";
    user.godki = 58;
    user.level = 72;
    setTransformation(user, "ssgss");
    assert.equal(user.transformation, 4500000);

    setTransformation(user, "ssj");
    assert.equal(user.kaiokenLevel, 0);
    assert.throws(() => setKaiokenLevel(user, 2), /not compatible/);
});

test("migrates previous standalone Kaioken forms into the ability field", () => {
    const legacyUser = {
        userID: "legacy",
        guildID: "guild",
        points: 2500,
        level: 25,
        race: "human",
        transformation: 20,
        transformationForm: "kaioken"
    };

    initializeUserProgress(legacyUser);

    assert.equal(legacyUser.transformationForm, "normal");
    assert.equal(legacyUser.kaiokenLevel, 10);
    assert.equal(legacyUser.transformation, 10);
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

test("keeps every god-ki Saiyan form below SSG while preserving form order", () => {
    assert.equal(getTransformationMultiplier("normal", 1, 1), 1);
    assert.equal(getTransformationMultiplier("ssj", 1, 1), 50);
    assert.equal(getTransformationMultiplier("ssj2", 1, 15), 20000);
    assert.equal(getTransformationMultiplier("ssj3", 1, 15), 22500);
    assert.equal(getTransformationMultiplier("ssg", 1, 15), 30000);
    assert.equal(getTransformationMultiplier("ssgss", 1, 15), 1500000);
    for (let tier = 1; tier <= 15; tier += 1) {
        const ssj = getTransformationMultiplier("ssj", 1, tier);
        const ssj2 = getTransformationMultiplier("ssj2", 1, tier);
        const ssj3 = getTransformationMultiplier("ssj3", 1, tier);
        const ssg = getTransformationMultiplier("ssg", 1, tier);
        assert.ok(ssj3 <= Math.floor(ssg * 0.75), `SSJ3 should be capped at 75% of SSG at God Tier ${tier}`);
        assert.ok(ssj < ssj2, `SSJ should remain below SSJ2 at God Tier ${tier}`);
        assert.ok(ssj2 < ssj3, `SSJ2 should remain below SSJ3 at God Tier ${tier}`);
        assert.ok(ssj3 < ssg, `SSJ3 should remain below SSG at God Tier ${tier}`);
    }
    assert.equal(
        getTransformationMultiplier("ssgss", 1, 8),
        getTransformationMultiplier("ssg", 1, 8) * 50
    );
});

test("updates the active god-ki multiplier when the user gains a God Tier", () => {
    const user = createDefaultUser("user", "guild", 0);
    user.race = "saiyan";
    user.godki = 1;
    setTransformation(user, "ssg");

    assert.equal(user.transformation, 20000);
    assert.equal(addExperience(user, getXpRequiredForLevel(1)), 1);
    assert.equal(user.level, 2);
    assert.equal(user.transformation, 20714);
});

test("maps overall levels relative to each user's God Ki awakening level", () => {
    const user = createDefaultUser("user", "guild", 0);
    user.godki = 58;
    user.level = 58;
    assert.equal(getGodTierLevel(user), 1);
    assert.equal(hasReachedGodTier(user, 15), false);

    user.level = 71;
    assert.equal(getGodTierLevel(user), 14);
    assert.equal(hasReachedGodTier(user, 15), false);

    user.level = 72;
    assert.equal(getGodTierLevel(user), 15);
    assert.equal(hasReachedGodTier(user, 15), true);

    user.level = 100;
    assert.equal(getGodTierLevel(user), 43);
    assert.equal(hasReachedGodTier(user, 15), true);
});

test("God Tier requirements cannot be met before God Ki is awakened", () => {
    const user = createDefaultUser("user", "guild", 0);
    user.level = 100;

    assert.equal(getGodTierLevel(user), 0);
    assert.equal(hasReachedGodTier(user, 15), false);
});

test("preserves transformation identity for all god-ki forms", () => {
    const user = createDefaultUser("user", "guild", 0);
    user.race = "saiyan";
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

test("migrates legacy Enmap JSON values atomically to the Enmap 6 format", async () => {
    const Database = require("better-sqlite3");
    const { parse, stringify } = await import("better-serialize");
    const { migrateLegacyEnmapData } = require("../enmap-migration");
    const database = new Database(":memory:");
    database.exec("CREATE TABLE points (key text PRIMARY KEY, value text); CREATE TABLE privacy (key text PRIMARY KEY, value text)");
    database.prepare("INSERT INTO points (key, value) VALUES (?, ?)").run(
        "legacy",
        JSON.stringify({ points: 2500, achievements: [] })
    );
    database.prepare("INSERT INTO points (key, value) VALUES (?, ?)").run(
        "current",
        stringify({ points: 5000, achievements: [] })
    );
    database.prepare("INSERT INTO privacy (key, value) VALUES (?, ?)").run(
        "legacy-opt-out",
        JSON.stringify(true)
    );

    try {
        migrateLegacyEnmapData(database, stringify);
        const readValue = database.prepare("SELECT value FROM points WHERE key = ?");
        assert.deepEqual(parse(readValue.get("legacy").value), { points: 2500, achievements: [] });
        assert.deepEqual(parse(readValue.get("current").value), { points: 5000, achievements: [] });
        assert.equal(parse(database.prepare("SELECT value FROM privacy WHERE key = ?").get("legacy-opt-out").value), true);
    } finally {
        database.close();
    }
});

test("rolls back the Enmap migration when a stored value is invalid", async () => {
    const Database = require("better-sqlite3");
    const { stringify } = await import("better-serialize");
    const { migrateLegacyEnmapData } = require("../enmap-migration");
    const database = new Database(":memory:");
    database.exec("CREATE TABLE points (key text PRIMARY KEY, value text); CREATE TABLE privacy (key text PRIMARY KEY, value text)");
    const legacyValues = [
        ["user", JSON.stringify({ points: 2500 })],
        ["another-user", JSON.stringify({ points: 5000 })]
    ];
    const insertPoint = database.prepare("INSERT INTO points (key, value) VALUES (?, ?)");
    for (const [key, value] of legacyValues) insertPoint.run(key, value);
    database.prepare("INSERT INTO privacy (key, value) VALUES (?, ?)").run("invalid", "{");

    try {
        assert.throws(
            () => migrateLegacyEnmapData(database, stringify),
            /Cannot migrate Enmap table "privacy" record 1: stored value is not valid JSON/
        );
        const readPoint = database.prepare("SELECT value FROM points WHERE key = ?");
        for (const [key, value] of legacyValues) {
            assert.equal(readPoint.get(key).value, value);
        }
    } finally {
        database.close();
    }
});

test("Enmap migration tolerates databases without either application table", () => {
    const Database = require("better-sqlite3");
    const { migrateLegacyEnmapData } = require("../enmap-migration");
    const database = new Database(":memory:");

    try {
        assert.doesNotThrow(() => migrateLegacyEnmapData(database, JSON.stringify));
    } finally {
        database.close();
    }
});
