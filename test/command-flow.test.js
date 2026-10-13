const test = require("node:test");
const assert = require("node:assert/strict");
const { client, handleInteraction, handleMessage, SLASH_COMMANDS } = require("../xp");
const { createDefaultUser } = require("../progression");

class TestStore extends Map {
    filter(predicate) {
        return [...this.values()].filter(predicate);
    }
}

function createMessage(content, userId = "user", targetUser = null) {
    const sent = [];
    const replied = [];
    const [commandName, ...commandArgs] = content.startsWith("!")
        ? content.slice(1).trim().split(/\s+/g)
        : [];
    const targetUsers = Array.isArray(targetUser) ? targetUser : targetUser ? [targetUser] : [];
    const targetMembers = targetUsers.map((user) => ({
        id: user.id,
        user,
        displayName: user.username || user.id
    }));
    const targetMember = targetMembers[0] || null;
    const author = {
        id: userId,
        username: userId,
        bot: false,
        displayAvatarURL: () => "https://example.invalid/avatar.png"
    };
    const channel = {
        send: async (payload) => {
            const response = { payload, delete: async () => {} };
            sent.push(response);
            return response;
        }
    };
    const message = {
        content,
        isSlashCommand: content.startsWith("!"),
        commandName: commandName?.toLowerCase() || null,
        commandArgs,
        author,
        member: { displayName: userId },
        guild: {
            id: "guild",
            name: "Test Guild",
            ownerId: "owner",
            members: { cache: new Map(targetMembers.map((member) => [member.id, member])) }
        },
        channel,
        mentions: {
            members: { first: () => targetMember },
            users: {
                first: () => targetUsers[0] || null,
                values: () => targetUsers.values()
            }
        },
        delete: async () => {},
        reply: async (payload) => {
            const response = { payload, delete: async () => {} };
            replied.push(response);
            return response;
        }
    };

    return { message, sent, replied };
}

function createInteraction(commandName, optionValues = {}, userId = "user") {
    const fixture = createMessage("", userId, optionValues.target || null);
    const targetMember = fixture.message.mentions.members.first();
    const interaction = {
        commandName,
        user: fixture.message.author,
        member: fixture.message.member,
        guild: fixture.message.guild,
        options: {
            getString: (name) => optionValues[name] ?? null,
            getInteger: (name) => optionValues[name] ?? null,
            getUser: (name) => optionValues[name] ?? null,
            getMember: (name) => name === "target" ? targetMember : null
        },
        inGuild: () => true,
        deferReply: async () => { interaction.deferred = true; },
        editReply: async (payload) => {
            const response = { payload, delete: async () => {} };
            fixture.sent.push(response);
            return response;
        },
        followUp: async (payload) => {
            const response = { payload, delete: async () => {} };
            fixture.sent.push(response);
            return response;
        },
        reply: async (payload) => {
            const response = { payload, delete: async () => {} };
            fixture.replied.push(response);
            return response;
        }
    };

    return { interaction, ...fixture };
}

test.beforeEach(() => {
    client.points = new TestStore();
    client.privacy = new TestStore();
    client.user = { displayAvatarURL: () => "https://example.invalid/bot.png" };
});

test("registers the complete guild-only slash command set", () => {
    const commands = SLASH_COMMANDS.map((command) => command.toJSON());
    assert.deepEqual(commands.map((command) => command.name), [
        "help", "scan", "profile", "compare", "leaderboard", "achievements",
        "train", "transform", "kaioken", "revert", "race", "privacy",
        "setlevel", "setpower", "awardpower", "reset"
    ]);
    const transform = commands.find((command) => command.name === "transform");
    assert.deepEqual(transform.options.map((option) => option.name), [
        "form", "helper1", "helper2", "helper3", "helper4", "helper5"
    ]);
    assert.equal(commands.every((command) => command.dm_permission === false), true);
});

test("slash interaction handles privacy opt-out and responds through the interaction", async () => {
    const key = "guild-user";
    client.points.set(key, createDefaultUser("user", "guild", 0));
    const fixture = createInteraction("privacy", { action: "optout" });

    await handleInteraction(fixture.interaction);

    assert.equal(client.privacy.get(key), true);
    assert.equal(client.points.has(key), false);
    assert.equal(fixture.interaction.deferred, true);
    assert.match(fixture.sent[0].payload, /saved progression record has been deleted/i);
});

