"use client";

import { useEffect, useRef, useState } from "react";
type Outcome = {
  slug: string;
  name: string;
  shortName?: string;
  acronym?: string;
  odds?: number;
  espnOdds?: {
    spread?: number;
    moneyline?: number;
    overUnder?: number;
  };
  winProbability?: number;
  score?: number; // Added
  state?: string;
  primaryColor?: string;
  secondaryColor?: string;
};

type Market = {
  slug: string;
  name: string;
  category?: string;
  broadcast?: string | null;
  gametimeAt?: number | null;
  imageSrc?: string | null;
  outcomes?: Record<string, Outcome>;
  espnEventId?: string;
  groupSlug?: string | null;
  isThreadMarket?: boolean;
  isMatchup?: boolean;
  espnStatus?: string;
  winProbabilities?: {
    // Added
    home?: number;
    away?: number;
  };
};

type GroupedMarkets = {
  [category: string]: {
    [slug: string]: Market;
  };
};
export default function BrackyWithESPNOdds() {
  const [markets, setMarkets] = useState<GroupedMarkets>({});
  const [loadingOdds, setLoadingOdds] = useState(false);
  const fetchedMarketsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const es = new EventSource("/api/stream");

    es.addEventListener("update", (e) => {
      try {
        const payload = JSON.parse(e.data);
        // console.log("Received payload:", payload); // Log the received payload
        const updates = payload.updates ?? [];
        // console.log("Received update:", updates);

        setMarkets((prev) => {
          const next = structuredClone(prev);

          for (const u of updates) {
            /* ---------------- Markets ---------------- */
            if (u.key?.[0] === "markets" && u.operation === "insert") {
              const m: Market = u.data;
              const category = m.category ?? "other";
              // Filter out NFL Playoff Race and other group markets
              if (
                m.slug === "ncaa-football-2025-26-cfp-champion" ||
                m.isThreadMarket
              ) {
                continue;
              }

              next[category] ??= {};
              next[category][m.slug] = {
                ...m,
                outcomes: next[category][m.slug]?.outcomes ?? {},
              };

              // Fetch ESPN odds for this market
              // Fetch ESPN odds for this market
              if (
                category === "nba" ||
                category === "nfl" ||
                category === "european-football" ||
                category === "ncaa-football" ||
                category === "mls" ||
                category === "ncaa-basketball" ||
                category === "soccer"
              ) {
                if (!fetchedMarketsRef.current.has(m.slug)) {
                  fetchedMarketsRef.current.add(m.slug);
                  fetchESPNOdds(m, category);
                }
              }
            }

            /* ---------------- Outcomes ---------------- */
            if (u.key?.[0] === "outcomes" && u.operation === "insert") {
              const marketSlug = u.key?.[1];
              const o: Outcome = u.data;

              for (const category of Object.keys(next)) {
                const market = next[category][marketSlug];
                if (!market) continue;

                market.outcomes ??= {};
                market.outcomes[o.slug] = o;
              }
            }
          }

          return next;
        });
      } catch {
        // ignore malformed payloads
      }
    });

    es.onerror = () => es.close();
    return () => es.close();
  }, []);

  const teamsMatchExactly = (espnTeams: string[], brackyTeams: string[]) => {
    if (espnTeams.length !== 2 || brackyTeams.length !== 2) return false;

    let matches = 0;

    for (const e of espnTeams) {
      const found = brackyTeams.some((b) => e.includes(b) || b.includes(e));
      if (found) matches++;
    }

    return matches === 2;
  };

  const fetchESPNOdds = async (market: Market, category: string) => {
    setLoadingOdds(true);
    try {
      // ESPN API endpoints - different for each sport
      let sport;
      if (category === "nba") {
        sport = "basketball/nba";
      } else if (category === "nfl") {
        sport = "football/nfl";
      } else if (category === "ncaa-football") {
        sport = "football/college-football/";
      } else if (category === "ncaa-basketball") {
        sport = "basketball/mens-college-basketball";
      } else if (category === "mls") {
        sport = "soccer/usa.1";
      } else if (category === "european-football" || category === "soccer") {
        sport = "soccer/eng.1";
      } else {
        return; // Skip unsupported sports
      }

      const scoreboard = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/${sport}/scoreboard`
      );
      const data = await scoreboard.json();

      // Find matching game by event name or team names
      const event = data.events?.find((e: any) => {
        const eventName = e.name?.toLowerCase() || "";
        const shortName = e.shortName?.toLowerCase() || "";

        // Clean up Bracky market name (remove broadcast info in parens)
        const brackyName = market.name
          .replace(/\([^)]*\)/g, "") // remove (anything)
          .replace(/#\d+/g, "") // remove #number
          .trim()
          .toLowerCase();

        // Try to match by event name first
        if (eventName && brackyName) {
          const normalizeName = (name: string) =>
            name
              .toLowerCase()
              .replace(/\([^)]*\)/g, "")
              .replace(/#\d+/g, "")
              .replace(/\p{Extended_Pictographic}/gu, "")
              .replace(/[^\w\s]/g, " ") // remove punctuation
              .replace(/\b(fc|cf|sc|afc|club|calcio|ac)\b/g, "")
              .replace(/\b\d{4}\b/g, "") // remove 1909, 1899, etc
              .replace(/\s+/g, " ")
              .trim();

          // Extract team names from both
          const splitTeams = (name: string) =>
            name.split(/\s+(?:at|vs|v)\s+|[-–]\s*/);

          const espnTeams = splitTeams(
            normalizeName(e.name ?? e.shortName ?? "")
          );
          const brackyParts = splitTeams(normalizeName(market.name));
          console.log("ESPN Teams:", espnTeams);
          console.log("Bracky Parts:", brackyParts);

          if (teamsMatchExactly(espnTeams, brackyParts)) {
            return true;
          }
        }

        // Fallback: match by competitor names
        const competitors = e.competitions?.[0]?.competitors || [];
        const teamNames = competitors.map((c: any) =>
          c.team.displayName.toLowerCase()
        );

        return teamNames.some((name: string) => brackyName.includes(name));
      });

      if (event && event.competitions?.[0]) {
        const competition = event.competitions[0];
        const oddsData = competition.odds?.[0];
        const competitors = competition.competitors;
        const statusDetail = event.status?.type?.detail;

        // Extract win percentages from situation if available
        const homeWinPercentage =
          competition.situation?.lastPlay?.probability?.homeWinPercentage;
        const awayWinPercentage =
          competition.situation?.lastPlay?.probability?.awayWinPercentage;

        setMarkets((prev) => {
          const next = structuredClone(prev);
          const m = next[category]?.[market.slug];
          if (!m?.outcomes) return next;

          if (statusDetail) m.espnStatus = statusDetail;

          // Store win percentages at market level
          if (
            homeWinPercentage !== undefined ||
            awayWinPercentage !== undefined
          ) {
            m.winProbabilities = {
              home: homeWinPercentage,
              away: awayWinPercentage,
            };
          }

          // Match outcomes to ESPN competitors
          if (oddsData && competitors && m.outcomes) {
            Object.values(m.outcomes).forEach((outcome) => {
              const competitor = competitors.find(
                (c: any) =>
                  outcome.name
                    ?.toLowerCase()
                    .includes(c.team.displayName.toLowerCase()) ||
                  outcome.shortName
                    ?.toLowerCase()
                    .includes(c.team.displayName.toLowerCase())
              );

              if (competitor) {
                const homeAway = competitor.homeAway; // 'home' or 'away'

                // ✅ LIVE SCORE
                if (competitor.score !== undefined) {
                  outcome.score = Number(competitor.score);
                }

                // ✅ LIVE WIN PROBABILITY (if available)
                if (competition.situation?.lastPlay?.probability) {
                  outcome.winProbability =
                    homeAway === "home"
                      ? competition.situation.lastPlay.probability
                          .homeWinPercentage
                      : competition.situation.lastPlay.probability
                          .awayWinPercentage;
                }

                // Get moneyline from odds.moneyline.home.close.odds or odds.moneyline.away.close.odds
                const moneylineValue =
                  oddsData.moneyline?.[homeAway]?.close?.odds;
                const spreadValue = oddsData.spread?.[homeAway]?.close?.line;
                const overUnderValue = oddsData.total?.close?.total;

                outcome.espnOdds = {
                  spread: spreadValue ? parseFloat(spreadValue) : undefined,
                  moneyline: moneylineValue
                    ? parseFloat(moneylineValue)
                    : undefined,
                  overUnder: overUnderValue
                    ? parseFloat(overUnderValue)
                    : undefined,
                };
              }
            });
          }

          return next;
        });
      }
    } catch (error) {
      console.error("Failed to fetch ESPN odds:", error);
    } finally {
      setLoadingOdds(false);
    }
  };

  const formatTime = (ts?: number | null) =>
    ts ? new Date(ts * 1000).toLocaleString() : "TBD";

  const convertMoneylineToPercent = (moneyline?: number) => {
    if (!moneyline) return null;

    if (moneyline > 0) {
      return (100 / (moneyline + 100)) * 100;
    } else {
      return (Math.abs(moneyline) / (Math.abs(moneyline) + 100)) * 100;
    }
  };

  return (
    <main
      style={{
        padding: 24,
        background: "#000",
        minHeight: "100vh",
        color: "#fff",
      }}
    >
      <div style={{ maxWidth: 1400, margin: "0 auto" }}>
        <h1 style={{ fontSize: 32, fontWeight: "bold", marginBottom: 8 }}>
          Bracky Live Markets
        </h1>
        <p style={{ color: "#888", marginBottom: 32 }}>
          Real-time prediction markets with ESPN odds comparison
        </p>

        {Object.entries(markets).map(([category, items]) => (
          <section key={category} style={{ marginBottom: 48 }}>
            <h2
              style={{
                fontSize: 24,
                fontWeight: "bold",
                marginBottom: 20,
                textTransform: "uppercase",
                color: "white",
              }}
            >
              {category}
            </h2>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))",
                gap: 20,
              }}
            >
              {Object.values(items).map((m) => (
                <div
                  key={m.slug}
                  style={{
                    border: "1px solid #333",
                    borderRadius: 12,
                    padding: 20,
                    background: "#111",
                    transition: "transform 0.2s",
                  }}
                >
                  <h3
                    style={{
                      marginTop: 8,
                      fontSize: 16,
                      fontWeight: 600,
                      marginBottom: 8,
                    }}
                  >
                    {m.name.replace(/\s*\([^)]*\)/g, "").trim()}
                  </h3>

                  <div
                    style={{
                      fontSize: 13,
                      color: "white",
                      marginBottom: 16,
                    }}
                  >
                    {m.broadcast && <div>📺 {m.broadcast}</div>}
                    <div>🕒 {m.espnStatus || formatTime(m.gametimeAt)}</div>
                  </div>

                  {/* Outcomes / Odds */}
                  {m.outcomes && (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                      }}
                    >
                      {Object.values(m.outcomes).map((o) => {
                        const espnImpliedProb = convertMoneylineToPercent(
                          o.espnOdds?.moneyline
                        );
                        const brackyOdds = o.odds;
                        const diff =
                          espnImpliedProb && brackyOdds
                            ? brackyOdds - espnImpliedProb
                            : null;

                        return (
                          <div
                            key={o.slug}
                            style={{
                              padding: "12px",
                              borderRadius: 8,
                              background: `linear-gradient(135deg, ${o.primaryColor}80, ${o.secondaryColor}40)`,
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                marginBottom: 8,
                              }}
                            >
                              <span
                                style={{
                                  fontWeight: 600,
                                  color: "#fff",
                                  fontSize: 15,
                                }}
                              >
                                {o.shortName ?? o.name}
                              </span>
                              {o.score !== undefined && (
                                <span
                                  style={{
                                    fontSize: 16,
                                    fontWeight: 700,
                                    color: "#fff",
                                  }}
                                >
                                  {o.score}
                                </span>
                              )}
                              {typeof o.odds === "number" && (
                                <span
                                  style={{
                                    fontVariantNumeric: "tabular-nums",
                                    color: "white",
                                    fontSize: 18,
                                    fontWeight: 700,
                                  }}
                                >
                                  {o.odds.toFixed(1)}%
                                </span>
                              )}
                            </div>

                            {/* ESPN Odds Comparison */}
                            {o.espnOdds && (
                              <div
                                style={{
                                  fontSize: 15,
                                  color: "#888",
                                  display: "flex",
                                  gap: 12,
                                  flexWrap: "wrap",
                                }}
                              >
                                {/* Show live win probability if available, otherwise moneyline */}
                                {o.winProbability !== undefined ? (
                                  <div>
                                    <span style={{ color: "white" }}>
                                      ESPN Live:
                                    </span>{" "}
                                    <span
                                      style={{
                                        color: "#00ff00",
                                        fontWeight: 600,
                                      }}
                                    >
                                      {o.winProbability.toFixed(1)}%
                                    </span>
                                  </div>
                                ) : o.espnOdds.moneyline ? (
                                  <div>
                                    <span style={{ color: "white" }}>
                                      ESPN ML:
                                    </span>{" "}
                                    <span style={{ color: "#fff" }}>
                                      {o.espnOdds.moneyline > 0 ? "+" : ""}
                                      {o.espnOdds.moneyline}
                                    </span>
                                    {espnImpliedProb && (
                                      <span style={{ color: "white" }}>
                                        {" "}
                                        ({espnImpliedProb.toFixed(1)}%)
                                      </span>
                                    )}
                                  </div>
                                ) : null}

                                {/* Show diff - compare against live probability if available, otherwise implied prob */}
                                {diff !== null && !o.winProbability && (
                                  <div>
                                    <span style={{ color: "#666" }}>Diff:</span>{" "}
                                    <span
                                      style={{
                                        color: diff > 0 ? "#00ff00" : "#ff0000",
                                        fontWeight: 600,
                                      }}
                                    >
                                      {diff > 0 ? "+" : ""}
                                      {diff.toFixed(1)}%
                                    </span>
                                  </div>
                                )}

                                {/* Show diff against live probability */}
                                {o.winProbability !== undefined &&
                                  brackyOdds && (
                                    <div>
                                      <span style={{ color: "#666" }}>
                                        Diff:
                                      </span>{" "}
                                      <span
                                        style={{
                                          color:
                                            brackyOdds - o.winProbability > 0
                                              ? "#00ff00"
                                              : "#ff0000",
                                          fontWeight: 600,
                                        }}
                                      >
                                        {brackyOdds - o.winProbability > 0
                                          ? "+"
                                          : ""}
                                        {(
                                          brackyOdds - o.winProbability
                                        ).toFixed(1)}
                                        %
                                      </span>
                                    </div>
                                  )}

                                {o.espnOdds.spread && (
                                  <div>
                                    <span style={{ color: "#666" }}>
                                      Spread:
                                    </span>{" "}
                                    <span style={{ color: "#fff" }}>
                                      {o.espnOdds.spread > 0 ? "+" : ""}
                                      {o.espnOdds.spread}
                                    </span>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}

        {Object.keys(markets).length === 0 && (
          <div
            style={{
              textAlign: "center",
              color: "#666",
              padding: 60,
            }}
          >
            <div style={{ fontSize: 48, marginBottom: 16 }}>📊</div>
            <p>Waiting for markets...</p>
          </div>
        )}
      </div>
    </main>
  );
}
