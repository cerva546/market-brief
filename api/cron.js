{
  "functions": {
    "api/brief.js": { "maxDuration": 60 },
    "api/quotes.js": { "maxDuration": 30 },
    "api/cron.js": { "maxDuration": 60 }
  },
  "crons": [
    {
      "path": "/api/cron",
      "schedule": "0 13 * * 1-5"
    }
  ]
}
