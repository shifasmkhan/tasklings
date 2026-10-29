import { Share } from 'react-native';

import { shareExportFile } from '../exportShare';

const mockFile = { exists: false, uri: 'file:///cache/tasklings-export.json', create: jest.fn(), write: jest.fn(), delete: jest.fn() };
const mockCtor = jest.fn();
jest.mock('expo-file-system', () => ({
  Paths: { cache: 'cache-dir' },
  File: function File(...args: unknown[]) {
    mockCtor(...args);
    return mockFile;
  },
}));

describe('shareExportFile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFile.exists = false;
    mockFile.create.mockImplementation(() => {
      mockFile.exists = true;
    });
    mockFile.delete.mockImplementation(() => {
      mockFile.exists = false;
    });
  });

  it('writes the JSON to a dated file in the cache, shares that file, then deletes it', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction, activityType: undefined });
    await expect(shareExportFile('{"tasks":[]}')).resolves.toBe(true);
    expect(mockCtor).toHaveBeenCalledWith('cache-dir', expect.stringMatching(/^tasklings-export-\d{4}-\d{2}-\d{2}\.json$/));
    expect(mockFile.write).toHaveBeenCalledWith('{"tasks":[]}');
    expect(share).toHaveBeenCalledWith({ url: mockFile.uri });
    expect(mockFile.exists).toBe(false);
  });

  it('reports a dismissed sheet as not shared, and still deletes the file', async () => {
    jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.dismissedAction, activityType: undefined });
    await expect(shareExportFile('{}')).resolves.toBe(false);
    expect(mockFile.delete).toHaveBeenCalled();
  });

  it('deletes the file even if sharing throws', async () => {
    jest.spyOn(Share, 'share').mockRejectedValue(new Error('boom'));
    await expect(shareExportFile('{}')).rejects.toThrow('boom');
    expect(mockFile.exists).toBe(false);
  });
});
