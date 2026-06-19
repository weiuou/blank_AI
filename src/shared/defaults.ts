import type { PageState, ThemeTokens } from './types';

export const defaultTheme: ThemeTokens = {
  pageBackground: '#ffffff',
  surface: '#ffffff',
  surfaceMuted: '#f5f5f5',
  textPrimary: '#111111',
  textSecondary: '#666666',
  accent: '#111111',
  accentSoft: '#ececec',
  border: '#dddddd',
  shadow: '0 18px 48px rgba(17, 17, 17, 0.08)',
  radius: '28px',
  fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif',
  spacing: '24px',
};

export function createInitialPageState(): PageState {
  return {
    theme: defaultTheme,
    behaviorState: {},
    root: {
      id: 'root',
      type: 'section',
      props: {
        layout: 'single',
        ariaLabel: 'AI canvas root',
      },
      styleTokens: {
        background: '#ffffff',
        minHeight: '100vh',
        width: '100%',
        padding: '0',
      },
      children: [
        {
          id: 'system-prompt',
          type: 'system_prompt',
          props: {
            placeholder: 'Describe the page you want to create...',
            layout: {
              position: 'center',
              width: 'min(760px, 100%)',
            },
            visual: {
              variant: 'glass',
              opacity: 0.42,
            },
          },
          styleTokens: {},
          children: [],
        },
        {
          id: 'system-timeline',
          type: 'system_timeline',
          props: {
            layout: {
              position: 'right',
              orientation: 'vertical',
            },
            visual: {
              variant: 'minimal',
              opacity: 1,
            },
            showLabels: true,
          },
          styleTokens: {},
          children: [],
        },
      ],
    },
  };
}
