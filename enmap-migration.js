const ENMAP_TABLES = ["points", "privacy"];

function isEnmapV6Value(value) {
    if (!value || typeof value !== "object" || !Number.isInteger(value.t) || value.t < 0 || value.t > 11) {
        return false;
    }
    return value.t === 5 || value.t === 7
        ? !Object.prototype.hasOwnProperty.call(value, "v")
        : Object.prototype.hasOwnProperty.call(value, "v");
}

function migrateLegacyEnmapData(database, stringify) {
    const migrate = database.transaction(() => {
        const tableExists = database.prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
        );
        for (const table of ENMAP_TABLES) {
            if (!tableExists.get(table)) continue;

            const rows = database.prepare(`SELECT key, value FROM "${table}"`).all();
            const update = database.prepare(`UPDATE "${table}" SET value = ? WHERE key = ?`);
            for (let index = 0; index < rows.length; index += 1) {
                const row = rows[index];
                let value;
                try {
                    value = JSON.parse(row.value);
                } catch (error) {
                    throw new Error(
                        `Cannot migrate Enmap table "${table}" record ${index + 1}: stored value is not valid JSON.`,
                        { cause: error }
                    );
                }
                if (!isEnmapV6Value(value)) {
                    update.run(stringify(value), row.key);
                }
            }
        }
    });
    migrate();
}

module.exports = { migrateLegacyEnmapData };
