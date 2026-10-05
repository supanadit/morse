# Support

Thanks for using Morse. A few places to look, fastest first.

- **The panel says the agent is unavailable, or nothing starts.** Run **Morse: Show Log** (or the
  command palette → *Morse: Show Log*) for the exact reason. It is almost always a missing `pi`
  binary on `PATH` (`pi --version`) or an unauthenticated provider (`pi` → `/login`).
- **Where does it keep state?** Morse writes nothing of its own inside your project. Sessions, models
  and credentials are pi's, under `~/.pi`; the browser host keeps its own layout under `~/.morse`.
- **Docs.** [Install](https://github.com/supanadit/morse/blob/master/docs/INSTALL.md) ·
  [Configuration](https://github.com/supanadit/morse/blob/master/docs/CONFIGURATION.md) ·
  [Troubleshooting / install gotchas](https://github.com/supanadit/morse/blob/master/docs/INSTALL.md#troubleshooting)
- **Bugs and feature requests.** Open an issue at
  <https://github.com/supanadit/morse/issues> and include the **Morse: Show Log** output and your
  VS Code / `pi` versions.
- **Questions and ideas.** <https://github.com/supanadit/morse/discussions>

Morse is a personal, AI-assisted project without a support contract — issues are read, but replies
are best-effort.
