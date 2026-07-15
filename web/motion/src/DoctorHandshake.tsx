import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Aurora } from './Aurora';
import { ACCENT, BG, FAINT, INK, MONO, PALETTES, SANS } from './theme';

export const DOCTOR_DURATION = 400;

/* The value of "healthy" resolves only after every check has landed. */
const RESOLVE_AT = 300;

const KEY = '#7dd3fc';
const STR = 'rgba(244,246,251,0.62)';
const PUNCT = 'rgba(244,246,251,0.3)';

const CHECKS = [
  { at: 160, name: 'node' },
  { at: 192, name: 'build' },
  { at: 224, name: 'browser' },
  { at: 256, name: 'mcp' },
];

const Appear: React.FC<{ at: number; children: React.ReactNode; indent?: number }> = ({
  at,
  children,
  indent = 0,
}) => {
  const frame = useCurrentFrame();
  if (frame < at) return null;
  const o = interpolate(frame, [at, at + 9], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const y = interpolate(frame, [at, at + 14], [8, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div
      style={{
        opacity: o,
        transform: `translateY(${y}px)`,
        paddingLeft: indent,
        fontFamily: MONO,
        fontSize: 32,
        lineHeight: 1.62,
        whiteSpace: 'pre',
      }}
    >
      {children}
    </div>
  );
};

export const DoctorHandshake: React.FC = () => {
  const frame = useCurrentFrame();

  const tail = interpolate(frame, [DOCTOR_DURATION - 26, DOCTOR_DURATION], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // the command types itself
  const cmd = '$ node dist/cli.js doctor --json';
  const typed = cmd.slice(0, Math.floor(Math.max(0, frame - 14) * 1.7));
  const cmdTyping = typed.length < cmd.length;

  const resolved = frame >= RESOLVE_AT;
  const glow = interpolate(frame, [RESOLVE_AT, RESOLVE_AT + 18], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const closing = interpolate(frame, [340, 366], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ backgroundColor: BG, opacity: tail }}>
      <Aurora palette={PALETTES.doctor} />
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'flex-start', padding: '0 200px' }}>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 19,
            letterSpacing: '0.3em',
            color: FAINT,
            marginBottom: 40,
          }}
        >
          THE FINISH LINE
        </div>

        <div style={{ fontFamily: MONO, fontSize: 32, color: INK, marginBottom: 30 }}>
          {typed}
          {cmdTyping ? (
            <span style={{ color: ACCENT, opacity: Math.floor(frame / 8) % 2 ? 1 : 0.25 }}>▍</span>
          ) : null}
        </div>

        <Appear at={92}>
          <span style={{ color: PUNCT }}>{'{'}</span>
        </Appear>

        <Appear at={106} indent={44}>
          <span style={{ color: KEY }}>"version"</span>
          <span style={{ color: PUNCT }}>: </span>
          <span style={{ color: STR }}>"2.3.0"</span>
          <span style={{ color: PUNCT }}>,</span>
        </Appear>

        {/* healthy is printed early but its value waits for the checks */}
        <Appear at={124} indent={44}>
          <span style={{ color: KEY }}>"healthy"</span>
          <span style={{ color: PUNCT }}>: </span>
          {resolved ? (
            <span
              style={{
                color: ACCENT,
                textShadow: `0 0 ${28 * glow}px rgba(103,232,195,${0.75 * glow})`,
              }}
            >
              true
            </span>
          ) : (
            <span style={{ color: ACCENT, opacity: Math.floor(frame / 7) % 2 ? 0.9 : 0.2 }}>▍</span>
          )}
          <span style={{ color: PUNCT }}>,</span>
        </Appear>

        <Appear at={142} indent={44}>
          <span style={{ color: KEY }}>"checks"</span>
          <span style={{ color: PUNCT }}>: [</span>
        </Appear>

        {CHECKS.map((c) => (
          <Appear key={c.name} at={c.at} indent={88}>
            <span style={{ color: PUNCT }}>{'{ '}</span>
            <span style={{ color: KEY }}>"name"</span>
            <span style={{ color: PUNCT }}>: </span>
            <span style={{ color: STR }}>{`"${c.name}"`.padEnd(11)}</span>
            <span style={{ color: PUNCT }}>, </span>
            <span style={{ color: KEY }}>"ok"</span>
            <span style={{ color: PUNCT }}>: </span>
            <span style={{ color: ACCENT }}>true</span>
            <span style={{ color: PUNCT }}>{' }'}</span>
          </Appear>
        ))}

        <Appear at={284} indent={44}>
          <span style={{ color: PUNCT }}>]</span>
        </Appear>
        <Appear at={292}>
          <span style={{ color: PUNCT }}>{'}'}</span>
        </Appear>

        <div
          style={{
            fontFamily: SANS,
            fontSize: 34,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            color: INK,
            marginTop: 44,
            opacity: closing,
          }}
        >
          Done when the doctor says so.
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
