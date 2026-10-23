import { uniq } from 'ramda';
import { OpenLibrarySearchResult } from './open-library-types';

const OPEN_LIBRARY_API = 'https://openlibrary.org';
const OPEN_LIBRARY_COVERS_API = 'https://covers.openlibrary.org';

export class OpenLibraryService {
  static async fetchCover(coverId: string, size: 'S' | 'M' | 'L' = 'M') {
    const url = `${OPEN_LIBRARY_COVERS_API}/b/id/${coverId}-${size}.jpg`;
    return fetch(url).then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to fetch cover ${coverId}: ${response.status}`);
      }
      return response.arrayBuffer();
    });
  }

  /**
   * Finds the best matching cover id for a book by title and author.
   * Returns null if Open Library has no matching book with a cover.
   */
  static async findCoverId(title: string, authors?: string | null): Promise<number | null> {
    const params = new URLSearchParams({ title, limit: '5', fields: 'key,cover_i' });
    if (authors) {
      params.set('author', authors);
    }

    const response = await fetch(`${OPEN_LIBRARY_API}/search.json?${params}`);
    if (!response.ok) {
      throw new Error(`Open Library search failed: ${response.status}`);
    }

    const result: OpenLibrarySearchResult = await response.json();
    return result.docs.find((doc) => doc.cover_i)?.cover_i ?? null;
  }

  static async queryCovers(searchTerm: string, limit: number = 3) {
    const response = await this.searchBooks(searchTerm, limit);
    const docs = response.docs;

    const coverIds = docs.flatMap((doc) => doc.cover_i);
    const keys = docs.flatMap((doc) => doc.key);

    const newCoverIds = (await Promise.all(keys.map((k) => this.queryCoverForKey(k)))).flat();

    return uniq([...coverIds, ...newCoverIds].filter(Boolean));
  }

  private static async searchBooks(
    searchTerm: string,
    limit = 3,
    fields = 'key,cover_i',
    lang = 'eng'
  ): Promise<OpenLibrarySearchResult> {
    const params = new URLSearchParams({
      q: searchTerm,
      limit: limit.toString(),
      lang,
      fields,
    });

    return fetch(`${OPEN_LIBRARY_API}/search.json?${params}`).then((response) => response.json());
  }

  private static queryCoverForKey(key: string) {
    return fetch(`${OPEN_LIBRARY_API}${key}/editions.json`)
      .then((r) => r.json())
      .then((r) => r.entries.flatMap((entry: { covers: string[] }) => entry.covers));
  }
}
