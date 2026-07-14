import { RefsProvider } from './stores/RefsContext';
import { FocusProvider } from './focus/FocusContext';
import { AppBootstrap } from './AppBootstrap';
import { AppLayout } from './AppLayout';
import { PhoneShell } from './mobile/PhoneShell';

const isPhone = typeof document !== 'undefined'
  && document.documentElement.dataset.shell === 'phone';

export function App(): JSX.Element {
  return (
    <RefsProvider>
      <FocusProvider>
        <AppBootstrap />
        {isPhone ? <PhoneShell /> : <AppLayout />}
      </FocusProvider>
    </RefsProvider>
  );
}
