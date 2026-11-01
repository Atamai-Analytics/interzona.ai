export async function embedQuery(text: string): Promise<number[]> {
  const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: [text],
      model: "voyage-3-large",
      input_type: "query",
    }),
  });
  if (!resp.ok) {
    throw new Error(`Voyage API error: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.data[0].embedding;
}

export function toVectorLiteral(embedding: number[]): string {
  return "[" + embedding.join(",") + "]";
}
