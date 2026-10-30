import { Book, BookDevice, Device, PageStat } from '@koinsight/common/types';
import { Knex } from 'knex';
import { db } from '../knex';

export type ReadestMatchBook = {
  hash: string;
  title?: string;
  authors?: string;
};

export type ReadestPageStatsBook = {
  hash: string;
  events: {
    page: number;
    startTime: number;
    durationSeconds: number;
    totalPages: number;
  }[];
};

export const READEST_DEFAULT_DEVICE_ID = 'readest';

export class ReadestService {
  /**
   * Registers the books Readest reports, keyed by KOReader's partial MD5.
   * Titles already known (e.g. from a KOReader upload) are kept; only
   * placeholders created by a page-stats push before a match-check are filled.
   */
  static async registerBooks(books: ReadestMatchBook[]): Promise<Pick<Book, 'id' | 'md5'>[]> {
    await db.transaction(async (trx) => {
      for (const { hash, title, authors } of books) {
        await trx<Book>('book')
          .insert({ md5: hash, title: title || hash, authors: authors ?? '' })
          .onConflict('md5')
          .ignore();

        if (title) {
          await trx<Book>('book')
            .where({ md5: hash })
            .andWhere((qb) => qb.whereNull('title').orWhere('title', hash))
            .update({ title, authors: authors ?? '' });
        }
      }
    });

    return db<Book>('book')
      .whereIn(
        'md5',
        books.map((book) => book.hash)
      )
      .select('id', 'md5');
  }

  /**
   * Stores page-read events pushed by Readest. Readest may resend events after
   * an interrupted push, so rows are upserted on the page_stat unique key.
   */
  static async importPageStats(device: Device, books: ReadestPageStatsBook[]): Promise<number> {
    let imported = 0;
    await db.transaction(async (trx) => {
      await trx<Device>('device').insert(device).onConflict('id').ignore();

      for (const { hash, events } of books) {
        const pageStats: PageStat[] = events
          .filter(
            (e) =>
              Number.isFinite(e.page) &&
              Number.isFinite(e.startTime) &&
              e.startTime > 0 &&
              Number.isFinite(e.durationSeconds) &&
              e.durationSeconds > 0 &&
              Number.isFinite(e.totalPages) &&
              e.totalPages > 0
          )
          .map((e) => ({
            book_md5: hash,
            device_id: device.id,
            page: e.page,
            start_time: e.startTime,
            duration: e.durationSeconds,
            total_pages: e.totalPages,
          }));

        if (pageStats.length === 0) {
          continue;
        }

        // Placeholder until Readest's match-check supplies the title
        await trx<Book>('book')
          .insert({ md5: hash, title: hash, authors: '' })
          .onConflict('md5')
          .ignore();

        for (const pageStat of pageStats) {
          await trx<PageStat>('page_stat')
            .insert(pageStat)
            .onConflict(['device_id', 'book_md5', 'page', 'start_time'])
            .merge(['duration', 'total_pages']);
        }
        imported += pageStats.length;
      }

      await this.removeCopiedEvents(trx, device.id);
    });

    return imported;
  }

  /**
   * Readest's own cloud sync copies other devices' KOReader stats into its
   * database, and pushes them back as if they were read on this device. An
   * event with the same book, page and start second on another device is such
   * a copy, so drop it here. Sweeping the whole device (not just this batch)
   * also catches copies that arrived before the other device uploaded.
   */
  private static async removeCopiedEvents(trx: Knex.Transaction, deviceId: string) {
    await trx('page_stat as p')
      .where('p.device_id', deviceId)
      .whereExists((qb) =>
        qb
          .select(trx.raw('1'))
          .from('page_stat as o')
          .whereNot('o.device_id', deviceId)
          .whereRaw('o.book_md5 = p.book_md5')
          .whereRaw('o.page = p.page')
          .whereRaw('o.start_time = p.start_time')
      )
      .delete();

    const books = await trx('page_stat')
      .where({ device_id: deviceId })
      .union((qb) => qb.select('book_md5').from('book_device').where({ device_id: deviceId }))
      .distinct('book_md5');

    for (const { book_md5 } of books) {
      await this.recomputeBookDevice(trx, book_md5, deviceId);
    }
  }

  /** Readest sends no per-book totals, so derive them from its page stats. */
  private static async recomputeBookDevice(
    trx: Knex.Transaction,
    bookMd5: string,
    deviceId: string
  ) {
    const where = { book_md5: bookMd5, device_id: deviceId };

    const totals = await trx<PageStat>('page_stat')
      .where(where)
      .select(
        trx.raw('COALESCE(SUM(duration), 0) as total_read_time'),
        trx.raw('COUNT(DISTINCT page) as total_read_pages'),
        trx.raw('COALESCE(MAX(start_time), 0) as last_open')
      )
      .first<{ total_read_time: number; total_read_pages: number; last_open: number }>();

    if (!Number(totals?.total_read_time)) {
      await trx<BookDevice>('book_device').where(where).delete();
      return;
    }

    const latest = await trx<PageStat>('page_stat')
      .where(where)
      .orderBy('start_time', 'desc')
      .select('total_pages')
      .first();

    const bookDevice: Omit<BookDevice, 'id' | 'notes' | 'highlights'> = {
      ...where,
      total_read_time: Number(totals?.total_read_time ?? 0),
      total_read_pages: Number(totals?.total_read_pages ?? 0),
      last_open: Number(totals?.last_open ?? 0),
      pages: latest?.total_pages ?? 0,
    };

    await trx<BookDevice>('book_device')
      .insert(bookDevice)
      .onConflict(['book_md5', 'device_id'])
      .merge(['total_read_time', 'total_read_pages', 'last_open', 'pages']);
  }
}
