import { defineEventHandler, readBody, createError } from 'h3';
import { getGeminiFlash } from '../../utils/gcp-clients';

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const { prompt, headers, source } = body;

  if (!prompt || !headers || !Array.isArray(headers)) {
    throw createError({ statusCode: 400, message: 'Missing prompt or headers' });
  }

  const systemInstruction = `
You are the Dribble Studio "Slice & Dice" Data Analyst Agent.
Your job is to read the user's natural language request and map it to a chart configuration based on the provided CSV headers.
You must return a raw JSON object (no markdown formatting, no code blocks, just the JSON).

Schema:
{
  "chartType": "bar" | "line" | "scatter" | "radar" | "pie",
  "xColumn": "header_name",
  "yColumn": "header_name",
  "colorColumn": "header_name" (or ""),
  "sizeColumn": "header_name" (or ""),
  "insight": "A 1-2 sentence analytical insight explaining what this specific chart will reveal."
}

Available Headers:
${headers.join(', ')}

Data Source context: ${source || 'Unknown CSV'}
`;

  try {
    const gemini = getGeminiFlash();
    const res = await gemini.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      systemInstruction: { role: 'system', parts: [{ text: systemInstruction }] },
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json"
      }
    });

    const text = res.response?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    return JSON.parse(text);
  } catch (err) {
    console.error("Slice & Dice Agent Error:", err);
    throw createError({ statusCode: 500, message: 'Agent failed to map prompt to chart.' });
  }
});
