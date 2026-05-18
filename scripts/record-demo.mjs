import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function recordDemo() {
  console.log("Launching browser for demo recording...");
  // Use headless false if possible, or add args to force software rendering if true, 
  // but for reliability in automation let's keep headless but ensure hydration waits.
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--use-gl=swiftshader'] // Force software WebGL so 3D charts render in headless
  });

  // Set up context with video recording enabled
  const context = await browser.newContext({
    recordVideo: {
      dir: path.join(__dirname, 'demo-videos'),
      size: { width: 1920, height: 1080 }
    },
    viewport: { width: 1920, height: 1080 },
  });

  const page = await context.newPage();

  try {
    console.log("Navigating to Dribble Studio (using Judge Bypass)...");
    await page.goto('http://localhost:3000/beta/studio?judge=google2026');
    await page.waitForTimeout(3000); // Wait for Vue hydration and auth cookie to settle

    console.log("Demoing Studio Feature...");
    // Type into the match search box (default mode)
    await page.waitForSelector('input.search-input', { timeout: 15000 });
    await page.fill('input.search-input', 'Arsenal');

    // Select the first search result
    await page.waitForSelector('.search-result-item');
    await page.click('.search-result-item:first-child');

    // Click "Generate"
    await page.waitForSelector('.tool-action-btn:has-text("Generate Voiceover Script")');
    await page.click('.tool-action-btn:has-text("Generate Voiceover Script")');

    // Wait for the stream to finish (when usage bar appears or stream ends)
    console.log("Waiting for ADK Agent to finish generating...");
    await page.waitForTimeout(10000); // Wait 10s for the stream to complete

    console.log("Navigating to Slice & Dice...");
    await page.goto('http://localhost:3000/beta/slice-and-dice', { waitUntil: 'domcontentloaded' });
    
    // Upload the sample CSV
    console.log("Uploading dataset...");
    await page.setInputFiles('input[type="file"]', path.join(__dirname, '../../sync_player_matches.csv'));
    await page.waitForTimeout(2000); // Give the UI time to parse the CSV

    // Type the AI prompt
    console.log("Prompting the ADK Data Analyst Agent...");
    await page.waitForSelector('input[placeholder*="Ask AI"]');
    await page.fill('input[placeholder*="Ask AI"]', 'Show Expected Goals against Actual Goals for Arsenal players');
    await page.keyboard.press('Enter');

    console.log("Waiting for Chart generation...");
    await page.waitForTimeout(8000); // Wait for the chart to render and insight to appear

  } catch (err) {
    console.error("Demo script encountered an error:", err);
  } finally {
    console.log("Closing context and saving video...");
    await context.close();
    await browser.close();
    console.log(`Video saved to ${path.join(__dirname, 'demo-videos')}`);
  }
}

recordDemo().catch(console.error);
