const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

async function getAIReply(question) {
  const API_KEY = process.env.VIBE_API_KEY;
  const API_URL = process.env.VIBE_API_URL || "https://api.vibe.ai/v1/chat";

  if (!API_KEY) {
    throw new Error("VIBE_API_KEY is missing in .env");
  }

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: question,
          },
        ],
        max_tokens: 150, // Adjust as needed
        temperature: 0.7, // Adjust for creativity
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Vibe API error: ${response.status} - ${JSON.stringify(errorData)}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "Sorry, I couldn't generate a response.";
  } catch (error) {
    console.error("[Vibe AI Error]:", error.message);
    return "Sorry, I couldn't connect to the AI service.";
  }
}

module.exports = { getAIReply };