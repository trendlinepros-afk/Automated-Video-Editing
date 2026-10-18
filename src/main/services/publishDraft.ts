/**
 * The "Title, desc, tags" page: titles, a description and tags in one quick call instead of a queued editing request.
 *
 * Everything Claude needs is in the prompt (the owner's example titles and what the video is about, the channel and its
 * rules, what is said in the edit, the chapters, the length), so Claude Code runs once with no tools at all and answers
 * with JSON only. The app saves the answer: the three titles (search, clickbait, mix) in publish.generated with the
 * chosen one as titles[0], and the description and tags when they were empty or when that part was asked for.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { chapterLines } from '@shared/captions'
import type { PublishDraft, PublishPart } from '@shared/ipc'
import type { Project, ProjectDoc } from '@shared/project'
import type { Profile } from '@shared/settings'
import { TimelineResolver } from '@shared/timeline'
import type { AppContext } from '../context'
import type { ProjectStore } from '../project/store'
import { resolveCommand } from '../runner/runner'
import { spokenText } from './thumbnailDraft'

const TIMEOUT_MS = 120_000
const MAX_SPOKEN_CHARS = 6000
export const TITLE_MAX = 70
export const TAGS_MAX_CHARS = 500
const DESCRIPTION_MAX = 4500
export type TitleKind = 'search' | 'clickbait' | 'mix'
export const TITLE_KINDS: TitleKind[] = ['search', 'clickbait', 'mix']

export interface PublishPromptInput {
  only?: PublishPart
  direction?: string
  examples: string[]
  about: string
  inspiration?: string
  channel?: string
  channelRules?: string[]
  channelNotes?: string
  theme?: string
  /** Seconds. */
  duration: number
  spoken: string
  /** "0:00 Intro" lines, from the chapters in the project (their times follow the edit). */
  chapters: string[]
  current: { titles: string[]; description: string; tags: string[] }
  /** The channel's standing description text (links, disclaimer) is added after the description by the app. */
  hasTemplate: boolean
}

function clock(seconds: number): string {
  const t = Math.max(0, Math.round(seconds))
  const m = Math.floor(t / 60)
  return `${m}:${String(t % 60).padStart(2, '0')}`
}

export function publishPrompt(o: PublishPromptInput): string {
  const want = o.only ? [o.only] : (['titles', 'description', 'tags'] as PublishPart[])
  const shape: string[] = []
  if (want.includes('titles')) shape.push('"titles": {"search": "...", "clickbait": "...", "mix": "..."}')
  if (want.includes('description')) shape.push('"description": "..."')
  if (want.includes('tags')) shape.push('"tags": ["...", "..."]')
  const examples = o.examples.map((e) => e.trim()).filter(Boolean)
  const lines: string[] = [
    `You are a YouTube packaging expert writing the ${want.join(', ')} for a creator's video${o.channel ? ` on the channel "${o.channel}"` : ''}. ` +
      'Everything you need is below: answer straight away, do not use or ask for any tools.',
    '\nABOUT THE VIDEO',
    `What the video is about, in the creator's words:\n"""${o.about.trim() || '(not given: work it out from what is said)'}"""`,
    o.inspiration?.trim() && o.inspiration.trim() !== o.about.trim() ? `The creator's vision for the edit:\n"""${o.inspiration.trim()}"""` : '',
    o.theme ? `Video theme: ${o.theme}.` : '',
    `Length of the edit: ${clock(o.duration)}.`,
    `What is said in the edit, in order:\n"""${o.spoken.trim() || '(no transcript yet)'}"""`,
    o.chapters.length ? `Chapters (times are exact and follow the edit):\n${o.chapters.join('\n')}` : 'There are no chapters yet.',
    examples.length
      ? `Titles the creator likes (their own past titles or ones that worked; match their voice, wording and style, do not copy them):\n${examples.map((e) => `- "${e}"`).join('\n')}`
      : '',
    o.channelRules?.length ? `Channel rules (always follow them):\n${o.channelRules.map((r) => `- ${r}`).join('\n')}` : '',
    o.channelNotes?.trim() ? `Channel notes from the creator:\n${o.channelNotes.trim()}` : '',
    o.direction?.trim() ? `The creator's direction for this answer: "${o.direction.trim()}"` : ''
  ]

  lines.push('\nRULES')
  if (want.includes('titles')) {
    lines.push(
      `Titles: write exactly three. Each at most ${TITLE_MAX} characters (ideally 40-60), no quotes around it, no hashtags, no emoji unless the example titles use them, ` +
        'every word true to the video (no lies or promises the video does not keep).',
      '- "search": optimised for YouTube search. Front-load the exact keywords people actually type to find this (the product or model name, ' +
        'what it is, the main question or problem). Clear and specific, reads like a natural title, not a keyword list.',
      '- "clickbait": made for the click from the home page and suggested videos: curiosity, emotion, stakes or a surprising result, ' +
        'a gap the viewer wants closed. Still true to the video.',
      '- "mix": the best of both. The main keyword early, plus a curiosity or emotion hook. This is the one most creators should use.'
    )
    if (o.current.titles.length && o.only === 'titles') lines.push(`Current titles (write new, better ones, not these): ${o.current.titles.map((t) => `"${t}"`).join('; ')}`)
  }
  if (want.includes('description')) {
    lines.push(
      'Description: plain text, under 1500 characters. The first two lines are what shows above "...more": a hook plus the main keywords ' +
        'in natural sentences. Then a short summary of what happens and what the viewer learns or sees (2-4 short paragraphs, keywords used naturally). ' +
        'No chapter list or timestamps (the app adds the chapters below the description so their times stay right), never invent times or facts. ' +
        'No links, prices or sponsors unless they are given above. No hashtags block.' +
        (o.hasTemplate ? ' The channel\'s standing links and disclaimer are added after it by the app: do not write them.' : '')
    )
    if (o.current.description.trim() && o.only === 'description') lines.push(`Current description (write a better one):\n"""${o.current.description.trim()}"""`)
  }
  if (want.includes('tags')) {
    lines.push(
      `Tags: 10-20 tags, from the most specific (exact product or model name, the main search phrase) to broad (the topic, the hobby). ` +
        `Lowercase, no "#", no duplicates, and all of them together at most ${TAGS_MAX_CHARS} characters.`
    )
    if (o.current.tags.length && o.only === 'tags') lines.push(`Current tags (improve on them): ${o.current.tags.join(', ')}`)
  }
  if (!want.includes('titles') && o.current.titles[0]) lines.push(`The video's title: "${o.current.titles[0]}".`)
  lines.push(`\nReply with ONLY this JSON, nothing before or after it: {${shape.join(', ')}}`)
  return lines.filter(Boolean).join('\n')
}

