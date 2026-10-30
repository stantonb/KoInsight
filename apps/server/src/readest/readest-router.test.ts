import express from 'express';
import request from 'supertest';
import { createBook } from '../db/factories/book-factory';
import { createDevice } from '../db/factories/device-factory';
import { createUser } from '../db/factories/user-factory';
import { db } from '../knex';
import { readestRouter } from './readest-router';

describe('readest-router', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/koreader/plugin', readestRouter);

  const hash = 'a'.repeat(32);
  const auth = { 'x-auth-user': 'reader', 'x-auth-key': 'key' };

  beforeEach(async () => {
    await createUser(db, { username: 'reader', password: 'key' });
  });

  const pushStats = (books: unknown, extra: Record<string, unknown> = {}) =>
    request(app)
      .post('/api/v1/koreader/plugin/page-stats')
      .set(auth)
      .send({ deviceId: 'phone-1', deviceModel: 'Pixel', books, ...extra });

  it('rejects requests without valid KoSync credentials', async () => {
    const response = await request(app)
      .get('/api/v1/koreader/plugin/version')
      .set({ 'x-auth-user': 'reader', 'x-auth-key': 'wrong' });

    expect(response.status).toBe(401);
  });

  it('reports version and capabilities', async () => {
    const response = await request(app).get('/api/v1/koreader/plugin/version').set(auth);

    expect(response.status).toBe(200);
    expect(response.body.capabilities).toEqual(expect.any(Array));
  });

  describe('POST /match-check', () => {
    it('registers unknown books and reports them as matched', async () => {
      const response = await request(app)
        .post('/api/v1/koreader/plugin/match-check')
        .set(auth)
        .send({ hashes: [hash], books: [{ hash, title: 'Dune', authors: 'Frank Herbert' }] });

      expect(response.status).toBe(200);
      expect(response.body.matches).toEqual([
        expect.objectContaining({ hash, bookId: expect.any(Number) }),
      ]);
      const book = await db('book').where({ md5: hash }).first();
      expect(book).toEqual(expect.objectContaining({ title: 'Dune', authors: 'Frank Herbert' }));
    });

    it('keeps the title of a book already imported from KOReader', async () => {
      await createBook(db, { md5: hash, title: 'KOReader title' });

      await request(app)
        .post('/api/v1/koreader/plugin/match-check')
        .set(auth)
        .send({ books: [{ hash, title: 'Readest title' }] });

      const book = await db('book').where({ md5: hash }).first();
      expect(book.title).toBe('KOReader title');
    });
  });

  describe('POST /page-stats', () => {
    it('stores page stats and derives per-device totals', async () => {
      const response = await pushStats([
        {
          hash,
          events: [
            { page: 1, startTime: 1000, durationSeconds: 30, totalPages: 200 },
            { page: 2, startTime: 1030, durationSeconds: 45, totalPages: 200 },
          ],
        },
      ]);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ imported: 2 });

      const stats = await db('page_stat').where({ book_md5: hash, device_id: 'phone-1' });
      expect(stats).toHaveLength(2);

      const device = await db('device').where({ id: 'phone-1' }).first();
      expect(device.model).toBe('Pixel');

      const bookDevice = await db('book_device')
        .where({ book_md5: hash, device_id: 'phone-1' })
        .first();
      expect(bookDevice).toEqual(
        expect.objectContaining({
          total_read_time: 75,
          total_read_pages: 2,
          last_open: 1030,
          pages: 200,
        })
      );
    });

    it('deduplicates resent events', async () => {
      const books = [
        { hash, events: [{ page: 1, startTime: 1000, durationSeconds: 30, totalPages: 200 }] },
      ];

      await pushStats(books);
      await pushStats(books);

      expect(await db('page_stat').where({ book_md5: hash })).toHaveLength(1);
      const bookDevice = await db('book_device').where({ book_md5: hash }).first();
      expect(bookDevice.total_read_time).toBe(30);
    });

    describe('events copied from another device by Readest sync', () => {
      const kindleEvent = { page: 1, startTime: 1000, duration: 30, total_pages: 200 };

      const insertKindleEvent = async () => {
        await createDevice(db, { id: 'kindle', model: 'Kindle' });
        await db('page_stat').insert({
          book_md5: hash,
          device_id: 'kindle',
          page: kindleEvent.page,
          start_time: kindleEvent.startTime,
          duration: kindleEvent.duration,
          total_pages: kindleEvent.total_pages,
        });
      };

      const readestEvents = [
        { page: 1, startTime: 1000, durationSeconds: 30, totalPages: 200 },
        { page: 2, startTime: 2000, durationSeconds: 40, totalPages: 200 },
      ];

      it('drops events another device already reported', async () => {
        await createBook(db, { md5: hash });
        await insertKindleEvent();

        await pushStats([{ hash, events: readestEvents }]);

        const stats = await db('page_stat').where({ book_md5: hash, device_id: 'phone-1' });
        expect(stats).toEqual([expect.objectContaining({ page: 2, start_time: 2000 })]);
        const bookDevice = await db('book_device')
          .where({ book_md5: hash, device_id: 'phone-1' })
          .first();
        expect(bookDevice.total_read_time).toBe(40);
      });

      it('removes copies on the next push when the other device uploads later', async () => {
        await pushStats([{ hash, events: readestEvents }]);
        await insertKindleEvent();

        await pushStats([]);

        const stats = await db('page_stat').where({ device_id: 'phone-1' });
        expect(stats).toHaveLength(1);
        expect(await db('page_stat').where({ device_id: 'kindle' })).toHaveLength(1);
      });

      it('removes the per-device totals of a book that was only copied', async () => {
        await createBook(db, { md5: hash });
        await insertKindleEvent();

        await pushStats([{ hash, events: [readestEvents[0]] }]);

        expect(await db('book_device').where({ device_id: 'phone-1' })).toHaveLength(0);
      });
    });

    it('fills in the title of a placeholder book on a later match-check', async () => {
      await pushStats([
        { hash, events: [{ page: 1, startTime: 1000, durationSeconds: 30, totalPages: 200 }] },
      ]);

      await request(app)
        .post('/api/v1/koreader/plugin/match-check')
        .set(auth)
        .send({ books: [{ hash, title: 'Dune', authors: 'Frank Herbert' }] });

      const book = await db('book').where({ md5: hash }).first();
      expect(book).toEqual(expect.objectContaining({ title: 'Dune', authors: 'Frank Herbert' }));
    });

    it('drops events without a positive duration', async () => {
      const response = await pushStats([
        { hash, events: [{ page: 1, startTime: 1000, durationSeconds: 0, totalPages: 200 }] },
      ]);

      expect(response.body).toEqual({ imported: 0 });
      expect(await db('book').where({ md5: hash })).toHaveLength(0);
    });

    it('falls back to a Readest device when no device ID is sent', async () => {
      await pushStats(
        [{ hash, events: [{ page: 1, startTime: 1000, durationSeconds: 30, totalPages: 200 }] }],
        { deviceId: undefined, deviceModel: undefined }
      );

      const device = await db('device').where({ id: 'readest' }).first();
      expect(device.model).toBe('Readest');
    });

    it('rejects malformed payloads', async () => {
      const response = await pushStats([{ hash: '', events: [] }]);

      expect(response.status).toBe(400);
    });
  });
});
