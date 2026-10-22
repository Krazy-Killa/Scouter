const { MessageFlags, SlashCommandBuilder } = require("discord.js");
const { ERROR_RESPONSE_COLOR, toEmbedPayload } = require("./response-embeds");

const SLASH_COMMAND_COOLDOWN_MS = 5000;
const slashCommandCooldowns = new Map();
const PRIVATE_SLASH_COMMANDS = new Set(["privacy", "revert", "transform", "kaioken"]);

const TRANSFORM_CHOICES = [
    ["normal", "Normal"],
    ["beyondgod", "Beyond God"],
    ["ssj", "Super Saiyan"],
    ["ssj2", "Super Saiyan 2"],
    ["ssj3", "Super Saiyan 3"],
    ["ssg", "Super Saiyan God"],
    ["ssgss", "Super Saiyan God Super Saiyan"],
    ["potential", "Potential Unleashed"],
    ["giant", "Giant Namekian"],
    ["final", "Final Form"],
    ["golden", "Golden Form"]
];

function createSlashCommands() {
    const commands = [
        new SlashCommandBuilder().setName("help").setDescription("Show Scouter's commands."),
        new SlashCommandBuilder().setName("scan").setDescription("Scan your power or another member.")
            .addUserOption((option) => option.setName("target").setDescription("Member to scan")),
        new SlashCommandBuilder().setName("profile").setDescription("View a progression profile.")
            .addUserOption((option) => option.setName("target").setDescription("Member whose profile to view")),
        new SlashCommandBuilder().setName("compare").setDescription("Compare progression with another member.")
            .addUserOption((option) => option.setName("target").setDescription("Member to compare with").setRequired(true)),
        new SlashCommandBuilder().setName("leaderboard").setDescription("Show this server's power rankings."),
        new SlashCommandBuilder().setName("achievements").setDescription("View your progression achievements."),
        new SlashCommandBuilder().setName("train").setDescription("Trade stamina for a training reward."),
        new SlashCommandBuilder().setName("spar").setDescription("Challenge a member to a friendly spar.")
            .addUserOption((option) => option.setName("target").setDescription("Member to challenge").setRequired(true)),
        new SlashCommandBuilder().setName("transform").setDescription("Change to an unlocked transformation.")
            .addStringOption((option) => option.setName("form").setDescription("Transformation to use").setRequired(true)
                .addChoices(...TRANSFORM_CHOICES.map(([value, name]) => ({ name, value }))))
            .addUserOption((option) => option.setName("helper1").setDescription("Tier 21+ Saiyan helper for your first SSG awakening"))
            .addUserOption((option) => option.setName("helper2").setDescription("Tier 21+ Saiyan helper for your first SSG awakening"))
            .addUserOption((option) => option.setName("helper3").setDescription("Tier 21+ Saiyan helper for your first SSG awakening"))
            .addUserOption((option) => option.setName("helper4").setDescription("Tier 21+ Saiyan helper for your first SSG awakening"))
            .addUserOption((option) => option.setName("helper5").setDescription("Tier 21+ Saiyan helper for your first SSG awakening")),
        new SlashCommandBuilder().setName("kaioken").setDescription("Activate or disable Kaioken.")
            .addStringOption((option) => option.setName("level").setDescription("Kaioken multiplier")
                .setRequired(true)
                .addChoices(
                    { name: "x2", value: "x2" },
                    { name: "x3", value: "x3" },
                    { name: "x4", value: "x4" },
                    { name: "x10", value: "x10" },
                    { name: "Off", value: "off" }
                )),
        new SlashCommandBuilder().setName("revert").setDescription("Return to your base form."),
        new SlashCommandBuilder().setName("race").setDescription("Choose your race before it locks.")
            .addStringOption((option) => option.setName("race").setDescription("Race to become").setRequired(true)
                .addChoices(
                    { name: "Saiyan", value: "saiyan" },
                    { name: "Human", value: "human" },
                    { name: "Namekian", value: "namekian" },
                    { name: "Frieza Race", value: "frieza" }
                )),
        new SlashCommandBuilder().setName("privacy").setDescription("Opt in or out of progression tracking.")
            .addStringOption((option) => option.setName("action").setDescription("Privacy action").setRequired(true)
                .addChoices(
                    { name: "Opt out and delete my record", value: "optout" },
                    { name: "Opt in again", value: "optin" }
                )),
        new SlashCommandBuilder().setName("setlevel").setDescription("Set a member's tier (server owner only).")
            .addUserOption((option) => option.setName("target").setDescription("Member to update").setRequired(true))
            .addIntegerOption((option) => option.setName("level").setDescription("New tier").setMinValue(1).setRequired(true)),
        new SlashCommandBuilder().setName("setpower").setDescription("Set a member's base power (server owner only).")
            .addUserOption((option) => option.setName("target").setDescription("Member to update").setRequired(true))
            .addStringOption((option) => option.setName("power").setDescription("New base power (2,500 or higher)").setRequired(true)),
        new SlashCommandBuilder().setName("awardpower").setDescription("Award base power to a member (server owner only).")
            .addUserOption((option) => option.setName("target").setDescription("Member to reward").setRequired(true))
            .addStringOption((option) => option.setName("amount").setDescription("Positive whole-number amount").setRequired(true))
            .addStringOption((option) => option.setName("reason").setDescription("Optional reason").setMaxLength(200)),
        new SlashCommandBuilder().setName("reset").setDescription("Reset a member's profile (server owner only).")
            .addUserOption((option) => option.setName("target").setDescription("Member to reset").setRequired(true))
    ];

    return commands.map((command) => command.setDMPermission(false));
}

