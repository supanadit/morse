# Bundled font — JetBrains Mono

The browser host's own copy of JetBrains Mono, so Morse looks the same without anything
installed on the machine. VS Code never downloads these: there `--vscode-font-family` /
`--vscode-editor-font-family` win before the `'JetBrains Mono'` fallback is reached.

Only the `latin` and `latin-ext` subsets are shipped (~115 KB in total). The browser picks
one file per style through the `unicode-range` declared in `src/styles.css`, which references
them as `/fonts/...` — absolute, because that is where the browser host serves the bundle.
VS Code never resolves that path: there `--vscode-font-family` / `--vscode-editor-font-family`
win before the `'JetBrains Mono'` fallback is reached, so the family is never requested.
Icon glyphs (`⧉ ▸ ⌕ …`) are not in JetBrains Mono at all, so they keep coming from the editor
or system fallback font, exactly as they did before.

| | |
|---|---|
| Source | `@fontsource-variable/jetbrains-mono@5.3.0` (variable, weight 100–800, italic) |
| Upstream | https://github.com/JetBrains/JetBrainsMono, via google/fonts v24 |
| Licence | `LICENSE.txt` — SIL Open Font License 1.1; ships with every copy of the bundle |

Updating: download that npm tarball, copy
`files/jetbrains-mono-{latin,latin-ext}-wght-{normal,italic}.woff2` and the package `LICENSE`
here, then bump the version in the table above.
