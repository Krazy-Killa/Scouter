# Changelog

Notable changes to Scouter are documented here.

## [Unreleased]

### Added

- `/spar` challenge flow: the target gets Accept/Decline buttons, the challenger
  can cancel, challenges expire as declined after 5 minutes, and pending
  challenges are persisted and restored after a restart. Combat outcomes are not
  implemented yet.

### Changed

- Moved privacy, scanning, profile, comparison, help, achievements, leaderboard,
  and training command handling into a dedicated user-command module.

### Tests

- Expanded command-flow coverage for ignored messages, stamina recovery in and
  out of base form, and Discord member-lookup failures.

## [0.6.5] - 2026-10-21

### Changed

- Moved race, transformation, Kaioken, and revert command handling into a
  dedicated command module without changing command behavior.
- Hid the God Ki awakening odds from attempt responses and user-facing
  documentation.
- Updated the roadmap to reflect completed reliability and maintainability work.

### Tests

- Covered the complete Beyond God awakening pity schedule through the guaranteed
  attempt.
- Added Saiyan SSG awakening coverage for legacy helper profiles and missing
  helper profiles.
