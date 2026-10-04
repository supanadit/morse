import { Controller, Get } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROTOCOL_VERSION, parseFrontendManifest } from '@morse/protocol';
import type { MorseServerConfig } from '../../app/config.js';
import { Inject } from '@nestjs/common';
import { MORSE_CONFIG } from '../../app/tokens.js';

@Controller('api')
export class HealthController {
  constructor(@Inject(MORSE_CONFIG) private readonly config: MorseServerConfig) {}

  @Get('health')
  health(): {
    status: string;
    protocolVersion: number;
    workspace: string;
    frontend: string;
    instance?: string;
  } {
    return {
      status: 'ok',
      protocolVersion: PROTOCOL_VERSION,
      workspace: this.config.workspace.cwd,
      frontend: this.config.uiDir,
      // Echoed so the CLI that spawned this daemon can tell it apart from an
      // unrelated process that later reused the same pid.
      ...(this.config.instance ? { instance: this.config.instance } : {}),
    };
  }

  @Get('manifest')
  async manifest(): Promise<unknown> {
    const raw = await readFile(join(this.config.uiDir, 'webview.manifest.json'), 'utf8').catch(
      () => undefined,
    );
    return parseFrontendManifest(raw) ?? { name: 'unknown', protocolVersion: PROTOCOL_VERSION };
  }
}
