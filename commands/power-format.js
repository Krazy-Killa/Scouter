const suffixes = ["", "K", "M", "B", "T", "Q"];

function formatPowerAmount(power) {
    if (!Number.isFinite(power)) {
        throw new RangeError("Power must be a finite number.");
    }

    const absolutePower = Math.abs(power);
    if (absolutePower < 1000) {
        return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(power);
    }

    let suffixIndex = Math.min(Math.floor(Math.log10(absolutePower) / 3), suffixes.length - 1);
    let roundedPower = Math.round((absolutePower / (1000 ** suffixIndex)) * 10) / 10;
    if (roundedPower >= 1000 && suffixIndex < suffixes.length - 1) {
        suffixIndex += 1;
        roundedPower /= 1000;
    }

    const formattedPower = new Intl.NumberFormat("en-US", {
        maximumFractionDigits: 1,
        minimumFractionDigits: 0
    }).format(roundedPower);
    return `${power < 0 ? "-" : ""}${formattedPower}${suffixes[suffixIndex]}`;
}

module.exports = { formatPowerAmount };
