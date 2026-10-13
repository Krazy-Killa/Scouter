# Scouter
An RPG-style Discord progression bot where members earn power through chat and training, unlock race-specific forms and universal God Ki, and compete on server leaderboards.

See the [current feature guide](docs/features.md) for an overview of what the bot can do, and the [project roadmap](docs/roadmap.md) for possible next steps.

## Setup

### Install Node.js and npm

If you do not already have Node.js and npm installed:

1. Install Node.js 20 or newer from the [official Node.js download page](https://nodejs.org/en/download) for your operating system. npm 10 or newer is required and is included with current Node.js releases; you do not need to install it separately.
2. Run the installer and keep the option to add Node.js to your PATH enabled, if shown.
3. Close and reopen your terminal, then check that both tools are available:

   ```sh
   node --version
   npm --version
   ```

   If either command is not recognized, restart your computer or reinstall Node.js and make sure it is added to your PATH.

### Install and run Scouter

From a terminal opened in the Scouter project folder:

1. Install the locked project dependencies: `npm ci`
2. Copy `.env.example` to `.env` and set your actual Discord token.
3. Start the bot: `npm start`

Before the first start after upgrading to Enmap 6, stop the bot and back up the entire `data` folder. Scouter migrates the existing Enmap values to the new serialization format at startup; the migration runs in a SQLite transaction.

Do not commit your real token. Keep `.env` and any local `config.json` out of Git; both are ignored in this repo.

### Discord permissions and intent

When inviting the bot, include the `bot` and `applications.commands` OAuth2 scopes so Discord can install its slash commands.

Grant the bot these channel permissions:

**Required for normal bot operation**

- **View Channel**
- **Send Messages**
- **Embed Links** — commands and progression notices use embeds.

**Required for reaction-based leaderboard pagination**

- **Add Reactions**
- **Read Message History**
- **Manage Messages** — used to remove the requesting user's reaction after a page change.

The bot also needs the **Message Content Intent** enabled under **Developer Portal → Bot → Privileged Gateway Intents** to award progression for chat messages. Scouter registers its global application commands when it starts; after the first registration, Discord may take some time to show them everywhere.

## Commands

Use Discord's `/` command picker. Scouter no longer handles prefix commands.
Most command responses remain visible in the channel; `/privacy` replies are
private to the invoking member. Slash-command invocations themselves do not
create command messages, and bot responses are not automatically deleted.

| Command | Options | Description |
|---|---|---|
| `/help` | — | Lists the bot's commands. |
| `/scan` | Optional `target` | Displays a scouter-style power reading for you or another server member. Users who opted out of tracking cannot be scanned. |
| `/profile` | Optional `target` | Shows base and displayed power, tier, form, stamina, progress to the next tier, achievements, and power earned per eligible message; can also show another member's profile. |
| `/compare` | Required `target` | Compares base and displayed power, tier, form, stamina, progress, and achievements with another server member. |
| `/leaderboard` | — | Shows all-time server rankings, 10 users per page, ordered by displayed power. Use the left and right reactions to change pages. |
| `/achievements` | — | Lists unlocked and locked achievements. |
| `/train` | — | Trades stamina for a one-time power reward. It can be used once every 24 hours. |
| `/transform` | Required `form`; optional `helper1`–`helper5` | Changes to an unlocked racial or universal transformation. Select five other Saiyan helpers for a first-time SSG awakening. |
| `/kaioken` | Required `level` | Activates x2/x3/x4/x10 or disables the universal Kaioken ability. |
| `/revert` | — | Automatically returns you to your normal form (Beyond God if you have God Ki). |
| `/race` | Required `race` | Changes your race while your base power is below 1,000,000. Race changes permanently lock at that threshold. |
| `/privacy` | Required `action` | Opts out of progression tracking in this server and deletes your saved record, or opts back in to start a new record. |
| `/setlevel` | Required `target`, `level` | Sets a user's tier without changing accumulated power. Server owner only. |
| `/setpower` | Required `target`, `power` | Sets a user's base power and recalculates their tier. Requires a whole number of at least 2,500. Server owner only. |
| `/awardpower` | Required `target`, `amount`; optional `reason` | Adds a positive whole-number amount to a member's base power, recalculates their tier, and checks progression achievements. Server owner only. |
| `/reset` | Required `target` | Resets an existing profile to its fresh starting state. Server owner only. |

`setlevel` changes only the tier, `setpower` replaces base power and recalculates the tier, and `awardpower` adds to base power. Administrative commands cannot modify a member who opted out of progression tracking. Command invocations are native Discord interactions; bot responses remain visible in the channel as before.

For leaderboards with multiple pages, use the left and right reactions beneath the leaderboard to navigate. The controls are available to the person who ran the command for two minutes.

### Races and transformations

New profiles start as Human. Existing profiles that predate race tracking and have no saved race remain Saiyan for compatibility. Use `/race` to change race before reaching 1,000,000 base power. At or above that amount, race locks permanently. Changing race resets the active race-specific form to Normal, but keeps power and universal God Ki.

Only one transformation can be active at a time. Base multipliers shown here apply before God Ki scaling.

#### Human

| Transformation | Unlock requirement | Base multiplier |
|---|---:|---:|
| Potential Unleashed | Tier 16 | 100× |

#### Saiyan

| Transformation | Unlock requirement | Base multiplier |
|---|---:|---:|
| Super Saiyan | Tier 21 | 50× |
| Super Saiyan 2 | Tier 25 | 100× |
| Super Saiyan 3 | Tier 33 | 400× |
| Super Saiyan God | Tier 50 | 20,000×–30,000× |
| Super Saiyan God Super Saiyan | God Tier 15 | 50× Super Saiyan God |

To awaken God Ki through your first Super Saiyan God transformation, choose five other players with existing Saiyan profiles in the `helper1` through `helper5` options of `/transform`.

#### Namekian

| Transformation | Unlock requirement | Base multiplier |
|---|---:|---:|
| Giant Namekian | Tier 8 | 50× |
| Potential Unleashed | Tier 25 | 250× |

#### Frieza Race

| Transformation | Unlock requirement | Base multiplier |
|---|---:|---:|
| Final Form | Tier 8 | 50× |
| Golden Form | Tier 25 | 400× |

Kaioken is a universal ability that multiplies your active transformation:

| Kaioken ability | Unlock requirement | Power multiplier |
|---|---:|---:|
| Kaioken x2 | Tier 2 | 2× |
| Kaioken x3 | Tier 6 | 3× |
| Kaioken x4 | Tier 12 | 4× |
| Kaioken x10 | Tier 20 | 10× |

Activate an unlocked level with `/kaioken level:x2`, `x3`, `x4`, or `x10`; choose `off` to disable it. Kaioken stacks with Super Saiyan God, Super Saiyan God Super Saiyan, Potential Unleashed, and other compatible forms. It cannot be combined with Super Saiyan, Super Saiyan 2, or Super Saiyan 3 because their ki is unstable. If stamina runs out, you drop one Kaioken level at a time before dropping the active transformation.

#### Universal God Ki

- Any race can attempt to awaken God Ki at Tier 50 with `/transform form:beyondgod`. Awakening is not guaranteed: you get one attempt every 12 hours, with a 5% chance for each of your first four attempts. After four failures, the chance doubles each attempt: 10%, 20%, 40%, 80%, then 100%.
- Saiyans can instead awaken God Ki by transforming into Super Saiyan God for the first time. This requires five other players with existing Saiyan progression profiles; select them in the helper options of `/transform form:ssg`. Later SSG transformations do not require helpers.
- Awakening sets the current overall level as God Tier 1. God Tier continues to increase with levels, while God Ki multipliers stop scaling after God Tier 15.
- Beyond God is the shared base form for all races after awakening. God Tier scales Beyond God from 1× to 400×.
- God Tier also scales Kaioken and each race's forms by the Beyond God multiplier. Saiyan Super Saiyan forms retain their existing caps below Super Saiyan God; Super Saiyan God and Super Saiyan God Super Saiyan remain Saiyan-only.
- For Saiyans, Super Saiyan, Super Saiyan 2, and Super Saiyan 3 remain capped at one-third, two-thirds, and three-quarters of the current Super Saiyan God multiplier, respectively. Super Saiyan God scales from 20,000× to 30,000×, and Super Saiyan God Super Saiyan is 50× Super Saiyan God.
- Super Saiyan God Super Saiyan unlocks at God Tier 15. For example, awakening at overall level 58 means it unlocks at overall level 72.

### Training and stamina by form

| Form | Training power | Training stamina cost | Stamina per eligible message |
|---|---:|---:|---:|
| Normal / Beyond God | 5,000 | 10 | 0 |
| Super Saiyan | 244,000 | 500 | 1 |
| Super Saiyan 2 | 480,000 | 1,000 | 2 |
| Super Saiyan 3 | 1,880,000 | 4,000 | 15 |
| Super Saiyan God | 2,025,000 | 4,500 | 5 |
| Super Saiyan God Super Saiyan | 2,125,000 | 5,000 | 10 |
| Kaioken ability only (x2) | 49,500 | 250 | 2 |
| Kaioken ability only (x3) | 73,500 | 500 | 5 |
| Kaioken ability only (x4) | 96,000 | 1,000 | 10 |
| Kaioken ability only (x10) | 225,000 | 3,000 | 25 |
| Potential Unleashed | 1,150,000 | 2,500 | 6 |
| Giant Namekian / Final Form | 570,000 | 1,200 | 4 |
| Golden Form | 2,700,000 | 6,000 | 10 |

#### Stamina

- Stamina is capped at 10,000 and regenerates at 2,000 per day while in Normal/Beyond God.
- Each eligible message drains stamina according to the training and stamina table above. When Kaioken is stacked with a transformation, its x2/x3/x4/x10 level multiplies that form's message drain and training stamina cost. For example, Potential Unleashed with Kaioken x3 drains 18 stamina per eligible message and costs 7,500 stamina to train.
- Kaioken used by itself drains 2/5/10/25 stamina per eligible message and costs 250/500/1,000/3,000 stamina to train at x2/x3/x4/x10.
- A stacked training cost can exceed the 10,000 stamina cap; disable Kaioken or train in a less taxing form in that case.
- When stamina runs out, Kaioken steps down one level at a time; after it is disabled, the active transformation can also drop as stamina remains depleted.

## Data backup and restore

Enmap stores progression records and privacy preferences in `data/enmap.sqlite` under the project folder. This folder is intentionally ignored by Git. Backups contain members' progression data and opt-out state, so restrict access to the backup location and keep backups private.

To make a backup on Windows, stop the bot first so SQLite has closed its files, then copy the entire `data` folder to a safe location. For example, from the project folder in PowerShell:

```powershell
$backup = Join-Path $env:USERPROFILE ("Scouter-data-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".zip")
Compress-Archive -Path .\data -DestinationPath $backup
```

To restore, stop the bot, preserve or rename the existing `data` folder, then extract the chosen backup into the project folder. Restoring an older backup can restore progression records that were later deleted and can also roll privacy preferences back to the time of that backup. After startup, reapply any opt-out requests received since the backup was made with `/privacy action:optout` before allowing members to use progression features; this removes the restored progression record and saves the opt-out marker. For example:

```powershell
Rename-Item .\data .\data-before-restore
Expand-Archive -Path "$env:USERPROFILE\Scouter-data-YYYYMMDD-HHMMSS.zip" -DestinationPath . -Force
```

Replace the example timestamp with the backup file's name. Start the bot after extraction completes. Keep the entire `data` folder together rather than restoring only `enmap.sqlite`.

## Tests

Run the progression and command-flow tests with:

```sh
npm test
```

## User privacy

Use `/privacy action:optout` to stop progression tracking in the current server and delete that server's active progression record, including power, training state, and achievements. Opt-out is per server; it does not affect data the member may have in another server. While opted out, ordinary chat does not create or update the member's record, and scans, profiles, and comparisons cannot read it. The `/privacy` command remains available to opt back in; a fresh record is created on the member's next chat message.

Progression commands may post profile or scan details in the channel where they are used, so choose an appropriately private channel if those details should not be visible to everyone who can read it. Opting out deletes the active record but cannot erase copies in backups already made. If a member requests deletion of historical copies too, remove the relevant backup files; account for that request when restoring any older backup.

## Progression and training

- Eligible messages grant 400–660 progression power, independent of transformation. The base random award is 400–600; messages earn up to 10% extra based on non-whitespace length, capped at 200 characters. Transformation multipliers remain in effect for displayed power level.
- To reduce chat spam, only one message per user can earn power every 60 seconds. Repeating the same normalized message within 10 minutes of its last power award does not earn power.
- The XP required to advance from level `L` is cumulative: `5,000 × L + 3,000 × (L × (L + 1) × (2L + 1) / 6)`. Super Saiyan God Super Saiyan requires God Tier 15; the overall level where it unlocks depends on when God Ki was awakened.
- Messages shorter than the configured minimum size and messages beginning with the legacy message prefix do not grant progression power. Commands are invoked with Discord's `/` command picker.
- Training rewards use form-specific multipliers and penalties, separate from the lore-based displayed power multipliers. Base-form training is the most stamina-efficient option.
- A user's progression record is created the first time they chat in a server. New-user notices are batched per server and sent no more than once per minute, showing both the number added in that update and the total users tracked.
- Achievements are announced when earned and can be reviewed with `/achievements`. They include tier and power milestones, first-time transformations, a first training session, and training on seven consecutive UTC calendar days.

At 100 eligible messages per day, the current numbers estimate roughly nine months to reach overall level 64 for an active user who starts at level 1, trains regularly, and uses higher forms before returning to base to recover stamina. Super Saiyan God Super Saiyan unlock timing depends on when the user awakens God Ki. Actual timing varies with message eligibility, training use, and stamina management.