function createInteractionContext(interaction) {
    const commandName = interaction.commandName;
    const options = interaction.options;
    const targetUser = options.getUser("target");
    const helperUsers = commandName === "transform"
        ? Array.from({ length: 5 }, (_, index) => options.getUser(`helper${index + 1}`)).filter(Boolean)
        : [];
    const mentionedUsers = helperUsers.length > 0 ? helperUsers : targetUser ? [targetUser] : [];
    const targetMember = targetUser
        ? options.getMember("target") || interaction.guild.members.cache.get(targetUser.id) || {
            id: targetUser.id,
            user: targetUser,
            displayName: targetUser.globalName || targetUser.username
        }
        : null;
    const commandArgs = [];

    if (commandName === "privacy") commandArgs.push(options.getString("action"));
    if (commandName === "race") commandArgs.push(options.getString("race"));
    if (commandName === "kaioken") commandArgs.push(options.getString("level"));
    if (commandName === "transform") commandArgs.push(options.getString("form"));
    if (["setlevel", "setpower", "awardpower", "reset"].includes(commandName)) {
        commandArgs.push(targetUser.id);
        if (commandName === "setlevel") commandArgs.push(String(options.getInteger("level")));
        if (commandName === "setpower") commandArgs.push(options.getString("power"));
        if (commandName === "awardpower") {
            commandArgs.push(options.getString("amount"));
            const reason = options.getString("reason");
            if (reason) commandArgs.push(reason);
        }
    }

    let firstResponse = true;
    const send = async (payload) => {
        const isFirstResponse = firstResponse;
        firstResponse = false;
        return isFirstResponse
            ? interaction.editReply(payload)
            : interaction.followUp(payload);
    };
    const reportFailure = async (error, context) => {
        try {
            const response = await interaction.editReply(toEmbedPayload(
                "Scouter could not complete that command. Please try again shortly.",
                ERROR_RESPONSE_COLOR
            ));
            firstResponse = false;
            return response;
        } catch (responseError) {
            console.error(`Failed to report /${commandName} ${context} error:`, responseError);
            return null;
        }
    };

    return {
        isSlashCommand: true,
        commandName,
        commandArgs,
        content: "",
        author: interaction.user,
        member: interaction.member?.displayName
            ? interaction.member
            : { displayName: interaction.member?.nick || interaction.user.globalName || interaction.user.username },
        guild: interaction.guild,
        channel: { send, isSlashCommandResponse: true, reportFailure },
        mentions: {
            members: { first: () => targetMember },
            users: {
                first: () => mentionedUsers[0] || null,
                values: () => mentionedUsers.values()
            }
        },
        delete: async () => {},
        reply: send
    };
}

async function handleSlashCommand(interaction, commandHandler) {
    if (!interaction.inGuild()) {
        await interaction.reply({
            ...toEmbedPayload("Scouter commands are only available in a server."),
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const now = Date.now();
    const userId = interaction.user.id;
    const lastUsedAt = slashCommandCooldowns.get(userId);
    const cooldownRemaining = lastUsedAt === undefined
        ? 0
        : SLASH_COMMAND_COOLDOWN_MS - (now - lastUsedAt);
    if (cooldownRemaining > 0) {
        const secondsRemaining = Math.ceil(cooldownRemaining / 1000);
        await interaction.reply({
            ...toEmbedPayload(`Please wait ${secondsRemaining} second(s) before using another slash command.`),
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    slashCommandCooldowns.set(userId, now);
    if (slashCommandCooldowns.size > 1000) {
        for (const [id, usedAt] of slashCommandCooldowns) {
            if (now - usedAt >= SLASH_COMMAND_COOLDOWN_MS) slashCommandCooldowns.delete(id);
        }
    }

    const replyOptions = PRIVATE_SLASH_COMMANDS.has(interaction.commandName)
        ? { flags: MessageFlags.Ephemeral }
        : undefined;
    await interaction.deferReply(replyOptions);
    await commandHandler(createInteractionContext(interaction));
}

module.exports = {
    createSlashCommands,
    handleSlashCommand,
    slashCommandCooldowns
};
