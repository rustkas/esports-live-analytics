-- ============================================
-- CS2 Live Analytics - PostgreSQL Schema
-- Metadata, configuration, and reference data
-- ============================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- 1. Teams
-- ============================================
CREATE TABLE IF NOT EXISTS teams (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    short_name VARCHAR(10),
    logo_url TEXT,
    country VARCHAR(3), -- ISO 3166-1 alpha-3
    rating INTEGER DEFAULT 1000,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_teams_name ON teams(name);
CREATE INDEX idx_teams_rating ON teams(rating DESC);

-- ============================================
-- 2. Players
-- ============================================
CREATE TABLE IF NOT EXISTS players (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    nickname VARCHAR(100) NOT NULL,
    real_name VARCHAR(255),
    team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
    country VARCHAR(3),
    avatar_url TEXT,
    steam_id VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_players_team ON players(team_id);
CREATE INDEX idx_players_nickname ON players(nickname);

-- ============================================
-- 3. Matches
-- ============================================
CREATE TYPE match_status AS ENUM ('scheduled', 'live', 'finished', 'cancelled');
CREATE TYPE match_format AS ENUM ('bo1', 'bo3', 'bo5');

CREATE TABLE IF NOT EXISTS matches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Teams
    team_a_id UUID NOT NULL REFERENCES teams(id),
    team_b_id UUID NOT NULL REFERENCES teams(id),
    
    -- Match info
    tournament_name VARCHAR(255),
    format match_format DEFAULT 'bo3',
    status match_status DEFAULT 'scheduled',
    
    -- Scheduling
    scheduled_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    
    -- Results (overall)
    team_a_maps_won INTEGER DEFAULT 0,
    team_b_maps_won INTEGER DEFAULT 0,
    winner_id UUID REFERENCES teams(id),
    
    -- Metadata
    external_id VARCHAR(255), -- ID from data provider
    source VARCHAR(50),
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_matches_status ON matches(status);
CREATE INDEX idx_matches_scheduled ON matches(scheduled_at);
CREATE INDEX idx_matches_teams ON matches(team_a_id, team_b_id);
CREATE INDEX idx_matches_live ON matches(status) WHERE status = 'live';

-- ============================================
-- 4. Maps (per match)
-- ============================================
CREATE TABLE IF NOT EXISTS match_maps (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    
    map_name VARCHAR(50) NOT NULL, -- e.g., 'de_mirage', 'de_inferno'
    map_number INTEGER NOT NULL,   -- 1, 2, 3...
    
    -- State
    status match_status DEFAULT 'scheduled',
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    
    -- Score
    team_a_score INTEGER DEFAULT 0,
    team_b_score INTEGER DEFAULT 0,
    current_round INTEGER DEFAULT 0,
    
    -- Current side (CT/T)
    team_a_side VARCHAR(2) DEFAULT 'CT', -- 'CT' or 'T'
    
    winner_id UUID REFERENCES teams(id),
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(match_id, map_number)
);

CREATE INDEX idx_match_maps_match ON match_maps(match_id);
CREATE INDEX idx_match_maps_status ON match_maps(status);

-- ============================================
-- 5. Model Versions (Predictor)
-- ============================================
CREATE TABLE IF NOT EXISTS model_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    version VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(255),
    description TEXT,
    
    -- Model metadata
    type VARCHAR(50) DEFAULT 'rule_based', -- 'rule_based', 'ml', 'ensemble'
    config JSONB, -- Model hyperparameters
    
    -- Performance metrics
    accuracy FLOAT,
    brier_score FLOAT,
    log_loss FLOAT,
    
    -- Lifecycle
    is_active BOOLEAN DEFAULT true,
    deployed_at TIMESTAMPTZ,
    deprecated_at TIMESTAMPTZ,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_model_versions_active ON model_versions(is_active);

-- ============================================
-- 6. API Clients (B2B)
-- ============================================
CREATE TABLE IF NOT EXISTS api_clients (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    api_key VARCHAR(64) NOT NULL UNIQUE,
    api_secret VARCHAR(128) NOT NULL,
    
    -- Permissions
    scopes TEXT[] DEFAULT ARRAY['read'], -- 'read', 'write', 'admin'
    
    -- Rate limiting
    rate_limit_per_minute INTEGER DEFAULT 60,
    rate_limit_per_day INTEGER DEFAULT 10000,
    
    -- Contact
    email VARCHAR(255),
    webhook_url TEXT,
    
    -- Status
    is_active BOOLEAN DEFAULT true,
    last_used_at TIMESTAMPTZ,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_api_clients_key ON api_clients(api_key);
CREATE INDEX idx_api_clients_active ON api_clients(is_active);

-- ============================================
-- 7. Event Log (for debugging/audit)
-- ============================================
CREATE TABLE IF NOT EXISTS event_processing_log (
    id BIGSERIAL PRIMARY KEY,
    event_id UUID NOT NULL,
    match_id UUID,
    
    -- Processing info
    processor VARCHAR(50),
    status VARCHAR(20), -- 'processed', 'failed', 'duplicate'
    error_message TEXT,
    
    -- Timing
    received_at TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    latency_ms INTEGER
);

CREATE INDEX idx_event_log_event ON event_processing_log(event_id);
CREATE INDEX idx_event_log_match ON event_processing_log(match_id);
CREATE INDEX idx_event_log_status ON event_processing_log(status) WHERE status = 'failed';

-- ============================================
-- 8. Helper Functions
-- ============================================

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER teams_updated_at
    BEFORE UPDATE ON teams
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER players_updated_at
    BEFORE UPDATE ON players
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER matches_updated_at
    BEFORE UPDATE ON matches
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER match_maps_updated_at
    BEFORE UPDATE ON match_maps
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER api_clients_updated_at
    BEFORE UPDATE ON api_clients
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- 9. Seed Data
-- ============================================

-- Insert demo teams
INSERT INTO teams (id, name, short_name, country, rating) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Team Alpha', 'ALPHA', 'USA', 1250),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Team Bravo', 'BRAVO', 'DEU', 1180)
ON CONFLICT DO NOTHING;

-- Insert demo players for Team Alpha
INSERT INTO players (id, nickname, team_id, country) VALUES
    ('a1000000-0000-0000-0000-000000000001', 'AlphaOne', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'USA'),
    ('a1000000-0000-0000-0000-000000000002', 'AlphaTwo', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'USA'),
    ('a1000000-0000-0000-0000-000000000003', 'AlphaThree', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'USA'),
    ('a1000000-0000-0000-0000-000000000004', 'AlphaFour', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'USA'),
    ('a1000000-0000-0000-0000-000000000005', 'AlphaFive', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'USA')
ON CONFLICT DO NOTHING;

-- Insert demo players for Team Bravo
INSERT INTO players (id, nickname, team_id, country) VALUES
    ('b1000000-0000-0000-0000-000000000001', 'BravoOne', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'DEU'),
    ('b1000000-0000-0000-0000-000000000002', 'BravoTwo', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'DEU'),
    ('b1000000-0000-0000-0000-000000000003', 'BravoThree', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'DEU'),
    ('b1000000-0000-0000-0000-000000000004', 'BravoFour', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'DEU'),
    ('b1000000-0000-0000-0000-000000000005', 'BravoFive', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'DEU')
ON CONFLICT DO NOTHING;

-- Insert demo match
INSERT INTO matches (id, team_a_id, team_b_id, tournament_name, format, status) VALUES
    ('11111111-1111-1111-1111-111111111111', 
     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 
     'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
     'Demo Tournament',
     'bo3',
     'live')
ON CONFLICT DO NOTHING;

-- Insert demo map
INSERT INTO match_maps (id, match_id, map_name, map_number, status) VALUES
    ('22222222-2222-2222-2222-222222222222',
     '11111111-1111-1111-1111-111111111111',
     'de_mirage',
     1,
     'live')
ON CONFLICT DO NOTHING;

-- Insert default model version
INSERT INTO model_versions (version, name, description, type, is_active) VALUES
    ('v1.0.0', 'Rule-Based Baseline', 'Simple rule-based predictor using round score and momentum', 'rule_based', true)
ON CONFLICT DO NOTHING;

-- Insert demo API client
INSERT INTO api_clients (name, api_key, api_secret, scopes, email) VALUES
    ('Demo Client', 'demo_api_key_12345', 'demo_secret_67890', ARRAY['read', 'write'], 'demo@example.com')
ON CONFLICT DO NOTHING;

-- ============================================
-- 10. Views
-- ============================================

-- Live matches with team names
CREATE OR REPLACE VIEW v_live_matches AS
SELECT 
    m.id,
    m.tournament_name,
    m.format,
    m.status,
    m.started_at,
    ta.name AS team_a_name,
    ta.short_name AS team_a_short,
    tb.name AS team_b_name,
    tb.short_name AS team_b_short,
    m.team_a_maps_won,
    m.team_b_maps_won
FROM matches m
JOIN teams ta ON m.team_a_id = ta.id
JOIN teams tb ON m.team_b_id = tb.id
WHERE m.status = 'live';

-- Match details with current map
CREATE OR REPLACE VIEW v_match_details AS
SELECT 
    m.id AS match_id,
    m.tournament_name,
    m.format,
    m.status AS match_status,
    ta.id AS team_a_id,
    ta.name AS team_a_name,
    tb.id AS team_b_id,
    tb.name AS team_b_name,
    mm.id AS current_map_id,
    mm.map_name,
    mm.team_a_score,
    mm.team_b_score,
    mm.current_round
FROM matches m
JOIN teams ta ON m.team_a_id = ta.id
JOIN teams tb ON m.team_b_id = tb.id
LEFT JOIN match_maps mm ON mm.match_id = m.id AND mm.status = 'live';
