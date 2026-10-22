# Roadmap

This roadmap describes possible next steps for Scouter. Priorities may change
with maintainer capacity and community feedback; no release dates are promised.

## Near term

- **Strengthen reliability:** Expand automated coverage for message progression,
  persistence, and failure cases. Current regression coverage includes chat
  cooldowns and duplicate-message protection, plus transactional rollback when
  stored Enmap data is invalid. Awakening tests also cover the full pity schedule
  through its guaranteed attempt, and Saiyan ritual tests cover legacy and
  missing helper profiles.
- **Improve maintainability:** Keep moving command concerns out of `xp.js`
  into focused modules without changing behavior. Slash-command registration
  and interaction adaptation now live in `commands/slash-commands.js`; owner
  progression controls live in `commands/admin.js`; race, transformation, and
  Kaioken command flows now live in `commands/transformation.js`. Continue
  extracting other command groups incrementally.

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
  - Start a challenge with a slash command, optionally allowing a mention or
    reply to identify the target. Check that both players have progression
    profiles and respect their privacy opt-outs; never start combat from a
    mention or reply alone.
  - Give each player a private consent prompt with Accept and Decline buttons.
    The challenger can receive an ephemeral prompt, while the opponent may need
    a DM because Discord does not allow a bot to send another user an ephemeral
    reply. Handle disabled DMs explicitly rather than silently proceeding.
  - Start only after both players accept. Only the two participants can use the
    buttons; either may decline, and an unanswered challenge expires as
    declined. Disable the buttons and update the challenge status after a
    decision or timeout.
  - Persist pending challenges and their expiry so a restart cannot leave an
    invitation open indefinitely.
  - Keep sparring outcomes temporary and cosmetic, with no loss of permanent
    progression. Define cooldowns and a way to decline or disable challenges.

## Guiding principles

- Preserve progression records and privacy choices across upgrades.
- Keep privacy opt-out behavior explicit and testable.
- Prefer incremental, backward-compatible changes to a large rewrite.
