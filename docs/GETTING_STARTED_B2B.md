# Getting Started for Partners (Bookmakers)

## 1. Authentication
Obtain your API Key from the dashboard.
Authenticate requests using the header:
`Authorization: Bearer <YOUR_API_KEY>`

## 2. API Overview
Base URL: `https://api.esports-analytics.com/api/v1`

### Key Endpoints
- `GET /live-matches`: List currently active matches.
- `GET /matches/:id/prediction/latest`: Get real-time win probability.
- `GET /partner/health`: Check API status.

## 3. Webhooks (Real-time updates)
Configure your endpoint to receive JSON payloads.

### Verification
Verify `X-Esports-Signature` matches `HMAC-SHA256(YOUR_CLIENT_ID, BODY)`.

### Example Payload
```json
{
  "matchId": "uuid",
  "teamAWinProbability": 0.65,
  "confidence": 0.8
}
```

## 4. Integration Example (Node.js)
```javascript
const crypto = require('crypto');
const express = require('express');
const app = express();

app.use(express.json());

app.post('/webhook', (req, res) => {
  const signature = req.headers['x-esports-signature'];
  const expected = 'sha256=' + crypto.createHmac('sha256', process.env.CLIENT_ID)
                                   .update(JSON.stringify(req.body))
                                   .digest('hex');
  
  if (signature !== expected) return res.status(401).send('Invalid Signature');
  
  console.log('Received event:', req.body);
  res.status(200).send('OK');
});

app.listen(3000);
```
