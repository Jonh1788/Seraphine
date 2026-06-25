import { RefsProvider } from './stores/RefsContext';
import { FocusProvider } from './focus/FocusContext';
import { AppBootstrap } from './AppBootstrap';
import { AppLayout } from './AppLayout';

export function App(): JSX.Element {
  return (
    <RefsProvider>
      <FocusProvider>
        <AppBootstrap />
        <AppLayout />
      </FocusProvider>
    </RefsProvider>
  );
}
