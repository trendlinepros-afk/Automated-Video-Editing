import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractChannelId,
  extractVideoIds,
  fetchYouTubeThumbnails,
  parseFeed,
  parseYouTubeLink
} from '../src/main/services/youtube'

const CH = 'UCX6OQ3DkcsbYNE6H8uQQuVA'

describe('parseYouTubeLink', () => {
  it('understands videos, shorts, playlists and channels', () => {
    expect(parseYouTubeLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s')).toEqual({ kind: 'video', videoId: 'dQw4w9WgXcQ' })
    expect(parseYouTubeLink('youtu.be/dQw4w9WgXcQ?si=abc')).toEqual({ kind: 'video', videoId: 'dQw4w9WgXcQ' })
    expect(parseYouTubeLink('https://youtube.com/shorts/dQw4w9WgXcQ')).toEqual({ kind: 'video', videoId: 'dQw4w9WgXcQ' })
    expect(parseYouTubeLink('https://m.youtube.com/playlist?list=PL123abc')).toEqual({ kind: 'playlist', playlistId: 'PL123abc' })
    expect(parseYouTubeLink('https://www.youtube.com/@MrBeast/videos')).toEqual({ kind: 'channel', path: '/@MrBeast' })
    expect(parseYouTubeLink('@MrBeast')).toEqual({ kind: 'channel', path: '/@MrBeast' })
    expect(parseYouTubeLink(`https://www.youtube.com/channel/${CH}`)).toEqual({ kind: 'channel', channelId: CH, path: `/channel/${CH}` })
    expect(parseYouTubeLink('https://www.youtube.com/c/SomeName')).toEqual({ kind: 'channel', path: '/c/SomeName' })
    expect(parseYouTubeLink('https://vimeo.com/123')).toBeNull()
    expect(parseYouTubeLink('not a link')).toBeNull()
  })
})

describe('page and feed parsing', () => {
  it('finds the channel id and video ids on a channel page', () => {
    const html = `<html><link rel="canonical" href="https://www.youtube.com/channel/${CH}">
      {"videoId":"aaaaaaaaaaa"},{"videoId":"bbbbbbbbbbb"},{"videoId":"aaaaaaaaaaa"},{"externalId":"${CH}"}`
    expect(extractChannelId(html)).toBe(CH)
    expect(extractVideoIds(html)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb'])
  })

  it('reads a channel feed with titles', () => {
    const xml = `<feed><title>RC Cars &amp; More</title>
      <entry><yt:videoId>aaaaaaaaaaa</yt:videoId><title>I &quot;Broke&quot; it</title></entry>
      <entry><yt:videoId>bbbbbbbbbbb</yt:videoId><title>Fast</title></entry></feed>`
    expect(parseFeed(xml)).toEqual({
      title: 'RC Cars & More',
      videos: [
        { videoId: 'aaaaaaaaaaa', title: 'I "Broke" it' },
        { videoId: 'bbbbbbbbbbb', title: 'Fast' }
      ]
    })
  })
})

describe('fetchYouTubeThumbnails', () => {
  const big = Buffer.alloc(5000, 7)
  const fakeFetch = (pages: Record<string, string>, missing: string[] = []) => {
    const calls: string[] = []
    const f = async (url: string) => {
      calls.push(url)
      const body = pages[url]
      const isImage = url.startsWith('https://i.ytimg.com/')
      const ok = isImage ? !missing.some((m) => url.includes(m)) : body !== undefined
      return {
        ok,
        status: ok ? 200 : 404,
        text: async () => body ?? '',
        arrayBuffer: async () => big.buffer.slice(big.byteOffset, big.byteOffset + big.length)
      }
    }
    return { f, calls }
  }

  it('lists a channel and saves the largest thumbnail available', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ave-yt-'))
    const { f, calls } = fakeFetch(
      {
        'https://www.youtube.com/@rc/videos': `{"externalId":"${CH}"} {"videoId":"aaaaaaaaaaa"} {"videoId":"bbbbbbbbbbb"}`,
        [`https://www.youtube.com/feeds/videos.xml?channel_id=${CH}`]: `<feed><title>RC</title><entry><yt:videoId>aaaaaaaaaaa</yt:videoId><title>First</title></entry></feed>`
      },
      ['aaaaaaaaaaa/maxresdefault']
    )
    const list = await fetchYouTubeThumbnails('https://www.youtube.com/@rc', { fetch: f, cacheDir: dir })
    expect(list.source).toBe('RC')
    expect(list.items.map((i) => [i.videoId, i.title])).toEqual([
      ['aaaaaaaaaaa', 'First'],
      ['bbbbbbbbbbb', '']
    ])
    // maxres was missing for the first video, so the next size was used.
    expect(calls).toContain('https://i.ytimg.com/vi/aaaaaaaaaaa/sddefault.jpg')
    for (const i of list.items) {
      expect(existsSync(i.file)).toBe(true)
      expect(readFileSync(i.file).length).toBe(5000)
    }
  })

  it('takes several video links at once and explains bad links plainly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ave-yt-'))
    const { f } = fakeFetch({
      'https://www.youtube.com/watch?v=aaaaaaaaaaa': '<meta name="title" content="Crash test">'
    })
    const list = await fetchYouTubeThumbnails('youtu.be/aaaaaaaaaaa\nhttps://youtu.be/bbbbbbbbbbb', { fetch: f, cacheDir: dir })
    expect(list.items.map((i) => i.title)).toEqual(['Crash test', ''])
    await expect(fetchYouTubeThumbnails('https://example.com/x', { fetch: f, cacheDir: dir })).rejects.toThrow(/not a YouTube/)
    await expect(fetchYouTubeThumbnails('   ', { fetch: f, cacheDir: dir })).rejects.toThrow(/Paste a YouTube/)
  })
})
