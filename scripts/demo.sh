#!/bin/bash
# Demo script: Send sample events to test the system

BASE_URL="${1:-http://localhost:8081}"
MATCH_ID="11111111-1111-1111-1111-111111111111"
MAP_ID="22222222-2222-2222-2222-222222222222"
TEAM_A_ID="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
TEAM_B_ID="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

echo "🎮 CS2 Live Analytics Demo"
echo "=========================="
echo "Sending events to: $BASE_URL"
echo ""

# Helper function to send event
send_event() {
  local event_type=$1
  local round=$2
  local payload=$3
  local event_id=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)
  
  echo "📤 Sending $event_type event (round $round)..."
  
  curl -sS -X POST "$BASE_URL/events" \
    -H 'Content-Type: application/json' \
    -d "{
      \"event_id\": \"$event_id\",
      \"match_id\": \"$MATCH_ID\",
      \"map_id\": \"$MAP_ID\",
      \"round_no\": $round,
      \"ts_event\": \"$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)\",
      \"type\": \"$event_type\",
      \"source\": \"demo\",
      \"seq_no\": $RANDOM,
      \"payload\": $payload
    }" | jq -r '.success // .error'
  
  sleep 0.5
}

# Round 1: Team A wins pistol
echo ""
echo "🔫 Round 1 - Pistol Round"
echo "-------------------------"

send_event "round_start" 1 "{
  \"team_a_score\": 0,
  \"team_b_score\": 0,
  \"team_a_side\": \"CT\",
  \"team_b_side\": \"T\",
  \"team_a_id\": \"$TEAM_A_ID\",
  \"team_b_id\": \"$TEAM_B_ID\"
}"

send_event "kill" 1 "{
  \"killer_player_id\": \"a1000000-0000-0000-0000-000000000001\",
  \"killer_team\": \"A\",
  \"victim_player_id\": \"b1000000-0000-0000-0000-000000000001\",
  \"victim_team\": \"B\",
  \"weapon\": \"usp_silencer\",
  \"is_headshot\": true,
  \"team_a_id\": \"$TEAM_A_ID\",
  \"team_b_id\": \"$TEAM_B_ID\"
}"

send_event "kill" 1 "{
  \"killer_player_id\": \"a1000000-0000-0000-0000-000000000002\",
  \"killer_team\": \"A\",
  \"victim_player_id\": \"b1000000-0000-0000-0000-000000000002\",
  \"victim_team\": \"B\",
  \"weapon\": \"usp_silencer\",
  \"is_headshot\": false,
  \"team_a_id\": \"$TEAM_A_ID\",
  \"team_b_id\": \"$TEAM_B_ID\"
}"

send_event "round_end" 1 "{
  \"winner_team\": \"A\",
  \"win_reason\": \"elimination\",
  \"team_a_score\": 1,
  \"team_b_score\": 0,
  \"team_a_id\": \"$TEAM_A_ID\",
  \"team_b_id\": \"$TEAM_B_ID\"
}"

# Round 2: Team A continues momentum
echo ""
echo "💰 Round 2 - Eco Round"
echo "----------------------"

send_event "round_start" 2 "{
  \"team_a_score\": 1,
  \"team_b_score\": 0,
  \"team_a_side\": \"CT\",
  \"team_b_side\": \"T\",
  \"team_a_id\": \"$TEAM_A_ID\",
  \"team_b_id\": \"$TEAM_B_ID\"
}"

send_event "economy_update" 2 "{
  \"team_a_econ\": 16000,
  \"team_b_econ\": 4500,
  \"team_a_buy_type\": \"full\",
  \"team_b_buy_type\": \"eco\"
}"

send_event "bomb_planted" 2 "{
  \"player_id\": \"b1000000-0000-0000-0000-000000000003\",
  \"player_team\": \"B\",
  \"site\": \"A\"
}"

send_event "kill" 2 "{
  \"killer_player_id\": \"a1000000-0000-0000-0000-000000000003\",
  \"killer_team\": \"A\",
  \"victim_player_id\": \"b1000000-0000-0000-0000-000000000003\",
  \"victim_team\": \"B\",
  \"weapon\": \"m4a1_silencer\",
  \"is_headshot\": true,
  \"team_a_id\": \"$TEAM_A_ID\",
  \"team_b_id\": \"$TEAM_B_ID\"
}"

send_event "bomb_defused" 2 "{
  \"player_id\": \"a1000000-0000-0000-0000-000000000004\",
  \"player_team\": \"A\",
  \"site\": \"A\"
}"

send_event "round_end" 2 "{
  \"winner_team\": \"A\",
  \"win_reason\": \"bomb_defused\",
  \"team_a_score\": 2,
  \"team_b_score\": 0,
  \"team_a_id\": \"$TEAM_A_ID\",
  \"team_b_id\": \"$TEAM_B_ID\"
}"

# Round 3: Team B force buy success
echo ""
echo "🎯 Round 3 - Force Buy"
echo "----------------------"

send_event "round_start" 3 "{
  \"team_a_score\": 2,
  \"team_b_score\": 0,
  \"team_a_side\": \"CT\",
  \"team_b_side\": \"T\",
  \"team_a_id\": \"$TEAM_A_ID\",
  \"team_b_id\": \"$TEAM_B_ID\"
}"

send_event "kill" 3 "{
  \"killer_player_id\": \"b1000000-0000-0000-0000-000000000001\",
  \"killer_team\": \"B\",
  \"victim_player_id\": \"a1000000-0000-0000-0000-000000000001\",
  \"victim_team\": \"A\",
  \"weapon\": \"ak47\",
  \"is_headshot\": true,
  \"is_first_kill\": true,
  \"team_a_id\": \"$TEAM_A_ID\",
  \"team_b_id\": \"$TEAM_B_ID\"
}"

send_event "kill" 3 "{
  \"killer_player_id\": \"b1000000-0000-0000-0000-000000000002\",
  \"killer_team\": \"B\",
  \"victim_player_id\": \"a1000000-0000-0000-0000-000000000002\",
  \"victim_team\": \"A\",
  \"weapon\": \"ak47\",
  \"is_headshot\": false,
  \"team_a_id\": \"$TEAM_A_ID\",
  \"team_b_id\": \"$TEAM_B_ID\"
}"

send_event "bomb_planted" 3 "{
  \"player_id\": \"b1000000-0000-0000-0000-000000000004\",
  \"player_team\": \"B\",
  \"site\": \"B\"
}"

send_event "round_end" 3 "{
  \"winner_team\": \"B\",
  \"win_reason\": \"bomb_exploded\",
  \"team_a_score\": 2,
  \"team_b_score\": 1,
  \"team_a_id\": \"$TEAM_A_ID\",
  \"team_b_id\": \"$TEAM_B_ID\"
}"

echo ""
echo "✅ Demo events sent!"
echo ""
echo "📊 Check the results:"
echo "   - API Gateway: http://localhost:8080/api/matches/$MATCH_ID"
echo "   - GraphQL: http://localhost:8080/graphql"
echo "   - Prediction: http://localhost:8083/prediction/$MATCH_ID"
echo ""
echo "📈 Query examples:"
echo "   curl http://localhost:8080/api/matches/$MATCH_ID/prediction"
echo "   curl http://localhost:8082/matches/$MATCH_ID/maps/$MAP_ID/rounds"
