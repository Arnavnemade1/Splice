import { Composition } from 'remotion';
import { AgentSession, SESSION_DURATION } from './AgentSession';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="AgentSession"
      component={AgentSession}
      durationInFrames={SESSION_DURATION}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
