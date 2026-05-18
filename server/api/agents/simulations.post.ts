import { defineEventHandler, readBody, createError } from 'h3';
import { getGeminiFlash } from '../../utils/gcp-clients';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const { homeTeam, awayTeam, homeId, awayId } = body;

  if (!homeTeam || !awayTeam) {
    throw createError({ statusCode: 400, message: 'Missing team names' });
  }

  // MCP Context Gathering
  let mcpContext = '';
  try {
    const transport = new StdioClientTransport({ command: "node", args: ["mcp/index.mjs"] });
    const client = new Client({ name: "simulations-agent", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    
    const hRes = await client.callTool({ name: "get_team_matches", arguments: { teamName: homeTeam, limit: 3 } });
    const aRes = await client.callTool({ name: "get_team_matches", arguments: { teamName: awayTeam, limit: 3 } });
    
    mcpContext = `Recent Matches - ${homeTeam}:\n${hRes.content[0].text}\n\nRecent Matches - ${awayTeam}:\n${aRes.content[0].text}`;
    
    setTimeout(() => { try { transport.close(); } catch {} }, 100);
  } catch (err) {
    console.error("MCP Context failed in Simulations:", err);
    mcpContext = "Recent match data unavailable.";
  }

  const systemInstruction = `
You are the Dribble Studio "Monte Carlo Match Producer".
Your job is to analyze the recent form of the two teams and provide simulation modifiers to our Poisson engine, plus a narrative insight.
Return a pure JSON object (no markdown, no backticks).

Schema:
{
  "homeModifier": float (default 1.0. Increase to 1.15 if home team is in great form, decrease if poor form),
  "awayModifier": float (default 1.0. Increase to 1.15 if away team is in great form),
  "narrative": "A 2-3 sentence engaging pre-match narrative explaining WHY the simulation modifiers were adjusted (e.g. recent form, tactical matchups)."
}

MCP Context Data:
${mcpContext}
`;

  try {
    const gemini = getGeminiFlash();
    const res = await gemini.generateContent({
      contents: [{ role: 'user', parts: [{ text: `Analyze the upcoming match: ${homeTeam} (Home) vs ${awayTeam} (Away).` }] }],
      systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
      generationConfig: { temperature: 0.4, responseMimeType: "application/json" }
    });

    const text = res.response?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    return JSON.parse(text);
  } catch (err) {
    console.error("Simulations Agent Error:", err);
    return { homeModifier: 1.0, awayModifier: 1.0, narrative: "Agent unavailable. Falling back to standard Poisson distribution." };
  }
});
