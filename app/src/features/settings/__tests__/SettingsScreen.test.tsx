import { render, screen, userEvent } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { ApiProvider } from '@/api/ApiProvider';
import { ApiError } from '@/api/errors';
import { makeTask } from '@/api/fixtures';
import { createMockApi, type MockApiClient } from '@/api/mock';
import { localIsoDate } from '@/lib/dates';
import appConfig from '../../../../app.json';
import { SettingsScreen } from '../SettingsScreen';
import { DELETE_COPY, EMPTY_DROPPED_TEXT, RESTORED_MESSAGE, TIMES_FOOTNOTE, TIME_SAVE_ERROR } from '../logic';

let mockScheme: 'light' | 'dark' = 'light';
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => mockScheme,
}));

// The native time picker can't run in Jest: a stand-in button that "picks" the time in mockPick.
const mockPick = { hour: 7, minute: 45 };
jest.mock('@react-native-community/datetimepicker', () => {
  // A jest.mock factory can't use the file's imports.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pressable, Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ accessibilityLabel, value, onChange }: { accessibilityLabel: string; value: Date; onChange: (e: { type: string }, d?: Date) => void }) => (
      <Pressable
        role="button"
        aria-label={accessibilityLabel}
        onPress={() => {
          const d = new Date(value);
          d.setHours(mockPick.hour, mockPick.minute, 0, 0);
          onChange({ type: 'set' }, d);
        }}
      >
        <Text>{`${value.getHours()}:${value.getMinutes()}`}</Text>
      </Pressable>
    ),
  };
});

const TODAY = localIsoDate();
const droppedTask = (id: string, title: string) => makeTask({ id, title, kind: 'quick' }, TODAY);

function user() {
  return userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
}

interface Setup {
  api: MockApiClient;
  onAccountDeleted: jest.Mock;
  credentialSource: jest.Mock;
  shareExport: jest.Mock;
}

async function renderSettings(opts: { dropped?: string[]; shared?: boolean } = {}): Promise<Setup> {
  const titles = opts.dropped ?? [];
  const api = createMockApi({
    tasks: titles.map((t, i) => droppedTask(`d${i + 1}`, t)),
    today: () => TODAY,
  });
  for (let i = 0; i < titles.length; i += 1) await api.dropTask(`d${i + 1}`);
  const onAccountDeleted = jest.fn();
  const credentialSource = jest.fn(async () => ({
    identityToken: 'synthetic-token',
    rawNonce: 'synthetic-nonce',
    authorizationCode: 'synthetic-code' as string | null,
  }));
  const shareExport = jest.fn(async (_json: string) => opts.shared ?? true);
  await render(
    <ApiProvider client={api}>
      <SettingsScreen onAccountDeleted={onAccountDeleted} credentialSource={credentialSource} shareExport={shareExport} />
    </ApiProvider>,
  );
  await screen.findByLabelText('Morning brief time');
  return { api, onAccountDeleted, credentialSource, shareExport };
}

