import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Aurora } from './Aurora';
import { ACCENT, AMBER, BG, DIM, INK, MONO, PALETTES, ROSE, SANS } from './theme';

export const LIE_DURATION = 370;

const STRIKE_AT = 148;

type Row = {
  at: number;
  label: string;
  text: string;
  color: string;
  labelColor: string;
  strike?: boolean;
  glow?: boolean;
  tick?: boolean;
};

/* The whole argument of the home page, told in four lines. */
const ROWS: Row[] = [
  { at: 22, label: 'agent', text: 'click "Place order"', color: INK, labelColor: 'rgba(244,246,251,0.3)' },
  { at: 82, label: 'assumed', text: 'order placed', color: '#7bd7a8', labelColor: 'rgba(123,215,168,0.55)', strike: true, tick: true },
  { at: 156, label: 'actually', text: 'a modal swallowed the click', color: AMBER, labelColor: 'rgba(247,201,92,0.6)' },
  { at: 224, label: 'splice', text: 'verified · reached /thanks', color: ACCENT, labelColor: 'rgba(103,232,195,0.6)', glow: true, tick: true },
];

const Line: React.FC<{ row: Row }> = ({ row }) => {
  const frame = useCurrentFrame();
  if (frame < row.at) return null;

  const opacity = interpolate(frame, [row.at, row.at + 10], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const y = interpolate(frame, [row.at, row.at + 18], [12, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const blur = interpolate(frame, [row.at, row.at + 18], [8, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const typedCount = Math.floor(Math.max(0, frame - row.at - 5) * 1.9);
  const shown = row.text.slice(0, typedCount);
  const typing = typedCount < row.text.length;

  // the lie gets crossed out and drained of colour
  const strikeW = row.strike
    ? interpolate(frame, [STRIKE_AT, STRIKE_AT + 20], [0, 100], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : 0;
  const drain = row.strike
    ? interpolate(frame, [STRIKE_AT, STRIKE_AT + 24], [1, 0.32], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : 1;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 30,
        opacity: opacity * (row.strike ? drain : 1),
        transform: `translateY(${y}px)`,
        filter: `blur(${blur}px)`,
        marginBottom: 30,
      }}
    >
      <span
        style={{
          fontFamily: MONO,
          fontSize: 27,
          width: 160,
          textAlign: 'right',
          color: row.labelColor,
          flex: 'none',
        }}
      >
        {row.label}
      </span>
      <span style={{ position: 'relative' }}>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 40,
            color: row.color,
            letterSpacing: '-0.01em',
            textShadow: row.glow ? '0 0 38px rgba(103,232,195,0.5)' : 'none',
          }}
        >
          {shown}
          {typing ? (
            <span style={{ color: ACCENT, opacity: Math.floor(frame / 8) % 2 ? 1 : 0.25 }}>▍</span>
          ) : null}
          {row.tick && !typing ? <span>{'  ✓'}</span> : null}
        </span>
        {row.strike ? (
          <span
            style={{
              position: 'absolute',
              left: -4,
              top: '52%',
              height: 2,
              width: `${strikeW}%`,
              background: ROSE,
              boxShadow: `0 0 12px ${ROSE}`,
            }}
          />
        ) : null}
      </span>
    </div>
  );
};

export const TheLie: React.FC = () => {
  const frame = useCurrentFrame();
  const tail = interpolate(frame, [LIE_DURATION - 26, LIE_DURATION], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const kicker = interpolate(frame, [8, 28], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const closing = interpolate(frame, [290, 320], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ backgroundColor: BG, opacity: tail }}>
      <Aurora palette={PALETTES.lie} />
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'flex-start', padding: '0 200px' }}>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 19,
            letterSpacing: '0.3em',
            color: DIM,
            marginBottom: 54,
            opacity: kicker,
          }}
        >
          THE PROBLEM
        </div>

        {ROWS.map((r) => (
          <Line key={r.label} row={r} />
        ))}

        <div
          style={{
            fontFamily: SANS,
            fontSize: 34,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            color: INK,
            marginTop: 40,
            opacity: closing,
          }}
        >
          The page lied. Splice checked.
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
