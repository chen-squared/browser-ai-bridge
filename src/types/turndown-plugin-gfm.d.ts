declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';

  type Plugin = (service: TurndownService) => void;

  export const gfm: Plugin;
}
