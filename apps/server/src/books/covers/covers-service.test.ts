import { Book } from '@koinsight/common/types';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { appConfig } from '../../config';
import { OpenLibraryService } from '../../open-library/open-library-service';
import { CoversService } from './covers-service';

const makeBook = (md5: string): Book => ({
  id: 1,
  md5,
  title: 'The Black Prism',
  authors: 'Brent Weeks',
  series: '',
  language: 'en',
  soft_deleted: false,
  reference_pages: null,
});

describe('CoversService.getOrFetch', () => {
  const originalCoversPath = appConfig.coversPath;
  const originalAutoFetch = appConfig.autoFetchCovers;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'koinsight-covers-'));
    appConfig.coversPath = path.join(tmpDir, 'covers');
    appConfig.autoFetchCovers = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    appConfig.coversPath = originalCoversPath;
    appConfig.autoFetchCovers = originalAutoFetch;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fetches and saves a cover from Open Library when none exists', async () => {
    const book = makeBook('md5-fetch');
    const findSpy = vi.spyOn(OpenLibraryService, 'findCoverId').mockResolvedValue(123);
    const fetchSpy = vi
      .spyOn(OpenLibraryService, 'fetchCover')
      .mockResolvedValue(new TextEncoder().encode('image').buffer as ArrayBuffer);

    const coverPath = await CoversService.getOrFetch(book);

    expect(findSpy).toHaveBeenCalledWith('The Black Prism', 'Brent Weeks');
    expect(fetchSpy).toHaveBeenCalledWith('123', 'L');
    expect(coverPath).toBe(path.join(appConfig.coversPath, 'md5-fetch.jpg'));
    expect(readFileSync(coverPath!, 'utf8')).toBe('image');
  });

  it('returns the existing cover without calling Open Library', async () => {
    const book = makeBook('md5-existing');
    await CoversService.save(book, Buffer.from('existing'));
    const findSpy = vi.spyOn(OpenLibraryService, 'findCoverId');

    const coverPath = await CoversService.getOrFetch(book);

    expect(findSpy).not.toHaveBeenCalled();
    expect(coverPath).toBe(path.join(appConfig.coversPath, 'md5-existing.jpg'));
  });

  it('only attempts to auto-fetch once per book', async () => {
    const book = makeBook('md5-missing');
    const findSpy = vi.spyOn(OpenLibraryService, 'findCoverId').mockResolvedValue(null);

    const results = await Promise.all([
      CoversService.getOrFetch(book),
      CoversService.getOrFetch(book),
    ]);
    await CoversService.getOrFetch(book);

    expect(results).toEqual([null, null]);
    expect(findSpy).toHaveBeenCalledTimes(1);
  });

  it('returns null when Open Library errors', async () => {
    const book = makeBook('md5-error');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(OpenLibraryService, 'findCoverId').mockRejectedValue(new Error('network'));

    expect(await CoversService.getOrFetch(book)).toBeNull();
  });

  it('does not auto-fetch when disabled', async () => {
    appConfig.autoFetchCovers = false;
    const book = makeBook('md5-disabled');
    const findSpy = vi.spyOn(OpenLibraryService, 'findCoverId');

    expect(await CoversService.getOrFetch(book)).toBeNull();
    expect(findSpy).not.toHaveBeenCalled();
  });
});
