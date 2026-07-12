# Cardo ⊕ — your pivot point

A **local-first, freely arrangeable dashboard** for macOS, Linux and Windows:
to-dos, notes, calendar, timers, habits and a fully local AI assistant — as
widgets on your personal board. No account, no cloud, no tracking.

**→ Download & website: https://hollatzleif.github.io/cardo-app/**
**→ Forum & releases: https://github.com/hollatzleif/cardo-app**

## About this repository

This is the source code of Cardo, published **source-available** (see
[LICENSE.md](LICENSE.md)): you can read it, learn from it and build it for
personal use — redistribution and derivative works are not permitted.
Official builds are free and signed; get them from the link above.

## Tech overview

- **Shell:** Tauri 2 (Rust core: SQLite storage with change log, persistent
  scheduler, local LLM engine via llama.cpp)
- **UI:** React + TypeScript, design tokens only (no hardcoded colors —
  enforced by the build)
- **Tools** are plugins against a versioned Plugin API with mandatory privacy
  declarations and self-tests
- **Privacy:** everything runs locally; every feature that would touch the
  internet is opt-in and explained in plain language first

## Development

```
pnpm install
pnpm tauri dev      # run the app
pnpm test           # JS tests · cargo test for the Rust side
pnpm lint           # eslint + stylelint + token guard + secret scan
```

Issues and ideas are welcome — please use the
[forum](https://github.com/hollatzleif/cardo-app/discussions).