function cleanTitle(t: unknown): string {
  return String(t ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim()
}

/** Tags as YouTube counts them: joined with commas, a tag with a space counts its quotes too. */
export function tagsLength(tags: string[]): number {
  return tags.reduce((n, t, i) => n + t.length + (/\s/.test(t) ? 2 : 0) + (i ? 1 : 0), 0)
}

export function cleanTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split(',')
  const out: string[] = []
  for (const piece of list.flatMap((t) => t.split(','))) {
    const t = piece.replace(/^#+/, '').replace(/[<>"]/g, '').replace(/\s+/g, ' ').trim()
    if (!t || out.some((o) => o.toLowerCase() === t.toLowerCase())) continue
    if (tagsLength([...out, t]) > TAGS_MAX_CHARS) break
    out.push(t)
  }
  return out
}

/** Links in the description stay only when the creator gave them (in the about text, say). */
function cleanDescription(text: unknown, allowed: string): string {
  return String(text ?? '')
    .replace(/https?:\/\/\S+|www\.\S+/gi, (url) => (allowed.includes(url) ? url : ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, DESCRIPTION_MAX)
}

/** The answer from Claude Code's reply (its JSON envelope, or plain text), checked for the asked-for parts. */
export function parsePublishDraft(stdout: string, only?: PublishPart, allowedLinksIn = ''): PublishDraft {
  let text = stdout.trim()
  try {
    const env = JSON.parse(text) as { result?: unknown; is_error?: boolean; subtype?: string }
    if (env.is_error) throw new Error(String(env.result ?? env.subtype ?? 'Claude could not answer.'))
    if (typeof env.result === 'string') text = env.result
  } catch (err) {
    if (err instanceof Error && !(err instanceof SyntaxError)) throw err
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  let parsed: Record<string, unknown>
  try {
    if (start < 0 || end <= start) throw new SyntaxError('no JSON')
    parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    throw new Error(`Claude did not answer with titles, a description and tags. It said: ${text.slice(0, 200) || '(nothing)'}`)
  }
  const want = only ? [only] : (['titles', 'description', 'tags'] as PublishPart[])
  const out: PublishDraft = {}
  if (want.includes('titles')) {
    const t = (parsed.titles ?? {}) as Record<string, unknown>
    const titles = { search: cleanTitle(t.search), clickbait: cleanTitle(t.clickbait), mix: cleanTitle(t.mix) }
    if (!titles.search && !titles.clickbait && !titles.mix) throw new Error('Claude did not write any titles. Try again.')
    // A missing one borrows from the others so every card has a title.
    titles.mix ||= titles.search || titles.clickbait
    titles.search ||= titles.mix
    titles.clickbait ||= titles.mix
    out.titles = titles
  }
  if (want.includes('description')) {
    const d = cleanDescription(parsed.description, allowedLinksIn)
    if (!d) throw new Error('Claude did not write a description. Try again.')
    out.description = d
  }
  if (want.includes('tags')) {
    const tags = cleanTags(parsed.tags)
    if (!tags.length) throw new Error('Claude did not write any tags. Try again.')
    out.tags = tags
  }
  return out
}

/**
 * Saves an answer into the publishing pack. The chosen title (Mix unless the owner picked another) is titles[0]; the
 * other two and the earlier titles follow. The description and tags are filled when they were empty, or replaced when
 * that part was the one asked for.
 */
export function applyPublishDraft(pub: Project['publish'], draft: PublishDraft, only: PublishPart | undefined, now: string): void {
  if (draft.titles) {
    const chosen = pub.generated?.chosen ?? 'mix'
    pub.generated = { ...draft.titles, chosen, at: now }
    const order = [draft.titles[chosen], ...TITLE_KINDS.filter((k) => k !== chosen).map((k) => draft.titles![k]), ...pub.titles]
    pub.titles = order.filter((t, i) => t && order.findIndex((o) => o.toLowerCase() === t.toLowerCase()) === i).slice(0, 6)
  }
  if (draft.description && (only === 'description' || !pub.description.trim())) pub.description = draft.description
  if (draft.tags && (only === 'tags' || !pub.tags.length)) pub.tags = draft.tags
  pub.updatedAt = now
}

export function promptInputFor(doc: ProjectDoc, profile: Profile | null, opts: { only?: PublishPart; direction?: string }): PublishPromptInput {
  const project = doc.project
  const brief = project.publish.brief
  return {
    only: opts.only,
    direction: opts.direction,
    examples: (brief?.examples ?? []).slice(0, 3),
    about: brief?.about?.trim() || project.inspiration,
    inspiration: project.inspiration,
    channel: profile?.name,
    channelRules: (profile?.rules ?? []).filter((r) => r.enabled).map((r) => r.text),
    channelNotes: profile?.channelNotes,
    theme: project.videoTheme?.name,
    duration: new TimelineResolver(project, doc.transcript).duration,
    spoken: spokenText(project, doc.transcript, MAX_SPOKEN_CHARS),
    chapters: chapterLines(doc),
    current: { titles: project.publish.titles, description: project.publish.description, tags: project.publish.tags },
    hasTemplate: !!(project.settings.descriptionTemplate || profile?.descriptionTemplate || '').trim()
  }
}

export interface PublishDraftDeps {
  spawn?: (file: string, args: string[], opts: Parameters<typeof spawn>[2]) => ChildProcess
  platform?: NodeJS.Platform
}

/** Runs the quick call and saves the answer. Resolves with what Claude wrote. */
export async function writePublishDraft(
  ctx: AppContext,
  store: ProjectStore,
  opts: { only?: PublishPart; direction?: string } = {},
  deps: PublishDraftDeps = {}
): Promise<PublishDraft> {
  const doc = store.snapshotDoc()
  const project = doc.project
  const profile = ctx.profiles.get(project.profileId)
  const input = promptInputFor(doc, profile, opts)
  if (!input.about.trim() && !input.spoken.trim() && !input.examples.some((e) => e.trim()))
    throw new Error('Tell Claude what the video is about first (or wait until there is an edit).')
  const prompt = publishPrompt(input)

  const work = join(store.paths.cache, 'publish-draft')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const started = Date.now()
  const settings = ctx.settings.get()
  const model = settings.claude?.models?.publish || ''
  // No tools at all: everything is in the prompt and the answer is JSON only.
  const args = ['-p', prompt, '--output-format', 'json', '--tools', '', '--max-turns', '2', ...(model ? ['--model', model] : [])]
  const platform = deps.platform ?? process.platform
  const cmd = resolveCommand(settings.runner.command, args, platform)
  const { ANTHROPIC_API_KEY: _drop, ...env } = process.env // Claude Code uses its own sign-in, never a key from the app
  const run = deps.spawn ?? spawn
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      let out = ''
      let err = ''
      const proc = run(cmd.file, cmd.args, { cwd: work, env, windowsHide: true, shell: cmd.shell, stdio: ['ignore', 'pipe', 'pipe'] })
      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error('Claude took too long to answer. Try again.'))
      }, TIMEOUT_MS)
      proc.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')))
      proc.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')))
      proc.on('error', (e) => {
        clearTimeout(timer)
        reject(new Error(`Claude Code could not be started (${(e as NodeJS.ErrnoException).code ?? e.message}). Check Settings > Claude.`))
      })
      proc.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0 || out.trim()) resolve(out)
        else reject(new Error(`Claude could not answer: ${(err || out).trim().slice(-300) || `exit code ${code}`}`))
      })
    })
    const draft = parsePublishDraft(stdout, opts.only, [input.about, input.inspiration ?? '', input.channelNotes ?? ''].join('\n'))
    store.mutate(
      opts.only ? `Rewrite ${opts.only === 'titles' ? 'titles' : opts.only === 'tags' ? 'tags' : 'description'} with Claude` : 'Titles, description and tags from Claude',
      'claude',
      (d) => applyPublishDraft(d.project.publish, draft, opts.only, new Date().toISOString()),
      { bypassLock: true }
    )
    store.log.write('claude', `Claude wrote the ${opts.only ?? 'titles, description and tags'} in ${((Date.now() - started) / 1000).toFixed(1)} s`, {
      model: model || 'default',
      only: opts.only ?? 'all'
    })
    return draft
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
