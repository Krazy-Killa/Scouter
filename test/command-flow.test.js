const test = require("node:test");
const assert = require("node:assert/strict");
const { MessageFlags } = require("discord.js");
const { client, handleButtonInteraction, handleInteraction, handleMessage, SLASH_COMMANDS } = require("../xp");
const { createDefaultUser } = require("../progression");
const { slashCommandCooldowns } = require("../commands/slash-commands");
const { SPAR_CHALLENGE_TTL_MS, expireChallenge } = require("../commands/spar");

class TestStore extends Map {
    filter(predicate) {
        return [...this.values()].filter(predicate);
    }
}

function getResponseText(response) {
    if (typeof response.payload === "string") return response.payload;
    const embed = response.payload.embeds?.[0];
    return embed?.data?.description || embed?.description || response.payload.content || "";
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
        deferReply: async (options) => {
            interaction.deferred = true;
            interaction.deferReplyOptions = options;
        },
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
    client.sparChallenges = new TestStore();
    client.user = { displayAvatarURL: () => "https://example.invalid/bot.png" };
    slashCommandCooldowns.clear();
});

test("registers the complete guild-only slash command set", () => {
    const commands = SLASH_COMMANDS.map((command) => command.toJSON());
    assert.deepEqual(commands.map((command) => command.name), [
        "help", "scan", "profile", "compare", "leaderboard", "achievements",
        "train", "spar", "transform", "kaioken", "revert", "race", "privacy",
        "setlevel", "setpower", "awardpower", "reset"
    ]);
    const transform = commands.find((command) => command.name === "transform");
    assert.deepEqual(transform.options.map((option) => option.name), [
        "form", "helper1", "helper2", "helper3", "helper4", "helper5"
    ]);
    assert.equal(commands.every((command) => command.dm_permission === false), true);
});

test("help and achievements commands are served by the extracted user-command handlers", async () => {
    client.points.set("guild-user", createDefaultUser("user", "guild", 0));
    const help = createInteraction("help");
    await handleInteraction(help.interaction);
    const helpEmbed = help.sent[0].payload.embeds[0];
    assert.equal(helpEmbed.data.title, "Command List");
    assert.ok(helpEmbed.data.fields.some((field) => field.name === "/spar target"));

    slashCommandCooldowns.clear();
    const achievements = createInteraction("achievements");
    await handleInteraction(achievements.interaction);
    const achievementEmbed = achievements.sent[0].payload.embeds[0];
    assert.ok(achievementEmbed.data.fields.length > 0);
    assert.match(achievementEmbed.data.footer.text, /of \d+ unlocked/);
});

test("slash interaction handles privacy opt-out and responds through the interaction", async () => {
    const key = "guild-user";
    client.points.set(key, createDefaultUser("user", "guild", 0));
    const fixture = createInteraction("privacy", { action: "optout" });

    await handleInteraction(fixture.interaction);

    assert.equal(client.privacy.get(key), true);
    assert.equal(client.points.has(key), false);
    assert.equal(fixture.interaction.deferred, true);
    assert.deepEqual(fixture.interaction.deferReplyOptions, { flags: MessageFlags.Ephemeral });
    assert.ok(fixture.sent[0].payload.embeds?.length);
    assert.match(getResponseText(fixture.sent[0]), /saved progression record has been deleted/i);
});

test("slash commands unavailable in DMs respond with an ephemeral embed", async () => {
    const fixture = createInteraction("help");
    fixture.interaction.inGuild = () => false;

    await handleInteraction(fixture.interaction);

    assert.ok(fixture.replied[0].payload.embeds?.length);
    assert.equal(fixture.replied[0].payload.flags, MessageFlags.Ephemeral);
    assert.match(getResponseText(fixture.replied[0]), /only available in a server/i);
});

test("slash commands have a per-user five-second cooldown with a private remaining-time notice", async () => {
    client.points.set("guild-user", createDefaultUser("user", "guild", 0));
    const originalNow = Date.now;
    let now = 10000;
    Date.now = () => now;

    try {
        const first = createInteraction("help");
        await handleInteraction(first.interaction);
        assert.equal(first.sent.length, 1);

        const blocked = createInteraction("scan");
        await handleInteraction(blocked.interaction);
        assert.equal(blocked.interaction.deferred, undefined);
        assert.equal(blocked.replied[0].payload.flags, MessageFlags.Ephemeral);
        assert.match(getResponseText(blocked.replied[0]), /wait 5 second\(s\)/i);

        now += 2500;
        const stillBlocked = createInteraction("scan");
        await handleInteraction(stillBlocked.interaction);
        assert.match(getResponseText(stillBlocked.replied[0]), /wait 3 second\(s\)/i);

        now += 2500;
        const available = createInteraction("help");
        await handleInteraction(available.interaction);
        assert.equal(available.sent.length, 1);

        const otherUser = createInteraction("help", {}, "other-user");
        await handleInteraction(otherUser.interaction);
        assert.equal(otherUser.sent.length, 1);
    } finally {
        Date.now = originalNow;
    }
});

