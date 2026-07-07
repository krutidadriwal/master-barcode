import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getGoogleDriveAuthUrl } from './_lib/GoogleDriveService.js';

/**
 * One-time Google Drive OAuth setup — visit /api/drive/oauth/start, complete
 * the consent screen, then copy the refresh token from the callback page into
 * GOOGLE_DRIVE_REFRESH_TOKEN.
 */
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    res.redirect(getGoogleDriveAuthUrl());
  } catch (err: any) {
    res.status(500).send(err.message);
  }
}
