import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Palette } from './theme';

/* Procedural aurora — drifting light, drawn not filmed. */
export const Aurora: React.FC<{ palette: Palette }> = ({ palette }) => {
  const frame = useCurrentFrame();
  const blobs = [
    { c: palette.a, x: 30, y: 26, s: 980, ax: 130, ay: 60, sp: 0.0062 },
    { c: palette.b, x: 70, y: 36, s: 880, ax: -150, ay: 80, sp: 0.0081 },
    { c: palette.c, x: 50, y: 76, s: 1120, ax: 100, ay: -70, sp: 0.0049 },
  ];
  const rise = interpolate(frame, [0, 40], [1.12, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ transform: `scale(${rise})` }}>
      {blobs.map((b, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: `${b.x}%`,
            top: `${b.y}%`,
            width: b.s,
            height: b.s,
            marginLeft: -b.s / 2,
            marginTop: -b.s / 2,
            transform: `translate(${Math.sin(frame * b.sp + i) * b.ax}px, ${
              Math.cos(frame * b.sp * 0.8 + i) * b.ay
            }px)`,
            background: `radial-gradient(circle, ${b.c} 0%, transparent 66%)`,
            filter: 'blur(70px)',
          }}
        />
      ))}
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(120% 90% at 50% 45%, rgba(6,8,15,0) 35%, rgba(6,8,15,0.74) 100%)',
        }}
      />
    </AbsoluteFill>
  );
};