test("slash transform passes five selected helpers to the first Saiyan SSG awakening", async () => {
    const saiyan = createDefaultUser("user", "guild", 0);
    saiyan.race = "saiyan";
    saiyan.level = 50;
    client.points.set("guild-user", saiyan);
    const helpers = Array.from({ length: 5 }, (_, index) => ({
        id: `helper-${index}`,
        username: `helper-${index}`,
        displayAvatarURL: () => "https://example.invalid/avatar.png"
    }));
    for (const helper of helpers) {
        const profile = createDefaultUser(helper.id, "guild", 0);
        profile.race = "saiyan";
        client.points.set(`guild-${helper.id}`, profile);
    }
    const fixture = createInteraction("transform", {
        form: "ssg",
        ...Object.fromEntries(helpers.map((helper, index) => [`helper${index + 1}`, helper]))
    });

    await handleInteraction(fixture.interaction);

    assert.equal(saiyan.godki, 50);
    assert.equal(saiyan.transformationForm, "ssg");
});

test("slash owner control resolves its selected target and string power option", async () => {
    const target = {
        id: "target",
        username: "target",
        tag: "target#0001",
        displayAvatarURL: () => "https://example.invalid/avatar.png"
    };
    const fixture = createInteraction("setpower", { target, power: "10000" }, "owner");

    await handleInteraction(fixture.interaction);

    assert.equal(client.points.get("guild-target").points, 10000);
    assert.ok(fixture.sent.length >= 1);
});

test("legacy prefix text is not dispatched as a command", async () => {
    const fixture = createMessage("!privacy optout");
    fixture.message.isSlashCommand = false;

    await handleMessage(fixture.message);

    assert.equal(client.privacy.has("guild-user"), false);
    assert.equal(client.points.has("guild-user"), false);
    assert.equal(fixture.sent.length, 0);
});

test("privacy opt-out blocks progression and opt-in starts a fresh record", async () => {
    const key = "guild-user";
    client.points.set(key, createDefaultUser("user", "guild", 0));

    const optOut = createMessage("!privacy optout");
    await handleMessage(optOut.message);
    assert.equal(client.privacy.get(key), true);
    assert.equal(client.points.has(key), false);
    assert.match(optOut.sent[0].payload, /saved progression record has been deleted/i);

    const blockedCommand = createMessage("!profile");
    await handleMessage(blockedCommand.message);
    assert.match(blockedCommand.replied[0].payload, /tracking is off/i);
    assert.equal(client.points.has(key), false);

    const optIn = createMessage("!privacy optin");
    await handleMessage(optIn.message);
    assert.equal(client.privacy.has(key), false);

    const firstChat = createMessage("hello after opting in");
    await handleMessage(firstChat.message);
    const freshRecord = client.points.get(key);
    assert.ok(freshRecord);
    assert.equal(freshRecord.points > 2500, true);
    assert.equal(freshRecord.lastXpAt > 0, true);
});

test("SSGSS command requires God Tier 15 after awakening God Ki", async () => {
    const key = "guild-user";
    const user = createDefaultUser("user", "guild", 0);
    user.race = "saiyan";
    user.level = 58;
    client.points.set(key, user);

    const helpers = Array.from({ length: 5 }, (_, index) => ({ id: `helper-${index}`, username: `helper-${index}` }));
    for (const helper of helpers) {
        const helperProfile = createDefaultUser(helper.id, "guild", 0);
        helperProfile.race = "saiyan";
        client.points.set(`guild-${helper.id}`, helperProfile);
    }
    await handleMessage(createMessage("!transform ssg", "user", helpers).message);
    assert.equal(user.godki, 58);
    assert.equal(user.transformationForm, "ssg");

    user.level = 71;
    await handleMessage(createMessage("!transform ssgss").message);
    assert.equal(user.transformationForm, "ssg");

    user.level = 72;
    await handleMessage(createMessage("!transform ssgss").message);
    assert.equal(user.transformationForm, "ssgss");
});

