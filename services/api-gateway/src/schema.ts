/**
 * GraphQL Schema
 */

export const typeDefs = /* GraphQL */ `
  type Query {
    """Get a match by ID"""
    match(id: ID!): Match
    
    """List matches with optional filters"""
    matches(
      status: MatchStatus, 
      limit: Int, 
      offset: Int @deprecated(reason: "Use 'after' for cursor pagination"), 
      after: String
    ): MatchConnection!
    
    """Get a team by ID"""
    team(id: ID!): Team
    
    """Get current prediction for a match"""
    prediction(matchId: ID!): Prediction
    
    """Get prediction history for a map"""
    predictionHistory(matchId: ID!, mapId: ID!): PredictionHistory
    
    """Get round metrics for a map"""
    roundMetrics(matchId: ID!, mapId: ID!): [RoundMetrics!]!
  }

  type Subscription {
    """Subscribe to prediction updates for a match"""
    predictionUpdated(matchId: ID!): PredictionUpdate!
    
    """Subscribe to score updates for a match"""
    scoreUpdated(matchId: ID!): ScoreUpdate!
    
    """Subscribe to all match events"""
    matchEvents(matchId: ID!): MatchEvent!
  }

  type Match {
    id: ID!
    tournamentName: String
    format: MatchFormat!
    status: MatchStatus!
    scheduledAt: String
    startedAt: String
    finishedAt: String
    
    teamA: Team!
    teamB: Team!
    
    teamAMapsWon: Int!
    teamBMapsWon: Int!
    winner: Team
    
    currentMap: MatchMap
    maps: [MatchMap!]!
    
    """Current prediction"""
    prediction: Prediction
  }

  type Team {
    id: ID!
    name: String!
    shortName: String
    logoUrl: String
    country: String
    rating: Int!
  }

  type MatchMap {
    id: ID!
    mapName: String!
    mapNumber: Int!
    status: MatchStatus!
    teamAScore: Int!
    teamBScore: Int!
    currentRound: Int!
    winner: Team
  }

  type Prediction {
    matchId: ID!
    mapId: ID!
    roundNo: Int!
    
    teamAWinProbability: Float!
    teamBWinProbability: Float!
    confidence: Float!
    
    modelVersion: String!
    calculatedAt: String!
    stateVersion: Int!
  }

  type PredictionHistory {
    matchId: ID!
    mapId: ID!
    teamAId: ID!
    teamBId: ID!
    points: [PredictionPoint!]!
  }

  type PredictionPoint {
    tsCalc: String!
    roundNo: Int!
    pTeamAWin: Float!
    pTeamBWin: Float!
    confidence: Float!
    triggerEventType: String
    stateVersion: Int
  }

  type RoundMetrics {
    roundNo: Int!
    teamAKills: Int!
    teamBKills: Int!
    teamAHeadshots: Int!
    teamBHeadshots: Int!
    momentum: Float!
    clutchIndex: Float!
    roundWinner: String
  }

  type PredictionUpdate {
    matchId: ID!
    mapId: ID!
    roundNo: Int!
    teamAWinProbability: Float!
    teamBWinProbability: Float!
    confidence: Float!
    triggerEventType: String
    timestamp: String!
    stateVersion: Int!
  }

  type ScoreUpdate {
    matchId: ID!
    mapId: ID!
    teamAScore: Int!
    teamBScore: Int!
    currentRound: Int!
    timestamp: String!
  }

  type MatchEvent {
    type: String!
    matchId: ID!
    timestamp: String!
    data: String!
  }

  type MatchConnection {
    edges: [MatchEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type MatchEdge {
    cursor: String!
    node: Match!
  }

  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }

  enum MatchStatus {
    SCHEDULED
    LIVE
    FINISHED
    CANCELLED
  }

  enum MatchFormat {
    BO1
    BO3
    BO5
  }
`;
