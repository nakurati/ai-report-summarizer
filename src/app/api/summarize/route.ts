/* Summarize endpoint: accepts a file and returns Markdown */

export const runtime = 'nodejs' // Uses Node runtime for PDF parsing on Vercel

import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { pdf as parsePdf } from 'pdf-parse'
import mammoth from 'mammoth'
import { z } from 'zod'
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter'

// Keep server-side validation aligned with client
type ValidMime =
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const max_bytes = 10 * 1024 * 1024 // 10 MB
const acceptedMimes: ValidMime[] = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]

// Token/size controls (MVP-safe)
const MAX_CHARS = 180000 // fail fast on huge docs (~180k chars ≈ ~30k tokens rough)
const CHUNK_SIZE = 6000 // chars (~1k tokens)
const CHUNK_OVERLAP = 400 // chars

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })

// Structured output schema (arrays of strings)
const SummarySchema = z.object({
  executive_summary: z.array(z.string()).default([]),
  key_insights: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  action_items: z.array(z.string()).default([]),
})

/* Helper functions */
function bad(status: number, msg: string) {
  return NextResponse.json({ error: msg }, { status })
}

function clean(s: string) {
  // Normalize whitespace and strip trailing spaces; keep newlines (helpful for chunking)
  return s
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

// Call OpenAI and parse JSON robustly
async function getJsonObjectFromModel(system: string, user: string) {
  const completion = await client.chat.completions.create({
    model: 'gpt-4.1-mini',
    temperature: 0.2,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    // Optional: force JSON-ish behavior
    response_format: { type: 'json_object' as const },
  })

  const content =
    (completion.choices &&
      completion.choices[0] &&
      completion.choices[0].message &&
      completion.choices[0].message.content) ||
    '{}'

  try {
    return JSON.parse(content)
  } catch {
    // Last resort: strip backticks if model wrapped it
    const stripped = content.replace(/```json|```/g, '')
    return JSON.parse(stripped)
  }
}

// Type alias for readability (matches your zod schema)
type Summary = {
  executive_summary: string[]
  key_insights: string[]
  risks: string[]
  action_items: string[]
}

/**
 * Return a de-duplicated list of lines in a human-friendly way.
 * - Trims leading/trailing whitespace
 * - Collapses internal whitespace to single spaces
 * - Treats lines as the same if they differ only by case (case-insensitive)
 */
function uniqueNormalizedLines(lines: string[]): string[] {
  // We'll keep a fingerprint (lowercased, normalized text) to detect duplicates.
  const seen = new Set<string>() // e.g., "risk a" and "Risk   A" → "risk a" (same fingerprint)

  // This will hold the final, cleaned lines we want to keep and return.
  const result: string[] = []

  // Check each input line
  for (const raw of lines) {
    // 1) Normalize whitespace for comparison:
    // - trim() removes whitespace at the ends
    // - replace(/\s+/g, ' ') turns any run of spaces/tabs/newlines into a single space
    const normalized = raw.trim().replace(/\s+/g, ' ')

    // If the line is empty after normalization, skip it.
    if (!normalized) continue

    // 2) Create a case-insensitive "fingerprint" for de-dup:
    // Lowercasing means "Risk A" and "risk a" are considered duplicates.
    const fingerprint = normalized.toLowerCase()

    // 3) If we haven't seen this fingerprint yet, keep the line.
    if (!seen.has(fingerprint)) {
      seen.add(fingerprint)

      // We push the normalized (but original-cased) text so it looks nice when displayed.
      result.push(normalized)
    }
    // If we have seen it, do nothing (skip duplicates).
  }

  // Return the unique, cleaned lines.
  return result
}

/**
 * Merge an array of partial summaries into one:
 * - flatten per-section arrays across all partials
 * - normalize + de-duplicate lines
 */
function mergePartialSummaries(partials: Summary[]): Summary {
  return {
    executive_summary: uniqueNormalizedLines(partials.flatMap(p => p.executive_summary)),
    key_insights: uniqueNormalizedLines(partials.flatMap(p => p.key_insights)),
    risks: uniqueNormalizedLines(partials.flatMap(p => p.risks)),
    action_items: uniqueNormalizedLines(partials.flatMap(p => p.action_items)),
  }
}

/**
 * Limit a list to a maximum length (keeps the first N).
 * This keeps output concise for very long documents.
 */
function capList(items: string[], max: number): string[] {
  return items.length > max ? items.slice(0, max) : items
}

// Single-shot summarize (short docs)
async function summarizeSingle(text: string, filename: string) {
  const sys = [
    'You are a precise analyst. Return ONLY valid JSON with keys:',
    'executive_summary, key_insights, risks, action_items (each an array of short bullet strings).',
  ].join(' ')

  const user = [
    'Summarize the following document into those 4 sections.',
    'Be concise, factually grounded, and avoid repetition.',
    'Prefer bullets; keep each bullet under ~25 words.',
    '',
    'Document:',
    text,
  ].join('\n')

  const out = await getJsonObjectFromModel(sys, user)
  return SummarySchema.parse(out)
}

// Chunked summarize (long docs)
async function summarizeChunked(text: string, filename: string) {
  // Split using LangChain (character splitter is fine for MVP)
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  })
  const chunks = await splitter.splitText(text)

  // Map: summarize each chunk to structured JSON
  const partials: z.infer<typeof SummarySchema>[] = []
  for (const chunk of chunks) {
    const sys = [
      'You are a precise analyst. Return ONLY valid JSON with keys:',
      'executive_summary, key_insights, risks, action_items (each an array of short bullet strings).',
      'Do NOT invent information. Summarize only from the provided chunk.',
    ].join(' ')

    const user = [
      'Summarize this chunk into the 4 arrays.',
      'Keep bullets short; skip empty sections rather than padding.',
      '',
      'Chunk:',
      chunk,
    ].join('\n')

    const out = await getJsonObjectFromModel(sys, user)
    const parsed = SummarySchema.parse(out)
    partials.push(parsed)
  }

  // Reduce: merge arrays & de-dupe lines
  const merged: Summary = mergePartialSummaries(partials)

  // Optional: keep only the top N bullets per section to avoid wall-of-text summaries
  const finalSummary: Summary = {
    executive_summary: capList(merged.executive_summary, 12),
    key_insights: capList(merged.key_insights, 20),
    risks: capList(merged.risks, 15),
    action_items: capList(merged.action_items, 15),
  }
  return finalSummary
}

