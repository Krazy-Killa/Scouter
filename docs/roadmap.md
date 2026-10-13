# Roadmap

This roadmap describes possible next steps for Scouter. Priorities may change
with maintainer capacity and community feedback; no release dates are promised.

## Near term

- **Strengthen reliability:** Expand automated coverage for message progression,
  persistence, and failure cases so balance and data changes remain safe.
- **Improve maintainability:** Gradually separate command handling from
  `xp.js`, keeping existing command behavior intact as the bot grows.

## Later

- **Review progression balance:** Use player feedback and observed play patterns
  to evaluate leveling pace, stamina costs, training rewards, and race/form
  balance before changing established values.
- **Assess combat and roleplay scope:** Decide whether combat belongs in
  Scouter's focused power-progression identity or whether the project should
  deliberately expand toward a broader RP bot. Gather community feedback and
  define a small, opt-in concept before committing to implementation.

## Guiding principles

- Preserve progression records and privacy choices across upgrades.
- Keep privacy opt-out behavior explicit and testable.
- Prefer incremental, backward-compatible changes to a large rewrite.
