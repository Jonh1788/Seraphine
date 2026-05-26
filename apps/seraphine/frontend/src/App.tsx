import { RefsProvider } from './stores/RefsContext';
import { AppBootstrap } from './AppBootstrap';
import { AppLayout } from './AppLayout';

export function App(): JSX.Element {
  return (
    <RefsProvider>
      <AppBootstrap />
      <AppLayout />
    </RefsProvider>
  );
}
