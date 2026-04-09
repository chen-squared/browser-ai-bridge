export type ExtractedMarkdownTokenPayload = {
  token: string;
  markdown: string;
  display?: 'block' | 'inline';
};

type RestoreMarkdownTokenOptions = {
  padIsolatedToken?: (payload: ExtractedMarkdownTokenPayload) => boolean;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function restoreMarkdownTokenPayloads(
  content: string,
  payloads: readonly ExtractedMarkdownTokenPayload[] | null | undefined,
  options: RestoreMarkdownTokenOptions = {},
): string {
  let restored = String(content || '');
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return restored;
  }

  const shouldPadIsolatedToken = options.padIsolatedToken ?? (() => true);

  for (const payload of payloads) {
    if (!payload || typeof payload.token !== 'string' || typeof payload.markdown !== 'string') {
      continue;
    }

    const escapedToken = escapeRegExp(payload.token);
    if (shouldPadIsolatedToken(payload)) {
      restored = restored.replace(
        new RegExp(`(?:^|\\n)${escapedToken}(?=\\n|$)`, 'gu'),
        () => `\n\n${payload.markdown}\n\n`,
      );
    }
    restored = restored.replace(new RegExp(escapedToken, 'gu'), () => payload.markdown);
  }

  return restored.replace(/\n{3,}/g, '\n\n').trim();
}
