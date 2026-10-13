const test = require("node:test");
const assert = require("node:assert/strict");
const { formatPowerAmount } = require("../commands/power-format");

test("formats power with uppercase K, M, and B suffixes", () => {
    assert.equal(formatPowerAmount(1000), "1K");
    assert.equal(formatPowerAmount(257102), "257.1K");
    assert.equal(formatPowerAmount(1500000), "1.5M");
    assert.equal(formatPowerAmount(1000000000), "1B");
});

test("rounds abbreviated power without leaving it at the previous magnitude", () => {
    assert.equal(formatPowerAmount(999999), "1M");
    assert.equal(formatPowerAmount(999999999), "1B");
});

test("keeps sub-thousand power values unabridged", () => {
    assert.equal(formatPowerAmount(999), "999");
    assert.equal(formatPowerAmount(0), "0");
});
