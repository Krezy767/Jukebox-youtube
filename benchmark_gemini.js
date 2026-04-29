
require('dotenv').config();
const axios = require('axios');

const key = process.env.GEMINI_API_KEY;
const models = [
  'gemini-2.0-flash-exp', // Real model name as of late 2024
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-2.5-flash-lite', // User mentioned
  'gemini-3.1-flash-lite-preview' // User mentioned
];

const prompt = "Give me 10 tracks for Organic House vibe mixed with Chill Deep House. Return ONLY a JSON array of objects with 'artist' and 'title'.";

async function testModel(modelId) {
  const startTime = Date.now();
  console.log(`Testing model: ${modelId}...`);
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${key}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.7
        }
      },
      { timeout: 30000 }
    );
    const duration = (Date.now() - startTime) / 1000;
    const tracks = JSON.parse(response.data.candidates[0].content.parts[0].text);
    console.log(`✅ ${modelId}: Success. ${tracks.length} tracks in ${duration}s`);
    return { modelId, success: true, duration, count: tracks.length };
  } catch (err) {
    const duration = (Date.now() - startTime) / 1000;
    const errorMsg = err.response?.data?.error?.message || err.message;
    console.log(`❌ ${modelId}: Failed after ${duration}s. Error: ${errorMsg}`);
    return { modelId, success: false, duration, error: errorMsg };
  }
}

async function runBenchmarks() {
  const results = [];
  for (const model of models) {
    results.push(await testModel(model));
  }
  console.table(results);
}

runBenchmarks();
