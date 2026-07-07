import { google } from 'googleapis';
import { Readable } from 'stream';

const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive'];

function buildOAuthClient() {
  const clientId     = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret  = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri  = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI must be set.');
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/** Builds the one-time Google consent URL — visit /api/drive/oauth/start to be redirected here. */
export function getGoogleDriveAuthUrl(): string {
  return buildOAuthClient().generateAuthUrl({
    access_type: 'offline', // required to receive a refresh_token
    prompt: 'consent',      // forces a refresh_token even on repeat consents
    scope: DRIVE_SCOPES,
  });
}

/** Exchanges the ?code Google redirects back with for a refresh/access token pair. */
export async function exchangeGoogleDriveAuthCode(code: string): Promise<{ refresh_token?: string | null; access_token?: string | null }> {
  const { tokens } = await buildOAuthClient().getToken(code);
  return tokens;
}

/**
 * Uploads weight-confirmation photos to Google Drive under:
 *   <root> / <batch_id> / <shipment_id> / (photos)
 *
 * Authenticates via a standard OAuth2 client + long-lived refresh token
 * (GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN) — a dedicated one, separate from any
 * other project's OAuth client. Uploaded files count against the quota of
 * whichever account granted consent, so no folder-sharing workaround is needed.
 *
 * One-time setup: visit GET /api/drive/oauth/start, complete the Google
 * consent screen, then copy the refresh token it logs/displays into
 * GOOGLE_DRIVE_REFRESH_TOKEN.
 */
export class GoogleDriveService {
  private drive: ReturnType<typeof google.drive> | null = null;
  private rootFolderId: string | null;
  private rootFolderIdPromise: Promise<string> | null = null;
  private batchFolderIdPromises = new Map<string, Promise<string>>();

  constructor() {
    this.rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim() || null;

    const clientId     = process.env.GOOGLE_CLIENT_ID?.trim();
    const clientSecret  = process.env.GOOGLE_CLIENT_SECRET?.trim();
    const redirectUri  = process.env.GOOGLE_REDIRECT_URI?.trim();
    const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN?.trim();

    if (!clientId || !clientSecret || !refreshToken) {
      console.warn('[GoogleDriveService] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_DRIVE_REFRESH_TOKEN not configured — Drive uploads disabled. Visit /api/drive/oauth/start once to mint a refresh token.');
      return;
    }

    try {
      const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
      oauth2Client.setCredentials({ refresh_token: refreshToken });
      this.drive = google.drive({ version: 'v3', auth: oauth2Client });
    } catch (err) {
      console.error('[GoogleDriveService] Failed to initialize OAuth2 client:', err);
    }
  }

  private isConfigured(): boolean {
    return !!this.drive;
  }

  private async findChildFolder(parentId: string, name: string): Promise<string | null> {
    const res = await this.drive!.files.list({
      q: `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)',
      spaces: 'drive',
    });
    return res.data.files?.[0]?.id || null;
  }

  private async createChildFolder(parentId: string, name: string): Promise<string> {
    const res = await this.drive!.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      },
      fields: 'id',
    });
    if (!res.data.id) throw new Error('Drive did not return a folder id.');
    return res.data.id;
  }

  private async getOrCreateChildFolder(parentId: string, name: string): Promise<string> {
    const existing = await this.findChildFolder(parentId, name);
    if (existing) return existing;
    return this.createChildFolder(parentId, name);
  }

  /**
   * Resolves GOOGLE_DRIVE_ROOT_FOLDER_ID if set; otherwise finds-or-creates a
   * "Shipment Weight Photos" folder under the account's My Drive root and
   * logs its ID so it can be pinned via the env var afterwards.
   */
  private async getRootFolderId(): Promise<string> {
    if (this.rootFolderId) return this.rootFolderId;
    if (!this.rootFolderIdPromise) {
      this.rootFolderIdPromise = (async () => {
        const id = await this.getOrCreateChildFolder('root', 'Shipment Weight Photos');
        console.log(`[GoogleDriveService] Using auto-created/found root folder "Shipment Weight Photos" — pin it via GOOGLE_DRIVE_ROOT_FOLDER_ID=${id}`);
        return id;
      })();
    }
    return this.rootFolderIdPromise;
  }

  private async getBatchFolderId(batchId: string): Promise<string> {
    let promise = this.batchFolderIdPromises.get(batchId);
    if (!promise) {
      promise = (async () => {
        const rootId = await this.getRootFolderId();
        return this.getOrCreateChildFolder(rootId, batchId);
      })();
      this.batchFolderIdPromises.set(batchId, promise);
    }
    return promise;
  }

  /**
   * Ensures <root>/<batchId>/<shipmentId> exists and returns its id + a shareable link.
   */
  async getOrCreateShipmentFolder(batchId: string, shipmentId: string): Promise<{ folderId: string; folderLink: string }> {
    if (!this.isConfigured()) {
      throw new Error('Google Drive is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_DRIVE_REFRESH_TOKEN). Visit /api/drive/oauth/start once to set it up.');
    }
    const batchFolderId = await this.getBatchFolderId(batchId);
    const folderId = await this.getOrCreateChildFolder(batchFolderId, shipmentId);
    return { folderId, folderLink: `https://drive.google.com/drive/folders/${folderId}` };
  }

  /**
   * Uploads a single file into the given folder.
   */
  async uploadFile(folderId: string, filename: string, mimeType: string, buffer: Buffer): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error('Google Drive is not configured.');
    }
    await this.drive!.files.create({
      requestBody: { name: filename, parents: [folderId] },
      media: { mimeType, body: Readable.from(buffer) },
      fields: 'id',
    });
  }

  /**
   * Convenience: ensures the batch/shipment folder exists, uploads all given
   * photos into it, and returns the folder link for vendor_shipments.drive_link.
   */
  async uploadShipmentPhotos(
    batchId: string,
    shipmentId: string,
    files: Array<{ originalname: string; mimetype: string; buffer: Buffer }>
  ): Promise<string> {
    const { folderId, folderLink } = await this.getOrCreateShipmentFolder(batchId, shipmentId);
    for (const file of files) {
      await this.uploadFile(folderId, file.originalname, file.mimetype, file.buffer);
    }
    return folderLink;
  }
}
