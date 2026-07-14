import { RefsProvider } from './stores/RefsContext';
import { FocusProvider } from './focus/FocusContext';
import { AppBootstrap } from './AppBootstrap';
import { AppLayout } from './AppLayout';
import { PhoneShell } from './mobile/PhoneShell';

export function App(): JSX.Element {
  const isPhone = typeof document !== 'undefined'
    && document.documentElement.dataset.shell === 'phone';
  return (
    <RefsProvider>
      <FocusProvider>
        <AppBootstrap />
        {isPhone ? <PhoneShell /> : <AppLayout />}
      </FocusProvider>
    </RefsProvider>
  );
}
