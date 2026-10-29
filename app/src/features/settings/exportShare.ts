import { File, Paths } from 'expo-file-system';
import { Share } from 'react-native';

import { localIsoDate } from '@/lib/dates';
import { exportFileName } from './logic';

/** Hands the export JSON to the iOS share sheet. Resolves true if the person shared or saved it. */
export type ExportSharer = (json: string) => Promise<boolean>;

/**
 * Writes the JSON to a file in the app's cache, opens the system share sheet on it, and deletes
 * the file again whatever happens. The contents are never logged. The file is only on disk while
 * the sheet is open.
 */
export const shareExportFile: ExportSharer = async (json) => {
  const file = new File(Paths.cache, exportFileName(localIsoDate()));
  try {
    if (file.exists) file.delete();
    file.create();
    file.write(json);
    const result = await Share.share({ url: file.uri });
    return result.action === Share.sharedAction;
  } finally {
    try {
      if (file.exists) file.delete();
    } catch {
      // The cache is cleared by the system; nothing more to do.
    }
  }
};
