/** One token of a candidate vanity number: either a dictionary word or a literal digit run. */
export type Segment =
  | { readonly kind: 'word'; readonly text: string; readonly tier: number; readonly start: number }
  | { readonly kind: 'digits'; readonly text: string; readonly start: number };

export function wordSegment(text: string, tier: number, start: number): Segment {
  return { kind: 'word', text, tier, start };
}

export function digitSegment(text: string, start: number): Segment {
  return { kind: 'digits', text, start };
}

/** Render segments the way a vanity number is printed: "CAKE-227". */
export function renderSegments(segments: readonly Segment[]): string {
  return segments.map((s) => s.text).join('-');
}
