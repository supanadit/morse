import * as vscode from 'vscode';
import type { WorkspaceRef } from '@morse/core';
import type { PiRpcAdapterConfig } from '@morse/adapter-pi-rpc';

/** Reads the pi-related settings that configure the driven adapter. */
export function readPiAdapterConfig(): PiRpcAdapterConfig {
  const configuration = vscode.workspace.getConfiguration('morse');
  const piPath = configuration.get<string>('pi.path', '').trim();
  const entry = configuration.get<string>('pi.entry', '').trim();
  const sessionDir = configuration.get<string>('pi.sessionDir', '').trim();

  return {
    piPath: piPath.length > 0 ? piPath : undefined,
    nodeEntryPath: entry.length > 0 ? entry : undefined,
    sessionDir: sessionDir.length > 0 ? sessionDir : undefined,
    noSession: configuration.get<boolean>('pi.noSession', false),
    extraArgs: configuration.get<string[]>('pi.extraArgs', []),
    requestTimeoutMs: configuration.get<number>('pi.requestTimeoutMs', 30_000),
  };
}

/** How many `pi` processes the window keeps alive at once. */
export function readHotLimit(): number {
  const value = vscode.workspace.getConfiguration('morse').get<number>('sessions.hotLimit', 4);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 4;
}

/** The folders this window is scoped to (the agent may not leave them). */
export function readWorkspaceRoots(): string[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const roots = folders.map((folder) => folder.uri.fsPath);
  return roots.length > 0 ? roots : [process.cwd()];
}

/** The workspace the agent runs in (first folder in a multi-root workspace). */
export function readWorkspaceRef(): WorkspaceRef {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return { cwd: process.cwd(), name: 'workspace' };
  }
  return { cwd: folder.uri.fsPath, name: folder.name };
}
