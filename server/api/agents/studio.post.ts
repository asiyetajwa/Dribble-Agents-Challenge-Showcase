/**
 * POST /api/agents/studio
 * Content Studio Agent — YouTube script, hooks, titles + optional Imagen 3 thumbnail.
 *
 * Gate:  downloads · api-lite · api-elite · api-flite · bq-researcher · bq-professional · bq-commercial
 * Auth:  session cookie OR Authorization: Bearer <api-key>
 * Response: text/event-stream (SSE)
 *
 * Body:
 *   {
 *     mode: 'match' | 'player',
 *     id: string,                     match ID or player ID (numeric)
 *     format?: 'script' | 'hooks' | 'full'  (default: 'full')
 *   }
 *
 * SSE events:
 *   { type: 'thinking', text: string }
 *   { type: 'context', data: object }
 *   { type: 'token', text: string }
 *   { type: 'thumbnail', prompt: string, image_base64?: string }
 *   { type: 'done', usage: object }
 *   { type: 'error', message: string }
 * Terminator: data: [DONE]
 */
import { defineEventHandler, sendStream, setResponseHeader, setResponseStatus } from 'h3';
import { neon } from '@neondatabase/serverless';
import { parseBody } from '../../utils/parse-body';
import {
  requireAgentAccess,
  incrementAgentUsage,
  AGENT_PLAN_LIMITS,
  STUDIO_IMAGEN_PLANS,
} from '../../utils/agent-auth';
import { getGeminiFlash, getVertexAI } from '../../utils/gcp-clients';
import { getChannelProfile } from '../../utils/channel-profiles-db';
import { buildChannelContextBlock } from '../../utils/channel-analysis';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ALLOWED_PLANS = [
  'downloads',
  'api-lite', 'api-elite', 'api-flite',
  'bq-researcher', 'bq-professional', 'bq-commercial',
];

type StudioMode = 'match' | 'player';
type StudioFormat = 'script' | 'hooks' | 'full';

// ── Typed interfaces for Imagen preview API ───────────────────────────────────

interface ImageGenerationModel {
  generateImages(args: {
    prompt: string;
    numberOfImages: number;
    aspectRatio?: string;
  }): Promise<{ images: Array<{ imageBytes: string }> }>;
}

interface VertexPreview {
  getImageGenerationModel(args: { model: string }): ImageGenerationModel;
}

// ── Data types ────────────────────────────────────────────────────────────────

interface MatchContext {
  id: string;
  date: string;
  home_team: string;
  away_team: string;
  home_score: number;
  away_score: number;
  league_name: string;
  season_name: string;
  performers: Array<{
    player_name: string;
    goals: number;
    assists: number;
    xg: number;
    mins_played: number;
    side: string;
  }>;
}

interface PlayerContext {
  display_name: string;
  position: string;
  team_name: string;
  league_name: string;
  season_name: string;
  matches_played: number;
  goals: number;
  assists: number;
  xg: number;
  goals_per_90: number;
  assists_per_90: number;
  xg_per_90: number;
  pass_accuracy: number;
  drib_per_90: number;
  prog_per_90: number;
  recent_form: Array<{
    date: string;
    goals: number;
    assists: number;
    xg: number;
    mins: number;
    opponent: string;
  }>;
}

// ── MCP Agent Bridge & Native Function Calling ──────────────────────────────

