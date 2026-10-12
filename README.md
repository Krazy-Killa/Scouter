# Scouter
Powerleveling bot for Discord.

## Setup

### Install Node.js and npm

If you do not already have Node.js and npm installed:

1. Visit the [official Node.js download page](https://nodejs.org/en/download) and download the **LTS** release for your operating system. npm is included with Node.js; you do not need to install it separately.
2. Run the installer and keep the option to add Node.js to your PATH enabled, if shown.
3. Close and reopen your terminal, then check that both tools are available:

   ```sh
   node --version
   npm --version
   ```

   If either command is not recognized, restart your computer or reinstall Node.js and make sure it is added to your PATH.

### Install and run Scouter

From a terminal opened in the Scouter project folder:

1. Install the project dependencies: `npm install`
2. Copy `.env.example` to `.env` and set your actual Discord token.
3. Start the bot: `npm start`

Do not commit your real token. Keep `.env` and any local `config.json` out of Git; both are ignored in this repo.

## Commands

Commands use the configured prefix, which defaults to `!`. Set another prefix with `DISCORD_PREFIX` in `.env` or `prefix` in a local `config.json`.

| Command | Usage | Description |
|---|---|---|
| `help` | `!help` | Lists the bot's commands. |
| `info` | `!info` | Shows your tier, displayed power level, current stamina, and progress to the next level. |
| `leaderboard` | `!leaderboard` | Shows the all-time rankings for the current server, 10 users per page, ordered by displayed power level. Use the left and right reactions to change pages. |
| `achievements` | `!achievements` | Lists unlocked and locked achievements. |
| `train` | `!train` | Trades stamina for a one-time power reward. It can be used once every 24 hours. |
| `transform` | `!transform <form>` | Changes your form. Valid forms: `normal`, `ssj`, `ssj2`, `ssj3`, `ssg`, `ssgss`. |
| `setlevel` | `!setlevel @user <level>` or `!setlevel <user-id> <level>` | Sets a user's level. Only the server owner can use this command. |

Replace `!` in these examples if you configured a different prefix. The `setlevel` command updates the level only; it does not adjust the user's accumulated power.

For leaderboards with multiple pages, use the left and right reactions beneath the leaderboard to navigate. The controls are available to the person who ran the command for two minutes.

The bot needs the **Add Reactions**, **Read Message History**, and **Manage Messages** permissions in the channel to use and clean up the leaderboard reaction controls.

### Transformation requirements

| Form | Minimum level | Training power | Training stamina cost | Stamina per eligible message |
|---|---:|---:|---:|---:|
| Normal | 1 | 5,000 | 10 | 0 |
| SSJ | 4 | 244,000 | 500 | 1 |
| SSJ2 | 8 | 480,000 | 1,000 | 2 |
| SSJ3 | 16 | 1,880,000 | 4,000 | 4 |
| SSG | 50 | 2,025,000 | 4,500 | 5 |
| SSGSS | 64 | 2,125,000 | 5,000 | 10 |

Users who have reached god ki cannot return to the non-god forms. In god ki, `normal` means the 80,000 base god form. Stamina is capped at 10,000 and regenerates at 2,000 per day while in base form. When transformed stamina reaches zero, the user drops one form.

## Progression and training

- Eligible messages grant 400–660 progression power, independent of transformation. The base random award is 400–600; messages earn up to 10% extra based on non-whitespace length, capped at 200 characters. Transformation multipliers remain in effect for displayed power level.
- To reduce chat spam, only one message per user can earn power every 60 seconds. Repeating the same normalized message within 10 minutes of its last power award does not earn power.
- The XP required to advance from level `L` is cumulative: `5,000 × L + 3,000 × (L × (L + 1) × (2L + 1) / 6)`. SSGSS remains unlocked at level 64.
- Messages shorter than the configured minimum size and messages beginning with the command prefix do not grant progression power.
- Training rewards use form-specific multipliers and penalties, separate from the lore-based displayed power multipliers. Base-form training is the most stamina-efficient option.
- A user's progression record is created the first time they chat in a server. New-user notices are batched per server and sent no more than once per minute, showing both the number added in that update and the total users tracked.
- Achievements are announced when earned and can be reviewed with `!achievements`. They include tier and power milestones, first-time transformations, a first training session, and training on seven consecutive UTC calendar days.

At 100 eligible messages per day, the current numbers estimate roughly nine months to level 64 for an active user who trains regularly and uses higher forms, then returns to base to recover stamina. Actual timing varies with message eligibility, training use, and stamina management.
