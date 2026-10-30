import { Request, Response, Router } from 'express';
import { authenticate } from '../kosync/kosync-authenticate-middleware';
import {
  READEST_DEFAULT_DEVICE_ID,
  ReadestMatchBook,
  ReadestPageStatsBook,
  ReadestService,
} from './readest-service';

/**
 * Router for Readest's "BookOrbit" integration, mounted at /api/v1/koreader/plugin.
 * Readest pushes its KOReader-compatible reading statistics here. Only the
 * endpoints needed for page stats are implemented; Readest skips features
 * whose capability is not advertised.
 */
const router = Router();

export const READEST_CAPABILITIES = ['pageStats'];

router.use(authenticate);

const isValidHash = (hash: unknown): hash is string =>
  typeof hash === 'string' && hash.length > 0 && hash.length <= 32;

router.get('/version', (_req: Request, res: Response) => {
  res.status(200).json({
    pluginVersion: 'koinsight',
    serverVersion: process.env.npm_package_version ?? 'unknown',
    capabilities: READEST_CAPABILITIES,
  });
});

router.post('/match-check', async (req: Request, res: Response) => {
  const books: ReadestMatchBook[] = Array.isArray(req.body?.books) ? req.body.books : [];
  const validBooks = books.filter((book) => isValidHash(book?.hash));

  try {
    const matched = await ReadestService.registerBooks(validBooks);
    res.status(200).json({
      matches: matched.map(({ id, md5 }) => ({ hash: md5, bookId: id, bookFileId: id })),
      libraryVersion: '1',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error registering books' });
  }
});

router.post('/page-stats', async (req: Request, res: Response) => {
  const books: ReadestPageStatsBook[] = Array.isArray(req.body?.books) ? req.body.books : [];
  if (books.some((book) => !isValidHash(book?.hash) || !Array.isArray(book.events))) {
    res.status(400).json({ message: 'Invalid page stats payload' });
    return;
  }

  const { deviceId, deviceModel } = req.body;
  const device = {
    id: typeof deviceId === 'string' && deviceId ? deviceId : READEST_DEFAULT_DEVICE_ID,
    model: typeof deviceModel === 'string' && deviceModel ? deviceModel : 'Readest',
  };

  try {
    const imported = await ReadestService.importPageStats(device, books);
    res.status(200).json({ imported });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error importing page stats' });
  }
});

export { router as readestRouter };
