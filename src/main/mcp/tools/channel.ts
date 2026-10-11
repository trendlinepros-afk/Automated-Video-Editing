/**
 * What the owner's own YouTube audience does: where viewers of past videos stayed and where they left.
 * Read-only numbers from YouTube Analytics (services/youtubeAnalytics.ts); Claude decides what they mean
 * for the video in front of it.
 */
import { z } from 'zod'
import { defineTool, errMessage, json, ToolError, type ToolDef } from './common'

const HOW_TO_USE =
  'Retention is the % of views still watching. Drops are where viewers left much faster than usual (opening = the hook); ' +
  'spikes are parts viewers re-watched. vsSimilar compares with videos of similar length on YouTube (0.5 = typical). ' +
  'Look at what happens at these moments in past videos and decide what it means for this edit; it is evidence, not a rule.'

export const channelTools: ToolDef[] = [
  defineTool({
    name: 'get_channel_retention',
    description:
      "Audience retention of the owner's own YouTube channel (read-only): for the last long-form videos (Shorts left out), how many " +
      'viewers are still watching at 30 s, 1 min and each quarter, the biggest drop-offs (with the time in seconds), re-watch spikes, ' +
      'how each video holds against similar videos, and a channel summary (typical drop spots, which videos held best). ' +
      'With video_id: one video in detail, with its full 100-point retention curve. ' +
      'Use it once at the start of an edit to learn what holds this channel\'s viewers and where they tend to leave (a long intro, ' +
      'a slow setup, after the price is mentioned...), and turn that into decisions for this video (a tighter hook, a faster setup, ' +
      'a re-hook before the usual drop spot). Do not copy it blindly: a drop in an old video is a clue to check, not a rule. ' +
      'The numbers are kept for a day, so asking again is free.',
    input: {
      videos: z.number().int().min(1).max(50).optional().describe('How many recent long-form videos to look at. Default 15.'),
      video_id: z.string().min(5).max(20).optional().describe('One video id (from an earlier answer) for its detail and full curve.')
    },
    needsProject: false,
    async run(args, env) {
      try {
        if (args.video_id) return json({ ...(await env.ctx.youtube.videoRetention(args.video_id)), howToUse: HOW_TO_USE })
        const r = await env.ctx.youtube.channelRetention({ videos: args.videos })
        return json({ ...r, howToUse: HOW_TO_USE })
      } catch (err) {
        const code = (err as { code?: string }).code
        if (code === 'not_connected' || code === 'not_configured') {
          throw new ToolError(
            "The owner's YouTube channel is not connected to the app, so there is no retention data. Mention once to the owner that " +
              'connecting it (Settings > General > YouTube channel) lets you learn where their viewers drop off, then carry on with the edit without it.'
          )
        }
        if (code === 'reconnect') {
          throw new ToolError(`${errMessage(err)} Tell the owner this once, then carry on with the edit without the retention data.`)
        }
        throw new ToolError(`Could not read the channel's retention: ${errMessage(err)} Mention it to the owner if it matters, and carry on with the edit.`)
      }
    }
  })
]