test("slash command responses are not scheduled for deletion", async () => {
    client.points.set("guild-user", createDefaultUser("user", "guild", 0));
    const fixture = createInteraction("help");
    const originalSetTimeout = global.setTimeout;
    const scheduledTimers = [];
    global.setTimeout = (callback, delay, ...args) => {
        scheduledTimers.push({ callback, delay, args });
        return { unref() {} };
    };

    try {
        await handleInteraction(fixture.interaction);
    } finally {
        global.setTimeout = originalSetTimeout;
    }

    assert.equal(scheduledTimers.length, 0);
    assert.equal(fixture.sent.length, 1);
});

test("slash response-send failures produce the interaction error response", async () => {
    client.points.set("guild-user", createDefaultUser("user", "guild", 0));
    const fixture = createInteraction("help");
    const originalEditReply = fixture.interaction.editReply;
    const originalConsoleError = console.error;
    const loggedErrors = [];
    let firstResponse = true;
    fixture.interaction.editReply = async (payload) => {
        if (firstResponse) {
            firstResponse = false;
            throw new Error("interaction response failed");
        }
        return originalEditReply(payload);
    };

    console.error = (...args) => loggedErrors.push(args);
    try {
        await handleInteraction(fixture.interaction);
    } finally {
        console.error = originalConsoleError;
    }

    assert.match(getResponseText(fixture.sent.at(-1)), /could not complete that command/i);
    assert.ok(fixture.sent.at(-1).payload.embeds?.length);
    assert.match(loggedErrors[0]?.[0], /Failed to send help response/);
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
        profile.level = 21;
        client.points.set(`guild-${helper.id}`, profile);
    }
    const fixture = createInteraction("transform", {
        form: "ssg",
        ...Object.fromEntries(helpers.map((helper, index) => [`helper${index + 1}`, helper]))
    });

    await handleInteraction(fixture.interaction);

    assert.deepEqual(fixture.interaction.deferReplyOptions, { flags: MessageFlags.Ephemeral });
    assert.equal(saiyan.godki, 50);
    assert.equal(saiyan.transformationForm, "ssg");
});

test("slash revert and Kaioken replies are only visible to the invoking user", async () => {
    const kaiokenUser = createDefaultUser("kaioken-user", "guild", 0);
    kaiokenUser.level = 2;
    client.points.set("guild-kaioken-user", kaiokenUser);
    const kaioken = createInteraction("kaioken", { level: "x2" }, "kaioken-user");
    await handleInteraction(kaioken.interaction);

    assert.deepEqual(kaioken.interaction.deferReplyOptions, { flags: MessageFlags.Ephemeral });
    assert.equal(kaiokenUser.kaiokenLevel, 2);
    assert.ok(kaioken.sent.length > 0);

    const revertUser = createDefaultUser("revert-user", "guild", 0);
    client.points.set("guild-revert-user", revertUser);
    const revert = createInteraction("revert", {}, "revert-user");
    await handleInteraction(revert.interaction);

    assert.deepEqual(revert.interaction.deferReplyOptions, { flags: MessageFlags.Ephemeral });
    assert.ok(revert.sent.length > 0);
});