test("Beyond God awakening uses a 12-hour attempt cooldown and escalating pity chance", async () => {
    const user = createDefaultUser("user", "guild", 0);
    user.level = 50;
    client.points.set("guild-user", user);

    const originalRandom = Math.random;
    Math.random = () => 0.99;
    try {
        await handleMessage(createMessage("!transform beyondgod").message);
    } finally {
        Math.random = originalRandom;
    }
    assert.equal(user.godki, 0);
    assert.equal(user.godKiAwakeningAttempts, 1);
    assert.ok(user.lastGodKiAwakeningAttemptAt > 0);

    const cooldownAttempt = createMessage("!transform beyondgod");
    await handleMessage(cooldownAttempt.message);
    assert.match(cooldownAttempt.replied[0].payload, /available in about 12 hour/i);
    assert.equal(user.godKiAwakeningAttempts, 1);

    user.godKiAwakeningAttempts = 4;
    user.lastGodKiAwakeningAttemptAt = Date.now() - 12 * 60 * 60 * 1000;
    Math.random = () => 0.09;
    try {
        await handleMessage(createMessage("!transform beyondgod").message);
    } finally {
        Math.random = originalRandom;
    }
    assert.equal(user.godki, 50);
    assert.equal(user.godKiAwakeningAttempts, 0);
});

test("first Saiyan SSG awakening requires five other persisted Saiyan profiles", async () => {
    const saiyan = createDefaultUser("user", "guild", 0);
    saiyan.race = "saiyan";
    saiyan.level = 50;
    client.points.set("guild-user", saiyan);

    const missingHelpers = createMessage("!transform ssg");
    await handleMessage(missingHelpers.message);
    assert.equal(saiyan.godki, 0);
    assert.match(missingHelpers.replied[0].payload, /exactly five other Saiyan helpers/i);

    const helpers = Array.from({ length: 5 }, (_, index) => ({ id: `saiyan-${index}`, username: `saiyan-${index}` }));
    for (const helper of helpers) {
        const profile = createDefaultUser(helper.id, "guild", 0);
        profile.race = "saiyan";
        client.points.set(`guild-${helper.id}`, profile);
    }
    await handleMessage(createMessage("!transform ssg", "user", helpers).message);
    assert.equal(saiyan.godki, 50);
    assert.equal(saiyan.transformationForm, "ssg");
});

test("first Saiyan SSG awakening rejects non-Saiyan helpers", async () => {
    const saiyan = createDefaultUser("user", "guild", 0);
    saiyan.race = "saiyan";
    saiyan.level = 50;
    client.points.set("guild-user", saiyan);
    const helpers = Array.from({ length: 5 }, (_, index) => ({ id: `helper-${index}`, username: `helper-${index}` }));
    helpers.forEach((helper, index) => {
        const profile = createDefaultUser(helper.id, "guild", 0);
        profile.race = index === 0 ? "human" : "saiyan";
        client.points.set(`guild-${helper.id}`, profile);
    });

    const attempt = createMessage("!transform ssg", "user", helpers);
    await handleMessage(attempt.message);
    assert.equal(saiyan.godki, 0);
    assert.match(attempt.replied[0].payload, /all five helpers must be Saiyans/i);
});

test("high overall level cannot bypass the God Ki awakening requirement", async () => {
    const key = "guild-user";
    const user = createDefaultUser("user", "guild", 0);
    user.race = "saiyan";
    user.level = 100;
    client.points.set(key, user);

    const attempt = createMessage("!transform ssgss");
    await handleMessage(attempt.message);

    assert.equal(user.godki, 0);
    assert.equal(user.transformationForm, "normal");
    assert.match(attempt.sent[0].payload.embeds[0].data.fields[0].value, /Awaken God Ki/);
});

test("users can change race before the lock, and non-Saiyans can awaken universal God Ki", async () => {
    const user = createDefaultUser("user", "guild", 0);
    user.race = "saiyan";
    client.points.set("guild-user", user);

    await handleMessage(createMessage("!race human").message);
    assert.equal(user.race, "human");

    const saiyanForm = createMessage("!transform ssj");
    await handleMessage(saiyanForm.message);
    assert.match(saiyanForm.replied[0].payload, /only available to the appropriate race/i);

    user.level = 4;
    await handleMessage(createMessage("!kaioken x2").message);
    assert.equal(user.kaiokenLevel, 2);
    assert.equal(user.transformation, 2);

    user.level = 50;
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
        await handleMessage(createMessage("!transform beyondgod").message);
    } finally {
        Math.random = originalRandom;
    }
    assert.equal(user.godki, 50);
    assert.equal(user.transformationForm, "normal");

    await handleMessage(createMessage("!transform potential").message);
    assert.equal(user.transformationForm, "potential");
    assert.equal(user.transformation, 200);
});

