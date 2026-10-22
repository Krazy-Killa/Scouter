# Roadmap

This roadmap describes possible next steps for Scouter. Priorities may change
with maintainer capacity and community feedback; no release dates are promised.

## Near term

- **Strengthen reliability:**
  - **Done:** Regression coverage now exercises chat cooldowns and duplicate
    messages; ignored bot, DM, legacy-prefix, and undersized messages; base-form
    stamina recovery and transformed-form recovery behavior; training costs and
    stamina exhaustion; privacy opt-out; Discord member-lookup and slash-response
    failures; transactional rollback when stored Enmap data is invalid; the
    complete awakening pity schedule through its guaranteed attempt; and Saiyan
    ritual handling of legacy and missing helper profiles. Keep adding focused
    regression tests when new behaviors or failure modes are introduced.
- **Improve maintainability:**
  - **Done:** Extracted slash-command registration and interaction adaptation
    into `commands/slash-commands.js`; privacy, scanning, profile, comparison,
    help, achievements, leaderboard, and training commands into
    `commands/user-commands.js`; owner progression controls into
    `commands/admin.js`; race, transformation, and Kaioken flows into
    `commands/transformation.js`; and spar challenges into `commands/spar.js`.
    `xp.js` now keeps command routing and shared message-progression lifecycle
    logic rather than the command-specific implementations.

## Later

- **Review progression balance:** Use player feedback and observed play patterns
  to evaluate leveling pace, stamina costs, training rewards, and race/form
  balance before changing established values.
- **Explore a Ki resource:** Consider a Ki bar for distinct abilities or
  techniques, keeping it separate from stamina's role in physical training and
  transformation upkeep. Define meaningful Ki uses and recovery rules before
  implementation; avoid adding a meter that only duplicates stamina upkeep.
- **Add daily and weekly objectives:** Offer optional goals around earning
  power, training, or tier milestones. Start with cosmetic or otherwise
  carefully capped rewards to avoid disrupting progression balance.
- **Add profile customization:** Explore unlockable titles, badges, or
  scouter-style profile themes tied to achievements.
- **Add teams and group rankings:** Let members form squads and compare
  combined power or activity using server-scoped groups.
- **Add server events:** Explore owner-enabled, time-limited progression
  challenges with participation goals and milestone rewards.
- **Add profile visibility controls:** Let members limit who can view profile
  details while remaining opted in to progression tracking.
- **Assess combat and roleplay scope:** Decide whether combat belongs in
  Scouter's focused power-progression identity or whether the project should
  deliberately expand toward a broader RP bot. Gather community feedback and
  define a small, opt-in concept before committing to implementation. One
  possible experiment is consensual sparring:
  - Add a message context-menu command (right-click a message, then Apps,
    then "Challenge to Spar"). The target is the message author, and the
    challenger gets an ephemeral confirm/cancel prompt. Confirming starts the
    same consent flow as `/spar`, with the same profile, opt-out, DM-failure
    and timeout rules. A plain reply cannot get an ephemeral prompt because it
    is not an interaction.
  - **Done:** `/spar target` posts a consent challenge in the channel with
    Accept, Decline and Cancel buttons. Only the target can accept or decline,
    only the challenger can cancel, and an unanswered challenge expires as
    declined after 5 minutes. Buttons are disabled and the embed updated after
    each outcome. Both players need profiles and must not be opted out, and
    each player can have one pending challenge. Pending challenges are
    persisted in the `sparChallenges` table and re-timed after a restart.
  - Consider a private prompt for the opponent. Discord only allows ephemeral
    replies to the person who ran the command, so this would need a DM, with
    disabled DMs handled explicitly rather than silently proceeding.
  - **Done:** Accepting starts an automatic, narrated three-round bout in the
    existing challenge message. Each round is weighted by effective power
    (`points x transformation`): the stronger fighter's per-round chance rises
    with the power ratio and is capped at 90%, so an underdog can still win.
    The result shows both effective power readings. The bout has no HP, move
    buttons, progression rewards, or stamina cost.
  - Consider optional cosmetic win/loss records or achievements and a per-pair
    cooldown (around 10 minutes); neither is part of the current bout.
  - Race perks (for example Saiyan comebacks) are a later addition.
  - Still decide whether to add a way for members to disable spar challenges.

## Guiding principles

- Preserve progression records and privacy choices across upgrades.
- Keep privacy opt-out behavior explicit and testable.
- Prefer incremental, backward-compatible changes to a large rewrite.
