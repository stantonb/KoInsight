import { Book } from '@koinsight/common/types';
import { existsSync, mkdirSync, promises, rename, rmSync } from 'fs';
import path from 'path';
import { appConfig } from '../../config';
import { OpenLibraryService } from '../../open-library/open-library-service';

export class CoversService {
  // Books we already tried to auto-fetch a cover for, so we don't hit Open Library on every request
  private static autoFetchAttempted = new Set<string>();
  private static autoFetchInFlight = new Map<string, Promise<string | null>>();

  static async get(book: Book): Promise<string | null> {
    if (!existsSync(appConfig.coversPath)) {
      return null;
    }

    const files = await promises.readdir(appConfig.coversPath);
    const file = files.find((f) => f.startsWith(book.md5));

    if (file) {
      return `${appConfig.coversPath}/${file}`;
    } else {
      return null;
    }
  }

  /**
   * Returns the book's cover, fetching one from Open Library if none exists yet.
   * Each book is only auto-fetched once per server run.
   */
  static async getOrFetch(book: Book): Promise<string | null> {
    const existing = await this.get(book);
    if (existing || !appConfig.autoFetchCovers || this.autoFetchAttempted.has(book.md5)) {
      return existing;
    }

    let inFlight = this.autoFetchInFlight.get(book.md5);
    if (!inFlight) {
      inFlight = this.fetchFromOpenLibrary(book).finally(() => {
        this.autoFetchAttempted.add(book.md5);
        this.autoFetchInFlight.delete(book.md5);
      });
      this.autoFetchInFlight.set(book.md5, inFlight);
    }

    return inFlight;
  }

  private static async fetchFromOpenLibrary(book: Book): Promise<string | null> {
    if (!book.title) {
      return null;
    }

    try {
      const coverId = await OpenLibraryService.findCoverId(book.title, book.authors);
      if (!coverId) {
        return null;
      }

      const cover = await OpenLibraryService.fetchCover(String(coverId), 'L');
      return await this.save(book, Buffer.from(cover));
    } catch (error) {
      console.error(`Error auto-fetching cover for ${book.title}:`, error);
      return null;
    }
  }

  static async save(book: Book, cover: Buffer): Promise<string> {
    if (!existsSync(appConfig.coversPath)) {
      mkdirSync(appConfig.coversPath, { recursive: true });
    }

    await this.deleteExisting(book);
    const filePath = `${appConfig.coversPath}/${book.md5}.jpg`;
    await promises.writeFile(filePath, cover);
    return filePath;
  }

  static async deleteExisting(book: Book) {
    if (!existsSync(appConfig.coversPath)) {
      return;
    }

    const files = await promises.readdir(appConfig.coversPath);
    const file = files.find((f) => f.startsWith(book.md5));

    if (file) {
      const filePath = `${appConfig.coversPath}/${file}`;
      rmSync(filePath, { force: true });
    }
  }

  static async upload(book: Book, file: Express.Multer.File) {
    if (!existsSync(appConfig.coversPath)) {
      mkdirSync(appConfig.coversPath, { recursive: true });
    }

    const extension = path.extname(file.originalname) || '';
    const newFilename = `${book.md5}${extension}`;
    const newPath = path.join(path.dirname(file.path), newFilename);
    await rename(file.path, newPath, () => {});
  }
}
