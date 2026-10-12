const test = require("node:test");
const assert = require("node:assert/strict");
const { client, handleMessage } = require("../xp");
const { createDefaultUser } = require("../progression");

class TestStore extends Map {
    filter(predicate) {
        return [...this.values()].filter(predicate);
    }
}

function createMessage(content, userId = "user", targetUser = null) {
    const sent = [];
    const replied = [];
    const targetMember = targetUser
        ? { id: targetUser.id, user: targetUser, displayName: targetUser.username || targetUser.id }
        : null;
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
        author,
        member: { displayName: userId },
        guild: {
            id: "guild",
            name: "Test Guild",
            ownerId: "owner",
            members: { cache: new Map(targetMember ? [[targetMember.id, targetMember]] : []) }
        },
        channel,
        mentions: {
            members: { first: () => targetMember },
            users: { first: () => targetUser }
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

test.beforeEach(() => {
    client.points = new TestStore();
    client.privacy = new TestStore();
    client.user = { displayAvatarURL: () => "https://example.invalid/bot.png" };
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
    user.level = 58;
    client.points.set(key, user);

    await handleMessage(createMessage("!transform ssg").message);
    assert.equal(user.godki, 58);
    assert.equal(user.transformationForm, "ssg");

    user.level = 71;
    await handleMessage(createMessage("!transform ssgss").message);
    assert.equal(user.transformationForm, "ssg");

    user.level = 72;
    await handleMessage(createMessage("!transform ssgss").message);
    assert.equal(user.transformationForm, "ssgss");
});

test("high overall level cannot bypass the God Ki awakening requirement", async () => {
    const key = "guild-user";
    const user = createDefaultUser("user", "guild", 0);
    user.level = 100;
    client.points.set(key, user);

    const attempt = createMessage("!transform ssgss");
    await handleMessage(attempt.message);

    assert.equal(user.godki, 0);
    assert.equal(user.transformationForm, "normal");
    assert.match(attempt.sent[0].payload.embeds[0].data.fields[0].value, /Awaken God Ki with Super Saiyan God/);
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