async function executeMcpTool(name: string, args: Record<string, unknown>): Promise<string> {
  let mcpData = '';
  try {
    const transport = new StdioClientTransport({
      command: "node",
      args: ["mcp/index.mjs"]
    });
    const client = new Client({ name: "studio-agent", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    
    const res = await client.callTool({ name, arguments: args });
    mcpData = res.content[0].text;
    
    setTimeout(() => { try { transport.close(); } catch {} }, 100);
  } catch (err) {
    console.error(`MCP Tool Error (${name}):`, err);
    mcpData = `Error executing ${name}`;
  }
  return mcpData;
}

const MCP_TOOLS = [
  {
    functionDeclarations: [
      {
        name: "get_team_matches",
        description: "Get recent match results, scores, and opposition for a specific team.",
        parameters: {
          type: "OBJECT",
          properties: {
            teamName: { type: "STRING", description: "Name of the team (e.g. Arsenal)" },
            limit: { type: "NUMBER", description: "Number of matches (e.g. 5)" }
          },
          required: ["teamName"]
        }
      },
      {
        name: "get_match_events",
        description: "Get the granular timeline of events (goals, cards, subs) for a specific match.",
        parameters: {
          type: "OBJECT",
          properties: {
            matchId: { type: "STRING", description: "The unique match ID" }
          },
          required: ["matchId"]
        }
      },
      {
        name: "get_player_stats",
        description: "Get basic player statistics, profile, and current team by player name.",
        parameters: {
          type: "OBJECT",
          properties: {
            playerName: { type: "STRING", description: "Name of the player" }
          },
          required: ["playerName"]
        }
      }
    ]
  }
];

// ── Data fetchers ─────────────────────────────────────────────────────────────

async function fetchMatchContext(matchId: string): Promise<MatchContext | null> {
  const sql = neon(process.env['NEON_DATABASE_URL'] ?? '');

  const matchRows = await sql`
    SELECT
      m.id::text                    AS id,
      m.date::text                  AS date,
      ht.name                       AS home_team,
      at.name                       AS away_team,
      COALESCE(m.home_score, 0)     AS home_score,
      COALESCE(m.away_score, 0)     AS away_score,
      COALESCE(l.name, 'Unknown')   AS league_name,
      COALESCE(s.name, 'Unknown')   AS season_name
    FROM matches m
    JOIN teams ht ON ht.id = m.home_team_id
    JOIN teams at ON at.id = m.away_team_id
    LEFT JOIN seasons s  ON s.id = m.season_id
    LEFT JOIN leagues l  ON l.id = s.league_id
    WHERE m.id = ${matchId}
      AND m.status::text = 'PLAYED'
  ` as Array<Record<string, unknown>>;

  if (!matchRows.length) return null;
  const match = matchRows[0]!;

  const performers = await sql`
    SELECT
      COALESCE(p.known_name, p.short_name, p.name)       AS player_name,
      COALESCE(pm.goals, 0)                               AS goals,
      COALESCE(pm.goal_assist, 0)                         AS assists,
      ROUND(COALESCE(pm.expected_goals, 0)::numeric, 2)   AS xg,
      COALESCE(pm.mins_played, 0)                         AS mins_played,
      pm.side
    FROM player_matches pm
    JOIN players p ON p.id = pm.player_id
    WHERE pm.match_id = ${matchId}
      AND (
        COALESCE(pm.goals, 0) > 0
        OR COALESCE(pm.goal_assist, 0) > 0
        OR COALESCE(pm.expected_goals, 0) > 0.4
      )
    ORDER BY pm.goals DESC NULLS LAST, pm.expected_goals DESC NULLS LAST
    LIMIT 12
  ` as Array<Record<string, unknown>>;

  return {
    id: String(match['id']),
    date: String(match['date']),
    home_team: String(match['home_team']),
    away_team: String(match['away_team']),
    home_score: Number(match['home_score']),
    away_score: Number(match['away_score']),
    league_name: String(match['league_name']),
    season_name: String(match['season_name']),
    performers: performers.map(p => ({
      player_name: String(p['player_name'] ?? ''),
      goals:       Number(p['goals']),
      assists:     Number(p['assists']),
      xg:          Number(p['xg']),
      mins_played: Number(p['mins_played']),
      side:        String(p['side'] ?? ''),
    })),
  };
}

async function fetchPlayerContext(playerId: string): Promise<PlayerContext | null> {
  const sql = neon(process.env['NEON_DATABASE_URL'] ?? '');

  const playerRows = await sql`
    SELECT
      COALESCE(p.known_name, p.short_name, p.name)              AS display_name,
      pst.most_played_position                                   AS position,
      COALESCE(det.team_name, 'Unknown')                         AS team_name,
      COALESCE(det.league_name, 'Unknown')                       AS league_name,
      COALESCE(det.season_name, 'Unknown')                       AS season_name,
      pst.matches_played,
      COALESCE(pst.goals, 0)                                     AS goals,
      COALESCE(pst.goal_assist, 0)                               AS assists,
      ROUND(COALESCE(pst.expected_goals, 0)::numeric, 2)         AS xg,
      ROUND(COALESCE(pst.goals_per_90, 0)::numeric, 2)           AS goals_per_90,
      ROUND(COALESCE(pst.goal_assist_per_90, 0)::numeric, 2)     AS assists_per_90,
      ROUND(COALESCE(pst.expected_goals_per_90, 0)::numeric, 2)  AS xg_per_90,
      ROUND(COALESCE(pst.pass_accuracy, 0)::numeric, 1)          AS pass_accuracy,
      ROUND(COALESCE(pst.successful_dribbles_per_90, 0)::numeric, 2) AS drib_per_90,
      ROUND(COALESCE(pst.progressive_carries_per_90, 0)::numeric, 2) AS prog_per_90
    FROM player_season_totals_mv pst
    JOIN players p ON p.id = pst.player_id
    LEFT JOIN LATERAL (
      SELECT team_name, league_name, season_name
      FROM player_season_detailed_mv
      WHERE player_id = pst.player_id AND is_latest = true
      LIMIT 1
    ) det ON true
    WHERE pst.player_id = ${playerId}
    ORDER BY det.season_name DESC NULLS LAST
    LIMIT 1
  ` as Array<Record<string, unknown>>;

  if (!playerRows.length) return null;
  const player = playerRows[0]!;

  const form = await sql`
    SELECT
      m.date::text                                        AS date,
      COALESCE(pm.goals, 0)::int                         AS goals,
      COALESCE(pm.goal_assist, 0)::int                   AS assists,
      ROUND(COALESCE(pm.expected_goals, 0)::numeric, 2)  AS xg,
      COALESCE(pm.mins_played, 0)::int                   AS mins,
      opp.name                                           AS opponent
    FROM player_matches pm
    JOIN matches m ON m.id = pm.match_id
    LEFT JOIN teams opp ON opp.id = (
      CASE WHEN m.home_team_id IN (
        SELECT team_id FROM player_season_detailed_mv
        WHERE player_id = ${playerId} AND is_latest = true LIMIT 1
      ) THEN m.away_team_id ELSE m.home_team_id END
    )
    WHERE pm.player_id = ${playerId}
      AND m.status::text = 'PLAYED'
    ORDER BY m.date DESC
    LIMIT 5
  ` as Array<Record<string, unknown>>;

  return {
    display_name: String(player['display_name'] ?? 'Player'),
    position:     String(player['position'] ?? ''),
    team_name:    String(player['team_name']),
    league_name:  String(player['league_name']),
    season_name:  String(player['season_name']),
    matches_played: Number(player['matches_played'] ?? 0),
    goals:        Number(player['goals']),
    assists:      Number(player['assists']),
    xg:           Number(player['xg']),
    goals_per_90: Number(player['goals_per_90']),
    assists_per_90: Number(player['assists_per_90']),
    xg_per_90:    Number(player['xg_per_90']),
    pass_accuracy: Number(player['pass_accuracy']),
    drib_per_90:  Number(player['drib_per_90']),
    prog_per_90:  Number(player['prog_per_90']),
    recent_form: form.map(r => ({
      date:     String(r['date'] ?? ''),
      goals:    Number(r['goals']),
      assists:  Number(r['assists']),
      xg:       Number(r['xg']),
      mins:     Number(r['mins']),
      opponent: String(r['opponent'] ?? 'Unknown'),
    })),
  };
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildMatchPrompt(ctx: MatchContext, format: StudioFormat, channelCtx: string | null): string {
  const score = `${ctx.home_team} ${ctx.home_score}–${ctx.away_score} ${ctx.away_team}`;
  const performerLines = ctx.performers.slice(0, 8).map(p => {
    const stats: string[] = [];
    if (p.goals > 0)   stats.push(`${String(p.goals)}G`);
    if (p.assists > 0) stats.push(`${String(p.assists)}A`);
    if (p.xg > 0)      stats.push(`${String(p.xg)} xG`);
    return `  • ${p.player_name} (${p.side}): ${stats.length > 0 ? stats.join(' ') : '—'}`;
  }).join('\n');

  const dataBlock = `Match: ${score}
League: ${ctx.league_name} | Season: ${ctx.season_name} | Date: ${ctx.date}

Key performers:
${performerLines || '  (no standout performers recorded)'}`;

  const sep = channelCtx ? `\n\n${channelCtx}\n` : '';

  if (format === 'script') {
    return `You are a football YouTube content creator with 1M+ subscribers, known for sharp data-driven breakdowns.

${dataBlock}${sep}

Write a 90-second voiceover script (≈200 words) for a match breakdown video. Lead with the most dramatic narrative hook. Cite at least 3 specific stats from the data. End with a question that drives comment debate. Energetic, authoritative tone — no hedging.`;
  }

  if (format === 'hooks') {
    return `You are a football YouTube content creator specialising in Shorts and viral clips.

${dataBlock}${sep}

Write exactly 3 YouTube Shorts hooks (first 3 seconds each). Each hook must be ≤15 words, open a curiosity loop, and create urgency. Number them 1, 2, 3.`;
  }

  return `You are a football YouTube content creator with 1M+ subscribers, known for sharp data-driven breakdowns.

${dataBlock}${sep}

Generate a complete content package for this match:

## VOICEOVER SCRIPT
90-second script (≈200 words). Most dramatic hook first. Cite specific stats. End with a comment-driving question.

## SHORTS HOOKS
3 Shorts hooks (≤15 words each, first 3 seconds). Numbered 1–3.

## TITLE SUGGESTIONS
5 YouTube titles. Mix curiosity gaps, number hooks, and emotional triggers. One per line, strongest first.

## THUMBNAIL CAPTION
One bold text overlay (≤6 words, ALL CAPS, maximum visual impact).`;
}

function buildPlayerPrompt(ctx: PlayerContext, format: StudioFormat, channelCtx: string | null): string {
  const formStr = ctx.recent_form.map(r => {
    const stats: string[] = [];
    if (r.goals > 0)   stats.push(`${String(r.goals)}G`);
    if (r.assists > 0) stats.push(`${String(r.assists)}A`);
    return `${r.opponent}: ${stats.length > 0 ? stats.join(' ') : '—'} (${String(r.mins)}')`;
  }).join(' | ');

  const dataBlock = `Player: ${ctx.display_name} | ${ctx.position} | ${ctx.team_name}
League: ${ctx.league_name} | Season: ${ctx.season_name}
Season totals: ${String(ctx.matches_played)} apps · ${String(ctx.goals)}G ${String(ctx.assists)}A · ${String(ctx.xg)} xG
Per 90: ${String(ctx.goals_per_90)} G · ${String(ctx.assists_per_90)} A · ${String(ctx.xg_per_90)} xG · ${String(ctx.pass_accuracy)}% pass acc · ${String(ctx.drib_per_90)} drib · ${String(ctx.prog_per_90)} prog
Last 5: ${formStr || 'no recent data'}`;

  const sep = channelCtx ? `\n\n${channelCtx}\n` : '';

  if (format === 'script') {
    return `You are a football YouTube content creator with 1M+ subscribers, known for sharp data-driven player breakdowns.

${dataBlock}${sep}

Write a 90-second voiceover script (≈200 words) making a clear case about this player's current form. Lead with their single most impressive stat. Compare to a known benchmark where possible. End with a question driving comment debate. Bold, direct, no hedging.`;
  }

  if (format === 'hooks') {
    return `You are a football YouTube content creator specialising in Shorts and viral clips.

${dataBlock}${sep}

Write exactly 3 YouTube Shorts hooks (first 3 seconds each) about this player. Each hook ≤15 words, opens a curiosity loop. Mix "hot take" style, stat-shock style, and comparison style (e.g. "Is he better than X?"). Numbered 1–3.`;
  }

  return `You are a football YouTube content creator with 1M+ subscribers, known for sharp data-driven player breakdowns.

${dataBlock}${sep}

Generate a complete content package for this player:

## VOICEOVER SCRIPT
90-second script (≈200 words). Lead with the most impressive stat. Make a clear argument (elite / underrated / overrated / red-hot / ice-cold). End with a comment-driving question.

## SHORTS HOOKS
3 Shorts hooks (≤15 words each, first 3 seconds). Mix hot-take, stat-shock, comparison. Numbered 1–3.

## TITLE SUGGESTIONS
5 YouTube titles about this player. Mix curiosity gaps, hot takes, stat-shocks. One per line, strongest first.

## THUMBNAIL CAPTION
One bold text overlay (≤6 words, ALL CAPS, maximum visual impact).`;
}

// ── Imagen 3 thumbnail generation ────────────────────────────────────────────

async function generateThumbnail(
  subject: string,
  imagenEligible: boolean,
): Promise<{ prompt: string; image_base64?: string }> {
  const model = getGeminiFlash();
  const resp = await model.generateContent({
    contents: [{
      role: 'user',
      parts: [{
        text: `Generate a vivid, cinematic image-generation prompt for a YouTube football thumbnail about: ${subject}

Requirements: dramatic stadium atmosphere, intense emotion, photorealistic, 16:9 composition. Max 180 characters. Return ONLY the prompt text — no explanation.`,
      }],
    }],
    generationConfig: { maxOutputTokens: 200, temperature: 0.8 },
  });

  const prompt = (resp.response.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
  if (!prompt) return { prompt: '' };
  if (!imagenEligible) return { prompt };

  try {
    const preview = (getVertexAI() as unknown as { preview: VertexPreview }).preview;
    const imageModel = preview.getImageGenerationModel({ model: 'imagen-3.0-generate-002' });
    const imageResp = await imageModel.generateImages({
      prompt,
      numberOfImages: 1,
      aspectRatio: '16:9',
    });
    const imageBytes = imageResp.images[0]?.imageBytes;
    if (imageBytes) return { prompt, image_base64: imageBytes };
  } catch {
    // Imagen unavailable — return prompt only so the rest of the response isn't broken
  }

  return { prompt };
}

// ── Route handler ─────────────────────────────────────────────────────────────

export default defineEventHandler(async (event) => {
  let identity: Awaited<ReturnType<typeof requireAgentAccess>>;
  try {
    identity = await requireAgentAccess(event, ALLOWED_PLANS);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  const dailyLimit = AGENT_PLAN_LIMITS['studio']?.[identity.plan] ?? 0;
  const usage = await incrementAgentUsage(identity.email, 'studio');
  if (usage > dailyLimit) {
    setResponseStatus(event, 429);
    return {
      error: `Daily studio-agent limit of ${dailyLimit} reached for plan "${identity.plan}". Resets at midnight UTC.`,
      code: 'RATE_LIMIT',
    };
  }

  const body = await parseBody(event.node.req);
  const mode  = typeof body['mode'] === 'string' ? body['mode'] as StudioMode : null;
  const id    = typeof body['id']   === 'string' ? body['id'].trim()          : '';
  const fmt   = typeof body['format'] === 'string' ? body['format'] as StudioFormat : 'full';

  if (mode !== 'match' && mode !== 'player') {
    setResponseStatus(event, 400);
    return { error: 'mode must be "match" or "player".' };
  }
  if (!id) {
    setResponseStatus(event, 400);
    return { error: 'id is required.' };
  }
  if (fmt !== 'script' && fmt !== 'hooks' && fmt !== 'full') {
    setResponseStatus(event, 400);
    return { error: 'format must be "script", "hooks", or "full".' };
  }

  const capturedIdentity = identity;
  const capturedUsage    = usage;
  const capturedLimit    = dailyLimit;
  const imagenEligible   = STUDIO_IMAGEN_PLANS.has(identity.plan);

  // Fetch channel profile for audience-calibrated prompts
  let channelCtx: string | null = null;
  try {
    const channelProfile = await getChannelProfile(identity.email);
    if (channelProfile) channelCtx = buildChannelContextBlock(channelProfile);
  } catch { /* continue without channel context */ }

  setResponseHeader(event, 'content-type',   'text/event-stream');
  setResponseHeader(event, 'cache-control',  'no-cache, no-transform');
  setResponseHeader(event, 'connection',     'keep-alive');
  setResponseHeader(event, 'x-accel-buffering', 'no');

  return sendStream(event, new ReadableStream({
    async start(controller) {
      const enc = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

      try {
        // ── Step 1: Fetch context data ────────────────────────────────────────
        controller.enqueue(enc({ type: 'thinking', text: `Fetching ${mode} data...` }));

        let matchCtx: MatchContext | null = null;
        let playerCtx: PlayerContext | null = null;

        if (mode === 'match') {
          matchCtx = await fetchMatchContext(id);
          if (!matchCtx) {
            controller.enqueue(enc({ type: 'error', message: `Match "${id}" not found or not yet played.` }));
            controller.enqueue('data: [DONE]\n\n');
            controller.close();
            return;
          }
          controller.enqueue(enc({ type: 'context', data: {
            id:         matchCtx.id,
            date:       matchCtx.date,
            home_team:  matchCtx.home_team,
            away_team:  matchCtx.away_team,
            home_score: matchCtx.home_score,
            away_score: matchCtx.away_score,
            league:     matchCtx.league_name,
            season:     matchCtx.season_name,
            performers: matchCtx.performers.length,
          } }));
        } else {
          playerCtx = await fetchPlayerContext(id);
          if (!playerCtx) {
            controller.enqueue(enc({ type: 'error', message: `Player "${id}" not found in the database.` }));
            controller.enqueue('data: [DONE]\n\n');
            controller.close();
            return;
          }
          controller.enqueue(enc({ type: 'context', data: {
            display_name:   playerCtx.display_name,
            position:       playerCtx.position,
            team:           playerCtx.team_name,
            league:         playerCtx.league_name,
            season:         playerCtx.season_name,
            matches_played: playerCtx.matches_played,
          } }));
        }

        // ── Step 2: Generate content via Gemini (ADK Tool Loop) ───────────────────
        const formatLabel = fmt === 'full'
          ? 'full content package'
          : fmt === 'script' ? 'voiceover script' : 'Shorts hooks';
        
        controller.enqueue(enc({ type: 'thinking', text: `Initializing ADK Agent...` }));

        const prompt = mode === 'match'
          ? buildMatchPrompt(matchCtx!, fmt, channelCtx)
          : buildPlayerPrompt(playerCtx!, fmt, channelCtx);

        const gemini = getGeminiFlash();
        const chat = gemini.startChat({
          tools: MCP_TOOLS as any,
          generationConfig: { maxOutputTokens: 2500, temperature: 0.5 }
        });

        // 1. Initial Prompt
        controller.enqueue(enc({ type: 'thinking', text: `Analyzing request and determining necessary tools...` }));
        let result = await chat.sendMessage(prompt);
        let call = result.response.candidates?.[0]?.content?.parts?.find(p => p.functionCall)?.functionCall;

        // 2. ADK / MCP Tool Loop
        while (call) {
          const toolName = call.name;
          const toolArgs = call.args as Record<string, unknown>;
          controller.enqueue(enc({ type: 'thinking', text: `Agent executing MCP Tool: ${toolName}...` }));
          
          const toolData = await executeMcpTool(toolName, toolArgs);
          
          controller.enqueue(enc({ type: 'thinking', text: `Evaluating tool data and planning next steps...` }));
          result = await chat.sendMessage([{
            functionResponse: {
              name: toolName,
              response: { result: toolData }
            }
          }]);
          call = result.response.candidates?.[0]?.content?.parts?.find(p => p.functionCall)?.functionCall;
        }

        controller.enqueue(enc({ type: 'thinking', text: `Writing ${formatLabel}...` }));

        // Send out the final text
        const text = result.response.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
        if (text) {
          // If the text was generated immediately after the tool calls
          controller.enqueue(enc({ type: 'token', text }));
        } else {
          // If we need a kick to finish
          const streamRes = await chat.sendMessageStream("Please provide the final formatted output based on all the data gathered.");
          for await (const chunk of streamRes.stream) {
            const chunkText = chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
            if (chunkText) controller.enqueue(enc({ type: 'token', text: chunkText }));
          }
        }

        // ── Step 3: Thumbnail generation (full format only) ───────────────────
        if (fmt === 'full') {
          controller.enqueue(enc({
            type: 'thinking',
            text: imagenEligible
              ? 'Generating thumbnail prompt and Imagen 3 image...'
              : 'Generating thumbnail prompt...',
          }));

          const subject = mode === 'match'
            ? `${matchCtx!.home_team} ${matchCtx!.home_score}–${matchCtx!.away_score} ${matchCtx!.away_team}, ${matchCtx!.league_name}`
            : `${playerCtx!.display_name}, ${playerCtx!.position} at ${playerCtx!.team_name}, ${playerCtx!.goals} goals this season`;

          const thumbnail = await generateThumbnail(subject, imagenEligible);
          controller.enqueue(enc({ type: 'thumbnail', ...thumbnail }));
        }

        // ── Done ──────────────────────────────────────────────────────────────
        controller.enqueue(enc({
          type: 'done',
          mode,
          format: fmt,
          imagen_eligible: imagenEligible,
          usage: {
            today: capturedUsage,
            limit: capturedLimit,
            plan:  capturedIdentity.plan,
          },
        }));
        controller.enqueue('data: [DONE]\n\n');
      } catch (err) {
        controller.enqueue(enc({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        }));
        controller.enqueue('data: [DONE]\n\n');
      } finally {
        controller.close();
      }
    },
  }));
});
