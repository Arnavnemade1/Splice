import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Aurora } from './Aurora';
import { ACCENT, AMBER, BG, DIM, INK, MONO, PALETTES, SANS } from './theme';

export const SESSION_DURATION = 430;

type Kind = 'intent' | 'dim' | 'warn' | 'ok';
type Line = { at: number; kind: Kind; label: string; text: string };

/* The story: an agent hits a wall, remembers the fix, acts, and proves it worked. */
const LINES: Line[] = [
  { at: 24, kind: 'intent', label: 'intent', text: 'click "Place order"' },
  { at: 80, kind: 'dim', label: 'diagnose', text: 'reading page state' },
  { at: 116, kind: 'warn', label: 'blocked', text: 'modal · cookie-consent is intercepting clicks' },
  { at: 162, kind: 'dim', label: 'recover', text: 'remembered fix found for this site' },
  { at: 200, kind: 'ok', label: 'applied', text: 'dismissed cookie-consent' },
  { at: 240, kind: 'dim', label: 'act', text: 'click "Place order"' },
  { at: 276, kind: 'dim', label: 'verify', text: 'expect url_contains "/thanks"' },
  { at: 316, kind: 'ok', label: 'verified', text: 'reached /thanks' },
];

const PHASES = [
  { name: 'DIAGNOSE', from: 74, to: 158 },
  { name: 'RECOVER', from: 158, to: 236 },
  { name: 'ACT', from: 236, to: 272 },
  { name: 'VERIFY', from: 272, to: 372 },
];

const COLORS: Record<Kind, string> = {
  intent: INK,
  dim: DIM,
  warn: AMBER,
  ok: ACCENT,
};

const PhaseRail: React.FC = () => {
  const frame = useCurrentFrame();
  const appear = interpolate(frame, [40, 62], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div style={{ display: 'flex', gap: 46, opacity: appear, marginBottom: 58 }}>
      {PHASES.map((p) => {
        const active = frame >= p.from && frame < p.to;
        const done = frame >= p.to;
        return (
          <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: 6,
                background: active ? ACCENT : done ? 'rgba(103,232,195,0.45)' : 'rgba(255,255,255,0.16)',
                boxShadow: active ? `0 0 14px ${ACCENT}` : 'none',
              }}
            />
            <span
              style={{
                fontFamily: MONO,
                fontSize: 19,
                letterSpacing: '0.22em',
                color: active ? INK : done ? 'rgba(244,246,251,0.5)' : 'rgba(244,246,251,0.24)',
              }}
            >
              {p.name}
            </span>
          </div>
        );
      })}
    </div>
  );
};

const SessionLine: React.FC<{ line: Line; index: number }> = ({ line }) => {
  const frame = useCurrentFrame();
  if (frame < line.at) return null;

  const opacity = interpolate(frame, [line.at, line.at + 10], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const y = interpolate(frame, [line.at, line.at + 18], [12, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const blur = interpolate(frame, [line.at, line.at + 18], [7, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // type the body on, character by character
  const typedCount = Math.floor(Math.max(0, frame - line.at - 6) * 1.9);
  const shown = line.text.slice(0, typedCount);
  const typing = typedCount < line.text.length;

  const glow = line.label === 'verified' ? `0 0 34px rgba(103,232,195,0.55)` : 'none';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 26,
        opacity,
        transform: `translateY(${y}px)`,
        filter: `blur(${blur}px)`,
        marginBottom: 26,
      }}
    >
      <span
        style={{
          fontFamily: MONO,
          fontSize: 26,
          width: 150,
          textAlign: 'right',
          color: line.kind === 'ok' ? ACCENT : line.kind === 'warn' ? AMBER : 'rgba(244,246,251,0.3)',
          letterSpacing: '0.04em',
          flex: 'none',
        }}
      >
        {line.label}
      </span>
      <span
        style={{
          fontFamily: MONO,
          fontSize: 34,
          color: COLORS[line.kind],
          letterSpacing: '-0.01em',
          textShadow: glow,
        }}
      >
        {shown}
        {typing ? (
          <span style={{ color: ACCENT, opacity: Math.floor(frame / 8) % 2 ? 1 : 0.25 }}>▍</span>
        ) : null}
        {line.kind === 'ok' && !typing ? <span style={{ color: ACCENT }}>{'  ✓'}</span> : null}
      </span>
    </div>
  );
};

export const AgentSession: React.FC = () => {
  const frame = useCurrentFrame();

  const headOpacity = interpolate(frame, [8, 30], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  // gentle fade at the tail so the loop rejoins cleanly
  const tail = interpolate(frame, [SESSION_DURATION - 26, SESSION_DURATION], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ backgroundColor: BG, opacity: tail }}>
      <Aurora palette={PALETTES.session} />
      <AbsoluteFill
        style={{
          justifyContent: 'center',
          alignItems: 'flex-start',
          padding: '0 190px',
        }}
      >
        <div
          style={{
            fontFamily: MONO,
            fontSize: 19,
            letterSpacing: '0.3em',
            color: 'rgba(244,246,251,0.34)',
            marginBottom: 34,
            opacity: headOpacity,
          }}
        >
          SPLICE · LIVE SESSION
        </div>

        <PhaseRail />

        <div>
          {LINES.map((line, i) => (
            <SessionLine key={line.label + i} line={line} index={i} />
          ))}
        </div>

        <div
          style={{
            fontFamily: SANS,
            fontSize: 30,
            fontWeight: 500,
            color: 'rgba(244,246,251,0.5)',
            marginTop: 34,
            opacity: interpolate(frame, [352, 380], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          }}
        >
          The agent never guessed. It checked.
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