describe('Settings (US-11)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockScheme = 'light';
    mockPick.hour = 7;
    mockPick.minute = 45;
    jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(false);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('times', () => {
    it('shows both times from the profile and the footnote about notifications', async () => {
      await renderSettings();
      expect(screen.getByLabelText('Morning brief time')).toHaveTextContent('8:0');
      expect(screen.getByLabelText('Evening check-in time')).toHaveTextContent('20:30');
      expect(screen.getByText(TIMES_FOOTNOTE)).toBeOnTheScreen();
    });

    it('saves a new morning time at once, sending only that field', async () => {
      const { api } = await renderSettings();
      const spy = jest.spyOn(api, 'updateProfileTimes');
      await user().press(screen.getByLabelText('Morning brief time'));
      expect(screen.getByLabelText('Morning brief time')).toHaveTextContent('7:45');
      expect(spy).toHaveBeenCalledWith({ briefTime: '07:45' });
      expect(await api.getProfile()).toMatchObject({ briefTime: '07:45', checkinTime: '20:30' });
      expect(screen.queryByText(TIME_SAVE_ERROR)).not.toBeOnTheScreen();
    });

    it('saves the evening time as HH:MM', async () => {
      const { api } = await renderSettings();
      mockPick.hour = 21;
      mockPick.minute = 5;
      await user().press(screen.getByLabelText('Evening check-in time'));
      expect(await api.getProfile()).toMatchObject({ briefTime: '08:00', checkinTime: '21:05' });
    });

    it('puts the old time back with an inline error when the save fails', async () => {
      const { api } = await renderSettings();
      jest.spyOn(api, 'updateProfileTimes').mockRejectedValue(new ApiError('network_error', 'offline'));
      await user().press(screen.getByLabelText('Morning brief time'));
      expect(await screen.findByText(TIME_SAVE_ERROR)).toBeOnTheScreen();
      expect(screen.getByLabelText('Morning brief time')).toHaveTextContent('8:0');
      expect((await api.getProfile()).briefTime).toBe('08:00');
    });

    it('offers a retry when the profile can\'t be loaded', async () => {
      const api = createMockApi({ tasks: [], today: () => TODAY });
      jest.spyOn(api, 'getProfile').mockRejectedValueOnce(new ApiError('network_error', 'offline'));
      await render(
        <ApiProvider client={api}>
          <SettingsScreen onAccountDeleted={jest.fn()} />
        </ApiProvider>,
      );
      await user().press(await screen.findByRole('button', { name: 'Try again' }));
      expect(await screen.findByLabelText('Morning brief time')).toBeOnTheScreen();
    });
  });

  describe('Recently dropped (US-09)', () => {
    it('says so when nothing was dropped', async () => {
      await renderSettings();
      expect(await screen.findByText(EMPTY_DROPPED_TEXT)).toBeOnTheScreen();
      expect(EMPTY_DROPPED_TEXT).toBe('Nothing dropped in the last 30 days.');
    });

    it('lists dropped tasks, and Restore reopens one, removes the row and confirms', async () => {
      const { api } = await renderSettings({ dropped: ['Mail the form', 'Water the plants'] });
      const undo = jest.spyOn(api, 'undoTask');
      expect(await screen.findByText('Mail the form')).toBeOnTheScreen();
      expect(screen.getByText('Water the plants')).toBeOnTheScreen();
      await user().press(screen.getByRole('button', { name: 'Restore Mail the form' }));
      expect(undo).toHaveBeenCalledWith('d1');
      expect(screen.queryByText('Mail the form')).not.toBeOnTheScreen();
      expect(screen.getByText('Water the plants')).toBeOnTheScreen();
      expect(screen.getByText(RESTORED_MESSAGE)).toBeOnTheScreen();
      expect(api.snapshot().find((t) => t.id === 'd1')?.status).toBe('open');
    });

    it('keeps the row and says so when a restore fails', async () => {
      const { api } = await renderSettings({ dropped: ['Mail the form'] });
      jest.spyOn(api, 'undoTask').mockRejectedValue(new ApiError('network_error', 'offline'));
      await user().press(await screen.findByRole('button', { name: 'Restore Mail the form' }));
      expect(await screen.findByText("Couldn't restore that. Try again.")).toBeOnTheScreen();
      expect(screen.getByText('Mail the form')).toBeOnTheScreen();
    });
  });

  describe('Export my data', () => {
    it('signs in with Apple first, then shares the JSON, and says nothing about its contents', async () => {
      const { api, credentialSource, shareExport } = await renderSettings({ dropped: ['Mail the form'] });
      const signIn = jest.spyOn(api, 'signInWithApple');
      const order: string[] = [];
      signIn.mockImplementation(async (...args) => {
        order.push('signIn');
        return { access_token: 'x', user_id: 'u', expires_at: 0, ...(args.length ? {} : {}) };
      });
      jest.spyOn(api, 'exportData').mockImplementation(async () => {
        order.push('export');
        return { tasks: [{ title: 'Synthetic' }] };
      });
      await user().press(screen.getByRole('button', { name: 'Export my data' }));
      expect(credentialSource).toHaveBeenCalledTimes(1);
      expect(signIn).toHaveBeenCalledWith('synthetic-token', 'synthetic-nonce');
      expect(order).toEqual(['signIn', 'export']);
      expect(shareExport).toHaveBeenCalledTimes(1);
      expect(JSON.parse(shareExport.mock.calls[0]![0] as string)).toEqual({ tasks: [{ title: 'Synthetic' }] });
      expect(await screen.findByRole('status')).toHaveTextContent(/ready to save or share/);
    });

    it('does not claim success when the share sheet was dismissed', async () => {
      await renderSettings({ shared: false });
      await user().press(screen.getByRole('button', { name: 'Export my data' }));
      expect(screen.queryByText(/ready to save or share/)).not.toBeOnTheScreen();
      expect(screen.queryByRole('alert')).not.toBeOnTheScreen();
    });

    it('says Sign in with Apple isn\'t set up yet when sign-in is unauthenticated, and exports nothing', async () => {
      const { api, shareExport } = await renderSettings();
      jest.spyOn(api, 'signInWithApple').mockRejectedValue(new ApiError('unauthenticated', 'Sign in failed', 401));
      const exportSpy = jest.spyOn(api, 'exportData');
      await user().press(screen.getByRole('button', { name: 'Export my data' }));
      expect(await screen.findByText("Sign in with Apple isn't set up yet.")).toBeOnTheScreen();
      expect(exportSpy).not.toHaveBeenCalled();
      expect(shareExport).not.toHaveBeenCalled();
    });

    it('handles the server\'s freshness error (reauth_required) without sharing anything', async () => {
      const { api, shareExport } = await renderSettings();
      jest.spyOn(api, 'exportData').mockRejectedValue(new ApiError('reauth_required', 'stale', 403));
      await user().press(screen.getByRole('button', { name: 'Export my data' }));
      expect(await screen.findByText(/sign in with Apple again/)).toBeOnTheScreen();
      expect(shareExport).not.toHaveBeenCalled();
    });

    it('stays quiet if the person cancels the Apple sheet', async () => {
      const { credentialSource } = await renderSettings();
      credentialSource.mockRejectedValueOnce(new ApiError('canceled', 'Cancelled'));
      await user().press(screen.getByRole('button', { name: 'Export my data' }));
      expect(screen.queryByRole('alert')).not.toBeOnTheScreen();
    });
  });

  describe('Delete account', () => {
    it('asks first, in plain words, and Cancel changes nothing', async () => {
      const { api, credentialSource, onAccountDeleted } = await renderSettings();
      const del = jest.spyOn(api, 'deleteAccount');
      await user().press(screen.getByRole('button', { name: 'Delete account' }));
      expect(screen.getByText(DELETE_COPY)).toBeOnTheScreen();
      expect(DELETE_COPY).toBe('This deletes your account, all tasks and notes. It can’t be undone.');
      await user().press(screen.getByRole('button', { name: 'Cancel' }));
      expect(del).not.toHaveBeenCalled();
      expect(credentialSource).not.toHaveBeenCalled();
      expect(onAccountDeleted).not.toHaveBeenCalled();
    });

    it('signs in with Apple, deletes, then hands over to leave the screen', async () => {
      const { api, credentialSource, onAccountDeleted } = await renderSettings();
      const order: string[] = [];
      jest.spyOn(api, 'signInWithApple').mockImplementation(async () => {
        order.push('signIn');
        return { access_token: 'x', user_id: 'u', expires_at: 0 };
      });
      const del = jest.spyOn(api, 'deleteAccount').mockImplementation(async () => {
        order.push('delete');
      });
      await user().press(screen.getByRole('button', { name: 'Delete account' }));
      // Two buttons now carry the label: the one on the screen and the one in the sheet.
      const buttons = screen.getAllByRole('button', { name: 'Delete account' });
      await user().press(buttons[buttons.length - 1]!);
      expect(credentialSource).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['signIn', 'delete']);
      // The code comes from the same credential, with no extra step for the person.
      expect(del).toHaveBeenCalledWith('synthetic-code');
      expect(onAccountDeleted).toHaveBeenCalledTimes(1);
    });

    it('without an authorization code it says sign-in isn\'t set up and deletes nothing', async () => {
      const { api, credentialSource, onAccountDeleted } = await renderSettings();
      credentialSource.mockResolvedValueOnce({ identityToken: 't', rawNonce: 'n', authorizationCode: null });
      const del = jest.spyOn(api, 'deleteAccount');
      await user().press(screen.getByRole('button', { name: 'Delete account' }));
      const buttons = screen.getAllByRole('button', { name: 'Delete account' });
      await user().press(buttons[buttons.length - 1]!);
      expect(await screen.findByText("Sign in with Apple isn't set up yet.")).toBeOnTheScreen();
      expect(del).not.toHaveBeenCalled();
      expect(onAccountDeleted).not.toHaveBeenCalled();
    });

    it('apple_code_invalid asks to sign in again, keeps the account, and a retry can succeed', async () => {
      const { api, credentialSource, onAccountDeleted } = await renderSettings();
      const del = jest
        .spyOn(api, 'deleteAccount')
        .mockRejectedValueOnce(new ApiError('apple_code_invalid', 'Sign in with Apple again', 400));
      await user().press(screen.getByRole('button', { name: 'Delete account' }));
      let buttons = screen.getAllByRole('button', { name: 'Delete account' });
      await user().press(buttons[buttons.length - 1]!);
      expect(await screen.findByText('Sign in with Apple again to delete your account.')).toBeOnTheScreen();
      expect(onAccountDeleted).not.toHaveBeenCalled();

      credentialSource.mockResolvedValueOnce({ identityToken: 't2', rawNonce: 'n2', authorizationCode: 'fresh-code' });
      await user().press(screen.getByRole('button', { name: 'Delete account' }));
      buttons = screen.getAllByRole('button', { name: 'Delete account' });
      await user().press(buttons[buttons.length - 1]!);
      expect(del).toHaveBeenLastCalledWith('fresh-code');
      expect(onAccountDeleted).toHaveBeenCalledTimes(1);
    });

    it('does not leave the screen when the server says the sign-in is too old', async () => {
      const { api, onAccountDeleted } = await renderSettings();
      jest.spyOn(api, 'deleteAccount').mockRejectedValue(new ApiError('reauth_required', 'stale', 403));
      await user().press(screen.getByRole('button', { name: 'Delete account' }));
      const buttons = screen.getAllByRole('button', { name: 'Delete account' });
      await user().press(buttons[buttons.length - 1]!);
      expect(await screen.findByText(/sign in with Apple again/)).toBeOnTheScreen();
      expect(onAccountDeleted).not.toHaveBeenCalled();
    });

    it('says Sign in with Apple isn\'t set up yet, and deletes nothing', async () => {
      const { api, onAccountDeleted } = await renderSettings();
      jest.spyOn(api, 'signInWithApple').mockRejectedValue(new ApiError('unauthenticated', 'Sign in failed', 401));
      const del = jest.spyOn(api, 'deleteAccount');
      await user().press(screen.getByRole('button', { name: 'Delete account' }));
      const buttons = screen.getAllByRole('button', { name: 'Delete account' });
      await user().press(buttons[buttons.length - 1]!);
      expect(await screen.findByText("Sign in with Apple isn't set up yet.")).toBeOnTheScreen();
      expect(del).not.toHaveBeenCalled();
      expect(onAccountDeleted).not.toHaveBeenCalled();
    });

    it('with the mock backend the whole flow works and empties the account', async () => {
      const { api, onAccountDeleted } = await renderSettings({ dropped: ['Mail the form'] });
      await user().press(screen.getByRole('button', { name: 'Delete account' }));
      const buttons = screen.getAllByRole('button', { name: 'Delete account' });
      await user().press(buttons[buttons.length - 1]!);
      expect(onAccountDeleted).toHaveBeenCalledTimes(1);
      expect(api.snapshot()).toEqual([]);
    });
  });

  describe('About and accessibility', () => {
    it('shows the version from app.json', async () => {
      await renderSettings();
      expect(screen.getByText(`Version ${appConfig.expo.version}`)).toBeOnTheScreen();
    });

    it('labels every control and keeps 44pt targets', async () => {
      await renderSettings({ dropped: ['Mail the form'] });
      for (const name of ['Export my data', 'Delete account', 'Restore Mail the form']) {
        const el = screen.getByRole('button', { name });
        const flat = Object.assign({}, ...[el.props.style].flat(2).filter(Boolean)) as { minHeight?: number };
        expect(flat.minHeight ?? 0).toBeGreaterThanOrEqual(44);
      }
      expect(screen.getByLabelText('Morning brief time')).toBeOnTheScreen();
      expect(screen.getByLabelText('Evening check-in time')).toBeOnTheScreen();
      expect(screen.getAllByRole('heading').map((h) => h.props.children)).toEqual(['TIMES', 'RECENTLY DROPPED', 'YOUR DATA', 'ABOUT']);
    });

    it('renders in dark mode with the dark palette', async () => {
      mockScheme = 'dark';
      await renderSettings();
      expect(screen.getByText('Version ' + appConfig.expo.version)).toBeOnTheScreen();
      expect(screen.getByText('TIMES').props.style).toEqual(expect.arrayContaining([expect.objectContaining({ color: '#AEAEB2' })]));
    });
  });
});

