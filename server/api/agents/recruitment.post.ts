import { defineEventHandler, readBody, createError } from 'h3';
import { getGeminiFlash } from '../../utils/gcp-clients';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const { prompt } = body;

  if (!prompt) {
    throw createError({ statusCode: 400, message: 'Missing recruitment prompt' });
  }

  // MCP Context Gathering: use player stats to find matches for the prompt
  // For the challenge demo, we will pass the user prompt to Gemini, have Gemini figure out 3 names,
  // then pull their stats via MCP to ground the report.
  
  let playerNames: string[] = [];
  try {
    const gemini = getGeminiFlash();
    const res = await gemini.generateContent({
      contents: [{ role: 'user', parts: [{ text: `Based on this recruitment request: "${prompt}", identify 3 real-world football players who perfectly fit this profile. Return ONLY a JSON array of their full names.` }] }],
      generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
    });
    playerNames = JSON.parse(res.response?.candidates?.[0]?.content?.parts?.[0]?.text || '[]');
  } catch (err) {
    playerNames = ["Sven Botman", "William Saliba", "Ruben Dias"]; // fallback
  }

  let mcpContext = '';
  try {
    const transport = new StdioClientTransport({ command: "node", args: ["mcp/index.mjs"] });
    const client = new Client({ name: "scout-agent", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    
    for (const name of playerNames) {
      const res = await client.callTool({ name: "get_player_stats", arguments: { playerName: name } });
      mcpContext += `\nPlayer: ${name}\nStats:\n${res.content[0].text}\n`;
    }
    
    setTimeout(() => { try { transport.close(); } catch {} }, 100);
  } catch (err) {
    console.error("MCP Context failed in Scout Pen:", err);
    mcpContext = "Data unavailable.";
  }

  const systemInstruction = `
You are the "AI Director of Football" Agent.
Based on the user's recruitment prompt and the grounded MCP stats provided, write a comparative scouting report shortlisting the 3 players.
Return a pure JSON object (no markdown, no backticks).

Schema:
{
  "shortlist": [
    { "name": "string", "team": "string", "fitScore": "string (e.g. 92/100)", "tacticalFit": "1-2 sentences on why they fit the prompt" }
  ],
  "executiveSummary": "A paragraph summarizing the strategy and the recommended primary target."
}

MCP Context Data:
${mcpContext}
`;

  try {
    const gemini = getGeminiFlash();
    const res = await gemini.generateContent({
      contents: [{ role: 'user', parts: [{ text: `Recruitment Prompt: ${prompt}` }] }],
      systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
      generationConfig: { temperature: 0.4, responseMimeType: "application/json" }
    });

    const text = res.response?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    return JSON.parse(text);
  } catch (err) {
    console.error("Scout Pen Agent Error:", err);
    throw createError({ statusCode: 500, message: 'Agent failed to generate recruitment report.' });
  }
});
