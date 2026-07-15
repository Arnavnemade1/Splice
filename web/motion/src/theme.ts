import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';
import { loadFont as loadSans } from '@remotion/google-fonts/Inter';

export const { fontFamily: MONO } = loadMono();
export const { fontFamily: SANS } = loadSans();

export const BG = '#06080f';
export const INK = '#f4f6fb';
export const DIM = 'rgba(244, 246, 251, 0.38)';
export const FAINT = 'rgba(244, 246, 251, 0.22)';
export const ACCENT = '#67e8c3';
export const AMBER = '#f7c95c';
export const ROSE = '#ff6b8a';

export type Palette = { a: string; b: string; c: string };

/* Each film gets its own light so the pages don't feel like reruns. */
export const PALETTES: Record<string, Palette> = {
  lie: { a: 'rgba(255, 107, 138, 0.20)', b: 'rgba(247, 201, 92, 0.16)', c: 'rgba(129, 140, 248, 0.18)' },
  session: { a: 'rgba(103, 232, 195, 0.28)', b: 'rgba(125, 211, 252, 0.20)', c: 'rgba(129, 140, 248, 0.16)' },
  doctor: { a: 'rgba(103, 232, 195, 0.30)', b: 'rgba(52, 211, 153, 0.18)', c: 'rgba(125, 211, 252, 0.14)' },
};