// Render structured summary to Markdown
function renderMarkdown(s: z.infer<typeof SummarySchema>, filename: string) {
  return [
    `# Executive Summary`,
    ...(s.executive_summary.length ? s.executive_summary.map(x => `- ${x}`) : ['- (none)']),
    '',
    `# Key Insights`,
    ...(s.key_insights.length ? s.key_insights.map(x => `- ${x}`) : ['- (none)']),
    '',
    `# Risks`,
    ...(s.risks.length ? s.risks.map(x => `- ${x}`) : ['- (none)']),
    '',
    `# Action Items`,
    ...(s.action_items.length ? s.action_items.map(x => `- ${x}`) : ['- (none)']),
    '',
    `> Source: \`${filename}\``,
  ].join('\n')
}

//

export async function POST(req: Request) {
  try {
    const form = await req.formData()
    const file = form.get('file') as File | null

    if (!file) {
      return NextResponse.json({ error: 'No file found in request.' }, { status: 400 })
    }

    // Validate type (MIME) with filename fallback (some environments don’t set type).
    const type = file.type as ValidMime | ''
    const name = file && file.name != null ? String(file.name) : 'uploaded-file'
    const lower = name.toLowerCase()
    const looksPdf = lower.endsWith('.pdf')
    const looksDocx = lower.endsWith('.docx')

    const mimeOk = acceptedMimes.includes(type as ValidMime) || looksPdf || looksDocx

    if (!mimeOk) {
      return NextResponse.json(
        { error: 'Only PDF (.pdf) or DOCX (.docx) are allowed.' },
        { status: 400 },
      )
    }

    if (file.size > max_bytes) {
      return NextResponse.json({ error: 'File is larger than 10 MB.' }, { status: 400 })
    }

    //  Read into Buffer
    const arr = await file.arrayBuffer()
    const buf = Buffer.from(arr)

    //  Extract raw text
    let rawText = ''

    if (looksPdf || type === 'application/pdf') {
      // pdf-parse (ESM named export)
      const parsed = await parsePdf(buf) // parsed.text, parsed.numpages, etc.
      rawText = clean(parsed.text || '')
    } else if (looksDocx) {
      const { value } = await mammoth.extractRawText({ buffer: buf })
      rawText = clean(value || '')
    } else {
      return bad(400, 'Unsupported file type.')
    }

    if (!rawText.trim()) return bad(400, 'Could not extract text from this file.')

    if (rawText.length > MAX_CHARS) {
      return bad(
        413,
        `This document is quite large (${rawText.length.toLocaleString()} chars). Please upload a smaller file.`,
      )
    }

    // ---- Summarize ----
    // Strategy:
    // - If short: single prompt → JSON → render Markdown.
    // - If long: chunk → per-chunk summaries → merge → render Markdown.
    let summary
    if (rawText.length <= 10000) {
      summary = await summarizeSingle(rawText, name)
    } else {
      summary = await summarizeChunked(rawText, name)
    }

    // Render Markdown for your UI
    const markdown = renderMarkdown(summary, name)

    return NextResponse.json({ markdown }, { status: 200 })
  } catch (err) {
    console.error('summarize error:', err)
    return bad(500, 'Unexpected server error.')
  }
}