test("slash transform requires five distinct helpers for the first Saiyan SSG awakening", async () => {
    const saiyan = createDefaultUser("user", "guild", 0);
    saiyan.race = "saiyan";
    saiyan.level = 50;
    client.points.set("guild-user", saiyan);

    const helper = { id: "helper", username: "helper" };
    const helperProfile = createDefaultUser(helper.id, "guild", 0);
    helperProfile.race = "saiyan";
    helperProfile.level = 21;
    client.points.set(`guild-${helper.id}`, helperProfile);

    const fixture = createInteraction("transform", {
        form: "ssg",
        helper1: helper,
        helper2: helper,
        helper3: helper,
        helper4: helper,
        helper5: helper
    });

    await handleInteraction(fixture.interaction);

    assert.equal(saiyan.godki, 0);
    assert.notEqual(saiyan.transformationForm, "ssg");
    assert.match(getResponseText(fixture.sent[0]), /exactly five distinct other Saiyan helpers/i);
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

test("scan returns a custom reading when the bot is selected", async () => {
    client.user = {
        id: "bot",
        username: "Scouter",
        displayAvatarURL: () => "https://example.invalid/bot.png"
    };
    const bot = {
        id: client.user.id,
        username: client.user.username,
        displayAvatarURL: () => "https://example.invalid/bot.png"
    };
    const fixture = createMessage("!scan @Scouter", "viewer", bot);

    await handleMessage(fixture.message);

    const scanEmbed = fixture.sent[0].payload.embeds[0];
    assert.equal(scanEmbed.data.title, "SCOUTER // SELF-SCAN");
    assert.match(scanEmbed.data.description, /RECURSIVE SCAN DETECTED/);
    assert.equal(scanEmbed.data.fields.find((field) => field.name === "Power reading").value, "OVER 9,000!");
    assert.match(scanEmbed.data.fields.find((field) => field.name === "Result").value, /I do the scanning/);
    assert.equal(scanEmbed.data.fields.some((field) => field.value.includes("Progression tracking is enabled")), false);
});

test("scan shows the effective reading without exposing base power", async () => {
    const targetUser = {
        id: "target",
        username: "target",
        displayAvatarURL: () => "https://example.invalid/target.png"
    };
    const target = createDefaultUser("target", "guild", Date.now());
    target.points = 12500;
    client.points.set("guild-target", target);
    const fixture = createMessage("!scan @target", "viewer", targetUser);

    await handleMessage(fixture.message);

    const fields = fixture.sent[0].payload.embeds[0].data.fields;
    assert.equal(fields.find((field) => field.name === "Power reading").value, "⚡ **12.5K**");
    assert.equal(fields.some((field) => /base power/i.test(field.name)), false);
});

test("profile embed groups power, stamina, and progression into readable sections", async () => {
    const user = createDefaultUser("user", "guild", 0);
    user.points = 12500;
    user.level = 2;
    user.stamina = 7500;
    user.staminaUpdatedAt = Date.now();
    user.achievements = ["level_10"];
    client.points.set("guild-user", user);

    const fixture = createMessage("!profile");
    await handleMessage(fixture.message);

    const embed = fixture.sent[0].payload.embeds[0];
    assert.match(embed.data.description, /\*\*Tier 2\*\* · Human\nNormal/);
    assert.deepEqual(embed.data.fields.map((field) => field.name), [
        "⚡ Power · Base → Form", "💪 Stamina", "📈 Progress"
    ]);
    assert.equal(embed.data.fields[0].value, "10K → 12.5K");
    assert.match(embed.data.fields[1].value, /7,500 \/ 10,000/);
    assert.ok(embed.data.fields[1].value.includes(`🟢 ${"▰".repeat(8)}${"▱".repeat(2)}\n7,500 / 10,000`));
    assert.ok(embed.data.fields[2].value.includes(`🔴 ▰${"▱".repeat(9)}\n2K / 17K (12%)\n15K power needed`));
    assert.match(embed.data.fields[2].value, /Achievements:\*\* 1 \/ 20/);
});

test("compare embed presents both profiles in matching organized columns", async () => {
    const targetUser = {
        id: "target",
        username: "target",
        tag: "target#0001",
        displayAvatarURL: () => "https://example.invalid/target.png"
    };
    const viewer = createDefaultUser("user", "guild", Date.now());
    viewer.points = 12500;
    viewer.level = 2;
    viewer.stamina = 7500;
    viewer.staminaUpdatedAt = Date.now();
    viewer.achievements = ["level_10"];
    client.points.set("guild-user", viewer);

    const target = createDefaultUser("target", "guild", Date.now());
    target.points = 22500;
    target.level = 2;
    target.stamina = 5000;
    target.staminaUpdatedAt = Date.now();
    client.points.set("guild-target", target);

    const fixture = createMessage("!compare @target", "user", targetUser);
    await handleMessage(fixture.message);

    const embed = fixture.sent[0].payload.embeds[0];
    assert.equal(embed.data.title, "Progression Comparison");
    assert.deepEqual(embed.data.fields.map((field) => field.name), ["user", "target"]);
    assert.equal(embed.data.fields[0].inline, true);
    assert.equal(embed.data.fields[1].inline, true);
    assert.match(embed.data.fields[0].value, /\*\*Tier 2 · Human\*\*[\s\S]*\*\*⚡ Power · Base → Form\*\*[\s\S]*10K → 12\.5K[\s\S]*\*\*💪 Stamina\*\*[\s\S]*7,500 \/ 10,000[\s\S]*\*\*📈 Progress\*\*[\s\S]*2K \/ 17K \(12%\)[\s\S]*Achievements · 1 \/ 20/);
    assert.match(embed.data.fields[1].value, /\*\*Tier 2 · Human\*\*[\s\S]*20K → 22\.5K[\s\S]*\*\*💪 Stamina\*\*[\s\S]*5,000 \/ 10,000[\s\S]*12K \/ 17K \(71%\)/);
    assert.ok(embed.data.fields[0].value.includes(`🟢 ${"▰".repeat(8)}${"▱".repeat(2)}\n7,500 / 10,000`));
    assert.ok(embed.data.fields[0].value.includes(`🔴 ▰${"▱".repeat(9)}\n2K / 17K (12%)`));
    assert.ok(embed.data.fields[1].value.includes(`🟡 ${"▰".repeat(5)}${"▱".repeat(5)}\n5,000 / 10,000`));
    assert.ok(embed.data.fields[1].value.includes(`🟢 ${"▰".repeat(7)}${"▱".repeat(3)}\n12K / 17K (71%)`));
});

test("chat progression enforces cooldowns and repeated-message protection", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
        await handleMessage(createMessage("first eligible message").message);
        const user = client.points.get("guild-user");
        const firstAward = user.points;
        assert.ok(firstAward > 2500);
        assert.equal(user.lastXpContent, "first eligible message");

        await handleMessage(createMessage("different message during cooldown").message);
        assert.equal(user.points, firstAward);

        user.lastXpAt = Date.now() - 60 * 1000;
        await handleMessage(createMessage(" FIRST   eligible message ").message);
        assert.equal(user.points, firstAward);

        await handleMessage(createMessage("different message after cooldown").message);
        assert.ok(user.points > firstAward);
        assert.equal(user.lastXpContent, "different message after cooldown");
    } finally {
        Math.random = originalRandom;
    }
});

