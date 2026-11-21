/** The sentence a thrown value reads as: an Error's own message, else its text. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
