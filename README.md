# Scouter
An RPG-style Discord progression bot where members earn power through chat and training, unlock Saiyan transformations and god ki, and compete on server leaderboards.

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

Grant the bot these channel permissions:

**Required for normal bot operation**

- **View Channel**
- **Send Messages**
- **Embed Links** — commands and progression notices use embeds.

**Required for automatic cleanup**

- **Manage Messages** — allows the bot to delete users' command messages. Without it, the bot can still run commands and delete its own messages, but command messages will remain. The bot logs deletion failures to its console.

**Required for reaction-based leaderboard pagination**

- **Add Reactions**
- **Read Message History**
- **Manage Messages** — used to remove the requesting user's reaction after a page change.

The bot also needs the **Message Content Intent** enabled under **Developer Portal → Bot → Privileged Gateway Intents** so it can read command text and award progression for chat messages.

## Commands

Commands use the configured prefix, which defaults to `!`. Set another prefix with `DISCORD_PREFIX` in `.env` or `prefix` in a local `config.json`.

| Command | Usage | Description |
|---|---|---|
| `help` | `!help` | Lists the bot's commands. |
| `scan` | `!scan`, `!scan @user`, or `!scan <user-id>` | Displays a scouter-style power reading for you or another server member. Users who opted out of tracking cannot be scanned. |
| `profile` | `!profile [@user]` | Shows base and displayed power, tier, form, stamina, progress to the next tier, achievements, and power earned per eligible message; can also show another member's profile. Profiles are unavailable for members who opted out. |
| `compare` | `!compare @user` or `!compare <user-id>` | Compares base and displayed power, tier, form, stamina, progress, and achievements with another server member. |
| `leaderboard` | `!leaderboard` | Shows the all-time rankings for the current server, 10 users per page, ordered by displayed power level. Use the left and right reactions to change pages. |
| `achievements` | `!achievements` | Lists unlocked and locked achievements. |
| `train` | `!train` | Trades stamina for a one-time power reward. It can be used once every 24 hours. |
| `transform` | `!transform <form>` | Changes your form. Valid forms: `normal`, `ssj`, `ssj2`, `ssj3`, `ssg`, `ssgss`. |
| `revert` | `!revert` | Automatically returns you to your normal form (Beyond God if you have god ki). |
| `privacy` | `!privacy optout` or `!privacy optin` | Opts out of progression tracking in this server and deletes your saved record, or opts back in to start a new record. |
| `setlevel` | `!setlevel @user <level>` or `!setlevel <user-id> <level>` | Sets a user's tier without changing their accumulated power. Only the server owner can use this command. Setting the tier below 50 removes God Ki and reverts Super Saiyan God/Super Saiyan God Super Saiyan to normal. |
| `setpower` | `!setpower @user <power>` or `!setpower <user-id> <power>` | Sets a user's base power and recalculates their tier. Requires a whole number of at least 2,500; only the server owner can use it. Setting power below Tier 50 removes God Ki and reverts Super Saiyan God/Super Saiyan God Super Saiyan to normal. |
| `reset` | `!reset @user` or `!reset <user-id>` | Resets an existing progression profile to its fresh starting state, including power, tier, form, stamina, training history, cooldowns, and achievements. Only the server owner can use this command. |

Replace `!` in these examples if you configured a different prefix. `setlevel` changes only the tier, while `setpower` changes base power and recalculates the tier. Administrative commands cannot modify a member who opted out of progression tracking.

For leaderboards with multiple pages, use the left and right reactions beneath the leaderboard to navigate. The controls are available to the person who ran the command for two minutes.

### Transformation requirements

| Form | Unlock requirement | Training power | Training stamina cost | Stamina per eligible message |
|---|---:|---:|---:|---:|
| Normal (Beyond God with god ki) | 1 | 5,000 | 10 | 0 |
| Super Saiyan | 4 | 244,000 | 500 | 1 |
| Super Saiyan 2 | 8 | 480,000 | 1,000 | 2 |
| Super Saiyan 3 | 16 | 1,880,000 | 4,000 | 15 |
| Super Saiyan God | 50 | 2,025,000 | 4,500 | 5 |
| Super Saiyan God Super Saiyan | God Tier 15 | 2,125,000 | 5,000 | 10 |

#### Unlocking God Ki

