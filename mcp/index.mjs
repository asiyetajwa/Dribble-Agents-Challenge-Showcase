import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import pg from 'pg';
import dotenv from 'dotenv';
const { Pool } = pg;

// Load environment variables if running locally outside Nuxt
dotenv.config();

// Connect to Neon PostgreSQL using the existing workspace credentials
const pool = new Pool({
  connectionString: process.env.NEON_PRIVATE_DATABASE_URL || 'postgresql://neondb_owner:npg_ItYjobSC76HB@ep-sparkling-star-afp7tfws-pooler.c-2.us-west-2.aws.neon.tech/neondb?sslmode=require'
});

const server = new Server({
  name: "dribble-studio-mcp",
  version: "1.0.0"
}, {
  capabilities: {
    tools: {}
  }
});

// Expose our tools to the LLM agent
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_player_stats",
        description: "Get basic player statistics, profile, and current team by player name.",
        inputSchema: {
          type: "object",
          properties: {
            playerName: { type: "string", description: "Name of the player to search for" }
          },
          required: ["playerName"]
        }
      },
      {
        name: "get_team_matches",
        description: "Get recent match results, scores, and opposition for a specific team.",
        inputSchema: {
          type: "object",
          properties: {
            teamName: { type: "string", description: "Name of the team (e.g. Arsenal, Chelsea, Real Madrid)" },
            limit: { type: "number", description: "Number of matches to return (default 5, max 20)" }
          },
          required: ["teamName"]
        }
      },
      {
        name: "get_match_events",
        description: "Get the granular timeline of events (goals, cards, subs) for a specific match. Use get_team_matches first to find the match_id.",
        inputSchema: {
          type: "object",
          properties: {
            matchId: { type: "string", description: "The unique match ID" }
          },
          required: ["matchId"]
        }
      }
    ]
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "get_player_stats") {
      const { playerName } = args;
      const res = await pool.query(`SELECT * FROM players WHERE name ILIKE $1 LIMIT 5`, [`%${playerName}%`]);
      return {
        content: [{ type: "text", text: JSON.stringify(res.rows, null, 2) }]
      };
    }

    if (name === "get_team_matches") {
      const { teamName, limit = 5 } = args;
      const safeLimit = Math.min(Math.max(1, limit), 20); // Cap at 20
      const res = await pool.query(`
        SELECT m.id as match_id, m.date as match_date,
               t.name as queried_team, tm.side as side,
               m.home_score, m.away_score, m.winner
        FROM teams t
        JOIN team_matches tm ON t.id = tm.team_id
        JOIN matches m ON tm.match_id = m.id
        WHERE t.name ILIKE $1
        ORDER BY m.date DESC
        LIMIT $2
      `, [`%${teamName}%`, safeLimit]);
      return {
        content: [{ type: "text", text: JSON.stringify(res.rows, null, 2) }]
      };
    }

    if (name === "get_match_events") {
      const { matchId } = args;
      const res = await pool.query(`
        SELECT time_min, time_sec, type, team_id, player_id, outcome
        FROM match_events 
        WHERE match_id = $1 
        ORDER BY time_min ASC, time_sec ASC
        LIMIT 100
      `, [matchId]);
      return {
        content: [{ type: "text", text: JSON.stringify(res.rows, null, 2) }]
      };
    }

    throw new Error(`Tool not found: ${name}`);
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error executing tool ${name}: ${error.message}` }],
      isError: true
    };
  }
});

// Connect stdio transport so the host agent can interact via stdin/stdout
async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Dribble Studio MCP Server running on stdio");
}

run().catch(console.error);
