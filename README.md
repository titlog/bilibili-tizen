# bilibili on Samsung TV

A bilibili client for a Samsung Tizen television, driven entirely by the remote.
Plain ES5, no build step, no backend, no proxy — the TV talks to bilibili
directly.

- `app/` — the client
- `spike/` — the diagnostic harness that established what the platform can do
- `tools/` — deploy, diagnostics collector, Samsung certificate issuance
- `CLAUDE.md` — how it works, what was measured, and the traps worth knowing

Deploy with `zsh tools/deploy.sh`. Everything else is in `CLAUDE.md`.

Personal project, not affiliated with bilibili or Samsung.
