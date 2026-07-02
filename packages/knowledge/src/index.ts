import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { glob } from 'node:fs/promises'

const SKILLS_ROOT = resolve(process.cwd(), '../../packages/skills')

export interface KnowledgeResult {
  content: string
  source: string
  score: number
}

/**
 * Lightweight BM25-inspired keyword search over the skills knowledge base.
 * Ranks markdown chunks by term frequency across query keywords.
 */
export async function searchKnowledge(
  query: string,
  topK = 5,
  skillFilter?: string,
): Promise<KnowledgeResult[]> {
  const terms = tokenize(query)
  if (!terms.length) return []

  const chunks = await loadChunks(skillFilter)
  const scored = chunks.map(chunk => ({
    ...chunk,
    score: bm25Score(terms, chunk.content, chunks.length, chunks.map(c => c.content)),
  }))

  return scored
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

interface Chunk { content: string; source: string }

async function loadChunks(skillFilter?: string): Promise<Chunk[]> {
  const chunks: Chunk[] = []
  const root = skillFilter ? join(SKILLS_ROOT, skillFilter) : SKILLS_ROOT

  if (!existsSync(root)) return chunks

  // Use recursive glob to find all .md files
  try {
    const files = (await Array.fromAsync(
      glob('**/*.md', { cwd: root }),
    )) as string[]
    for (const rel of files) {
      const full = join(root, rel)
      const content = readFileSync(full, 'utf-8')
      // Split into ~500 char chunks
      const paragraphs = content.split(/\n\n+/).filter((p: string) => p.trim().length > 20)
      for (const para of paragraphs) {
        chunks.push({ content: para.trim(), source: rel })
      }
    }
  } catch {
    // Fallback: don't crash if glob fails
  }

  return chunks
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9一-龥\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1)
}

function bm25Score(
  queryTerms: string[],
  doc: string,
  totalDocs: number,
  allDocs: string[],
  k1 = 1.5,
  b = 0.75,
): number {
  const docTokens = tokenize(doc)
  const avgLen = allDocs.reduce((sum, d) => sum + tokenize(d).length, 0) / totalDocs
  const docLen = docTokens.length

  let score = 0
  for (const term of queryTerms) {
    const tf = docTokens.filter(t => t === term).length
    if (!tf) continue
    const df = allDocs.filter(d => d.toLowerCase().includes(term)).length
    const idf = Math.log((totalDocs - df + 0.5) / (df + 0.5) + 1)
    const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / avgLen)))
    score += idf * tfNorm
  }
  return score
}
