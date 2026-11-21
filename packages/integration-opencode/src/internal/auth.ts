/** The HTTP basic-auth header OpenCode's server expects for its local password. */
export function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
}