test("race command refuses changes after base power reaches the permanent lock", async () => {
    const user = createDefaultUser("user", "guild", 0);
    user.points = 2500 + 1000000;
    client.points.set("guild-user", user);

    const attempt = createMessage("!race namekian");
    await handleMessage(attempt.message);

    assert.equal(user.race, "human");
    assert.equal(user.raceLocked, true);
    assert.match(attempt.replied[0].payload, /race is locked/i);
});

test("each race can use its own unlocked transformation path", async () => {
    const cases = [
        ["saiyan", 4, "ssj"],
        ["human", 16, "potential"],
        ["namekian", 25, "potential"],
        ["frieza", 25, "golden"]
    ];

    for (const [race, level, form] of cases) {
        const user = createDefaultUser("user", "guild", 0);
        user.race = race;
        user.level = level;
        client.points.set("guild-user", user);

        await handleMessage(createMessage(`!transform ${form}`).message);
        assert.equal(user.transformationForm, form, `${race} should be able to use ${form}`);
    }
});

test("Kaioken ability is universal and each multiplier unlocks at its configured tier", async () => {
    const cases = [
        [4, "x2", 2],
        [8, "x3", 3],
        [16, "x4", 4],
        [25, "x10", 10]
    ];

    for (const race of ["saiyan", "human", "namekian", "frieza"]) {
        for (const [level, ability, multiplier] of cases) {
            const user = createDefaultUser("user", "guild", 0);
            user.race = race;
            user.level = level;
            client.points.set("guild-user", user);

            await handleMessage(createMessage(`!kaioken ${ability}`).message);
            assert.equal(user.kaiokenLevel, multiplier, `${race} at Tier ${level} should use Kaioken ${ability}`);
            assert.equal(user.transformationForm, "normal");
        }
    }
});

test("Kaioken x10 remains locked until Tier 25", async () => {
    const user = createDefaultUser("user", "guild", 0);
    user.level = 24;
    client.points.set("guild-user", user);

    const lockedAttempt = createMessage("!kaioken x10");
    await handleMessage(lockedAttempt.message);
    assert.equal(user.transformationForm, "normal");
    assert.match(lockedAttempt.replied[0].payload, /Reach Tier 25/);

    user.level = 25;
    await handleMessage(createMessage("!kaioken x10").message);
    assert.equal(user.kaiokenLevel, 10);
});

test("Kaioken training consumes its ability stamina cost at each unlocked multiplier", async () => {
    const cases = [
        [4, "x2", 250],
        [8, "x3", 500],
        [16, "x4", 1000],
        [25, "x10", 3000]
    ];

    for (const [level, ability, staminaCost] of cases) {
        const user = createDefaultUser("user", "guild", 0);
        user.level = level;
        client.points.set("guild-user", user);

        await handleMessage(createMessage(`!kaioken ${ability}`).message);
        user.stamina = 10000;
        user.staminaUpdatedAt = Date.now();
        await handleMessage(createMessage("!train").message);
        assert.equal(user.stamina, 10000 - staminaCost, `${ability} should cost ${staminaCost} stamina to train`);
    }
});

test("Kaioken x10 drains 25 stamina per eligible message and drops to x4 when exhausted", async () => {
    const user = createDefaultUser("user", "guild", 0);
    user.race = "frieza";
    user.level = 25;
    client.points.set("guild-user", user);

    await handleMessage(createMessage("!kaioken x10").message);
    assert.equal(user.kaiokenLevel, 10);

    user.stamina = 100;
    user.staminaUpdatedAt = Date.now();
    await handleMessage(createMessage("A message while using Kaioken x10").message);
    assert.equal(user.stamina, 75);

    user.stamina = 24;
    user.staminaUpdatedAt = Date.now();
    user.lastXpAt = 0;
    await handleMessage(createMessage("Another message using Kaioken x10").message);
    assert.equal(user.stamina, 0);
    assert.equal(user.kaiokenLevel, 4);
});

