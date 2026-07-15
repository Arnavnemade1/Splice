import { Composition } from 'remotion';
import { AgentSession, SESSION_DURATION } from './AgentSession';
import { TheLie, LIE_DURATION } from './TheLie';
import { DoctorHandshake, DOCTOR_DURATION } from './DoctorHandshake';

/* One film per page — each makes its own argument. */
export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* index.html — the page lied, Splice checked */}
      <Composition
        id="TheLie"
        component={TheLie}
        durationInFrames={LIE_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      {/* how.html — the full loop, start to finish */}
      <Composition
        id="AgentSession"
        component={AgentSession}
        durationInFrames={SESSION_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
      {/* agents.html — the machine-checkable finish line */}
      <Composition
        id="DoctorHandshake"
        component={DoctorHandshake}
        durationInFrames={DOCTOR_DURATION}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
