# Argo CD Extension Backend API

This repository owns the backend service for the Argo CD extension.

## Endpoints

- `GET /healthz`
- `GET /api/datasources/proxy/prometheus/api/v1/query`
- `GET /api/datasources/proxy/tempo/api/search`

## Environment Variables

- `PORT` (default: `8000`, valid range `1..65535`)
- `PROMETHEUS_BASE_URL` (required for metrics)
- `TEMPO_BASE_URL` (optional; if unset, traces return empty)
- `TEMPO_SEARCH_PATH` (default: `/api/search`)
- `REQUEST_TIMEOUT_MS` (default: `8000`, valid range `1..2147483647`)
- `LOG_LEVEL` (`INFO` or `DEBUG`)

## Local Run

```bash
npm install
PORT=8000 \
PROMETHEUS_BASE_URL=http://localhost:9090 \
TEMPO_BASE_URL=http://localhost:3200 \
npm start
```

## Release Model

This repository publishes the backend image independently from the UI extension repository.
