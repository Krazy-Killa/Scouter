# Scouter Features

Scouter is a Discord RPG progression bot. Members earn base power through
eligible chat messages and training, unlock forms and abilities, and compare
their progress with others in the server. Progression is stored separately for
each Discord server.

Commands use Discord's native `/` command picker. Scouter registers its global
application commands at startup; initial registration can take some time to
appear across Discord. See the [README command reference](../README.md#commands)
for command options and setup. Most replies remain visible in the channel, while
`/privacy` replies are private to the invoking member. Slash-command replies are
not automatically deleted.

## Chat progression

- Eligible messages award a random 400–600 base power, with a length bonus of
  up to 10% for messages containing at least 200 non-whitespace characters.
- A member can earn message power once every 60 seconds. Repeating the same
  normalized message within 10 minutes of its previous award does not earn
  power.
- Messages shorter than the configured minimum length and messages beginning
  with the legacy message prefix do not award power. Prefix commands are not
  supported; use Discord's `/` command picker.
- A member's first message creates their server-specific progression profile.
  New-profile notices are batched and sent no more than once per minute per
  server.
- Power contributes to tier progression. Eligible messages can also drain
  stamina while the member is using a stamina-draining form or ability.

## Progression profiles and social features

- **Profile (`/profile`):** View base and displayed power, tier, race, active
  form, stamina, next-tier progress, and achievements. A member can view
  another server member's profile if they have not opted out.
- **Scan (`/scan`):** Get a scouter-style power reading for yourself or another
  member, including their tier, form, stamina, and next-tier progress.
- **Compare (`/compare`):** Compare progression details and achievements with
  another server member.
- **Leaderboard (`/leaderboard`):** View the server's all-time rankings by
  displayed power. Pages show 10 members and can be navigated with reactions;
  only the requester can use the controls, which remain active for two minutes.
- **Achievements (`/achievements`):** Review unlocked and locked achievements.
  Achievements cover tier and power milestones, transformations, first
  training, and a seven-day training streak.

## Training and stamina

- **Training (`/train`):** Exchange stamina for a one-time base-power reward.
  Training can be used once every 24 hours, and its reward, stamina cost, and
  penalty depend on the active form and Kaioken level.
- Stamina is capped at 10,000 and recovers at 2,000 per day.
- Stamina-draining forms consume stamina when eligible messages earn power.
  Kaioken can increase the stamina cost when stacked with compatible forms.
- When stamina is exhausted, Kaioken steps down and then the active form may
  revert, depending on remaining stamina and the active abilities.

## Races, forms, and abilities

- Members begin as Humans. `/race` changes a member's race before they reach
  1,000,000 base power; race locks permanently at that threshold.
- Each race has its own transformation path: Saiyan, Human, Namekian, or
  Frieza Race. `/transform` switches to an unlocked form, and `/revert` returns
  to Normal or Beyond God.
- Any race can attempt to awaken universal God Ki from Tier 50 using Beyond
  God. Attempts have a 12-hour cooldown and a chance that increases after
  repeated failures.
- A Saiyan's first Super Saiyan God transformation can awaken God Ki by
  meeting its helper requirement. God Ki then progresses in God Tiers, scaling
  Beyond God and compatible forms up to God Tier 15.
- **Kaioken (`/kaioken`):** A universal ability unlocked at higher tiers. It
  multiplies compatible forms, can be switched off independently, and cannot
  be combined with Super Saiyan, Super Saiyan 2, or Super Saiyan 3.

## Server-owner controls

The server owner can use `/setlevel`, `/setpower`, `/awardpower`, and `/reset`
to manage a member's progression. These controls respect privacy opt-outs.
Setting power recalculates the member's tier; awarding power adds to their
existing base power; resetting creates a fresh profile.

## Privacy and data

- **Privacy (`/privacy action:optout`):** Stop tracking in the current server and
  delete the member's active progression record there. Their record cannot be
  scanned, viewed, compared, or changed with owner controls while opted out.
- **Privacy (`/privacy action:optin`):** Resume tracking; a new profile is created
  when the member next chats. Privacy choices are server-specific.
- `/privacy` confirmations and instructions are only visible to the invoking member.
- Progression data and opt-out preferences are stored locally in SQLite via
  Enmap. The database is excluded from Git; maintainers should back it up
  privately and follow the [backup and restore instructions](../README.md#data-backup-and-restore).

For exact unlock tiers, multipliers, training values, configuration, and
operational requirements, see the [README](../README.md).
