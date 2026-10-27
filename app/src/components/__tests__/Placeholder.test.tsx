import { render, screen, userEvent } from '@testing-library/react-native';

import { dark, light } from '@/theme/colors';
import { Placeholder } from '../Placeholder';

let mockScheme: 'light' | 'dark' = 'light';
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => mockScheme,
}));

// Capture, Task detail and Evening check-in are all this component until their stories land.
describe.each([
  ['light', light],
  ['dark', dark],
] as const)('Placeholder screen (%s)', (scheme, palette) => {
  beforeEach(() => {
    mockScheme = scheme;
  });

  it('uses the palette and has a labelled close control', async () => {
    const onClose = jest.fn();
    await render(<Placeholder title="Capture" story="US-01 · placeholder" body="Synthetic body" onClose={onClose} />);
    expect(screen.getByRole('heading', { name: 'Capture' })).toHaveStyle({ color: palette.text });
    await userEvent.press(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
