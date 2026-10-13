const { EmbedBuilder } = require("discord.js");

const DEFAULT_RESPONSE_COLOR = "#008B8B";
const ERROR_RESPONSE_COLOR = "#FF0000";

function toEmbedPayload(payload, color = DEFAULT_RESPONSE_COLOR) {
    if (typeof payload !== "string") return payload;

    return {
        embeds: [
            new EmbedBuilder()
                .setColor(color)
                .setDescription(payload)
        ]
    };
}

module.exports = {
    DEFAULT_RESPONSE_COLOR,
    ERROR_RESPONSE_COLOR,
    toEmbedPayload
};