test("Kaioken stacks with SSGSS and Potential Unleashed and multiplies stamina costs", async () => {
    const human = createDefaultUser("user", "guild", 0);
    human.level = 16;
    client.points.set("guild-user", human);

    await handleMessage(createMessage("!kaioken x3").message);
    await handleMessage(createMessage("!transform potential").message);
    assert.equal(human.transformationForm, "potential");
    assert.equal(human.transformation, 300);

    human.stamina = 100;
    human.staminaUpdatedAt = Date.now();
    await handleMessage(createMessage("Potential with Kaioken").message);
    assert.equal(human.stamina, 82);

    human.stamina = 10000;
    human.staminaUpdatedAt = Date.now();
    human.trainLastUsedAt = 0;
    await handleMessage(createMessage("!train").message);
    assert.equal(human.stamina, 2500);

    await handleMessage(createMessage("!kaioken off").message);
    assert.equal(human.kaiokenLevel, 0);
    assert.equal(human.transformation, 100);

    const saiyan = createDefaultUser("user", "guild", 0);
    saiyan.race = "saiyan";
    saiyan.level = 72;
    saiyan.godki = 58;
    client.points.set("guild-user", saiyan);

    await handleMessage(createMessage("!kaioken x2").message);
    await handleMessage(createMessage("!transform ssgss").message);
    assert.equal(saiyan.transformationForm, "ssgss");
    assert.equal(saiyan.kaiokenLevel, 2);
    assert.equal(saiyan.transformation, 3000000);
});

test("Kaioken cannot be activated with unstable Super Saiyan forms", async () => {
    const user = createDefaultUser("user", "guild", 0);
    user.race = "saiyan";
    user.level = 4;
    client.points.set("guild-user", user);

    await handleMessage(createMessage("!transform ssj").message);
    const abilityAttempt = createMessage("!kaioken x2");
    await handleMessage(abilityAttempt.message);
    assert.equal(user.kaiokenLevel, 0);
    assert.match(abilityAttempt.replied[0].payload, /ki is unstable/i);

    user.transformationForm = "normal";
    user.transformation = 1;
    await handleMessage(createMessage("!kaioken x2").message);
    const formAttempt = createMessage("!transform ssj2");
    user.level = 8;
    await handleMessage(formAttempt.message);
    assert.equal(user.transformationForm, "normal");
    assert.equal(user.kaiokenLevel, 2);
    assert.match(formAttempt.replied[0].payload, /disable Kaioken first/i);
});

test("leaderboard normalizes and persists legacy god-ki transformation forms", async () => {
    const legacyRecord = {
        userID: "legacy",
        guildID: "guild",
        points: 2500,
        level: 64,
        godki: 64,
        transformation: 8000000
    };
    client.points.set("guild-legacy", legacyRecord);

    const { message, sent } = createMessage("!leaderboard", "viewer");
    await handleMessage(message);

    assert.equal(legacyRecord.transformationForm, "ssgss");
    assert.equal(legacyRecord.transformation, 1000000);
    const leaderboard = sent.find((response) => response.payload.embeds)?.payload.embeds[0];
    assert.ok(leaderboard);
    assert.match(leaderboard.data.fields.map((field) => field.value).join("\n"), /Super Saiyan God Super Saiyan/);
});

test("non-owners cannot use setlevel, setpower, or reset", async () => {
    const targetUser = { id: "target", tag: "target#0001" };
    const targetKey = "guild-target";
    const originalRecord = createDefaultUser("target", "guild", 0);
    originalRecord.points = 50000;
    originalRecord.level = 3;
    client.points.set(targetKey, originalRecord);

    for (const command of ["setlevel @target 50", "setpower @target 50000", "reset @target"]) {
        const { message, replied } = createMessage(`!${command}`, "not-owner", targetUser);
        await handleMessage(message);

        assert.match(replied[0].payload, /Only the server owner/i);
        assert.equal(client.points.get(targetKey), originalRecord);
        assert.equal(originalRecord.points, 50000);
        assert.equal(originalRecord.level, 3);
    }
});