test("message progression ignores bots, DMs, legacy commands, and messages below the size threshold", async () => {
    const botMessage = createMessage("A bot message");
    botMessage.message.author.bot = true;
    await handleMessage(botMessage.message);
    assert.equal(client.points.has("guild-user"), false);

    const directMessage = createMessage("A direct message");
    directMessage.message.guild = null;
    await handleMessage(directMessage.message);
    assert.equal(client.points.has("guild-user"), false);

    const legacyCommand = createMessage("!train");
    legacyCommand.message.isSlashCommand = false;
    await handleMessage(legacyCommand.message);
    assert.equal(client.points.has("guild-user"), false);

    await handleMessage(createMessage("x").message);
    const user = client.points.get("guild-user");
    assert.ok(user);
    assert.equal(user.points, 2500);
    assert.equal(user.lastXpAt, 0);
});

test("profile requests recover stamina only in base form and persist the recovery timestamp", async () => {
    const baseFormUser = createDefaultUser("user", "guild", 0);
    baseFormUser.stamina = 4000;
    baseFormUser.staminaUpdatedAt = Date.now() - 24 * 60 * 60 * 1000;
    client.points.set("guild-user", baseFormUser);

    await handleMessage(createMessage("!profile").message);
    assert.ok(Math.abs(baseFormUser.stamina - 6000) < 1);
    assert.ok(baseFormUser.staminaUpdatedAt >= Date.now() - 1000);

    const transformedUser = createDefaultUser("user", "guild", 0);
    transformedUser.transformationForm = "potential";
    transformedUser.transformation = 100;
    transformedUser.stamina = 4000;
    transformedUser.staminaUpdatedAt = Date.now() - 24 * 60 * 60 * 1000;
    client.points.set("guild-user", transformedUser);

    await handleMessage(createMessage("!profile").message);
    assert.equal(transformedUser.stamina, 4000);
    assert.ok(transformedUser.staminaUpdatedAt >= Date.now() - 1000);
});

test("scan reports a temporary lookup failure when Discord cannot fetch a member", async () => {
    const fixture = createMessage("!scan 12345678901234567");
    fixture.message.guild.members.fetch = async () => {
        const error = new Error("Discord API unavailable");
        error.code = 50013;
        throw error;
    };
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
        await handleMessage(fixture.message);
    } finally {
        console.error = originalConsoleError;
    }

    assert.match(getResponseText(fixture.replied[0]), /could not complete the scan/i);
    assert.equal(fixture.sent.length, 0);
});

