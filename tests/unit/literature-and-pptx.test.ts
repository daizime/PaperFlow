import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { LibraryDatabase } from '../../src/main/services/database'
import { DocumentService } from '../../src/main/services/document-service'
import {
  LiteratureSearchService,
  parseArxivAtomFeed,
  reconstructOpenAlexAbstract,
  validateExternalHttpsUrl
} from '../../src/main/services/literature-search-service'
import {
  buildAcademicPptxBuffer,
  formatSlideDeckMarkdown,
  parseSlideDeckJson
} from '../../src/main/services/pptx-builder'
import { readZipBuffer } from '../../src/main/services/zip-archive'

describe('LiteratureSearchService & OpenAlex/arXiv helpers', () => {
  test('reconstructOpenAlexAbstract restores word positions cleanly', () => {
    expect(
      reconstructOpenAlexAbstract({
        Sparse: [0],
        attention: [1, 4],
        improves: [2],
        long: [3],
        'scaling.': [5]
      })
    ).toBe('Sparse attention improves long attention scaling.')
    expect(reconstructOpenAlexAbstract(null)).toBe('')
  })

  test('parseArxivAtomFeed extracts papers, PDF URLs, authors, and categories', () => {
    const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <published>2024-01-22T18:00:00Z</published>
    <title>Deterministic Layout &amp; Sparse Attention</title>
    <summary>We propose deterministic chunking for scholarly PDFs.</summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>Alan Turing</name></author>
    <link title="pdf" href="http://arxiv.org/pdf/2401.12345v1" rel="related" type="application/pdf"/>
    <arxiv:doi>10.48550/arXiv.2401.12345</arxiv:doi>
    <category term="cs.CL"/>
  </entry>
</feed>`
    const items = parseArxivAtomFeed(atom)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      source: 'arxiv',
      title: 'Deterministic Layout & Sparse Attention',
      year: 2024,
      authors: ['Ada Lovelace', 'Alan Turing'],
      pdfUrl: 'https://arxiv.org/pdf/2401.12345v1',
      doi: '10.48550/arXiv.2401.12345',
      isOpenAccess: true,
      topics: ['cs.CL']
    })
  })

  test('validateExternalHttpsUrl enforces HTTPS and rejects private/loopback/local hosts', () => {
    expect(() => validateExternalHttpsUrl('file:///C:/secret.pdf')).toThrow()
    expect(() => validateExternalHttpsUrl('http://arxiv.org/pdf/2401.00001.pdf')).toThrow()
    expect(() => validateExternalHttpsUrl('https://127.0.0.1/test.pdf')).toThrow()
    expect(() => validateExternalHttpsUrl('https://192.168.1.10/test.pdf')).toThrow()
    expect(() => validateExternalHttpsUrl('https://localhost/test.pdf')).toThrow()
    expect(validateExternalHttpsUrl('https://arxiv.org/pdf/2401.00001.pdf').hostname).toBe('arxiv.org')
  })

  test('search deduplicates OpenAlex + arXiv results by DOI/title and degrades gracefully if AI fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'paperflow-lit-unit-'))
    const db = new LibraryDatabase(join(dir, 'db.sqlite'))
    const docs = new DocumentService(db, join(dir, 'lib'), async () => 1)
    try {
      const mockFetch: typeof fetch = async input => {
        const url = String(input)
        if (url.includes('/works')) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  id: 'https://openalex.org/W1',
                  doi: 'https://doi.org/10.48550/arXiv.2401.12345',
                  title: 'Deterministic Layout & Sparse Attention',
                  publication_year: 2024,
                  cited_by_count: 88,
                  abstract_inverted_index: { Short: [0], summary: [1] },
                  open_access: { is_oa: true },
                  best_oa_location: { pdf_url: null, source: { display_name: 'NeurIPS' } },
                  authorships: [{ author: { display_name: 'Ada Lovelace' } }]
                },
                {
                  id: 'https://openalex.org/W2',
                  doi: 'https://doi.org/10.1000/second',
                  title: 'Second Cited Benchmark',
                  publication_year: 2023,
                  cited_by_count: 250,
                  abstract_inverted_index: { High: [0], impact: [1] },
                  open_access: { is_oa: false },
                  authorships: [{ author: { display_name: 'Grace Hopper' } }]
                }
              ]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        return new Response(
          `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><entry><id>http://arxiv.org/abs/2401.12345v1</id><published>2024-01-22T00:00:00Z</published><title>Deterministic Layout &amp; Sparse Attention</title><summary>Much longer detailed arXiv abstract for deduplication merge.</summary><author><name>Ada Lovelace</name></author><link title="pdf" href="http://arxiv.org/pdf/2401.12345v1" type="application/pdf"/><arxiv:doi>10.48550/arXiv.2401.12345</arxiv:doi></entry></feed>`,
          { status: 200, headers: { 'Content-Type': 'application/atom+xml' } }
        )
      }

      const service = new LiteratureSearchService({
        database: db,
        documents: docs,
        translations: {
          hasConfiguredAiEngine: () => true,
          completeAcademicTask: async () => {
            throw new Error('simulated AI failure')
          }
        } as never,
        fetchImpl: mockFetch
      })

      const result = await service.search({
        query: 'sparse attention',
        tags: ['Transformer'],
        sort: 'citations'
      })
      expect(result.usedAiExpansion).toBe(false)
      expect(result.effectiveQuery).toBe('sparse attention Transformer')
      expect(result.items).toHaveLength(2)
      expect(result.items[0].title).toBe('Second Cited Benchmark')
      expect(result.items[1].pdfUrl).toBe('https://arxiv.org/pdf/2401.12345v1')
      expect(result.items[1].abstract).toContain('Much longer detailed arXiv abstract')
    } finally {
      db.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('buildAcademicPptxBuffer & parseSlideDeckJson', () => {
  test('parses fenced AI JSON and builds valid 16:9 OOXML .pptx ZIP with speaker notes and escaped XML', () => {
    const rawJson = '```json\n' +
      JSON.stringify({
        deckTitle: 'Catalysis & Reaction <Overpotential> Study',
        subtitle: 'Group Meeting Presentation',
        authors: 'Jane Doe et al.',
        slides: [
          {
            title: 'Catalysis & Reaction <Overpotential> Study',
            layout: 'cover',
            bullets: ['Journal: Nature Energy', 'Keywords: OER & HER'],
            speakerNotes: 'Introduce research background & scope.'
          },
          {
            title: 'Quantitative Benchmarks',
            layout: 'metrics',
            metrics: [
              { value: '198 mV', label: 'Overpotential @10 mA/cm2', detail: 'Outperforms RuO2' },
              { value: '99.2%', label: 'Faradaic Efficiency', detail: 'Stable > 100h' }
            ],
            takeaway: 'Significant activity & stability improvement.',
            speakerNotes: 'Highlight <198 mV> metric clearly.'
          },
          {
            title: 'Conclusion & Q&A',
            layout: 'closing',
            bullets: ['Active sites verified', 'Future scale-up tests'],
            takeaway: 'Ready for pilot validation'
          }
        ]
      }) +
      '\n```'

    const deck = parseSlideDeckJson(rawJson, 'Fallback')
    expect(deck.slides).toHaveLength(3)
    expect(formatSlideDeckMarkdown(deck)).toContain('198 mV')

    const pptxBuf = buildAcademicPptxBuffer(deck)
    const files = readZipBuffer(pptxBuf)
    expect(files.has('[Content_Types].xml')).toBe(true)
    expect(files.has('ppt/presentation.xml')).toBe(true)
    expect(files.has('ppt/slides/slide1.xml')).toBe(true)
    expect(files.has('ppt/slides/slide2.xml')).toBe(true)
    expect(files.has('ppt/slides/slide3.xml')).toBe(true)
    expect(files.has('ppt/notesSlides/notesSlide2.xml')).toBe(true)

    const slide1Xml = files.get('ppt/slides/slide1.xml')!.toString('utf8')
    expect(slide1Xml).toContain('Catalysis &amp; Reaction &lt;Overpotential&gt; Study')
    const notes2Xml = files.get('ppt/notesSlides/notesSlide2.xml')!.toString('utf8')
    expect(notes2Xml).toContain('Highlight &lt;198 mV&gt; metric clearly.')
  })

  test('falls back to structured slides when model returns plain markdown instead of JSON', () => {
    const deck = parseSlideDeckJson('# Background\n- Point A\n- Point B\n- Point C\n- Point D\n- Point E', 'My Paper')
    expect(deck.slides.length).toBeGreaterThanOrEqual(3)
    expect(deck.slides[0].layout).toBe('cover')
    expect(deck.slides[deck.slides.length - 1].layout).toBe('closing')
  })
})