test("server owner can set level, set power, and reset an existing profile", async () => {
    const targetUser = { id: "target", tag: "target#0001" };
    const targetKey = "guild-target";
    const originalRecord = createDefaultUser("target", "guild", 0);
    originalRecord.points = 50000;
    client.points.set(targetKey, originalRecord);

    const setLevel = createMessage("!setlevel @target 10", "owner", targetUser);
    await handleMessage(setLevel.message);
    assert.equal(client.points.get(targetKey).level, 10);
    assert.match(setLevel.sent[0].payload, /set to Tier 10/);

    const setPower = createMessage("!setpower @target 10500", "owner", targetUser);
    await handleMessage(setPower.message);
    assert.equal(client.points.get(targetKey).points, 10500);
    assert.equal(client.points.get(targetKey).level, 2);
    assert.match(setPower.sent[0].payload, /base power is now 10,500/);

    const reset = createMessage("!reset @target", "owner", targetUser);
    await handleMessage(reset.message);
    const resetRecord = client.points.get(targetKey);
    assert.notEqual(resetRecord, originalRecord);
    assert.equal(resetRecord.points, 2500);
    assert.equal(resetRecord.level, 1);
    assert.equal(resetRecord.transformationForm, "normal");
    assert.match(reset.sent[0].payload, /reset to a fresh profile/);
});

test("server owner can award additive power with an optional reason", async () => {
    const targetUser = {
        id: "target",
        tag: "target#0001",
        displayAvatarURL: () => "https://example.invalid/target.png"
    };
    const targetKey = "guild-target";
    const targetRecord = createDefaultUser("target", "guild", 0);
    client.points.set(targetKey, targetRecord);

    const award = createMessage("!awardpower @target 10,000 tournament win", "owner", targetUser);
    await handleMessage(award.message);

    assert.equal(client.points.get(targetKey), targetRecord);
    assert.equal(targetRecord.points, 12500);
    assert.equal(targetRecord.level, 2);
    const confirmation = award.sent.find((response) => typeof response.payload === "string").payload;
    assert.match(confirmation, /10,000 base power awarded/);
    assert.match(confirmation, /Reason: tournament win/);
});

test("awardpower rejects invalid amounts and does not change the profile", async () => {
    const targetUser = { id: "target", tag: "target#0001" };
    const targetKey = "guild-target";
    const targetRecord = createDefaultUser("target", "guild", 0);
    client.points.set(targetKey, targetRecord);

    for (const amount of ["0", "-10", "1.5", "9007199254740992"]) {
        const { message, replied } = createMessage(`!awardpower @target ${amount}`, "owner", targetUser);
        await handleMessage(message);

        assert.match(replied[0].payload, /positive whole-number power award/i);
        assert.equal(client.points.get(targetKey), targetRecord);
        assert.equal(targetRecord.points, 2500);
    }
});

test("non-owners cannot use awardpower and opted-out members cannot receive it", async () => {
    const targetUser = { id: "target", tag: "target#0001" };
    const targetKey = "guild-target";
    const targetRecord = createDefaultUser("target", "guild", 0);
    client.points.set(targetKey, targetRecord);

    const unauthorized = createMessage("!awardpower @target 100", "not-owner", targetUser);
    await handleMessage(unauthorized.message);
    assert.match(unauthorized.replied[0].payload, /Only the server owner/i);
    assert.equal(targetRecord.points, 2500);

    client.privacy.set(targetKey, true);
    const optedOut = createMessage("!awardpower @target 100", "owner", targetUser);
    await handleMessage(optedOut.message);
    assert.match(optedOut.replied[0].payload, /opted out/i);
    assert.equal(targetRecord.points, 2500);
});

test("scan, profile, and compare do not expose opted-out members' records", async () => {
    const targetUser = {
        id: "target",
        username: "target",
        tag: "target#0001",
        displayAvatarURL: () => "https://example.invalid/target.png"
    };
    const targetKey = "guild-target";
    client.points.set(targetKey, createDefaultUser("target", "guild", 0));
    client.points.get(targetKey).points = 987654321;
    client.privacy.set(targetKey, true);

    const scan = createMessage("!scan @target", "viewer", targetUser);
    await handleMessage(scan.message);
    const scanEmbed = scan.sent[0].payload.embeds[0];
    assert.match(scanEmbed.data.description, /SCAN BLOCKED/);
    assert.doesNotMatch(JSON.stringify(scanEmbed.data), /987654321/);

    for (const command of ["profile", "compare"]) {
        const lookup = createMessage(`!${command} @target`, "viewer", targetUser);
        await handleMessage(lookup.message);
        assert.match(lookup.replied[0].payload, /opted out of progression tracking/i);
        assert.equal(lookup.sent.length, 0);
    }
});