test("privacy opt-out blocks progression and opt-in starts a fresh record", async () => {
    const key = "guild-user";
    client.points.set(key, createDefaultUser("user", "guild", 0));

    const optOut = createMessage("!privacy optout");
    await handleMessage(optOut.message);
    assert.equal(client.privacy.get(key), true);
    assert.equal(client.points.has(key), false);
    assert.match(getResponseText(optOut.sent[0]), /saved progression record has been deleted/i);
    assert.ok(optOut.sent[0].payload.embeds?.length);

    const blockedCommand = createMessage("!profile");
    await handleMessage(blockedCommand.message);
    assert.match(getResponseText(blockedCommand.replied[0]), /tracking is off/i);
    assert.ok(blockedCommand.replied[0].payload.embeds?.length);
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
        helperProfile.level = 21;
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
    assert.match(getResponseText(cooldownAttempt.replied[0]), /available in about 12 hour/i);
    assert.equal(user.godKiAwakeningAttempts, 1);

    user.lastGodKiAwakeningAttemptAt = Date.now() - (12 * 60 * 60 * 1000 - 45 * 60 * 1000);
    const minutesRemainingAttempt = createMessage("!transform beyondgod");
    await handleMessage(minutesRemainingAttempt.message);
    assert.match(getResponseText(minutesRemainingAttempt.replied[0]), /available in about 45 minute/i);

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

test("Beyond God awakening persists every pity step through the guaranteed attempt", async () => {
    const user = createDefaultUser("user", "guild", 0);
    user.level = 50;
    client.points.set("guild-user", user);
    const originalNow = Date.now;
    const originalRandom = Math.random;
    let now = 13 * 60 * 60 * 1000;
    const totalAttemptsUntilGuaranteed = 9;
    Date.now = () => now;
    Math.random = () => 0.99;

    try {
        for (let index = 0; index < totalAttemptsUntilGuaranteed; index += 1) {
            const attempt = createMessage("!transform beyondgod");
            await handleMessage(attempt.message);

            const isGuaranteedAttempt = index === totalAttemptsUntilGuaranteed - 1;
            assert.equal(client.points.get("guild-user").godki, isGuaranteedAttempt ? 50 : 0);
            assert.equal(
                client.points.get("guild-user").godKiAwakeningAttempts,
                isGuaranteedAttempt ? 0 : index + 1
            );
            if (!isGuaranteedAttempt) {
                const responseText = getResponseText(attempt.sent[0]);
                assert.match(responseText, /attempt to awaken God Ki failed/i);
                assert.match(responseText, /try again in 12 hours/i);
                assert.doesNotMatch(responseText, /chance|%/i);
                now += 12 * 60 * 60 * 1000;
            }
        }
    } finally {
        Date.now = originalNow;
        Math.random = originalRandom;
    }
});

test("first Saiyan SSG awakening requires five other persisted Saiyan profiles", async () => {
    const saiyan = createDefaultUser("user", "guild", 0);
    saiyan.race = "saiyan";
    saiyan.level = 50;
    client.points.set("guild-user", saiyan);

    const missingHelpers = createMessage("!transform ssg");
    await handleMessage(missingHelpers.message);
    assert.equal(saiyan.godki, 0);
    assert.match(getResponseText(missingHelpers.replied[0]), /exactly five distinct other Saiyan helpers/i);

    const helpers = Array.from({ length: 5 }, (_, index) => ({ id: `saiyan-${index}`, username: `saiyan-${index}` }));
    for (const helper of helpers) {
        const profile = createDefaultUser(helper.id, "guild", 0);
        profile.race = "saiyan";
        profile.level = 21;
        client.points.set(`guild-${helper.id}`, profile);
    }
    await handleMessage(createMessage("!transform ssg", "user", helpers).message);
    assert.equal(saiyan.godki, 50);
    assert.equal(saiyan.transformationForm, "ssg");
});

test("first Saiyan SSG awakening initializes and persists legacy helper profiles", async () => {
    const saiyan = createDefaultUser("user", "guild", 0);
    saiyan.race = "saiyan";
    saiyan.level = 50;
    client.points.set("guild-user", saiyan);
    const helpers = Array.from({ length: 5 }, (_, index) => ({ id: `legacy-${index}`, username: `legacy-${index}` }));
    for (const helper of helpers) {
        const profile = createDefaultUser(helper.id, "guild", 0);
        delete profile.race;
        profile.level = 21;
        delete profile.godKiAwakeningAttempts;
        delete profile.lastGodKiAwakeningAttemptAt;
        client.points.set(`guild-${helper.id}`, profile);
    }

    await handleMessage(createMessage("!transform ssg", "user", helpers).message);

    for (const helper of helpers) {
        const persistedProfile = client.points.get(`guild-${helper.id}`);
        assert.equal(persistedProfile.race, "saiyan");
        assert.equal(persistedProfile.godKiAwakeningAttempts, 0);
        assert.equal(persistedProfile.lastGodKiAwakeningAttemptAt, 0);
    }
    assert.equal(saiyan.godki, 50);
    assert.equal(saiyan.transformationForm, "ssg");
});

test("first Saiyan SSG awakening does not create missing helper profiles", async () => {
    const saiyan = createDefaultUser("user", "guild", 0);
    saiyan.race = "saiyan";
    saiyan.level = 50;
    client.points.set("guild-user", saiyan);
    const helpers = Array.from({ length: 5 }, (_, index) => ({ id: `missing-${index}`, username: `missing-${index}` }));

    const attempt = createMessage("!transform ssg", "user", helpers);
    await handleMessage(attempt.message);

    assert.equal(saiyan.godki, 0);
    assert.equal(saiyan.transformationForm, "normal");
    assert.equal(helpers.every((helper) => !client.points.has(`guild-${helper.id}`)), true);
    assert.match(getResponseText(attempt.replied[0]), /existing Saiyan progression profile/i);
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
        profile.level = 21;
        client.points.set(`guild-${helper.id}`, profile);
    });

    const attempt = createMessage("!transform ssg", "user", helpers);
    await handleMessage(attempt.message);
    assert.equal(saiyan.godki, 0);
    assert.match(getResponseText(attempt.replied[0]), /all five helpers must be Saiyans/i);
});

