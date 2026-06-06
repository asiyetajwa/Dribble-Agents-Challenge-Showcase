# Dribble Studio - Google AI Agents Challenge Showcase

**Track 1: Build (Net-New Agents)**

This repository is a partial, public extract of the commercial **Dribble Studio** SaaS platform, specifically compiled for the Google for Startups AI Agents Challenge 2026. 

Due to the commercial nature of our core product (UI, billing, and proprietary data syncs), the full repository remains private. This showcase repository contains the specific backend architectural components that demonstrate our adherence to the Track 1 requirements: **Moving from static code to declarative intent using the Agent Development Kit (ADK) and the Model Context Protocol (MCP).**

## Repository Contents

*   **`architecture.md`**: Contains the Mermaid.js code detailing the full system architecture and data flow.
*   **`mcp/`**: Contains the standalone Dribble Studio MCP Server (`index.mjs`) which securely exposes our 38.7M Opta event database to Gemini via discrete tools (`get_match_events`, `get_team_matches`, `get_player_stats`).
*   **`server/api/agents/`**: Contains the Nuxt 3 backend routes acting as the Context Bridge. These files (e.g. `studio.post.ts`) demonstrate the native Gemini Function Calling loop using `startChat` and `tools`, proving the agent's autonomous execution.
*   **`scripts/`**: Contains our `record-demo.mjs` Playwright script, demonstrating how we automated our end-to-end testing pipeline for these new agents.

## Testing Access

Judges can bypass our Stripe paywall and free-tier limits to test the full commercial product live using this specific backdoor link:

[https://dribble360.com/beta/studio?judge=google2026](https://dribble360.com/beta/studio?judge=google2026)

## Impact & Market Opportunity

- **800,000+** football YouTube channels globally — the vast majority run by solo creators
- A solo creator covering a top-5 league spends **8–14 hours per match** producing one long-form video (rewatching, manual stat research on FBref, scripting, thumbnailing)
- Studio compresses that to **under 10 minutes** for a complete content package
- **World Cup 2026:** 48 teams, 104 matches, June 11–July 19 — the highest-density football content production period in 4 years. Studio launches into peak demand.
- **Multiplier effect:** Competitor Radar and Pattern Mine surface underreported storylines, meaning more unique content across the ecosystem — not just faster content
- Direct goal contribution rate improvement: creators using data-grounded hooks see measurably higher CTR than generic match recap angles