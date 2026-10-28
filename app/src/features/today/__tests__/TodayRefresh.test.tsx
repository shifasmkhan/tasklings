import { render, screen } from '@testing-library/react-native';

import { ApiProvider } from '@/api/ApiProvider';
import { makeTask } from '@/api/fixtures';
import { createMockApi } from '@/api/mock';
import { localIsoDate } from '@/lib/dates';
import { TodayScreen, type TodayNavigation } from '../TodayScreen';

// Swipe gestures can't run headlessly; Today's own tests cover them. Rows only need to render.
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const Swipeable = React.forwardRef(function Swipeable(props: { children: React.ReactNode }) {
    return <View>{props.children}</View>;
  });
  return { __esModule: true, default: Swipeable, SwipeDirection: { LEFT: 'left', RIGHT: 'right' } };
});

const TODAY = localIsoDate();
const nav: TodayNavigation = { openCapture: jest.fn(), openTask: jest.fn(), openCheckIn: jest.fn() };

describe('Today reloads when it comes back into focus (US-05)', () => {
  it('drops the Needs a look card once an edit in Task detail has cleared the flag', async () => {
    const api = createMockApi({
      today: () => TODAY,
      tasks: [makeTask({ id: 'r1', title: 'Whole note saved as one task', kind: 'quick', needs_review: true }, TODAY)],
    });
    const tree = (key: number) => (
      <ApiProvider client={api}>
        <TodayScreen nav={nav} refreshKey={key} />
      </ApiProvider>
    );
    const view = await render(tree(0));
    expect(await screen.findByText('We saved one note as a single task. Tap to fix.')).toBeOnTheScreen();

    // The edit happens on the detail screen; Today is behind it and unchanged until it refocuses.
    await api.updateTask('r1', { title: 'Buy stamps' });
    expect(screen.getByText('We saved one note as a single task. Tap to fix.')).toBeOnTheScreen();

    await view.rerender(tree(1));
    await screen.findByText('Buy stamps');
    expect(screen.queryByText('We saved one note as a single task. Tap to fix.')).not.toBeOnTheScreen();
  });
});