- Super Saiyan God unlocks at overall level 50 and awakens God Ki. Your current overall level becomes God Tier 1.
- Super Saiyan God Super Saiyan unlocks at God Tier 15, regardless of your overall level.
- God Tier is based on levels gained after awakening. For example, if you awaken at level 58, you reach God Tier 15 at overall level 72.
- God Ki multipliers continue to scale through God Tier 15, then stop increasing.

#### God Ki multipliers

| Form | Multiplier |
|---|---:|
| Beyond God (base form) | Scales from 1× at God Tier 1 to 400× at God Tier 15 |
| Super Saiyan | Up to 50× Beyond God; capped at one-third of Super Saiyan God |
| Super Saiyan 2 | Up to 100× Beyond God; capped at two-thirds of Super Saiyan God |
| Super Saiyan 3 | Up to 400× Beyond God; capped at three-quarters of Super Saiyan God |
| Super Saiyan God | Scales from 20,000× at God Tier 1 to 30,000× at God Tier 15 |
| Super Saiyan God Super Saiyan | 50× the current Super Saiyan God multiplier (1,000,000×–1,500,000×) |

The caps keep the forms in order: Super Saiyan < Super Saiyan 2 < Super Saiyan 3 < Super Saiyan God.

#### Stamina

- Stamina is capped at 10,000 and regenerates at 2,000 per day while in base form.
- Each eligible message drains stamina according to the transformation requirements table above. Super Saiyan 3 drains 15 per message; Super Saiyan God drains 5.
- When stamina reaches zero, you drop one transformation level.

## Data backup and restore

Enmap stores progression and privacy preferences in `data/enmap.sqlite` under the project folder. This folder is intentionally ignored by Git; back it up separately and keep backups private because they contain user progression records.

To make a backup on Windows, stop the bot first so SQLite has closed its files, then copy the entire `data` folder to a safe location. For example, from the project folder in PowerShell:

```powershell
$backup = Join-Path $env:USERPROFILE ("Scouter-data-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".zip")
Compress-Archive -Path .\data -DestinationPath $backup
```

To restore, stop the bot, preserve or rename the existing `data` folder, then extract the chosen backup into the project folder. For example:

```powershell
Rename-Item .\data .\data-before-restore
Expand-Archive -Path "$env:USERPROFILE\Scouter-data-YYYYMMDD-HHMMSS.zip" -DestinationPath . -Force
```

Replace the example timestamp with the backup file's name. Start the bot after extraction completes. Keep the entire `data` folder together rather than restoring only `enmap.sqlite`.

## Tests

Run the progression unit tests with:

```sh
npm test
```

## User privacy

Use `!privacy optout` to stop progression tracking in the current server and delete that server's active progression record, including power, training state, and achievements. While opted out, the bot does not process progression commands or ordinary chat for that user. Use `!privacy optin` to resume tracking; a fresh record is created on the user's next chat message. Existing backups may still contain an earlier copy of a deleted record; remove those backup files too if you need to erase that historical copy.

## Progression and training

- Eligible messages grant 400–660 progression power, independent of transformation. The base random award is 400–600; messages earn up to 10% extra based on non-whitespace length, capped at 200 characters. Transformation multipliers remain in effect for displayed power level.
- To reduce chat spam, only one message per user can earn power every 60 seconds. Repeating the same normalized message within 10 minutes of its last power award does not earn power.
- The XP required to advance from level `L` is cumulative: `5,000 × L + 3,000 × (L × (L + 1) × (2L + 1) / 6)`. Super Saiyan God Super Saiyan requires God Tier 15; the overall level where it unlocks depends on when God Ki was awakened.
- Messages shorter than the configured minimum size and messages beginning with the command prefix do not grant progression power.
- Training rewards use form-specific multipliers and penalties, separate from the lore-based displayed power multipliers. Base-form training is the most stamina-efficient option.
- A user's progression record is created the first time they chat in a server. New-user notices are batched per server and sent no more than once per minute, showing both the number added in that update and the total users tracked.
- Achievements are announced when earned and can be reviewed with `!achievements`. They include tier and power milestones, first-time transformations, a first training session, and training on seven consecutive UTC calendar days.

At 100 eligible messages per day, the current numbers estimate roughly nine months to reach overall level 64 for an active user who starts at level 1, trains regularly, and uses higher forms before returning to base to recover stamina. Super Saiyan God Super Saiyan unlock timing depends on when the user awakens God Ki. Actual timing varies with message eligibility, training use, and stamina management.
