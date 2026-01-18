# API Documentation

## REST API

Base URL: `http://localhost:8080/api`

### Matches

#### List Matches
```http
GET /matches?status=live&limit=20&offset=0
```

Response:
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "tournament_name": "Demo Tournament",
      "format": "bo3",
      "status": "live",
      "team_a_id": "uuid",
      "team_b_id": "uuid",
      "team_a_maps_won": 1,
      "team_b_maps_won": 0
    }
  ],
  "meta": {
    "limit": 20,
    "offset": 0
  }
}
```

#### Get Match
```http
GET /matches/:id
```

Response includes teams and maps.

#### Get Match Stats
```http
GET /matches/:id/stats
```

#### Get Match Prediction
```http
GET /matches/:id/prediction
```

Response:
```json
{
  "success": true,
  "data": {
    "match_id": "uuid",
    "map_id": "uuid",
    "round_no": 15,
    "p_team_a_win": 0.67,
    "p_team_b_win": 0.33,
    "confidence": 0.74,
    "model_version": "v1.0.0-rule-based",
    "ts_calc": "2026-01-18T12:00:00.000Z"
  }
}
```

### Teams

#### List Teams
```http
GET /teams?limit=50&offset=0
```

#### Get Team
```http
GET /teams/:id
```

#### Get Team Metrics
```http
GET /teams/:id/metrics
```

---

## GraphQL API

Endpoint: `http://localhost:8080/graphql`

### Queries

```graphql
# Get match with prediction
query GetMatch($id: ID!) {
  match(id: $id) {
    id
    tournamentName
    format
    status
    teamA {
      id
      name
      shortName
    }
    teamB {
      id
      name
      shortName
    }
    teamAMapsWon
    teamBMapsWon
    currentMap {
      mapName
      teamAScore
      teamBScore
      currentRound
    }
    prediction {
      teamAWinProbability
      teamBWinProbability
      confidence
    }
  }
}

# List live matches
query LiveMatches {
  matches(status: LIVE, limit: 10) {
    items {
      id
      tournamentName
      teamA { name }
      teamB { name }
    }
    total
    hasMore
  }
}

# Get prediction history
query PredictionHistory($matchId: ID!, $mapId: ID!) {
  predictionHistory(matchId: $matchId, mapId: $mapId) {
    matchId
    mapId
    points {
      tsCalc
      roundNo
      pTeamAWin
      pTeamBWin
      confidence
    }
  }
}

# Get round metrics
query RoundMetrics($matchId: ID!, $mapId: ID!) {
  roundMetrics(matchId: $matchId, mapId: $mapId) {
    roundNo
    teamAKills
    teamBKills
    momentum
    roundWinner
  }
}
```

### Subscriptions

```graphql
# Subscribe to prediction updates
subscription PredictionUpdates($matchId: ID!) {
  predictionUpdated(matchId: $matchId) {
    matchId
    roundNo
    teamAWinProbability
    teamBWinProbability
    confidence
    timestamp
  }
}

# Subscribe to score updates
subscription ScoreUpdates($matchId: ID!) {
  scoreUpdated(matchId: $matchId) {
    teamAScore
    teamBScore
    currentRound
    timestamp
  }
}
```

---

## Event Ingestion API

Base URL: `http://localhost:8081`

### Send Event
```http
POST /events
Content-Type: application/json

{
  "event_id": "uuid",
  "match_id": "uuid",
  "map_id": "uuid",
  "round_no": 1,
  "ts_event": "2026-01-18T12:00:00.000Z",
  "type": "kill",
  "source": "provider_name",
  "seq_no": 123,
  "payload": {
    "killer_player_id": "p1",
    "victim_player_id": "p2",
    "killer_team": "A",
    "victim_team": "B",
    "weapon": "ak47",
    "is_headshot": true
  }
}
```

Response:
```json
{
  "success": true,
  "event_id": "uuid",
  "job_id": "uuid",
  "latency_ms": 25.5
}
```

### Send Batch
```http
POST /events/batch
Content-Type: application/json

[
  { "event_id": "...", ... },
  { "event_id": "...", ... }
]
```

### Event Types

| Type | Description |
|------|-------------|
| `match_start` | Match begins |
| `match_end` | Match ends |
| `map_start` | Map begins |
| `map_end` | Map ends |
| `round_start` | Round begins |
| `round_end` | Round ends |
| `kill` | Player killed |
| `bomb_planted` | Bomb planted |
| `bomb_defused` | Bomb defused |
| `bomb_exploded` | Bomb exploded |
| `economy_update` | Economy state |
| `player_hurt` | Player damaged |

---

## Health & Metrics

### Health Check
```http
GET /health
```

Available on all services.

### Prometheus Metrics
```http
GET /metrics
```

Available on all services. Returns Prometheus format.

---

## API Versioning & Contracts

### Versioning Strategy
- **REST API**: URI Versioning (v1). Current default: `/api/v1`.
- **GraphQL**: Schema Evolution (non-breaking changes only).
- **Event Contracts**: `RawEvent` schema versions managed via strict validation.

### Breaking Changes Response
If a breaking change is detected in event payload:
1. `provider_ingestion_errors` will log `SCHEMA_MISMATCH`.
2. Old consumers will continue to process valid fields (robustness principle).

### Headers
Client MUST send:
- `Authorization: Bearer <token>`
- `X-Client-ID: <uuid>` (If not using Bearer)
- `X-Client-Version: <semver>` (Optional, for debugging)