test("first Saiyan SSG awakening requires each helper to be at least Tier 21", async () => {
    const saiyan = createDefaultUser("user", "guild", 0);
    saiyan.race = "saiyan";
    saiyan.level = 50;
    client.points.set("guild-user", saiyan);
    const helpers = Array.from({ length: 5 }, (_, index) => ({ id: `tier-${index}`, username: `tier-${index}` }));
    helpers.forEach((helper, index) => {
        const profile = createDefaultUser(helper.id, "guild", 0);
        profile.race = "saiyan";
        profile.level = index === 4 ? 20 : 21;
        client.points.set(`guild-${helper.id}`, profile);
    });

    const attempt = createMessage("!transform ssg", "user", helpers);
    await handleMessage(attempt.message);

    assert.equal(saiyan.godki, 0);
    assert.equal(saiyan.transformationForm, "normal");
    assert.match(getResponseText(attempt.replied[0]), /all five Saiyan helpers must be at least Tier 21/i);
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
    assert.match(getResponseText(saiyanForm.replied[0]), /only available to the appropriate race/i);

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
    assert.match(getResponseText(attempt.replied[0]), /race is locked/i);
});

test("each race can use its own unlocked transformation path", async () => {
    const cases = [
        ["saiyan", 21, "ssj"],
        ["human", 21, "potential"],
        ["namekian", 21, "giant"],
        ["namekian", 25, "potential"],
        ["frieza", 21, "final"],
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

test("non-Saiyan transformations unlock on the matching Saiyan tier steps", async () => {
    const cases = [
        ["human", 20, "potential", 21],
        ["namekian", 20, "giant", 21],
        ["namekian", 24, "potential", 25],
        ["frieza", 20, "final", 21],
        ["frieza", 24, "golden", 25]
    ];

    for (const [race, level, form, unlockTier] of cases) {
        const user = createDefaultUser("user", "guild", 0);
        user.race = race;
        user.level = level;
        client.points.set("guild-user", user);

        const lockedAttempt = createMessage(`!transform ${form}`);
        await handleMessage(lockedAttempt.message);
        assert.match(lockedAttempt.sent[0].payload.embeds[0].data.fields[0].value, new RegExp(`Reach Tier ${unlockTier}`));
        assert.equal(user.transformationForm, "normal");
    }
});

test("Saiyan forms unlock after the full Kaioken progression", async () => {
    const cases = [
        [21, "ssj"],
        [25, "ssj2"],
        [33, "ssj3"]
    ];

    for (const [tier, form] of cases) {
        const user = createDefaultUser("user", "guild", 0);
        user.race = "saiyan";
        user.level = tier - 1;
        client.points.set("guild-user", user);

        const lockedAttempt = createMessage(`!transform ${form}`);
        await handleMessage(lockedAttempt.message);
        assert.match(lockedAttempt.sent[0].payload.embeds[0].data.fields[0].value, new RegExp(`Reach Tier ${tier}`));
        assert.equal(user.transformationForm, "normal");

        user.level = tier;
        await handleMessage(createMessage(`!transform ${form}`).message);
        assert.equal(user.transformationForm, form);
    }
});

test("Kaioken ability is universal and each multiplier unlocks at its configured tier", async () => {
    const cases = [
        [2, "x2", 2],
        [6, "x3", 3],
        [12, "x4", 4],
        [20, "x10", 10]
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

test("Kaioken x10 remains locked until Tier 20", async () => {
    const user = createDefaultUser("user", "guild", 0);
    user.level = 19;
    client.points.set("guild-user", user);

    const lockedAttempt = createMessage("!kaioken x10");
    await handleMessage(lockedAttempt.message);
    assert.equal(user.transformationForm, "normal");
    assert.match(getResponseText(lockedAttempt.replied[0]), /Reach Tier 20/);

    user.level = 20;
    await handleMessage(createMessage("!kaioken x10").message);
    assert.equal(user.kaiokenLevel, 10);
});

test("Kaioken training consumes its ability stamina cost at each unlocked multiplier", async () => {
    const cases = [
        [2, "x2", 250],
        [6, "x3", 500],
        [12, "x4", 1000],
        [20, "x10", 3000]
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

test("training cooldown reports minutes when less than an hour remains", async () => {
    const user = createDefaultUser("user", "guild", Date.now());
    user.trainLastUsedAt = Date.now() - (24 * 60 * 60 * 1000 - 35 * 60 * 1000);
    client.points.set("guild-user", user);

    const attempt = createMessage("!train");
    await handleMessage(attempt.message);

    assert.match(getResponseText(attempt.replied[0]), /exhausted from training\. Try again in about 35 minute/i);
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
    human.level = 21;
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
    user.level = 21;
    client.points.set("guild-user", user);

    await handleMessage(createMessage("!transform ssj").message);
    const abilityAttempt = createMessage("!kaioken x2");
    await handleMessage(abilityAttempt.message);
    assert.equal(user.kaiokenLevel, 0);
    assert.match(getResponseText(abilityAttempt.replied[0]), /ki is unstable/i);

    user.transformationForm = "normal";
    user.transformation = 1;
    await handleMessage(createMessage("!kaioken x2").message);
    const formAttempt = createMessage("!transform ssj2");
    user.level = 25;
    await handleMessage(formAttempt.message);
    assert.equal(user.transformationForm, "normal");
    assert.equal(user.kaiokenLevel, 2);
    assert.match(getResponseText(formAttempt.replied[0]), /disable Kaioken first/i);
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

        assert.match(getResponseText(replied[0]), /Only the server owner/i);
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
    assert.match(getResponseText(setLevel.sent[0]), /set to Tier 10/);

    const setPower = createMessage("!setpower @target 10500", "owner", targetUser);
    await handleMessage(setPower.message);
    assert.equal(client.points.get(targetKey).points, 10500);
    assert.equal(client.points.get(targetKey).level, 2);
    assert.match(getResponseText(setPower.sent[0]), /base power is now 10\.5K/);

    const reset = createMessage("!reset @target", "owner", targetUser);
    await handleMessage(reset.message);
    const resetRecord = client.points.get(targetKey);
    assert.notEqual(resetRecord, originalRecord);
    assert.equal(resetRecord.points, 2500);
    assert.equal(resetRecord.level, 1);
    assert.equal(resetRecord.transformationForm, "normal");
    assert.match(getResponseText(reset.sent[0]), /reset to a fresh profile/);
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
    const confirmation = getResponseText(award.sent.find((response) => getResponseText(response)));
    assert.match(confirmation, /10K base power awarded/);
    assert.match(confirmation, /base power is now 10K/);
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

        assert.match(getResponseText(replied[0]), /positive whole-number power award/i);
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
    assert.match(getResponseText(unauthorized.replied[0]), /Only the server owner/i);
    assert.equal(targetRecord.points, 2500);

    client.privacy.set(targetKey, true);
    const optedOut = createMessage("!awardpower @target 100", "owner", targetUser);
    await handleMessage(optedOut.message);
    assert.match(getResponseText(optedOut.replied[0]), /opted out/i);
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
        assert.match(getResponseText(lookup.replied[0]), /opted out of progression tracking/i);
        assert.equal(lookup.sent.length, 0);
    }
});

const sparUser = (id) => ({
    id,
    username: id,
    bot: false,
    displayAvatarURL: () => "https://example.invalid/avatar.png"
});

function createButton(action, challengeId, userId, guildId = "guild") {
    const responses = { updates: [], replies: [] };
    return {
        interaction: {
            customId: `spar:${action}:${challengeId}`,
            user: { id: userId },
            guildId,
            update: async (payload) => responses.updates.push(payload),
            reply: async (payload) => responses.replies.push(payload)
        },
        ...responses
    };
}

async function startSpar(challengerId = "challenger", opponentId = "opponent") {
    client.points.set(`guild-${challengerId}`, createDefaultUser(challengerId, "guild", 0));
    client.points.set(`guild-${opponentId}`, createDefaultUser(opponentId, "guild", 0));
    const fixture = createInteraction("spar", { target: sparUser(opponentId) }, challengerId);
    slashCommandCooldowns.clear();
    await handleInteraction(fixture.interaction);
    return fixture;
}

test("spar posts a consent challenge that only pings the opponent and is persisted", async () => {
    const fixture = await startSpar();

    const payload = fixture.sent[0].payload;
    assert.equal(fixture.interaction.deferReplyOptions, undefined);
    assert.deepEqual(payload.allowedMentions, { users: ["opponent"] });
    assert.match(payload.embeds[0].data.description, /<@challenger> challenges <@opponent>/);
    const buttons = payload.components[0].components.map((button) => button.data);
    assert.deepEqual(buttons.map((button) => button.label), ["Accept", "Decline", "Cancel challenge"]);
    assert.equal(buttons.every((button) => !button.disabled), true);

    const [challenge] = client.sparChallenges.filter(() => true);
    assert.equal(challenge.challengerID, "challenger");
    assert.equal(challenge.opponentID, "opponent");
    assert.equal(challenge.expiresAt - challenge.createdAt, SPAR_CHALLENGE_TTL_MS);
    assert.equal(buttons[0].custom_id, `spar:accept:${challenge.id}`);
});

test("spar rejects invalid, unavailable, and already-pending targets without creating a challenge", async () => {
    client.points.set("guild-challenger", createDefaultUser("challenger", "guild", 0));
    client.points.set("guild-opponent", createDefaultUser("opponent", "guild", 0));
    client.points.set("guild-busy", createDefaultUser("busy", "guild", 0));
    client.privacy.set("guild-private", true);
    client.points.set("guild-private", createDefaultUser("private", "guild", 0));

    const attempt = async (target, userId = "challenger") => {
        slashCommandCooldowns.clear();
        const fixture = createInteraction("spar", { target }, userId);
        await handleInteraction(fixture.interaction);
        return getResponseText(fixture.sent[0]);
    };

    assert.match(await attempt(sparUser("challenger")), /can't spar with yourself/i);
    assert.match(await attempt({ ...sparUser("bot"), bot: true }), /bots can't be challenged/i);
    assert.match(await attempt(sparUser("nobody")), /can't be challenged to a spar right now/i);
    assert.match(await attempt(sparUser("private")), /can't be challenged to a spar right now/i);
    assert.equal(client.sparChallenges.size, 0);

    await attempt(sparUser("opponent"));
    assert.equal(client.sparChallenges.size, 1);
    assert.match(await attempt(sparUser("busy")), /already have a pending/i);
    assert.match(await attempt(sparUser("challenger"), "busy"), /already has a pending/i);
    assert.equal(client.sparChallenges.size, 1);
});

test("only the opponent can accept a spar and it resolves exactly once", async () => {
    await startSpar();
    const [challenge] = client.sparChallenges.filter(() => true);

    const intruder = createButton("accept", challenge.id, "stranger");
    await handleButtonInteraction(intruder.interaction);
    assert.equal(intruder.updates.length, 0);
    assert.equal(intruder.replies[0].flags, MessageFlags.Ephemeral);
    assert.equal(client.sparChallenges.size, 1);

    const accept = createButton("accept", challenge.id, "opponent");
    await handleButtonInteraction(accept.interaction);
    const update = accept.updates[0];
    assert.match(update.embeds[0].data.description, /accepted/i);
    assert.equal(update.components[0].components.every((button) => button.data.disabled), true);
    assert.deepEqual(update.allowedMentions, { users: [] });
    assert.equal(client.sparChallenges.size, 0);

    const repeat = createButton("accept", challenge.id, "opponent");
    await handleButtonInteraction(repeat.interaction);
    assert.equal(repeat.updates.length, 0);
    assert.match(getResponseText({ payload: repeat.replies[0] }), /no longer active/i);
});

test("the opponent can decline and only the challenger can cancel a spar", async () => {
    await startSpar();
    const [challenge] = client.sparChallenges.filter(() => true);

    const wrongCancel = createButton("cancel", challenge.id, "opponent");
    await handleButtonInteraction(wrongCancel.interaction);
    assert.equal(wrongCancel.updates.length, 0);
    assert.equal(client.sparChallenges.size, 1);

    const cancel = createButton("cancel", challenge.id, "challenger");
    await handleButtonInteraction(cancel.interaction);
    assert.match(cancel.updates[0].embeds[0].data.description, /cancelled/i);
    assert.equal(client.sparChallenges.size, 0);

    await startSpar();
    const [second] = client.sparChallenges.filter(() => true);
    const decline = createButton("decline", second.id, "opponent");
    await handleButtonInteraction(decline.interaction);
    assert.match(decline.updates[0].embeds[0].data.description, /declined/i);
    assert.equal(client.sparChallenges.size, 0);
});

test("accepting a spar after a fighter opts out closes it as unavailable", async () => {
    await startSpar();
    const [challenge] = client.sparChallenges.filter(() => true);
    client.privacy.set("guild-challenger", true);

    const accept = createButton("accept", challenge.id, "opponent");
    await handleButtonInteraction(accept.interaction);

    assert.match(accept.updates[0].embeds[0].data.description, /no longer available/i);
    assert.equal(client.sparChallenges.size, 0);
});

test("expired spar challenges decline on click and are closed by the expiry handler", async () => {
    await startSpar();
    const [challenge] = client.sparChallenges.filter(() => true);
    challenge.expiresAt = Date.now() - 1;

    const late = createButton("accept", challenge.id, "opponent");
    await handleButtonInteraction(late.interaction);
    assert.match(late.updates[0].embeds[0].data.description, /did not respond in time/i);
    assert.equal(client.sparChallenges.size, 0);

    const edits = [];
    const tracked = { ...challenge, id: "tracked", channelID: "channel", messageID: "message" };
    client.sparChallenges.set(tracked.id, tracked);
    client.channels = {
        fetch: async () => ({ messages: { fetch: async () => ({ edit: async (payload) => edits.push(payload) }) } })
    };
    await expireChallenge(client, tracked.id);
    assert.equal(client.sparChallenges.size, 0);
    assert.match(edits[0].embeds[0].data.description, /did not respond in time/i);
});
