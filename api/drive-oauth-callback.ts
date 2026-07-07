import type { VercelRequest, VercelResponse } from '@vercel/node';
import { exchangeGoogleDriveAuthCode } from './_lib/GoogleDriveService.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const code = (req.query.code as string) || '';
  if (!code) return res.status(400).send('Missing ?code from Google.');

  try {
    const tokens = await exchangeGoogleDriveAuthCode(code);
    console.log('[Google Drive OAuth] Refresh token:', tokens.refresh_token);
    res.setHeader('Content-Type', 'text/html');
    res.send(`
      <html><body style="font-family: sans-serif; padding: 2rem; max-width: 640px; margin: 0 auto;">
        <h2>Google Drive connected</h2>
        <p>Copy this into your Vercel project's env vars as <code>GOOGLE_DRIVE_REFRESH_TOKEN</code>, then redeploy:</p>
        <pre style="background:#eee;padding:1rem;border-radius:8px;word-break:break-all;user-select:all;">${tokens.refresh_token || '(No refresh token returned — you likely already granted consent before. Revoke access at https://myaccount.google.com/permissions for this app, then try again.)'}</pre>
      </body></html>
    `);
  } catch (err: any) {
    res.status(500).send(`OAuth exchange failed: ${err.message}`);
  }
}
