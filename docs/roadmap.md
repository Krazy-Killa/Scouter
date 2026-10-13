# Roadmap

This roadmap describes possible next steps for Scouter. Priorities may change
with maintainer capacity and community feedback; no release dates are promised.

## Near term

- **Strengthen reliability:** Expand automated coverage for message progression,
  persistence, and failure cases. Current regression coverage includes chat
  cooldowns and duplicate-message protection, plus transactional rollback when
  stored Enmap data is invalid.
- **Improve maintainability:** Keep moving command concerns out of `xp.js`
  into focused modules without changing behavior. Slash-command registration
  and interaction adaptation now live in `commands/slash-commands.js`; owner
  progression controls live in `commands/admin.js`. Continue extracting other
  command groups incrementally.

## Later

- **Review progression balance:** Use player feedback and observed play patterns
  to evaluate leveling pace, stamina costs, training rewards, and race/form
  balance before changing established values.
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
  possible experiment is consensual sparring with temporary outcomes that
  cannot remove permanent progression.

## Guiding principles

- Preserve progression records and privacy choices across upgrades.
- Keep privacy opt-out behavior explicit and testable.
- Prefer incremental, backward-compatible changes to a large rewrite.
