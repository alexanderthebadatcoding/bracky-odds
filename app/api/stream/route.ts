export const runtime = "edge";

export async function GET() {
  const upstream = await fetch("https://bracky.app/api/stream", {
    headers: {
      Authorization: `Bearer ${process.env.BRACKY_TOKEN}`,
      Accept: "text/event-stream",
    },
  });

  if (!upstream.body) {
    return new Response("No stream", { status: 500 });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
