# Changelog

## 0.1.0

- First version.
- The **Past Dev API** credential: API Key and API Host. The credential test lists the audiences,
  and spends no credits.
- The **past dev** node, usable as an AI Agent tool, with the resource Memory:
  - **Ingest**: send one data point (`POST /api/v1/ingest`).
  - **Recall**: retrieve the ranked memories for a query and an identity (`POST /api/v1/recall`).
    The output is the API response plus a flat `context` text.
  - **Delete Data Point**: delete one data point by its source ID
    (`DELETE /api/v1/data-points/{sourceId}`).
- Dropdown lists for identities (`GET /api/v1/identities`) and audiences (`GET /api/v1/audiences`).
