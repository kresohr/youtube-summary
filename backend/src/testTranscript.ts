/**
 * Standalone test script to verify transcript fetching works.
 * No database connection required — only tests the YouTube transcript pipeline.
 *
 * Usage:  npx tsx src/testTranscript.ts
 *   or:  npm run test:transcript
 */

import { transcribeVideo, extractVideoId } from "./jobs/youtubeTranscript.js";

const TEST_VIDEO_ID = "dQw4w9WgXcQ"; // Rick Astley — guaranteed captions
const TEST_VIDEO_URL = `https://www.youtube.com/watch?v=${TEST_VIDEO_ID}`;

async function main(): Promise<void> {
  console.log("=== YouTube Transcript Test ===\n");

  // --- Test 1: extractVideoId ---
  console.log("Test 1: extractVideoId()");
  const testCases: [string, string | null][] = [
    [TEST_VIDEO_URL, TEST_VIDEO_ID],
    [`https://youtu.be/${TEST_VIDEO_ID}`, TEST_VIDEO_ID],
    [TEST_VIDEO_ID, TEST_VIDEO_ID],
    ["not-a-url", null],
  ];

  let allPassed = true;
  for (const [input, expected] of testCases) {
    const result = extractVideoId(input);
    const ok = result === expected;
    console.log(
      `  ${ok ? "✓" : "✗"} extractVideoId("${input}") => "${result}" ${ok ? "" : `(expected "${expected}")`}`
    );
    if (!ok) allPassed = false;
  }
  console.log();

  // --- Test 2: transcribeVideo with full URL ---
  console.log(`Test 2: transcribeVideo("${TEST_VIDEO_URL}")`);
  try {
    const segments = await transcribeVideo(TEST_VIDEO_URL);

    if (!segments || segments.length === 0) {
      console.error("  ✗ FAIL: No segments returned");
      allPassed = false;
    } else {
      const fullText = segments.map((s: { text: string }) => s.text).join(" ");
      console.log(
        `  ✓ OK: ${segments.length} segments, ${fullText.length} chars`
      );
      console.log(`  Preview: "${fullText.substring(0, 200)}..."\n`);
    }
  } catch (error) {
    const errName = error instanceof Error ? error.constructor.name : "Unknown";
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`  ✗ FAIL [${errName}]: ${errMsg}`);
    allPassed = false;
  }

  // --- Test 3: transcribeVideo with just video ID ---
  console.log(`Test 3: transcribeVideo("${TEST_VIDEO_ID}") — raw ID`);
  try {
    const segments = await transcribeVideo(TEST_VIDEO_ID);

    if (!segments || segments.length === 0) {
      console.error("  ✗ FAIL: No segments returned");
      allPassed = false;
    } else {
      const fullText = segments.map((s: { text: string }) => s.text).join(" ");
      console.log(
        `  ✓ OK: ${segments.length} segments, ${fullText.length} chars`
      );
      console.log(`  Preview: "${fullText.substring(0, 200)}..."\n`);
    }
  } catch (error) {
    const errName = error instanceof Error ? error.constructor.name : "Unknown";
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`  ✗ FAIL [${errName}]: ${errMsg}`);
    allPassed = false;
  }

  // --- Test 4: previously-failing video (ANDROID client returned no captions) ---
  const FAILING_VIDEO_ID = "5B8N8eDv5iE"; // "I hate what programming has become"
  console.log(
    `Test 4: transcribeVideo("${FAILING_VIDEO_ID}") — previously failing with ANDROID client`
  );
  try {
    const segments = await transcribeVideo(FAILING_VIDEO_ID);

    if (!segments || segments.length === 0) {
      console.error("  ✗ FAIL: No segments returned");
      allPassed = false;
    } else {
      const fullText = segments.map((s: { text: string }) => s.text).join(" ");
      console.log(
        `  ✓ OK: ${segments.length} segments, ${fullText.length} chars`
      );
      console.log(`  Preview: "${fullText.substring(0, 200)}..."\n`);
    }
  } catch (error) {
    const errName = error instanceof Error ? error.constructor.name : "Unknown";
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`  ✗ FAIL [${errName}]: ${errMsg}`);
    allPassed = false;
  }

  // --- Test 5: multi-language video — exercises ANDROID InnerTube fallback + language ranking ---
  // Gangnam Style has many translated caption tracks; the ranking logic should prefer
  // the English ASR track when no manual English track exists.
  // Previously this test targeted TubeText; TubeText is no longer operational and has
  // been replaced by the InnerTube ANDROID/WEB fallback as the second fallback method.
  const MULTILANG_VIDEO_ID = "9bZkp7q19f0"; // PSY — Gangnam Style (global availability guaranteed)
  console.log(
    `Test 5: transcribeVideo("${MULTILANG_VIDEO_ID}") — multi-language video, InnerTube fallback`
  );
  try {
    const segments = await transcribeVideo(MULTILANG_VIDEO_ID);

    if (!segments || segments.length === 0) {
      console.error("  ✗ FAIL: No segments returned");
      allPassed = false;
    } else {
      const fullText = segments.map((s: { text: string }) => s.text).join(" ");
      console.log(
        `  ✓ OK: ${segments.length} segments, ${fullText.length} chars`
      );
      console.log(`  Preview: "${fullText.substring(0, 200)}..."\n`);
    }
  } catch (error) {
    const errName = error instanceof Error ? error.constructor.name : "Unknown";
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`  ✗ FAIL [${errName}]: ${errMsg}`);
    allPassed = false;
  }

  // --- Result ---
  console.log("=== Result ===");
  if (allPassed) {
    console.log("All tests PASSED ✓");
    process.exit(0);
  } else {
    console.log("Some tests FAILED ✗");
    process.exit(1);
  }
}

main();
