/**
 * Who this build stands on.
 *
 * `credits.spec.ts` walks every `package.json` in the workspace and fails when a
 * dependency is missing here, when a row outlives the package it credits, or when
 * an installed package changes its licence — so attribution cannot rot silently.
 *
 * Licence ids are the SPDX strings the packages themselves declare.
 */
export interface Credit {
  /** Display name: the project, not necessarily the package id. */
  name: string;
  /** npm packages this row covers; omitted when it is not one (platform, font, ...). */
  packages?: readonly string[];
  license: string;
  url: string;
  /** One line on what it does for Morse. */
  role: string;
  /** People behind it, where credit belongs to somebody. */
  by?: string;
}

export interface CreditGroup {
  title: string;
  blurb?: string;
  entries: readonly Credit[];
}

export const CREDITS: readonly CreditGroup[] = [
  {
    title: 'The agent',
    blurb: 'Morse never imports pi — it spawns `pi --mode rpc` and speaks its protocol.',
    entries: [
      {
        name: 'pi coding agent',
        by: 'Mario Zechner',
        license: 'MIT',
        url: 'https://github.com/earendil-works/pi',
        role: 'Reads, runs, edits and thinks: every reply in this window is pi talking.',
      },
    ],
  },
  {
    title: 'Interface',
    entries: [
      {
        name: 'Angular',
        packages: [
          '@angular/common',
          '@angular/compiler',
          '@angular/core',
          '@angular/forms',
          '@angular/platform-browser',
          '@angular/router',
        ],
        license: 'MIT',
        url: 'https://angular.dev',
        role: 'Components, signals and the shell both hosts render.',
        by: 'Google',
      },
      {
        name: 'Angular CDK',
        packages: ['@angular/cdk'],
        license: 'MIT',
        url: 'https://material.angular.dev/cdk/categories',
        role: 'The drag-and-drop that reorders the tab strip.',
        by: 'Google',
      },
      {
        name: 'xterm.js',
        packages: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-webgl'],
        license: 'MIT',
        url: 'https://xtermjs.org',
        by: 'The xterm.js authors',
        role: 'The terminal emulator that renders the bottom panel\u2019s shell.',
      },
      {
        name: 'RxJS',
        packages: ['rxjs'],
        license: 'Apache-2.0',
        url: 'https://rxjs.dev',
        role: 'The streams Angular is built on.',
      },
      {
        name: 'marked',
        packages: ['marked'],
        license: 'MIT',
        url: 'https://marked.js.org',
        role: 'Turns the agent’s markdown into HTML.',
      },
      {
        name: 'DOMPurify',
        packages: ['dompurify'],
        license: '(MPL-2.0 OR Apache-2.0)',
        url: 'https://github.com/cure53/DOMPurify',
        role: 'Sanitises that HTML before it reaches the DOM.',
        by: 'Cure53',
      },
      {
        name: 'highlight.js',
        packages: ['highlight.js'],
        license: 'BSD-3-Clause',
        url: 'https://highlightjs.org',
        role: 'Syntax colours in code blocks.',
      },
      {
        name: 'anime.js',
        packages: ['animejs'],
        license: 'MIT',
        url: 'https://animejs.com',
        role: 'The cold-start intro and the drop-zone pulse.',
        by: 'Julian Garnier',
      },
      {
        name: 'tslib',
        packages: ['tslib'],
        license: '0BSD',
        url: 'https://github.com/microsoft/tslib',
        role: 'TypeScript’s own runtime helpers.',
        by: 'Microsoft',
      },
    ],
  },
  {
    title: 'Hosts',
    entries: [
      {
        name: 'NestJS',
        packages: [
          '@nestjs/common',
          '@nestjs/core',
          '@nestjs/platform-express',
          '@nestjs/platform-ws',
          '@nestjs/websockets',
        ],
        license: 'MIT',
        url: 'https://nestjs.com',
        role: 'The browser host: static frontend plus one WebSocket gateway.',
        by: 'Kamil Myśliwiec',
      },
      {
        name: 'ws',
        packages: ['ws'],
        license: 'MIT',
        url: 'https://github.com/websockets/ws',
        role: 'The WebSocket server NestJS sits on.',
      },
      {
        name: 'node-pty',
        packages: ['node-pty'],
        license: 'MIT',
        url: 'https://github.com/microsoft/node-pty',
        role: 'The pseudo-terminal the browser host runs the panel\u2019s shell in.',
        by: 'Microsoft',
      },
      {
        name: 'reflect-metadata',
        packages: ['reflect-metadata'],
        license: 'Apache-2.0',
        url: 'https://github.com/rbuckton/reflect-metadata',
        role: 'Decorator metadata for NestJS’s dependency injection.',
        by: 'Ron Buckton',
      },
      {
        name: 'yaml',
        packages: ['yaml'],
        license: 'ISC',
        url: 'https://eemeli.org/yaml/',
        role: 'Parses prompt-template frontmatter the same way pi does, so a template pi refuses is reported instead of offered.',
        by: 'Eemeli Aro',
      },
      {
        name: 'Node.js',
        by: 'OpenJS Foundation',
        license: 'MIT',
        url: 'https://nodejs.org',
        role: 'Runtime for the host and for pi itself.',
      },
      {
        name: 'Visual Studio Code',
        by: 'Microsoft',
        license: 'MIT',
        url: 'https://code.visualstudio.com/api',
        role: 'The editor Morse docks into, and the API it builds against.',
      },
    ],
  },
  {
    title: 'Typeface',
    blurb:
      'The browser host bundles JetBrains Mono; VS Code keeps the editor’s own font and downloads nothing.',
    entries: [
      {
        name: 'JetBrains Mono',
        by: 'JetBrains',
        license: 'OFL-1.1',
        url: 'https://www.jetbrains.com/lp/mono/',
        role: 'The interface typeface, subset to latin and latin-ext. Licence text ships beside it.',
      },
      {
        name: 'Nerd Fonts',
        by: 'Ryan L. McIntyre',
        license: 'MIT',
        url: 'https://www.nerdfonts.com',
        role: 'Where the UI’s icon glyphs come from — Morse bundles none, they follow the editor font.',
      },
    ],
  },
  {
    title: 'Build & test',
    blurb: 'Not shipped with the app — but nothing here would exist without them.',
    entries: [
      {
        name: 'TypeScript',
        packages: ['typescript'],
        license: 'Apache-2.0',
        url: 'https://www.typescriptlang.org',
        role: 'Every line of Morse, typed.',
        by: 'Microsoft',
      },
      {
        name: 'Angular CLI & build',
        packages: ['@angular/cli', '@angular/build', '@angular/compiler-cli'],
        license: 'MIT',
        url: 'https://angular.dev/tools/cli',
        role: 'Builds, bundles and serves the frontend.',
      },
      {
        name: 'esbuild',
        packages: ['esbuild'],
        license: 'MIT',
        url: 'https://esbuild.github.io',
        role: 'Bundles the libraries, the server, the CLI and the extension.',
        by: 'Evan Wallace',
      },
      {
        name: 'Vitest',
        packages: ['vitest'],
        license: 'MIT',
        url: 'https://vitest.dev',
        role: 'The unit suites.',
      },
      {
        name: 'jsdom',
        packages: ['jsdom'],
        license: 'MIT',
        url: 'https://github.com/jsdom/jsdom',
        role: 'A DOM for those suites.',
      },
      {
        name: 'ESLint',
        packages: ['eslint'],
        license: 'MIT',
        url: 'https://eslint.org',
        role: 'Lints the extension.',
      },
      {
        name: 'typescript-eslint',
        packages: ['typescript-eslint'],
        license: 'MIT',
        url: 'https://typescript-eslint.io',
        role: 'The type-aware lint rules.',
      },
      {
        name: 'Prettier',
        packages: ['prettier'],
        license: 'MIT',
        url: 'https://prettier.io',
        role: 'Formatting, so no diff is about whitespace.',
      },
      {
        name: 'DefinitelyTyped',
        packages: ['@types/node', '@types/ws', '@types/mocha', '@types/vscode'],
        license: 'MIT',
        url: 'https://github.com/DefinitelyTyped/DefinitelyTyped',
        role: 'Type definitions for Node, ws, mocha and the VS Code API.',
      },
      {
        name: 'VS Code test tools',
        packages: ['@vscode/test-cli', '@vscode/test-electron'],
        license: 'MIT',
        url: 'https://code.visualstudio.com/api/working-with-extensions/testing-extension',
        role: 'Runs the integration suite in a real VS Code.',
        by: 'Microsoft',
      },
      {
        name: 'VSCE',
        packages: ['@vscode/vsce'],
        license: 'MIT',
        url: 'https://github.com/microsoft/vscode-vsce',
        role: 'Packages the extension into a .vsix.',
        by: 'Microsoft',
      },
      {
        name: 'npm-run-all',
        packages: ['npm-run-all'],
        license: 'MIT',
        url: 'https://github.com/mysticatea/npm-run-all',
        role: 'Runs the dev and watch scripts side by side.',
        by: 'Toru Nagashima',
      },
    ],
  },
];
