#!/bin/bash
# Load test script using curl (simple version)
# For production testing, use k6 or locust

BASE_URL="${1:-http://localhost:8081}"
EVENTS="${2:-1000}"
CONCURRENCY="${3:-10}"

echo "🔥 Load Test: $EVENTS events with concurrency $CONCURRENCY"
echo "Target: $BASE_URL"
echo ""

MATCH_ID="11111111-1111-1111-1111-111111111111"
MAP_ID="22222222-2222-2222-2222-222222222222"
TEAM_A_ID="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
TEAM_B_ID="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

send_event() {
  local i=$1
  local round=$((i % 30 + 1))
  local event_types=("kill" "round_start" "round_end" "economy_update" "bomb_planted")
  local event_type=${event_types[$((RANDOM % ${#event_types[@]}))]}
  
  curl -sS -X POST "$BASE_URL/events" \
    -H 'Content-Type: application/json' \
    -d "{
      \"event_id\": \"$(cat /proc/sys/kernel/random/uuid)\",
      \"match_id\": \"$MATCH_ID\",
      \"map_id\": \"$MAP_ID\",
      \"round_no\": $round,
      \"ts_event\": \"$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)\",
      \"type\": \"$event_type\",
      \"source\": \"loadtest\",
      \"seq_no\": $i,
      \"payload\": {
        \"team_a_id\": \"$TEAM_A_ID\",
        \"team_b_id\": \"$TEAM_B_ID\",
        \"killer_team\": \"A\",
        \"victim_team\": \"B\"
      }
    }" -o /dev/null -w "%{http_code}" 2>/dev/null
}

export -f send_event
export BASE_URL MATCH_ID MAP_ID TEAM_A_ID TEAM_B_ID

start_time=$(date +%s.%N)

# Run in parallel
seq 1 $EVENTS | xargs -P $CONCURRENCY -I {} bash -c 'send_event {}'

end_time=$(date +%s.%N)
duration=$(echo "$end_time - $start_time" | bc)
rate=$(echo "scale=2; $EVENTS / $duration" | bc)

echo ""
echo ""
echo "📊 Results:"
echo "   Total events: $EVENTS"
echo "   Duration: ${duration}s"
echo "   Rate: ${rate} events/sec"
echo ""
echo "💡 For proper load testing, use k6:"
echo "   k6 run scripts/k6-test.js"
